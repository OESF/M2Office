/**
 * @file 月の給与の計算（仕様書 第30.10.1節）。決まったプログラムで額を出し、行ごとに根拠を残す（H-1・H-4）。
 *
 * 入力は雇用条件・給与の情報・標準報酬月額・勤怠の期間の集計・会社の設定・法令の表。副作用を持たない。
 * 社会保険料と雇用保険料の本人負担は 50 銭以下を切り捨て、50 銭を超えれば切り上げる。割増賃金は行ごとに 1 円未満を四捨五入する。
 */

import type {
  AttDay, AttTotals, HrEmployee, HrPayItemRule, HrPayrollProfile, HrSettings, HrTerms, PayLine,
} from '@m2office/shared';
import type { Law } from './law/lookup.js';
import type { LawMeta } from './law/types.js';
import { scheduledMinutes } from './attendance.js';

/** 1 人分の計算の入力。 */
export interface SlipInput {
  employee: HrEmployee;
  terms: HrTerms | null;
  profile: HrPayrollProfile | null;
  /** 保険料の月に効いている標準報酬月額（健康保険）。無ければ雇用条件から仮に求める。 */
  standardPay: number | null;
  /** 勤怠の期間の集計と日ごとの記録。 */
  totals: AttTotals;
  days: AttDay[];
  settings: HrSettings;
  /** 支給月（YYYY-MM）と支払日。 */
  payMonth: string;
  payDate: string;
  periodEnd: string;
  law: Law;
}

/** 1 人分の計算の結果。 */
export interface SlipResult {
  gross: number;
  deductions: number;
  net: number;
  lines: PayLine[];
  warnings: string[];
  /** 使った法令の表（版と監修の状態）。 */
  tables: LawMeta[];
}

/** 50 銭以下は切り捨て、50 銭を超えれば切り上げ（社会保険料・雇用保険料の本人負担）。 */
export function round50(v: number): number {
  const sen = Math.round(v * 100);
  const yen = Math.floor(sen / 100);
  return sen - yen * 100 > 50 ? yen + 1 : yen;
}

/** 1 円未満を四捨五入。 */
const round = (v: number) => Math.round(v);

/** 法の割増の基礎から除く手当（家族・通勤・別居・子女教育・住宅・臨時）。名前で見分ける。 */
const EXCLUDED = /家族|扶養|通勤|交通|別居|単身赴任|子女教育|住宅|家賃|臨時|慶弔|見舞|賞与/;
/** 所得税の対象にしない手当（通勤手当は別に非課税の額で扱う）。 */
const TAX_FREE = /見舞/;

/** 手当の扱い（会社の設定があればそれ、無ければ名前から）。 */
export function itemRule(name: string, rules: HrPayItemRule[]): HrPayItemRule {
  return rules.find((r) => r.name === name) ?? { name, premiumBase: !EXCLUDED.test(name), taxable: !TAX_FREE.test(name) };
}

/** 月の前後（YYYY-MM）。 */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** 年齢に「達した日」（誕生日の前の日）の月（YYYY-MM）。 */
export function reachMonth(birthDate: string, age: number): string {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y + age, m - 1, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 7);
}

