/**
 * @file 契約の管理（内蔵の拡張）の API。一覧・1 件・手で入れる・契約書（ファイルか契約書チェックの実行）から入れる・直す・削除・契約書を開く。
 *
 * 会社が契約の管理を切っているときと、利用範囲の外の人には、どの口も使わせない。社外には何も出さない。
 *
 * @see 仕様書 第38.13節 API
 */

import { Hono, type Context } from 'hono';
import { CONTRACT_KIND_LABELS, type ContractKind, type ContractStatus } from '@m2office/shared';
import type { ContractViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 契約の管理の API（仕様書 第38章）。
 *
 * @remarks 監査ログは処理（ContractService）が残す
 */
export function contractsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.contracts;
  const who = (c: Context<AppEnv>): ContractViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // 契約の管理を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.contracts.access(tenant.id, user.id))) {
      return c.json({ error: '契約書の管理は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 一覧（期限の近い順。`status`: active・cancel_requested・ended・all、`kind`、`owner`（`me` か利用者の ID）、`q`）。 */
  app.get('/', async (c) => {
    const status = c.req.query('status');
    const kind = c.req.query('kind');
    const owner = c.req.query('owner');
    const w = who(c);
    const items = await service.list(w, {
      status: status === 'active' || status === 'cancel_requested' || status === 'ended' ? status as ContractStatus : 'all',
      ...(kind && kind in CONTRACT_KIND_LABELS ? { kind: kind as ContractKind } : {}),
      ...(owner ? { ownerId: owner === 'me' ? w.userId : owner.slice(0, 100) } : {}),
      ...(c.req.query('q') ? { search: c.req.query('q')!.slice(0, 100) } : {}),
    });
    const storage = (await deps.repo.getTenantSettings(w.tenantId)).contracts.storage;
    return c.json({ items, storage: storage ? { folderName: storage.folderName } : null });
  });

  /** 手で入れる（紙だけの古い契約など。第38.5節 ③）。 */
  app.post('/', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.create(who(c), body);
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 契約書から入れる（`fileId`: 上げた契約書のファイル、か `runId`: 契約書チェックの実行。第38.5節 ①②）。AI が項目を取り出す。 */
  app.post('/import', async (c) => {
    const body = await c.req.json<{ fileId?: unknown; runId?: unknown }>().catch(() => ({} as { fileId?: unknown; runId?: unknown }));
    const fileId = typeof body.fileId === 'string' && ID.test(body.fileId) ? body.fileId : null;
    const runId = typeof body.runId === 'string' && ID.test(body.runId) ? body.runId : null;
    if (!fileId && !runId) return c.json({ error: '契約書のファイルか、契約書チェックの実行を渡してください' }, 400);
    const r = fileId ? await service.importFile(who(c), fileId) : await service.importReview(who(c), runId);
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 名刺管理の会社と同じ相手の契約（`name`: 会社名。名刺の詳細に並べる。第38.18節）。 */
  app.get('/by-company', async (c) => c.json({ items: await service.byCompany(who(c), (c.req.query('name') ?? '').slice(0, 100)) }));

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.get(who(c), id) : null;
    return r ? c.json({ contract: r }) : c.json({ error: '契約が見つかりません' }, 404);
  });

  /** 直す（項目・状態・担当。日付や決まりを直すと期限を計算し直す）。 */
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const problem = ID.test(id) ? await service.update(who(c), id, body) : '契約が見つかりません';
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 400);
    return c.json({ contract: await service.get(who(c), id) });
  });

  /** 削除（入れた人と管理者だけ。ドライブの契約書は残す）。 */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const problem = ID.test(id) ? await service.remove(who(c), id) : '契約が見つかりません';
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 403);
    return c.json({ ok: true });
  });

  /** 契約書を開く（置き場をつないだ管理者の許可で、ドライブから読んで返す。第38.7節）。 */
  /** 契約書チェックで見直す（ドライブの契約書で契約書チェックを始める。第38.18節）。 */
  app.post('/:id/review', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '契約が見つかりません' }, 404);
    const r = await service.startReview(who(c), id);
    return 'error' in r ? c.json(r, r.error.includes('見つかりません') ? 404 : 400) : c.json(r, 201);
  });

  app.get('/:id/file', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '契約が見つかりません' }, 404);
    const r = await service.openFile(who(c), id);
    if ('error' in r) return c.json({ error: r.error }, 404);
    return new Response(Buffer.from(r.bytes), {
      headers: {
        'content-type': r.mimeType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      },
    });
  });

  return app;
}
