/**
 * @file ログインとログアウトの API。
 *
 * 正式なログインは Google アカウントのみ。OAuth クライアントが整うまでは、
 * 開発用ログイン（利用者を選ぶ）で骨格を動かす。
 *
 * @see 仕様書 第16.1節 認証
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { companyName, type AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { buildGoogleLoginUrl, createPkce } from '@m2office/core';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { clearSessionCookie, issueSession, readSession } from '../auth/session.js';
import { PROXY_COOKIE } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

/**
 * ログインとログアウト。
 *
 * テナントの解決は済んでいるが、利用者の確認はまだ行っていない段階で呼ばれる。
 *
 * @remarks
 * 正式なログインは Google アカウント（OpenID Connect）に一本化する（仕様書 第16.1節）。
 * OAuth クライアント（docs/google-setup.md の B-2）が整うまでは、
 * 開発用ログイン（利用者を選ぶ）で骨格を動かす。開発用ログインは本番で起動を拒否する。
 */
export function authRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 使えるログイン手段。画面はこれを見てボタンを出し分ける。 */
  app.get('/providers', async (c) => {
    const tenant = c.get('tenant');
    const devUsers = deps.auth.devLogin
      ? (await deps.repo.listUsers(tenant.id))
          .filter((u) => u.status === 'active')
          .map((u) => ({ email: u.email, displayName: u.displayName, roles: u.roles }))
      : [];
    return c.json({
      // ログイン画面に出す会社名も、会社情報の正式な会社名（仕様書 第6.6.1節）
      tenant: { name: await companyName(deps, tenant), subdomain: tenant.subdomain },
      google: deps.auth.googleConfigured
        ? { enabled: true }
        : { enabled: false, reason: 'Google ログインは準備中です（OAuth クライアントの設定待ち）' },
      dev: { enabled: deps.auth.devLogin, users: devUsers },
    });
  });

  /**
   * 開発用ログイン。利用者を選ぶだけでログインできる。
   *
   * @remarks
   * 本番では `AUTH_DEV_LOGIN` を有効にできない（起動時に検査する）。
   * それでも、Workspace のドメインとの照合は本番と同じく行う（仕様書 第16.1節「テナント判定」）。
   */
  app.post('/dev-login', async (c) => {
    if (!deps.auth.devLogin) return c.json({ error: '開発用ログインは無効です' }, 404);
    const tenant = c.get('tenant');
    const { email } = await c.req.json<{ email?: string }>();
    if (!email) return c.json({ error: 'メールアドレスを指定してください' }, 400);

    const domain = email.split('@')[1];
    if (tenant.workspaceDomain && domain !== tenant.workspaceDomain) {
      return c.json({ error: 'このテナントのドメインではありません' }, 403);
    }
    const user = await deps.repo.findUserByEmail(tenant.id, email);
    if (!user || user.status !== 'active') {
      return c.json({ error: '招待されていない利用者です' }, 403);
    }

    const session = await issueSession(c, deps.repo, deps.auth, {
      tenantId: tenant.id, userId: user.id, provider: 'dev',
    });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
      action: 'auth.login', targetType: 'session', targetId: session.id.slice(0, 16),
      detail: { provider: 'dev' }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, csrfToken: session.csrfToken });
  });

  /**
   * Google でのログインを始める（仕様書 第16.1.2節）。
   *
   * @remarks
   * 使うのは**運営の OAuth クライアント**であり、求める権限は
   * `openid`・`email`・`profile` だけである（第16.1.1節）。
   *
   * 戻り先は運営のホスト 1 本である。どの会社から始めたかは `state` に入れて運ぶ。
   */
  app.get('/google/start', (c) => {
    const tenant = c.get('tenant');
    const login = deps.auth.login;
    if (!login) {
      return c.json(
        { error: 'Google ログインは準備中です。OAuth クライアントの設定（B-2）の完了後に有効になります。' },
        503,
      );
    }
    const { verifier, challenge } = createPkce();
    const state = deps.loginStates.issue({
      tenantId: tenant.id,
      // ログインの時点では、まだ誰かが分からない
      userId: '',
      codeVerifier: verifier,
      // 戻す先は、始めた会社のホストである
      returnTo: tenantOrigin(c.req.header('origin'), c.req.header('host')),
    });
    return c.json({
      url: buildGoogleLoginUrl({
        clientId: login.clientId, redirectUri: login.redirectUri, state, codeChallenge: challenge,
        // Google 側でも会社のドメインに絞る。こちらでも必ず確かめる
        ...(tenant.workspaceDomain ? { hostedDomain: tenant.workspaceDomain } : {}),
      }),
    });
  });

  /**
   * 引換券を、この会社のホストでのログイン状態に換える（仕様書 第16.1.2節）。
   *
   * @remarks
   * ログイン状態の Cookie は `Domain` を付けないため、運営のホストで張っても
   * 会社のホストには届かない。**この口でだけ、そのホストの Cookie を張る。**
   *
   * 券は 1 回しか使えない。会社が食い違えば拒否する。
   */
  app.post('/exchange', async (c) => {
    const tenant = c.get('tenant');
    const { ticket } = await c.req.json<{ ticket?: string }>().catch(() => ({ ticket: undefined }));
    const hit = ticket ? deps.handoffs.take(ticket) : null;
    // 券が違う会社のものなら、使わせない（券は消費済みである）
    if (!hit || hit.tenantId !== tenant.id) {
      return c.json({ error: 'ログインをやり直してください' }, 401);
    }
    const user = await deps.repo.findUserById(tenant.id, hit.userId);
    if (!user || user.status !== 'active') {
      return c.json({ error: 'ログインをやり直してください' }, 401);
    }
    const session = await issueSession(c, deps.repo, deps.auth, {
      tenantId: tenant.id, userId: user.id, provider: 'google',
    });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
      action: 'auth.login', targetType: 'session', targetId: session.id.slice(0, 16),
      detail: { provider: 'google' }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, csrfToken: session.csrfToken });
  });

  /**
   * 運営のサポートの代理アクセスに入る（仕様書 第23.6.1節）。運営の画面が出した 1 回だけの引換券を、閲覧だけのログイン状態に換える。
   *
   * @remarks 券は 2 分で切れ、1 回しか使えない。会社の管理者が許していて、期限の中のときだけ通す
   */
  app.post('/proxy-exchange', async (c) => {
    const tenant = c.get('tenant');
    const { ticket } = await c.req.json<{ ticket?: string }>().catch(() => ({ ticket: undefined }));
    const hit = ticket ? await deps.proxy.exchange(tenant.id, ticket) : null;
    if (!hit) return c.json({ error: '代理アクセスに入れませんでした。運営の画面からもう一度開いてください' }, 401);
    const maxAge = Math.max(60, Math.floor((Date.parse(hit.grant.expiresAt ?? '') - Date.now()) / 1000));
    setCookie(c, PROXY_COOKIE, hit.token, { httpOnly: true, sameSite: 'Lax', secure: deps.auth.cookieSecure, path: '/', maxAge });
    await deps.repo.appendAudit({
      id: randomUUID(), tenantId: tenant.id, actorType: 'system', actorId: `ops:${hit.grant.operatorId}`, action: 'proxy.enter',
      targetType: 'proxy', targetId: hit.grant.id, detail: { scope: hit.grant.scope, operator: hit.grant.operatorLabel }, occurredAt: new Date().toISOString(),
    });
    return c.json({ ok: true, csrfToken: hit.csrfToken });
  });

  /** ログアウト。ログイン状態を失効させ、Cookie を消す。 */
  app.post('/logout', async (c) => {
    // 代理アクセスの閲覧を終える（第23.6.1節）
    const proxyToken = getCookie(c, PROXY_COOKIE);
    const proxy = proxyToken ? await deps.proxy.findSession(c.get('tenant').id, proxyToken) : null;
    if (proxyToken) {
      if (proxy) {
        if (c.req.header('x-csrf-token') !== proxy.csrfToken) return c.json({ error: '画面を再読み込みしてから、もう一度お試しください' }, 403);
        await deps.proxy.endSession(c.get('tenant').id, proxy.sessionId);
      }
      deleteCookie(c, PROXY_COOKIE, { path: '/' });
      return c.json({ ok: true });
    }
    const session = await readSession(c, deps.repo, c.get('tenant').id);
    if (session) {
      if (c.req.header('x-csrf-token') !== session.csrfToken) {
        return c.json({ error: '画面を再読み込みしてから、もう一度お試しください' }, 403);
      }
      await deps.repo.revokeSession(session.tenantId, session.id, new Date());
      await deps.repo.appendAudit({
        id: randomUUID(), tenantId: session.tenantId, actorType: 'user', actorId: session.userId,
        action: 'auth.logout', targetType: 'session', targetId: session.id.slice(0, 16),
        detail: {}, occurredAt: new Date().toISOString(),
      });
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
}
