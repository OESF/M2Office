/**
 * @file 朝のブリーフ・週次ブリーフの画面の API（仕様書 第9.5.5.1.2節、Q-246）。本人の直近のブリーフと過去のブリーフを返す。
 *
 * - `GET /v1/briefs?agent=morning-brief&before=…` 本人のブリーフの一覧（新しい順・30 件ずつ。本文は省く）と、いままとめている実行
 * - `GET /v1/briefs/:runId` 本人のブリーフ 1 件（本文つき）
 * - `DELETE /v1/briefs/:runId` 本人のブリーフ 1 件を削除する
 *
 * 見られるのは本人だけ（管理者にも、運営の代理アクセスにも出さない）。ほかの人のブリーフは「見つかりません」と同じに返す。
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/** 一覧で 1 度に返す数。 */
const PAGE = 30;
/** まとめている最中とみなす実行の状態。 */
const RUNNING = new Set(['queued', 'running', 'awaiting_approval']);

/**
 * ブリーフの API。
 *
 * @remarks 業務がブリーフ（定義の `category` が `briefing`）でなければ 404。運営の代理アクセスでは 404（本人だけが見るため）
 */
export function briefsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 本人だけが使える。代理アクセスでは本人の私的な中身を見せない。 */
  app.use('*', async (c, next) => {
    if (c.get('auth').method === 'proxy') return c.json({ error: 'ブリーフが見つかりません' }, 404);
    await next();
  });

  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const agentId = c.req.query('agent') ?? '';
    const def = (await deps.agentsFor(tenant.id)).find((a) => a.id === agentId);
    if (!def || def.category !== 'briefing') return c.json({ error: 'ブリーフの業務が見つかりません' }, 404);
    const before = c.req.query('before');
    const valid = before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : undefined;
    const items = await deps.repo.listBriefs(tenant.id, user.id, agentId, { before: valid, limit: PAGE + 1 });
    // いままとめている実行（あれば、終わるまで画面で待つ）
    const running = valid ? null : (await deps.repo.listRunsWithJobs(tenant.id, { limit: 20, requestedBy: user.id }))
      .find((x) => x.job.agentId === agentId && RUNNING.has(x.run.status)) ?? null;
    return c.json({
      items: items.slice(0, PAGE),
      more: items.length > PAGE,
      running: running ? { runId: running.run.id, status: running.run.status, startedAt: running.run.startedAt } : null,
    });
  });

  app.get('/:runId', async (c) => {
    const { tenant, user } = c.get('ctx');
    const brief = await deps.repo.getBrief(tenant.id, user.id, c.req.param('runId'));
    return brief ? c.json({ brief }) : c.json({ error: 'ブリーフが見つかりません' }, 404);
  });

  app.delete('/:runId', async (c) => {
    const { tenant, user } = c.get('ctx');
    const ok = await deps.repo.deleteBrief(tenant.id, user.id, c.req.param('runId'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'ブリーフが見つかりません' }, 404);
  });

  return app;
}
