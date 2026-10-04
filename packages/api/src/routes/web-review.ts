/**
 * @file Web の振り返り（内蔵の拡張）の API。状態といちばん新しい月の便り・便りの一覧・月ごとの便り・直すべき所（段 2）。
 *
 * 会社が Web の振り返りを切っているときと、利用範囲の外の人には、どの口も使わせない。
 * つなぐ・外す・サイトを選ぶは管理者ページの拡張機能の口（`/v1/admin/extensions/web-review/…`）で行う。
 *
 * @see 仕様書 第34.18節 段 1 の実装の決まり
 */

import { Hono } from 'hono';
import type { WebReviewFindingStatus } from '@m2office/shared';
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

  /** 状態（始める前の手伝い）と、いちばん新しい月の便りと、便りの一覧と、直すべき所（新しい・見たもの）。 */
  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const [status, latest, reports, admin, findings, settings] = await Promise.all([
      service.status(tenant.id), service.report(tenant.id), service.reports(tenant.id), service.isAdmin(tenant.id, user.id),
      service.findings(tenant.id), deps.repo.getTenantSettings(tenant.id),
    ]);
    return c.json({ status, latest, reports, admin, findings, checkedAt: settings.webReview.checkedAt ?? null, checkRequested: !!settings.webReview.checkRequestedAt, agency: settings.webReview.agency ?? null });
  });

  /** 直すべき所（`all=1` なら済んだ・見送りも）。 */
  app.get('/findings', async (c) => c.json({ findings: await service.findings(c.get('ctx').tenant.id, c.req.query('all') === '1') }));

  /** 直すべき所の状態を変える（`status`: new・seen・done・dismissed）。 */
  app.patch('/findings/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const err = await service.setFindingStatus({ tenantId: tenant.id, userId: user.id }, c.req.param('id'), String(body['status'] ?? '') as WebReviewFindingStatus);
    return err ? c.json({ error: err }, err.includes('見つかりません') ? 404 : 400) : c.json({ ok: true });
  });

  /** 依頼文を制作会社に送る業務を始める（承認の後に送る。`to` で宛先を変えられる。第34.21節）。 */
  app.post('/findings/:id/send', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.submitRequest({ tenantId: tenant.id, userId: user.id }, c.req.param('id'), typeof body['to'] === 'string' && body['to'].trim() ? body['to'] : undefined);
    return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r, 201);
  });

  /** 今すぐチェック（管理者）。ワーカーが次の見回り（1 分ごと）で探す。 */
  app.post('/check', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!(await service.isAdmin(tenant.id, user.id))) return c.json({ error: '今すぐチェックを頼めるのは管理者だけです' }, 403);
    const err = await service.requestCheck({ tenantId: tenant.id, userId: user.id });
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
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
