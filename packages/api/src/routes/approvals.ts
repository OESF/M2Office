/**
 * @file 承認トレイの API。本人が判断できる承認待ちの一覧、承認・却下の受付、本人が判断したものの履歴。
 *
 * @see 仕様書 第9.2.3節 承認者の指定
 * @see 仕様書 第9.3節 実行ライフサイクル
 * @see 仕様書 第6.2.5節 判断したもの（承認の履歴）
 */

import { Hono } from 'hono';
import { agentDisplayName, canDecide } from '@m2office/shared';
import { ApprovalForbiddenError, RunNotResumableError, describeContext, executedCalls } from '@m2office/core';
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
/** 「判断したもの」に出す件数（仕様書 第6.2.5節）。 */
const DECIDED_LIMIT = 100;

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
      定義が見つからない（業務を削除した）ときは、依頼のときに残した名前を出す。ID をそのまま出さない。**推測で名前を作らない。**
    */
    const view = await deps.tenantView(ctx.tenant.id);
    const items = [];
    for (const a of pending) {
      const step = await deps.repo.getRunStepById(ctx.tenant.id, a.runStepId);
      const run = step ? await deps.repo.getRun(ctx.tenant.id, step.runId) : null;
      const job = run ? await deps.repo.getJob(ctx.tenant.id, run.jobId) : null;
      const agentName = job
        ? agentDisplayName(view.allAgents.find((x) => x.id === job.agentId)?.name, job.agentId, job.agentName)
        : null;
      items.push({ ...a, agentName });
    }
    return c.json({ items });
  });

  /**
   * 本人が判断したもの（仕様書 第6.2.5節）。何を承認したか（判断したときの承認の画面）と、どのように承認したか、
   * 承認のあとに実際に行ったことと結果を返す。新しい順に 100 件まで。
   *
   * @remarks 自動で通過した承認・期限切れ・取り消しは含まない（人が判断していない）。本人の判断だけを返す
   */
  app.get('/decided', async (c) => {
    const ctx = c.get('ctx');
    const view = await deps.tenantView(ctx.tenant.id);
    const rows = await deps.repo.listDecidedApprovals(ctx.tenant.id, ctx.user.id, DECIDED_LIMIT);
    const names = new Map<string, string>();
    const nameOf = async (userId: string) => {
      if (!names.has(userId)) names.set(userId, (await deps.repo.findUserById(ctx.tenant.id, userId))?.displayName ?? '');
      return names.get(userId)!;
    };
    const items = [];
    for (const a of rows) {
      const [step, artifacts] = await Promise.all([
        deps.repo.getRunStepById(ctx.tenant.id, a.runStepId),
        deps.repo.listArtifacts(ctx.tenant.id, a.runId),
      ]);
      items.push({
        id: a.id, runId: a.runId,
        // 定義が見つからなければ、依頼のときに残した名前を出す。推測で名前を作らない
        agentName: agentDisplayName(view.resolve(a.agentId, a.agentVersion)?.name ?? view.allAgents.find((x) => x.id === a.agentId)?.name, a.agentId, a.agentName),
        decision: a.decision, decidedAt: a.decidedAt, comment: a.comment, present: a.present,
        // 自分が依頼したものでなければ、依頼した人を出す
        requestedBy: a.requestedBy === ctx.user.id ? null : await nameOf(a.requestedBy),
        done: a.decision === 'approved' ? executedCalls(step, describeContext(view.registry, artifacts)) : [],
      });
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
