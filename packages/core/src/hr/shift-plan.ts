/**
 * @file シフトの案づくりと点検（仕様書 第30.6.2節）。決まったプログラムで、日ごとに要る人数を、本人の休みの希望・連続の勤務・
 * 週の所定労働日数・変形労働時間制の総枠（使わなければ 1 日 8 時間・週 40 時間）を守って割り当てる。副作用を持たない。
 *
 * 割り当ては、その期間に入った日の割合が少ない人から（同じなら、その型に入った回数が少ない人から）。足りない枠は点検で示す。
 */

import type { HrShift, HrShiftPattern, HrShiftSettings, ShiftIssue } from '@m2office/shared';
import { isJapaneseHoliday } from './holidays.js';
import { scheduledMinutes, shiftDate, variableCapMinutes, weekday } from './attendance.js';

/** 案づくりと点検の、シフトに入る人。 */
export interface PlanMember {
  employeeId: string;
  name: string;
  weeklyDays: number | null;
  weeklyHours: number | null;
  hiredOn: string | null;
  leftOn: string | null;
}

/** 案づくりと点検の入力。 */
export interface PlanInput {
  days: string[];
  members: PlanMember[];
  settings: HrShiftSettings;
  /** 本人の休みの希望（`${employeeId}|${date}`）。 */
  requests: Set<string>;
  /** 週の起算日（0=日曜）。 */
  weekStart: number;
}

/** 連続して働ける日数（週に 1 日の休みを守るため 6 日まで）。 */
export const MAX_STREAK = 6;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 型の所定の時間（分）。 */
export const patternMinutes = (p: Pick<HrShiftPattern, 'start' | 'end' | 'breakMinutes'>) => scheduledMinutes({ start: p.start, end: p.end, breakMinutes: p.breakMinutes }) ?? 0;

/** 変形労働時間制の総枠（分。週 40 時間 × 期間の暦日数 ÷ 7 の 0.1 時間未満を切り捨て。特例は 44 時間）。 */
export function variableCap(days: number, special44: boolean): number {
  return variableCapMinutes(days, special44);
}

/** その日に要る人数（曜日か、祝日の決まりがあれば祝日の分）。 */
export function needsOn(date: string, settings: HrShiftSettings): { patternId: string; count: number }[] {
  const holiday = isJapaneseHoliday(date) && settings.needs.some((n) => n.day === 7);
  const key = holiday ? 7 : weekday(date);
  return settings.needs.filter((n) => n.day === key && n.count > 0).map((n) => ({ patternId: n.patternId, count: n.count }));
}

/** 週の目印（起算日の日付）。 */
const weekKey = (date: string, weekStart: number) => shiftDate(date, -((weekday(date) - weekStart + 7) % 7));

/** 在籍している日か。 */
const employed = (m: PlanMember, d: string) => (!m.hiredOn || m.hiredOn <= d) && (!m.leftOn || m.leftOn >= d);

/** 1 人の期間の上限（分）: 変形なら総枠、無ければ無し。週の所定労働時間があれば、それを期間にならした分まで。 */
function periodLimit(m: PlanMember, input: PlanInput): number {
  const n = input.days.length;
  const cap = input.settings.variable ? variableCap(n, input.settings.special44) : Infinity;
  return m.weeklyHours ? Math.min(cap, (m.weeklyHours * 60 * n) / 7) : cap;
}

/**
 * シフトの案を作る。
 *
 * @returns 働く日のシフト（休みの日は持たない）
 */
export function generatePlan(input: PlanInput): HrShift[] {
  const { settings } = input;
  const patterns = new Map(settings.patterns.map((p) => [p.id, p]));
  const n = input.days.length;
  const state = new Map(input.members.map((m) => [m.employeeId, {
    days: 0, minutes: 0, streak: 0, lastDate: '', week: '', weekDays: 0, weekMinutes: 0, byPattern: new Map<string, number>(), limit: periodLimit(m, input),
    target: ((m.weeklyDays ?? 5) * n) / 7,
  }]));
  const out: HrShift[] = [];
  for (const d of input.days) {
    const wk = weekKey(d, input.weekStart);
    for (const s of state.values()) {
      if (s.week !== wk) { s.week = wk; s.weekDays = 0; s.weekMinutes = 0; }
      // 前の日に働いていなければ、連続の勤務は途切れる
      if (s.lastDate !== shiftDate(d, -1)) s.streak = 0;
    }
    const taken = new Set<string>();
    const needs = needsOn(d, settings).map((x) => ({ ...x, p: patterns.get(x.patternId) })).filter((x) => x.p).sort((a, b) => a.p!.start.localeCompare(b.p!.start));
    for (const need of needs) {
      const p = need.p!;
      const pm = patternMinutes(p);
      const ok = input.members.filter((m) => {
        const s = state.get(m.employeeId)!;
        if (!employed(m, d) || taken.has(m.employeeId) || input.requests.has(`${m.employeeId}|${d}`)) return false;
        if (s.streak >= MAX_STREAK || s.weekDays >= (m.weeklyDays ?? 5)) return false;
        if (s.minutes + pm > s.limit + 0.001) return false;
        if (!settings.variable && (pm > 480 || s.weekMinutes + pm > Math.min(2400, m.weeklyHours ? m.weeklyHours * 60 : 2400))) return false;
        return true;
      }).sort((a, b) => {
        const sa = state.get(a.employeeId)!;
        const sb = state.get(b.employeeId)!;
        return sa.days / sa.target - sb.days / sb.target || (sa.byPattern.get(p.id) ?? 0) - (sb.byPattern.get(p.id) ?? 0) || a.employeeId.localeCompare(b.employeeId);
      });
      for (const m of ok.slice(0, need.count)) {
        const s = state.get(m.employeeId)!;
        taken.add(m.employeeId);
        s.days++; s.minutes += pm; s.weekDays++; s.weekMinutes += pm; s.streak++; s.lastDate = d;
        s.byPattern.set(p.id, (s.byPattern.get(p.id) ?? 0) + 1);
        out.push({ employeeId: m.employeeId, date: d, patternId: p.id, start: p.start, end: p.end, breakMinutes: p.breakMinutes });
      }
    }
  }
  return out;
}

