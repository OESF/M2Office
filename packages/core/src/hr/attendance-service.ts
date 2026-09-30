/**
 * @file 勤怠と休暇の処理（仕様書 第30.6.1節・第30.7.1節。人事・給与の段 2）。
 *
 * 打刻・直し・集計・締め・36 協定の見張り・出勤簿と、有給の付与・残り・申請・取得義務・管理簿。
 * 時間と日数は決まったプログラムで出す（attendance.ts・leave.ts）。本人の分は本人の画面と秘書から、他人の分は人事区画の担当者だけが扱う。
 * 知らせは種類「勤怠」で、本人と人事区画の人に送る（本人が切っていれば送らない）。
 */

import { randomUUID } from 'node:crypto';
import {
  ATT_PUNCH_LABELS, HR_COMPARTMENT,
  type AttClose, type AttDay, type AttPeriod, type AttPunch, type AttPunchKind, type AttTotals, type AuditEvent,
  type HrEmployee, type HrSettings, type HrTerms, type LeaveBalance, type LeaveGrant, type LeaveTake,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { ShiftStore } from './shift-store.js';
import type { HrStore } from './store.js';
import type { AttendanceStore } from './attendance-store.js';
import {
  agreementAlerts, dayType, jstDate, jstTime, periodContaining, periodOf, periodTotals, scheduledMinutes, shiftDate, summarizeDay, variableCapMinutes, variableTotals, weekday,
} from './attendance.js';
import { addMonths, dueGrantDates, grantDays, leaveBalance } from './leave.js';

/** 本人の打刻の状態。 */
export type AttState = { state: 'off' | 'working' | 'break'; since: string | null };

/** 日を直すときの入力（時刻は日本時間の HH:MM。退勤が出勤より前なら翌日）。 */
export interface DayFix {
  in: string;
  out: string | null;
  breaks: { start: string; end: string }[];
}

/** 期間の従業員ごとの集計の行（担当者の画面）。 */
export interface AttSummaryRow {
  employeeId: string;
  name: string;
  totals: AttTotals;
  issues: number;
  alerts: string[];
}

/** 勤怠と休暇の処理に要るもの。 */
export interface AttendanceServiceDeps {
  store: AttendanceStore;
  hrStore: HrStore;
  repo: Repository;
  /** 公開したシフト（シフトの人の所定の始業・終業と休み。第30.6.2節）。 */
  shiftStore?: ShiftStore;
  now?: () => Date;
}

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** 日本時間の日付と時刻から ISO。 */
const isoAt = (date: string, hm: string) => new Date(Date.parse(`${date}T${hm.padStart(5, '0')}:00+09:00`)).toISOString();

/**
 * 勤怠と休暇。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。本人か人事区画かの確かめは呼ぶ側（API・秘書）が行う
 */
export class AttendanceService {
  constructor(readonly deps: AttendanceServiceDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private today(): string {
    return jstDate(this.now());
  }

  async settings(tenantId: string): Promise<HrSettings> {
    return (await this.deps.repo.getTenantSettings(tenantId)).hr;
  }

  // ---- 本人 ----

  /**
   * 利用者に結び付いた従業員。結び付いていなければ、同じメールアドレスの従業員に自動で結び付ける（人に結び付けさせない。ADR-0028）。
   *
   * @returns 人事・給与を使っていない会社・台帳に載っていない人は `null`
   */
  async selfEmployee(tenantId: string, userId: string): Promise<HrEmployee | null> {
    const settings = await this.settings(tenantId);
    if (!settings.enabled) return null;
    const linked = await this.deps.hrStore.findEmployeeByUser(tenantId, userId);
    if (linked) return linked;
    const user = await this.deps.repo.findUserById(tenantId, userId);
    const email = user?.email?.trim().toLowerCase();
    if (!email) return null;
    const match = (await this.deps.hrStore.listEmployees(tenantId)).filter((e) => !e.userId && e.email.trim().toLowerCase() === email);
    if (match.length !== 1) return null;
    const e = match[0]!;
    const { updatedAt: _u, ...rec } = e;
    await this.deps.hrStore.updateEmployee(tenantId, { ...rec, userId }, userId);
    await this.audit(tenantId, userId, 'hr.employee.link', 'hr_employee', e.id, { by: 'email' });
    return { ...e, userId };
  }

  /** いまの打刻の状態（最後の打刻から）。 */
  async state(tenantId: string, employeeId: string): Promise<AttState> {
    const last = await this.deps.store.lastPunch(tenantId, employeeId);
    if (!last || last.kind === 'out') return { state: 'off', since: last?.at ?? null };
    // 出勤から 24 時間を過ぎても退勤が無ければ、打ち忘れとして次の出勤を受け付ける
    if (this.now().getTime() - Date.parse(last.at) > 24 * 3_600_000) return { state: 'off', since: null };
    return { state: last.kind === 'break_start' ? 'break' : 'working', since: last.at };
  }

  /** その日が締めた期間の中か。 */
  async isClosed(tenantId: string, date: string): Promise<AttClose | null> {
    const closes = await this.deps.store.listCloses(tenantId);
    return closes.find((c) => c.status === 'closed' && c.periodStart <= date && date <= c.periodEnd) ?? null;
  }

  /**
   * 打刻する（本人の画面・スマホ・秘書）。いまの状態から、できない打刻は断る。
   *
   * @returns 打刻と、そのあとの状態。退勤のあとは 36 協定を見直す
   */
  async punch(tenantId: string, actorUserId: string, employee: HrEmployee, kind: AttPunchKind, source: AttPunch['source']): Promise<{ punch: AttPunch; state: AttState } | { error: string }> {
    const st = await this.state(tenantId, employee.id);
    const bad = kind === 'in' ? (st.state !== 'off' ? 'もう出勤しています' : null)
      : kind === 'out' ? (st.state === 'off' ? 'まだ出勤していません' : st.state === 'break' ? '休憩中です。休憩を終えてから退勤してください' : null)
        : kind === 'break_start' ? (st.state === 'off' ? 'まだ出勤していません' : st.state === 'break' ? 'もう休憩中です' : null)
          : (st.state !== 'break' ? '休憩中ではありません' : null);
    if (bad) return { error: bad };
    const at = this.now().toISOString();
    if (await this.isClosed(tenantId, jstDate(at))) return { error: 'この日は締めた期間です。担当者に伝えてください' };
    const punch: AttPunch = { id: randomUUID(), employeeId: employee.id, kind, at, source };
    await this.deps.store.addPunch(tenantId, { ...punch, createdBy: actorUserId });
    if (kind === 'out') await this.checkAgreement(tenantId, employee).catch(() => undefined);
    return { punch, state: await this.state(tenantId, employee.id) };
  }

  /**
   * 1 日の打刻を直す（前の打刻は消さずに「直した」として残す）。本人が直したら人事区画の人に知らせる。
   *
   * @param byStaff 担当者が直すか（締めた期間も直せない。締めを戻してから）
   */
  async fixDay(tenantId: string, actorUserId: string, employee: HrEmployee, date: string, fix: DayFix, byStaff: boolean): Promise<{ day: AttDay } | { error: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日付が違います' };
    if (date > this.today()) return { error: '先の日は直せません' };
    if (await this.isClosed(tenantId, date)) return { error: byStaff ? 'この日は締めた期間です。締めを戻してから直してください' : 'この日は締めた期間です。担当者に直してもらってください' };
    if (!HM.test(fix.in) || (fix.out !== null && !HM.test(fix.out))) return { error: '時刻を HH:MM で入れてください' };
    const tIn = isoAt(date, fix.in);
    let tOut = fix.out ? isoAt(date, fix.out) : null;
    if (tOut && tOut <= tIn) tOut = isoAt(shiftDate(date, 1), fix.out!);
    const breaks: [string, string][] = [];
    for (const b of fix.breaks.slice(0, 5)) {
      if (!HM.test(b.start) || !HM.test(b.end)) return { error: '休憩の時刻を HH:MM で入れてください' };
      let s = isoAt(date, b.start);
      if (s < tIn) s = isoAt(shiftDate(date, 1), b.start);
      let e = isoAt(date, b.end);
      if (e <= s) e = isoAt(shiftDate(date, 1), b.end);
      if (tOut && (s < tIn || e > tOut)) return { error: '休憩は出勤から退勤の間に入れてください' };
      breaks.push([s, e]);
    }
    // その日に始まった勤務の打刻（日をまたぐ退勤を含む）だけを、直した扱いにする（前の日の勤務の打刻には触れない）
    const shift = (await this.shifts(tenantId, employee.id, date, date)).get(date) ?? [];
    await this.deps.store.replacePunches(tenantId, employee.id, shift.map((p) => p.id), actorUserId);
    const add = (kind: AttPunchKind, at: string) => this.deps.store.addPunch(tenantId, { id: randomUUID(), employeeId: employee.id, kind, at, source: 'fix', createdBy: actorUserId });
    await add('in', tIn);
    for (const [s, e] of breaks) { await add('break_start', s); await add('break_end', e); }
    if (tOut) await add('out', tOut);
    await this.audit(tenantId, actorUserId, 'hr.attendance.fix', 'hr_employee', employee.id, { date, byStaff });
    if (!byStaff) await this.notifyStaff(tenantId, `勤怠: ${employee.name}さんが ${date.slice(5).replace('-', '/')} の打刻を直しました`, `出勤 ${fix.in}・退勤 ${fix.out ?? '（なし）'}`, actorUserId);
    const { days } = await this.days(tenantId, employee, periodContaining(date, (await this.settings(tenantId)).pay.closingDay));
    return { day: days.find((d) => d.date === date)! };
  }

  /** 範囲の日に始まった勤務ごとの打刻（出勤で区切る。出勤の無い打刻はその日の分）。 */
  private async shifts(tenantId: string, employeeId: string | undefined, from: string, to: string): Promise<Map<string, AttPunch[]>> {
    const punches = await this.deps.store.listPunches(tenantId, { ...(employeeId ? { employeeId } : {}), from: isoAt(shiftDate(from, -1), '00:00'), to: isoAt(shiftDate(to, 2), '00:00') });
    return groupShifts(punches, from, to);
  }

  /**
   * 1 人の期間の日ごとの集計と合計。週の法定外を数えるため、期間の前の同じ週の日も集計に使う。
   */
  async days(tenantId: string, employee: HrEmployee, period: AttPeriod, preloaded?: { punches: AttPunch[]; takes: LeaveTake[]; terms: HrTerms[]; firstPunch: Map<string, string> }): Promise<{ days: AttDay[]; totals: AttTotals }> {
    const settings = await this.settings(tenantId);
    const back = (weekday(period.start) - settings.work.weekStart + 7) % 7;
    const from = shiftDate(period.start, -back);
    const shifts = preloaded
      ? groupShifts(preloaded.punches.filter((p) => p.employeeId === employee.id), from, period.end)
      : await this.shifts(tenantId, employee.id, from, period.end);
    const takes = preloaded ? preloaded.takes.filter((t) => t.employeeId === employee.id) : await this.deps.store.listTakes(tenantId, { employeeId: employee.id, from, to: period.end });
    const terms = preloaded ? preloaded.terms : await this.deps.hrStore.listTerms(tenantId, employee.id);
    // 打刻を始める前の日は「打刻がありません」と指摘しない（導入の前の日まで数えないため）
    const first = (preloaded ? preloaded.firstPunch : await this.deps.store.firstPunchDates(tenantId)).get(employee.id) ?? null;
    const today = first ? this.today() : '0000-00-00';
    // シフトの人は、公開したシフトをその日の所定にする（シフトの無い日は休み。第30.6.2節）
    const shiftTerms = termsOn(terms, period.end)?.schedule === 'shift' || terms.some((t) => t.schedule === 'shift');
    const plans = shiftTerms && this.deps.shiftStore ? await this.deps.shiftStore.listPublished(tenantId, from, period.end) : [];
    const planned = new Map((plans.length && this.deps.shiftStore ? await this.deps.shiftStore.listShifts(tenantId, from, period.end, employee.id) : []).map((s) => [s.date, s]));
    const inPlan = (d: string) => plans.some((p) => p.periodStart <= d && d <= p.periodEnd);
    const names = new Map(settings.shift.patterns.map((p) => [p.id, p.name]));
    const out: AttDay[] = [];
    for (let d = from; d <= period.end; d = shiftDate(d, 1)) {
      // 在籍の外の日は数えない
      if ((employee.hiredOn && d < employee.hiredOn) || (employee.leftOn && d > employee.leftOn)) continue;
      const t = termsOn(terms, d);
      const leave = takes.filter((x) => x.status === 'taken' && x.date === d).reduce((s, x) => s + x.days, 0);
      const byShift = t?.schedule === 'shift' && inPlan(d);
      const s = byShift ? planned.get(d) : undefined;
      const work = byShift && s?.patternId;
      const sched = byShift ? (work ? { start: s!.start, end: s!.end, breakMinutes: s!.breakMinutes } : { start: null, end: null, breakMinutes: null })
        : { start: t?.startTime || null, end: t?.endTime || null, breakMinutes: t?.breakMinutes ?? null };
      const day = summarizeDay(d, shifts.get(d) ?? [], byShift ? (work ? 'workday' : 'dayoff') : dayType(d, settings.work), sched, leave, first && d >= first ? today : '0000-00-00');
      if (byShift) { day.scheduledMinutes = work ? scheduledMinutes(sched) ?? 0 : 0; if (work) day.shiftName = names.get(s!.patternId!) ?? ''; }
      out.push(day);
    }
    // シフトの人が暦週の 7 日とも働いたら、その週の最後の日を法定休日の労働にする（週に 1 日の休日が取れなかったため）
    if (plans.length) {
      for (let i = 0; i < out.length; i++) {
        const d = out[i]!;
        if (weekday(d.date) !== (settings.work.weekStart + 6) % 7 || d.scheduledMinutes === undefined) continue;
        const week = out.filter((x) => x.date >= shiftDate(d.date, -6) && x.date <= d.date);
        if (week.length === 7 && week.every((x) => x.workMinutes > 0 && x.scheduledMinutes !== undefined)) {
          const t = termsOn(terms, d.date);
          const s = planned.get(d.date);
          out[i] = { ...summarizeDay(d.date, shifts.get(d.date) ?? [], 'legal-holiday', { start: s?.start || t?.startTime || null, end: s?.end || t?.endTime || null, breakMinutes: s?.breakMinutes ?? null }, d.leaveDays, first && d.date >= first ? today : '0000-00-00'), scheduledMinutes: d.scheduledMinutes, shiftName: d.shiftName };
        }
      }
    }
    // 1 か月単位の変形労働時間制（変形期間は締めの期間。期間のすべての日に公開したシフトがあるとき）
    const variable = settings.shift.variable && termsOn(terms, period.end)?.schedule === 'shift' && plans.some((p) => p.periodStart <= period.start && period.end <= p.periodEnd);
    if (variable) {
      const n = Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86_400_000) + 1;
      return { days: out.filter((d) => d.date >= period.start), totals: variableTotals(out, period, settings.work.weekStart, variableCapMinutes(n, settings.shift.special44)) };
    }
    return { days: out.filter((d) => d.date >= period.start), totals: periodTotals(out, period, settings.work.weekStart) };
  }

  /** 締めの期間（締め日の月 YYYY-MM から。省略すれば今日を含む期間）。 */
  async period(tenantId: string, month?: string): Promise<AttPeriod> {
    const s = await this.settings(tenantId);
    return month && /^\d{4}-\d{2}$/.test(month) ? periodOf(month, s.pay.closingDay) : periodContaining(this.today(), s.pay.closingDay);
  }

  /** 期間の、在籍していた従業員ごとの集計（担当者の画面）。 */
  async summary(tenantId: string, period: AttPeriod): Promise<AttSummaryRow[]> {
    const settings = await this.settings(tenantId);
    const employees = (await this.deps.hrStore.listEmployees(tenantId))
      .filter((e) => e.category !== 'owner' && (!e.hiredOn || e.hiredOn <= period.end) && (!e.leftOn || e.leftOn >= period.start));
    const back = (weekday(period.start) - settings.work.weekStart + 7) % 7;
    const from = shiftDate(period.start, -back);
    const punches = await this.deps.store.listPunches(tenantId, { from: isoAt(shiftDate(from, -1), '00:00'), to: isoAt(shiftDate(period.end, 2), '00:00') });
    const takes = await this.deps.store.listTakes(tenantId, { from, to: period.end });
    const firstPunch = await this.deps.store.firstPunchDates(tenantId);
    const rows: AttSummaryRow[] = [];
    for (const e of employees) {
      const terms = await this.deps.hrStore.listTerms(tenantId, e.id);
      const { days, totals } = await this.days(tenantId, e, period, { punches, takes, terms, firstPunch });
      const alerts = settings.agreement.enabled ? agreementAlerts([{ label: period.label, totals }], { ...settings.agreement, special: false }).map((a) => a.text) : [];
      rows.push({ employeeId: e.id, name: e.name, totals, issues: days.reduce((s, d) => s + d.issues.length, 0), alerts });
    }
    return rows;
  }

  /** 期間を締める（点検の指摘は示すだけで止めない）。締めた期間の集計を記録する。 */
  async close(tenantId: string, userId: string, period: AttPeriod): Promise<{ close: AttClose } | { error: string }> {
    const closes = await this.deps.store.listCloses(tenantId);
    if (closes.some((c) => c.status === 'closed' && c.periodEnd === period.end)) return { error: 'この期間はもう締めています' };
    if (period.end >= this.today()) return { error: '期間の終わりの日を過ぎてから締めてください' };
    const rows = await this.summary(tenantId, period);
    const id = randomUUID();
    await this.deps.store.addClose(tenantId, { id, periodStart: period.start, periodEnd: period.end, totals: Object.fromEntries(rows.map((r) => [r.employeeId, r.totals])), by: userId });
    await this.audit(tenantId, userId, 'hr.attendance.close', 'hr', `${period.start}..${period.end}`, { employees: rows.length, issues: rows.reduce((s, r) => s + r.issues, 0) });
    return { close: { id, periodStart: period.start, periodEnd: period.end, status: 'closed', closedBy: userId, closedAt: new Date().toISOString() } };
  }

  /** 締めを戻す（記録を残す）。 */
  async reopen(tenantId: string, userId: string, closeId: string): Promise<boolean> {
    const ok = await this.deps.store.reopenClose(tenantId, closeId, userId);
    if (ok) await this.audit(tenantId, userId, 'hr.attendance.reopen', 'hr', closeId, {});
    return ok;
  }

  /** 締めの記録（新しい順）。 */
  async closes(tenantId: string): Promise<AttClose[]> {
    return (await this.deps.store.listCloses(tenantId)).map(({ totals: _t, ...c }) => c);
  }

  /**
   * 出勤簿の表（期間の日ごと。第30.6.1節）。書き出したことを監査ログに残す。
   *
   * @param audit 監査ログに残すか（帳簿をまとめて書き出すときは、まとめて 1 つ残すため `false`）
   */
  async attendanceBook(tenantId: string, userId: string, period: AttPeriod, audit = true): Promise<{ columns: string[]; rows: (string | number | null)[][] }> {
    const employees = (await this.deps.hrStore.listEmployees(tenantId))
      .filter((e) => e.category !== 'owner' && (!e.hiredOn || e.hiredOn <= period.end) && (!e.leftOn || e.leftOn >= period.start));
    const hm = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '');
    const typeLabel = { workday: '', dayoff: '所定休日', 'legal-holiday': '法定休日' } as const;
    const rows: (string | number | null)[][] = [];
    for (const e of employees) {
      const { days } = await this.days(tenantId, e, period);
      for (const d of days) {
        rows.push([e.code, e.name, d.date, '日月火水木金土'[weekday(d.date)]!, typeLabel[d.type], d.in ? jstTime(d.in) : '', d.out ? jstTime(d.out) : '',
          hm(d.breakMinutes), hm(d.workMinutes), hm(d.overtimeMinutes), hm(d.nightMinutes), hm(d.holidayMinutes), d.leaveDays || '', d.issues.join('・')]);
      }
    }
    if (audit) await this.audit(tenantId, userId, 'hr.export', 'hr', `${period.start}..${period.end}`, { kind: 'attendance-book', rows: rows.length });
    return { columns: ['社員番号', '氏名', '日付', '曜日', '区分', '出勤', '退勤', '休憩', '労働時間', '法定外（日）', '深夜', '法定休日の労働', '有給', '点検'], rows };
  }

  // ---- 36 協定 ----

  /**
   * 36 協定への接近と超過を見て、初めての段階なら本人と人事区画の人に知らせる（第30.6.1節）。
   *
   * @returns 知らせた数
   */
  async checkAgreement(tenantId: string, employee: HrEmployee): Promise<number> {
    const settings = await this.settings(tenantId);
    if (!settings.agreement.enabled) return 0;
    const today = this.today();
    const cur = periodContaining(today, settings.pay.closingDay);
    // 対象期間の始まり（その月の締めの期間）から、いまの期間まで
    const [y, m] = cur.end.split('-').map(Number) as [number, number];
    const startYear = m >= settings.agreement.startMonth ? y : y - 1;
    const months: { label: string; totals: AttTotals }[] = [];
    let mm = `${startYear}-${String(settings.agreement.startMonth).padStart(2, '0')}`;
    for (let i = 0; i < 12; i++) {
      const p = periodOf(mm, settings.pay.closingDay);
      if (p.start > cur.end) break;
      months.push({ label: p.label, totals: (await this.days(tenantId, employee, p)).totals });
      const [yy, m0] = mm.split('-').map(Number) as [number, number];
      mm = m0 === 12 ? `${yy + 1}-01` : `${yy}-${String(m0 + 1).padStart(2, '0')}`;
    }
    let sent = 0;
    for (const a of agreementAlerts(months, settings.agreement)) {
      if (!(await this.deps.store.markAlert(tenantId, employee.id, `36:${a.key}`))) continue;
      const title = `勤怠: ${employee.name}さんの時間外が${a.level === 'over' ? '協定を超えました' : '協定に近づいています'}`;
      if (employee.userId) sent += await this.notify(tenantId, employee.userId, title, a.text);
      sent += await this.notifyStaff(tenantId, title, a.text, employee.userId ?? '');
    }
    return sent;
  }

  // ---- 有給 ----

  /** 付与の日が来た分の付与を作る（同じ日の付与は 1 つ）。 */
  async ensureGrants(tenantId: string, employee: HrEmployee): Promise<number> {
    if (!employee.hiredOn || employee.category === 'owner') return 0;
    const terms = await this.deps.hrStore.listTerms(tenantId, employee.id);
    let n = 0;
    for (const { date, index } of dueGrantDates(employee.hiredOn, this.today(), employee.leftOn)) {
      const t = termsOn(terms, date);
      const days = grantDays(index, t?.weeklyDays ?? null, t?.weeklyHours ?? null);
      if (days <= 0) continue;
      if (await this.deps.store.addGrant(tenantId, { id: randomUUID(), employeeId: employee.id, grantedOn: date, days, expiresOn: addMonths(date, 24), basis: 'auto', note: '', createdBy: 'system' })) n++;
    }
    return n;
  }

  /** 有給の残りと取得義務（付与の日が来た分を先に作る）。 */
  async balance(tenantId: string, employee: HrEmployee, asOf?: string): Promise<LeaveBalance & { takes: LeaveTake[] }> {
    await this.ensureGrants(tenantId, employee);
    const [grants, takes] = await Promise.all([this.deps.store.listGrants(tenantId, employee.id), this.deps.store.listTakes(tenantId, { employeeId: employee.id })]);
    return { ...leaveBalance(grants, takes, asOf ?? this.today()), takes };
  }

  /**
   * 有給を取る（本人の申請・担当者の記録）。承認の段は挟まず、人事区画の人に知らせる（第30.7.1節）。
   *
   * @param days 1 か 0.5（半日は会社の設定で入れているときだけ）
   */
  async requestLeave(tenantId: string, actorUserId: string, employee: HrEmployee, date: string, days: number, source: LeaveTake['source']): Promise<{ take: LeaveTake; remaining: number } | { error: string }> {
    const settings = await this.settings(tenantId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: '日付が違います' };
    if (days !== 1 && days !== 0.5) return { error: '1 日か半日で入れてください' };
    if (days === 0.5 && !settings.leave.halfDay) return { error: '半日の有給は会社で使っていません' };
    if (source !== 'staff' && await this.isClosed(tenantId, date)) return { error: 'この日は締めた期間です。担当者に伝えてください' };
    if (employee.hiredOn && date < employee.hiredOn) return { error: '入社日より前の日です' };
    const bal = await this.balance(tenantId, employee, date);
    if (bal.takes.some((t) => t.status === 'taken' && t.date === date)) return { error: 'この日はもう有給を取っています' };
    if (bal.remaining < days) return { error: `有給の残りが足りません（${date} の時点で残り ${bal.remaining} 日）` };
    const take: LeaveTake = { id: randomUUID(), employeeId: employee.id, date, days, status: 'taken', source };
    await this.deps.store.addTake(tenantId, { ...take, createdBy: actorUserId, note: '' });
    await this.audit(tenantId, actorUserId, 'hr.leave.take', 'hr_employee', employee.id, { date, days });
    if (source !== 'staff') await this.notifyStaff(tenantId, `勤怠: ${employee.name}さんが ${date.slice(5).replace('-', '/')} に有給を取ります`, days === 0.5 ? '半日' : '1 日', actorUserId);
    const after = await this.balance(tenantId, employee);
    return { take, remaining: after.remaining };
  }

  /** 有給の取得を取り消す（本人は締めていない期間だけ）。 */
  async cancelLeave(tenantId: string, actorUserId: string, employee: HrEmployee | null, takeId: string, byStaff: boolean): Promise<{ take: LeaveTake } | { error: string }> {
    const takes = await this.deps.store.listTakes(tenantId, employee ? { employeeId: employee.id } : {});
    const target = takes.find((t) => t.id === takeId && t.status === 'taken');
    if (!target) return { error: '取り消せる有給が見つかりません' };
    if (!byStaff && await this.isClosed(tenantId, target.date)) return { error: 'この日は締めた期間です。担当者に伝えてください' };
    const take = await this.deps.store.cancelTake(tenantId, takeId, actorUserId);
    if (!take) return { error: '取り消せませんでした' };
    await this.audit(tenantId, actorUserId, 'hr.leave.cancel', 'hr_employee', take.employeeId, { date: take.date });
    return { take };
  }

  /** 手作業の付与（導入のときの今の残日数・付与の直し。理由を残す）。 */
  async addGrant(tenantId: string, userId: string, employee: HrEmployee, grantedOn: string, days: number, note: string): Promise<{ grant: LeaveGrant } | { error: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(grantedOn)) return { error: '付与の日を YYYY-MM-DD で入れてください' };
    if (!Number.isFinite(days) || days < 0 || days > 40) return { error: '日数は 0〜40 で入れてください' };
    const grant: LeaveGrant = { id: randomUUID(), employeeId: employee.id, grantedOn, days: Math.round(days * 2) / 2, expiresOn: addMonths(grantedOn, 24), basis: 'manual', note: note.trim().slice(0, 200) };
    if (!(await this.deps.store.addGrant(tenantId, { ...grant, createdBy: userId }))) {
      const same = (await this.deps.store.listGrants(tenantId, employee.id)).find((g) => g.grantedOn === grantedOn);
      if (!same) return { error: '付与を足せませんでした' };
      await this.deps.store.updateGrant(tenantId, same.id, { days: grant.days, note: grant.note });
      grant.id = same.id;
    }
    await this.audit(tenantId, userId, 'hr.leave.grant', 'hr_employee', employee.id, { grantedOn, days: grant.days });
    return { grant };
  }

  /**
   * 有給の一覧（担当者の画面）。出勤率が 8 割に届かない見込みの人も示す（付与は止めない。第30.7.1節）。
   */
  async leaveOverview(tenantId: string): Promise<{ employeeId: string; name: string; balance: LeaveBalance; lowAttendance: number | null; takes: LeaveTake[] }[]> {
    const employees = (await this.deps.hrStore.listEmployees(tenantId)).filter((e) => e.category !== 'owner' && (!e.leftOn || e.leftOn >= this.today()));
    const out = [];
    for (const e of employees) {
      const bal = await this.balance(tenantId, e);
      out.push({ employeeId: e.id, name: e.name, balance: { remaining: bal.remaining, grants: bal.grants, obligation: bal.obligation }, lowAttendance: await this.attendanceRate(tenantId, e, bal.grants), takes: bal.takes.filter((t) => t.status === 'taken') });
    }
    return out;
  }

  /** 直近の付与の前の期間の出勤率（打刻の記録がその期間を覆っているときだけ。8 割以上なら `null`）。 */
  private async attendanceRate(tenantId: string, e: HrEmployee, grants: LeaveGrant[]): Promise<number | null> {
    const last = [...grants].filter((g) => g.basis === 'auto').pop();
    if (!last || !e.hiredOn) return null;
    const from = last.grantedOn === addMonths(e.hiredOn, 6) ? e.hiredOn : addMonths(last.grantedOn, -12);
    const to = shiftDate(last.grantedOn, -1);
    const first = await this.deps.store.listPunches(tenantId, { employeeId: e.id, from: isoAt(shiftDate(from, -3650), '00:00'), to: isoAt(shiftDate(from, 1), '00:00') });
    if (first.length === 0) return null;
    const { days } = await this.days(tenantId, e, { start: from, end: to, label: '' });
    const scheduled = days.filter((d) => d.type === 'workday').length;
    if (scheduled === 0) return null;
    const attended = days.filter((d) => d.type === 'workday' && (d.workMinutes > 0 || d.leaveDays > 0)).length;
    const rate = attended / scheduled;
    return rate < 0.8 ? Math.round(rate * 100) / 100 : null;
  }

  /**
   * 年次有給休暇の管理簿の表（第30.7節）。書き出したことを監査ログに残す。
   *
   * @param audit 監査ログに残すか（帳簿をまとめて書き出すときは `false`）
   */
  async leaveRegister(tenantId: string, userId: string, audit = true): Promise<{ columns: string[]; rows: (string | number | null)[][] }> {
    const employees = (await this.deps.hrStore.listEmployees(tenantId)).filter((e) => e.category !== 'owner');
    const rows: (string | number | null)[][] = [];
    for (const e of employees) {
      const bal = await this.balance(tenantId, e);
      for (const g of bal.grants) {
        const end = addMonths(g.grantedOn, 12);
        const dates = bal.takes.filter((t) => t.status === 'taken' && t.date >= g.grantedOn && t.date < end).map((t) => `${t.date}${t.days === 0.5 ? '（半日）' : ''}`);
        rows.push([e.code, e.name, g.grantedOn, g.days, g.used, g.left, g.expiresOn, dates.join('、')]);
      }
    }
    if (audit) await this.audit(tenantId, userId, 'hr.export', 'hr', 'leave-register', { kind: 'leave-register', rows: rows.length });
    return { columns: ['社員番号', '氏名', '基準日（付与の日）', '付与日数', '使った日数', '残り', '時効', '1 年の間に取った日'], rows };
  }

  /**
   * 毎朝の見回り（ワーカー）。付与の日が来た分を作り、取得義務の残り 3 か月で足りない人を知らせる（月に一度）。
   *
   * @returns 知らせた数
   */
  async daily(tenantId: string): Promise<number> {
    const settings = await this.settings(tenantId);
    if (!settings.enabled) return 0;
    const today = this.today();
    let sent = 0;
    for (const e of await this.deps.hrStore.listEmployees(tenantId)) {
      if (e.category === 'owner' || (e.leftOn && e.leftOn < today)) continue;
      const bal = await this.balance(tenantId, e);
      const o = bal.obligation;
      if (!o || o.taken >= o.required || addMonths(today, 3) < o.deadline) continue;
      if (!(await this.deps.store.markAlert(tenantId, e.id, `obl:${o.grantedOn}:${today.slice(0, 7)}`))) continue;
      const title = `勤怠: ${e.name}さんの有給の取得義務（あと ${o.required - o.taken} 日）`;
      const body = `${o.deadline} までに 5 日を取る義務があります。いま ${o.taken} 日です。`;
      if (e.userId) sent += await this.notify(tenantId, e.userId, title, body);
      sent += await this.notifyStaff(tenantId, title, body, e.userId ?? '');
    }
    return sent;
  }

  // ---- 知らせと記録 ----

  /** 1 人に知らせる（本人が「勤怠」の知らせを切っていれば送らない。同じ題の知らせが最近あれば送らない）。 */
  private async notify(tenantId: string, userId: string, title: string, body: string): Promise<number> {
    const { repo } = this.deps;
    const prefs = await repo.getUserSettings(tenantId, userId);
    if (!prefs.notifications.kinds.attendance) return 0;
    const recent = await repo.listNotifications(tenantId, userId, 30);
    if (recent.some((n) => n.kind === 'attendance' && n.title === title && Date.now() - Date.parse(n.createdAt) < 3_600_000)) return 0;
    await repo.createNotification({ id: randomUUID(), tenantId, userId, kind: 'attendance', title, body, runId: null, readAt: null, createdAt: new Date().toISOString() });
    return 1;
  }

  /** 人事区画の人に知らせる（操作した本人は除く）。 */
  private async notifyStaff(tenantId: string, title: string, body: string, exceptUserId: string): Promise<number> {
    let n = 0;
    for (const u of await this.deps.repo.listUsers(tenantId)) {
      if (u.status !== 'active' || u.id === exceptUserId) continue;
      if (!(await this.deps.repo.listUserCompartments(tenantId, u.id)).includes(HR_COMPARTMENT)) continue;
      n += await this.notify(tenantId, u.id, title, body);
    }
    return n;
  }

  private async audit(tenantId: string, userId: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType, targetId, detail, occurredAt: new Date().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }

  /** 打刻の種類の名前（秘書の答えに使う）。 */
  static label(kind: AttPunchKind): string {
    return ATT_PUNCH_LABELS[kind];
  }
}

/** その日に効いている雇用条件（適用日がその日以前で最も新しいもの）。 */
export function termsOn(terms: HrTerms[], date: string): HrTerms | null {
  return [...terms].filter((t) => t.effectiveOn <= date).sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.createdAt.localeCompare(a.createdAt))[0]
    ?? [...terms].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))[0] ?? null;
}

/**
 * 打刻を、出勤した日ごとの勤務にまとめる（従業員ごと・時刻の順）。範囲の日に始まった勤務だけを返す。
 */
export function groupShifts(punches: AttPunch[], from: string, to: string): Map<string, AttPunch[]> {
  const out = new Map<string, AttPunch[]>();
  const byEmp = new Map<string, AttPunch[]>();
  for (const p of punches) byEmp.set(p.employeeId, [...(byEmp.get(p.employeeId) ?? []), p]);
  for (const list of byEmp.values()) {
    let cur: string | null = null;
    for (const p of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
      if (p.kind === 'in') cur = jstDate(p.at);
      const d = cur ?? jstDate(p.at);
      if (p.kind === 'out') cur = null;
      if (d < from || d > to) continue;
      out.set(d, [...(out.get(d) ?? []), p]);
    }
  }
  return out;
}
