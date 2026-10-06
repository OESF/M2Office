/**
 * @file 国の補助金の調べ先（仕様書 第39.4節）。jGrants の公開の API（ログイン不要）から、受付中の公募を引く。
 *
 * 読みに行くのは決まった所（`api.jgrants-portal.go.jp`）だけで、利用者の入力で行き先を変えない。会社のことは送らない（検索の言葉だけ）。
 * 見本の会社では {@link MockJGrants} を使い、外には読みに行かない。返ってきた中身は外のデータであり、指示として扱わない（不変則 I-6）。
 */

/** jGrants の公募の 1 件（一覧の項目だけ）。 */
export interface JGrantsItem {
  id: string;
  title: string;
  /** 実施する所 */
  institution: string;
  /** 対象の地域（「全国」「東京都 / 神奈川県」など） */
  area: string;
  /** 上限額（円。書かれていなければ `null`） */
  maxLimit: number | null;
  /** 受付の始めと終わり（ISO。書かれていなければ空） */
  start: string;
  end: string;
  /** 従業員の数の条件（「20名以下」など） */
  employees: string;
}

/** 国の補助金の調べ先。 */
export interface SubsidySource {
  /** 受付中の公募を、言葉で引く（2 字以上）。 */
  search(keyword: string): Promise<JGrantsItem[]>;
}

/** jGrants の一覧の API。 */
export const JGRANTS_API = 'https://api.jgrants-portal.go.jp/exp/v1/public/subsidies';

/** jGrants の公募のページ（出典に使う）。 */
export const jgrantsUrl = (id: string) => `https://www.jgrants-portal.go.jp/subsidy/${encodeURIComponent(id)}`;

const MAX_BYTES = 2 * 1024 * 1024;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** API の 1 件を読む（形が違えば `null`）。 */
export function readJGrantsItem(o: unknown): JGrantsItem | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const id = str(r['id']);
  const title = str(r['title']) || str(r['name']);
  if (!id || !title) return null;
  const max = typeof r['subsidy_max_limit'] === 'number' && r['subsidy_max_limit'] > 0 ? r['subsidy_max_limit'] : null;
  return {
    id: id.slice(0, 40), title: title.slice(0, 200), institution: str(r['institution_name']).slice(0, 100), area: str(r['target_area_search']).slice(0, 300),
    maxLimit: max, start: str(r['acceptance_start_datetime']), end: str(r['acceptance_end_datetime']), employees: str(r['target_number_of_employees']).slice(0, 60),
  };
}

/** jGrants の公開の API（本番）。 */
export class JGrantsApi implements SubsidySource {
  constructor(private readonly timeoutMs = 15_000) {}

  async search(keyword: string): Promise<JGrantsItem[]> {
    const k = keyword.trim().slice(0, 100);
    if (k.length < 2) return [];
    const url = `${JGRANTS_API}?${new URLSearchParams({ keyword: k, sort: 'acceptance_end_datetime', order: 'ASC', acceptance: '1' })}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' }, redirect: 'error' });
      if (!res.ok) throw new Error(`jGrants の API が ${res.status} を返しました`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error('jGrants の API の答えが大きすぎます');
      const body = JSON.parse(text) as { result?: unknown[] };
      return (Array.isArray(body.result) ? body.result : []).map(readJGrantsItem).filter((x): x is JGrantsItem => !!x).slice(0, 100);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 見本の会社の調べ先（外に読みに行かない）。締め切りは今日から数えて作る。 */
export class MockJGrants implements SubsidySource {
  readonly asked: string[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async search(keyword: string): Promise<JGrantsItem[]> {
    this.asked.push(keyword);
    const at = (days: number) => new Date(this.now().getTime() + days * 86_400_000).toISOString();
    return [
      { id: 'mock-it-01', title: '見本 IT 導入の補助金（通常枠）', institution: '見本の中小企業庁', area: '全国', maxLimit: 4_500_000, start: at(-10), end: at(40), employees: '従業員数の制約なし' },
      { id: 'mock-eco-02', title: '見本 省エネ設備の更新の補助金', institution: '見本の経済産業局', area: '全国', maxLimit: 10_000_000, start: at(-5), end: at(20), employees: '300名以下' },
      { id: 'mock-pref-03', title: '見本 地方の店舗の改装の補助金', institution: '見本の県', area: '大阪府', maxLimit: 1_000_000, start: at(-3), end: at(30), employees: '20名以下' },
    ];
  }
}

const PREF = /(北海道|東京都|(?:京都|大阪)府|[^\s都道府県]{2,3}県)/;

/** 住所から、都道府県と市区町村だけを取り出す（番地は持たない。第39.3節）。 */
export function regionOf(address: string): string {
  const a = address.normalize('NFKC').replace(/\s+/g, '');
  const pref = PREF.exec(a);
  if (!pref) return '';
  const rest = a.slice((pref.index ?? 0) + pref[0].length);
  // 政令市の区（「横浜市中区」）は市まで。郡は町村まで
  const city = /^(.+?郡.+?[町村]|.+?市|.+?区|.+?[町村])/.exec(rest);
  return `${pref[0]}${city ? city[1] : ''}`;
}

/** 都道府県だけ。 */
export const prefectureOf = (region: string) => PREF.exec(region)?.[0] ?? '';

/** 従業員の数を幅にする（そのままの数は渡さない。第39.3節）。 */
export function employeesBand(n: number | null): string {
  if (n === null || n <= 0) return '';
  if (n <= 5) return '1〜5 人';
  if (n <= 20) return '6〜20 人';
  if (n <= 50) return '21〜50 人';
  if (n <= 100) return '51〜100 人';
  if (n <= 300) return '101〜300 人';
  return '301 人以上';
}

/** 公募の対象の地域が、会社の所在地を含むか（「全国」か、都道府県の名前があるか。地域が書かれていなければ含むとみなす）。 */
export function areaMatches(area: string, region: string): boolean {
  const a = area.normalize('NFKC');
  if (!a || /全国/.test(a)) return true;
  const pref = prefectureOf(region);
  return !!pref && a.includes(pref);
}
