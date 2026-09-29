/**
 * @file 法令の表の形（仕様書 第30.10.2節）。運営が本体のデータとして持ち、リリースで更新する。
 *
 * どの表も出典（官公庁の発表の URL）・確認日・監修の状態を持つ。額や料率を推測で埋めない。
 * 料率は % で持つ（全体の料率。本人負担は計算で半分にする）。雇用保険は労働者負担の率を小数で持つ。
 */

/** 監修の状態。監修前の表で計算した回は確定できない（段 4）。 */
export interface LawReview {
  status: 'unverified' | 'verified';
  /** 監修した人（事務所）。 */
  by?: string;
  on?: string;
}

/** どの表も持つ出どころ。 */
export interface LawMeta {
  /** 版の名前（「協会けんぽ 令和8年度」）。 */
  version: string;
  source: string;
  checkedOn: string;
  review: LawReview;
}

/** 料率 1 つ（保険料の月 YYYY-MM から）。 */
export interface RateTable extends LawMeta {
  effectiveFrom: string;
  rate: number;
}

/** 協会けんぽの健康保険料率（都道府県ごと。保険料の月 YYYY-MM から）。 */
export interface HealthRates extends LawMeta {
  effectiveFrom: string;
  prefectures: Record<string, number>;
}

/** 標準報酬月額の等級の 1 行（min 以上 max 未満。最後の等級は max が `null`）。 */
export interface GradeRow {
  grade: number;
  amount: number;
  min: number;
  max: number | null;
}

/** 標準報酬月額の等級表（健康保険と厚生年金）。 */
export interface GradeTable extends LawMeta {
  effectiveFrom: string;
  health: GradeRow[];
  pension: GradeRow[];
}

/** 雇用保険料率（労働者負担。日付 YYYY-MM-DD から。賃金の締め日で選ぶ）。 */
export interface EmploymentRates extends LawMeta {
  effectiveFrom: string;
  general: number;
  agriculture: number;
  construction: number;
}

/** 源泉徴収税額表（月額表）の 1 行。`ko` は扶養親族等の数 0〜7 人の甲欄。 */
export interface WithholdingRow {
  min: number;
  max: number;
  ko: number[];
  otsu: number;
}

/** 甲欄で表の最後の行を超える金額の式（min 以上で次の min 未満: 額 = min の場合の額 + (金額 − min) × 率 の 1 円未満切り捨て）。 */
export interface WithholdingAbove {
  min: number;
  ko: number[];
  koRate: number;
}

/** 乙欄で表の最後の行を超える金額の式（min 以上で次の min 未満: 額 = base + (金額 − min) × 率 の 1 円未満切り捨て）。 */
export interface WithholdingOtsuAbove {
  min: number;
  base: number;
  rate: number;
}

/** 給与所得の源泉徴収税額表（月額表）。その年に支払う給与に使う。 */
export interface WithholdingMonthly extends LawMeta {
  year: number;
  /** 最初の行より少ない金額（甲欄は 0 円、乙欄は金額 × 率）。 */
  below: { max: number; otsuRate: number };
  rows: WithholdingRow[];
  above: WithholdingAbove[];
  otsuAbove: WithholdingOtsuAbove[];
  /** 扶養親族等が 7 人を超えるとき、1 人ごとに 7 人の税額から引く額。 */
  extraDependentDeduction: number;
}

/** 地域別最低賃金（都道府県ごと・発効日つき）。 */
export interface MinimumWage extends LawMeta {
  prefectures: Record<string, { amount: number; from: string }[]>;
}

/** 法令の表のひとそろい。版ごとに並べ、使う日で選ぶ。 */
export interface LawBook {
  health: HealthRates[];
  care: RateTable[];
  childSupport: RateTable[];
  pension: RateTable[];
  grades: GradeTable[];
  employment: EmploymentRates[];
  withholding: WithholdingMonthly[];
  minimumWage: MinimumWage[];
}