/** その月に社会保険の被保険者か（資格取得の月から、資格喪失（退職日の翌日）の月の前の月まで）。 */
export function insuredIn(employee: Pick<HrEmployee, 'hiredOn' | 'leftOn'>, month: string): boolean {
  if (!employee.hiredOn || employee.hiredOn.slice(0, 7) > month) return false;
  if (!employee.leftOn) return true;
  const loss = new Date(`${employee.leftOn}T00:00:00Z`);
  loss.setUTCDate(loss.getUTCDate() + 1);
  return month < loss.toISOString().slice(0, 7);
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const hours = (m: number) => `${Math.round((m / 60) * 100) / 100} 時間`;

/**
 * 1 人分の月の給与を計算する（下書き）。
 */
export function calcSlip(input: SlipInput): SlipResult {
  const { employee: e, terms: t, profile: p, totals, settings, law } = input;
  const pr = settings.payroll;
  const lines: PayLine[] = [];
  const warnings: string[] = [];
  const tables = new Map<string, LawMeta>();
  const use = (m: LawMeta) => tables.set(m.version, m);
  const pay = (code: string, label: string, amount: number, basis: PayLine['basis']) => { if (amount !== 0) lines.push({ code, label, amount, kind: 'pay', basis }); };
  const deduct = (code: string, label: string, amount: number, basis: PayLine['basis']) => { if (amount > 0) lines.push({ code, label, amount, kind: 'deduct', basis }); };

  if (!t || t.wageAmount === null) {
    warnings.push('雇用条件に賃金の額がありません');
    return { gross: 0, deductions: 0, net: 0, lines, warnings, tables: [] };
  }
  const allowances = t.allowances.map((a) => ({ ...a, rule: itemRule(a.name, pr.items) }));
  const premiumAllowances = allowances.filter((a) => a.rule.premiumBase).reduce((s, a) => s + a.amount, 0);
  const dailyMinutes = scheduledMinutes({ start: t.startTime || null, end: t.endTime || null, breakMinutes: t.breakMinutes }) ?? 480;
  const avgHours = pr.avgMonthlyHours ?? (t.weeklyHours ? Math.round(((t.weeklyHours * 52) / 12) * 100) / 100 : null);

  // 基本の賃金と、割増の単価
  let unit: number;
  let unitBasis: string;
  if (t.wageType === 'monthly') {
    pay('base', '基本給', t.wageAmount, { 賃金の定め: '月給' });
    const h = avgHours ?? 173.33;
    if (!avgHours) warnings.push('月の平均所定労働時間が分からないため、173.33 時間で割増の単価を出しました');
    unit = (t.wageAmount + premiumAllowances) / h;
    unitBasis = `（基本給 ${yen(t.wageAmount)} ＋ 割増の基礎の手当 ${yen(premiumAllowances)}）÷ 月の平均所定労働時間 ${h} 時間`;
  } else if (t.wageType === 'daily') {
    pay('base', '日給', round(t.wageAmount * totals.workDays), { 日給: yen(t.wageAmount), 出勤日数: `${totals.workDays} 日` });
    unit = t.wageAmount / (dailyMinutes / 60);
    unitBasis = `日給 ${yen(t.wageAmount)} ÷ 1 日の所定 ${hours(dailyMinutes)}`;
  } else {
    pay('base', '時給の賃金', round((t.wageAmount * totals.workMinutes) / 60), { 時給: yen(t.wageAmount), 実労働: hours(totals.workMinutes) });
    unit = t.wageAmount;
    unitBasis = `時給 ${yen(t.wageAmount)}`;
  }
  const unitText = `${Math.round(unit * 100) / 100} 円（${unitBasis}）`;
  for (const a of allowances) pay(`allowance:${a.name}`, a.name, a.amount, { 雇用条件: yen(a.amount), 割増の基礎: a.rule.premiumBase ? '入れる' : '入れない' });

  // 割増賃金（時給の人は実労働に含めて払っているため、割増の分だけを足す）
  const hourly = t.wageType === 'hourly';
  const legalOt = totals.overtimeMinutes - totals.over60Minutes;
  pay('overtime', '時間外手当', round((unit * legalOt / 60) * ((hourly ? 0 : 100) + pr.premiums.overtime) / 100),
    { 単価: unitText, 法定外: hours(legalOt), 割増率: `${pr.premiums.overtime}%` });
  pay('over60', '時間外手当（月 60 時間超）', round((unit * totals.over60Minutes / 60) * ((hourly ? 0 : 100) + pr.premiums.over60) / 100),
    { 単価: unitText, '60 時間を超えた分': hours(totals.over60Minutes), 割増率: `${pr.premiums.over60}%` });
  if (!hourly && t.wageType === 'monthly') {
    pay('extra', '所定外手当', round(unit * totals.extraMinutes / 60), { 単価: unitText, 所定外: hours(totals.extraMinutes), 割増率: '0%' });
  }
  pay('night', '深夜手当', round((unit * totals.nightMinutes / 60) * pr.premiums.night / 100), { 単価: unitText, 深夜: hours(totals.nightMinutes), 割増率: `${pr.premiums.night}%` });
  pay('holiday', '休日手当', round((unit * totals.holidayMinutes / 60) * ((hourly ? 0 : 100) + pr.premiums.holiday) / 100),
    { 単価: unitText, 法定休日の労働: hours(totals.holidayMinutes), 割増率: `${pr.premiums.holiday}%` });

  // 通勤手当（非課税の額は所得税の対象から外す）
  const commute = Math.max(0, p?.commute.monthly ?? 0);
  const taxFreeCommute = Math.min(commute, Math.max(0, p?.commute.taxFree ?? 0));
  pay('commute', '通勤手当', commute, { 月額: yen(commute), うち非課税: yen(taxFreeCommute) });

  // 欠勤・遅刻早退（月給の人だけ。会社の設定で切れる）
  if (t.wageType === 'monthly' && pr.deductAbsence) {
    const scheduledDays = input.days.filter((d) => d.type === 'workday').length;
    if (totals.missingDays > 0 && scheduledDays > 0) {
      pay('absence', '欠勤控除', -round((t.wageAmount / scheduledDays) * totals.missingDays),
        { 基本給: yen(t.wageAmount), 所定の労働日: `${scheduledDays} 日`, 欠勤: `${totals.missingDays} 日`, 計算: '基本給 ÷ 所定の労働日 × 欠勤の日数' });
      warnings.push(`打刻の無い所定の労働日 ${totals.missingDays} 日を欠勤として引きました。打刻漏れや休みの入れ忘れでないか確かめてください`);
    }
    const lateEarly = totals.lateMinutes + totals.earlyMinutes;
    pay('late', '遅刻早退控除', -round(unit * lateEarly / 60), { 単価: unitText, 遅刻と早退: hours(lateEarly) });
  }

  const gross = lines.filter((l) => l.kind === 'pay').reduce((s, l) => s + l.amount, 0);
  const taxFreeItems = allowances.filter((a) => !a.rule.taxable).reduce((s, a) => s + a.amount, 0);

  // 社会保険料（保険料の月の分。翌月徴収なら前の月）
  let social = 0;
  const premiumMonth = pr.collect === 'next' ? shiftMonth(input.payMonth, -1) : input.payMonth;
  const socialOn = t.socialInsurance && e.category !== 'owner' && settings.socialApply !== 'none' && settings.health.kind !== 'none';
  if (socialOn && insuredIn(e, premiumMonth)) {
    let std = input.standardPay;
    if (!std) {
      const monthly = t.wageType === 'monthly' ? t.wageAmount + allowances.reduce((s, a) => s + a.amount, 0) + commute
        : t.wageType === 'daily' ? t.wageAmount * (t.weeklyDays ?? 5) * 52 / 12
          : t.wageAmount * (t.weeklyHours ?? 40) * 52 / 12;
      const g = law.grade(Math.round(monthly), premiumMonth);
      std = g?.value.health.amount ?? null;
      warnings.push(`標準報酬月額が未登録のため、雇用条件から仮に ${std ? yen(std) : '（等級表が無く求められません）'} としました`);
    }
    if (std) {
      const careOn = !!e.birthDate && premiumMonth >= reachMonth(e.birthDate, 40) && premiumMonth < reachMonth(e.birthDate, 65);
      const kumiai = settings.health.kind === 'kumiai';
      const h = kumiai ? (pr.kumiai.health !== null ? { value: pr.kumiai.health, table: null } : null) : settings.health.kind === 'kyokai' ? law.healthRate(settings.health.prefecture, premiumMonth) : null;
      const c = careOn ? (kumiai ? (pr.kumiai.care !== null ? { value: pr.kumiai.care, table: null } : null) : law.careRate(premiumMonth)) : { value: 0, table: null };
      if (h && c) {
        if (h.table) use(h.table);
        if (c.table) use(c.table);
        // 小数の足し算の誤差（11.469999…%）を根拠に出さない
        const rate = Math.round((h.value + c.value) * 1000) / 1000;
        const amount = round50((std * rate) / 100 / 2);
        deduct('health', careOn ? '健康保険料（介護を含む）' : '健康保険料', amount, {
          標準報酬月額: yen(std), 料率: `${rate}%（健康保険 ${h.value}%${careOn ? `・介護 ${c.value}%` : ''}）`, 保険料の月: premiumMonth,
          本人負担: '料率の半分', 端数: '50 銭以下切り捨て', ...(h.table ? { 表: h.table.version } : { 表: '健康保険組合の料率（会社の設定）' }),
        });
        social += amount;
      } else {
        warnings.push(settings.health.kind === 'kyokai' && !settings.health.prefecture ? '健康保険の都道府県が会社の設定にありません' : '健康保険の料率が分かりません（表が未登録か、組合の料率が未設定）');
      }
      const cs = law.childSupportRate(premiumMonth);
      if (cs) {
        use(cs.table);
        const amount = round50((std * cs.value) / 100 / 2);
        deduct('child', '子ども・子育て支援金', amount, { 標準報酬月額: yen(std), 支援金率: `${cs.value}%`, 保険料の月: premiumMonth, 端数: '50 銭以下切り捨て', 表: cs.table.version });
        social += amount;
      }
      const pensionOn = !e.birthDate || premiumMonth < reachMonth(e.birthDate, 70);
      const ps = pensionOn ? law.pensionRate(premiumMonth) : null;
      const pstd = law.pensionAmountFor(std, premiumMonth);
      if (ps && pstd) {
        use(ps.table);
        use(pstd.table);
        const amount = round50((pstd.value.amount * ps.value) / 100 / 2);
        deduct('pension', '厚生年金保険料', amount, { 標準報酬月額: yen(pstd.value.amount), 料率: `${ps.value}%`, 保険料の月: premiumMonth, 端数: '50 銭以下切り捨て', 表: ps.table.version });
        social += amount;
      } else if (pensionOn) {
        warnings.push('厚生年金の料率か等級表が未登録です');
      }
    }
  }

  // 雇用保険料（賃金の総額 × 労働者負担の率）
  let employment = 0;
  if (t.employmentInsurance && e.category === 'employee') {
    const r = law.employmentRate('general', input.periodEnd);
    if (r) {
      use(r.table);
      employment = round50(gross * r.value);
      deduct('employment', '雇用保険料', employment, { 賃金の総額: yen(gross), 労働者負担: `${Math.round(r.value * 100000) / 100} / 1,000`, 端数: '50 銭以下切り捨て', 表: r.table.version });
    } else {
      warnings.push('雇用保険料率の表が未登録です');
    }
  } else if (t.employmentInsurance && e.category !== 'employee') {
    warnings.push('役員・家族の従業員は、原則として雇用保険の対象ではありません（加入の設定を確かめてください）');
  }

  // 源泉所得税（月額表）
  const taxable = gross - taxFreeCommute - taxFreeItems - social - employment;
  const column = p?.taxColumn ?? 'ko';
  const dependents = p?.dependents ?? 0;
  const w = law.withholding(Math.max(0, taxable), column, dependents, input.payDate);
  if (w) {
    use(w.table);
    // 0 円でも根拠を見せるため、所得税の行は必ず出す
    lines.push({ code: 'income-tax', label: '所得税', amount: w.value.tax, kind: 'deduct', basis: {
      社会保険料等を引いた後の額: yen(Math.max(0, taxable)), 欄: column === 'ko' ? `甲欄（扶養親族等 ${dependents} 人）` : '乙欄', 行: w.value.row, 表: w.table.version,
    } });
  } else {
    warnings.push(`${input.payDate.slice(0, 4)} 年の源泉徴収税額表が未登録です`);
  }
  if (!p) warnings.push('税の区分（甲欄・乙欄）と扶養の数が未登録のため、甲欄・扶養 0 人で計算しました');

  // 住民税（6 月から翌年 5 月の年度）
  const [py, pm] = input.payMonth.split('-').map(Number) as [number, number];
  const fiscal = pm >= 6 ? py : py - 1;
  const rt = p?.residentTax.find((x) => x.fiscalYear === fiscal);
  if (rt) {
    deduct('resident-tax', '住民税', pm === 6 ? rt.june : rt.monthly, { 年度: `${fiscal} 年度`, 市区町村: rt.municipality, 月: pm === 6 ? '6 月分' : '7 月以降の月額' });
  }

  // 最低賃金（時間あたりの額）
  const pref = settings.health.prefecture;
  const mw = pref ? law.minimumWage(pref, input.periodEnd) : null;
  if (mw) {
    use(mw.table);
    const perHour = t.wageType === 'hourly' ? t.wageAmount : t.wageType === 'daily' ? t.wageAmount / (dailyMinutes / 60) : (t.wageAmount + premiumAllowances) / (avgHours ?? 173.33);
    if (perHour < mw.value) warnings.push(`時間あたり ${Math.floor(perHour)} 円で、${pref}の最低賃金 ${mw.value} 円を下回っています`);
  }

  // 毎年変わる表が更新されていなければ、前の表で計算したことを示す（H-8・第30.18.1節）。税額表は無ければ計算できないため別に示す
  const stale = [
    ...(social > 0 ? law.staleAt(premiumMonth).filter((x) => x.label !== '源泉徴収税額表（月額表）' && x.label !== '雇用保険料率') : []),
    ...(employment > 0 ? law.staleAt(input.periodEnd.slice(0, 7)).filter((x) => x.label === '雇用保険料率') : []),
  ];
  for (const x of stale) warnings.push(`${x.label}が ${Number(x.expectedFrom.slice(0, 4))} 年 ${Number(x.expectedFrom.slice(5, 7))} 月からの表に更新されていません（前の表で計算しました）`);

  const deductions = lines.filter((l) => l.kind === 'deduct').reduce((s, l) => s + l.amount, 0);
  for (const m of tables.values()) if (m.review.status !== 'verified') { warnings.push('法令の表が監修前です（確定には使えません）'); break; }
  return { gross, deductions, net: gross - deductions, lines, warnings, tables: [...tables.values()] };
}
