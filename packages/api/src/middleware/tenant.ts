/**
 * @file 要求ごとに、テナントの解決・利用者の確認・ロールの確認を行うミドルウェア。
 *
 * ここで確定したテナントを、以降のすべてのデータアクセスに持ち回る（不変則 I-2）。
 * 利用者を確認できない要求は、誰でもないものとして 401 を返す。
 *
 * @see 仕様書 第8.5節 マルチテナントの分離方式
 * @see 仕様書 第20.7節 認証の実装方針
 */

import type { Context, Next } from 'hono';
import type { RequestContext, Tenant } from '@m2office/shared';
import type { Logger } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { readSession } from '../auth/session.js';

/** 認証の結果。どの手段で本人を確認したか。 */
export type AuthInfo =
  | { method: 'session'; sessionId: string; csrfToken: string }
  | { method: 'dev-header' };

/** API 全体で共有する要求ごとの変数。 */
export interface AppEnv {
  Variables: {
    tenant: Tenant;
    ctx: RequestContext;
    auth: AuthInfo;
    /** 要求ごとの ID。応答の `X-Request-Id` と同じ（開発規約 第7.4節）。 */
    requestId: string;
    /** 要求 ID を固定したロガー。 */
    log: Logger;
  };
}

/**
 * ホスト名からテナントを解決する。
 *
 * `a.lvh.me:3101` の `a` をサブドメインとして扱う。
 * 開発と外部からの確認のため、`X-Tenant` ヘッダーでの指定も受け付ける。
 *
 * @remarks
 * テナント境界: ここで確定した `tenantId` を、以降のすべてのデータ
 * アクセスに持ち回る（不変則 I-2）。解決できない要求は処理しない。
 *
 * @see 仕様書 第8.5節 マルチテナントの分離方式
 */
export function resolveTenant(deps: AppDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    const host = c.req.header('host') ?? '';
    const explicit = deps.auth.devHeaders ? c.req.header('x-tenant') : undefined;
    const subdomain = explicit ?? extractSubdomain(host);

    if (!subdomain) {
      return c.json({ error: 'テナントを特定できません。サブドメインを指定してください。' }, 400);
    }
    const tenant = await deps.repo.findTenantBySubdomain(subdomain);
    if (!tenant) {
      return c.json({ error: `テナントが見つかりません: ${subdomain}` }, 404);
    }
    // 緊急停止はログインを含めてすべて止める。理由は返さない（仕様書 第23.8.6節）
    if (tenant.status === 'locked') {
      return c.json({ error: 'この会社のご利用は、現在停止しています。管理者にお問い合わせください' }, 403);
    }
    // 解約済みは「エクスポートのみ」だが、持ち出しが未実装のためすべて拒否する（第23.3節）
    if (tenant.status === 'cancelled') {
      return c.json({ error: 'この会社のご契約は終了しています' }, 403);
    }
    // 通常の停止は閲覧のみ。業務の依頼・承認・設定の変更は受け付けない（第23.8.6節）
    if (tenant.status === 'suspended' && !allowedWhileSuspended(c.req.method, c.req.path)) {
      return c.json({ error: SUSPENDED_MESSAGE, suspended: true }, 403);
    }
    c.set('tenant', tenant);
    await next();
  };
}

/** 通常の停止の間に、閲覧以外の操作を断るときの文。 */
export const SUSPENDED_MESSAGE = 'この会社のご利用は停止中のため、閲覧だけができます。業務の依頼・承認・設定の変更は、再開のあとに行ってください';

/**
 * 通常の停止（`suspended`）の間に受け付ける書き込み。閲覧（`GET` など）は別にすべて受け付ける。
 *
 * @remarks 仕様書 第23.8.6節「通常の停止で受け付ける書き込み」の表と一致させる。
 */
const WRITES_WHILE_SUSPENDED: { method: string; path: RegExp }[] = [
  // ログインとログアウト。閲覧にはログインが要る
  { method: 'POST', path: /^\/v1\/auth\/(dev-login|logout)$/ },
  // お知らせの既読。業務のデータを変えない
  { method: 'POST', path: /^\/v1\/notifications\/[^/]+\/read$/ },
  // ログイン中の端末のログアウト。乗っ取りへの備え（R-13）
  { method: 'DELETE', path: /^\/v1\/me\/sessions\/[^/]+$/ },
];

