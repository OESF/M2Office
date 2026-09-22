import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * 実行の詳細。進捗・ステップ・根拠・成果物を返す。
 *
 * 画面のサッシパネル（仕様書 第6.2節）はこの応答を表示する。
 *
 * @remarks
 * 見られるのは、依頼した本人と、承認者のロールを持つ者である。
 * 承認者は判断のために中身を見る必要があるため。
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
    const isApprover = ctx.user.roles.includes('approver');
    if (job?.requestedBy !== ctx.user.id && !isApprover) {
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
