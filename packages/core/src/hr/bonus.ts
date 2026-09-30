/**
 * @file 賞与の計算（仕様書 第30.11.1節）。決まったプログラムで額を出し、行ごとに根拠を残す（H-1・H-4）。
 *
 * 社会保険料は標準賞与額（1,000 円未満切り捨て）に、支払った月の料率を掛ける。健康保険（介護・支援金を含む）は年度の累計 573 万円、
 * 厚生年金は 1 か月 150 万円が上限。源泉所得税は、前の月の給与の社会保険料等を引いた後の額から算出率の表で率を求める。
 * 前の月に給与が無いとき・賞与が前の月の給与の 10 倍を超えるときは、月額表を使う計算にする。住民税は引かない。副作用を持たない。
 */

import type { HrEmployee, HrPayrollProfile, HrSettings, HrTerms, PayAdjustment, PayLine } from '@m2office/shared';
import type { Law } from './law/lookup.js';
import type { LawMeta } from './law/types.js';
import { adjustmentLines, insuredIn, reachMonth, round50, type SlipResult } from './payroll.js';

/** 健康保険の標準賞与額の年度の累計の上限。 */
export const HEALTH_BONUS_CAP = 5_730_000;
/** 厚生年金の標準賞与額の 1 か月の上限。 */
export const PENSION_BONUS_CAP = 1_500_000;

