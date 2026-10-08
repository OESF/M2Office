/**
 * @file 実行の詳細（ステップ・根拠・成果物）を返す API と、実行を途中で止める API。
 *
 * 詳細は画面の実行の詳細が表示する。
 *
 * @see 仕様書 第6.2.2節 実行の結果の示し方、第9.3.1節 実行の中止
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { CANCELLABLE, canViewRun, cancelRun, createdDriveLinks, stepLabel } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 本人が止めたときの理由。実行の `failureReason` と、知らせる文に使う。 */
const CANCEL_REASON = '依頼した人が止めました';

/**
 * 実行の詳細。進捗・ステップ・根拠・成果物を返す。
 *
 * 画面の実行の詳細（仕様書 第6.2.2節）はこの応答を表示する。
 *
 * @remarks
 * 見られるのは、依頼した本人と、その実行に自分が判断できる承認がある人だけである（仕様書 第6.2.1節）。
 * 承認者の役割を持つだけでは見られない。中身には Google から取得したメールなどが入るため。
 * それ以外の利用者には、存在自体を示さず 404 を返す。
 */
export function runsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/:id', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const run = await deps.repo.getRun(ctx.tenant.id, id);
    // テナントを跨いだ取得は null になる。存在自体を示さない
    if (!run) return c.json({ error: '実行が見つかりません' }, 404);

    const job = await deps.repo.getJob(ctx.tenant.id, run.jobId);
    // 代理アクセスの業務の結果は、許した管理者が自分で依頼した実行だけ（承認者として見られる実行も含めない。第23.6.1節）
    if (c.get('auth').method === 'proxy' && job?.requestedBy !== ctx.user.id) return c.json({ error: '実行が見つかりません' }, 404);
    if (!job || !(await canViewRun(deps.repo, ctx.tenant.id, job, run.id, ctx.user))) {
      return c.json({ error: '実行が見つかりません' }, 404);
    }
    const [steps, artifacts, agents] = await Promise.all([
      deps.repo.listRunSteps(ctx.tenant.id, id),
      deps.repo.listArtifacts(ctx.tenant.id, id),
      deps.agentsFor(ctx.tenant.id),
    ]);
    /*
      段の表示名（仕様書 第9.2.4節）。画面は動いている間、これを 1 行で出す（第6.2.2.2節）。
      定義が見つからないとき（拡張機能を外した後など）は、段の ID をそのまま返す。
      **推測で名前を作らない。**
    */
    const def = agents.find((a) => a.id === job.agentId);
    const labels = new Map((def?.steps ?? []).map((st) => [st.id, stepLabel(st)]));
    const labelled = steps.map((st) => ({ ...st, label: labels.get(st.stepId) ?? st.stepId }));
    // 誰がいつ判断したか（仕様書 第6.2.5節）。依頼した人が、自分の業務を誰が承認したかを確かめられるように
    const decisions = [];
    for (const a of await deps.repo.listRunApprovals(ctx.tenant.id, id)) {
      if (!a.decision) continue;
      const who = a.decidedBy ? (await deps.repo.findUserById(ctx.tenant.id, a.decidedBy))?.displayName ?? null : null;
      decisions.push({ runStepId: a.runStepId, decision: a.decision, decidedBy: who, decidedAt: a.decidedAt, comment: a.comment });
    }
    // 段の並び（動いている間の進み具合に使う。第6.2.2.2節）。定義が見つからなければ空
    const plan = (def?.steps ?? []).map((st) => ({ stepId: st.id, label: stepLabel(st), kind: st.type }));
    return c.json({ run, job, steps: labelled, artifacts, decisions, plan });
  });

  /**
   * 実行の中止（仕様書 第9.3.1節）。
   *
   * 止められるのは**依頼した本人だけ**である。承認する人は却下を、
   * 会社全体を止める必要があるときは緊急停止（第23.8.6節）を使う。
   */
  app.post('/:id/cancel', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const run = await deps.repo.getRun(ctx.tenant.id, id);
    if (!run) return c.json({ error: '実行が見つかりません' }, 404);
    const job = await deps.repo.getJob(ctx.tenant.id, run.jobId);
    // 見られない実行は存在自体を示さない（第6.2.1節）
    if (!job || !(await canViewRun(deps.repo, ctx.tenant.id, job, run.id, ctx.user))) {
      return c.json({ error: '実行が見つかりません' }, 404);
    }
    // 見られても止められるとは限らない。止められるのは依頼した本人だけ
    if (job.requestedBy !== ctx.user.id) {
      return c.json({ error: '止められるのは、依頼した本人だけです' }, 403);
    }
    if (!CANCELLABLE.has(run.status)) {
      return c.json({ error: 'この実行はすでに終わっています' }, 409);
    }

    const result = await cancelRun(
      deps.repo, job, run, CANCEL_REASON, { actorType: 'user', actorId: ctx.user.id },
    );
    if (!result.stopped) return c.json({ error: 'この実行はすでに終わっています' }, 409);

    const at = new Date().toISOString();
    for (const userId of result.approvers) {
      await deps.repo.createNotification({
        id: randomUUID(), tenantId: ctx.tenant.id, userId, kind: 'approval',
        title: '承認待ちの業務が止まりました',
        body: `${CANCEL_REASON}。この承認は判断しなくてよくなりました。`,
        runId: run.id, readAt: null, createdAt: at,
      });
    }
    // 中止は、すでに起きたことを取り消さない。作りかけの文書があれば示す（第9.3.1節）
    const leftoverLinks = await createdDriveLinks(deps.repo, ctx.tenant.id, run.id);
    return c.json({ ok: true, leftoverLinks });
  });

  return app;
}
