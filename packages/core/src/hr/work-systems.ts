/**
 * @file 1 年単位の変形労働時間制とフレックスタイム制の計算（仕様書 第30.6.3節、ADR-0085）。決まったプログラムで出す（H-1。推論に数えさせない）。
 *
 * 1 年単位の変形労働時間制（労働基準法 32 条の 4・32 条の 4 の 2）:
 *   時間外は日・週・対象期間の 3 段。日と週は毎月の締めで、対象期間の分は対象期間の終わり（途中で入った人・辞めた人は、働いた期間の終わり）の締めで清算する。
 *   所定は 1 日 10 時間・1 週 52 時間まで、連続して 6 日（特定期間は 12 日）まで、労働日は 1 年あたり 280 日まで（対象期間が 3 か月を超えるとき）、
 *   48 時間を超える週は 3 週を超えて続けない・3 か月ごとに 3 週まで（同）。
 * フレックスタイム制（32 条の 3）:
 *   清算期間の実際の時間が総枠（40 時間 × 暦日数 ÷ 7）を超えた分が時間外。清算期間が 1 か月を超えるときは、各月で週の平均が 50 時間を超えた分をその月の時間外にし、
 *   残りを最後の月に清算する。足りない時間は、会社の決まりで次の清算期間に繰り越すか、給与から差し引く。
 *
 * **社会保険労務士の監修の前**（第30.27節）。確定はデバッグモードだけ（ADR-0053）。
 */

import type { AttDay, AttFlexStatus, AttPeriod, AttTotals, HrAnnualSettings, HrFlexSettings, HrShift } from '@m2office/shared';
import { DAILY_LIMIT, OVER60, WEEKLY_LIMIT, scheduledMinutes, shiftDate, variableCapMinutes, weekday } from './attendance.js';

/** 期間の暦日数。 */
export const daysBetween = (start: string, end: string): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

/** 日付に月を足す（月末を超える日は月末にする）。 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** 週の目印（起算日の日付）。 */
const weekKey = (date: string, weekStart: number) => shiftDate(date, -((weekday(date) - weekStart + 7) % 7));

const emptyTotals = (): AttTotals => ({
  workDays: 0, workMinutes: 0, overtimeMinutes: 0, weeklyOvertimeMinutes: 0, extraMinutes: 0, nightMinutes: 0, holidayMinutes: 0,
  over60Minutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, missingDays: 0, overtimeWithinMinutes: 0,
});

// ─── 1 年単位の変形労働時間制 ─────────────────────────────────────────

/**
 * その日を含む対象期間。起算日から、決めた長さの期間を続けて並べる。
 *
 * @returns 設定が無い（起算日が無い・その日が起算日より前）ときは `null`
 */
export function annualPeriodOf(date: string, s: HrAnnualSettings): { start: string; end: string } | null {
  if (!s.enabled || !/^\d{4}-\d{2}-\d{2}$/.test(s.start) || date < s.start) return null;
  const months = Math.min(12, Math.max(2, Math.round(s.months || 12)));
  let start = s.start;
  for (let i = 0; i < 200; i++) {
    const next = addMonths(s.start, (i + 1) * months);
    if (date < next) return { start, end: shiftDate(next, -1) };
    start = next;
  }
  return null;
}

/** 1 年単位の総枠（分。40 時間 × 暦日数 ÷ 7。特例の 44 時間は使えない）。 */
export const annualCapMinutes = (days: number): number => variableCapMinutes(days, false);

/** 3 段の計算の 1 日。 */
interface StageRow {
  d: AttDay;
  sched: number;
  dayOt: number;
  weekOt: number;
  schedPart: number;
  extra: number;
}

