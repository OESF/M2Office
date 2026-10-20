/**
 * @file Google Workspace のログインの記録の取り込み（仕様書 第16.8.6節、ADR-0092。不正の兆しの見張りの段 3）。
 *
 * Admin SDK の Reports API のログインの記録（`activities.list`、`applicationName=login`）を、担当の管理者の Google の許可
 * （読み取りだけの `admin.reports.audit.readonly`。本人の Google の接続とは別に、会社の鍵の置き場の種類 `google_login_audit` に預ける）で読む。
 *
 * - 取り込むのは、Google が「異変」と判断したものと、乗っ取りの後によく行われる操作だけ（第16.8.6.2節）。ふだんのログインの成功・ログアウトは取り込まない
 * - **接続元の IP（`ipAddress`）は読まずに捨てる**。残すのは、できごとの種類・対象の人のメールアドレス・時刻・Google の記録の番号だけ（第16.8.6.3節）
 * - 開発の見本の会社では、Google に問い合わせない口（{@link MockGoogleLoginSource}）を使う
 */

import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import { GOOGLE_OAUTH_ENDPOINTS, refreshGoogleAccessToken, type GoogleOAuthEndpoints } from '../google/oauth.js';
import type { SecuritySignalType } from './store.js';

/** 担当の許可を預ける、会社の鍵の置き場の種類。 */
export const GOOGLE_LOGIN_KIND = 'google_login_audit' as const;

/** 担当に求める Google の許可（読み取りだけ）。 */
export const GOOGLE_LOGIN_SCOPES = ['admin.reports.audit.readonly'];

/** Google への反映の遅れに合わせて、読む範囲を前の読みと重ねる長さ（ミリ秒）。 */
export const GOOGLE_LOGIN_OVERLAP_MS = 15 * 60_000;

/** 読めなかった間が長くなっても、さかのぼって読むのはこの長さまで（ミリ秒。Google は 6 か月持つ）。 */
export const GOOGLE_LOGIN_MAX_BACK_MS = 7 * 86_400_000;

/** 個人向けの Google アカウントのドメイン（ログインの記録は読めない）。 */
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** ログインの記録の 1 件（IP・ログインの方式などは持たない）。 */
export interface GoogleLoginEvent {
  /** Google の記録の番号とできごとの名前（同じ記録を二重に数えない）。 */
  id: string;
  at: string;
  email: string;
  /** Google の記録の名前（`account_disabled_hijacked` など）。 */
  name: string;
  /** `login_success` のとき、Google が不審と判断したか（`is_suspicious`）。 */
  suspicious: boolean;
}

/** ログインの記録を読む口。 */
export interface GoogleLoginSource {
  /** この範囲（`from` 以上 `to` 以下）のできごと。 */
  list(from: string, to: string): Promise<GoogleLoginEvent[]>;
}

/** 読めなかったとき（許可が切れた・担当が Google の管理者でなくなった・Google が答えない）。 */
export class GoogleLoginError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'forbidden' | 'failed') {
    super(message);
    this.name = 'GoogleLoginError';
  }
}

/** 取り込むできごとと、兆しの型・重さ（第16.8.6.2節。`login_failure` は数えてから決める）。 */
export const GOOGLE_LOGIN_EVENTS: Record<string, { type: SecuritySignalType; severity: 'high' | 'medium' }> = {
  account_disabled_hijacked: { type: 'google_hijacked', severity: 'high' },
  account_disabled_password_leak: { type: 'google_password_leak', severity: 'high' },
  gov_attack_warning: { type: 'google_gov_attack', severity: 'high' },
  email_forwarding_out_of_domain: { type: 'google_forwarding', severity: 'high' },
  suspicious_login: { type: 'google_login_blocked', severity: 'medium' },
  suspicious_login_less_secure_app: { type: 'google_login_blocked', severity: 'medium' },
  suspicious_programmatic_login: { type: 'google_login_blocked', severity: 'medium' },
  user_signed_out_due_to_suspicious_session_cookie: { type: 'google_cookie_signout', severity: 'medium' },
  risky_sensitive_action_blocked: { type: 'google_risky_blocked', severity: 'medium' },
  '2sv_disable': { type: 'google_2sv_off', severity: 'medium' },
  recovery_email_edit: { type: 'google_recovery_changed', severity: 'medium' },
  recovery_phone_edit: { type: 'google_recovery_changed', severity: 'medium' },
};

