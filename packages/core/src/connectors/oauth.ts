/**
 * @file 認証の要る会社の接続（`oauth`）の、認可の流れ。相手のサーバの案内の発見、許可の画面の URL、認可の受け取りと更新、取り消し。
 *
 * MCP の認可の決まり（保護されたリソースの情報 RFC 9728 と、認可サーバの情報 RFC 8414）に従う。
 * 会社がアプリ（クライアント ID とシークレット）を登録する形と、相手が自動登録の口を持つときのアプリの自動登録（動的クライアント登録 RFC 7591。
 * 第 0.203.0 版、Q-99）を扱う。自動登録で送るのはアプリの名前・戻り先・認可の型・求める権限だけ。
 * 認可の値は呼び出し側が暗号化して持つ。このファイルは記録に出さない。
 *
 * @see 仕様書 第12.11.6.2節・第12.11.6.3節・第12.11.6.4節
 */

/** 1 回の問い合わせの時間の上限（ミリ秒）。 */
const TIMEOUT_MS = 20_000;

/** 認可の口。 */
export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** 相手が案内する権限。 */
  scopesSupported: string[];
  /** PKCE（S256）に対応しているか。 */
  pkce: boolean;
  /** アプリの自動登録の口（`registration_endpoint`）。無ければ `null`（会社がアプリを登録する）。 */
  registrationUrl: string | null;
  /** トークンの口で使えるクライアントの認証の方法（`client_secret_post`・`none` など）。 */
  tokenAuthMethods: string[];
}

/** 自動で登録したアプリ。 */
export interface RegisteredClient {
  clientId: string;
  /** シークレットを持たないアプリ（公開クライアント）では `null`。 */
  clientSecret: string | null;
}

/** 受け取った認可。 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** 期限（ISO 8601）。相手が期限を返さなければ `null`。 */
  expiresAt: string | null;
  /** 許可された権限。 */
  scopes: string[];
}

/** 認可の流れの失敗。`message` は利用者に見せてよい。 */
export class ConnectionOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionOAuthError';
  }
}

type FetchLike = typeof fetch;

/**
 * 相手の MCP サーバの案内から、認可の口を見つける（第12.11.6.2節）。
 *
 * @returns 見つからなければ `null`（型に書いた口か、管理者が入れた口を使う）
 */
export async function discoverOAuthEndpoints(mcpUrl: string, fetchImpl: FetchLike = fetch): Promise<OAuthEndpoints | null> {
  try {
    const origin = new URL(mcpUrl).origin;
    const resource = await getJson(`${origin}/.well-known/oauth-protected-resource`, fetchImpl);
    const server = Array.isArray(resource?.['authorization_servers']) ? String(resource['authorization_servers'][0]) : origin;
    const meta = await getJson(`${new URL(server).origin}/.well-known/oauth-authorization-server`, fetchImpl);
    const authorizeUrl = meta?.['authorization_endpoint'];
    const tokenUrl = meta?.['token_endpoint'];
    if (typeof authorizeUrl !== 'string' || typeof tokenUrl !== 'string') return null;
    const scopes = meta?.['scopes_supported'] ?? resource?.['scopes_supported'];
    const methods = meta?.['code_challenge_methods_supported'];
    const registration = meta?.['registration_endpoint'];
    const auth = meta?.['token_endpoint_auth_methods_supported'];
    return {
      authorizeUrl, tokenUrl,
      scopesSupported: Array.isArray(scopes) ? scopes.map(String) : [],
      pkce: Array.isArray(methods) && methods.includes('S256'),
      // 口は https に限る（開発の手元のサーバだけ http を認める。第12.11.1節の接続先と同じ）
      registrationUrl: typeof registration === 'string' && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(registration) ? registration : null,
      // 書いていなければ、決まりの既定（client_secret_basic）として扱う
      tokenAuthMethods: Array.isArray(auth) ? auth.map(String) : ['client_secret_basic'],
    };
  } catch {
    return null;
  }
}

/**
 * 相手の認可サーバにアプリを自動で登録する（動的クライアント登録 RFC 7591。第12.11.6.2節、Q-99）。
 *
 * @param p.authMethods 相手が使えるクライアントの認証の方法。シークレットを本文で送る方法（`client_secret_post`）を選び、
 *   使えなければシークレットを持たない方法（`none`）にする
 * @throws ConnectionOAuthError 相手に断られた・応答が読めない
 * @remarks 送るのはアプリの名前（「M2Office」）・戻り先の URL・認可の型・求める権限だけ。会社の名前や利用者の情報は送らない
 */
