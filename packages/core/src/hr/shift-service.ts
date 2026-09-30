/**
 * @file シフトの処理（仕様書 第30.6.2節）。勤務の型と要る人数・締めの期間のシフトの案づくり・担当者の直し・公開・本人の休みの希望と見る画面。
 *
 * 案は shift-plan.ts（決まったプログラム）で作る。公開すると、シフトの人の所定の始業・終業になり、勤怠の集計が使う（attendance-service.ts）。
 * 社外にもお金にも関わらないため、公開に承認は挟まない（ADR-0028）。人事区画の確かめは呼ぶ側（API）が行う。
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent, HrEmployee, HrShift, HrShiftSettings, HrTerms, ShiftView } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { HrStore } from './store.js';
import type { ShiftStore } from './shift-store.js';
import { termsOn } from './attendance-service.js';
import { periodContaining, periodOf, scheduledMinutes, shiftDate, jstDate } from './attendance.js';
import { checkPlan, generatePlan, variableCap, type PlanInput, type PlanMember } from './shift-plan.js';

/** シフトの処理に要るもの。 */
export interface ShiftServiceDeps {
  store: ShiftStore;
  hrStore: HrStore;
  repo: Repository;
  now?: () => Date;
}

const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * シフト。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）
 */
export class ShiftService {
  constructor(readonly deps: ShiftServiceDeps) {}

  private today(): string {
    return jstDate(this.deps.now ? this.deps.now() : new Date());
  }

  /** 締めの期間（`month` は締め日の月。省略すれば今日を含む期間）。 */
  async period(tenantId: string, month?: string): Promise<{ start: string; end: string; label: string }> {
    const s = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    return month ? periodOf(month, s.pay.closingDay) : periodContaining(this.today(), s.pay.closingDay);
  }

  /** シフトに入る人（期間に在籍し、雇用条件の働き方がシフトの人）。 */
  private async members(tenantId: string, period: { start: string; end: string }): Promise<{ member: PlanMember; terms: HrTerms | null; employee: HrEmployee }[]> {
    const out: { member: PlanMember; terms: HrTerms | null; employee: HrEmployee }[] = [];
    for (const e of await this.deps.hrStore.listEmployees(tenantId)) {
      if (e.category === 'owner' || (e.hiredOn && e.hiredOn > period.end) || (e.leftOn && e.leftOn < period.start)) continue;
      const t = termsOn(await this.deps.hrStore.listTerms(tenantId, e.id), period.end);
      if (t?.schedule !== 'shift') continue;
      out.push({ employee: e, terms: t, member: { employeeId: e.id, name: e.name, weeklyDays: t.weeklyDays, weeklyHours: t.weeklyHours, hiredOn: e.hiredOn, leftOn: e.leftOn } });
    }
    return out.sort((a, b) => a.member.name.localeCompare(b.member.name, 'ja'));
  }

  private days(period: { start: string; end: string }): string[] {
    const out: string[] = [];
    for (let d = period.start; d <= period.end; d = shiftDate(d, 1)) out.push(d);
    return out;
  }

  private async input(tenantId: string, period: { start: string; end: string }): Promise<{ input: PlanInput; members: Awaited<ReturnType<ShiftService['members']>>; settings: HrShiftSettings }> {
    const s = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const members = await this.members(tenantId, period);
    const requests = await this.deps.store.listRequests(tenantId, period.start, period.end);
    return {
      input: { days: this.days(period), members: members.map((m) => m.member), settings: s.shift, requests: new Set(requests.map((r) => `${r.employeeId}|${r.date}`)), weekStart: s.work.weekStart },
      members, settings: s.shift,
    };
  }

  /**
   * シフトの画面（期間のシフト・休みの希望・点検）。
   *
   * @param month 締め日の月（省略すれば次の期間。シフトは前もって組むため）
   */
  async view(tenantId: string, month?: string): Promise<ShiftView> {
    const period = month ? await this.period(tenantId, month) : await this.nextPeriod(tenantId);
    const { input, members, settings } = await this.input(tenantId, period);
    const [plan, shifts, requests] = await Promise.all([
      this.deps.store.getPlan(tenantId, period.start), this.deps.store.listShifts(tenantId, period.start, period.end), this.deps.store.listRequests(tenantId, period.start, period.end),
    ]);
    const ids = new Set(members.map((m) => m.member.employeeId));
    const mine = shifts.filter((s) => ids.has(s.employeeId));
    const issues = plan ? checkPlan(input, mine) : [];
    if (plan?.status === 'published' && mine.some((s) => s.changedAfterPublish) && settings.variable) {
      issues.push({ level: 'check', code: 'changed', text: '公開の後に直したシフトがあります（1 か月単位の変形労働時間制では、期間が始まった後に所定の時間を変えないのが決まりです）' });
    }
    const cap = settings.variable ? variableCap(input.days.length, settings.special44) : null;
    const minutes = (s: HrShift) => scheduledMinutes({ start: s.start, end: s.end, breakMinutes: s.breakMinutes }) ?? 0;
    return {
      period, plan: plan ?? { periodStart: period.start, periodEnd: period.end, status: 'none', generatedAt: null, publishedAt: null },
      members: members.map((m) => ({
        employeeId: m.member.employeeId, name: m.member.name, weeklyDays: m.member.weeklyDays, weeklyHours: m.member.weeklyHours,
        scheduledMinutes: mine.filter((s) => s.employeeId === m.member.employeeId && s.patternId).reduce((sum, s) => sum + minutes(s), 0), capMinutes: cap,
      })),
      shifts: mine, requests: requests.filter((r) => ids.has(r.employeeId)), settings, issues,
    };
  }

