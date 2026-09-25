/**
 * @file Google の API を、利用者本人の許可で呼ぶための共通部分（仕様書 第14.3.4節）。
 *
 * アクセス トークンの取り直しと、Google の失敗を「断るときの言葉」に直す処理をここに集める。
 * Gmail とカレンダーの実装は、ここだけを通って Google を呼ぶ。
 */

import type { Repository } from '../../repository/types.js';
import type { SecretBox } from '../../secrets/box.js';
import {
  GOOGLE_OAUTH_ENDPOINTS, GoogleOAuthError, refreshGoogleAccessToken, type GoogleOAuthEndpoints,
} from '../../google/oauth.js';
import { ConnectorUnavailableError, type ConnectorPrincipal } from '../types.js';

/** 呼び先。テストでは手元の偽の Google に向ける。 */
export interface GoogleApiEndpoints {
  gmail: string;
  calendar: string;
  oauth: GoogleOAuthEndpoints;
}

export const GOOGLE_API_ENDPOINTS: GoogleApiEndpoints = {
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
  oauth: GOOGLE_OAUTH_ENDPOINTS,
};

/** アクセス トークンを、期限のこれだけ前に取り直す（ミリ秒）。 */
const REFRESH_MARGIN_MS = 60_000;

/** 1 回の呼び出しの待ち時間の上限（ミリ秒）。 */
const TIMEOUT_MS = 20_000;

/** 呼び先の API の、利用者に見せる名前。 */
export type GoogleApiName = 'Gmail' | 'カレンダー';

/**
 * 利用者ごとのアクセス トークンを配る（仕様書 第14.3.4節「誰の権限で呼ぶか」）。
 *
 * @remarks
 * **トークンはプロセスのメモリにだけ持つ。** データベースにもログにも書かない。
 * 期限の 1 分前まで使い回し、それを過ぎたら保存したリフレッシュ トークンから取り直す。
 * 取り直しは、依頼した本人の接続と、会社の OAuth クライアントで行う。ほかの人のもので代えない（不変則 I-9）。
 */
export class GoogleTokenSource {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly repo: Repository,
    private readonly box: SecretBox,
    private readonly endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 本人のアクセス トークンを返す。
   *
   * @throws {ConnectorUnavailableError} 接続していない・許可が取り消された・会社のクライアントが無いか誤り・届かない
   */
  async token(p: ConnectorPrincipal): Promise<string> {
    const key = `${p.tenantId}:${p.userId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - REFRESH_MARGIN_MS > this.now()) return hit.token;

    const [conn, cred] = await Promise.all([
      this.repo.getGoogleConnection(p.tenantId, p.userId),
      this.repo.getTenantCredential(p.tenantId, 'google_oauth'),
    ]);
    if (!conn) {
      throw new ConnectorUnavailableError('not-connected', 'Google と接続していません。個人設定の「Google 連携」で接続してください');
    }
    const clientId = typeof cred?.meta['clientId'] === 'string' ? cred.meta['clientId'] : '';
    if (!cred?.secretEnc || !clientId) {
      throw new ConnectorUnavailableError('no-client', '会社の Google 接続の設定がありません。管理者に伝えてください');
    }
    try {
      const r = await refreshGoogleAccessToken({
        clientId, clientSecret: this.box.decrypt(cred.secretEnc), refreshToken: this.box.decrypt(conn.refreshTokenEnc),
      }, this.endpoints);
      this.cache.set(key, { token: r.accessToken, expiresAt: this.now() + r.expiresIn * 1000 });
      return r.accessToken;
    } catch (err) {
      if (err instanceof GoogleOAuthError && err.detail === 'invalid_grant') {
        throw new ConnectorUnavailableError('revoked', 'Google の許可が取り消されたか、期限が切れています。個人設定の「Google 連携」で接続し直してください');
      }
      if (err instanceof GoogleOAuthError && err.detail === 'invalid_client') {
        throw new ConnectorUnavailableError('client-error', '会社の Google 接続の設定に誤りがあります。管理者に伝えてください');
      }
      throw new ConnectorUnavailableError('unreachable', 'Google に届きませんでした。しばらくしてからもう一度お試しください');
    }
  }

  /** 使えなくなったトークンを捨てる（Google が 401 を返したとき）。 */
  forget(p: ConnectorPrincipal): void {
    this.cache.delete(`${p.tenantId}:${p.userId}`);
  }
}

/**
 * Google の API を 1 回呼ぶ。
 *
 * @param api 利用者に見せる API の名前（断りの文に使う）
 * @returns 応答の JSON。`404`・`410` なら `null`（呼び出し側が「見つからない」として扱う）
 * @throws {ConnectorUnavailableError} 許可が無い・API が無効・届かない
 *
 * @remarks
 * - `401` はトークンを捨てて **1 回だけ**取り直す（取り消された直後などに期限前でも失効するため）
 * - `429`・`5xx` は 1 秒待って **1 回だけ**やり直す
 * - **断りの文に、応答の中身を入れない**（メールの件名などが混ざりうるため）。Google の理由の短い符号だけを見る
 */
export async function callGoogle(
  tokens: GoogleTokenSource, p: ConnectorPrincipal, api: GoogleApiName,
  url: string, init: { method?: string; body?: unknown } = {},
): Promise<Record<string, any> | null> {
  for (let attempt = 1; ; attempt++) {
    const token = await tokens.token(p);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      if (attempt === 1) continue;
      throw new ConnectorUnavailableError('unreachable', `${api}（Google）に届きませんでした。しばらくしてからもう一度お試しください`);
    }
    if (res.status === 204) return {};
    if (res.ok) return (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.status === 404 || res.status === 410) return null;

    const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } };
    const reasons = [
      body.error?.status, ...(body.error?.errors ?? []).map((e) => e.reason), ...(body.error?.details ?? []).map((d) => d.reason),
    ].filter((x): x is string => typeof x === 'string');

    if (res.status === 401 && attempt === 1) { tokens.forget(p); continue; }
    if (res.status === 401) {
      throw new ConnectorUnavailableError('revoked', 'Google の許可が取り消されたか、期限が切れています。個人設定の「Google 連携」で接続し直してください');
    }
    if (res.status === 403 && reasons.some((r) => /SCOPE_INSUFFICIENT|insufficientPermissions/i.test(r))) {
      throw new ConnectorUnavailableError('insufficient-scope', `この操作に要る Google の許可（${api}）がありません。個人設定の「Google 連携」で接続し直して、許可を追加してください`);
    }
    if (res.status === 403 && reasons.some((r) => /SERVICE_DISABLED|accessNotConfigured/i.test(r))) {
      throw new ConnectorUnavailableError('api-disabled', `会社の Google Cloud で ${api} の API が有効になっていません。管理者に伝えてください`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 1) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      throw new ConnectorUnavailableError('unreachable', `${api}（Google）が混み合っています。しばらくしてからもう一度お試しください`);
    }
    // それ以外（400 など）は、こちらの組み立ての誤り。理由の符号だけを添える
    throw new Error(`${api}（Google）が要求を受け付けませんでした（HTTP ${res.status}${reasons[0] ? `・${reasons[0]}` : ''}）`);
  }
}
