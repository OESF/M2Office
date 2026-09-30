/**
 * @file 社会保険の定時決定・随時改定・資格の取得と喪失・年齢の到達・加入の判定（仕様書 第30.12.1節）。決まったプログラムで行う（H-1）。
 *
 * 報酬と支払基礎日数は、確定した月の給与の明細から支払った月ごとに求める。等級は法令の表（標準報酬月額の等級表）で引き、
 * 日数の要件・短時間労働者の要件・雇用保険の要件は法令の表（社会保険の適用の決まり）の施行日で切り替える。副作用を持たない。
 */

import type {
  HrEmployee, HrInsuranceSettings, HrPayrollProfile, HrStandardPay, HrTerms, InsuranceEligibility, PaySlip, SocialDetermination, SocialEvent, SocialGrade, SocialMonth,
} from '@m2office/shared';
import type { Law } from './law/lookup.js';
import type { InsuranceRules } from './law/types.js';
import { addDays } from './procedures.js';
import { reachMonth, shiftMonth } from './payroll.js';

/** 支払った明細と、その回の要点。 */
export interface PaidSlip {
  slip: PaySlip;
  run: { kind: string; payMonth: string; payDate: string; periodStart: string; periodEnd: string };
}

/** 明細から読んだ固定的賃金（基本給か日給・時給の単価・雇用条件の手当・通勤手当）。 */
export interface FixedWage {
  wageType: 'monthly' | 'daily' | 'hourly';
  /** 月給の額か、日給・時給の単価。 */
  unit: number;
  allowances: Record<string, number>;
  commute: number;
}

const yenOf = (v: string | number | undefined): number | null => {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return String(v ?? '').match(/\d/) ? n : null;
};

/**
 * 報酬（通貨によるもの）。支給の行の合計で、通勤手当・時間外手当を含み、欠勤控除を引く。調整の行（臨時のもの）は入れない。
 */
export function remunerationOf(slip: PaySlip): number {
  return slip.lines.filter((l) => l.kind === 'pay' && !l.code.startsWith('adjust:')).reduce((s, l) => s + l.amount, 0);
}

/** 明細から固定的賃金を読む（基本の賃金の行が無ければ `null`）。 */
export function fixedWageOf(slip: PaySlip): FixedWage | null {
  const base = slip.lines.find((l) => l.code === 'base');
  if (!base) return null;
  const wageType = base.basis['日給'] !== undefined ? 'daily' : base.basis['時給'] !== undefined ? 'hourly' : 'monthly';
  const unit = wageType === 'monthly' ? base.amount : yenOf(base.basis[wageType === 'daily' ? '日給' : '時給']);
  if (unit === null) return null;
  const allowances: Record<string, number> = {};
  for (const l of slip.lines) if (l.code.startsWith('allowance:')) allowances[l.label] = l.amount;
  return { wageType, unit, allowances, commute: slip.lines.find((l) => l.code === 'commute')?.amount ?? 0 };
}

/**
 * 固定的賃金の変動の向き（上がった分の見込みの月額。変わらなければ 0）。日給・時給の単価の差は、新しい月の日数・時間に掛けて月額にする。
 */
export function fixedDelta(prev: FixedWage, cur: FixedWage, curSlip: PaySlip): number {
  let d = 0;
  if (prev.wageType !== cur.wageType) {
    // 賃金の定めが変わった（給与体系の変更）。向きは報酬の差で見る
    d += Number.EPSILON;
  } else if (prev.unit !== cur.unit) {
    if (cur.wageType === 'monthly') d += cur.unit - prev.unit;
    else {
      const qty = cur.unit > 0 ? (curSlip.lines.find((l) => l.code === 'base')?.amount ?? 0) / cur.unit : 0;
      d += (cur.unit - prev.unit) * qty;
    }
  }
  const names = new Set([...Object.keys(prev.allowances), ...Object.keys(cur.allowances)]);
  for (const n of names) d += (cur.allowances[n] ?? 0) - (prev.allowances[n] ?? 0);
  d += cur.commute - prev.commute;
  return d;
}