  /** 今日を含む期間の次の期間。 */
  async nextPeriod(tenantId: string): Promise<{ start: string; end: string; label: string }> {
    const cur = await this.period(tenantId);
    const s = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    return periodContaining(shiftDate(cur.end, 1), s.pay.closingDay);
  }

  /** 勤務の型と要る人数を直す（人事区画の人。会社の設定の shift に残す）。 */
  async saveSettings(tenantId: string, userId: string, input: Partial<HrShiftSettings>): Promise<HrShiftSettings | { error: string }> {
    const all = await this.deps.repo.getTenantSettings(tenantId);
    const next: HrShiftSettings = { ...all.hr.shift };
    if (input.patterns !== undefined) {
      if (!Array.isArray(input.patterns) || input.patterns.length > 20) return { error: '勤務の型は 20 までです' };
      const list = [];
      for (const p of input.patterns) {
        const name = String(p?.name ?? '').trim().slice(0, 20);
        if (!name || !HM.test(String(p?.start)) || !HM.test(String(p?.end))) return { error: '勤務の型の名前と、始業・終業（HH:MM）を入れてください' };
        const br = Math.max(0, Math.round(Number(p?.breakMinutes) || 0));
        list.push({ id: String(p?.id || randomUUID().slice(0, 8)), name, start: String(p.start).padStart(5, '0'), end: String(p.end).padStart(5, '0'), breakMinutes: br });
      }
      next.patterns = list;
    }
    if (input.needs !== undefined) {
      if (!Array.isArray(input.needs)) return { error: '要る人数の形が違います' };
      const ids = new Set(next.patterns.map((p) => p.id));
      next.needs = input.needs.filter((n) => ids.has(String(n?.patternId)) && Number.isInteger(n?.day) && n.day >= 0 && n.day <= 7)
        .map((n) => ({ day: n.day, patternId: String(n.patternId), count: Math.max(0, Math.min(50, Math.round(Number(n.count) || 0))) }))
        .filter((n) => n.count > 0);
    } else {
      // 消した型の人数は残さない
      next.needs = next.needs.filter((n) => next.patterns.some((p) => p.id === n.patternId));
    }
    if (input.variable !== undefined) next.variable = !!input.variable;
    if (input.special44 !== undefined) next.special44 = !!input.special44;
    await this.deps.repo.saveTenantSettings(tenantId, 'hr', { ...all.hr, shift: next }, userId);
    await this.audit(tenantId, userId, 'hr.shift.settings', 'shift', { patterns: next.patterns.length, needs: next.needs.length });
    return next;
  }

  /** 案を作る（期間のシフトを置き換えて下書きにする）。公開した期間は作り直せない。 */
  async generate(tenantId: string, userId: string, month: string): Promise<ShiftView | { error: string }> {
    const period = await this.period(tenantId, month);
    const plan = await this.deps.store.getPlan(tenantId, period.start);
    if (plan?.status === 'published') return { error: 'この期間のシフトは公開しています。直すときは日ごとに直してください' };
    const { input, settings } = await this.input(tenantId, period);
    if (input.members.length === 0) return { error: 'シフトの人がいません。雇用条件の働き方を「シフト」にしてください' };
    if (settings.patterns.length === 0 || settings.needs.length === 0) return { error: '勤務の型と、日ごとに要る人数を入れてください' };
    const shifts = generatePlan(input);
    await this.deps.store.replaceShifts(tenantId, period.start, period.end, shifts, userId);
    await this.deps.store.savePlan(tenantId, { periodStart: period.start, periodEnd: period.end, status: 'draft', generated: true }, userId);
    await this.audit(tenantId, userId, 'hr.shift.generate', period.start, { shifts: shifts.length, members: input.members.length });
    return this.view(tenantId, month);
  }