/** 日の段（所定が 8 時間を超える日はその所定を、それ以外は 8 時間を超えた分）。法定休日の労働は除く。 */
function dayStage(days: AttDay[]): StageRow[] {
  return days.map((d) => {
    const sched = d.type === 'legal-holiday' ? 0 : d.scheduledMinutes ?? 0;
    const work = d.type === 'legal-holiday' ? 0 : d.workMinutes;
    const dayOt = Math.max(0, work - Math.max(sched, DAILY_LIMIT));
    const nonOt = work - dayOt;
    const schedPart = Math.min(nonOt, sched);
    return { d, sched, dayOt, weekOt: 0, schedPart, extra: nonOt - schedPart };
  });
}

/** 週の段（所定が 40 時間を超える週はその所定を、それ以外は 40 時間を超えた分。日の段を除く）。週の終わりに近い日の所定外から当てる。 */
function weekStage(rows: StageRow[], weekStart: number, counted: (wk: string) => boolean): void {
  const byWeek = new Map<string, StageRow[]>();
  for (const r of rows) {
    const wk = weekKey(r.d.date, weekStart);
    byWeek.set(wk, [...(byWeek.get(wk) ?? []), r]);
  }
  for (const [wk, rs] of byWeek) {
    if (rs.length < 7 || !counted(wk)) continue;
    const limit = Math.max(rs.reduce((s, r) => s + r.sched, 0), WEEKLY_LIMIT);
    let over = Math.max(0, rs.reduce((s, r) => s + r.schedPart + r.extra, 0) - limit);
    for (const r of [...rs].reverse()) {
      const take = Math.min(over, r.extra);
      r.extra -= take; r.weekOt += take; over -= take;
    }
  }
}

/**
 * 1 年単位の変形労働時間制の、締めの期間の集計。
 *
 * @param days 日の集計（期間の始まりを含む週の起算日から、期間の終わりまで）
 * @param range 対象期間（途中で入った人・辞めた人は、その人の働いた範囲）
 * @param settle この期間に終わる対象期間（または働いた範囲）ごとの、すべての日の集計（範囲の始まりを含む週の起算日から）と範囲
 * @returns 合計。日・週の時間外は毎月、対象期間の分は清算する期間に足す。前の期間に所定外として払った時間が時間外に当たったら、割増だけを払う分（`overtimeWithinMinutes`）にする
 * @remarks 週の時間外は、対象期間に丸ごと入り、この期間に終わる週で数える（期間をまたぐ週は、終わる期間で数える）
 */
