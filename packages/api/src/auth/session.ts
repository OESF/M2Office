import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Session } from '@m2office/shared';
import type { Repository } from '@m2office/core';
import type { AuthConfig } from './config.js';

/** ログイン状態を持つ Cookie の名前。 */
export const SESSION_COOKIE = 'm2o_session';

/** Cookie の値からデータベース上の ID を求める。値そのものは保存しない。 */
export function sessionIdOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * ログイン状態を作り、Cookie を発行する。
 *
 * @param c 要求の文脈
 * @param repo 永続化層
 * @param config 認証の設定
 * @param who ログインした利用者と、確認に使った手段
 * @returns 作成したログイン状態
 *
 * @remarks
 * Cookie は `HttpOnly`・`SameSite=Lax` とし、`Domain` 属性を付けない。
 * これにより `a.m2office.online` の Cookie は `b.m2office.online` へ送られない
 * （仕様書 第20.7節「対象範囲」）。
 *
 * ログインは「本人の確認」と「ログイン状態の発行」の 2 段に分けてある。
 * 本人の確認の手段（Google・開発用）を増やしても、この関数は変わらない。
 * 追加の確認を差し込む場合もこの手前に置く（仕様書 第20.7節「2 段階認証」）。
 */
export async function issueSession(
  c: Context,
  repo: Repository,
  config: AuthConfig,
  who: { tenantId: string; userId: string; provider: Session['provider'] },
): Promise<Session> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const session: Session = {
    id: sessionIdOf(token),
    tenantId: who.tenantId,
    userId: who.userId,
    csrfToken: randomBytes(24).toString('base64url'),
    provider: who.provider,
    userAgent: c.req.header('user-agent')?.slice(0, 300) ?? null,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.sessionTtlHours * 3_600_000).toISOString(),
    revokedAt: null,
  };
  await repo.createSession(session);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlHours * 3600,
  });
  return session;
}

/**
 * Cookie から有効なログイン状態を探す。無ければ `null`。
 *
 * @remarks 探すのは要求先のテナントの中だけである。他社で発行された Cookie は見つからない。
 */
export async function readSession(
  c: Context,
  repo: Repository,
  tenantId: string,
): Promise<Session | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return repo.findActiveSession(tenantId, sessionIdOf(token), new Date());
}

/** Cookie を消す。ログイン状態の失効は呼び出し側で行う。 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
