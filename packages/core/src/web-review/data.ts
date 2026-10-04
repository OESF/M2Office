/**
 * @file Web の振り返りの口（仕様書 第34.3節・第34.18節）。アナリティクス（GA4 のデータと管理の API）と Search Console の API を、
 * 担当が許した読み取りの権限だけで読む。開発の見本の会社では、Google に問い合わせず決まった数字を返す口（{@link MockWebData}）を使う。
 *
 * 担当の許可は、本人の Google の接続とは別に、会社の鍵の置き場（種類 `web_review`）に暗号化して預けてある。
 * 読むだけで、アナリティクス・Search Console・サイトの設定は変えない（第34.13節）。
 */

import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import { GOOGLE_OAUTH_ENDPOINTS, refreshGoogleAccessToken, type GoogleOAuthEndpoints } from '../google/oauth.js';

/** 担当の許可を預ける、会社の鍵の置き場の種類。 */
export const WEB_REVIEW_KIND = 'web_review' as const;

/** アナリティクスのプロパティ（ウェブのデータ ストリームの URL つき）。 */
export interface WebProperty {
  /** `properties/123` */
  id: string;
  name: string;
  /** アカウントの名前 */
  account: string;
  uris: string[];
}

/** Search Console のサイト。 */
export interface WebSite {
  /** `sc-domain:example.jp` か `https://www.example.jp/` */
  siteUrl: string;
  permission: string;
}

/** アナリティクスの問い合わせ（GA4 の `runReport` の一部だけ）。 */
export interface AnalyticsQuery {
  start: string;
  end: string;
  metrics: string[];
  dimensions?: string[];
  limit?: number;
  /** 多い順に並べる指標 */
  orderBy?: string;
  /** 切り口の値に、この文字を含むものだけ */
  filter?: { dimension: string; contains: string };
}

/** Search Console の問い合わせ（検索のパフォーマンスの一部だけ）。 */
export interface SearchQuery {
  start: string;
  end: string;
  dimensions?: ('query' | 'page' | 'device')[];
  limit?: number;
  filter?: { dimension: 'query' | 'page'; contains: string };
}

/** Search Console の 1 行。 */
export interface SearchRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Web の振り返りが使う口。 */
export interface WebData {
  /** 見られるプロパティ（データ ストリームの URL つき） */
  properties(): Promise<WebProperty[]>;
  /** 見られるサイト */
  sites(): Promise<WebSite[]>;
  /** アナリティクスの集計。切り口が無ければ合計の 1 行 */
  report(propertyId: string, q: AnalyticsQuery): Promise<{ dims: string[]; values: number[] }[]>;
  /** Search Console の集計。切り口が無ければ合計の 1 行（無ければ空） */
  search(siteUrl: string, q: SearchQuery): Promise<SearchRow[]>;
}

/** 読めなかった理由の種類。`apiDisabled` は Google Cloud の側で API が有効でない。`auth` は許可が取り消された・切れた。 */
export class WebDataError extends Error {
  constructor(message: string, readonly kind: 'apiDisabled' | 'auth' | 'denied' | 'failed') {
    super(message);
  }
}

/** Google の API の場所（試験で差し替える）。 */
export interface WebDataEndpoints {
  admin: string;
  data: string;
  search: string;
  oauth: GoogleOAuthEndpoints;
}

const ENDPOINTS: WebDataEndpoints = {
  admin: 'https://analyticsadmin.googleapis.com/v1beta',
  data: 'https://analyticsdata.googleapis.com/v1beta',
  search: 'https://www.googleapis.com/webmasters/v3',
  oauth: GOOGLE_OAUTH_ENDPOINTS,
};

