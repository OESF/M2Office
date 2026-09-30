/**
 * @file 労働保険の年度更新の計算（仕様書 第30.13.1節）。決まったプログラムで行う（H-1）。
 *
 * 確定した給与の明細から、前年度（4 月〜3 月）の労災保険の対象と雇用保険の対象の賃金と人数を月ごとに集め、
 * 確定保険料・一般拠出金・概算保険料・申告済の概算保険料との差・延納の期別の額を出す。率は法令の表で引く。副作用を持たない。
 *
 * 端数（厚生労働省「令和8年度 労働保険年度更新申告書の書き方」）: 賃金の総額は 1,000 円未満切り捨て、保険料は 1 円未満切り捨て。
 * 労災と雇用保険の算定基礎額が同じなら、合わせた率で 1 回だけ計算する。延納の 1 円未満の端数と、確定の不足額・一般拠出金は第 1 期に入れる。
 */

import type {
  HrEmployee, HrLaborSettings, HrTerms, LaborInsuranceData, LaborInsuranceResult, LaborLine, LaborMonth, LaborPremium, PaySlip,
} from '@m2office/shared';
import type { Law } from './law/lookup.js';
import { nextBusinessDay } from './calendar.js';

/** 集計に使う、確定した明細と回の要点。 */
export interface LaborSlip {
  slip: PaySlip;
  run: { kind: string; payDate: string; periodEnd: string };
}

/** 集計の入力。 */
export interface LaborInput {
  law: Law;
  /** 年度更新の年（申告する年）。 */
  year: number;
  settings: HrLaborSettings;
  employees: Map<string, HrEmployee>;
  /** その日の雇用条件。 */
  termsAt: (employeeId: string, date: string) => HrTerms | null;
  /** 確定期間に確定した月の給与・賞与・訂正の回の明細。 */
  slips: LaborSlip[];
  /** 会社で月の給与を確定した月（締めの月 YYYY-MM）。 */
  confirmedMonths: Set<string>;
  data: LaborInsuranceData;
}

/** 1,000 分の率を掛けて 1 円未満を切り捨てる（小数の誤差を丸めてから切り捨てる）。 */
export function perMille(baseThousand: number, rate: number): number {
  return Math.floor(Math.round(baseThousand * rate * 1000) / 1000);
}

/** 1,000 円未満を切り捨てた、千円単位の額。 */
export const thousands = (yen: number) => Math.floor(Math.max(0, yen) / 1000);

/** 年度の 12 か月（YYYY-MM）。 */
export function fiscalMonths(startYear: number): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m = 4 + i;
    return m <= 12 ? `${startYear}-${String(m).padStart(2, '0')}` : `${startYear + 1}-${String(m - 12).padStart(2, '0')}`;
  });
}

/** 雇用保険の賃金に入れない額（調整の行のうち、支給で「入れない」もの・控除で「入れる」もの）。 */
function notInsurable(slip: PaySlip): number {
  return slip.lines.filter((l) => l.code.startsWith('adjust:')).reduce((s, l) => s + (l.kind === 'pay' ? (l.basis['雇用保険'] === '入れない' ? l.amount : 0) : (l.basis['雇用保険'] === '賃金に入れる' ? l.amount : 0)), 0);
}

/** 労働保険の賃金（支給の合計から、臨時の恩恵的なものとして外した調整の行を除く）。 */
export function laborWage(slip: PaySlip): number {
  return slip.gross - notInsurable(slip);
}

/**
 * 月ごと（と賞与ごと）の労災保険の対象・雇用保険の対象の人数と賃金。月の給与と訂正の回は締めの月、賞与は支払った日に入れる。
 * 役員・同居の親族は労災保険の対象に入れない（役員で労働者扱いの人は、会社で確かめて足す）。
 */
