/**
 * @file Webの分析の数字（仕様書 第34.4節・第34.5節・第34.18節）。期間の決め方・サイトの選び方・月の便りの数字・秘書の問いの答え。
 *
 * **数字はここでプログラムが計算する。** 推論に数えさせない（比べた率も含む）。取れなかった数字は `null` にし、理由を `missing` に残す。
 * 期間は日本時間の日付で決める。
 */

import {
  WEB_REVIEW_BREAKDOWNS, WEB_REVIEW_FEW_USERS, WEB_REVIEW_METRICS, WEB_REVIEW_PERIODS,
  type WebReviewBreakdown, type WebReviewFigures, type WebReviewMetric, type WebReviewNumber, type WebReviewPeriod,
} from '@m2office/shared';
import { WebDataError, type WebData, type WebProperty, type WebSite } from './data.js';

// ---- 期間 -------------------------------------------------------------------------------------

/** 日本時間の今日（`YYYY-MM-DD`）。 */
export const jstToday = (now: Date = new Date()) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** 月（`2026-09`）の初日と末日。 */
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** 月をずらす（`2026-01` の -1 は `2025-12`）。 */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** 先月（`YYYY-MM`）。 */
export const lastMonthOf = (now: Date = new Date()) => shiftMonth(jstToday(now).slice(0, 7), -1);

/**
 * 秘書の問いの期間を日付にする。比べる相手は、直前の同じ長さの期間（先月なら前の月）。
 *
 * @returns 読めない日付なら `null`
 */
export function periodRange(period: WebReviewPeriod, now: Date = new Date(), custom?: { start?: string; end?: string }):
  { start: string; end: string; label: string; compare: { start: string; end: string } } | null {
  const today = jstToday(now);
  const yesterday = addDays(today, -1);
  const span = (start: string, end: string, label: string) => {
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
    return { start, end, label, compare: { start: addDays(start, -days), end: addDays(start, -1) } };
  };
  switch (period) {
    case 'lastMonth': {
      const m = shiftMonth(today.slice(0, 7), -1);
      const r = monthRange(m);
      const p = monthRange(shiftMonth(m, -1));
      return { ...r, label: `${Number(m.slice(5))} 月`, compare: p };
    }
    case 'thisMonth': {
      // 1 日は、今月の数字がまだ無い
      const start = `${today.slice(0, 7)}-01`;
      const end = yesterday < start ? start : yesterday;
      const prev = monthRange(shiftMonth(today.slice(0, 7), -1));
      const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
      return { start, end, label: `${Number(today.slice(5, 7))} 月（${Number(end.slice(8))} 日まで）`, compare: { start: prev.start, end: addDays(prev.start, Math.min(days, 27)) } };
    }
    case 'lastWeek': {
      // 月曜から日曜
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      const monday = addDays(today, -dow - 7);
      return span(monday, addDays(monday, 6), '先週');
    }
    case 'last7Days': return span(addDays(today, -7), yesterday, 'この 7 日');
    case 'last28Days': return span(addDays(today, -28), yesterday, 'この 28 日');
    case 'custom': {
      const ok = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
      if (!ok(custom?.start) || !ok(custom?.end) || custom!.start! > custom!.end!) return null;
      return span(custom!.start!, custom!.end! > today ? today : custom!.end!, `${custom!.start} 〜 ${custom!.end}`);
    }
  }
}

// ---- サイトの選び方 ---------------------------------------------------------------------------

