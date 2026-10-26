/**
 * @file 消費税の区分と、日付で変わる税率（仕様書 第15.1.1節、Q-275）。制度の決まりとして基盤に持ち、業務の定義には書かない。
 *
 * 品目には税率の数ではなく「区分」を持ち、税率は区分と取引の日から決める（税率の変わる日をまたぐ取引と、新しい税率を扱うため）。
 * まだ成立していない変更は「予定」として表に持ち、M2Office の更新で確定にするまで今の税率で計算する。
 */

/** 消費税の区分。`exempt` は消費税のかからないもの（不課税と非課税をまとめる）。 */
export type TaxCategory = 'standard' | 'food' | 'news' | 'exempt';

/** 区分の呼び方。 */
export const TAX_CATEGORY_LABELS: Record<TaxCategory, string> = {
  standard: '標準', food: '軽減（飲食料品）', news: '軽減（新聞）', exempt: '対象外',
};

/** 税率の表の 1 行。日付は `YYYY-MM-DD`（両端を含む）。 */
export interface TaxRateEntry {
  category: TaxCategory;
  rate: number;
  from: string;
  to?: string;
  /** まだ法律が成立していない変更。確定するまで計算に使わない */
  planned?: boolean;
  /** 予定のときに書類に出す言葉 */
  note?: string;
}

/**
 * 税率の表（第15.1.1節）。制度が変わったら M2Office の更新で直す。
 *
 * @remarks 食料品の 1%（2027-04-01〜2029-03-31）は、2026-10-26 時点で法案の段階のため `planned`。成立したら `planned` を外す
 */
export const TAX_RATE_TABLE: TaxRateEntry[] = [
  { category: 'standard', rate: 10, from: '2019-10-01' },
  { category: 'food', rate: 8, from: '2019-10-01' },
  {
    category: 'food', rate: 1, from: '2027-04-01', to: '2029-03-31', planned: true,
    note: '食料品の税率は 2027 年 4 月から 1% になる予定です（法律の成立を待っています）',
  },
  { category: 'news', rate: 8, from: '2019-10-01' },
  { category: 'exempt', rate: 0, from: '2019-10-01' },
];

/**
 * その日の区分の税率（確定した行だけを見る。後から始まる行を優先する）。
 *
 * @param day 取引の日（`YYYY-MM-DD`）
 */
export function taxRateOn(category: TaxCategory, day: string, table: TaxRateEntry[] = TAX_RATE_TABLE): number {
  const hit = table.filter((e) => e.category === category && !e.planned && e.from <= day && (!e.to || day <= e.to))
    .sort((a, b) => b.from.localeCompare(a.from))[0];
  return hit?.rate ?? (category === 'exempt' ? 0 : category === 'standard' ? 10 : 8);
}

/**
 * その日に当たる、まだ確定していない税率の変更の知らせ（無ければ `null`）。
 */
export function plannedTaxNote(category: TaxCategory, day: string, table: TaxRateEntry[] = TAX_RATE_TABLE): string | null {
  return table.find((e) => e.category === category && e.planned && e.from <= day && (!e.to || day <= e.to))?.note ?? null;
}

/**
 * 品目の区分（区分を持たない前の品目は、税率から読む: 8 は飲食料品、0 は対象外、ほかは標準）。
 */
export function taxCategoryOf(item: { taxCategory?: TaxCategory | null; taxRate?: number | null }): TaxCategory {
  if (item.taxCategory && item.taxCategory in TAX_CATEGORY_LABELS) return item.taxCategory;
  return item.taxRate === 8 || item.taxRate === 1 ? 'food' : item.taxRate === 0 ? 'exempt' : 'standard';
}

/** 帳票と画面の税率の呼び方（「10% 対象」「対象外」）。 */
export const taxRateLabel = (rate: number): string => (rate === 0 ? '対象外' : `${rate}% 対象`);

