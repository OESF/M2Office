import { Hono } from 'hono';
import type { RequestContext } from '@m2office/shared';
import type { AppDeps } from '../context.js';

/** 監査ログの参照（仕様書 第16.6節）。 */
export function auditRoute(deps: AppDeps) {
  const app = new Hono<{ Variables: { ctx: RequestContext } }>();
  app.get('/', async (c) => {
    const ctx = c.get('ctx');
    const items = await deps.repo.listAudit(ctx.tenant.id, 100);
    return c.json({ items });
  });
  return app;
}