/** 担当の許可で Google の API を読む口。 */
export class GoogleWebData implements WebData {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly endpoints: WebDataEndpoints = ENDPOINTS,
  ) {}

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    try {
      const t = await refreshGoogleAccessToken(this.creds, this.endpoints.oauth);
      this.token = { value: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 };
      return t.accessToken;
    } catch (err) {
      throw new WebDataError(`担当の Google の許可が取り消されたか、期限が切れています。管理者がつなぎ直してください（${err instanceof Error ? err.message : String(err)}）`, 'auth');
    }
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        ...init, headers: { authorization: `Bearer ${await this.accessToken(attempt > 0)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      }).catch((err: unknown) => { throw new WebDataError(`Google に届きませんでした（${err instanceof Error ? err.message : String(err)}）`, 'failed'); });
      if (res.status === 401 && attempt === 0) continue;
      if (res.ok) return await res.json() as T;
      const text = await res.text().catch(() => '');
      if (res.status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(text)) {
        throw new WebDataError('Google Cloud のプロジェクトで、アナリティクスか Search Console の API が有効になっていません。管理者が有効にしてください', 'apiDisabled');
      }
      if (res.status === 401) throw new WebDataError('担当の Google の許可が取り消されたか、期限が切れています。管理者がつなぎ直してください', 'auth');
      if (res.status === 403) throw new WebDataError('このプロパティかサイトを見る権限がありません', 'denied');
      throw new WebDataError(`Google から読めませんでした（${res.status}）`, 'failed');
    }
    throw new WebDataError('担当の Google の許可が取り消されたか、期限が切れています。管理者がつなぎ直してください', 'auth');
  }

  async properties(): Promise<WebProperty[]> {
    const r = await this.call<{ accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName?: string }[] }[] }>(
      `${this.endpoints.admin}/accountSummaries?pageSize=200`);
    const out: WebProperty[] = [];
    for (const a of r.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        const streams = await this.call<{ dataStreams?: { type?: string; webStreamData?: { defaultUri?: string } }[] }>(`${this.endpoints.admin}/${p.property}/dataStreams`)
          .catch(() => ({ dataStreams: [] }));
        out.push({
          id: p.property, name: p.displayName ?? p.property, account: a.displayName ?? '',
          uris: (streams.dataStreams ?? []).map((s) => s.webStreamData?.defaultUri ?? '').filter(Boolean),
        });
        if (out.length >= 50) return out;
      }
    }
    return out;
  }

  async sites(): Promise<WebSite[]> {
    const r = await this.call<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${this.endpoints.search}/sites`);
    return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }));
  }

  async report(propertyId: string, q: AnalyticsQuery): Promise<{ dims: string[]; values: number[] }[]> {
    const body = {
      dateRanges: [{ startDate: q.start, endDate: q.end }],
      metrics: q.metrics.map((name) => ({ name })),
      dimensions: (q.dimensions ?? []).map((name) => ({ name })),
      limit: q.limit ?? 10,
      ...(q.orderBy ? { orderBys: [{ metric: { metricName: q.orderBy }, desc: true }] } : {}),
      ...(q.filter ? { dimensionFilter: { filter: { fieldName: q.filter.dimension, stringFilter: { matchType: 'CONTAINS', value: q.filter.contains, caseSensitive: false } } } } : {}),
    };
    const r = await this.call<{ rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[] }>(
      `${this.endpoints.data}/${propertyId}:runReport`, { method: 'POST', body: JSON.stringify(body) });
    return (r.rows ?? []).map((row) => ({ dims: (row.dimensionValues ?? []).map((d) => d.value), values: (row.metricValues ?? []).map((m) => Number(m.value) || 0) }));
  }

  async search(siteUrl: string, q: SearchQuery): Promise<SearchRow[]> {
    const body = {
      startDate: q.start, endDate: q.end, dimensions: q.dimensions ?? [], rowLimit: q.limit ?? 10,
      ...(q.filter ? { dimensionFilterGroups: [{ filters: [{ dimension: q.filter.dimension, operator: 'contains', expression: q.filter.contains }] }] } : {}),
    };
    const r = await this.call<{ rows?: SearchRow[] }>(`${this.endpoints.search}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, { method: 'POST', body: JSON.stringify(body) });
    return (r.rows ?? []).map((x) => ({ keys: x.keys ?? [], clicks: x.clicks ?? 0, impressions: x.impressions ?? 0, ctr: x.ctr ?? 0, position: x.position ?? 0 }));
  }
}

/** 見本の口の日付ごとの揺らぎ（決まった値。月ごとに少しずつ違う）。 */
function factorOf(start: string): number {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return 1 + (((y * 12 + m) * 7) % 5) / 10;
}

const daysOf = (q: { start: string; end: string }) => Math.max(1, Math.round((Date.parse(`${q.end}T00:00:00Z`) - Date.parse(`${q.start}T00:00:00Z`)) / 86_400_000) + 1);

/**
 * 開発の見本の会社の口。Google に問い合わせず、期間から決まる見本の数字を返す。外には何も出さない。
 */
export class MockWebData implements WebData {
  constructor(private readonly host = 'www.alpha.example.jp') {}

  async properties(): Promise<WebProperty[]> {
    return [{ id: 'properties/100001', name: '見本のサイト', account: '見本の会社', uris: [`https://${this.host}/`] }];
  }

  async sites(): Promise<WebSite[]> {
    return [{ siteUrl: `sc-domain:${this.host.replace(/^www\./, '')}`, permission: 'siteFullUser' }];
  }

  async report(_propertyId: string, q: AnalyticsQuery): Promise<{ dims: string[]; values: number[] }[]> {
    const k = factorOf(q.start) * daysOf(q);
    const base: Record<string, number> = {
      activeUsers: Math.round(40 * k), newUsers: Math.round(29 * k), sessions: Math.round(55 * k), screenPageViews: Math.round(120 * k),
      engagementRate: 0.48 + (factorOf(q.start) - 1) / 10, keyEvents: 0,
    };
    const value = (name: string, share: number) => (name === 'engagementRate' ? base[name]! : Math.round((base[name] ?? 0) * share));
    const dims = q.dimensions ?? [];
    if (!dims.length) return [{ dims: [], values: q.metrics.map((m) => base[m] ?? 0) }];
    const lists: Record<string, [string, number][]> = {
      sessionDefaultChannelGroup: [['Organic Search', 0.52], ['Direct', 0.21], ['Organic Social', 0.12], ['Referral', 0.09], ['Organic Maps', 0.06]],
      deviceCategory: [['mobile', 0.68], ['desktop', 0.29], ['tablet', 0.03]],
      region: [['Tokyo', 0.41], ['Kanagawa', 0.18], ['Saitama', 0.11], ['Chiba', 0.08]],
      pagePath: [['/', 0.34], ['/service/', 0.16], ['/price/', 0.12], ['/contact/', 0.07], ['/column/spring/', 0.05], ['/company/', 0.04]],
    };
    const titles: Record<string, string> = { '/': 'トップ', '/service/': 'サービス', '/price/': '料金', '/contact/': 'お問い合わせ', '/column/spring/': '春のコラム', '/company/': '会社の案内' };
    const list = lists[dims[0]!] ?? [];
    const rows = list
      .filter(([v]) => !q.filter || v.toLowerCase().includes(q.filter.contains.toLowerCase()))
      .map(([v, share]) => ({ dims: dims.map((d) => (d === 'pageTitle' ? titles[v] ?? v : v)), values: q.metrics.map((m) => value(m, share)) }));
    return rows.slice(0, q.limit ?? 10);
  }

  async search(_siteUrl: string, q: SearchQuery): Promise<SearchRow[]> {
    const k = factorOf(q.start) * daysOf(q);
    const total = { clicks: Math.round(21 * k), impressions: Math.round(640 * k) };
    const dims = q.dimensions ?? [];
    if (!dims.length) return [{ keys: [], clicks: total.clicks, impressions: total.impressions, ctr: total.clicks / total.impressions, position: 14.2 - (factorOf(q.start) - 1) * 4 }];
    const lists: Record<string, [string, number, number][]> = {
      query: [['見本の会社', 0.31, 0.05], ['見本 料金', 0.14 * factorOf(q.start), 0.09], ['見本 地名', 0.11, 0.12], ['春 コラム', 0.07, 0.2], ['見本 予約', 0.05, 0.03]],
      page: [[`https://${this.host}/`, 0.45, 0.3], [`https://${this.host}/price/`, 0.2, 0.2], [`https://${this.host}/column/spring/`, 0.1, 0.25]],
      device: [['MOBILE', 0.7, 0.66], ['DESKTOP', 0.28, 0.31], ['TABLET', 0.02, 0.03]],
    };
    return (lists[dims[0]!] ?? [])
      .filter(([v]) => !q.filter || v.includes(q.filter.contains))
      .map(([v, c, i]) => {
        const clicks = Math.round(total.clicks * c);
        const impressions = Math.max(1, Math.round(total.impressions * i));
        return { keys: [v], clicks, impressions, ctr: clicks / impressions, position: 9.5 };
      })
      .slice(0, q.limit ?? 10);
  }
}