/** 固定的賃金が変わったか。 */
export function fixedChanged(prev: FixedWage, cur: FixedWage): boolean {
  if (prev.wageType !== cur.wageType || prev.unit !== cur.unit || prev.commute !== cur.commute) return true;
  const names = new Set([...Object.keys(prev.allowances), ...Object.keys(cur.allowances)]);
  return [...names].some((n) => (prev.allowances[n] ?? 0) !== (cur.allowances[n] ?? 0));
}

/**
 * 支払基礎日数。計算のときに控えた日数（meta.baseDays）が無い前の明細は、月給は締めの期間の暦日数、日給・時給は出勤した日と有給の日で見込む。
 */
export function baseDaysOfSlip(p: PaidSlip): number | null {
  if (typeof p.slip.meta?.baseDays === 'number') return p.slip.meta.baseDays;
  const fw = fixedWageOf(p.slip);
  if (!fw) return null;
  if (fw.wageType === 'monthly') {
    if (!p.run.periodStart || !p.run.periodEnd) return null;
    return Math.round((Date.parse(`${p.run.periodEnd}T00:00:00Z`) - Date.parse(`${p.run.periodStart}T00:00:00Z`)) / 86_400_000) + 1;
  }
  const a = p.slip.attendance;
  return a?.workDays !== undefined ? a.workDays + Math.floor(a.leaveDays ?? 0) : null;
}

/** 短時間労働者か（1 週の所定労働時間か 1 月の所定労働日数が、通常の労働者の 4 分の 3 未満）。 */
export function isShortTime(terms: HrTerms | null, settings: HrInsuranceSettings, fullTimeWeeklyDays: number): boolean {
  if (!terms) return false;
  const h = terms.weeklyHours;
  const d = terms.weeklyDays;
  return (h !== null && h < settings.fullTimeWeeklyHours * 0.75) || (d !== null && fullTimeWeeklyDays > 0 && d < fullTimeWeeklyDays * 0.75);
}

/** 標準報酬月額の等級（健康保険の額から厚生年金の額も引く）。 */
export function gradeOf(law: Law, pay: number, month: string): SocialGrade | null {
  const g = law.grade(Math.max(0, Math.floor(pay)), month);
  return g ? { amount: g.value.health.amount, grade: g.value.health.grade, pensionAmount: g.value.pension.amount, pensionGrade: g.value.pension.grade } : null;
}

/** その月に効いている標準報酬月額。 */
export function standardPayAt(list: HrStandardPay[], employeeId: string, month: string): HrStandardPay | null {
  return list.filter((x) => x.employeeId === employeeId && x.fromMonth <= month).sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))[0] ?? null;
}

/** 報酬の月を並べる（その月に払った月の給与の明細と、訂正の回の差額）。 */
export function monthsOf(paid: PaidSlip[], employeeId: string, months: string[]): SocialMonth[] {
  return months.map((month) => {
    const mine = paid.filter((p) => p.slip.employeeId === employeeId && p.run.payDate.slice(0, 7) === month);
    const monthly = mine.find((p) => p.run.kind === 'monthly');
    const retro = mine.filter((p) => p.run.kind === 'correction').reduce((s, p) => s + remunerationOf(p.slip), 0);
    return { month, baseDays: monthly ? baseDaysOfSlip(monthly) : null, pay: monthly ? remunerationOf(monthly.slip) : 0, retro, counted: false };
  });
}

/**
 * 平均に入れる月を決め、平均額（遡及支払額を含む）と修正平均額（除く）を出す（1 円未満切り捨て）。
 *
 * @param mode 定時決定は 17 日（短時間労働者は 11 日）。4 分の 3 以上のパートで 17 日以上の月が無ければ 15 日。随時改定は 3 か月ともが要る
 */