export function laborMonths(input: LaborInput): LaborMonth[] {
  const months = fiscalMonths(input.year - 1);
  const out: LaborMonth[] = [];
  const classify = (s: LaborSlip) => {
    const e = input.employees.get(s.slip.employeeId);
    const worker = e?.category === 'employee';
    const insured = worker && !!input.termsAt(s.slip.employeeId, s.run.periodEnd || s.run.payDate)?.employmentInsurance;
    return { worker, insured, wage: laborWage(s.slip) };
  };
  for (const m of months) {
    const manual = input.data.supplements[m];
    if (!input.confirmedMonths.has(m)) {
      out.push(manual ? { key: m, kind: 'month', source: 'manual', ...manual } : { key: m, kind: 'month', source: 'missing', workers: 0, wages: 0, insured: 0, insuredWages: 0 });
      continue;
    }
    const row: LaborMonth = { key: m, kind: 'month', source: 'm2office', workers: 0, wages: 0, insured: 0, insuredWages: 0 };
    for (const s of input.slips.filter((x) => (x.run.kind === 'monthly' || x.run.kind === 'correction') && x.run.periodEnd.slice(0, 7) === m)) {
      const c = classify(s);
      if (!c.worker) continue;
      row.wages += c.wage;
      if (c.insured) row.insuredWages += c.wage;
      // 人数は月の給与の明細の人（締め日に在籍している人）で数える
      if (s.run.kind === 'monthly') {
        const e = input.employees.get(s.slip.employeeId);
        if (!e?.leftOn || e.leftOn >= s.run.periodEnd) { row.workers++; if (c.insured) row.insured++; }
      }
    }
    out.push(row);
  }
  const from = `${input.year - 1}-04-01`;
  const to = `${input.year}-03-31`;
  const bonusDates = [...new Set(input.slips.filter((s) => s.run.kind === 'bonus' && s.run.payDate >= from && s.run.payDate <= to).map((s) => s.run.payDate))].sort();
  for (const d of bonusDates) {
    const row: LaborMonth = { key: d, kind: 'bonus', source: 'm2office', workers: 0, wages: 0, insured: 0, insuredWages: 0 };
    for (const s of input.slips.filter((x) => x.run.kind === 'bonus' && x.run.payDate === d)) {
      const c = classify(s);
      if (!c.worker) continue;
      row.wages += c.wage;
      if (c.insured) row.insuredWages += c.wage;
    }
    out.push(row);
  }
  return out;
}

/** 算定基礎額と率から保険料の行を作る。 */
const line = (baseThousand: number, rate: number): LaborLine => ({ base: baseThousand * 1000, rate, amount: perMille(baseThousand, rate) });

/** 労災と雇用保険の保険料（算定基礎額が同じなら合わせた率で 1 回だけ計算する）。 */
export function premium(wagesK: number, insuredK: number, workersCompRate: number, employmentRate: number): LaborPremium {
  const workersComp = line(wagesK, workersCompRate);
  const employment = line(insuredK, employmentRate);
  const total = wagesK === insuredK ? perMille(wagesK, Math.round((workersCompRate + employmentRate) * 1000) / 1000) : workersComp.amount + employment.amount;
  return { workersComp, employment, total };
}

/**
 * 延納の期別の額（第 1 期に 1 円未満の端数・確定の不足額・一般拠出金を入れ、超過額は第 1 期から充当する）。
 *
 * @returns 期ごとの納める額と、充当しきれずに還付を請求する額
 */
export function installments(year: number, estimate: number, shortage: number, surplus: number, general: number, split: boolean): { list: { due: string; amount: number }[]; refund: number } {
  const dues = [nextBusinessDay(`${year}-07-10`), nextBusinessDay(`${year}-10-31`), nextBusinessDay(`${year + 1}-01-31`)];
  const parts = split ? [estimate - 2 * Math.floor(estimate / 3), Math.floor(estimate / 3), Math.floor(estimate / 3)] : [estimate];
  parts[0] = parts[0]! + shortage + general;
  let left = surplus;
  const list = parts.map((p, i) => {
    const use = Math.min(left, p);
    left -= use;
    return { due: dues[i]!, amount: p - use };
  });
  return { list, refund: left };
}

/**
 * 年度更新の計算。足りない月があれば `null`。
 *
 * @returns 確定保険料・一般拠出金・概算保険料・差・延納・常時使用労働者数と被保険者数と、使った表
 */
