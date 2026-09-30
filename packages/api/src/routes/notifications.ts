/**
 * @file 本人宛の通知（お知らせ）の一覧・既読・消す API。
 *
 * @see 仕様書 第6.5.5節 通知
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 本人宛の通知（仕様書 第6.5.5節）。
 *
 * @remarks
 * 本人の通知だけを返し、消す。管理者であっても他人の通知は見られず、消せない（不変則 I-10）。
 */
export function notificationsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const items = await deps.repo.listNotifications(tenant.id, user.id, 50);
    return c.json({ items, unread: items.filter((n) => !n.readAt).length });
  });

  app.post('/:id/read', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.markNotificationRead(tenant.id, user.id, c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: '通知が見つかりません' }, 404);
  });

  /** 選んだお知らせをまとめて消す（本文 `ids`。本人の分だけ消える。100 件まで）。 */
  app.post('/delete', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
    if (!Array.isArray(b.ids) || b.ids.length === 0) return c.json({ error: '消すお知らせを選んでください' }, 400);
    if (b.ids.length > 100) return c.json({ error: '一度に消せるのは 100 件までです' }, 400);
    const ids = [...new Set(b.ids.filter((x): x is string => typeof x === 'string'))];
    return c.json({ deleted: await deps.repo.deleteNotifications(tenant.id, user.id, ids) });
  });

  /** お知らせを 1 件消す（本人の分だけ）。 */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const n = await deps.repo.deleteNotifications(tenant.id, user.id, [c.req.param('id')]);
    return n ? c.json({ ok: true }) : c.json({ error: '通知が見つかりません' }, 404);
  });

  return app;
}
