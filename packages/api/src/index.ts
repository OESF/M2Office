import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { RequestContext } from '@m2office/shared';
import { buildDeps } from './context.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { agentsRoute } from './routes/agents.js';
import { jobsRoute } from './routes/jobs.js';
import { runsRoute } from './routes/runs.js';
import { approvalsRoute } from './routes/approvals.js';
import { secretaryRoute } from './routes/secretary.js';
import { auditRoute } from './routes/audit.js';

/**
 * API サーバー。
 *
 * @remarks
 * 画面が使う API と外部公開 API は同じものである（仕様書 第11.1節 A-1・A-2）。
 * 画面専用の抜け道を作らない。SPA 構成により、これは構造として保たれる。
 */
const deps = buildDeps();
const app = new Hono<{ Variables: { ctx: RequestContext } }>();

// 開発時は画面（3100）から API（3101）を呼ぶため、同一オリジンではない
app.use('*', cors({
  origin: (origin) => origin,
  credentials: true,
  allowHeaders: ['content-type', 'x-tenant', 'x-user'],
}));

app.get('/health', (c) => c.json({ ok: true, service: 'api' }));

app.use('/v1/*', tenantMiddleware(deps));
app.get('/v1/me', (c) => {
  const ctx = c.get('ctx');
  return c.json({ tenant: ctx.tenant, user: ctx.user });
});
app.route('/v1/agents', agentsRoute);
app.route('/v1/jobs', jobsRoute(deps));
app.route('/v1/runs', runsRoute(deps));
app.route('/v1/approvals', approvalsRoute(deps));
app.route('/v1/secretary', secretaryRoute(deps));
app.route('/v1/audit-events', auditRoute(deps));

const port = Number(process.env['API_PORT'] ?? 3101);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] http://localhost:${info.port} で待ち受けています`);
  console.log(`[api] 例: curl -H 'x-tenant: a' http://localhost:${info.port}/v1/agents`);
});