export function laborCalc(input: LaborInput, months: LaborMonth[]): { result: LaborInsuranceResult; tables: { version: string; reviewed: boolean }[]; notes: string[] } | { error: string } {
  const { law, year, settings, data } = input;
  if (months.some((m) => m.source === 'missing')) return { error: 'M2Office で給与を確定していない月があります。その月の合計を入れてください' };
  const confirmedDate = `${year - 1}-04-01`;
  const estimateDate = `${year}-04-01`;
  const wc = law.workersComp(confirmedDate);
  const wcNext = law.workersComp(estimateDate);
  const em = law.employmentTable(confirmedDate);
  const emNext = law.employmentTable(estimateDate);
  if (!wc || !wcNext || !em || !emNext) return { error: `${year} 年度の年度更新に使う労災保険率か雇用保険料率の表がありません` };
  const industry = wc.rows.find((r) => r.code === settings.industry);
  const industryNext = wcNext.rows.find((r) => r.code === settings.industry);
  if (!industry || !industryNext) return { error: `労災保険の事業の種類（${settings.industry}）が労災保険率表にありません。会社の設定で選んでください` };
  const notes: string[] = [];
  // 今年度の雇用保険料率の表がまだ無ければ、前の年度の率で概算を出したことを示す（表の更新待ち。第30.18.1節）
  if (emNext.effectiveFrom < estimateDate) notes.push(`${year} 年度の雇用保険料率の表がまだ無いため、${emNext.version}の率で概算保険料を出しました`);
  const sum = (k: 'wages' | 'insuredWages') => months.reduce((s, m) => s + m[k], 0);
  const wagesK = thousands(sum('wages'));
  const insuredK = thousands(sum('insuredWages'));
  const confirmed = premium(wagesK, insuredK, industry.rate, em.totalPerMille[settings.business]);
  const generalContribution = line(wagesK, wc.generalContribution);
  // 概算: 見込みが前年度の 2 分の 1 以上 2 倍以下なら前年度の額（労災と雇用保険それぞれで判定する）
  const within = (next: number, prev: number) => next >= prev / 2 && next <= prev * 2;
  const est = data.estimateWages;
  const nextWagesK = est && !within(est.wages, sum('wages')) ? thousands(est.wages) : wagesK;
  const nextInsuredK = est && !within(est.insuredWages, sum('insuredWages')) ? thousands(est.insuredWages) : insuredK;
  if (nextWagesK !== wagesK || nextInsuredK !== insuredK) notes.push('今年度の賃金の見込みが前年度の 2 分の 1 未満か 2 倍を超えるため、見込みの額で概算保険料を出しました');
  const estimate = premium(nextWagesK, nextInsuredK, industryNext.rate, emNext.totalPerMille[settings.business]);
  const declared = data.declaredEstimate;
  if (declared === null) notes.push('前の年に申告した概算保険料が分からないため、差（不足・充当）を出していません');
  const shortage = declared === null ? 0 : Math.max(0, confirmed.total - declared);
  const surplus = declared === null ? 0 : Math.max(0, declared - confirmed.total);
  // 延納: 概算保険料が 40 万円以上（労災か雇用保険の一方だけなら 20 万円以上）
  const oneSided = nextInsuredK === 0 || nextWagesK === 0;
  const split = estimate.total >= (oneSided ? 200000 : 400000);
  const inst = installments(year, estimate.total, shortage, surplus, generalContribution.amount, split);
  if (inst.refund > 0) notes.push(`充当しきれない ${inst.refund.toLocaleString('ja-JP')} 円は、還付を請求します`);
  // 常時使用労働者数・被保険者数は、月末の人数の合計 ÷ 12（1 人未満切り捨て、0 人なら 1 人）
  const monthRows = months.filter((m) => m.kind === 'month');
  const avg = (k: 'workers' | 'insured') => Math.max(1, Math.floor(monthRows.reduce((s, m) => s + m[k], 0) / 12));
  const tables = [wc, wcNext, em, emNext].filter((t, i, a) => a.findIndex((x) => x.version === t.version) === i).map((t) => ({ version: t.version, reviewed: t.review.status === 'verified' }));
  return {
    result: {
      year, confirmed, generalContribution, estimate, declaredEstimate: declared, shortage, surplus, refund: inst.refund, installments: inst.list,
      workers: avg('workers'), insured: insuredK > 0 ? avg('insured') : 0, industry: { code: industry.code, name: industry.name },
    },
    tables, notes,
  };
}
