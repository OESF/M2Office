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
    'chat.spaces.readonly': '入っているチャットのスペースを見る（投稿先を名前で探すため）',
    'drive.file': 'M2Office で作った・あなたが選んだファイルを扱う',
    drive: 'ドライブのファイルを扱う（会社のスライドのテンプレートを複製するため）',
    'directory.readonly': '社内の人を探す',
    'analytics.readonly': 'Google アナリティクスの数字を見る',
    'webmasters.readonly': 'Search Console の数字を見る',
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
  /** アカウントを選ばせる（本人ではない窓口のアカウントでつなぐとき。第33.18節）。 */
  selectAccount?: boolean;
  /**
   * 前に許した権限を引き継がない（`include_granted_scopes` を付けない）。Web の分析の許可のように、
   * 決まった権限だけを別に預けるときに使う（本人の接続の権限まで預けないため。第34.18節）。
   */
  onlyTheseScopes?: boolean;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): string {
  const scope = [...new Set([...GOOGLE_LOGIN_SCOPES, ...p.scopes])].map(googleScopeUrl).join(' ');
  const q = new URLSearchParams({
    client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope,
    access_type: 'offline', prompt: p.selectAccount ? 'consent select_account' : 'consent', ...(p.onlyTheseScopes ? {} : { include_granted_scopes: 'true' }),
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

/**
 * クライアントの確かめの結果（仕様書 第14.3.3節「登録の確認」）。
 *
 * - `ok`: ID とシークレットは組になっている
 * - `bad-secret`: シークレットが誤っている
 * - `no-client`: その ID のクライアントが Google に無い
 * - `unreachable`: Google に届かなかった（正否は分からない）
 * - `unexpected`: 想定と違う返事（`detail` に返事をそのまま入れる）
 */
export type GoogleClientVerdict = 'ok' | 'bad-secret' | 'no-client' | 'unreachable' | 'unexpected';

/** 確かめに使う、使えない認可コード。Google は先にクライアントを確かめるため、コードの正否より前に判定が出る。 */
const CLIENT_CHECK_CODE = 'm2office-client-check';

/**
 * OAuth クライアントの ID とシークレットが組になっているかを、Google に確かめる（仕様書 第14.3.3節）。
 *
 * @param p 確かめるクライアント。`redirectUri` は実際に使う戻り先を渡す
 * @returns 判定と、Google の返事（画面や記録に出すため。**シークレットは含まない**）
 *
 * @remarks
 * 使えない認可コードで鍵の受け取りを求め、返し方で判定する。
 * 組が正しければ `invalid_grant`（コードが無効）、シークレットが誤りなら `invalid_client` が返る
 * （2026-09-25 に本物の Google で確かめた）。利用者の許可も、実際の鍵も要らない。
 *
 * **例外は投げない。** 届かないときも `unreachable` として返し、呼び出し側が「確かめられなかった」と示す。
 * 確かめられるのはクライアントの正否だけで、リダイレクト URI の登録漏れなどは分からない。
 */
export async function checkGoogleClient(p: {
  clientId: string; clientSecret: string; redirectUri: string;
}, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<{ verdict: GoogleClientVerdict; detail: string | null }> {
  let res: Response;
  try {
    res = await fetch(endpoints.token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: p.clientId, client_secret: p.clientSecret, code: CLIENT_CHECK_CODE,
        redirect_uri: p.redirectUri, grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { verdict: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status >= 500) return { verdict: 'unreachable', detail: `HTTP ${res.status}` };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const error = typeof json['error'] === 'string' ? json['error'] : '';
  const description = typeof json['error_description'] === 'string' ? json['error_description'] : '';
  const detail = [error, description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
  if (error === 'invalid_grant') return { verdict: 'ok', detail };
  if (error === 'invalid_client') {
    return { verdict: /not found/i.test(description) ? 'no-client' : 'bad-secret', detail };
  }
  return { verdict: 'unexpected', detail };
}

/**
 * Google の失敗が「会社のクライアントの誤り」によるものか（仕様書 第14.3.3節）。
 *
 * @remarks 利用者の接続で分かったとき、もう一度試しても直らないことを知らせるために使う。
 */
export function isGoogleClientError(err: unknown): boolean {
  return err instanceof GoogleOAuthError && err.detail === 'invalid_client';
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

/**
 * 接続した Google アカウントの利用者情報（メールアドレスとプロフィール写真の URL）。
 *
 * @returns 取れなかった項目は `null`。写真は `profile` の許可があるときだけ返る（仕様書 第6.5.1.1節）
 */
export async function googleUserInfo(
  accessToken: string, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS,
): Promise<{ email: string | null; picture: string | null }> {
  const res = await fetch(endpoints.userinfo, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { email: null, picture: null };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    email: typeof json['email'] === 'string' ? json['email'] : null,
    picture: typeof json['picture'] === 'string' ? json['picture'] : null,
  };
}

/** 接続した Google アカウントのメールアドレス。 */
export async function googleUserEmail(accessToken: string, endpoints: GoogleOAuthEndpoints = GOOGLE_OAUTH_ENDPOINTS): Promise<string | null> {
  return (await googleUserInfo(accessToken, endpoints)).email;
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
