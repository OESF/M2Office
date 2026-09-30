/**
 * @file 勤怠の集計（仕様書 第30.6.1節）。打刻から日・週・期間の時間を、決まったプログラムで出す（H-1。推論に数えさせない）。
 *
 * 時刻は日本時間で扱う。日をまたぐ勤務は出勤した日の分にする。
 * 法定外は「1 日 8 時間を超えた分」と「週 40 時間を超えた分（日の法定外を除く）」の和。週の分は 40 時間を超えた日に数える。
 */

import type { AttDay, AttDayType, AttPeriod, AttPunch, AttTotals, HrSettings } from '@m2office/shared';
import { isJapaneseHoliday } from './holidays.js';

const MIN = 60_000;
const JST = 9 * 3_600_000;
/** 1 日の法定労働時間（分）。 */
export const DAILY_LIMIT = 480;
/** 1 週の法定労働時間（分）。 */
export const WEEKLY_LIMIT = 2400;
/** 月 60 時間（分）。これを超えた法定外は割増率が上がる。 */
export const OVER60 = 3600;
/** 長すぎる勤務として示す 1 日の実労働（分）。 */
export const LONG_DAY = 720;

/** 日本時間の日付（YYYY-MM-DD）。 */
export const jstDate = (iso: string | number | Date): string => new Date(new Date(iso).getTime() + JST).toISOString().slice(0, 10);
/** 日本時間の時刻（HH:MM）。 */
export const jstTime = (iso: string): string => new Date(new Date(iso).getTime() + JST).toISOString().slice(11, 16);
/** 日本時間の日付と時刻から、その瞬間（ミリ秒）。 */
const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`);
/** 日付の曜日（0=日曜）。 */
export const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
/** 日付に日数を足す。 */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 重なりの長さ（ミリ秒）。 */
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** 日の区分（会社の所定の労働日と法定休日、祝日を休みにするか）。祝日は所定休日（法定休日ではない）。 */
export function dayType(date: string, work: HrSettings['work']): AttDayType {
  const w = weekday(date);
  if (w === work.legalHoliday) return 'legal-holiday';
  if (work.nationalHolidays !== false && isJapaneseHoliday(date)) return 'dayoff';
  return work.weekdays.includes(w) ? 'workday' : 'dayoff';
}

/** 1 日の所定（雇用条件の始業・終業・休憩）。 */
export interface DaySchedule {
  start: string | null;
  end: string | null;
  breakMinutes: number | null;
}

/** 所定の労働時間（分）。始業・終業が無ければ `null`。 */
export function scheduledMinutes(s: DaySchedule): number | null {
  if (!s.start || !s.end || !/^\d{1,2}:\d{2}$/.test(s.start) || !/^\d{1,2}:\d{2}$/.test(s.end)) return null;
  const [sh, sm] = s.start.split(':').map(Number) as [number, number];
  const [eh, em] = s.end.split(':').map(Number) as [number, number];
  let m = eh * 60 + em - (sh * 60 + sm);
  if (m <= 0) m += 1440;
  return Math.max(0, m - (s.breakMinutes ?? 0));
}

/**
 * 1 日の集計。
 *
 * @param punches その日に出勤した分の打刻（時刻の順）
 * @param leaveDays その日に取った有給（0・0.5・1）
 * @param today 今日（打刻の無い所定の労働日を、過ぎた日だけ指摘するため）
 */
export function summarizeDay(date: string, punches: AttPunch[], type: AttDayType, schedule: DaySchedule, leaveDays: number, today: string): AttDay {
  const day: AttDay = {
    date, type, in: null, out: null, breakMinutes: 0, workMinutes: 0, nightMinutes: 0, overtimeMinutes: 0, extraMinutes: 0,
    holidayMinutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays, issues: [],
  };
  const inP = punches.find((p) => p.kind === 'in');
  if (!inP) {
    if (punches.length) day.issues.push('出勤の打刻がありません');
    else if (type === 'workday' && leaveDays < 1 && date < today) day.issues.push('打刻がありません');
    return day;
  }
  const outP = [...punches].reverse().find((p) => p.kind === 'out' && Date.parse(p.at) > Date.parse(inP.at));
  day.in = inP.at;
  day.out = outP?.at ?? null;
  if (!outP) {
    if (date < today) day.issues.push('退勤の打刻がありません');
    return day;
  }
  const t0 = Date.parse(inP.at);
  const t1 = Date.parse(outP.at);
  // 休憩は始めと終わりを順に組にする。終わりの無い休憩は数えずに指摘する
  const breaks: [number, number][] = [];
  let open: number | null = null;
  for (const p of punches) {
    const t = Date.parse(p.at);
    if (p.kind === 'break_start') open = t;
    else if (p.kind === 'break_end' && open !== null) { breaks.push([open, t]); open = null; }
  }
  if (open !== null) day.issues.push('休憩の終わりの打刻がありません');
  const breakMs = breaks.reduce((s, [a, b]) => s + overlap(a, b, t0, t1), 0);
  day.breakMinutes = Math.round(breakMs / MIN);
  day.workMinutes = Math.max(0, Math.round((t1 - t0 - breakMs) / MIN));
  // 深夜（22 時〜5 時）。休憩の重なりは除く
  let nightMs = 0;
  for (let k = -1; k <= 1; k++) {
    const d = shiftDate(date, k);
    const n0 = at(d, '22:00');
    const n1 = at(shiftDate(d, 1), '05:00');
    nightMs += overlap(t0, t1, n0, n1) - breaks.reduce((s, [a, b]) => s + overlap(Math.max(a, t0), Math.min(b, t1), n0, n1), 0);
  }
  day.nightMinutes = Math.max(0, Math.round(nightMs / MIN));
  if (type === 'legal-holiday') {
    // 法定休日の労働は時間外に数えず、休日の労働として別に持つ
    day.holidayMinutes = day.workMinutes;
  } else {
    day.overtimeMinutes = Math.max(0, day.workMinutes - DAILY_LIMIT);
    const sched = type === 'workday' ? scheduledMinutes(schedule) : 0;
    if (sched !== null) day.extraMinutes = Math.max(0, Math.min(day.workMinutes, DAILY_LIMIT) - sched);
  }
  if (type === 'workday' && schedule.start && /^\d{1,2}:\d{2}$/.test(schedule.start)) day.lateMinutes = Math.max(0, Math.round((t0 - at(date, schedule.start.padStart(5, '0'))) / MIN));
  if (type === 'workday' && schedule.end && /^\d{1,2}:\d{2}$/.test(schedule.end)) day.earlyMinutes = Math.max(0, Math.round((at(date, schedule.end.padStart(5, '0')) - t1) / MIN));
  if (day.workMinutes > 480 && day.breakMinutes < 60) day.issues.push('休憩が足りません（8 時間を超えたら 60 分）');
  else if (day.workMinutes > 360 && day.breakMinutes < 45) day.issues.push('休憩が足りません（6 時間を超えたら 45 分）');
  if (day.workMinutes > LONG_DAY) day.issues.push('勤務が 12 時間を超えています');
  return day;
}

/**
 * 週 40 時間を超えた分を、超えた日に数える（日の法定外と法定休日の労働は除く）。
 *
 * @param days 日の集計（日付の順。週の途中から始まってもよい）
 * @returns 日付ごとの、週の法定外（分）
 */
export function weeklyOvertime(days: AttDay[], weekStart: number): Map<string, number> {
  const out = new Map<string, number>();
  let key = '';
  let sum = 0;
  for (const d of days) {
    // 週の起算日の日付を週の目印にする
    const back = (weekday(d.date) - weekStart + 7) % 7;
    const wk = shiftDate(d.date, -back);
    if (wk !== key) { key = wk; sum = 0; }
    if (d.type === 'legal-holiday') continue;
    const base = d.workMinutes - d.overtimeMinutes;
    const before = sum;
    sum += base;
    const over = Math.max(0, sum - Math.max(WEEKLY_LIMIT, before));
    if (over > 0) out.set(d.date, over);
  }
  return out;
}

/**
 * 期間の集計。週の法定外を正しく数えるため、`days` には期間の前の同じ週の日を含めてよい（期間の外の日は数えない）。
 */
export function periodTotals(days: AttDay[], period: Pick<AttPeriod, 'start' | 'end'>, weekStart: number): AttTotals {
  const weekly = weeklyOvertime(days, weekStart);
  const t: AttTotals = {
    workDays: 0, workMinutes: 0, overtimeMinutes: 0, weeklyOvertimeMinutes: 0, extraMinutes: 0, nightMinutes: 0, holidayMinutes: 0,
    over60Minutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, missingDays: 0,
  };
  for (const d of days) {
    if (d.date < period.start || d.date > period.end) continue;
    if (d.workMinutes > 0) t.workDays++;
    t.workMinutes += d.workMinutes;
    const w = weekly.get(d.date) ?? 0;
    t.weeklyOvertimeMinutes += w;
    t.overtimeMinutes += d.overtimeMinutes + w;
    // 所定外のうち週の法定外に当たる分は、法定外として数える（二重に数えない）
    t.extraMinutes += Math.max(0, d.extraMinutes - w);
    t.nightMinutes += d.nightMinutes;
    t.holidayMinutes += d.holidayMinutes;
    t.lateMinutes += d.lateMinutes;
    t.earlyMinutes += d.earlyMinutes;
    t.leaveDays += d.leaveDays;
    if (d.issues.includes('打刻がありません')) t.missingDays++;
  }
  t.over60Minutes = Math.max(0, t.overtimeMinutes - OVER60);
  return t;
}

/**
 * 1 か月単位の変形労働時間制の総枠（分）。週 40 時間（特例は 44 時間）× 期間の暦日数 ÷ 7 を、公式の表のとおり 0.1 時間未満を切り捨てる
 * （31 日なら 177.1 時間。厚生労働省「1箇月単位の変形労働時間制」・モデル就業規則。第30.6.2節）。
 */
export function variableCapMinutes(days: number, special44 = false): number {
  const hoursCap = Math.floor((((special44 ? 44 : 40) * days) / 7) * 10 + 1e-9) / 10;
  return Math.round(hoursCap * 60);
}

/**
 * 1 か月単位の変形労働時間制の期間の集計（昭63.1.1基発1号の 3 段）。所定は日ごとの `scheduledMinutes`（休みは 0）。
 *
 * 1. 日: 所定が 8 時間を超える日はその所定を、それ以外の日は 8 時間を超えた分
 * 2. 週: 暦週（週の起算日から 7 日）のうち期間に丸ごと入る週で、所定が 40 時間を超える週はその所定を、それ以外の週は 40 時間を超えた分
 *    （1 を除く）。所定を超えて働いた分から、週の終わりに近い日の分を先に当てる。期間の始めと終わりの 7 日に満たない週は 3 で見る
 * 3. 期間: 総枠を超えた分（1・2 を除く）。期間の終わりの日から、所定を超えた分・所定の分の順に当てる。所定の中の分は割増だけを払う
 *
 * 法定休日の労働は時間外に数えない。`days` の日は書き換える（日ごとの法定外と所定外を、3 段の結果にする）。
 */
export function variableTotals(days: AttDay[], period: Pick<AttPeriod, 'start' | 'end'>, weekStart: number, capMinutes: number): AttTotals {
  const inPeriod = days.filter((d) => d.date >= period.start && d.date <= period.end);
  const row = inPeriod.map((d) => {
    const sched = d.type === 'legal-holiday' ? 0 : d.scheduledMinutes ?? 0;
    const work = d.type === 'legal-holiday' ? 0 : d.workMinutes;
    const dayOt = Math.max(0, work - Math.max(sched, DAILY_LIMIT));
    const nonOt = work - dayOt;
    const schedPart = Math.min(nonOt, sched);
    return { d, sched, dayOt, weekOt: 0, periodOt: 0, within: 0, schedPart, extra: nonOt - schedPart };
  });
  // 2. 週（期間に丸ごと入る暦週だけ）
  const byWeek = new Map<string, typeof row>();
  for (const r of row) {
    const wk = shiftDate(r.d.date, -((weekday(r.d.date) - weekStart + 7) % 7));
    byWeek.set(wk, [...(byWeek.get(wk) ?? []), r]);
  }
  for (const [wk, rs] of byWeek) {
    if (wk < period.start || shiftDate(wk, 6) > period.end) continue;
    const limit = Math.max(rs.reduce((s, r) => s + r.sched, 0), WEEKLY_LIMIT);
    let over = Math.max(0, rs.reduce((s, r) => s + r.schedPart + r.extra, 0) - limit);
    for (const r of [...rs].reverse()) {
      const take = Math.min(over, r.extra);
      r.extra -= take; r.weekOt += take; over -= take;
    }
  }
  // 3. 期間の総枠
  let over = Math.max(0, row.reduce((s, r) => s + r.schedPart + r.extra, 0) - capMinutes);
  for (const r of [...row].reverse()) {
    if (over <= 0) break;
    const fromExtra = Math.min(over, r.extra);
    r.extra -= fromExtra; r.periodOt += fromExtra; over -= fromExtra;
    const fromSched = Math.min(over, r.schedPart);
    r.schedPart -= fromSched; r.periodOt += fromSched; r.within += fromSched; over -= fromSched;
  }
  const t: AttTotals = {
    workDays: 0, workMinutes: 0, overtimeMinutes: 0, weeklyOvertimeMinutes: 0, extraMinutes: 0, nightMinutes: 0, holidayMinutes: 0,
    over60Minutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, missingDays: 0, overtimeWithinMinutes: 0,
  };
  for (const r of row) {
    const d = r.d;
    if (d.type !== 'legal-holiday') { d.overtimeMinutes = r.dayOt + r.weekOt + r.periodOt; d.extraMinutes = r.extra; }
    if (d.workMinutes > 0) t.workDays++;
    t.workMinutes += d.workMinutes;
    t.overtimeMinutes += r.dayOt + r.weekOt + r.periodOt;
    t.weeklyOvertimeMinutes += r.weekOt;
    t.overtimeWithinMinutes! += r.within;
    t.extraMinutes += r.extra;
    t.nightMinutes += d.nightMinutes;
    t.holidayMinutes += d.holidayMinutes;
    t.lateMinutes += d.lateMinutes;
    t.earlyMinutes += d.earlyMinutes;
    t.leaveDays += d.leaveDays;
    if (d.issues.includes('打刻がありません')) t.missingDays++;
  }
  t.over60Minutes = Math.max(0, t.overtimeMinutes - OVER60);
  return t;
}

/**
 * 締めの期間（締め日から）。`month` の締め日で終わる期間を返す。
 *
 * @param month 締め日の月（YYYY-MM）
 * @remarks 締め日の 31 は末日
 */
export function periodOf(month: string, closingDay: number): AttPeriod {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const end = dayIn(y, m - 1, closingDay);
  const prev = dayIn(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, closingDay);
  return { start: shiftDate(prev, 1), end, label: `${y} 年 ${m} 月分` };
}

/** その日を含む締めの期間。 */
export function periodContaining(date: string, closingDay: number): AttPeriod {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const here = periodOf(`${y}-${String(m).padStart(2, '0')}`, closingDay);
  if (date <= here.end && date >= here.start) return here;
  const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return periodOf(nm, closingDay);
}

function dayIn(y: number, m0: number, day: number): string {
  const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m0, Math.min(day, last))).toISOString().slice(0, 10);
}

/** 36 協定の知らせ 1 つ。`key` は同じ段階を二度知らせないための印。 */
export interface AgreementAlert {
  key: string;
  level: 'near' | 'over';
  text: string;
}

const h = (m: number) => Math.round((m / 60) * 10) / 10;

/**
 * 36 協定への接近と超過（第30.6.1節）。
 *
 * @param months 対象期間の始まりからの期間ごとの集計（古い順。最後がいまの期間）
 */
export function agreementAlerts(months: { label: string; totals: AttTotals }[], a: HrSettings['agreement']): AgreementAlert[] {
  if (!a.enabled || months.length === 0) return [];
  const out: AgreementAlert[] = [];
  const cur = months[months.length - 1]!;
  const ot = cur.totals.overtimeMinutes;
  const year = months.reduce((s, x) => s + x.totals.overtimeMinutes, 0);
  const push = (key: string, level: 'near' | 'over', text: string) => out.push({ key: `${cur.label}:${key}:${level}`, level, text });
  const monthly = a.monthly * 60;
  const yearly = a.yearly * 60;
  if (ot >= monthly) push('month', 'over', `${cur.label}の法定外が ${h(ot)} 時間で、協定の月 ${a.monthly} 時間を超えました`);
  else if (ot >= monthly * 0.8) push('month', 'near', `${cur.label}の法定外が ${h(ot)} 時間で、協定の月 ${a.monthly} 時間に近づいています`);
  if (year >= yearly) push('year', 'over', `今年度の法定外が ${h(year)} 時間で、協定の年 ${a.yearly} 時間を超えました`);
  else if (year >= yearly * 0.8) push('year', 'near', `今年度の法定外が ${h(year)} 時間で、協定の年 ${a.yearly} 時間に近づいています`);
  if (a.special) {
    const withHoliday = ot + cur.totals.holidayMinutes;
    if (withHoliday >= 6000) push('100', 'over', `${cur.label}の法定外と休日の労働が ${h(withHoliday)} 時間で、月 100 時間の上限に達しました`);
    else if (withHoliday >= 4800) push('100', 'near', `${cur.label}の法定外と休日の労働が ${h(withHoliday)} 時間で、月 100 時間に近づいています`);
    for (let n = 2; n <= 6 && n <= months.length; n++) {
      const avg = months.slice(-n).reduce((s, x) => s + x.totals.overtimeMinutes + x.totals.holidayMinutes, 0) / n;
      if (avg > 4800) { push(`avg${n}`, 'over', `直近 ${n} か月の平均が ${h(avg)} 時間で、80 時間を超えています`); break; }
    }
    if (year >= 43200) push('720', 'over', `今年度の法定外が ${h(year)} 時間で、年 720 時間の上限に達しました`);
    const over45 = months.filter((x) => x.totals.overtimeMinutes > 2700).length;
    if (over45 > 6) push('times', 'over', `月 45 時間を超えた月が ${over45} 回で、年 6 回を超えました`);
    else if (over45 === 6 && ot > 2700) push('times', 'near', '月 45 時間を超えた月が 6 回になりました（年 6 回まで）');
  }
  return out;
}
