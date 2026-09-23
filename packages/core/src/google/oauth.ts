/**
 * @file Google の OAuth 2.0（認可コード + PKCE）。認可の URL、コードの交換、アクセス トークンの取り直し、
 * 実際に許可された範囲の確認、取り消し。
 *
 * AI Radio の `server/routes/oauth-routes.js`（MIT、同じ作者）の流れを引き継ぐ。
 * 違いは、会社の OAuth クライアントを使い、利用者ごとにトークンを持つこと、`state` と PKCE で戻りを照合すること。
 *
 * @see 仕様書 第14.3.3節 接続の設定
 * @see ADR-0007 接続の設定
 */

import { createHash, randomBytes } from 'node:crypto';

/** Google の OAuth の窓口。テストでは差し替える。 */
export interface GoogleOAuthEndpoints {
  auth: string;
  token: string;
  tokeninfo: string;
  userinfo: string;
  revoke: string;
}

export const GOOGLE_OAUTH_ENDPOINTS: GoogleOAuthEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  tokeninfo: 'https://oauth2.googleapis.com/tokeninfo',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  revoke: 'https://oauth2.googleapis.com/revoke',
};

/** ログインに要る権限。業務のツールの権限に必ず足す。 */
export const GOOGLE_LOGIN_SCOPES = ['openid', 'email'];

/** スコープの短い名前（例: `gmail.readonly`）を、Google に渡す形（URL）にする。 */
export function googleScopeUrl(name: string): string {
  return name === 'openid' || name === 'email' || name === 'profile' || name.startsWith('https://')
    ? name : `https://www.googleapis.com/auth/${name}`;
}

/**
 * 権限を、利用者に見せる業務の言葉にする（仕様書 第6.5.2節「鍵という言葉を使わない」）。
 * 表に無いものは名前をそのまま返す。
 */
export function googleScopeLabel(name: string): string {
  const labels: Record<string, string> = {
    'gmail.readonly': 'メールを読む',
    'gmail.compose': 'メールの下書きを作る',
    'gmail.send': 'メールを送る（承認のあとだけ）',
    'calendar.readonly': '予定と空きを見る',
    'calendar.events': '予定を登録・変更する（承認のあとだけ）',
    tasks: 'ToDo を見る・登録する',
    'chat.messages.create': 'チャットに投稿する（承認のあとだけ）',
    'drive.file': 'M2Office で作った・あなたが選んだファイルを扱う',
    'directory.readonly': '社内の人を探す',
    'meetings.space.readonly': '参加した会議の文字起こしを読む',
    openid: 'ログイン', email: 'メールアドレスを知る',
  };
  return labels[name] ?? name;
}

/** PKCE の組（検証用の値と、そのハッシュ）。 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * 認可の URL を作る。オフラインの利用のため `access_type=offline` と `prompt=consent` を付ける（AI Radio と同じ）。
 *
 * @param scopes 短い名前の一覧（`openid`・`email` は自動で足す）
 */
export function buildGoogleAuthUrl(p: {
  clientId: string; redirectUri: string; scopes: string[]; state: string; codeChallenge: string; loginHint?: string;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): string {
  const scope = [...new Set([...GOOGLE_LOGIN_SCOPES, ...p.scopes])].map(googleScopeUrl).join(' ');
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    state: p.state, code_challenge: p.codeChallenge, code_challenge_method: 'S256',
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  });
  return `${endpoints.auth}?${q.toString()}`;
}

/** Google の応答の失敗。画面に出す文にする。 */
export class GoogleOAuthError extends Error {
  constructor(message: string, readonly detail: string | null = null) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new GoogleOAuthError(String(json['error_description'] ?? json['error'] ?? `HTTP ${res.status}`), json['error'] ?? null);
  return json;
}

/**
 * 戻ってきたコードをトークンに換える。
 *
 * @throws {GoogleOAuthError} 交換に失敗した場合、またはリフレッシュ トークンが返らなかった場合
 */