export function averageOf(months: SocialMonth[], rules: InsuranceRules, kind: { shortTime: boolean; part: boolean; mode: 'regular' | 'change' }): { months: SocialMonth[]; average: number | null; adjusted: number | null; reason: string | null } {
  const need = kind.shortTime ? rules.baseDays.shortTime : rules.baseDays.general;
  const unknown = months.some((m) => m.baseDays === null && (m.pay > 0 || m.retro > 0));
  let counted = months.map((m) => ({ ...m, counted: m.baseDays !== null && m.baseDays >= need }));
  if (kind.mode === 'regular' && !kind.shortTime && kind.part && !counted.some((m) => m.counted)) {
    counted = months.map((m) => ({ ...m, counted: m.baseDays !== null && m.baseDays >= rules.baseDays.part }));
  }
  if (kind.mode === 'change' && counted.some((m) => !m.counted)) {
    return { months: counted, average: null, adjusted: null, reason: unknown ? '支払基礎日数が分からない月があります' : `支払基礎日数が ${need} 日に満たない月があるため、随時改定の対象になりません` };
  }
  const use = counted.filter((m) => m.counted);
  if (use.length === 0) return { months: counted, average: null, adjusted: null, reason: unknown ? '支払基礎日数が分からない月があります' : `支払基礎日数が ${need} 日以上の月がありません（従前の標準報酬月額で決めます）` };
  const sum = use.reduce((s, m) => s + m.pay, 0);
  const retro = use.reduce((s, m) => s + m.retro, 0);
  return { months: counted, average: Math.floor((sum + retro) / use.length), adjusted: Math.floor(sum / use.length), reason: null };
}

/** 70 歳以上被用者か（その月に 70 歳に達している）。 */
export const over70 = (birthDate: string | null, month: string) => !!birthDate && month >= reachMonth(birthDate, 70);

/** 75 歳に達する日（誕生日。後期高齢者医療の被保険者になり、健康保険の資格を失う）。 */
export function day75(birthDate: string): string {
  return `${Number(birthDate.slice(0, 4)) + 75}${birthDate.slice(4)}`;
}

/** 70 歳に達する日（誕生日の前の日。厚生年金の資格を失う）。 */
export function day70(birthDate: string): string {
  return addDays(`${Number(birthDate.slice(0, 4)) + 70}${birthDate.slice(4)}`, -1);
}

/** 健康保険の被保険者でいられる月か（75 歳の誕生日の月から後期高齢者医療）。 */
export function healthIn(birthDate: string | null, month: string): boolean {
  return !birthDate || month < day75(birthDate).slice(0, 7);
}

/** 定時決定の入力（1 人分）。 */
export interface RegularInput {
  law: Law;
  rules: InsuranceRules;
  year: number;
  employee: HrEmployee;
  /** 7 月 1 日の雇用条件。 */
  terms: HrTerms | null;
  shortTime: boolean;
  paid: PaidSlip[];
  standardPays: HrStandardPay[];
  /** 7〜9 月に随時改定がある（月額変更届の下書きを作った）。 */
  changeInJulyToSep: boolean;
}

/**
 * 定時決定（算定基礎届）の 1 人分。対象でない人は `excluded` に理由を入れる。70 歳以上被用者と 75 歳以上の人も対象（在職老齢年金のため）。
 */
