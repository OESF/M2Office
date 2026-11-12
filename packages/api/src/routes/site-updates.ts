/**
 * @file サイトの更新（内蔵の拡張）の API。つないでいるサイト・直しの記録の一覧・1 件・元に戻す（承認へ進める）。
 *
 * 会社がサイトの更新を切っているときと、利用範囲の外の人には、どの口も使わせない。
 * **サイトに入れるのは承認の後だけ**（付属の業務「サイトに入れる」）。元に戻すのも、承認へ進めるだけ。
 *
 * @see 仕様書 第45.8節・第45.11節
 */

import { Hono, type Context } from 'hono';
import type { SiteUpdateViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * サイトの更新の API（仕様書 第45章）。
 *
 * @remarks 監査ログは処理（SiteUpdateService）が残す。直し案を作るのは秘書から（画面に編集の欄は作らない。第45.3節）
 */
export function siteUpdatesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.siteUpdates;
  const who = (c: Context<AppEnv>): SiteUpdateViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // サイトの更新を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.siteUpdates.access(tenant.id, user.id))) {
      return c.json({ error: 'サイトの更新は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 直しの記録（新しい順）。 */
  app.get('/', async (c) => c.json({ items: await service.list(who(c)) }));

  /** つないでいるサイト（名前・URL・利用者・直せるか）。開いたときに WordPress に問い合わせる。 */
  app.get('/site', async (c) => c.json(await service.site(who(c))));

  /** 本人の WordPress の接続（個人設定の「サービスとの接続」。第45.16節）。パスワードは返さない。 */
  app.get('/wordpress-user', async (c) => c.json(await service.wordpressUser(who(c))));

  /** 本人の WordPress の利用者をつなぐ（`username`・`password`）。会社のサイトで通るかを確かめてから預ける。 */
  app.put('/wordpress-user', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    const r = await service.connectWordPressUser(who(c), { username: s(body['username']), password: s(body['password']) });
    return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r);
  });

  /** 本人の WordPress の接続を外す。 */
  app.delete('/wordpress-user', async (c) => {
    await service.disconnectWordPressUser(who(c));
    return c.json({ ok: true });
  });

  /** 直し 1 件。 */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '直しが見つかりません' }, 404);
    const e = await service.get(who(c), id);
    return e ? c.json(e) : c.json({ error: '直しが見つかりません' }, 404);
  });

  /** 元に戻す直し案を作り、承認へ進める（第45.8節）。承認の実行の ID を返す。 */
  app.post('/:id/revert', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '直しが見つかりません' }, 404);
    const r = await service.revert(who(c), id);
    if ('error' in r) return c.json({ error: r.error }, 400);
    return c.json({ runId: r.runId, edit: r.edit });
  });

  return app;
}
