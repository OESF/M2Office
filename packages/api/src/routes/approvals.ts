import { Hono } from 'hono';
import { canDecide } from '@m2office/shared';
import { ApprovalForbiddenError, RunNotResumableError } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 承認トレイ。承認待ちの一覧と、承認・却下の受付。
 *
 * @remarks
 * 承認の API 化は慎重に扱う（仕様書 第11.3節）。
 * 外部アプリからの承認は既定で禁止とし、ここでは画面からの操作だけを受ける。
 * `external-send` と `financial` は恒久的に API 承認を禁止する。
 */
export function approvalsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 本人が判断できる承認待ちだけを返す（ロール、または依頼者本人。仕様書 第9.2.3節）。 */
  app.get('/', async (c) => {
    const ctx = c.get('ctx');
    const items = (await deps.repo.listPendingApprovals(ctx.tenant.id))
      .filter((a) => canDecide(a, ctx.user));
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