/** 1 人分の賞与の計算の入力。 */
export interface BonusInput {
  employee: HrEmployee;
  terms: HrTerms | null;
  profile: HrPayrollProfile | null;
  settings: HrSettings;
  /** 賞与の額。 */
  amount: number;
  payDate: string;
  /** 賞与の計算期間が 6 か月を超えるか。 */
  longPeriod: boolean;
  /** 前の月に払った給与の社会保険料等を引いた後の額（払っていなければ `null`）。 */
  prevTaxable: number | null;
  /** 前の月に払った給与の源泉所得税（10 倍を超えるときの計算に使う）。 */
  prevTax: number;
  /** 同じ年度にすでに払った賞与の、健康保険の標準賞与額の累計。 */
  healthBonusSoFar: number;
  law: Law;
  adjustments?: PayAdjustment[];
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

/**
 * 1 人分の賞与を計算する（下書き）。
 */
export function calcBonus(input: BonusInput): SlipResult {
  const { employee: e, terms: t, profile: p, settings, law } = input;
  const lines: PayLine[] = [];
  const warnings: string[] = [];
  const tables = new Map<string, LawMeta>();
  const use = (m: LawMeta) => tables.set(m.version, m);
  const deduct = (code: string, label: string, amount: number, basis: PayLine['basis']) => { if (amount > 0) lines.push({ code, label, amount, kind: 'deduct', basis }); };
  const month = input.payDate.slice(0, 7);
  const amount = Math.max(0, Math.round(input.amount));
  lines.push({ code: 'bonus', label: '賞与', amount, kind: 'pay', basis: { 賞与の額: yen(amount) } });
  const adj = adjustmentLines(input.adjustments ?? []);
  lines.push(...adj.pays);
  const gross = lines.filter((l) => l.kind === 'pay').reduce((s, l) => s + l.amount, 0);

  // 社会保険料（支払った月の保険料。資格を失う月の賞与にはかけない）
  let social = 0;
  let stdHealth = 0;
  let stdPension = 0;
  const socialOn = !!t?.socialInsurance && e.category !== 'owner' && settings.socialApply !== 'none' && settings.health.kind !== 'none';
  if (socialOn && insuredIn(e, month)) {
    const std = Math.floor(amount / 1000) * 1000;
    // 75 歳の誕生日の月から後期高齢者医療（健康保険の分をかけない。第30.12.1節）
    const healthOn = !e.birthDate || month < `${Number(e.birthDate.slice(0, 4)) + 75}-${e.birthDate.slice(5, 7)}`;
    stdHealth = healthOn ? Math.max(0, Math.min(std, HEALTH_BONUS_CAP - input.healthBonusSoFar)) : 0;
    if (!healthOn) warnings.push('75 歳に達したため、健康保険料・介護保険料・子ども・子育て支援金をかけません（後期高齢者医療）');
    const capNote = stdHealth < std ? `（年度の累計 ${yen(HEALTH_BONUS_CAP)} の上限まで。これまで ${yen(input.healthBonusSoFar)}）` : '';
    const careOn = !!e.birthDate && month >= reachMonth(e.birthDate, 40) && month < reachMonth(e.birthDate, 65);
    const kumiai = settings.health.kind === 'kumiai';
    const pr = settings.payroll;
    const h = kumiai ? (pr.kumiai.health !== null ? { value: pr.kumiai.health, table: null } : null) : settings.health.kind === 'kyokai' ? law.healthRate(settings.health.prefecture, month) : null;
    const c = careOn ? (kumiai ? (pr.kumiai.care !== null ? { value: pr.kumiai.care, table: null } : null) : law.careRate(month)) : { value: 0, table: null };
    if (!healthOn) {
      // 健康保険の被保険者でない
    } else if (h && c) {
      if (h.table) use(h.table);
      if (c.table) use(c.table);
      const rate = Math.round((h.value + c.value) * 1000) / 1000;
      const v = round50((stdHealth * rate) / 100 / 2);
      deduct('health', careOn ? '健康保険料（介護を含む）' : '健康保険料', v, {
        標準賞与額: `${yen(stdHealth)}${capNote}`, 料率: `${rate}%（健康保険 ${h.value}%${careOn ? `・介護 ${c.value}%` : ''}）`, 保険料の月: month, 本人負担: '料率の半分', 端数: '50 銭以下切り捨て',
        ...(h.table ? { 表: h.table.version } : { 表: '健康保険組合の料率（会社の設定）' }),
      });
      social += v;
    } else {
      warnings.push('健康保険の料率が分かりません（表が未登録か、組合の料率が未設定）');
    }
    const cs = healthOn ? law.childSupportRate(month) : null;
    if (cs) {
      use(cs.table);
      const v = round50((stdHealth * cs.value) / 100 / 2);
      deduct('child', '子ども・子育て支援金', v, { 標準賞与額: yen(stdHealth), 支援金率: `${cs.value}%`, 端数: '50 銭以下切り捨て', 表: cs.table.version });
      social += v;
    }
    const pensionOn = !e.birthDate || month < reachMonth(e.birthDate, 70);
    const ps = pensionOn ? law.pensionRate(month) : null;
    if (ps) {
      use(ps.table);
      stdPension = Math.min(std, PENSION_BONUS_CAP);
      const v = round50((stdPension * ps.value) / 100 / 2);
      deduct('pension', '厚生年金保険料', v, { 標準賞与額: `${yen(stdPension)}${stdPension < std ? `（1 か月 ${yen(PENSION_BONUS_CAP)} の上限）` : ''}`, 料率: `${ps.value}%`, 端数: '50 銭以下切り捨て', 表: ps.table.version });
      social += v;
    } else if (pensionOn) {
      warnings.push('厚生年金の料率の表が未登録です');
    }
  } else if (socialOn) {
    warnings.push('資格を失う月か、資格を取る前の月の賞与のため、社会保険料をかけません');
  }

  // 雇用保険料（賞与の額 × 労働者負担の率）
  let employment = 0;
  if (t?.employmentInsurance && e.category === 'employee') {
    const r = law.employmentRate(settings.labor.business, input.payDate);
    if (r) {
      use(r.table);
      const wages = gross - adj.notInsurable;
      employment = round50(wages * r.value);
      deduct('employment', '雇用保険料', employment, { 賃金の総額: yen(wages), 労働者負担: `${Math.round(r.value * 100000) / 100} / 1,000`, 端数: '50 銭以下切り捨て', 表: r.table.version });
    } else {
      warnings.push('雇用保険料率の表が未登録です');
    }
  }

  // 源泉所得税
  const base = Math.max(0, gross - adj.notTaxable - social - employment);
  const column = p?.taxColumn ?? 'ko';
  const dependents = p?.dependents ?? 0;
  const prev = input.prevTaxable;
  const special = prev === null || prev <= 0 || base > prev * 10;
  if (special) {
    // 算出率の表によらず月額表を使う（国税庁 タックスアンサー No.2523）。÷6 か ÷12 の結果は 1 円未満を切り捨てる
    const div = input.longPeriod ? 12 : 6;
    const noPrev = prev === null || prev <= 0;
    const part = Math.floor(base / div);
    const w = law.withholding(noPrev ? part : part + prev, column, dependents, input.payDate);
    if (w) {
      use(w.table);
      const each = noPrev ? w.value.tax : Math.max(0, w.value.tax - input.prevTax);
      lines.push({ code: 'income-tax', label: '所得税', amount: each * div, kind: 'deduct', basis: noPrev ? {
        計算: '前の月に給与が無いため、月額表を使う', '社会保険料等を引いた後の賞与': yen(base), [`÷ ${div}`]: yen(part),
        欄: column === 'ko' ? `甲欄（扶養親族等 ${dependents} 人）` : '乙欄', 行: w.value.row, 税額: `${yen(w.value.tax)} × ${div}`, 表: w.table.version,
      } : {
        計算: '賞与が前の月の給与の 10 倍を超えるため、月額表を使う', '社会保険料等を引いた後の賞与': yen(base), [`÷ ${div}`]: yen(part),
        前の月の給与: `${yen(prev)}（社会保険料等を引いた後）`, 月額表に当てる額: yen(part + prev), 欄: column === 'ko' ? `甲欄（扶養親族等 ${dependents} 人）` : '乙欄',
        行: w.value.row, 税額: `（${yen(w.value.tax)} − 前の月の税額 ${yen(input.prevTax)}）× ${div}`, 表: w.table.version,
      } });
      warnings.push(noPrev ? '前の月に給与が無いため、月額表で所得税を計算しました' : '賞与が前の月の給与の 10 倍を超えるため、月額表で所得税を計算しました');
    } else {
      warnings.push(`${input.payDate.slice(0, 4)} 年の源泉徴収税額表が未登録です`);
    }
  } else {
    const r = law.bonusRate(prev, column, dependents, input.payDate);
    if (r) {
      use(r.table);
      lines.push({ code: 'income-tax', label: '所得税', amount: Math.floor((base * r.value.rate) / 100), kind: 'deduct', basis: {
        前の月の給与: `${yen(prev)}（社会保険料等を引いた後）`, 率: `${r.value.rate}%`, 行: r.value.row, '社会保険料等を引いた後の賞与': yen(base), 端数: '1 円未満切り捨て', 表: r.table.version,
      } });
    } else {
      warnings.push(`${input.payDate.slice(0, 4)} 年の賞与に対する源泉徴収税額の算出率の表が未登録です`);
    }
  }
  if (!p) warnings.push('税の区分（甲欄・乙欄）と扶養の数が未登録のため、甲欄・扶養 0 人で計算しました');
  lines.push(...adj.deducts);

  const deductions = lines.filter((l) => l.kind === 'deduct').reduce((s, l) => s + l.amount, 0);
  for (const m of tables.values()) if (m.review.status !== 'verified') { warnings.push('法令の表が監修前です（確定には使えません）'); break; }
  const tax = lines.find((l) => l.code === 'income-tax')?.amount ?? 0;
  return { gross, deductions, net: gross - deductions, lines, warnings, tables: [...tables.values()], meta: {
    taxable: base, stdBonusHealth: stdHealth, stdBonusPension: stdPension, taxablePay: gross - adj.notTaxable, social: social + employment, tax,
  } };
}