export function regularDetermination(input: RegularInput): SocialDetermination {
  const { law, rules, year, employee: e } = input;
  const applyMonth = `${year}-09`;
  const before = standardPayAt(input.standardPays, e.id, `${year}-08`);
  const base: SocialDetermination = {
    employeeId: e.id, name: e.name, kind: 'regular', applyMonth, months: [], average: null, adjustedAverage: null,
    before: before ? gradeOf(law, before.amount, `${year}-08`) : null, after: null, notes: [], excluded: null, filedAt: null,
  };
  if (!input.terms?.socialInsurance) return { ...base, excluded: '社会保険に加入していない' };
  if (!e.hiredOn || e.hiredOn > `${year}-07-01`) return { ...base, excluded: '7 月 1 日に被保険者でない' };
  if (e.hiredOn >= `${year}-06-01`) return { ...base, excluded: '6 月 1 日以後に資格を取得した（資格取得のときの決定が翌年 8 月まで効く）' };
  if (e.leftOn && e.leftOn < `${year}-07-01`) return { ...base, excluded: '6 月 30 日までに退職した' };
  if (input.changeInJulyToSep) return { ...base, excluded: '7〜9 月に随時改定がある（備考「月額変更予定」）' };
  const months = monthsOf(input.paid, e.id, [`${year}-04`, `${year}-05`, `${year}-06`]);
  // M2Office で給与を計算する前の月は、日数が足りないのではなく記録が無い（従前の額で決めない）
  if (months.every((m) => m.baseDays === null && m.pay === 0 && m.retro === 0)) return { ...base, months, excluded: '4〜6 月に支払った確定した給与が M2Office にありません' };
  const part = !input.shortTime && (e.employment === 'part' || e.employment === 'arbeit');
  const avg = averageOf(months, rules, { shortTime: input.shortTime, part, mode: 'regular' });
  const notes: string[] = [];
  if (over70(e.birthDate, `${year}-07`)) notes.push(healthIn(e.birthDate, `${year}-07`) ? '70 歳以上被用者算定' : '70 歳以上被用者算定（75 歳以上。健康保険の被保険者でない）');
  if (input.shortTime) notes.push('短時間労働者（特定適用事業所等）');
  else if (part && avg.months.some((m) => m.counted && m.baseDays !== null && m.baseDays < rules.baseDays.general)) notes.push('パート');
  if (e.hiredOn > `${year}-04-01` && e.hiredOn.slice(0, 7) >= `${year}-04`) notes.push('途中入社');
  if (months.some((m) => m.retro)) notes.push('遡及支払額あり（修正平均で決める）');
  if (avg.adjusted === null) {
    // 3 か月とも基礎日数に満たなければ、従前の標準報酬月額で決める
    return { ...base, months: avg.months, notes: [...notes, avg.reason ?? ''].filter(Boolean), after: base.before, excluded: base.before ? null : avg.reason };
  }
  return { ...base, months: avg.months, average: avg.average, adjustedAverage: avg.adjusted, notes, after: gradeOf(law, avg.adjusted, applyMonth) };
}

/** 等級の差が改定に当たるか（2 等級以上か、上限・下限の特例）。 */
export function changeQualifies(law: Law, rules: InsuranceRules, system: 'health' | 'pension', from: number, to: number, direction: 'up' | 'down', priorPay: number, average: number, month: string): boolean {
  const diff = to - from;
  if (direction === 'up' ? diff >= rules.changeGrades : diff <= -rules.changeGrades) return true;
  return (law.gradeTable(month)?.changeLimits ?? []).some((l) => l.system === system && l.direction === direction && l.fromGrade === from && l.toGrade === to
    && (l.priorPayBelow === undefined || priorPay < l.priorPayBelow) && (l.priorPayAtLeast === undefined || priorPay >= l.priorPayAtLeast)
    && (l.averageAtLeast === undefined || average >= l.averageAtLeast) && (l.averageBelow === undefined || average < l.averageBelow));
}

/** 随時改定の判定の入力（1 人分）。 */
export interface ChangeInput {
  law: Law;
  rulesAt: (month: string) => InsuranceRules | null;
  employee: HrEmployee;
  shortTime: boolean;
  /** 見る期間に支払った明細（月の給与と訂正の回）。 */
  paid: PaidSlip[];
  standardPays: HrStandardPay[];
  /** 月額変更届の下書きを作った改定の月と日時。 */
  filed: Map<string, string>;
  /** 会社で月の給与が確定した支払の月。 */
  confirmedMonths: Set<string>;
  /** これより前の変動月は見ない（YYYY-MM）。 */
  since: string;
}

/**
 * 随時改定の候補（1 人分）。固定的賃金が前の月と変わった月（変動月）ごとに、3 か月がそろっていれば判定し、そろっていなければ待つ。
 */