export async function exchangeGoogleCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<{ refreshToken: string; accessToken: string; scopes: string[] }> {
  const t = await postForm(endpoints.token, {
    client_id: p.clientId, client_secret: p.clientSecret, code: p.code, redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier, grant_type: 'authorization_code',
  });
  if (!t['refresh_token']) {
    throw new GoogleOAuthError('Google からリフレッシュ トークンが返りませんでした。いちど Google のアカウントの設定で M2Office の許可を取り消してから、もう一度接続してください');
  }
  return { refreshToken: String(t['refresh_token']), accessToken: String(t['access_token']), scopes: shortScopes(String(t['scope'] ?? '')) };
}

/** リフレッシュ トークンからアクセス トークンを取り直す。 */
export async function refreshGoogleAccessToken(p: {
  clientId: string; clientSecret: string; refreshToken: string;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<{ accessToken: string; expiresIn: number }> {
  const t = await postForm(endpoints.token, {
    client_id: p.clientId, client_secret: p.clientSecret, refresh_token: p.refreshToken, grant_type: 'refresh_token',
  });
  return { accessToken: String(t['access_token']), expiresIn: Number(t['expires_in'] ?? 3600) };
}

/**
 * Google に実際に許可された範囲を問い合わせる（AI Radio と同じく tokeninfo を使う）。
 * こちらが求めた範囲ではなく、Google が認めた範囲なので、一部だけ拒否された場合も分かる。
 */
export async function googleGrantedScopes(accessToken: string, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<string[]> {
  const res = await fetch(`${endpoints.tokeninfo}?access_token=${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json['scope'] !== 'string') throw new GoogleOAuthError('許可の範囲を確かめられませんでした');
  return shortScopes(json['scope']);
}

/** 接続した Google アカウントのメールアドレス。 */
export async function googleUserEmail(accessToken: string, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<string | null> {
  const res = await fetch(endpoints.userinfo, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return typeof json['email'] === 'string' ? json['email'] : null;
}

/** 許可を取り消す。失敗しても例外にしない（トークンはこちらで消すため）。 */
export async function revokeGoogleToken(token: string, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<boolean> {
  try {
    const res = await fetch(endpoints.revoke, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }), signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Google の返す権限の URL の並びを、短い名前にする。 */
function shortScopes(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean).map((s) => s.replace('https://www.googleapis.com/auth/', '').replace(/^https:\/\/www\.googleapis\.com\/auth\/userinfo\.email$/, 'email'));
}

/**
 * ログインの同意画面の URL を作る（仕様書 第16.1.1節）。
 *
 * @remarks
 * 求めるのは `openid`・`email`・`profile` **だけ**である。
 * メールも予定もドライブも読めない。会社のデータに触れるのは、
 * 会社の OAuth クライアントで得た許可だけである。
 *
 * 業務の連携（{@link buildGoogleAuthUrl}）と違い、`access_type=offline` を付けない。
 * ログインに、あとから使うトークンは要らないためである。
 */
export function buildGoogleLoginUrl(p: {
  clientId: string; redirectUri: string; state: string; codeChallenge: string; hostedDomain?: string;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): string {
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code',
    scope: 'openid email profile',
    state: p.state, code_challenge: p.codeChallenge, code_challenge_method: 'S256',
    // アカウントを選ばせる。前に選んだものを黙って使わない
    prompt: 'select_account',
    // 会社のドメインを Google 側でも絞る。こちらでも必ず確かめる（第16.1.2節）
    ...(p.hostedDomain ? { hd: p.hostedDomain } : {}),
  });
  return `${endpoints.auth}?${q.toString()}`;
}

/**
 * ログインの戻りのコードを、アクセス トークンに換える（仕様書 第16.1.2節）。
 *
 * @remarks
 * リフレッシュ トークンは要らない。誰がログインしたかを 1 度知れば足りるためである。
 */
export async function exchangeGoogleLoginCode(p: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<{ accessToken: string }> {
  const t = await postForm(endpoints.token, {
    client_id: p.clientId, client_secret: p.clientSecret, code: p.code, redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier, grant_type: 'authorization_code',
  });
  if (!t['access_token']) throw new GoogleOAuthError('Google からトークンが返りませんでした');
  return { accessToken: String(t['access_token']) };
}