/** 重なりを待たずに、その人の M2Office の端末をすべてログアウトさせるできごと（Q-225）。 */
export const GOOGLE_SIGNOUT_NOW: SecuritySignalType[] = ['google_hijacked', 'google_password_leak'];

/** Reports API の 1 件（使う項目だけ。`ipAddress` は型にも持たない）。 */
interface ActivityItem {
  id?: { time?: string; uniqueQualifier?: string };
  actor?: { email?: string };
  events?: { name?: string; parameters?: { name?: string; boolValue?: boolean }[] }[];
}

/**
 * Reports API の答えを、取り込む形に直す。IP など、持たない値はここで捨てる。
 *
 * @remarks 試験からも使う
 */
export function parseLoginActivities(items: unknown[]): GoogleLoginEvent[] {
  const out: GoogleLoginEvent[] = [];
  for (const raw of items as ActivityItem[]) {
    const at = raw.id?.time ?? '';
    const email = (raw.actor?.email ?? '').trim().toLowerCase();
    const q = raw.id?.uniqueQualifier ?? '';
    if (!at || !email || !q) continue;
    for (const e of raw.events ?? []) {
      const name = e.name ?? '';
      if (!name) continue;
      const suspicious = (e.parameters ?? []).some((p) => p.name === 'is_suspicious' && p.boolValue === true);
      out.push({ id: `${q}:${name}`, at: new Date(at).toISOString(), email, name, suspicious });
    }
  }
  return out;
}

/** 担当の許可で、Google の Reports API を読む口。 */
export class HttpGoogleLoginSource implements GoogleLoginSource {
  constructor(private readonly p: {
    clientId: string; clientSecret: string; refreshToken: string; fetch?: typeof fetch; endpoints?: GoogleOAuthEndpoints;
  }) {}