  /** 1 人 1 日のシフトを直す（`patternId` が `null` なら休み。型に無い時刻も入れられる）。 */
  async setCell(tenantId: string, userId: string, month: string, employeeId: string, date: string, input: { patternId: string | null; start?: string; end?: string; breakMinutes?: number }): Promise<ShiftView | { error: string }> {
    const period = await this.period(tenantId, month);
    if (date < period.start || date > period.end) return { error: 'その日はこの期間にありません' };
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr.shift;
    const plan = await this.deps.store.getPlan(tenantId, period.start);
    const p = input.patternId ? settings.patterns.find((x) => x.id === input.patternId) : null;
    if (input.patternId && !p) return { error: '勤務の型が見つかりません' };
    const start = input.start ?? p?.start ?? '';
    const end = input.end ?? p?.end ?? '';
    if (input.patternId && (!HM.test(start) || !HM.test(end))) return { error: '始業・終業を HH:MM で入れてください' };
    await this.deps.store.setShift(tenantId, {
      employeeId, date, patternId: input.patternId, start: input.patternId ? start : '', end: input.patternId ? end : '',
      breakMinutes: input.patternId ? Math.max(0, Math.round(input.breakMinutes ?? p?.breakMinutes ?? 0)) : 0, changedAfterPublish: plan?.status === 'published',
    }, userId);
    if (!plan) await this.deps.store.savePlan(tenantId, { periodStart: period.start, periodEnd: period.end, status: 'draft' }, userId);
    await this.audit(tenantId, userId, 'hr.shift.set', employeeId, { date, published: plan?.status === 'published' });
    return this.view(tenantId, month);
  }

  /**
   * 公開する（シフトの人に知らせ、勤怠の所定になる）。点検で止まっているもの（総枠を超える・7 日続けて働く）があれば公開しない。
   */
  async publish(tenantId: string, userId: string, month: string): Promise<ShiftView | { error: string; issues?: ShiftView['issues'] }> {
    const v = await this.view(tenantId, month);
    if (v.plan.status === 'none') return { error: 'この期間のシフトはまだありません' };
    const stops = v.issues.filter((x) => x.level === 'stop');
    if (stops.length) return { error: '点検で止まっているものがあるため、公開できません', issues: stops };
    await this.deps.store.savePlan(tenantId, { periodStart: v.period.start, periodEnd: v.period.end, status: 'published' }, userId);
    let sent = 0;
    for (const m of v.members) {
      const e = await this.deps.hrStore.getEmployee(tenantId, m.employeeId);
      if (!e?.userId) continue;
      const days = v.shifts.filter((s) => s.employeeId === m.employeeId && s.patternId).length;
      sent += await this.notify(tenantId, e.userId, `シフト（${v.period.label}）が決まりました`, `勤務 ${days} 日。「給与・勤怠」で見られます`);
    }
    await this.audit(tenantId, userId, 'hr.shift.publish', v.period.start, { members: v.members.length, sent });
    return this.view(tenantId, month);
  }

  /** 本人のシフト（公開した期間だけ）と休みの希望（今の期間と次の期間）。 */
  async selfView(tenantId: string, employee: HrEmployee): Promise<{ periods: { period: { start: string; end: string; label: string }; published: boolean; shifts: HrShift[]; requests: string[]; canRequest: boolean }[]; patterns: HrShiftSettings['patterns'] }> {
    const s = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    // シフトの人でなければ出さない
    if (termsOn(await this.deps.hrStore.listTerms(tenantId, employee.id), this.today())?.schedule !== 'shift') return { periods: [], patterns: s.shift.patterns };
    const cur = await this.period(tenantId);
    const next = await this.nextPeriod(tenantId);
    const out = [];
    for (const p of [cur, next]) {
      const plan = await this.deps.store.getPlan(tenantId, p.start);
      const published = plan?.status === 'published';
      out.push({
        period: p, published, shifts: published ? await this.deps.store.listShifts(tenantId, p.start, p.end, employee.id) : [],
        requests: (await this.deps.store.listRequests(tenantId, p.start, p.end, employee.id)).map((r) => r.date), canRequest: !published && p.start > this.today(),
      });
    }
    return { periods: out, patterns: s.shift.patterns };
  }

  /** 本人の休みの希望を入れるか外す（公開の前の、次の期間の日だけ）。 */
  async setRequest(tenantId: string, employee: HrEmployee, date: string, on: boolean): Promise<{ ok: true } | { error: string }> {
    const s = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const p = periodContaining(date, s.pay.closingDay);
    if (p.start <= this.today()) return { error: '始まった期間の休みの希望は出せません。担当者に伝えてください' };
    if ((await this.deps.store.getPlan(tenantId, p.start))?.status === 'published') return { error: 'この期間のシフトは決まっています。担当者に伝えてください' };
    await this.deps.store.setRequest(tenantId, employee.id, date, on);
    return { ok: true };
  }

  private async notify(tenantId: string, userId: string, title: string, body: string): Promise<number> {
    const prefs = await this.deps.repo.getUserSettings(tenantId, userId);
    if (!prefs.notifications.kinds.attendance) return 0;
    await this.deps.repo.createNotification({ id: randomUUID(), tenantId, userId, kind: 'attendance', title, body, runId: null, readAt: null, createdAt: new Date().toISOString() });
    return 1;
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'hr', targetId, detail, occurredAt: new Date().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }
}
