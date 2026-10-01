/**
 * @file 労務カレンダー（仕様書 第30.19.1節）。期限を並べ、14 日前と 3 日前に人事区画の人へ知らせ、朝のブリーフに渡す。
 * 源泉所得税と住民税の納付は、M2Office で給与を確定している会社にだけ知らせる（画面には出す）。
 *
 * 期限は calendar.ts（決まったプログラム）で出す。人事区画の確かめは呼ぶ側（API・ツール）が行う。
 */

import { randomUUID } from 'node:crypto';
import { HR_COMPARTMENT, type HrDeadline, type HrTerms } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { HrStore } from './store.js';
import type { PayrollStore } from './payroll-store.js';
import type { LaborStore } from './labor-store.js';
import type { AttendanceService } from './attendance-service.js';
import { termsOn } from './attendance-service.js';
import { buildDeadlines } from './calendar.js';
import { withinFiveDays } from './procedures.js';
import { jstDate } from './attendance.js';
import { Law } from './law/lookup.js';
import type { LawBook } from './law/types.js';

/** 労務カレンダーに要るもの。 */
export interface LaborCalendarDeps {
  hrStore: HrStore;
  payrollStore: PayrollStore;
  attendance: AttendanceService;
  repo: Repository;
  /** 法令の表（変わり目と更新待ちを出す。第30.18.1節）。 */
  law?: LawBook;
  /** 年度更新の下書きの結果（延納の第 2 期・第 3 期の納期限を出す。第30.13.1節）。 */
  laborStore?: LaborStore;
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
    const law = this.deps.law ? this.lawItems(new Law(this.deps.law), today, days, settings.health.prefecture) : [];
    // 賞与支払届（支払日を 1 日目として 5 日目まで。資格取得届などとそろえる。第30.11.1節）
    for (const r of await this.deps.payrollStore.listRuns(tenantId)) {
      if (r.kind !== 'bonus' || (r.status !== 'confirmed' && r.status !== 'paid')) continue;
      const due = withinFiveDays(r.payDate);
      law.push({ date: due, kind: 'bonus-report', title: `賞与支払届（${Number(r.payMonth.slice(5, 7))} 月の賞与）`, detail: '「給与」の賞与の回で下書きを出し、年金事務所（健康保険組合）に届け出る' });
    }
    // 労働保険の延納の第 2 期・第 3 期（年度更新の下書きを作った年）
    if (this.deps.laborStore) {
      const y = Number(today.slice(0, 4));
      for (const year of [y - 1, y]) {
        const rec = await this.deps.laborStore.get(tenantId, year);
        for (const [i, p] of (rec?.result?.installments ?? []).entries()) {
          if (i === 0 || p.amount <= 0) continue;
          law.push({ date: p.due, kind: 'labor-insurance', title: `労働保険料の納付（${year} 年度・延納の第 ${i + 1} 期）`, detail: `${p.amount.toLocaleString('ja-JP')} 円（年度更新の下書きから）` });
        }
      }
    }
    return { items: buildDeadlines({ today, days, settings, employees, terms, tasks, obligations, payments, law }), usesPayroll: payments.length > 0 };
  }

  /** 法令の表の変わり目と、更新待ち（時期の 45 日前から）。 */
  private lawItems(law: Law, today: string, days: number, prefecture: string): HrDeadline[] {
    const end = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const items: HrDeadline[] = law.changesBetween(today, end, prefecture).map((c) => ({
      date: c.date, kind: 'law-change', title: `${c.label}が変わります（${c.applies}）`, detail: `${c.detail}。計算は自動で新しい表に切り替わります`,
    }));
    const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 45 * 86_400_000).toISOString().slice(0, 7);
    for (const s of law.staleAt(soon)) {
      const due = `${s.expectedFrom}-01`;
      items.push({
        date: due < today ? today : due, kind: 'law-stale', title: `法令の表の更新待ち（${s.label}・${Number(s.expectedFrom.slice(0, 4))} 年 ${Number(s.expectedFrom.slice(5, 7))} 月分から）`,
        detail: '運営が表を更新します。更新されるまでは前の表で計算し、明細と点検に示します',
      });
    }
    return items;
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
