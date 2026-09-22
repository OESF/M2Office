import { Hono } from 'hono';
import { OFFICIAL_AGENTS } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/**
 * 管理者ページ（`/admin`）が使う API（仕様書 第6.6節）。
 *
 * 管理者ロールを持つ者だけが呼べる。
 *
 * @remarks
 * **管理者でも、他人の会話ログと個人記憶、実行の中身は見られない**（不変則 I-10）。
 * ここで返すのは実行の状態と監査の記録であり、やり取りの中身ではない。
 * 実行の一覧に入力や成果物を含めないのはそのためである。
 */
export function adminRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));

  /** 利用者と権限（第6.6.4節）。 */
  app.get('/users', async (c) => {
    const { tenant } = c.get('ctx');
    const users = await deps.repo.listUsers(tenant.id);
    return c.json({ items: users });
  });

  /** 実行の一覧。状態・費用・起動経路だけを返す（第6.6.8節）。 */
  app.get('/runs', async (c) => {
    const { tenant } = c.get('ctx');
    const rows = await deps.repo.listRunsWithJobs(tenant.id, { limit: 100 });
    // 入力（job.input）と成果物は返さない。状態を見るためのものであり、中身を見るためではない
    const items = rows.map(({ run: r, job }) => ({
      id: r.id, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
      tokensUsed: r.tokensUsed, costJpy: r.costJpy,
      agentId: job.agentId, agentName: OFFICIAL_AGENTS.find((a) => a.id === job.agentId)?.name ?? job.agentId,
      origin: job.origin, requestedBy: job.requestedBy,
    }));
    return c.json({ items });
  });

  /** 利用量の集計。エージェント別の件数と費用（第6.6.7節）。 */
  app.get('/usage', async (c) => {
    const { tenant } = c.get('ctx');
    const rows = await deps.repo.usageByAgent(tenant.id);
    const items = rows.map((r) => ({
      ...r,
      name: OFFICIAL_AGENTS.find((a) => a.id === r.agentId)?.name ?? r.agentId,
      costJpy: Math.round(r.costJpy * 100) / 100,
    }));
    return c.json({
      items,
      total: {
        runs: items.reduce((s, i) => s + i.runs, 0),
        costJpy: Math.round(items.reduce((s, i) => s + i.costJpy, 0) * 100) / 100,
      },
      note: null,
    });
  });

  /** 監査ログ（第16.6節）。 */
  app.get('/audit-events', async (c) => {
    const { tenant } = c.get('ctx');
    const items = await deps.repo.listAudit(tenant.id, 200);
    return c.json({ items });
  });

  /** 接続の状態（第6.6.3節）。Google 未接続の間はダミーであることを示す。 */
  app.get('/connectors', (c) =>
    c.json({
      workspace: {
        source: deps.connector.source,
        label: deps.connector.source === 'mock'
          ? 'ダミーデータで動作中（Google 未接続）'
          : 'Google Workspace に接続中',
      },
      llm: { provider: deps.llm.name },
    }),
  );

  return app;
}
