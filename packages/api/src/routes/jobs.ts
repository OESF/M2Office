/**
 * @file 業務の実行を依頼する API と、本人の実行履歴を返す API。
 *
 * 依頼は待ち行列へ入れるだけで、実行はワーカーが担う。
 *
 * @see 仕様書 第8.4節 同期・非同期の境界
 */

import { Hono } from 'hono';
import type { Job } from '@m2office/shared';
import { AI_NOT_CONFIGURED_MESSAGE, aiAvailable, enqueueJob } from '@m2office/core';
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

    const view = await deps.tenantView(ctx.tenant.id);
    const def = view.resolve(body.agentId, body.agentVersion ?? 1);
    // 導入していない・無効にした拡張機能の業務と、利用範囲の外の業務は、存在を示さない（第12.10.4節・第16.7.4節）
    if (!def || !(await deps.canUse(ctx.tenant.id, ctx.user.id, def.id))) {
      return c.json({ error: `エージェントが見つかりません: ${body.agentId}` }, 404);
    }
    const { agents } = await deps.repo.getTenantSettings(ctx.tenant.id);
    if (agents.disabled.includes(def.id)) {
      return c.json({ error: 'この業務は管理者によって無効にされています' }, 403);
    }
    // 推論が使えない会社では、業務を始めない（仕様書 第20.2.4節、ADR-0030）
    if (!aiAvailable(await deps.ai.llmFor(ctx.tenant.id))) {
      return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    }
    const origin = body.origin && USER_ORIGINS.includes(body.origin) ? body.origin : 'menu';

    const { jobId, runId } = await enqueueJob(deps.repo, {
      tenantId: ctx.tenant.id, requestedBy: ctx.user.id, def, input: body.input ?? {},
      origin, actor: { type: 'user', id: ctx.user.id },
    });
    // 秘書から始めた実行は、直前の会話に結び付ける。評価（承認されたか）を引くため（仕様書 第11.9.5節 第 4 項）
    if (origin === 'secretary') {
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      await deps.repo.linkConversationRun(ctx.tenant.id, ctx.user.id, runId, since);
    }
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