const FOOD = /(パン|弁当|おにぎり|お米|白米|玄米|精米|野菜|果物|フルーツ|肉|魚|鮮魚|精肉|卵|牛乳|乳製品|チーズ|ヨーグルト|菓子|ケーキ|クッキー|せんべい|チョコ|飲料|ジュース|お茶|緑茶|麦茶|紅茶|コーヒー豆|ドリップ|ミネラルウォーター|水（|食品|食材|調味料|醤油|味噌|砂糖|食塩|食用油|麺|うどん|そば|パスタ|惣菜|総菜|冷凍食品|缶詰|豆腐|納豆|漬物|のり|海苔|乾物|ハム|ソーセージ|ベーコン)/;
const ALCOHOL = /(ビール|発泡酒|日本酒|焼酎|ワイン|ウイスキー|酒|サワー|チューハイ|リキュール|ハイボール)/;
const DINE_IN = /(店内|イートイン|ケータリング|出張料理|外食|飲食代|会食|宴会)/;
const NEWS = /(新聞)/;
const EXEMPT = /(会費|年会費|入会金|寄付|寄附|協賛金|祝い金|見舞金|保険金|印紙|切手|地代|土地|家賃（住宅|住宅の家賃|商品券|プリペイド)/;
const PAID_FEE = /(セミナー|講座|研修|教室|参加費|利用料|使用料|月謝|サービス)/;

/**
 * 品名から区分を推し量る（AI が使えないときと、画面の初めの値）。分からなければ標準。
 *
 * @returns 区分と、迷ったか（会費のように、対価のあるものと無いものが分かれるもの）
 * @remarks 推論が使えるときは、業務の推論が区分を決める（第15.1.1節）。これは決まった言い方での読み方
 */
export function guessTaxCategory(name: string): { category: TaxCategory; unsure: boolean } {
  const t = name.normalize('NFKC');
  if (ALCOHOL.test(t) && !/(ノンアルコール|酒粕|料理酒)/.test(t)) return { category: 'standard', unsure: false };
  if (DINE_IN.test(t)) return { category: 'standard', unsure: false };
  if (NEWS.test(t)) return { category: /(定期購読|月極|購読料)/.test(t) ? 'news' : 'standard', unsure: !/(定期購読|月極|購読料)/.test(t) };
  if (EXEMPT.test(t)) {
    // 会費でも、セミナーの参加費やサービスの利用料のように対価のあるものは標準
    if (/会費|入会金/.test(t) && PAID_FEE.test(t)) return { category: 'standard', unsure: true };
    return { category: 'exempt', unsure: /会費|入会金/.test(t) };
  }
  if (FOOD.test(t)) return { category: 'food', unsure: false };
  return { category: 'standard', unsure: false };
}

/** 区分を決めたことの言葉（受注と書類の印。標準は出さない）。 */
export function taxCategoryNote(name: string, category: TaxCategory, unsure = false): string | null {
  if (category === 'standard' && !unsure) return null;
  const what = category === 'exempt' ? '対象外（消費税がかからない）' : category === 'standard' ? '標準（10%）' : TAX_CATEGORY_LABELS[category].replace('軽減', '軽減税率');
  return `${name} は${what}と判断しました${unsure ? '（対価のあるものかで変わります。違えば直してください）' : ''}`;
}

/** 品目の行に添える税率の印（標準は付けない）。 */
export const taxMark = (rate: number): string => (rate === 10 ? '' : rate === 0 ? '（対象外）' : `（${rate}%）`);

/**
 * 税率ごとの内訳の 1 行（適格請求書の「税率ごとに区分した対価の額と消費税額」。第15.1.1節）。
 *
 * @example `（内訳）10% 対象 42,000 円・消費税 4,200 円、8% 対象 1,000 円・消費税 80 円、対象外 5,000 円`
 */
export function taxBreakdown(lines: { rate: number; base: number; tax: number }[]): string {
  const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
  return `（内訳）${lines.map((x) => (x.rate === 0 ? `対象外 ${yen(x.base)}` : `${x.rate}% 対象 ${yen(x.base)}・消費税 ${yen(x.tax)}`)).join('、')}`;
}

/** 品目の税率の印の説明（標準以外の印があるときだけ）。 */
export function taxLegend(rates: number[]): string | null {
  const reduced = [...new Set(rates.filter((r) => r !== 10 && r !== 0))].sort((a, b) => b - a).map((r) => `（${r}%）`);
  const parts = [...(reduced.length ? [`${reduced.join('')}は軽減税率の対象`] : []), ...(rates.includes(0) ? ['（対象外）は消費税のかからないもの'] : [])];
  return parts.length ? `${parts.join('、')}です` : null;
}
