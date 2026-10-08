/**
 * @file 管理者ページの「サポートの閲覧」（仕様書 第23.6.1節）。運営のサポートからの代理アクセスの申請を、会社の管理者が許すか断り、許した閲覧を切る。
 *
 * 同意は会社の管理者の誰か 1 人。許すときに期限（1 時間・4 時間・1 日・3 日）を選ぶ。運営の側は決めた関数でしか触れない。
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { PROXY_DEFAULT_HOURS } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/**
 * サポートの閲覧の申請の一覧と、許す・断る・切る。
 *
 * @remarks 危険度: 社内の設定の変更（運営に会社の画面を見せるかどうか）。会社の管理者だけ。すべて会社の監査ログに残す
 */
export function supportAccessRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 監査ログに残す。 */
  const audit = (c: { get: (k: 'ctx') => { tenant: { id: string }; user: { id: string } } }, action: string, grantId: string, detail: Record<string, unknown> = {}) => {
    const ctx = c.get('ctx');
    return deps.repo.appendAudit({
      id: randomUUID(), tenantId: ctx.tenant.id, actorType: 'user', actorId: ctx.user.id, action, targetType: 'proxy', targetId: grantId, detail,
      occurredAt: new Date().toISOString(),
    });
  };

  app.get('/', async (c) => c.json({ items: await deps.proxy.list(c.get('ctx').tenant.id) }));

  app.post('/:id/approve', async (c) => {
    const { hours } = await c.req.json<{ hours?: number }>().catch(() => ({ hours: undefined }));
    const ctx = c.get('ctx');
    const g = await deps.proxy.decide(ctx.tenant.id, c.req.param('id'), true, Number(hours ?? PROXY_DEFAULT_HOURS), ctx.user.id);
    if (!g) return c.json({ error: 'この申請は、もう扱えません' }, 409);
    await audit(c, 'proxy.approve', g.id, { hours: g.hours, scope: g.scope, operator: g.operatorLabel });
    return c.json({ item: g });
  });

  app.post('/:id/deny', async (c) => {
    const ctx = c.get('ctx');
    const g = await deps.proxy.decide(ctx.tenant.id, c.req.param('id'), false, 0, ctx.user.id);
    if (!g) return c.json({ error: 'この申請は、もう扱えません' }, 409);
    await audit(c, 'proxy.deny', g.id, { operator: g.operatorLabel });
    return c.json({ item: g });
  });

  app.post('/:id/revoke', async (c) => {
    const ctx = c.get('ctx');
    const g = await deps.proxy.revoke(ctx.tenant.id, c.req.param('id'), ctx.user.id);
    if (!g) return c.json({ error: 'この閲覧は、もう終わっています' }, 409);
    await audit(c, 'proxy.revoke', g.id, { operator: g.operatorLabel });
    return c.json({ item: g });
  });

  return app;
}
