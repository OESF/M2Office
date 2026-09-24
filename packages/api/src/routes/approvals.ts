/**
 * @file 承認トレイの API。本人が判断できる承認待ちの一覧と、承認・却下の受付。
 *
 * @see 仕様書 第9.2.3節 承認者の指定
 * @see 仕様書 第9.3節 実行ライフサイクル
 */

import { Hono } from 'hono';
import { canDecide } from '@m2office/shared';
import { ApprovalForbiddenError, RunNotResumableError } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 承認トレイ。承認待ちの一覧と、承認・却下の受付。
 *
 * @remarks
 * 承認の API 化は慎重に扱う（仕様書 第13.3節）。
 * 外部アプリからの承認は既定で禁止とし、ここでは画面からの操作だけを受ける。
 * `external-send` と `financial` は恒久的に API 承認を禁止する。
 */
export function approvalsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 本人が判断できる承認待ちだけを返す（ロール、または依頼者本人。仕様書 第9.2.3節）。 */
  app.get('/', async (c) => {
    const ctx = c.get('ctx');
    const pending = (await deps.repo.listPendingApprovals(ctx.tenant.id))
      .filter((a) => canDecide(a, ctx.user));
    /*
      どの業務の承認かを添える（仕様書 第6.2.4節）。
      **開く前に、何を判断するのかが分かること。** 「承認の依頼」が並ぶだけでは選べない。
      定義が見つからないときは業務の ID を返す。**推測で名前を作らない。**
    */
    const view = await deps.tenantView(ctx.tenant.id);
    const items = [];
    for (const a of pending) {
      const step = await deps.repo.getRunStepById(ctx.tenant.id, a.runStepId);
      const run = step ? await deps.repo.getRun(ctx.tenant.id, step.runId) : null;
      const job = run ? await deps.repo.getJob(ctx.tenant.id, run.jobId) : null;
      const agentName = job
        ? (view.allAgents.find((x) => x.id === job.agentId)?.name ?? job.agentId)
        : null;
      items.push({ ...a, agentName });
    }
    return c.json({ items });
  });

  app.post('/:id', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const body = await c.req.json<{ decision: 'approved' | 'rejected'; comment?: string }>();

    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return c.json({ error: 'decision は approved か rejected を指定してください' }, 400);
    }

    try {
      const result = await deps.engine.decideApproval(
        ctx.tenant.id, id, body.decision, { id: ctx.user.id, roles: ctx.user.roles },
        body.comment ?? null,
      );
      return c.json({ runId: result.runId, decision: body.decision });
    } catch (err) {
      if (err instanceof ApprovalForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      if (err instanceof RunNotResumableError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  return app;
}
