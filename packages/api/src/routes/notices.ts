/**
 * @file 社内のお知らせの API。本人宛ての一覧・出す・取り下げ・済んだ。
 *
 * 秘書も同じ処理（NoticeService）を使う（仕様書 第13.1節 A-2）。承認は挟まない（社内だけのもの）。
 *
 * @see 仕様書 第10.15節 社内のお知らせ
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 社内のお知らせの API（仕様書 第10.15節）。
 *
 * @remarks
 * 一覧は**本人宛ての**有効なものだけを返す（宛先の外の人に中身を見せない）。
 * 取り下げは出した人と管理者だけ。ほかの会社のお知らせは「見つからない」（不変則 I-2）。
 */
export function noticesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.notices.forUser(tenant.id, user.id);
    return c.json({ items });
  });

  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const result = await deps.notices.create(tenant.id, user.id, {
      title: String(b['title'] ?? ''),
      body: String(b['body'] ?? ''),
      link: String(b['link'] ?? ''),
      all: b['all'] === true,
      groupIds: Array.isArray(b['groupIds']) ? b['groupIds'].map(String) : [],
      dueOn: typeof b['dueOn'] === 'string' ? b['dueOn'] : null,
      until: typeof b['until'] === 'string' ? b['until'] : null,
    });
    if ('error' in result) return c.json({ error: result.error }, 400);
    return c.json({ notice: result.notice }, 201);
  });

  app.post('/:id/withdraw', async (c) => {
    const { tenant, user } = c.get('ctx');
    const result = await deps.notices.withdraw(tenant.id, user.id, c.req.param('id'));
    if ('error' in result) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  });

  app.post('/:id/done', async (c) => {
    const { tenant, user } = c.get('ctx');
    const result = await deps.notices.done(tenant.id, user.id, c.req.param('id'));
    if ('error' in result) return c.json({ error: result.error }, 404);
    return c.json({ ok: true });
  });

  return app;
}