  async list(from: string, to: string): Promise<GoogleLoginEvent[]> {
    let accessToken: string;
    try {
      ({ accessToken } = await refreshGoogleAccessToken(this.p, this.p.endpoints ?? GOOGLE_OAUTH_ENDPOINTS));
    } catch {
      throw new GoogleLoginError('担当の Google の許可が切れています', 'auth');
    }
    const doFetch = this.p.fetch ?? fetch;
    const items: unknown[] = [];
    let pageToken = '';
    // 5 分ごとの見回りで読む量は少ない。長く読めなかったときも 10 ページ（1 万件）で止める
    for (let page = 0; page < 10; page++) {
      const url = 'https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/login'
        + `?startTime=${encodeURIComponent(from)}&endTime=${encodeURIComponent(to)}&maxResults=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await doFetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) })
        .catch(() => { throw new GoogleLoginError('Google が答えませんでした', 'failed'); });
      if (res.status === 401) throw new GoogleLoginError('担当の Google の許可が切れています', 'auth');
      if (res.status === 403) throw new GoogleLoginError('担当のアカウントでは、ログインの記録を見られません（Google の管理者でないか、Admin SDK API が有効でない）', 'forbidden');
      if (!res.ok) throw new GoogleLoginError(`Google が答えませんでした（${res.status}）`, 'failed');
      const body = await res.json() as { items?: unknown[]; nextPageToken?: string };
      items.push(...(body.items ?? []));
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return parseLoginActivities(items);
  }
}

/** 開発の見本の会社の口（Google に問い合わせない。試験ではできごとを渡す）。 */
export class MockGoogleLoginSource implements GoogleLoginSource {
  constructor(private readonly events: GoogleLoginEvent[] = []) {}

  async list(from: string, to: string): Promise<GoogleLoginEvent[]> {
    return this.events.filter((e) => e.at >= from && e.at <= to);
  }
}

/** 会社のログインの記録の読み方（見張りが見回りのたびに引く）。 */
export type GoogleLoginAccess =
  /** 使えない会社（Google Workspace の会社のドメインでログインしていない）。 */
  | { state: 'na' }
  /** 使えるが、担当がまだ許可していない。 */
  | { state: 'disconnected' }
  | { state: 'connected'; source: GoogleLoginSource; email: string; assigneeId: string | null };

/** 担当の許可の状態（画面に出す。トークンは出さない）。 */
export interface GoogleLoginConnection {
  state: 'na' | 'disconnected' | 'connected';
  email: string | null;
  assigneeId: string | null;
  connectedAt: string | null;
}

/** 読み方を引くのに要るもの。 */
export interface GoogleLoginDeps {
  repo: Repository;
  box: SecretBox;
  /** 会社の業務が見本のデータで動くか（`mock` なら Google に問い合わせない）。 */
  sourceFor: (tenantId: string) => string;
  fetch?: typeof fetch;
}

/** 会社が Google Workspace の会社のドメインでログインしているか（ログインの記録を読める会社か）。 */
export async function googleLoginApplies(repo: Repository, tenantId: string): Promise<boolean> {
  const tenant = await repo.findTenantById(tenantId).catch(() => null);
  const domain = tenant?.workspaceDomain?.trim().toLowerCase() ?? '';
  return !!domain && !CONSUMER_DOMAINS.has(domain);
}

/** 担当の許可の状態。 */
export async function googleLoginConnection(repo: Repository, tenantId: string): Promise<GoogleLoginConnection> {
  if (!(await googleLoginApplies(repo, tenantId))) return { state: 'na', email: null, assigneeId: null, connectedAt: null };
  const cred = await repo.getTenantCredential(tenantId, GOOGLE_LOGIN_KIND);
  if (!cred) return { state: 'disconnected', email: null, assigneeId: null, connectedAt: null };
  return {
    state: 'connected', email: typeof cred.meta['email'] === 'string' ? cred.meta['email'] : null,
    assigneeId: cred.updatedBy ?? null, connectedAt: cred.updatedAt ?? null,
  };
}

/**
 * 見張りに渡す、会社ごとの読み方を引く関数を作る。
 *
 * @remarks 担当を替えると鍵の置き場の行が置き換わるため、前の担当の許可では読まない
 */
export function googleLoginAccessFrom(deps: GoogleLoginDeps): (tenantId: string) => Promise<GoogleLoginAccess> {
  return async (tenantId) => {
    const conn = await googleLoginConnection(deps.repo, tenantId);
    if (conn.state !== 'connected') return { state: conn.state };
    const cred = await deps.repo.getTenantCredential(tenantId, GOOGLE_LOGIN_KIND);
    if (!cred) return { state: 'disconnected' };
    if (cred.meta['mock'] === true || deps.sourceFor(tenantId) === 'mock') {
      return { state: 'connected', source: new MockGoogleLoginSource(), email: conn.email ?? '', assigneeId: conn.assigneeId };
    }
    const client = await deps.repo.getTenantCredential(tenantId, 'google_oauth');
    const clientId = typeof client?.meta['clientId'] === 'string' ? client.meta['clientId'] : '';
    if (!client?.secretEnc || !clientId || !cred.secretEnc) {
      return { state: 'connected', source: { list: async () => { throw new GoogleLoginError('会社の Google 接続の設定がありません', 'failed'); } }, email: conn.email ?? '', assigneeId: conn.assigneeId };
    }
    return {
      state: 'connected', email: conn.email ?? '', assigneeId: conn.assigneeId,
      source: new HttpGoogleLoginSource({
        clientId, clientSecret: deps.box.decrypt(client.secretEnc), refreshToken: deps.box.decrypt(cred.secretEnc), ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    };
  };
}
