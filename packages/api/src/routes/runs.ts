import { Hono } from 'hono';
import type { RequestContext } from '@m2office/shared';
import type { AppDeps } from '../context.js';

/**
 * 実行の詳細。進捗・ステップ・根拠・成果物を返す。
 *
 * 画面のサッシパネル（仕様書 第18.2節）はこの応答を表示する。
 */
export function runsRoute(deps: AppDeps) {
  const app = new Hono<{ Variables: { ctx: RequestContext } }>();

  app.get('/:id', async (c) => {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const run = await deps.repo.getRun(ctx.tenant.id, id);
    // テナントを跨いだ取得は null になる。存在自体を示さない
    if (!run) return c.json({ error: '実行が見つかりません' }, 404);

    const [steps, artifacts, job] = await Promise.all([
      deps.repo.listRunSteps(ctx.tenant.id, id),
      deps.repo.listArtifacts(ctx.tenant.id, id),
      deps.repo.getJob(ctx.tenant.id, run.jobId),
    ]);
    return c.json({ run, job, steps, artifacts });
  });

  return app;
}
