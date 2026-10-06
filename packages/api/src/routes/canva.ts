/**
 * @file 本人の Canva の接続（仕様書 第41.19.3節）。個人設定の「サービスとの接続」から、つなぐ・状態・切断。と、Canva からの戻り。
 *
 * 運営が `CANVA_CLIENT_ID`・`CANVA_CLIENT_SECRET`（か開発の `CANVA_MOCK=true`）を設定したときだけ使える。
 * トークンは暗号化して本人ごとに持ち、画面にも API にも出さない。
 */

import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { createPkce } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { isOperational } from '../middleware/tenant.js';

async function audit(deps: AppDeps, tenantId: string, userId: string, action: string) {
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'canva', targetId: userId, detail: {}, occurredAt: new Date().toISOString(),
  });
}

/**
 * 個人設定の Canva の接続の API（`/v1/me/canva`）。
 *
 * @param returnTo 接続のあとに戻す画面を、要求から決める（Google の接続と同じ）
 */
export function myCanvaRoute(deps: AppDeps, returnTo: (c: Context<AppEnv>) => string) {
  const app = new Hono<AppEnv>();

  /** 運営が設定しているか、本人がつないでいるか。 */
  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.canva) return c.json({ configured: false, connected: false, connectedAt: null });
    return c.json({ configured: true, ...(await deps.canva.status({ tenantId: tenant.id, userId: user.id })) });
  });

  /** つなぐ（Canva の許可の画面の URL を返す。PKCE）。 */
  app.post('/connect', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.canva) return c.json({ error: 'Canva は使えません' }, 404);
    const { verifier, challenge } = createPkce();
    const state = deps.oauth.states.issue({ tenantId: tenant.id, userId: user.id, codeVerifier: verifier, returnTo: returnTo(c), purpose: 'canva' });
    return c.json({ url: deps.canva.authorizeUrl(state, challenge) });
  });

  /** 切断する（Canva の許可も取り消す）。 */
  app.delete('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.canva) return c.json({ error: 'Canva は使えません' }, 404);
    if (!(await deps.canva.disconnect({ tenantId: tenant.id, userId: user.id }))) return c.json({ error: 'Canva とつないでいません' }, 404);
    await audit(deps, tenant.id, user.id, 'canva.disconnect');
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Canva からの戻り（`/v1/oauth/canva/callback`）。テナントの判定とログインより前に受ける。`state` を照合してテナントと利用者を引く。
 */
export function registerCanvaCallback(app: Hono, deps: AppDeps): void {
  app.get('/canva/callback', async (c) => {
    const pending = deps.oauth.states.take(c.req.query('state') ?? '');
    // Canva の要求の state でなければ受けない（取り違えを防ぐ）
    if (!pending || pending.purpose !== 'canva' || !deps.canva) {
      return c.text('この接続の要求は無効か、期限が切れています。M2Office の個人設定からもう一度「つなぐ」を押してください。', 400);
    }
    // 戻り先は会社の接続と同じ知らせ方（`connection=<結果>&id=canva`）にする
    const back = (result: string) => c.redirect(`${pending.returnTo}${pending.returnTo.includes('?') ? '&' : '?'}connection=${result}&id=canva`);
    if (c.req.query('error')) return back('cancelled');
    const code = c.req.query('code');
    if (!code) return back('failed');
    const tenant = await deps.repo.findTenantById(pending.tenantId);
    if (!tenant || !isOperational(tenant)) return back('failed');
    try {
      await deps.canva.finishConnect({ tenantId: pending.tenantId, userId: pending.userId }, code, pending.codeVerifier);
      await audit(deps, pending.tenantId, pending.userId, 'canva.connect');
      return back('connected');
    } catch (err) {
      deps.log.warn('Canva の接続に失敗しました', { tenantId: pending.tenantId, err: err instanceof Error ? err.message : String(err) });
      return back('failed');
    }
  });
}
