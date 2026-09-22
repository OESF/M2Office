import { Hono } from 'hono';
import type { Job } from '@m2office/shared';
import { enqueueJob, resolveOfficialAgent } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 利用者が指定できる起動経路。`schedule` はワーカーだけが使う。 */
const USER_ORIGINS: Job['origin'][] = ['menu', 'secretary', 'api'];

/**
 * ジョブの作成と参照。
 *
 * @remarks
 * 作成は待ち行列へ入れるだけで、実行はワーカーが担う。
 * 呼び出し側を待たせない（仕様書 第8.4節）。
 * 一覧は**本人が依頼したものだけ**を返す。全体の状態は管理者ページで見る。
 */
export function jobsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const ctx = c.get('ctx');
    const body = await c.req.json<{
      agentId: string;
      agentVersion?: number;
      input?: Record<string, unknown>;
      origin?: Job['origin'];
    }>();

    const def = resolveOfficialAgent(body.agentId, body.agentVersion ?? 1);
    if (!def) {
      return c.json({ error: `エージェントが見つかりません: ${body.agentId}` }, 404);
    }
    const { agents } = await deps.repo.getTenantSettings(ctx.tenant.id);
    if (agents.disabled.includes(def.id)) {
      return c.json({ error: 'この業務は管理者によって無効にされています' }, 403);
    }
    const origin = body.origin && USER_ORIGINS.includes(body.origin) ? body.origin : 'menu';

    const { jobId, runId } = await enqueueJob(deps.repo, {
      tenantId: ctx.tenant.id, requestedBy: ctx.user.id, def, input: body.input ?? {},
      origin, actor: { type: 'user', id: ctx.user.id },
    });
    return c.json({ jobId, runId, status: 'queued' }, 201);
  });

  app.get('/', async (c) => {
    const ctx = c.get('ctx');
    const items = await deps.repo.listRunsWithJobs(ctx.tenant.id, {
      limit: 50, requestedBy: ctx.user.id,
    });
    return c.json({ items });
  });

  return app;
}
