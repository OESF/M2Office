/**
 * @file 労務カレンダー（仕様書 第30.19.1節）。期限を並べ、14 日前と 3 日前に人事区画の人へ知らせ、朝のブリーフに渡す。
 * 源泉所得税と住民税の納付は、M2Office で給与を確定している会社にだけ知らせる（画面には出す）。
 *
 * 期限は calendar.ts（決まったプログラム）で出す。人事区画の確かめは呼ぶ側（API・道具）が行う。
 */

import { randomUUID } from 'node:crypto';
import { HR_COMPARTMENT, type HrDeadline, type HrTerms } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { HrStore } from './store.js';
import type { PayrollStore } from './payroll-store.js';
import type { AttendanceService } from './attendance-service.js';
import { termsOn } from './attendance-service.js';
import { buildDeadlines } from './calendar.js';
import { jstDate } from './attendance.js';

/** 労務カレンダーに要るもの。 */
export interface LaborCalendarDeps {
  hrStore: HrStore;
  payrollStore: PayrollStore;
  attendance: AttendanceService;
  repo: Repository;
  now?: () => Date;
}

/** 知らせる日（期限の何日前か）。 */
const STAGES = [14, 3] as const;

/**
 * 労務カレンダー。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。知らせは人事区画の人だけに送る（H-3）
 */
export class LaborCalendar {
  constructor(readonly deps: LaborCalendarDeps) {}

  private today(): string {
    return jstDate(this.deps.now ? this.deps.now() : new Date());
  }

  /**
   * 今日から `days` 日の期限（過ぎて済んでいない手続きを含む）。人事・給与を切っている会社では空。
   */
  async list(tenantId: string, days = 90): Promise<HrDeadline[]> {
    return (await this.collect(tenantId, days)).items;
  }

  /** 期限と、確定した給与があるか。 */
  private async collect(tenantId: string, days: number): Promise<{ items: HrDeadline[]; usesPayroll: boolean }> {
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    if (!settings.enabled) return { items: [], usesPayroll: false };
    const today = this.today();
    const employees = await this.deps.hrStore.listEmployees(tenantId);
    const terms = new Map<string, HrTerms | null>();
    const obligations: { employeeId: string; name: string; deadline: string; taken: number; required: number }[] = [];
    for (const e of employees) {
      if (e.category === 'owner' || (e.leftOn && e.leftOn < today)) continue;
      terms.set(e.id, termsOn(await this.deps.hrStore.listTerms(tenantId, e.id), today));
      const o = (await this.deps.attendance.balance(tenantId, e)).obligation;
      if (o && o.taken < o.required) obligations.push({ employeeId: e.id, name: e.name, deadline: o.deadline, taken: o.taken, required: o.required });
    }
    const [tasks, payments] = await Promise.all([
      this.deps.hrStore.listTasks(tenantId, { openOnly: true }),
      this.deps.payrollStore.monthlyTotals(tenantId, `${Number(today.slice(0, 4)) - 1}-01`),
    ]);
    return { items: buildDeadlines({ today, days, settings, employees, terms, tasks, obligations, payments }), usesPayroll: payments.length > 0 };
  }

  /**
   * 期限の 14 日前と 3 日前に、人事区画の人へ知らせる（同じ期限の同じ段は二度知らせない）。ワーカーが毎日呼ぶ。
   *
   * @returns 送った知らせの数
   */
  async daily(tenantId: string): Promise<number> {
    const today = this.today();
    const { items: all, usesPayroll } = await this.collect(tenantId, 14);
    // 納付は、M2Office で給与を確定している会社にだけ知らせる（台帳と勤怠だけを使う会社に、関わりの薄い知らせを送らない）。画面には出す
    const items = all.filter((d) => !d.overdue && d.kind !== 'leave-obligation' && (usesPayroll || (d.kind !== 'withholding' && d.kind !== 'resident')));
    if (items.length === 0) return 0;
    const staff = [];
    for (const u of await this.deps.repo.listUsers(tenantId)) {
      if (u.status === 'active' && (await this.deps.repo.listUserCompartments(tenantId, u.id)).includes(HR_COMPARTMENT)) staff.push(u.id);
    }
    let sent = 0;
    for (const d of items) {
      const left = Math.round((Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      const stage = [...STAGES].reverse().find((n) => left <= n);
      if (stage === undefined) continue;
      // 近い段で初めて見つけたときは、遠い段も済んだことにする（二度知らせない）
      const fresh = await this.deps.hrStore.markCalendarAlert(tenantId, `${d.kind}:${d.date}:${d.title}:${stage}`);
      for (const n of STAGES) if (n > stage) await this.deps.hrStore.markCalendarAlert(tenantId, `${d.kind}:${d.date}:${d.title}:${n}`);
      if (!fresh) continue;
      const title = `労務: ${d.title}（${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))} まで）`;
      for (const userId of staff) {
        const prefs = await this.deps.repo.getUserSettings(tenantId, userId);
        if (!prefs.notifications.kinds.attendance) continue;
        await this.deps.repo.createNotification({ id: randomUUID(), tenantId, userId, kind: 'attendance', title, body: d.detail, runId: null, readAt: null, createdAt: new Date().toISOString() });
        sent++;
      }
    }
    return sent;
  }
}
