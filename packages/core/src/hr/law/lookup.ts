/**
 * @file 法令の表を使う日で引く（仕様書 第30.10.2節・H-8）。表が無い月は `null` を返し、計算を止めずに「表が未登録」と示させる。
 */

import type {
  EmploymentRates, GradeRow, GradeTable, HealthRates, LawBook, LawMeta, MinimumWage, RateTable, WithholdingMonthly,
} from './types.js';

/** 引いた値と、使った表の版。 */
export interface LawHit<T> {
  value: T;
  table: LawMeta;
}

/** 効き始めが `key` 以前で最も新しい表。 */
function latest<T extends { effectiveFrom: string }>(list: T[], key: string): T | null {
  return [...list].filter((t) => t.effectiveFrom <= key).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
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