export function annualTotals(
  days: AttDay[], period: Pick<AttPeriod, 'start' | 'end'>, range: { start: string; end: string }, weekStart: number,
  settle: { days: AttDay[]; range: { start: string; end: string } }[] = [],
): AttTotals {
  const rows = dayStage(days.filter((d) => d.date <= period.end));
  weekStage(rows, weekStart, (wk) => wk >= range.start && shiftDate(wk, 6) <= range.end && shiftDate(wk, 6) >= period.start && shiftDate(wk, 6) <= period.end);
  const t = emptyTotals();
  for (const r of rows) {
    const d = r.d;
    if (d.date < period.start) {
      // 前の期間の日（この期間に終わる週の分）。所定外として払い済みの時間が週の時間外に当たった分は、割増だけを払う
      t.overtimeMinutes += r.weekOt; t.weeklyOvertimeMinutes += r.weekOt; t.overtimeWithinMinutes! += r.weekOt;
      continue;
    }
    if (d.type !== 'legal-holiday') { d.overtimeMinutes = r.dayOt + r.weekOt; d.extraMinutes = r.extra; }
    if (d.workMinutes > 0) t.workDays++;
    t.workMinutes += d.workMinutes;
    t.overtimeMinutes += r.dayOt + r.weekOt;
    t.weeklyOvertimeMinutes += r.weekOt;
    t.extraMinutes += r.extra;
    t.nightMinutes += d.nightMinutes;
    t.holidayMinutes += d.holidayMinutes;
    t.lateMinutes += d.lateMinutes;
    t.earlyMinutes += d.earlyMinutes;
    t.leaveDays += d.leaveDays;
    if (d.issues.includes('打刻がありません')) t.missingDays++;
  }
  for (const { days: settleDays, range: sr } of settle) {
    // 対象期間の段: 対象期間のすべての日で日と週の段を出し直し、総枠を超えた分を、終わりの日から（所定外・所定の順に）当てる
    const all = dayStage(settleDays.filter((d) => d.date <= sr.end));
    weekStage(all, weekStart, (wk) => wk >= sr.start && shiftDate(wk, 6) <= sr.end);
    const inRange = all.filter((r) => r.d.date >= sr.start);
    let over = Math.max(0, inRange.reduce((s, r) => s + r.schedPart + r.extra, 0) - annualCapMinutes(daysBetween(sr.start, sr.end)));
    for (const r of [...inRange].reverse()) {
      if (over <= 0) break;
      const fromExtra = Math.min(over, r.extra);
      over -= fromExtra;
      const fromSched = Math.min(over, r.schedPart);
      over -= fromSched;
      t.overtimeMinutes += fromExtra + fromSched;
      if (r.d.date >= period.start) {
        // この期間の所定外は時間外として払い、所定の中の分は割増だけを払う
        t.extraMinutes = Math.max(0, t.extraMinutes - fromExtra);
        t.overtimeWithinMinutes! += fromSched;
      } else {
        // 前の期間に払い済みの時間（所定・所定外）は、割増だけを払う
        t.overtimeWithinMinutes! += fromExtra + fromSched;
      }
    }
    t.annualSettled = true;
  }
  t.over60Minutes = Math.max(0, t.overtimeMinutes - OVER60);
  return t;
}

