/**
 * @file Web の振り返り（内蔵の拡張）の API。状態といちばん新しい月の便り・便りの一覧・月ごとの便り。
 *
 * 会社が Web の振り返りを切っているときと、利用範囲の外の人には、どの口も使わせない。
 * つなぐ・外す・サイトを選ぶは管理者ページの拡張機能の口（`/v1/admin/extensions/web-review/…`）で行う。
 *
 * @see 仕様書 第34.18節 段 1 の実装の決まり
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Web の振り返りの API（仕様書 第34章）。
 *
 * @remarks 便りは集計の数字だけで、個人の情報を含まない（第34.13節）。利用範囲の中の人が見られる
 */
export function webReviewRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.webReview;

  // Web の振り返りを使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.webReview.access(tenant.id, user.id))) {
      return c.json({ error: 'Web の振り返りは使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 状態（始める前の手伝い）と、いちばん新しい月の便りと、便りの一覧。 */
  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const [status, latest, reports, admin] = await Promise.all([
      service.status(tenant.id), service.report(tenant.id), service.reports(tenant.id), service.isAdmin(tenant.id, user.id),
    ]);
    return c.json({ status, latest, reports, admin });
  });

  /** 便りの一覧（新しい順）。 */
  app.get('/reports', async (c) => c.json({ reports: await service.reports(c.get('ctx').tenant.id) }));

  /** 月ごとの便り（`YYYY-MM`）。 */
  app.get('/reports/:month', async (c) => {
    const month = c.req.param('month');
    if (!MONTH.test(month)) return c.json({ error: '月が読めません' }, 400);
    const report = await service.report(c.get('ctx').tenant.id, month);
    return report ? c.json({ report }) : c.json({ error: 'その月の便りはありません' }, 404);
  });

  return app;
}
