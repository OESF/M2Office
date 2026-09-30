/**
 * @file 年末調整の計算（仕様書 第30.15.1節）。決まったプログラムで年税額と過不足を出し、計算の順に根拠を残す（H-1・H-4）。
 *
 * 手順は国税庁「令和8年分 年末調整のしかた」による: 給与所得控除後の給与等の金額 → 所得金額調整控除 → 所得控除 →
 * 課税給与所得金額（1,000 円未満切り捨て）→ 算出所得税額（速算表）→ 住宅借入金等特別控除 → 年調年税額（× 102.1%。100 円未満切り捨て）→ 過不足。
 * 年齢は 12 月 31 日で判定する（年齢に達するのは誕生日の前の日）。控除額と要件は法令の表（その年の版）から引く。副作用を持たない。
 */

import type { HrEmployee, YeaDeclaration, YeaPerson, YeaResult } from '@m2office/shared';
import type { Law } from './law/lookup.js';
import type { StepFormula, YeaRules } from './law/types.js';

/** 1 人分の年末調整の入力。 */
export interface YeaInput {
  law: Law;
  year: number;
  employee: HrEmployee;
  declaration: YeaDeclaration;
  /** この会社が支払った課税の給与と賞与の額。 */
  payHere: number;
  /** この会社が給与から差し引いた社会保険料等。 */
  socialHere: number;
  /** この会社が源泉徴収した所得税。 */
  withheldHere: number;
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;

/** 段階の式を当てる（1 円未満は切り上げ）。 */
export function stepFormula(f: StepFormula, amount: number): number {
  if (amount <= 0) return 0;
  for (const [max, rate, add] of f) {
    if (max === null) return add;
    if (amount <= max) return Math.ceil(amount * rate + add);
  }
  return 0;
}

/** 給与所得控除後の給与等の金額（所得金額調整控除の前）。 */
export function employmentIncome(r: YeaRules, pay: number): number {
  if (pay < r.employment.zeroBelow) return 0;
  if (pay < r.employment.linearBelow) return pay - r.employment.linearMinus;
  const row = r.employmentTable.find(([min, max]) => pay >= min && pay < max);
  if (row) return row[2];
  const band = r.employment.over.find((b) => pay >= b.min && (b.max === null || pay < b.max));
  return band ? Math.floor(pay * band.rate - band.minus) : 0;
}

/** 生年月日の境目（その年の 12 月 31 日に何歳以上か。年齢に達するのは誕生日の前の日）。 */
const bornOnOrBefore = (year: number, age: number) => `${year - age + 1}-01-01`;
/** 12 月 31 日に `age` 歳以上か。 */
export const ageAtLeast = (birth: string | null, year: number, age: number) => !!birth && birth <= bornOnOrBefore(year, age);

/** 親族の区分（扶養控除・特定親族・年少）。 */
type Kind = 'under16' | 'general' | 'specific' | 'elderly' | 'elderly-cohabiting' | 'specific-relative' | 'none';

function kindOf(r: YeaRules, year: number, p: YeaPerson): Kind {
  const b = p.birthDate;
  if (p.incomeEstimate <= r.dependents.incomeMax) {
    if (!ageAtLeast(b, year, 16)) return b ? 'under16' : 'general';
    if (ageAtLeast(b, year, 70)) return p.cohabiting && /父|母|祖/.test(p.relation) ? 'elderly-cohabiting' : 'elderly';
    if (ageAtLeast(b, year, 19) && !ageAtLeast(b, year, 23)) return 'specific';
    return 'general';
  }
  const max = r.specificRelative.at(-1)?.max ?? 0;
  if (p.incomeEstimate <= max && ageAtLeast(b, year, 19) && !ageAtLeast(b, year, 23)) return 'specific-relative';
  return 'none';
}

/**
 * 1 人分の年末調整を計算する。
 *
 * @returns 結果と注意。その年の表が無い・対象外の額なら理由
 */
export function calcYea(input: YeaInput): { result: YeaResult; warnings: string[] } | { error: string } {
  const r = input.law.yeaRules(input.year);
  if (!r) return { error: `${input.year} 年分の年末調整の表が未登録です` };
  const d = input.declaration;
  const year = input.year;
  const warnings: string[] = [];
  const basis: [string, string][] = [];
  const prev = d.previousJob ?? { pay: 0, social: 0, tax: 0 };
  const pay = input.payHere + prev.pay;
  if (pay > r.payLimit) return { error: `給与が ${yen(r.payLimit)} を超えるため、年末調整の対象外です` };
  basis.push(['支払金額', `${yen(pay)}${prev.pay ? `（前の勤め先 ${yen(prev.pay)} を含む）` : ''}`]);

  // 23 歳未満の扶養親族（16 歳未満を含む）と特別障害者
  const deps = d.dependents.map((p) => ({ p, kind: kindOf(r, year, p) }));
  const dependentsOnly = deps.filter((x) => x.kind !== 'none' && x.kind !== 'specific-relative');
  const under23 = dependentsOnly.some((x) => x.p.birthDate && !ageAtLeast(x.p.birthDate, year, 23));
  const spouseSame = d.spouse && d.spouse.incomeEstimate <= r.spouse.incomeMax;
  const specialDisabled = d.self.disability === 'special' || dependentsOnly.some((x) => x.p.disability === 'special' || x.p.disability === 'special-cohabiting')
    || (!!spouseSame && (d.spouse!.disability === 'special' || d.spouse!.disability === 'special-cohabiting'));

  // 給与所得控除後の給与等の金額と所得金額調整控除
  const employment = employmentIncome(r, pay);
  const ia = r.incomeAdjustment;
  const incomeAdjustment = pay > ia.payOver && (under23 || specialDisabled) ? Math.min(ia.max, Math.ceil((Math.min(pay, ia.payCap) - ia.payOver) * ia.rate)) : 0;
  const afterDeduction = Math.max(0, employment - incomeAdjustment);
  basis.push(['給与所得控除後の給与等の金額', `${yen(employment)}${incomeAdjustment ? `・所得金額調整控除 ${yen(incomeAdjustment)} を引いて ${yen(afterDeduction)}` : ''}`]);
  const selfIncome = afterDeduction + d.self.otherIncome;

  // 保険料
  const social = input.socialHere + prev.social + d.insurance.social;
  const small = d.insurance.smallBusiness;
  const L = r.life;
  const ins = d.insurance;
  const fNew = stepFormula(under23 ? L.formulaII : L.formulaI, ins.lifeNewGeneral);
  const fOld = stepFormula(L.formulaIII, ins.lifeOldGeneral);
  const general = Math.max(fNew, fOld, Math.min(fNew + fOld, under23 ? L.generalMaxSpecial : L.generalMax));
  const care = stepFormula(L.formulaI, ins.lifeNewCare);
  const pNew = stepFormula(L.formulaI, ins.lifeNewPension);
  const pOld = stepFormula(L.formulaIII, ins.lifeOldPension);
  const pension = Math.max(pNew, pOld, Math.min(pNew + pOld, L.pensionMax));
  const life = Math.min(L.totalMax, general + care + pension);
  const earthquake = Math.min(r.earthquake.max, Math.min(ins.earthquake, r.earthquake.max) + stepFormula(r.earthquake.oldLongTerm, ins.oldLongTerm));

  // 配偶者控除・配偶者特別控除（本人の合計所得金額の段ごと）
  const col = r.spouse.selfBands.findIndex((b) => selfIncome <= b);
  let spouseDeduction = 0;
  let spouseSpecial = 0;
  let spouseKind: YeaResult['counts']['spouse'] = 'none';
  if (d.spouse && col >= 0) {
    const s = d.spouse;
    if (s.incomeEstimate <= r.spouse.incomeMax) {
      const elderly = ageAtLeast(s.birthDate, year, 70);
      spouseDeduction = (elderly ? r.spouse.elderly : r.spouse.general)[col] ?? 0;
      spouseKind = elderly ? 'elderly' : 'general';
    } else {
      const band = r.spouse.special.find((b) => s.incomeEstimate > b.min && s.incomeEstimate <= b.max);
      spouseSpecial = band?.amounts[col] ?? 0;
      if (spouseSpecial) spouseKind = 'special';
    }
  } else if (d.spouse) {
    warnings.push('本人の合計所得金額が 1,000 万円を超えるため、配偶者控除・配偶者特別控除は受けられません');
  }

  // 扶養控除・特定親族特別控除・障害者控除
  const counts: YeaResult['counts'] = { spouse: spouseKind, specific: 0, elderly: 0, elderlyCohabiting: 0, general: 0, under16: 0, disabilityGeneral: 0, disabilitySpecial: 0, disabilitySpecialCohabiting: 0, specificRelative: 0 };
  let dependents = 0;
  let specificRelative = 0;
  let disability = 0;
  const addDisability = (p: YeaPerson) => {
    if (p.disability === 'general') { disability += r.disability.general; counts.disabilityGeneral++; }
    if (p.disability === 'special') { disability += r.disability.special; counts.disabilitySpecial++; }
    if (p.disability === 'special-cohabiting') { disability += r.disability.specialCohabiting; counts.disabilitySpecial++; counts.disabilitySpecialCohabiting++; }
  };
  for (const { p, kind } of deps) {
    if (kind === 'none') continue;
    if (kind === 'specific-relative') {
      specificRelative += r.specificRelative.find((b) => p.incomeEstimate > b.min && p.incomeEstimate <= b.max)?.amount ?? 0;
      counts.specificRelative++;
      continue;
    }
    if (kind === 'under16') counts.under16++;
    if (kind === 'general') { dependents += r.dependents.general; counts.general++; }
    if (kind === 'specific') { dependents += r.dependents.specific; counts.specific++; }
    if (kind === 'elderly') { dependents += r.dependents.elderly; counts.elderly++; }
    if (kind === 'elderly-cohabiting') { dependents += r.dependents.elderlyCohabiting; counts.elderly++; counts.elderlyCohabiting++; }
    addDisability(p);
  }
  if (spouseSame) addDisability(d.spouse!);

  // 本人の障害者・寡婦・ひとり親・勤労学生
  if (d.self.disability === 'general') disability += r.disability.general;
  if (d.self.disability === 'special') disability += r.disability.special;
  let widow = 0;
  if (d.self.widow !== 'none') {
    if (selfIncome <= r.singleParentIncomeMax) widow = d.self.widow === 'widow' ? r.widow : r.singleParent;
    else warnings.push('寡婦・ひとり親は合計所得金額 500 万円以下が要件のため、控除しません');
  }
  let student = 0;
  if (d.self.workingStudent) {
    if (selfIncome <= r.workingStudentIncomeMax) student = r.workingStudent;
    else warnings.push(`勤労学生は合計所得金額 ${yen(r.workingStudentIncomeMax)} 以下が要件のため、控除しません`);
  }

  const basic = r.basic.find((b) => b.max === null || selfIncome <= b.max)?.amount ?? 0;
  const deductions = { social, smallBusiness: small, life, earthquake, spouse: spouseDeduction, spouseSpecial, dependents, specificRelative, basic, disability, widow, student };
  const deductionTotal = Object.values(deductions).reduce((a, b) => a + b, 0);
  basis.push(['所得控除の合計', `${yen(deductionTotal)}（社会保険料等 ${yen(social + small)}・生命保険料 ${yen(life)}・地震保険料 ${yen(earthquake)}・配偶者 ${yen(spouseDeduction + spouseSpecial)}・扶養 ${yen(dependents)}・特定親族 ${yen(specificRelative)}・障害者等 ${yen(disability + widow + student)}・基礎 ${yen(basic)}）`]);

  // 課税給与所得金額と税額
  const taxable = Math.max(0, Math.floor((afterDeduction - deductionTotal) / 1000) * 1000);
  if (taxable > r.taxableLimit) return { error: `課税給与所得金額が ${yen(r.taxableLimit)} を超えるため、年末調整の対象外です` };
  const band = r.rates.find((b) => taxable <= b.max) ?? r.rates.at(-1)!;
  const calculatedTax = Math.max(0, Math.round(taxable * band.rate - band.deduction));
  const housingCredit = Math.min(d.housingCredit, calculatedTax);
  const annualTax = Math.floor(((calculatedTax - housingCredit) * r.surtax) / 100) * 100;
  const withheld = input.withheldHere + prev.tax;
  basis.push(['課税給与所得金額', `${yen(taxable)}（1,000 円未満切り捨て）`]);
  basis.push(['算出所得税額', `${yen(calculatedTax)}（${yen(taxable)} × ${Math.round(band.rate * 100)}% − ${yen(band.deduction)}）`]);
  if (d.housingCredit) basis.push(['住宅借入金等特別控除', `${yen(housingCredit)}${housingCredit < d.housingCredit ? `（控除しきれない ${yen(d.housingCredit - housingCredit)} は源泉徴収票の控除可能額）` : ''}`]);
  basis.push(['年調年税額', `${yen(annualTax)}（× ${r.surtax}。100 円未満切り捨て）`]);
  basis.push(['源泉徴収した額', `${yen(withheld)}${prev.tax ? `（前の勤め先 ${yen(prev.tax)} を含む）` : ''}`]);
  const difference = withheld - annualTax;
  basis.push(['過不足', difference >= 0 ? `還付 ${yen(difference)}` : `不足 ${yen(-difference)}`]);
  basis.push(['表', r.version]);

  return {
    result: {
      year, pay, payHere: input.payHere, payPrevious: prev.pay, afterDeduction, incomeAdjustment, deductions, deductionTotal, taxable, calculatedTax,
      housingCredit, annualTax, withheld, difference, counts, basis,
    },
    warnings,
  };
}

/**
 * 申告の不備（決まったプログラムで示す）。止めはしない。
 *
 * @param payHere その年にこの会社が払った給与（年の途中なら、ここまでの額）
 */
export function declarationProblems(law: Law, year: number, employee: HrEmployee, d: YeaDeclaration, payHere: number): string[] {
  const r = law.yeaRules(year);
  if (!r) return [`${year} 年分の年末調整の表が未登録です`];
  const out: string[] = [];
  const selfIncome = employmentIncome(r, payHere + (d.previousJob?.pay ?? 0)) + d.self.otherIncome;
  const spMax = r.spouse.special.at(-1)?.max ?? 0;
  if (d.spouse && d.spouse.incomeEstimate > spMax) out.push(`配偶者の所得の見積もりが ${yen(spMax)} を超えるため、配偶者控除・配偶者特別控除は受けられません`);
  if (d.spouse && selfIncome > (r.spouse.selfBands.at(-1) ?? 0)) out.push('本人の合計所得金額の見積もりが 1,000 万円を超えるため、配偶者控除・配偶者特別控除は受けられません');
  for (const p of d.dependents) {
    if (!p.birthDate) out.push(`${p.name}さんの生年月日が無いため、年齢で決まる控除を判定できません`);
    else if (kindOf(r, year, p) === 'none') out.push(`${p.name}さんの所得の見積もりが ${yen(r.dependents.incomeMax)} を超えるため、扶養控除の対象になりません`);
  }
  if (employee.hiredOn && employee.hiredOn > `${year}-01-01` && employee.hiredOn <= `${year}-12-31` && !d.previousJob) {
    out.push('今年の途中で入社しています。前の勤め先から給与をもらっていれば、その源泉徴収票の額を入れてください');
  }
  if (d.self.widow !== 'none' && selfIncome > r.singleParentIncomeMax) out.push('寡婦・ひとり親は合計所得金額 500 万円以下が要件です');
  if (d.self.workingStudent && selfIncome > r.workingStudentIncomeMax) out.push(`勤労学生は合計所得金額 ${yen(r.workingStudentIncomeMax)} 以下が要件です`);
  return out;
}
