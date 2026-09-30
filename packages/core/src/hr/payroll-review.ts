/**
 * @file 給与の回の点検（仕様書 第30.10.3節）。決まったプログラムで、止めるもの（確定できない）と確かめるものを挙げる。
 *
 * 額は変えない。前の確定した回との差・年齢の到達・固定の賃金の変動・扶養の数・振込先・明細の同意・住民税の読み取りを見る。
 * 副作用を持たない。
 */

import type { HrEmployee, HrFamilyMember, HrPayrollProfile, HrTerms, PayCheck, PaySlip } from '@m2office/shared';
import { reachMonth, shiftMonth } from './payroll.js';

/** 点検に要るもの。 */
export interface ReviewInput {
  payMonth: string;
  /** 保険料の月（翌月徴収なら支給月の前の月）。 */
  premiumMonth: string;
  slips: PaySlip[];
  /** 前の確定した月の給与の明細（従業員ごと）。 */
  previous: Map<string, PaySlip>;
  employees: Map<string, HrEmployee>;
  profiles: Map<string, HrPayrollProfile>;
  family: Map<string, HrFamilyMember[]>;
  terms: Map<string, HrTerms[]>;
  attendanceClosed: boolean;
  periodLabel: string;
  /** 監修前の表を使ったか。 */
  unverified: boolean;
}

