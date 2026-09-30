/**
 * @file 法令の表を使う日で引く（仕様書 第30.10.2節・H-8）。表が無い月は `null` を返し、計算を止めずに「表が未登録」と示させる。
 */

import type {
  BonusRates, YeaRules, EmploymentRates, InsuranceRules, GradeRow, GradeTable, HealthRates, LawBook, LawMeta, MinimumWage, RateTable, WithholdingMonthly,
} from './types.js';

/** 引いた値と、使った表の版。 */
export interface LawHit<T> {
  value: T;
  table: LawMeta;
}

/** 前の月（YYYY-MM）。 */
function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 効き始めが `key` 以前で最も新しい表。 */
function latest<T extends { effectiveFrom: string }>(list: T[], key: string): T | null {
  return [...list].filter((t) => t.effectiveFrom <= key).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

/** 毎年変わる表と、変わる月（仕様書 第30.18.1節）。 */
const YEARLY: { key: 'health' | 'care' | 'childSupport' | 'employment' | 'withholding'; label: string; month: number }[] = [
  { key: 'health', label: '協会けんぽの健康保険料率', month: 3 },
  { key: 'care', label: '介護保険料率', month: 3 },
  { key: 'childSupport', label: '子ども・子育て支援金率', month: 4 },
  { key: 'employment', label: '雇用保険料率', month: 4 },
  { key: 'withholding', label: '源泉徴収税額表（月額表）', month: 1 },
];

/** 更新されていない表 1 つ。 */
export interface StaleTable {
  label: string;
  /** 本来はこの月（YYYY-MM）から新しい表が効く。 */
  expectedFrom: string;
}

/** これから効く表 1 つ。 */
export interface LawChange {
  label: string;
  /** 効き始め（YYYY-MM-DD）。 */
  date: string;
  /** 保険料の月か、支払う給与か。 */
  applies: string;
  detail: string;
}

/** 法令の表を引く道具。 */
export class Law {
  constructor(readonly book: LawBook) {}

  /** 協会けんぽの健康保険料率（%）。保険料の月（YYYY-MM）で選ぶ。 */
  healthRate(prefecture: string, premiumMonth: string): LawHit<number> | null {
    const t: HealthRates | null = latest(this.book.health, premiumMonth);
    const rate = t?.prefectures[prefecture];
    return t && rate !== undefined ? { value: rate, table: t } : null;
  }

  private rate(list: RateTable[], premiumMonth: string): LawHit<number> | null {
    const t = latest(list, premiumMonth);
    return t ? { value: t.rate, table: t } : null;
  }

  /** 介護保険料率（%）。 */
  careRate(premiumMonth: string): LawHit<number> | null {
    return this.rate(this.book.care, premiumMonth);
  }

  /** 子ども・子育て支援金率（%）。始まる前の月は `null`。 */
  childSupportRate(premiumMonth: string): LawHit<number> | null {
    return this.rate(this.book.childSupport, premiumMonth);
  }

  /** 厚生年金保険料率（%）。 */
  pensionRate(premiumMonth: string): LawHit<number> | null {
    return this.rate(this.book.pension, premiumMonth);
  }

  /** 報酬の額から、健康保険と厚生年金の等級を引く。 */
  grade(pay: number, premiumMonth: string): LawHit<{ health: GradeRow; pension: GradeRow }> | null {
    const t: GradeTable | null = latest(this.book.grades, premiumMonth);
    if (!t) return null;
    const find = (rows: GradeRow[]) => rows.find((r) => pay >= r.min && (r.max === null || pay < r.max)) ?? null;
    const health = find(t.health);
    const pension = find(t.pension);
    return health && pension ? { value: { health, pension }, table: t } : null;
  }

  /** 保険料の月（YYYY-MM）に効いている等級表。 */
  gradeTable(premiumMonth: string): GradeTable | null {
    return latest(this.book.grades, premiumMonth);
  }

  /** 健康保険の標準報酬月額の額から、厚生年金の標準報酬月額（上限と下限で丸める）。 */
  pensionAmountFor(healthAmount: number, premiumMonth: string): LawHit<GradeRow> | null {
    const t: GradeTable | null = latest(this.book.grades, premiumMonth);
    if (!t) return null;
    const row = t.pension.find((r) => healthAmount >= r.min && (r.max === null || healthAmount < r.max)) ?? null;
    return row ? { value: row, table: t } : null;
  }

  /** 雇用保険の労働者負担の率（小数）。賃金の締め日（YYYY-MM-DD）で選ぶ。 */
  employmentRate(kind: 'general' | 'agriculture' | 'construction', date: string): LawHit<number> | null {
    const t: EmploymentRates | null = latest(this.book.employment, date);
    return t ? { value: t[kind], table: t } : null;
  }

  /**
   * 源泉所得税（月額表）。支払う日の年の表で引く。
   *
   * @param amount 社会保険料等を引いた後の給与の額
   * @returns 税額と、当てた行（根拠）。その年の表が無ければ `null`
   */
  withholding(amount: number, column: 'ko' | 'otsu', dependents: number, payDate: string): LawHit<{ tax: number; row: string }> | null {
    const t: WithholdingMonthly | undefined = this.book.withholding.find((w) => w.year === Number(payDate.slice(0, 4)));
    if (!t) return null;
    const a = Math.max(0, Math.floor(amount));
    const dep = Math.max(0, Math.floor(dependents));
    // 7 人を超える分は 1 人ごとに引く（0 円より下にしない）
    const ko = (list: number[]) => Math.max(0, list[Math.min(dep, 7)]! - Math.max(0, dep - 7) * t.extraDependentDeduction);
    if (a < t.below.max) {
      const tax = column === 'ko' ? 0 : Math.floor((a * t.below.otsuRate) / 100);
      return { value: { tax, row: `${t.below.max.toLocaleString('ja-JP')} 円未満` }, table: t };
    }
    const row = t.rows.find((r) => a >= r.min && a < r.max);
    if (row) {
      return { value: { tax: column === 'ko' ? ko(row.ko) : row.otsu, row: `${row.min.toLocaleString('ja-JP')} 円以上 ${row.max.toLocaleString('ja-JP')} 円未満` }, table: t };
    }
    // 表の最後の行を超える金額は式で求める（率を掛けた額の 1 円未満は切り捨て）
    if (column === 'ko') {
      const top = [...t.above].sort((x, y) => y.min - x.min).find((x) => a >= x.min);
      if (!top) return null;
      return { value: { tax: Math.floor(ko(top.ko) + ((a - top.min) * top.koRate) / 100), row: `${top.min.toLocaleString('ja-JP')} 円の額 ＋ 超える分 × ${top.koRate}%` }, table: t };
    }
    const top = [...t.otsuAbove].sort((x, y) => y.min - x.min).find((x) => a >= x.min);
    if (!top) return null;
    return { value: { tax: Math.floor(top.base + ((a - top.min) * top.rate) / 100), row: `乙欄 ${top.base.toLocaleString('ja-JP')} 円 ＋ ${top.min.toLocaleString('ja-JP')} 円を超える分 × ${top.rate}%` }, table: t };
  }

  /** 表の種類ごとの、持っている版の効き始め（YYYY-MM）。 */
  private starts(key: (typeof YEARLY)[number]['key']): string[] {
    if (key === 'withholding') return this.book.withholding.map((w) => `${w.year}-01`);
    return (this.book[key] as { effectiveFrom: string }[]).map((t) => t.effectiveFrom.slice(0, 7));
  }

  /**
   * その月（YYYY-MM）に、毎年変わる表のうち更新されていないもの（H-8）。
   *
   * @remarks 表を 1 つも持たない種類は数えない（始まる前の制度など）
   */
  staleAt(month: string): StaleTable[] {
    const out: StaleTable[] = [];
    for (const y of YEARLY) {
      const starts = this.starts(y.key);
      if (starts.length === 0) continue;
      const yr = Number(month.slice(0, 4));
      const expected = `${Number(month.slice(5, 7)) >= y.month ? yr : yr - 1}-${String(y.month).padStart(2, '0')}`;
      if (!starts.some((s) => s >= expected)) out.push({ label: y.label, expectedFrom: expected });
    }
    return out;
  }

  /**
   * `from`〜`to`（YYYY-MM-DD）に効き始める表（仕様書 第30.18.1節）。協会けんぽは会社の都道府県の新旧の率を添える。
   */
  changesBetween(from: string, to: string, prefecture: string): LawChange[] {
    const out: LawChange[] = [];
    const inRange = (d: string) => d >= from && d <= to;
    const month = (ym: string) => `${Number(ym.slice(0, 4))} 年 ${Number(ym.slice(5, 7))} 月分`;
    for (const t of this.book.health) {
      const d = `${t.effectiveFrom}-01`;
      if (!inRange(d)) continue;
      const before = this.healthRate(prefecture, prevMonth(t.effectiveFrom));
      const now = t.prefectures[prefecture];
      out.push({ label: '協会けんぽの健康保険料率', date: d, applies: `${month(t.effectiveFrom)}の保険料から`,
        detail: prefecture && now !== undefined ? `${prefecture} ${before ? `${before.value}% → ` : ''}${now}%` : t.version });
    }
    for (const [label, list] of [['介護保険料率', this.book.care], ['子ども・子育て支援金率', this.book.childSupport], ['厚生年金保険料率', this.book.pension]] as const) {
      for (const t of list) {
        const d = `${t.effectiveFrom}-01`;
        if (!inRange(d)) continue;
        const before = latest(list.filter((x) => x !== t), prevMonth(t.effectiveFrom));
        out.push({ label, date: d, applies: `${month(t.effectiveFrom)}の保険料から`, detail: `${before ? `${before.rate}% → ` : ''}${t.rate}%` });
      }
    }
    for (const t of this.book.employment) {
      if (!inRange(t.effectiveFrom)) continue;
      out.push({ label: '雇用保険料率', date: t.effectiveFrom, applies: `${t.effectiveFrom.slice(0, 4)} 年 ${Number(t.effectiveFrom.slice(5, 7))} 月 ${Number(t.effectiveFrom.slice(8, 10))} 日から`, detail: `労働者負担 ${Math.round(t.general * 100000) / 100} / 1,000（一般の事業）` });
    }
    for (const w of this.book.withholding) {
      const d = `${w.year}-01-01`;
      if (inRange(d)) out.push({ label: '源泉徴収税額表（月額表）', date: d, applies: `${w.year} 年 1 月に支払う給与から`, detail: w.version });
    }
    // 社会保険と雇用保険の適用の決まり（第30.12.1節）。加入の判定が変わる
    for (const t of this.book.insurance) {
      if (!inRange(t.effectiveFrom) || t === this.book.insurance[0]) continue;
      out.push({ label: '社会保険と雇用保険の適用', date: t.effectiveFrom, applies: `${t.effectiveFrom.slice(0, 4)} 年 ${Number(t.effectiveFrom.slice(5, 7))} 月 ${Number(t.effectiveFrom.slice(8, 10))} 日から`, detail: `${t.version}。「社会保険」の加入の判定で確かめる` });
    }
    return out;
  }

  /**
   * 賞与に対する源泉徴収税額の算出率（%）。支払う日の年の表で引く。
   *
   * @param prevTaxable 前の月の給与の社会保険料等を引いた後の額
   * @returns 率と当てた行（根拠）。その年の表が無いか、当たる行が無ければ `null`
   */
  bonusRate(prevTaxable: number, column: 'ko' | 'otsu', dependents: number, payDate: string): LawHit<{ rate: number; row: string }> | null {
    const t: BonusRates | undefined = this.book.bonus.find((b) => b.year === Number(payDate.slice(0, 4)));
    if (!t) return null;
    const a = Math.max(0, Math.floor(prevTaxable));
    const col = Math.min(Math.max(0, Math.floor(dependents)), 7);
    const yen = (n: number) => n.toLocaleString('ja-JP');
    for (const r of t.rows) {
      const range = column === 'ko' ? r.ko[col] : r.otsu;
      if (!range) continue;
      if (a >= range[0] && (range[1] === null || a < range[1])) {
        const where = `${yen(range[0])} 円以上${range[1] === null ? '' : ` ${yen(range[1])} 円未満`}`;
        return { value: { rate: r.rate, row: column === 'ko' ? `甲欄（扶養親族等 ${col}${col === 7 ? ' 人以上' : ' 人'}）${where}` : `乙欄 ${where}` }, table: t };
      }
    }
    return null;
  }

  /** その年の年末調整の決まり（無ければ `null`）。 */
  yeaRules(year: number): YeaRules | null {
    return this.book.yea.find((r) => r.year === year) ?? null;
  }

  /** 社会保険と雇用保険の適用の決まり。その日（YYYY-MM-DD か YYYY-MM）に効いている版。 */
  insuranceRules(date: string): InsuranceRules | null {
    const key = date.length === 7 ? `${date}-01` : date;
    return latest(this.book.insurance, key);
  }

  /** 地域別最低賃金（円）。その日に効いている額。 */
  minimumWage(prefecture: string, date: string): LawHit<number> | null {
    for (const t of [...this.book.minimumWage].reverse() as MinimumWage[]) {
      const list = t.prefectures[prefecture];
      const hit = list ? [...list].filter((x) => x.from <= date).sort((x, y) => y.from.localeCompare(x.from))[0] : undefined;
      if (hit) return { value: hit.amount, table: t };
    }
    return null;
  }
}
