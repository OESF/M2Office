/**
 * @file 補助金・助成金の案内（内蔵の拡張）の API。候補の一覧・いま調べる・気になる／見送り。
 *
 * 会社が切っているときと、利用範囲の外の人には、どの口も使わせない。申請の書類は作らない（第39.6節）。
 * 会社の関心と業種を直すのは管理者で、`PUT /v1/admin/extensions/subsidies/settings`（拡張機能の口）で行う。
 *
 * @see 仕様書 第39章
 */

import { Hono, type Context } from 'hono';
import type { SubsidyStatus } from '@m2office/shared';
import type { SubsidyViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 補助金・助成金の案内の API（仕様書 第39章）。
 *
 * @remarks 監査ログは処理（SubsidyService）が残す
 */
export function subsidiesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.subsidies;
  const who = (c: Context<AppEnv>): SubsidyViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // 補助金・助成金の案内を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.subsidies.access(tenant.id, user.id))) {
      return c.json({ error: '補助金・助成金の案内は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 候補（締め切りの近い順。過ぎたもの・見送りも含む）と、調べるのに使った会社のこと・関心・最後に調べた日時・調べているか・相談先の地域の窓口（第39.18節）。 */
  app.get('/', async (c) => {
    const w = who(c);
    const settings = (await deps.repo.getTenantSettings(w.tenantId)).subsidies;
    const searching = !!settings.searchingSince && Date.now() - Date.parse(settings.searchingSince) < 10 * 60_000;
    return c.json({
      items: await service.list(w), today: service.today(), profile: settings.profile, interest: settings.interest, industry: settings.industry,
      searchedAt: settings.searchedAt, searching, admin: c.get('ctx').user.roles.includes('admin'),
      contacts: await service.contactsOf(w.tenantId),
    });
  });

  /** いま調べる（後ろで調べる。同じ会社は 1 日 1 回まで）。 */
  app.post('/search', async (c) => {
    const r = await service.start(who(c));
    if ('error' in r) return c.json({ error: r.error }, 409);
    if ('already' in r) return c.json({ error: '今日はもう調べました（調べるのは 1 日 1 回までです）', searchedAt: r.searchedAt }, 409);
    return c.json({ ok: true }, 202);
  });

  /** 気になる・見送り・新しいに戻す。 */
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '候補が見つかりません' }, 404);
    const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }));
    const problem = await service.mark(who(c), id, String(body.status ?? '') as SubsidyStatus);
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 400);
    return c.json({ ok: true });
  });

  return app;
}