export function changeCandidates(input: ChangeInput): SocialDetermination[] {
  const { law, employee: e } = input;
  const monthly = input.paid.filter((p) => p.slip.employeeId === e.id && p.run.kind === 'monthly').sort((a, b) => a.run.payDate.localeCompare(b.run.payDate));
  const out: SocialDetermination[] = [];
  for (let i = 1; i < monthly.length; i++) {
    const prev = monthly[i - 1]!;
    const cur = monthly[i]!;
    const m = cur.run.payDate.slice(0, 7);
    if (m < input.since || prev.run.payDate.slice(0, 7) < shiftMonth(m, -2)) continue;
    const a = fixedWageOf(prev.slip);
    const b = fixedWageOf(cur.slip);
    if (!a || !b || !fixedChanged(a, b)) continue;
    const applyMonth = shiftMonth(m, 3);
    const months3 = [m, shiftMonth(m, 1), shiftMonth(m, 2)];
    const beforeStd = standardPayAt(input.standardPays, e.id, shiftMonth(applyMonth, -1));
    const before = beforeStd ? gradeOf(law, beforeStd.amount, shiftMonth(applyMonth, -1)) : null;
    const delta = fixedDelta(a, b, cur.slip);
    const d: SocialDetermination = {
      employeeId: e.id, name: e.name, kind: 'change', applyMonth, months: monthsOf(input.paid, e.id, months3), average: null, adjustedAverage: null,
      before, after: null, direction: delta < 0 ? 'down' : 'up', notes: [], excluded: null, filedAt: input.filed.get(applyMonth) ?? null,
    };
    const waiting = months3.find((x) => !input.confirmedMonths.has(x) && !monthly.some((p) => p.run.payDate.slice(0, 7) === x));
    if (waiting) { out.push({ ...d, excluded: `${Number(waiting.slice(5, 7))} 月に支払う給与が確定したら判定します` }); continue; }
    if (e.leftOn && e.leftOn < `${applyMonth}-01`) continue;
    const rules = input.rulesAt(m);
    if (!rules) { out.push({ ...d, excluded: '社会保険の適用の決まりの表がありません' }); continue; }
    const avg = averageOf(d.months, rules, { shortTime: input.shortTime, part: false, mode: 'change' });
    d.months = avg.months;
    d.average = avg.average;
    d.adjustedAverage = avg.adjusted;
    if (input.shortTime) d.notes.push('短時間労働者（特定適用事業所等）');
    if (over70(e.birthDate, applyMonth)) d.notes.push('70 歳以上被用者月額変更');
    if (d.months.some((x) => x.retro)) d.notes.push('遡及支払額あり（修正平均で決める）');
    if (avg.adjusted === null) { out.push({ ...d, excluded: avg.reason }); continue; }
    if (!before) { out.push({ ...d, excluded: '従前の標準報酬月額が未登録のため、判定できません' }); continue; }
    const after = gradeOf(law, avg.adjusted, applyMonth);
    if (!after) { out.push({ ...d, excluded: 'その月の等級表がありません' }); continue; }
    // 賃金の定めが変わっただけ（向きが決まらない）なら、平均の向きで見る
    const direction = delta === 0 || Math.abs(delta) < 1 ? (after.grade >= before.grade ? 'up' : 'down') : d.direction!;
    d.direction = direction;
    const prior = remunerationOf(prev.slip);
    const health = changeQualifies(law, rules, 'health', before.grade, after.grade, direction, prior, avg.adjusted, applyMonth);
    const pension = changeQualifies(law, rules, 'pension', before.pensionGrade, after.pensionGrade, direction, prior, avg.adjusted, applyMonth);
    if (!health && !pension) {
      const moved = after.grade - before.grade;
      out.push({ ...d, excluded: (direction === 'up') !== (moved > 0) && moved !== 0
        ? `固定的賃金は${direction === 'up' ? '上がりました' : '下がりました'}が、平均の等級は${moved > 0 ? '上がった' : '下がった'}ため、対象になりません`
        : `等級の差が ${Math.abs(moved)} 等級のため、対象になりません` });
      continue;
    }
    if (health && !pension) d.notes.push('健康保険のみ改定');
    if (!health && pension) d.notes.push('厚生年金のみ改定（標準報酬月額の履歴は健康保険の額のため、決定通知書と見比べてください）');
    d.after = health ? { ...after, ...(pension ? {} : { pensionAmount: before.pensionAmount, pensionGrade: before.pensionGrade }) } : { ...before, pensionAmount: after.pensionAmount, pensionGrade: after.pensionGrade };
    out.push(d);
  }
  return out;
}

/**
 * 資格取得のときの報酬月額の見込み。月給は基本給・手当・通勤手当、日給・時給は所定の日数・時間から月にならす。見込みの時間外手当を足す。
 *
 * @remarks 日給・時給の人は、公式には「同様の業務の人の前の月の平均」で決める。M2Office は所定の日数・時間から見込み、根拠に書く（監修で確かめる）
 */
