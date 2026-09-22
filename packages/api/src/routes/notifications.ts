import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 本人宛の通知（仕様書 第6.5.5節）。
 *
 * @remarks
 * 本人の通知だけを返す。管理者であっても他人の通知は見られない（不変則 I-10）。
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

  return app;
}
