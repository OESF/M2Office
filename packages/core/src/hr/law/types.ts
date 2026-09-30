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

/**
 * 随時改定の上限・下限の特例（1 等級の差でも改定する。仕様書 第30.12.1節）。従前の等級が `fromGrade` で、
 * 従前の報酬月額と 3 か月の平均が条件に合えば `toGrade` にする。
 */
export interface ChangeLimit {
  system: 'health' | 'pension';
  direction: 'up' | 'down';
  fromGrade: number;
  /** 従前の報酬月額が この額未満（以上）であること。 */
  priorPayBelow?: number;
  priorPayAtLeast?: number;
  /** 3 か月の平均が この額以上（未満）であること。 */
  averageAtLeast?: number;
  averageBelow?: number;
  toGrade: number;
}

/** 標準報酬月額の等級表（健康保険と厚生年金）。 */
export interface GradeTable extends LawMeta {
  effectiveFrom: string;
  health: GradeRow[];
  pension: GradeRow[];
  /** 随時改定の上限・下限の特例（等級表とともに変わる）。 */
  changeLimits?: ChangeLimit[];
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

/** 賞与に対する源泉徴収税額の算出率の表の 1 行（率ごとに、扶養親族等の数 0〜7 人以上の前月の給与の範囲）。 */
export interface BonusRateRow {
  /** 賞与の金額に乗ずべき率（%）。 */
  rate: number;
  /** 甲欄: 扶養親族等の数 0〜7 人以上ごとの [以上, 未満]（円。未満が `null` なら上限なし。欄が無ければ `null`）。 */
  ko: ([number, number | null] | null)[];
  /** 乙欄の [以上, 未満]（欄が無ければ `null`）。 */
  otsu: [number, number | null] | null;
}

/** 賞与に対する源泉徴収税額の算出率の表。その年に支払う賞与に使う。 */
export interface BonusRates extends LawMeta {
  year: number;
  rows: BonusRateRow[];
}

/** 控除の段階の式 [以下, 率, 足す額]（以下が `null` なら定額）。 */
export type StepFormula = [number | null, number, number][];

/** 年末調整の決まり（その年の版。仕様書 第30.15.1節）。 */
export interface YeaRules extends LawMeta {
  year: number;
  /** この版を使う年末調整の日（令和8年分は 12 月 1 日以後）。 */
  appliesFrom: string;
  /** 年末調整の対象になる給与の上限。 */
  payLimit: number;
  /** 給与所得控除後の給与等の金額（表の外の式）。 */
  employment: { zeroBelow: number; linearBelow: number; linearMinus: number; over: { min: number; max: number | null; rate: number; minus: number }[] };
  /** 給与所得控除後の給与等の金額の表 [以上, 未満, 控除後]。 */
  employmentTable: [number, number, number][];
  incomeAdjustment: { payOver: number; payCap: number; rate: number; max: number };
  /** 基礎控除（合計所得金額が max 以下の段。max が `null` は最後）。 */
  basic: { max: number | null; amount: number }[];
  /** 配偶者控除と配偶者特別控除。金額は本人の合計所得金額の段（selfBands）ごと。 */
  spouse: { selfBands: number[]; incomeMax: number; general: number[]; elderly: number[]; special: { min: number; max: number; amounts: number[] }[] };
  dependents: { incomeMax: number; general: number; specific: number; elderly: number; elderlyCohabiting: number };
  /** 特定親族特別控除（親族の合計所得金額が min 超 max 以下）。 */
  specificRelative: { min: number; max: number; amount: number }[];
  disability: { general: number; special: number; specialCohabiting: number };
  widow: number;
  singleParent: number;
  singleParentIncomeMax: number;
  workingStudent: number;
  workingStudentIncomeMax: number;
  life: { formulaI: StepFormula; formulaII: StepFormula; formulaIII: StepFormula; generalMax: number; generalMaxSpecial: number; pensionMax: number; totalMax: number };
  earthquake: { max: number; oldLongTerm: StepFormula };
  /** 算出所得税額の速算表（課税給与所得金額が max 以下）。 */
  rates: { max: number; rate: number; deduction: number }[];
  /** これを超える課税給与所得金額は年末調整の対象外。 */
  taxableLimit: number;
  /** 復興特別所得税を含む倍率。 */
  surtax: number;
}

/** 社会保険と雇用保険の適用の決まり（仕様書 第30.12.1節）。施行日（YYYY-MM-DD）から効く。 */
export interface InsuranceRules extends LawMeta {
  effectiveFrom: string;
  /** 支払基礎日数の要件（一般・短時間労働者・4 分の 3 以上のパートで 17 日以上の月が無いとき）。 */
  baseDays: { general: number; shortTime: number; part: number };
  /** 短時間労働者の適用の要件（週の所定労働時間・所定内賃金の月額（撤廃の後は `null`）・雇用の見込みの月数（を超える）・特定適用事業所の被保険者の数（以上））。 */
  shortTime: { weeklyHours: number; monthlyWage: number | null; months: number; officeSize: number };
  /** 雇用保険の適用の要件（週の所定労働時間（以上）・雇用の見込みの日数（以上））。 */
  employment: { weeklyHours: number; days: number };
  /** 随時改定の等級の差（以上）。 */
  changeGrades: number;
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
  /** 賞与に対する源泉徴収税額の算出率の表。 */
  bonus: BonusRates[];
  minimumWage: MinimumWage[];
  /** 年末調整の決まり（年ごと）。 */
  yea: YeaRules[];
  /** 社会保険と雇用保険の適用の決まり（施行日ごと）。 */
  insurance: InsuranceRules[];
}