export function acquirePay(terms: HrTerms | null, profile: HrPayrollProfile | null): { pay: number; basis: string } | null {
  if (!terms || terms.wageAmount === null) return null;
  const allowances = terms.allowances.reduce((s, a) => s + a.amount, 0);
  const commute = Math.max(0, profile?.commute.monthly ?? 0);
  const overtime = Math.max(0, profile?.insurance?.overtimeEstimate ?? 0);
  const extra = allowances + commute + overtime;
  const tail = `手当 ${allowances.toLocaleString('ja-JP')} 円・通勤手当 ${commute.toLocaleString('ja-JP')} 円・見込みの時間外手当 ${overtime.toLocaleString('ja-JP')} 円`;
  if (terms.wageType === 'monthly') return { pay: terms.wageAmount + extra, basis: `月給 ${terms.wageAmount.toLocaleString('ja-JP')} 円・${tail}` };
  if (terms.wageType === 'daily') {
    const days = terms.weeklyDays ?? 5;
    return { pay: Math.floor((terms.wageAmount * days * 52) / 12) + extra, basis: `日給 ${terms.wageAmount.toLocaleString('ja-JP')} 円 × 週 ${days} 日 × 52 ÷ 12・${tail}` };
  }
  const hours = terms.weeklyHours ?? 40;
  return { pay: Math.floor((terms.wageAmount * hours * 52) / 12) + extra, basis: `時給 ${terms.wageAmount.toLocaleString('ja-JP')} 円 × 週 ${hours} 時間 × 52 ÷ 12・${tail}` };
}

/** 資格の取得・喪失・年齢の到達を並べる入力。 */
export interface EventsInput {
  law: Law;
  /** この期間（YYYY-MM-DD）に事実のあったもの。 */
  from: string;
  to: string;
  employees: HrEmployee[];
  /** 従業員ごとの、事実のあった日の雇用条件。 */
  termsAt: (employeeId: string, date: string) => HrTerms | null;
  profiles: Map<string, HrPayrollProfile>;
  standardPays: HrStandardPay[];
  /** 被扶養者がいる人。 */
  withDependents: Set<string>;
  shortTime: (terms: HrTerms | null) => boolean;
  /** 届出の下書きを作った日時（`${kind}|${employeeId}|${target}`）。 */
  filed: Map<string, string>;
}

/**
 * 資格の取得・喪失（退職・75 歳）・70 歳到達の届出を並べる（事実のあった日の順）。
 */
