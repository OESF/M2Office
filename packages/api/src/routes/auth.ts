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
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { clearSessionCookie, issueSession, readSession } from '../auth/session.js';

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
      tenant: { name: tenant.name, subdomain: tenant.subdomain },
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
   * Google でのログインを始める。
   *
   * @remarks
   * B-2 の完了後に、認可コードフロー（PKCE 付き）で実装する。
   * それまでは準備中であることを返す。黙って開発用ログインへ切り替えない。
   */
  app.get('/google/start', (c) =>
    c.json(
      { error: 'Google ログインは準備中です。OAuth クライアントの設定（B-2）の完了後に有効になります。' },
      503,
    ),
  );

  /** ログアウト。ログイン状態を失効させ、Cookie を消す。 */
  app.post('/logout', async (c) => {
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
