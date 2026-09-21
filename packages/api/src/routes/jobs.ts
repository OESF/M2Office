import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Job, RequestContext, Run } from '@m2office/shared';
import { resolveOfficialAgent } from '@m2office/core';
import type { AppDeps } from '../context.js';

/**
 * ジョブの作成と参照。
 *
 * @remarks
 * 作成は待ち行列へ入れるだけで、実行はワーカーが担う。
 * 呼び出し側を待たせない（仕様書 第6.4節）。
 */
export function jobsRoute(deps: AppDeps) {
  const app = new Hono<{ Variables: { ctx: RequestContext } }>();

  app.post('/', async (c) => {
    const ctx = c.get('ctx');
    const body = await c.req.json<{
      agentId: string;
      agentVersion?: number;
      input?: Record<string, unknown>;
      origin?: Job['origin'];
    }>();

    const version = body.agentVersion ?? 1;
    const def = resolveOfficialAgent(body.agentId, version);
    if (!def) {
      return c.json({ error: `エージェントが見つかりません: ${body.agentId}` }, 404);
    }

    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      tenantId: ctx.tenant.id,
      agentId: def.id,
      agentVersion: def.version,
      requestedBy: ctx.user.id,
      origin: body.origin ?? 'menu',
      input: body.input ?? {},
      createdAt: now,
    };
    const run: Run = {
      id: randomUUID(),
      jobId: job.id,
      tenantId: ctx.tenant.id,
      status: 'queued',
      cursor: 0,
      startedAt: now,
      endedAt: null,
      tokensUsed: 0,
      costJpy: 0,
      failureReason: null,
    };

    await deps.repo.createJob(job);
    await deps.repo.createRun(run);
    await deps.repo.appendAudit({
      id: randomUUID(),
      tenantId: ctx.tenant.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'job.create',
      targetType: 'job',
      targetId: job.id,
      detail: { agentId: def.id, runId: run.id, origin: job.origin },
      occurredAt: now,
    });

    return c.json({ jobId: job.id, runId: run.id, status: run.status }, 201);
  });

  app.get('/', async (c) => {
    const ctx = c.get('ctx');
    const runs = await deps.repo.listRuns(ctx.tenant.id, 50);
    const jobs = await Promise.all(
      runs.map(async (r) => {
        const job = await deps.repo.getJob(ctx.tenant.id, r.jobId);
        return { run: r, job };
      }),
    );
    return c.json({ items: jobs });
  });

  return app;
}
