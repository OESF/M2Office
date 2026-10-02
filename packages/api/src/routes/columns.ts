/**
 * @file Web のコラム（内蔵の拡張）の API。一覧・書く・詳細・直す・書き直しを頼む・直し案に置き換える・前の版に戻す・
 * 承認へ進める・写す形・削除。
 *
 * 会社が Web のコラムを切っているときと、利用範囲の外の人には、どの口も使わせない。コラムは会社で共有する。
 * 設定と WordPress の鍵は管理者の口（拡張機能）で扱う。
 *
 * @see 仕様書 第32.18.1節 段 1 の実装の決まり
 */

import { Hono, type Context } from 'hono';
import { AI_NOT_CONFIGURED_MESSAGE, WEB_COLUMN_PLACE, aiAvailable, enqueueJob, type ColumnViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Web のコラムの API（仕様書 第32章）。
 *
 * @remarks 監査ログは処理（ColumnService）が残す（書く・承認へ進める・入れる・削除）
 */
export function columnsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.columns;
  const who = (c: Context<AppEnv>): ColumnViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // Web のコラムを使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.columns.access(tenant.id, user.id))) {
      return c.json({ error: 'Web のコラムは使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** コラムの一覧（新しい順）と、入れ先の WordPress。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [columns, settings] = await Promise.all([service.list(tenant.id), deps.repo.getTenantSettings(tenant.id)]);
    return c.json({ columns, wordpress: settings.webColumns.wordpress });
  });

  /**
   * コラムを書き始める。書き上げは裏で進め、すぐに ID を返す（状態「書いています」）。
   *
   * @returns 作ったコラムの ID。推論が使えなければ 409
   */
  app.post('/', async (c) => {
    const { tenant } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const res = await service.create(who(c), { theme: str(body['theme']) ?? '', memo: str(body['memo']) ?? '' });
    return 'error' in res ? c.json({ error: res.error }, 400) : c.json(res, 201);
  });

  /** 1 つのコラムと版の一覧。 */
  app.get('/:id', async (c) => {
    const d = await service.detail(who(c), c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'コラムが見つかりません' }, 404);
  });

  /** 直して保存する（新しい版になる）。 */
  app.put('/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const sns = (body['sns'] ?? {}) as Record<string, unknown>;
    const err = await service.saveEdit(who(c), c.req.param('id'), {
      ...(str(body['title']) !== undefined ? { title: str(body['title'])! } : {}),
      ...(str(body['body']) !== undefined ? { body: str(body['body'])! } : {}),
      ...(str(body['description']) !== undefined ? { description: str(body['description'])! } : {}),
      sns: { ...(str(sns['short']) !== undefined ? { short: str(sns['short'])! } : {}), ...(str(sns['long']) !== undefined ? { long: str(sns['long'])! } : {}) },
    });
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 指示で書き直してもらう（新しい版になる）。 */
  app.post('/:id/rewrite', async (c) => {
    const { tenant } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const err = await service.rewrite(who(c), c.req.param('id'), str(body['instruction']) ?? '');
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 書けなかったコラムを、もう一度書く。 */
  app.post('/:id/retry', async (c) => {
    const { tenant } = c.get('ctx');
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const err = await service.retry(who(c), c.req.param('id'));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 赤入れの直し案に置き換える（今の版の `index` 番目）。 */
  app.post('/:id/suggestions/:index', async (c) => {
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: '指摘が見つかりません' }, 400);
    const err = await service.applySuggestion(who(c), c.req.param('id'), index);
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 前の版に戻す（その版を写した新しい版を足す）。 */
  app.post('/:id/versions/:version/restore', async (c) => {
    const err = await service.restore(who(c), c.req.param('id'), Number(c.req.param('version')));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 記事に入れる形（Markdown と HTML）。写して使う。 */
  app.get('/:id/export', async (c) => {
    const e = await service.exported(who(c), c.req.param('id'));
    return e ? c.json(e) : c.json({ error: 'コラムが見つかりません' }, 404);
  });

  /**
   * 承認へ進める（業務「コラムを WordPress に入れる」を始め、責任者の承認を待つ。第32.18.1節）。
   *
   * @returns 実行の ID。入れられない理由があれば 400
   */
  app.post('/:id/submit', async (c) => {
    const { tenant, user } = c.get('ctx');
    const v = who(c);
    const id = c.req.param('id');
    await service.syncAwaiting(v, id);
    const col = await service.store.get(tenant.id, id);
    if (!col) return c.json({ error: 'コラムが見つかりません' }, 404);
    if (col.status === 'awaiting') return c.json({ error: 'すでに承認へ進めています' }, 409);
    const p = await service.preview(v, id);
    if (!p) return c.json({ error: 'コラムが見つかりません' }, 404);
    if (p.problems.length > 0) return c.json({ error: p.problems.join('／') }, 400);
    const def = (await deps.tenantView(tenant.id)).resolve(WEB_COLUMN_PLACE.id, WEB_COLUMN_PLACE.version);
    if (!def) return c.json({ error: 'コラムを WordPress に入れる業務が見つかりません' }, 404);
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const { runId } = await enqueueJob(deps.repo, {
      tenantId: tenant.id, requestedBy: user.id, def, input: { columnId: id }, origin: 'menu', actor: { type: 'user', id: user.id },
    });
    await service.markAwaiting(v, id, runId, p);
    return c.json({ runId }, 201);
  });

  /** 削除する（承認へ進めていないものだけ）。 */
  app.delete('/:id', async (c) => {
    const err = await service.remove(who(c), c.req.param('id'));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  return app;
}