const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toLocaleString('ja-JP')} 円`;

/** 明細の注意のうち、使う表が無くて額を出せないもの（止める）。 */
const MISSING_TABLE = /税額表が未登録|料率の表が未登録|料率か等級表が未登録|料率が分かりません|都道府県が会社の設定にありません|等級表が無く|算出率の表が未登録/;

/** 前の回から変わった行（差の大きい順）。 */
export function changedLines(cur: PaySlip, prev: PaySlip): { label: string; diff: number }[] {
  const sign = (k: 'pay' | 'deduct') => (k === 'pay' ? 1 : -1);
  const map = new Map<string, { label: string; diff: number }>();
  for (const l of prev.lines) map.set(l.code, { label: l.label, diff: -sign(l.kind) * l.amount });
  for (const l of cur.lines) {
    const m = map.get(l.code) ?? { label: l.label, diff: 0 };
    m.diff += sign(l.kind) * l.amount;
    map.set(l.code, m);
  }
  return [...map.values()].filter((x) => x.diff !== 0).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

/** 差の説明（「住民税 −3,000 円・時間外手当 +12,000 円」。差引支給への効き目で書く）。 */
export function explainDiff(cur: PaySlip, prev: PaySlip, max = 3): string {
  return changedLines(cur, prev).slice(0, max).map((x) => `${x.label} ${signed(x.diff)}`).join('・');
}

/** 年末に 16 歳以上か（年齢は誕生日の前の日に加わるため、その年の 15 年前の 1 月 1 日以前の生まれ）。 */
const sixteenAtYearEnd = (birthDate: string, year: number) => birthDate <= `${year - 15}-01-01`;

/** 介護保険の対象の月か。 */
const careIn = (birthDate: string, month: string) => month >= reachMonth(birthDate, 40) && month < reachMonth(birthDate, 65);

/**
 * 回を点検する。
 *
 * @returns 止めるものを先に、確かめるものを後に
 */
export function reviewRun(input: ReviewInput): PayCheck[] {
  const stops: PayCheck[] = [];
  const checks: PayCheck[] = [];
  if (!input.attendanceClosed) stops.push({ level: 'stop', code: 'not-closed', text: `勤怠（${input.periodLabel}）が締まっていません。締めてから計算し直してください` });
  if (input.unverified) stops.push({ level: 'stop', code: 'unverified', text: '法令の表が監修前です。監修が済むまで確定できません' });
  const monthPrev = shiftMonth(input.premiumMonth, -1);
  const year = Number(input.payMonth.slice(0, 4));
  for (const s of input.slips) {
    const who = { employeeId: s.employeeId, employeeName: s.employeeName ?? '' };
    const e = input.employees.get(s.employeeId);
    const p = input.profiles.get(s.employeeId);
    if (s.net < 0) stops.push({ level: 'stop', code: 'negative', text: `差引支給がマイナスです（${yen(s.net)}）`, ...who });
    for (const w of s.warnings) {
      if (w.startsWith('法令の表が監修前')) continue;
      if (w.startsWith('雇用条件に賃金の額がありません')) stops.push({ level: 'stop', code: 'no-wage', text: w, ...who });
      else if (MISSING_TABLE.test(w)) stops.push({ level: 'stop', code: 'missing-table', text: w, ...who });
      else checks.push({ level: 'check', code: /最低賃金/.test(w) ? 'min-wage' : /欠勤/.test(w) ? 'absence' : /標準報酬月額が未登録/.test(w) ? 'std-missing' : /表に更新されていません/.test(w) ? 'stale-table' : 'note', text: w, ...who });
    }
    // 前の確定した回との差
    const prev = input.previous.get(s.employeeId);
    if (prev) {
      const d = s.net - prev.net;
      if (Math.abs(d) >= 5000 && Math.abs(d) >= Math.abs(prev.net) * 0.1) {
        checks.push({ level: 'check', code: 'diff', text: `差引支給が前の回より ${signed(d)}（${explainDiff(s, prev)}）`, ...who });
      }
    }
    if (e?.birthDate) {
      const now = careIn(e.birthDate, input.premiumMonth);
      if (now !== careIn(e.birthDate, monthPrev)) checks.push({ level: 'check', code: 'care', text: now ? '今月から介護保険料を引きます（40 歳）' : '今月から介護保険料を引きません（65 歳）', ...who });
      if (input.premiumMonth === reachMonth(e.birthDate, 70)) checks.push({ level: 'check', code: 'pension-end', text: '70 歳に達したため、今月から厚生年金保険料を引きません（70 歳以上被用者の届出を確かめてください）', ...who });
    }
    // 随時改定の判定は、確定した明細から社会保険の処理が行い、知らせとして足す（第30.12.1節）
    // 家族の扶養（16 歳以上）と源泉の扶養親族等の数
    const fam = input.family.get(s.employeeId) ?? [];
    if (fam.length > 0 && p) {
      const n = fam.filter((f) => f.dependent && (!f.birthDate || sixteenAtYearEnd(f.birthDate, year))).length;
      if (n !== p.dependents) checks.push({ level: 'check', code: 'dependents', text: `家族で扶養にしている 16 歳以上の人（${n} 人）と、源泉の扶養親族等の数（${p.dependents} 人）が違います`, ...who });
    }
    const bank = p?.bank ?? {};
    if (!bank.bankCode || !bank.branchCode || !bank.number) checks.push({ level: 'check', code: 'no-bank', text: '振込先（銀行と支店の番号・口座番号）が無いため、振込データに入りません', ...who });
    if (!e?.userId || !p?.payslipConsentAt) checks.push({ level: 'check', code: 'no-consent', text: '明細を画面で受け取る同意が無いため、PDF で渡してください', ...who });
    const pm = Number(input.payMonth.slice(5, 7));
    if (pm === 6 && p?.residentTax.find((r) => r.fiscalYear === year)?.source === 'notice') {
      checks.push({ level: 'check', code: 'resident-notice', text: `住民税は決定通知書から読み取った額（${year} 年度）で引いています`, ...who });
    }
  }
  return [...stops, ...checks];
}

/**
 * 賞与の回と訂正の回を点検する（第30.11.1節・第30.10.4節）。月の給与と違い、勤怠の締めと前の回との差は見ない。
 *
 * @returns 止めるものを先に、確かめるものを後に
 */
export function reviewOther(input: { slips: PaySlip[]; employees: Map<string, HrEmployee>; profiles: Map<string, HrPayrollProfile>; unverified: boolean }): PayCheck[] {
  const stops: PayCheck[] = [];
  const checks: PayCheck[] = [];
  if (input.unverified) stops.push({ level: 'stop', code: 'unverified', text: '法令の表が監修前です。監修が済むまで確定できません' });
  for (const s of input.slips) {
    const who = { employeeId: s.employeeId, employeeName: s.employeeName ?? '' };
    const e = input.employees.get(s.employeeId);
    const p = input.profiles.get(s.employeeId);
    if (s.net < 0 && !s.lines.some((l) => l.basis['訂正前'] !== undefined)) stops.push({ level: 'stop', code: 'negative', text: `差引支給がマイナスです（${s.net.toLocaleString('ja-JP')} 円）`, ...who });
    for (const w of s.warnings) {
      if (w.startsWith('法令の表が監修前')) continue;
      if (MISSING_TABLE.test(w)) stops.push({ level: 'stop', code: 'missing-table', text: w, ...who });
      else checks.push({ level: 'check', code: /月額表で所得税/.test(w) ? 'bonus-special' : 'note', text: w, ...who });
    }
    const bank = p?.bank ?? {};
    if (s.net > 0 && (!bank.bankCode || !bank.branchCode || !bank.number)) checks.push({ level: 'check', code: 'no-bank', text: '振込先（銀行と支店の番号・口座番号）が無いため、振込データに入りません', ...who });
    if (!e?.userId || !p?.payslipConsentAt) checks.push({ level: 'check', code: 'no-consent', text: '明細を画面で受け取る同意が無いため、PDF で渡してください', ...who });
  }
  return [...stops, ...checks];
}
