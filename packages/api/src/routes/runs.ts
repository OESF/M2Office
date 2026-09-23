/**
 * @file 実行の詳細（ステップ・根拠・成果物）を返す API と、実行を途中で止める API。
 *
 * 詳細は画面のサッシパネルが表示する。
 *
 * @see 仕様書 第6.2節 サッシパネルの表示内容、第9.3.1節 実行の中止
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { CANCELLABLE, canViewRun, cancelRun, createdDriveLinks } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 本人が止めたときの理由。実行の `failureReason` と、知らせる文に使う。 */
const CANCEL_REASON = '依頼した人が止めました';

/**
 * 実行の詳細。進捗・ステップ・根拠・成果物を返す。
 *
 * 画面のサッシパネル（仕様書 第6.2節）はこの応答を表示する。
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
    if (!job || !(await canViewRun(deps.repo, ctx.tenant.id, job, run.id, ctx.user))) {
      return c.json({ error: '実行が見つかりません' }, 404);
    }
    const [steps, artifacts] = await Promise.all([
      deps.repo.listRunSteps(ctx.tenant.id, id),
      deps.repo.listArtifacts(ctx.tenant.id, id),
    ]);
    return c.json({ run, job, steps, artifacts });
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