/** 点検の 1 つ（シフトの点検と同じ形）。 */
export interface AnnualIssue {
  code: 'day10' | 'week52' | 'streak' | 'days280' | 'cap' | 'week48';
  date?: string;
  text: string;
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 特定期間の日か（月日の範囲。年をまたぐ範囲も読む）。 */
export function inBusy(date: string, busy: HrAnnualSettings['busy']): boolean {
  const k = date.slice(5);
  return busy.some((b) => (b.from <= b.to ? k >= b.from && k <= b.to : k >= b.from || k <= b.to));
}

/**
 * 1 人の、1 年単位の変形労働時間制の所定の点検（止める点検）。
 *
 * @param shifts 対象期間の、これまでに決めたシフトと点検する期間のシフト（働く日だけ）
 * @param range 対象期間
 * @remarks 総枠と労働日の数は、決めた分だけで見る（決めていない先の月は 0）。超えたら止める
 */
export function checkAnnual(shifts: Pick<HrShift, 'date' | 'start' | 'end' | 'breakMinutes'>[], range: { start: string; end: string }, s: HrAnnualSettings, weekStart: number): AnnualIssue[] {
  const issues: AnnualIssue[] = [];
  const mins = new Map<string, number>();
  for (const x of shifts) {
    if (x.date < range.start || x.date > range.end) continue;
    mins.set(x.date, (mins.get(x.date) ?? 0) + (scheduledMinutes({ start: x.start, end: x.end, breakMinutes: x.breakMinutes }) ?? 0));
  }
  const dates = [...mins.keys()].sort();
  for (const d of dates) if (mins.get(d)! > 600) issues.push({ code: 'day10', date: d, text: `${md(d)} の所定が 10 時間を超えています` });
  // 週
  const weeks = new Map<string, number>();
  for (const d of dates) weeks.set(weekKey(d, weekStart), (weeks.get(weekKey(d, weekStart)) ?? 0) + mins.get(d)!);
  for (const [wk, m] of weeks) if (m > 3120) issues.push({ code: 'week52', date: wk, text: `${md(wk)} からの週の所定が 52 時間を超えています` });
  // 連続の労働（特定期間は 12 日まで）
  let streak = 0;
  let prev = '';
  for (const d of dates) {
    streak = prev && shiftDate(prev, 1) === d ? streak + 1 : 1;
    prev = d;
    const limit = inBusy(d, s.busy) ? 12 : 6;
    if (streak === limit + 1) issues.push({ code: 'streak', date: d, text: `${md(d)} まで ${limit + 1} 日続けて働きます（${limit === 12 ? '特定期間でも 12 日まで' : '6 日まで'}）` });
  }
  const total = daysBetween(range.start, range.end);
  const sum = [...mins.values()].reduce((a, b) => a + b, 0);
  const cap = annualCapMinutes(total);
  if (sum > cap + 0.001) issues.push({ code: 'cap', text: `所定の合計 ${(sum / 60).toFixed(1)} 時間が、対象期間の総枠 ${(cap / 60).toFixed(1)} 時間を超えています` });
  if (total > 92) {
    const limitDays = Math.floor((280 * total) / 365);
    if (dates.length > limitDays) issues.push({ code: 'days280', text: `労働日 ${dates.length} 日が、対象期間の上限 ${limitDays} 日（1 年あたり 280 日）を超えています` });
    // 48 時間を超える週: 3 週を超えて続けない。対象期間の始めから 3 か月ごとに 3 週まで
    const heavy = [...weeks.entries()].filter(([, m]) => m > 2880).map(([wk]) => wk).sort();
    let run = 0;
    let last = '';
    for (const wk of heavy) {
      run = last && shiftDate(last, 7) === wk ? run + 1 : 1;
      last = wk;
      if (run === 4) issues.push({ code: 'week48', date: wk, text: `48 時間を超える週が ${md(wk)} からの週で 4 週続きます（3 週まで）` });
    }
    for (let seg = range.start; seg <= range.end; seg = addMonths(seg, 3)) {
      const end = shiftDate(addMonths(seg, 3), -1);
      const n = heavy.filter((wk) => wk >= seg && wk <= end).length;
      if (n > 3) issues.push({ code: 'week48', date: seg, text: `${md(seg)} からの 3 か月に、48 時間を超える週が ${n} 週あります（3 週まで）` });
    }
  }
  return issues;
}

// ─── フレックスタイム制 ─────────────────────────────────────────────

/** 締め日の月（YYYY-MM）どうしの差（月）。 */
const monthDiff = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/**
 * 締めの期間（締め日の月）を含む清算期間の、最初と最後の締め日の月。
 *
 * @param month 締め日の月（YYYY-MM）
 */
export function flexMonthsOf(month: string, s: HrFlexSettings): { first: string; last: string; index: number; months: number } {
  const months = Math.min(3, Math.max(1, Math.round(s.months || 1)));
  if (months === 1 || !/^\d{4}-\d{2}$/.test(s.startMonth)) return { first: month, last: month, index: 0, months: 1 };
  const index = ((monthDiff(s.startMonth, month) % months) + months) % months;
  const shift = (m: string, n: number) => addMonths(`${m}-01`, n).slice(0, 7);
  return { first: shift(month, -index), last: shift(month, months - 1 - index), index, months };
}

/** フレックスの 1 か月分の入力。 */
export interface FlexMonth {
  period: Pick<AttPeriod, 'start' | 'end'>;
  days: AttDay[];
}

/**
 * フレックスタイム制の、締めの期間の集計。
 *
 * @param months 清算期間の、いまの期間までの締めの期間（古い順。最後がいまの期間）
 * @param settlement 清算期間の範囲
 * @param baseMinutes 清算期間に働く所定の時間（会社の労働日 × 1 日の標準の時間。総枠まで）
 * @param carried 前の清算期間から繰り越した、足りなかった時間（分）
 * @param last いまの期間が清算期間の最後か
 * @param special44 特例措置対象事業場（清算期間が 1 か月のときだけ 44 時間）
 */
export function flexTotals(
  months: FlexMonth[], settlement: { start: string; end: string }, s: HrFlexSettings, baseMinutes: number, carried: number, last: boolean, special44 = false,
): { totals: AttTotals; carryNext: number } {
  const cur = months[months.length - 1]!;
  const t = emptyTotals();
  const workOf = (ds: AttDay[]) => ds.filter((d) => d.type !== 'legal-holiday').reduce((n, d) => n + d.workMinutes, 0);
  for (const d of cur.days) {
    if (d.date < cur.period.start || d.date > cur.period.end) continue;
    // 遅刻・早退・時間ごとの時間外は数えない（清算期間でまとめて見る）
    d.lateMinutes = 0; d.earlyMinutes = 0; d.overtimeMinutes = 0; d.extraMinutes = 0;
    if (d.workMinutes > 0) t.workDays++;
    t.workMinutes += d.workMinutes;
    t.nightMinutes += d.nightMinutes;
    t.holidayMinutes += d.holidayMinutes;
    t.leaveDays += d.leaveDays;
  }
  const monthsN = flexMonthCount(s);
  const cap = monthsN === 1 ? variableCapMinutes(daysBetween(settlement.start, settlement.end), special44) : annualCapMinutes(daysBetween(settlement.start, settlement.end));
  const over50 = (m: FlexMonth) => (monthsN === 1 ? 0 : Math.max(0, workOf(m.days.filter((d) => d.date >= m.period.start && d.date <= m.period.end))
    - Math.floor((50 * daysBetween(m.period.start, m.period.end) / 7) * 60)));
  const worked = months.reduce((n, m) => n + workOf(m.days.filter((d) => d.date >= m.period.start && d.date <= m.period.end)), 0);
  const base = Math.min(baseMinutes, cap);
  // 繰り越しは総枠の中だけ（所定と繰り越しの合計が総枠を超えない）
  const carry = Math.min(carried, Math.max(0, cap - base));
  const required = base + carry;
  let carryNext = 0;
  if (monthsN > 1) t.overtimeMinutes += over50(cur);
  if (last) {
    const paid50 = months.reduce((n, m) => n + over50(m), 0);
    const settleOt = Math.max(0, worked - cap - paid50);
    t.overtimeMinutes += settleOt;
    // 総枠までのうち所定を超えた時間（法定内の所定外）。月 50 時間を超えて時間外にした分は除く
    t.extraMinutes = Math.max(0, Math.min(worked - paid50, cap) - required);
    const short = Math.max(0, required - worked);
    if (s.shortfall === 'carry') {
      carryNext = Math.min(short, Math.max(0, cap - base));
      // 総枠の中で繰り越せない分は差し引く
      t.flexShortMinutes = short - carryNext;
    } else {
      t.flexShortMinutes = short;
    }
  }
  t.over60Minutes = Math.max(0, t.overtimeMinutes - OVER60);
  const status: AttFlexStatus = { periodStart: settlement.start, periodEnd: settlement.end, workedMinutes: worked, requiredMinutes: required, capMinutes: cap, carriedMinutes: carry };
  t.flex = status;
  return { totals: t, carryNext };
}

/** 清算期間の月の数（1〜3）。 */
export const flexMonthCount = (s: HrFlexSettings): number => Math.min(3, Math.max(1, Math.round(s.months || 1)));

/**
 * コアタイムに勤務していない日の指摘（遅刻・早退として数えず、記録はする）。
 *
 * @returns 指摘の文。コアタイムが無い・働かなかった日・休みの日は `null`
 */
export function coreTimeIssue(day: AttDay, s: HrFlexSettings): string | null {
  if (!s.core || day.type !== 'workday' || day.workMinutes === 0 || !day.in) return null;
  const late = day.in > s.core.start;
  const early = !!day.out && day.out < s.core.end;
  return late || early ? `コアタイム（${s.core.start}〜${s.core.end}）に勤務していない時間があります` : null;
}