/**
 * 通常の停止の間に、この要求を受け付けるか。
 *
 * @param method HTTP メソッド
 * @param path 要求のパス（`/v1/...`）
 * @returns 閲覧か、停止中でも受け付ける書き込みなら `true`
 *
 * @remarks
 * `GET` でも状態を変える入口（Google のログインの開始）は、閲覧とみなさず断る。
 * Google からの戻り（`/v1/oauth/...`）はテナントの判定より前に受けるため、その経路で別に状態を確かめる。
 */
export function allowedWhileSuspended(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method)) return path !== '/v1/auth/google/start';
  return WRITES_WHILE_SUSPENDED.some((w) => w.method === method && w.path.test(path));
}

/**
 * テナントが業務を受け付ける状態か（試用・稼働中）。
 *
 * @remarks 停止中・緊急停止・解約済みでは、Google との接続のような書き込みを行わない。
 */
export function isOperational(tenant: Pick<Tenant, 'status'>): boolean {
  return tenant.status === 'trial' || tenant.status === 'active';
}

/** 状態を変えない HTTP メソッド。CSRF の確認を要しない。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 利用者を確認する。確認できなければ 401 を返す。
 *
 * @remarks
 * 確認の順序は次のとおり。
 * 1. ログイン状態の Cookie。テナントが一致しなければ拒否する
 * 2. `X-User` ヘッダー。**開発用**であり、`AUTH_DEV_HEADERS=true` のときだけ受け付ける
 *
 * Cookie で確認した要求のうち、状態を変えるものは `X-CSRF-Token` の一致を求める
 * （仕様書 第20.7節「CSRF」）。
 *
 * 以前は利用者の指定が無いと管理者として扱っていたが、これは取りやめた。
 * 指定が無ければ、誰でもなく、ログインを求める。
 */
export function authenticate(deps: AppDeps) {
  return async (c: Context<AppEnv>, next: Next) => {
    const tenant = c.get('tenant');

    const session = await readSession(c, deps.repo, tenant.id);
    if (session) {
      if (session.tenantId !== tenant.id) {
        return c.json({ error: 'ログインが必要です', login: true }, 401);
      }
      const user = await deps.repo.findUserById(tenant.id, session.userId);
      if (!user || user.status !== 'active') {
        return c.json({ error: 'この利用者は現在ご利用いただけません', login: true }, 401);
      }
      if (!SAFE_METHODS.has(c.req.method) && c.req.header('x-csrf-token') !== session.csrfToken) {
        return c.json({ error: '画面を再読み込みしてから、もう一度お試しください' }, 403);
      }
      await deps.repo.touchSession(tenant.id, session.id, new Date());
      c.set('ctx', { tenant, user });
      c.set('auth', { method: 'session', sessionId: session.id, csrfToken: session.csrfToken });
      return next();
    }

    const email = deps.auth.devHeaders ? c.req.header('x-user') : undefined;
    if (email) {
      const user = await deps.repo.findUserByEmail(tenant.id, email);
      if (!user || user.status !== 'active') {
        return c.json({ error: `利用者が見つかりません: ${email}` }, 401);
      }
      c.set('ctx', { tenant, user });
      c.set('auth', { method: 'dev-header' });
      return next();
    }

    return c.json({ error: 'ログインが必要です', login: true }, 401);
  };
}

/**
 * 指定したロールのいずれかを持つ利用者だけを通す。
 *
 * @param roles 通すロール
 */
export function requireRole(...roles: string[]) {
  return async (c: Context<AppEnv>, next: Next) => {
    const { user } = c.get('ctx');
    if (!user.roles.some((r) => roles.includes(r))) {
      return c.json({ error: 'この操作を行う権限がありません' }, 403);
    }
    await next();
  };
}

/** `a.lvh.me` や `a.m2office.online` から先頭のラベルを取り出す。 */
export function extractSubdomain(host: string): string | null {
  const name = host.split(':')[0] ?? '';
  const labels = name.split('.');
  if (labels.length < 2) return null;
  const first = labels[0];
  if (!first || RESERVED.has(first)) return null;
  return first;
}

/**
 * 運営が使う名前は払い出さない（仕様書 第20.4.3節）。
 *
 * @remarks `ops` は運営の画面が使う（第23.8.2節、Q-60）。顧客のサブドメインとして通さない。
 */
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'ops', 'mail', 'docs', 'status', 'help', 'localhost',
]);