export function socialEvents(input: EventsInput): SocialEvent[] {
  const { law } = input;
  const out: SocialEvent[] = [];
  const within = (d: string) => d >= input.from && d <= input.to;
  const filedAt = (kind: string, id: string, target: string) => input.filed.get(`${kind}|${id}|${target}`) ?? null;
  for (const e of input.employees) {
    if (e.category === 'owner') continue;
    if (e.hiredOn && within(e.hiredOn)) {
      const t = input.termsAt(e.id, e.hiredOn);
      if (t?.socialInsurance) {
        const est = acquirePay(t, input.profiles.get(e.id) ?? null);
        const month = e.hiredOn.slice(0, 7);
        const notes: string[] = [];
        if (!healthIn(e.birthDate, month)) notes.push('75 歳以上のため、厚生年金の 70 歳以上被用者該当だけ');
        else if (over70(e.birthDate, month)) notes.push('取得の区分: 健康保険（70 歳以上被用者該当）');
        else notes.push('取得の区分: 健康保険・厚生年金');
        if (input.shortTime(t)) notes.push('短時間労働者の取得（特定適用事業所等）');
        if (input.withDependents.has(e.id)) notes.push('被扶養者あり（被扶養者（異動）届を一緒に出す）');
        if (est) notes.push(`報酬月額の見込み: ${est.basis}`);
        out.push({ employeeId: e.id, name: e.name, kind: 'acquire', date: e.hiredOn, dueOn: addDays(e.hiredOn, 4), cause: '入社', pay: est?.pay ?? null,
          grade: est ? gradeOf(law, est.pay, month) : null, notes, required: true, filedAt: filedAt('acquire', e.id, e.hiredOn) });
      }
    }
    if (e.leftOn) {
      const loss = addDays(e.leftOn, 1);
      const t = input.termsAt(e.id, e.leftOn);
      if (within(loss) && t?.socialInsurance) {
        const notes = ['資格確認書を交付していれば回収して添付する'];
        if (over70(e.birthDate, e.leftOn.slice(0, 7))) notes.push(`70 歳以上被用者不該当（${e.leftOn}）`);
        out.push({ employeeId: e.id, name: e.name, kind: 'lose', date: loss, dueOn: addDays(loss, 4), cause: `退職等（${e.leftOn} 退職）`, pay: null, grade: null, notes, required: true, filedAt: filedAt('lose', e.id, loss) });
      }
    }
    if (!e.birthDate) continue;
    const active = (d: string) => (!e.hiredOn || e.hiredOn <= d) && (!e.leftOn || e.leftOn >= d);
    const d75 = day75(e.birthDate);
    if (within(d75) && active(d75) && input.termsAt(e.id, d75)?.socialInsurance) {
      out.push({ employeeId: e.id, name: e.name, kind: 'lose', date: d75, dueOn: addDays(d75, 4), cause: '75 歳到達（健康保険のみ喪失）', pay: null, grade: null,
        notes: ['後期高齢者医療に移る。この月から健康保険料・介護保険料・子ども・子育て支援金を引かない'], required: true, filedAt: filedAt('lose', e.id, d75) });
    }
    const d70 = day70(e.birthDate);
    if (within(d70) && active(d70)) {
      const t = input.termsAt(e.id, d70);
      if (t?.socialInsurance) {
        const est = acquirePay(t, input.profiles.get(e.id) ?? null);
        const cur = standardPayAt(input.standardPays, e.id, d70.slice(0, 7));
        const g = est ? gradeOf(law, est.pay, d70.slice(0, 7)) : null;
        const curG = cur ? gradeOf(law, cur.amount, d70.slice(0, 7)) : null;
        const required = !g || !curG || g.pensionAmount !== curG.pensionAmount;
        out.push({ employeeId: e.id, name: e.name, kind: 'age70', date: d70, dueOn: addDays(d70, 4), cause: '70 歳到達（厚生年金の資格喪失・70 歳以上被用者該当）', pay: est?.pay ?? null, grade: g,
          notes: [required ? '標準報酬月額相当額が今の標準報酬月額と違うため、届出が要る' : '標準報酬月額相当額が今と同じため、届出は要らない（日本年金機構が処理する）', ...(est ? [`報酬月額の見込み: ${est.basis}`] : [])],
          required, filedAt: filedAt('age70', e.id, d70) });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** 加入の判定の入力（1 人分）。 */
export interface EligibilityInput {
  rules: InsuranceRules;
  date: string;
  employee: HrEmployee;
  terms: HrTerms | null;
  profile: HrPayrollProfile | null;
  settings: { socialApply: 'mandatory' | 'voluntary' | 'none'; officeForm: 'corporation' | 'sole'; insurance: HrInsuranceSettings; fullTimeWeeklyDays: number };
  /** 特定適用事業所か（会社の設定か、被保険者の数から見込んだもの）。 */
  specificOffice: boolean;
}

/** 所定内賃金の月額（時間外・賞与・通勤・家族・精皆勤の手当を除く）。 */
export function scheduledWage(terms: HrTerms): number | null {
  if (terms.wageAmount === null) return null;
  const allowances = terms.allowances.filter((a) => !/通勤|交通|家族|扶養|精勤|皆勤|時間外|残業|深夜|休日/.test(a.name)).reduce((s, a) => s + a.amount, 0);
  if (terms.wageType === 'monthly') return terms.wageAmount + allowances;
  if (terms.wageType === 'daily') return Math.floor((terms.wageAmount * (terms.weeklyDays ?? 5) * 52) / 12) + allowances;
  return Math.floor((terms.wageAmount * (terms.weeklyHours ?? 0) * 52) / 12) + allowances;
}

/** 契約の期間の日数（期間の定めが無ければ `null`）。 */
const contractDays = (t: HrTerms) => (t.contractStart && t.contractEnd ? Math.round((Date.parse(`${t.contractEnd}T00:00:00Z`) - Date.parse(`${t.contractStart}T00:00:00Z`)) / 86_400_000) + 1 : null);
/** 更新があり得るか（更新の定めに「しない」と書いていない）。 */
const mayRenew = (t: HrTerms) => !!t.renewal.trim() && !/しない|無し|なし/.test(t.renewal);

/**
 * 加入の判定（1 人分）。雇用条件の週の所定労働時間・日数・契約の期間・年齢・区分と、法令の表の要件で決める。
 */
export function eligibility(input: EligibilityInput): InsuranceEligibility {
  const { rules, employee: e, terms: t, settings: s } = input;
  const current = { social: !!t?.socialInsurance, employment: !!t?.employmentInsurance };
  const make = (social: InsuranceEligibility['social'], employment: InsuranceEligibility['employment']): InsuranceEligibility => ({ employeeId: e.id, name: e.name, social, employment, current });
  if (e.category === 'owner') return make({ should: false, reason: '事業主本人' }, { should: false, reason: '事業主本人' });
  if (!t) return make({ should: current.social, reason: '雇用条件が無いため判定できません' }, { should: current.employment, reason: '雇用条件が無いため判定できません' });
  const student = !!input.profile?.insurance?.student;
  const days = contractDays(t);
  const month = input.date.slice(0, 7);

  // 社会保険
  let social: InsuranceEligibility['social'];
  if (s.socialApply === 'none') social = { should: false, reason: '社会保険の適用事業所でない（会社の設定）' };
  else if (days !== null && days <= 61 && !mayRenew(t)) social = { should: false, reason: '2 か月以内の期間を定めて使用され、更新の見込みが無い' };
  else if (!isShortTime(t, s.insurance, s.fullTimeWeeklyDays)) {
    social = { should: true, reason: `所定労働時間・日数が通常の労働者の 4 分の 3 以上${!healthIn(e.birthDate, month) ? '（75 歳以上のため厚生年金の 70 歳以上被用者だけ）' : over70(e.birthDate, month) ? '（70 歳以上のため健康保険だけ）' : ''}` };
  } else if (!input.specificOffice) social = { should: false, reason: '短時間労働者で、特定適用事業所でない' };
  else if ((t.weeklyHours ?? 0) < rules.shortTime.weeklyHours) social = { should: false, reason: `短時間労働者で、週の所定労働時間が ${rules.shortTime.weeklyHours} 時間未満` };
  else if (student) social = { should: false, reason: '短時間労働者で、学生' };
  else if (rules.shortTime.monthlyWage !== null && (scheduledWage(t) ?? 0) < rules.shortTime.monthlyWage) social = { should: false, reason: `短時間労働者で、所定内賃金が月 ${rules.shortTime.monthlyWage.toLocaleString('ja-JP')} 円未満` };
  else social = { should: true, reason: `短時間労働者の要件（週 ${rules.shortTime.weeklyHours} 時間以上・特定適用事業所${rules.shortTime.monthlyWage !== null ? `・月 ${rules.shortTime.monthlyWage.toLocaleString('ja-JP')} 円以上` : ''}・学生でない）を満たす` };

  // 雇用保険
  let employment: InsuranceEligibility['employment'];
  if (e.category === 'officer') employment = { should: false, reason: '役員（使用人を兼ねる実態があれば対象。ハローワークで確かめる）' };
  else if (e.category === 'family') employment = { should: false, reason: '同居の親族（ほかの従業員と同じ働き方なら対象になり得る）' };
  else if ((t.weeklyHours ?? 0) < rules.employment.weeklyHours) employment = { should: false, reason: `週の所定労働時間が ${rules.employment.weeklyHours} 時間未満` };
  else if (days !== null && days < rules.employment.days && !mayRenew(t)) employment = { should: false, reason: `雇用の見込みが ${rules.employment.days} 日未満` };
  else if (student) employment = { should: false, reason: '昼間の学生（卒業の見込みで勤め続ける人などは対象）' };
  else employment = { should: true, reason: `週 ${rules.employment.weeklyHours} 時間以上・${rules.employment.days} 日以上の雇用の見込み` };
  return make(social, employment);
}
