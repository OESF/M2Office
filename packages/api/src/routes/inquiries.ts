/**
 * @file 問い合わせの記録（内蔵の拡張）の API。一覧・残す（1 行の欄）・1 件・続きを足す・別の問い合わせに分ける・直す・次にやること・削除。
 *
 * 会社が問い合わせの記録を切っているときと、利用範囲の外の人には、どの口も使わせない。問い合わせは会社で共有する。
 *
 * @see 仕様書 第33.17節 段 1 の実装の決まり
 */

import { Hono, type Context } from 'hono';
import type { InquiryViewer, RecordResult } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * 問い合わせの記録の API（仕様書 第33章）。
 *
 * @remarks 監査ログは処理（InquiryService）が残す（残す・続き・直す・次にやること・削除）
 */
export function inquiriesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.inquiries;
  const who = (c: Context<AppEnv>): InquiryViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // 問い合わせの記録を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.inquiries.access(tenant.id, user.id))) {
      return c.json({ error: '問い合わせの記録は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 残した結果を画面に返す形。 */
  const recorded = (c: Context<AppEnv>, res: RecordResult) => {
    if (res.kind === 'error') return c.json({ error: res.error }, 400);
    if (res.kind === 'ambiguous') return c.json({ ambiguous: true, candidates: res.candidates }, 200);
    return c.json({
      kind: res.kind, inquiry: res.inquiry, task: res.task, closedTask: res.closedTask, sensitive: res.sensitive, contactCreated: res.contactCreated,
    }, res.kind === 'created' ? 201 : 200);
  };

  /** 一覧（`status`: open・done・dropped・all。`q`: 検索の言葉。`contactId`: 名刺管理の連絡先の問い合わせ）。 */
  app.get('/', async (c) => {
    const status = c.req.query('status');
    const items = await service.list(who(c), {
      status: status === 'open' || status === 'done' || status === 'dropped' ? status : 'all',
      ...(c.req.query('q') ? { search: c.req.query('q')! } : {}),
      ...(c.req.query('contactId') ? { contactId: c.req.query('contactId')! } : {}),
    });
    return c.json({ items });
  });

  /**
   * 1 行の欄に書いた文から残す。前の問い合わせの続きなら、同じ問い合わせに足す。
   *
   * @returns 新しく残したら 201、続きに足したら 200。どの続きか決まらなければ候補
   */
  app.post('/', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    return recorded(c, await service.record(who(c), str(body['text']) ?? ''));
  });

  /** 1 件と、会話の履歴と、次にやること。 */
  app.get('/:id', async (c) => {
    const detail = await service.detail(who(c), c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: '問い合わせが見つかりません' }, 404);
  });

  /** 1 件の画面から続きを足す（その問い合わせに足す）。 */
  app.post('/:id/events', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    return recorded(c, await service.record(who(c), str(body['text']) ?? '', { inquiryId: c.req.param('id') }));
  });

  /** 項目を直す（誰から・経路・分類・用件・どこで知ったか・温度感・状態）。 */
  app.patch('/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const from = body['from'] && typeof body['from'] === 'object' ? body['from'] as Record<string, unknown> : null;
    const err = await service.update(who(c), c.req.param('id'), {
      ...(from ? { from: { name: str(from['name']), company: str(from['company']), phone: str(from['phone']), email: str(from['email']) } as Record<string, string> } : {}),
      ...(str(body['channel']) !== undefined ? { channel: str(body['channel'])! } : {}),
      ...(str(body['category']) !== undefined ? { category: str(body['category'])! } : {}),
      ...(str(body['summary']) !== undefined ? { summary: str(body['summary'])! } : {}),
      ...(str(body['source']) !== undefined ? { source: str(body['source'])! } : {}),
      ...(str(body['temperature']) !== undefined ? { temperature: str(body['temperature'])! } : {}),
      ...(str(body['status']) !== undefined ? { status: str(body['status'])! } : {}),
    });
    if (err) return c.json({ error: err }, err.includes('見つかりません') ? 404 : 400);
    return c.json({ ok: true });
  });

  /** 次にやることを足す。 */
  app.post('/:id/tasks', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const err = await service.addTask(who(c), c.req.param('id'), {
      what: str(body['what']) ?? '', due: str(body['due']) ?? null, ...(str(body['assignee']) ? { assignee: str(body['assignee'])! } : {}),
    });
    if (err) return c.json({ error: err }, err.includes('見つかりません') ? 404 : 400);
    return c.json({ ok: true }, 201);
  });

  /** 次にやることを直す・済みにする。 */
  app.patch('/tasks/:taskId', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const err = await service.updateTask(who(c), c.req.param('taskId'), {
      ...(str(body['what']) !== undefined ? { what: str(body['what'])! } : {}),
      ...('due' in body ? { due: str(body['due']) || null } : {}),
      ...(str(body['assignee']) !== undefined ? { assignee: str(body['assignee'])! } : {}),
      ...(typeof body['done'] === 'boolean' ? { done: body['done'] } : {}),
    });
    if (err) return c.json({ error: err }, err.includes('見つかりません') ? 404 : 400);
    return c.json({ ok: true });
  });

  /** 会話の履歴 1 つを、別の問い合わせに分ける（続きとして入ったのが別の用件だったとき）。 */
  app.post('/events/:eventId/split', async (c) => {
    const res = await service.split(who(c), c.req.param('eventId'));
    if ('error' in res) return c.json({ error: res.error }, res.error.includes('見つかりません') ? 404 : 400);
    return c.json(res, 201);
  });

  /** 削除する（残した本人と管理者だけ）。 */
  app.delete('/:id', async (c) => {
    const err = await service.remove(who(c), c.req.param('id'));
    if (err) return c.json({ error: err }, err.includes('見つかりません') ? 404 : 403);
    return c.json({ ok: true });
  });

  return app;
}