export async function registerOAuthClient(p: {
  registrationUrl: string; redirectUri: string; scopes: string[]; authMethods: string[];
}, fetchImpl: FetchLike = fetch): Promise<RegisteredClient> {
  const method = p.authMethods.includes('client_secret_post') ? 'client_secret_post' : p.authMethods.includes('none') ? 'none' : 'client_secret_post';
  let res: Response;
  try {
    res = await fetchImpl(p.registrationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'M2Office', redirect_uris: [p.redirectUri], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: method, ...(p.scopes.length > 0 ? { scope: p.scopes.join(' ') } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ConnectionOAuthError('相手のサービスにつながりませんでした（アプリの自動登録）');
  }
  let body: Record<string, unknown>;
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    throw new ConnectionOAuthError(`相手のサービスの応答を読めませんでした（アプリの自動登録。HTTP ${res.status}）`);
  }
  if (!res.ok || typeof body['client_id'] !== 'string' || body['client_id'] === '') {
    throw new ConnectionOAuthError(`相手のサービスにアプリの自動登録を断られました（${String(body['error'] ?? `HTTP ${res.status}`)}）`);
  }
  const secret = body['client_secret'];
  return { clientId: body['client_id'], clientSecret: typeof secret === 'string' && secret !== '' ? secret : null };
}

/** 許可の画面の URL を作る。`state` と PKCE は呼び出し側が用意する（第12.11.6.3節）。 */
export function buildConnectionAuthUrl(p: {
  authorizeUrl: string; clientId: string; redirectUri: string; scopes: string[]; state: string; codeChallenge?: string;
}): string {
  const u = new URL(p.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  if (p.scopes.length > 0) u.searchParams.set('scope', p.scopes.join(' '));
  u.searchParams.set('state', p.state);
  if (p.codeChallenge) {
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

/**
 * 戻ってきた `code` を認可に換える（シークレットは本文で送る。`client_secret_post`）。
 *
 * @throws ConnectionOAuthError 相手に断られた・応答が読めない
 */
export async function exchangeConnectionCode(p: {
  tokenUrl: string; clientId: string; clientSecret: string | null; code: string; redirectUri: string; codeVerifier?: string;
}, fetchImpl: FetchLike = fetch, now = new Date()): Promise<OAuthTokens> {
  return tokensOf(await postForm(p.tokenUrl, {
    grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri,
    // シークレットを持たないアプリ（自動登録の公開クライアント）は送らない
    client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
    ...(p.codeVerifier ? { code_verifier: p.codeVerifier } : {}),
  }, fetchImpl), now);
}

/**
 * 更新用の認可で、新しい認可を受け取る（第12.11.6.4節）。
 *
 * @throws ConnectionOAuthError 更新できない（相手の側で許可が外れたなど）
 */
export async function refreshConnectionToken(p: {
  tokenUrl: string; clientId: string; clientSecret: string | null; refreshToken: string;
}, fetchImpl: FetchLike = fetch, now = new Date()): Promise<OAuthTokens> {
  const t = tokensOf(await postForm(p.tokenUrl, {
    grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
  }, fetchImpl), now);
  // 更新用の認可を返さない相手は、前のものを使い続ける
  return { ...t, refreshToken: t.refreshToken ?? p.refreshToken };
}

/**
 * 許可したアカウントの表示名を問い合わせる（例: Slack の `auth.test` から「OESF / 三浦」）。
 *
 * @returns 分からなければ空の文字。**推測で埋めない**
 */
export async function fetchAccountLabel(accountUrl: string, accessToken: string, fetchImpl: FetchLike = fetch): Promise<string> {
  try {
    const res = await fetchImpl(accountUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json() as Record<string, unknown>;
    if (body['ok'] === false) return '';
    const parts = [body['team'], body['user'] ?? body['name'] ?? body['email']].filter((v): v is string => typeof v === 'string' && v !== '');
    return parts.join(' / ');
  } catch {
    return '';
  }
}

/** 相手の側でも認可を取り消す。できたら `true`。失敗しても例外にしない（手元の認可は呼び出し側が消す）。 */
export async function revokeConnectionToken(revokeUrl: string, accessToken: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(revokeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return res.ok && body['ok'] !== false;
  } catch {
    return false;
  }
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  return await res.json() as Record<string, unknown>;
}

async function postForm(url: string, form: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ConnectionOAuthError('相手のサービスにつながりませんでした');
  }
  let body: Record<string, unknown>;
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    throw new ConnectionOAuthError(`相手のサービスの応答を読めませんでした（HTTP ${res.status}）`);
  }
  // Slack は失敗しても 200 で `ok: false` を返す。標準の形は `error`
  if (!res.ok || body['ok'] === false || typeof body['error'] === 'string') {
    throw new ConnectionOAuthError(`相手のサービスに断られました（${String(body['error'] ?? `HTTP ${res.status}`)}）`);
  }
  return body;
}

/** 応答から認可を取り出す。Slack は最上位に、古い形は `authed_user` の下に置く。 */
function tokensOf(body: Record<string, unknown>, now: Date): OAuthTokens {
  const user = (body['authed_user'] ?? {}) as Record<string, unknown>;
  const accessToken = body['access_token'] ?? user['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') throw new ConnectionOAuthError('相手のサービスから認可を受け取れませんでした');
  const refresh = body['refresh_token'] ?? user['refresh_token'];
  const expiresIn = Number(body['expires_in'] ?? user['expires_in']);
  const scope = body['scope'] ?? user['scope'];
  return {
    accessToken,
    refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
    scopes: typeof scope === 'string' ? scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}