/** 口を開くのに要るもの。 */
export interface WebDataDeps {
  repo: Repository;
  box: SecretBox;
  /** その会社が見本（Google に問い合わせない）か */
  sourceFor(tenantId: string): 'google' | 'mock' | string;
}

/**
 * 担当の許可で読む口を開く。つないでいなければ `null`。
 *
 * @throws WebDataError 会社の Google 接続の設定が無いとき
 */
export async function openWebData(deps: WebDataDeps, tenantId: string, host?: string): Promise<WebData | null> {
  const cred = await deps.repo.getTenantCredential(tenantId, WEB_REVIEW_KIND);
  if (!cred) return null;
  if (cred.meta['mock'] === true || deps.sourceFor(tenantId) === 'mock') return new MockWebData(host || undefined);
  const client = await deps.repo.getTenantCredential(tenantId, 'google_oauth');
  const clientId = typeof client?.meta['clientId'] === 'string' ? client.meta['clientId'] : '';
  if (!client?.secretEnc || !clientId || !cred.secretEnc) throw new WebDataError('会社の Google 接続の設定がありません。管理者に伝えてください', 'failed');
  return new GoogleWebData({ clientId, clientSecret: deps.box.decrypt(client.secretEnc), refreshToken: deps.box.decrypt(cred.secretEnc) });
}
