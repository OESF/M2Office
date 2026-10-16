/**
 * @file ローカルの形の管理者ページ「機械」の、システムログと証拠保全の API（仕様書 第16.10.4節・第16.10.5節）。
 *
 * ローカルの形（サブドメインを使わない、社内の機械）だけで使える。クラウドの形では 404（クラウドの形は運営がマスター管理画面で見る）。
 * 見られるのは会社の管理者だけ（管理者ページの口に付く）。見た・ダウンロードした・保全したことを監査ログに残す（絞った条件と件数だけ）。
 */

import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import {
  logExportZip, parseLogFilter, SYSTEM_LOG_EXPORT_MAX, SYSTEM_LOG_KEEP_DAYS, SYSTEM_LOG_PAGE, type SystemLogLine,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 機械のログのファイルとして出す名前（入れ替えた世代と圧縮したものも）。道を含む名前は受けない。 */
const MACHINE_LOG = /^[A-Za-z0-9._-]+\.log(\.\d+)?(\.(gz|bz2))?$/;

/** 機械のログの置き場（`<データの置き場>/logs`）。無ければ `null`。 */
const machineLogDir = () => process.env['M2O_LOG_DIR']?.trim() || null;

/**
 * システムログと証拠保全の口（`/v1/admin/machine/logs`・`/v1/admin/machine/evidence`）。
 *
 * @remarks テナント境界: 読むのは本人の会社の分と、会社に属さない仕組みの分だけ（ローカルの形の機械には会社が 1 つ）
 */
export function systemLogsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const store = deps.systemLogs;

  app.use('*', async (c, next) => {
    if (deps.ai.deployment() !== 'onsite') return c.json({ error: 'ローカルの形だけで使えます' }, 404);
    await next();
  });

  const audit = async (c: Context<AppEnv>, action: string, targetId: string, detail: Record<string, unknown>) => {
    const { tenant, user } = c.get('ctx');
    await deps.repo.appendAudit({ id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id, action, targetType: 'system_log', targetId, detail, occurredAt: new Date().toISOString() });
  };
  const filterDetail = (f: ReturnType<typeof parseLogFilter>) => ({ from: f.from, to: f.to, levels: f.levels, service: f.service, q: f.q ? '（言葉あり）' : null, requestId: f.requestId, runId: f.runId });

  /** 絞った行（新しい順に 200 件）。`next` があれば続きを読める。 */
  app.get('/logs', async (c) => {
    const { tenant } = c.get('ctx');
    const f = parseLogFilter(c.req.query(), { limit: SYSTEM_LOG_PAGE, maxDays: SYSTEM_LOG_KEEP_DAYS });
    const items = await store.read(tenant.id, f);
    // 続きを読むたびには残さない（最初の 1 回だけ）
    if (!f.before) await audit(c, 'log.view', 'system', filterDetail(f));
    const last = items[items.length - 1];
    return c.json({ items, next: items.length === SYSTEM_LOG_PAGE && last ? { before: last.at, beforeId: last.id } : null, range: { from: f.from, to: f.to } });
  });

  /** 範囲の日ごとの改ざんの確かめ（いまの行から作り直して比べる。7 日まで）。 */
  app.get('/logs/digests', async (c) => {
    const f = parseLogFilter(c.req.query(), { limit: 1, maxDays: 7 });
    return c.json({ items: await store.digests(f.from.slice(0, 10), f.to.slice(0, 10), true) });
  });

  /** 絞った結果を ZIP（`format=jsonl|csv`）で。100 万行・28 日まで。 */
  app.get('/logs/export', async (c) => {
    const { tenant, user } = c.get('ctx');
    const format = c.req.query('format') === 'csv' ? 'csv' : 'jsonl';
    const f = parseLogFilter(c.req.query(), { limit: 100_000, maxDays: SYSTEM_LOG_KEEP_DAYS });
    const lines: SystemLogLine[] = [];
    for (let before = f.before; lines.length < SYSTEM_LOG_EXPORT_MAX;) {
      const page = await store.read(tenant.id, { ...f, before, limit: Math.min(100_000, SYSTEM_LOG_EXPORT_MAX - lines.length) });
      lines.push(...page);
      if (page.length < 100_000) break;
      before = { at: page[page.length - 1]!.at, id: page[page.length - 1]!.id };
    }
    lines.reverse();
    const digests = await store.digests(f.from.slice(0, 10), f.to.slice(0, 10), true).catch(() => []);
    const zip = await logExportZip(lines, format, { kind: 'system-logs', scope: 'machine', tenantId: tenant.id, by: user.id, filter: filterDetail(f) }, digests);
    await audit(c, 'log.download', 'system', { ...filterDetail(f), lines: lines.length, format });
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="system-logs-${f.from.slice(0, 10)}.zip"`);
    return c.body(zip as unknown as ArrayBuffer);
  });

  /** 機械のログのファイル（標準出力のファイル・入れ替えた世代・入口のアクセスログ）。 */
  app.get('/logs/files', async (c) => {
    const dir = machineLogDir();
    if (!dir) return c.json({ items: [], configured: false });
    const items = [];
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
      if (!MACHINE_LOG.test(name)) continue;
      const st = await stat(join(dir, name)).catch(() => null);
      if (st?.isFile()) items.push({ name, size: st.size, updatedAt: st.mtime.toISOString() });
    }
    return c.json({ items, configured: true });
  });

  /** 機械のログのファイルを、そのままダウンロードする。 */
  app.get('/logs/files/:name', async (c) => {
    const dir = machineLogDir();
    const name = c.req.param('name');
    if (!dir || !MACHINE_LOG.test(name)) return c.json({ error: 'ファイルが見つかりません' }, 404);
    const path = join(dir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return c.json({ error: 'ファイルが見つかりません' }, 404);
    await audit(c, 'log.download', name, { file: name, size: st.size });
    c.header('Content-Type', name.endsWith('.gz') ? 'application/gzip' : name.endsWith('.bz2') ? 'application/x-bzip2' : 'text/plain; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${name}"`);
    c.header('Content-Length', String(st.size));
    return c.body(Readable.toWeb(createReadStream(path)) as unknown as ReadableStream);
  });

  /** 証拠保全の一覧（新しい順）。 */
  app.get('/evidence', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ items: await store.listEvidence(tenant.id) });
  });

  /** 証拠保全を頼む（本文 `reason`・`days`（1〜28。既定 28））。ワーカーが組み立てて、できたら管理者に知らせる。 */
  app.post('/evidence', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ reason?: unknown; days?: unknown }>().catch(() => ({} as { reason?: unknown; days?: unknown }));
    const reason = String(b.reason ?? '').trim();
    if (!reason || reason.length > 300) return c.json({ error: '理由を 1〜300 字で書いてください' }, 400);
    const days = b.days === undefined ? SYSTEM_LOG_KEEP_DAYS : Number(b.days);
    if (!(days >= 1 && days <= SYSTEM_LOG_KEEP_DAYS)) return c.json({ error: `保全する期間は 1〜${SYSTEM_LOG_KEEP_DAYS} 日にしてください` }, 400);
    const id = `ev-${randomUUID()}`;
    const to = new Date();
    await store.requestEvidence(tenant.id, { id, scope: 'machine', reason, createdKind: 'user', createdBy: user.id, from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() });
    await audit(c, 'evidence.create', id, { days });
    return c.json({ id }, 202);
  });

  /** 保全した ZIP をダウンロードする（できあがったものだけ）。 */
  app.get('/evidence/:id/download', async (c) => {
    const { tenant } = c.get('ctx');
    const id = c.req.param('id');
    const p = await store.getEvidence(tenant.id, id);
    if (!p || p.status !== 'ready') return c.json({ error: '保全したものが見つかりません' }, 404);
    await audit(c, 'evidence.download', id, { size: p.size, sha256: p.sha256 });
    // 8 MB ずつ読みながら流す（全体を記憶に載せない）
    let seq = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const chunk = await store.evidenceChunk(tenant.id, id, seq++);
        if (chunk) ctrl.enqueue(chunk); else ctrl.close();
      },
    });
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="evidence-${p.createdAt.slice(0, 10)}-${id.slice(3, 11)}.zip"`);
    if (p.size) c.header('Content-Length', String(p.size));
    return c.body(stream);
  });

  /** 1 年を過ぎた保全を消す（本文 `reason`）。1 年に満たなければ 409。 */
  app.delete('/evidence/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const id = c.req.param('id');
    const b = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
    const reason = String(b.reason ?? '').trim();
    if (!reason || reason.length > 300) return c.json({ error: '消す理由を 1〜300 字で書いてください' }, 400);
    const p = await store.getEvidence(tenant.id, id);
    if (!p || p.status === 'deleted') return c.json({ error: '保全したものが見つかりません' }, 404);
    if (Date.parse(p.createdAt) > Date.now() - 365 * 86_400_000) return c.json({ error: '保全してから 1 年は消せません' }, 409);
    if (!(await store.deleteEvidence(tenant.id, id, user.id, reason))) return c.json({ error: '消せませんでした' }, 409);
    await audit(c, 'evidence.delete', id, {});
    return c.json({ ok: true });
  });

  return app;
}