/** URL かホスト名から、比べるためのホスト名（小文字・`www.` を除く）。 */
export function hostOf(v: string): string {
  const s = v.trim().toLowerCase().replace(/^sc-domain:/, '');
  try {
    return new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 会社の Web サイトに合うプロパティとサイトを選ぶ（第34.18節。決まった規則で選ぶ。推論は使わない）。
 *
 * @returns 選べたもの。選べなければ `null`（候補が複数・合うものが無い）
 */
export function pickSite(website: string, properties: WebProperty[], sites: WebSite[]): { property: WebProperty | null; site: WebSite | null } {
  const host = hostOf(website);
  const same = (h: string) => !!host && (h === host || h.endsWith(`.${host}`) || host.endsWith(`.${h}`));
  const props = properties.filter((p) => p.uris.some((u) => same(hostOf(u))));
  const matched = sites.filter((s) => same(hostOf(s.siteUrl)));
  // ドメインのプロパティ（sc-domain:）が 1 つあれば、URL のプロパティより先にする（サブドメインと http も含むため）
  // 合うものが 1 つならそれ。合うものが無く、見られるものが 1 つだけならそれ。ほかは選ばない（候補を並べて担当に選んでもらう）
  const property = props.length === 1 ? props[0]! : props.length === 0 && properties.length === 1 ? properties[0]! : null;
  const domains = matched.filter((s) => s.siteUrl.startsWith('sc-domain:'));
  const site = matched.length === 1 ? matched[0]! : domains.length === 1 ? domains[0]! : matched.length === 0 && sites.length === 1 ? sites[0]! : null;
  return { property, site };
}

// ---- 言葉 ------------------------------------------------------------------------------------

/** どこから来たか（GA4 の既定のチャネル）の言い換え（原則 u1）。 */
export const CHANNEL_LABELS: Record<string, string> = {
  'Organic Search': '検索', 'Paid Search': '検索の広告', 'Organic Social': 'SNS', 'Paid Social': 'SNS の広告', Referral: 'ほかのサイト',
  Direct: '直接（ブックマーク・URL の入力など）', Email: 'メール', 'Organic Maps': '地図', 'Paid Other': '広告', Display: '表示の広告',
  'Organic Video': '動画', 'Paid Video': '動画の広告', 'Organic Shopping': 'ショッピング', 'Paid Shopping': 'ショッピングの広告',
  'Cross-network': '広告（いくつもの場所）', Affiliates: 'アフィリエイト', SMS: 'SMS', Audio: '音声の広告', 'Mobile Push Notifications': 'スマホの通知',
  Unassigned: '分からない',
};

export const DEVICE_LABELS: Record<string, string> = { mobile: 'スマホ', desktop: 'パソコン', tablet: 'タブレット', MOBILE: 'スマホ', DESKTOP: 'パソコン', TABLET: 'タブレット' };

/** 都道府県（GA4 の地域の英語の名前）の言い換え。 */
export const REGION_LABELS: Record<string, string> = {
  Hokkaido: '北海道', Aomori: '青森県', Iwate: '岩手県', Miyagi: '宮城県', Akita: '秋田県', Yamagata: '山形県', Fukushima: '福島県',
  Ibaraki: '茨城県', Tochigi: '栃木県', Gunma: '群馬県', Saitama: '埼玉県', Chiba: '千葉県', Tokyo: '東京都', Kanagawa: '神奈川県',
  Niigata: '新潟県', Toyama: '富山県', Ishikawa: '石川県', Fukui: '福井県', Yamanashi: '山梨県', Nagano: '長野県', Gifu: '岐阜県',
  Shizuoka: '静岡県', Aichi: '愛知県', Mie: '三重県', Shiga: '滋賀県', Kyoto: '京都府', Osaka: '大阪府', Hyogo: '兵庫県', Nara: '奈良県',
  Wakayama: '和歌山県', Tottori: '鳥取県', Shimane: '島根県', Okayama: '岡山県', Hiroshima: '広島県', Yamaguchi: '山口県',
  Tokushima: '徳島県', Kagawa: '香川県', Ehime: '愛媛県', Kochi: '高知県', Fukuoka: '福岡県', Saga: '佐賀県', Nagasaki: '長崎県',
  Kumamoto: '熊本県', Oita: '大分県', Miyazaki: '宮崎県', Kagoshima: '鹿児島県', Okinawa: '沖縄県',
};

const label = (map: Record<string, string>, v: string) => map[v] ?? v;

/** 問い合わせ・予約のページらしい URL（キーイベントが無いときの数え方。第34.7節）。 */
export const INQUIRY_PAGE = /contact|inquiry|toiawase|otoiawase|form|reserve|yoyaku|booking|%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B|お問い合わせ|問い合わせ|予約/i;

// ---- 月の便りの数字 ---------------------------------------------------------------------------

const reason = (err: unknown) => (err instanceof WebDataError ? err.message : `読めませんでした（${err instanceof Error ? err.message : String(err)}）`);

/**
 * 月の便りの数字を、API の値から計算する（第34.4節）。
 *
 * @param month 対象の月（`2026-09`）
 * @remarks アナリティクスと Search Console は別々に読み、片方が読めなくてももう片方を出す。読めなかった理由は `missing` に入れる
 */
export async function monthFigures(data: WebData, month: string, target: { propertyId: string | null; siteUrl: string | null }): Promise<WebReviewFigures> {
  const cur = monthRange(month);
  const prev = monthRange(shiftMonth(month, -1));
  const ly = monthRange(shiftMonth(month, -12));
  const missing: string[] = [];
  let analytics: WebReviewFigures['analytics'] = null;
  let search: WebReviewFigures['search'] = null;

  if (!target.propertyId) missing.push('アナリティクス: プロパティを選んでいません');
  else {
    const pid = target.propertyId;
    try {
      const totals = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'keyEvents'];
      const [c, p, y] = await Promise.all([cur, prev, ly].map((r) => data.report(pid, { ...r, metrics: totals }).then((rows) => rows[0]?.values ?? null).catch(() => null)));
      if (!c) throw new WebDataError('アナリティクスの数字を読めませんでした', 'failed');
      const num = (i: number): WebReviewNumber => ({ value: c[i] ?? null, previous: p?.[i] ?? null, lastYear: y?.[i] ?? null });
      // 問い合わせのページへ進んだ数（キーイベントがあればその数。無ければ URL で数える）
      const useKey = (c[5] ?? 0) > 0;
      const pageViewsOf = async (r: { start: string; end: string }) => {
        const rows = await data.report(pid, { ...r, metrics: ['screenPageViews'], dimensions: ['pagePath'], limit: 500, orderBy: 'screenPageViews' });
        return rows.filter((row) => INQUIRY_PAGE.test(row.dims[0] ?? '')).reduce((t, row) => t + (row.values[0] ?? 0), 0);
      };
      const inquiries = useKey
        ? { ...num(5), basis: 'keyEvents' as const }
        : await Promise.all([cur, prev, ly].map((r) => pageViewsOf(r).catch(() => null)))
          .then(([a, b, d]) => ({ value: a ?? null, previous: b ?? null, lastYear: d ?? null, basis: 'pages' as const }));
      const [sources, pages, devices, regions] = await Promise.all([
        data.report(pid, { ...cur, metrics: ['sessions'], dimensions: ['sessionDefaultChannelGroup'], limit: 10, orderBy: 'sessions' }),
        data.report(pid, { ...cur, metrics: ['screenPageViews'], dimensions: ['pagePath', 'pageTitle'], limit: 5, orderBy: 'screenPageViews' }),
        data.report(pid, { ...cur, metrics: ['activeUsers'], dimensions: ['deviceCategory'], limit: 5, orderBy: 'activeUsers' }),
        data.report(pid, { ...cur, metrics: ['activeUsers'], dimensions: ['region'], limit: 5, orderBy: 'activeUsers' }),
      ]);
      const deviceTotal = devices.reduce((t, d) => t + (d.values[0] ?? 0), 0);
      analytics = {
        users: num(0), newUsers: num(1), sessions: num(2), pageViews: num(3), engagementRate: num(4), inquiries,
        sources: sources.map((s) => ({ label: label(CHANNEL_LABELS, s.dims[0] ?? ''), sessions: s.values[0] ?? 0 })),
        topPages: pages.map((r) => ({ path: r.dims[0] ?? '', title: r.dims[1] ?? '', views: r.values[0] ?? 0 })),
        mobileShare: deviceTotal ? (devices.find((d) => d.dims[0] === 'mobile')?.values[0] ?? 0) / deviceTotal : null,
        regions: regions.filter((r) => r.dims[0] && r.dims[0] !== '(not set)').slice(0, 3).map((r) => ({ label: label(REGION_LABELS, r.dims[0]!), users: r.values[0] ?? 0 })),
      };
    } catch (err) {
      missing.push(`アナリティクス: ${reason(err)}`);
    }
  }

  if (!target.siteUrl) missing.push('Search Console: サイトを選んでいません');
  else {
    const site = target.siteUrl;
    try {
      const [c, p, y] = await Promise.all([cur, prev, ly].map((r) => data.search(site, r).then((rows) => rows[0] ?? null).catch(() => null)));
      if (!c) throw new WebDataError('Search Console の数字を読めませんでした（まだ数字が無いか、読めません）', 'failed');
      const n = (k: 'clicks' | 'impressions' | 'ctr' | 'position'): WebReviewNumber => ({ value: c[k], previous: p?.[k] ?? null, lastYear: y?.[k] ?? null });
      const [now, before] = await Promise.all([
        data.search(site, { ...cur, dimensions: ['query'], limit: 250 }),
        data.search(site, { ...prev, dimensions: ['query'], limit: 250 }).catch(() => [] as Awaited<ReturnType<WebData['search']>>),
      ]);
      const was = new Map(before.map((r) => [r.keys[0] ?? '', r.clicks]));
      search = {
        impressions: n('impressions'), clicks: n('clicks'), ctr: n('ctr'), position: n('position'),
        topQueries: [...now].sort((a, b) => b.clicks - a.clicks).slice(0, 5).map((r) => ({ query: r.keys[0] ?? '', clicks: r.clicks, impressions: r.impressions })),
        risingQueries: now.map((r) => ({ query: r.keys[0] ?? '', clicks: r.clicks, previous: was.get(r.keys[0] ?? '') ?? 0 }))
          .filter((r) => r.clicks > r.previous).sort((a, b) => (b.clicks - b.previous) - (a.clicks - a.previous)).slice(0, 3),
      };
    } catch (err) {
      missing.push(`Search Console: ${reason(err)}`);
    }
  }

  const users = analytics?.users.value ?? null;
  return { month, ...cur, few: users !== null && users < WEB_REVIEW_FEW_USERS, analytics, search, missing };
}

/** 比べた率（%）。前が無い・0 なら `null`。 */
export function changeRate(n: { value: number | null; previous: number | null }): number | null {
  if (n.value === null || n.previous === null || n.previous === 0) return null;
  return Math.round(((n.value - n.previous) / n.previous) * 1000) / 10;
}

// ---- 秘書の問い --------------------------------------------------------------------------------

/** 秘書の問い（推論が決まった一覧の中から選んだもの）。 */
export interface WebAsk {
  metric: WebReviewMetric;
  breakdown: WebReviewBreakdown;
  period: WebReviewPeriod;
  start?: string;
  end?: string;
  /** ページの URL か検索の言葉に含む文字 */
  contains?: string;
}

/** 秘書の問いの答え。 */
export interface WebAnswer {
  metric: string;
  breakdown: string | null;
  period: { start: string; end: string; label: string };
  compare: { start: string; end: string };
  value: number | null;
  previous: number | null;
  /** 前と比べた率（%） */
  change: number | null;
  rows: { label: string; value: number; previous: number | null }[];
  source: 'アナリティクス' | 'Search Console';
}

const GA_METRIC: Partial<Record<WebReviewMetric, string>> = {
  users: 'activeUsers', newUsers: 'newUsers', sessions: 'sessions', pageViews: 'screenPageViews', engagementRate: 'engagementRate', keyEvents: 'keyEvents',
};
const GA_DIMENSION: Partial<Record<WebReviewBreakdown, string>> = { page: 'pagePath', source: 'sessionDefaultChannelGroup', device: 'deviceCategory', region: 'region' };
const SC_DIMENSION: Partial<Record<WebReviewBreakdown, 'query' | 'page' | 'device'>> = { searchQuery: 'query', searchPage: 'page', device: 'device' };

/** 問いが決まった一覧の中かを確かめる。外なら理由。 */
export function checkAsk(a: Partial<WebAsk>): string | null {
  if (!a.metric || !(a.metric in WEB_REVIEW_METRICS)) return 'その指標は扱っていません';
  if (!a.breakdown || !(a.breakdown in WEB_REVIEW_BREAKDOWNS)) return 'その切り口は扱っていません';
  if (!a.period || !(a.period in WEB_REVIEW_PERIODS)) return 'その期間は扱っていません';
  const ga = a.metric in GA_METRIC;
  if (a.breakdown !== 'none' && (ga ? !(a.breakdown in GA_DIMENSION) : !(a.breakdown in SC_DIMENSION))) return 'その切り口は扱っていません';
  return null;
}

/**
 * 秘書の問いに答える（第34.5節）。決まった指標と切り口の組み合わせだけを呼ぶ。
 *
 * @returns 範囲の外・つないでいないときは `{ error }`
 */
export async function answerAsk(data: WebData, target: { propertyId: string | null; siteUrl: string | null }, a: WebAsk, now: Date = new Date()): Promise<WebAnswer | { error: string }> {
  const bad = checkAsk(a);
  if (bad) return { error: bad };
  const range = periodRange(a.period, now, { start: a.start, end: a.end });
  if (!range) return { error: '期間の日付が読めません' };
  const contains = a.contains?.trim().slice(0, 100) || undefined;
  const base = { metric: WEB_REVIEW_METRICS[a.metric], breakdown: a.breakdown === 'none' ? null : WEB_REVIEW_BREAKDOWNS[a.breakdown], period: { start: range.start, end: range.end, label: range.label }, compare: range.compare };
  const gaMetric = GA_METRIC[a.metric];
  if (gaMetric) {
    if (!target.propertyId) return { error: 'アナリティクスのプロパティを選んでいません' };
    const pid = target.propertyId;
    const dim = GA_DIMENSION[a.breakdown];
    // ページで絞るときは、合計もそのページだけにする
    const filter = contains ? { dimension: 'pagePath', contains } : undefined;
    const total = async (r: { start: string; end: string }) => {
      if (!filter) return (await data.report(pid, { ...r, metrics: [gaMetric] }))[0]?.values[0] ?? null;
      const rows = await data.report(pid, { ...r, metrics: [gaMetric], dimensions: ['pagePath'], filter, limit: 500 });
      if (gaMetric === 'engagementRate') return rows.length ? rows.reduce((t, x) => t + (x.values[0] ?? 0), 0) / rows.length : null;
      return rows.reduce((t, x) => t + (x.values[0] ?? 0), 0);
    };
    const [value, previous] = await Promise.all([total(range), total(range.compare).catch(() => null)]);
    let rows: WebAnswer['rows'] = [];
    if (dim) {
      const q = { metrics: [gaMetric], dimensions: [dim], limit: 10, orderBy: gaMetric, ...(filter && dim === 'pagePath' ? { filter } : {}) };
      const [now2, before] = await Promise.all([data.report(pid, { ...range, ...q }), data.report(pid, { ...range.compare, ...q, limit: 50 }).catch(() => [])]);
      const was = new Map(before.map((r) => [r.dims[0] ?? '', r.values[0] ?? 0]));
      const map = dim === 'sessionDefaultChannelGroup' ? CHANNEL_LABELS : dim === 'deviceCategory' ? DEVICE_LABELS : dim === 'region' ? REGION_LABELS : {};
      rows = now2.map((r) => ({ label: label(map, r.dims[0] ?? ''), value: r.values[0] ?? 0, previous: was.get(r.dims[0] ?? '') ?? null }));
    }
    return { ...base, value, previous, change: changeRate({ value, previous }), rows, source: 'アナリティクス' };
  }
  if (!target.siteUrl) return { error: 'Search Console のサイトを選んでいません' };
  const site = target.siteUrl;
  const key = ({ searchImpressions: 'impressions', searchClicks: 'clicks', searchCtr: 'ctr', searchPosition: 'position' } as const)[a.metric as 'searchImpressions'];
  const dim = SC_DIMENSION[a.breakdown];
  const filter = contains ? { dimension: (a.breakdown === 'searchPage' ? 'page' : 'query') as 'query' | 'page', contains } : undefined;
  const total = async (r: { start: string; end: string }) => {
    const rows = await data.search(site, { ...r, ...(filter ? { filter } : {}) });
    return rows[0] ? rows[0][key] : null;
  };
  const [value, previous] = await Promise.all([total(range), total(range.compare).catch(() => null)]);
  let rows: WebAnswer['rows'] = [];
  if (dim) {
    const q = { dimensions: [dim], limit: 10, ...(filter ? { filter } : {}) };
    const [now2, before] = await Promise.all([data.search(site, { ...range, ...q }), data.search(site, { ...range.compare, ...q, limit: 50 }).catch(() => [])]);
    const was = new Map(before.map((r) => [r.keys[0] ?? '', r[key]]));
    rows = now2.map((r) => ({ label: dim === 'device' ? label(DEVICE_LABELS, r.keys[0] ?? '') : r.keys[0] ?? '', value: r[key], previous: was.get(r.keys[0] ?? '') ?? null }));
  }
  return { ...base, value, previous, change: changeRate({ value, previous }), rows, source: 'Search Console' };
}
