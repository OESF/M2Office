/**
 * @file 実行の詳細（ステップ・根拠・成果物）を返す API。画面のサッシパネルが表示する。
 *
 * @see 仕様書 第6.2節 サッシパネルの表示内容
 */

import { Hono } from 'hono';
import { canViewRun } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

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

  return app;
}