/**
 * シフトを点検する（足りない人数・休みの希望に入れた日・休みの無い週・変形労働時間制の総枠・8 時間と 40 時間）。
 */
export function checkPlan(input: PlanInput, shifts: HrShift[]): ShiftIssue[] {
  const { settings } = input;
  const issues: ShiftIssue[] = [];
  const patterns = new Map(settings.patterns.map((p) => [p.id, p]));
  const by = new Map<string, HrShift>();
  for (const s of shifts) if (s.patternId) by.set(`${s.employeeId}|${s.date}`, s);
  const minutes = (s: HrShift) => scheduledMinutes({ start: s.start, end: s.end, breakMinutes: s.breakMinutes }) ?? 0;
  // 足りない人数
  for (const d of input.days) {
    for (const need of needsOn(d, settings)) {
      const have = shifts.filter((s) => s.date === d && s.patternId === need.patternId).length;
      if (have < need.count) issues.push({ level: 'check', code: 'short', date: d, text: `${md(d)} の${patterns.get(need.patternId)?.name ?? '勤務'}が ${need.count - have} 人足りません` });
    }
  }
  const n = input.days.length;
  for (const m of input.members) {
    const who = { employeeId: m.employeeId };
    const mine = input.days.map((d) => by.get(`${m.employeeId}|${d}`) ?? null);
    for (const [i, s] of mine.entries()) {
      if (s && input.requests.has(`${m.employeeId}|${input.days[i]}`)) issues.push({ level: 'check', code: 'request', date: input.days[i], text: `${m.name}さんの休みの希望の日（${md(input.days[i]!)}）に勤務を入れています`, ...who });
    }
    // 7 日続けて働く日がある（週に 1 日の休みが取れない）
    let streak = 0;
    for (const [i, s] of mine.entries()) {
      streak = s ? streak + 1 : 0;
      if (streak === MAX_STREAK + 1) issues.push({ level: 'stop', code: 'no-rest', date: input.days[i], text: `${m.name}さんが ${md(input.days[i]!)} まで 7 日続けて働きます（週に 1 日の休みが要ります）`, ...who });
    }
    const total = mine.reduce((sum, s) => sum + (s ? minutes(s) : 0), 0);
    if (settings.variable) {
      const cap = variableCap(n, settings.special44);
      if (total > cap + 0.001) issues.push({ level: 'stop', code: 'cap', text: `${m.name}さんの所定の時間の合計 ${(total / 60).toFixed(1)} 時間が、変形労働時間制の総枠 ${(cap / 60).toFixed(1)} 時間を超えています`, ...who });
    } else {
      const weeks = new Map<string, number>();
      for (const [i, s] of mine.entries()) {
        if (!s) continue;
        const mm = minutes(s);
        if (mm > 480) issues.push({ level: 'check', code: 'day8', date: input.days[i], text: `${m.name}さんの ${md(input.days[i]!)} の所定が 8 時間を超えています（変形労働時間制を使わない会社では時間外になります）`, ...who });
        const wk = weekKey(input.days[i]!, input.weekStart);
        weeks.set(wk, (weeks.get(wk) ?? 0) + mm);
      }
      for (const [wk, mm] of weeks) if (mm > 2400) issues.push({ level: 'check', code: 'week40', date: wk, text: `${m.name}さんの ${md(wk)} からの週の所定が 40 時間を超えています（時間外になります）`, ...who });
    }
  }
  return [...issues.filter((x) => x.level === 'stop'), ...issues.filter((x) => x.level === 'check')];
}
