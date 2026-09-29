/**
 * @file 給与の処理（仕様書 第30.10.1節。人事・給与の段 3）。給与の情報・標準報酬月額・家族と、月の給与の下書きの計算。
 *
 * 額は calcSlip（決まったプログラム）で出す。勤怠は締めの期間の集計を使い、締めていなければその時点の集計で計算して示す。
 * 下書きは何度でも計算し直せる。点検・確定（承認）・明細・振込データは段 4。人事区画の確かめは呼ぶ側（API）が行う。
 */

import { randomUUID } from 'node:crypto';
import type {
  AuditEvent, HrEmployee, HrFamilyMember, HrPayrollProfile, HrResidentTax, HrStandardPay, PayRun, PaySlip,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { HrStore } from './store.js';
import type { PayrollStore } from './payroll-store.js';
import type { AttendanceService } from './attendance-service.js';
import { termsOn } from './attendance-service.js';
import { periodOf } from './attendance.js';
import { dayOfMonth } from './procedures.js';
import { calcSlip, shiftMonth } from './payroll.js';
import { Law } from './law/lookup.js';
import type { LawBook } from './law/types.js';

/** 給与の処理に要るもの。 */
export interface PayrollServiceDeps {
  store: PayrollStore;
  hrStore: HrStore;
  attendance: AttendanceService;
  repo: Repository;
  law: LawBook;
}

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 給与の処理（段 3）。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。監査ログには額を入れない（件数と項目の名前だけ）
 */
export class PayrollService {
  readonly law: Law;

  constructor(readonly deps: PayrollServiceDeps) {
    this.law = new Law(deps.law);
  }

  /** 給与の情報（無ければ既定: 甲欄・扶養 0 人）。 */
  async profile(tenantId: string, employeeId: string): Promise<HrPayrollProfile> {
    return (await this.deps.store.getProfile(tenantId, employeeId)) ?? { employeeId, taxColumn: 'ko', dependents: 0, residentTax: [], commute: {}, bank: {} };
  }

  /** 給与の情報を直す（送った項目だけ）。 */
  async saveProfile(tenantId: string, userId: string, employeeId: string, input: Partial<HrPayrollProfile>): Promise<{ profile: HrPayrollProfile } | { error: string }> {
    const cur = await this.profile(tenantId, employeeId);
    const next: HrPayrollProfile = { ...cur };
    if (input.taxColumn !== undefined) {
      if (input.taxColumn !== 'ko' && input.taxColumn !== 'otsu') return { error: '税の区分は甲欄か乙欄です' };
      next.taxColumn = input.taxColumn;
    }
    if (input.dependents !== undefined) {
      const n = Number(input.dependents);
      if (!Number.isInteger(n) || n < 0 || n > 20) return { error: '扶養親族等の数は 0〜20 人で入れてください' };
      next.dependents = n;
    }
    if (input.residentTax !== undefined) {
      if (!Array.isArray(input.residentTax)) return { error: '住民税の形が違います' };
      const list: HrResidentTax[] = [];
      for (const r of input.residentTax) {
        const y = Number(r?.fiscalYear);
        const june = Number(r?.june);
        const monthly = Number(r?.monthly);
        if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(june) || june < 0 || !Number.isInteger(monthly) || monthly < 0) return { error: '住民税の年度と額を整数で入れてください' };
        list.push({ fiscalYear: y, municipality: String(r?.municipality ?? '').trim().slice(0, 50), june, monthly });
      }
      next.residentTax = list.sort((a, b) => b.fiscalYear - a.fiscalYear).slice(0, 10);
    }
    if (input.commute !== undefined) {
      const m = input.commute.monthly === undefined ? undefined : Number(input.commute.monthly);
      const f = input.commute.taxFree === undefined ? undefined : Number(input.commute.taxFree);
      if ((m !== undefined && (!Number.isFinite(m) || m < 0)) || (f !== undefined && (!Number.isFinite(f) || f < 0))) return { error: '通勤手当の額は 0 以上で入れてください' };
      next.commute = { means: String(input.commute.means ?? cur.commute.means ?? '').slice(0, 50), ...(m !== undefined ? { monthly: Math.round(m) } : {}), ...(f !== undefined ? { taxFree: Math.round(f) } : {}) };
    }
    if (input.bank !== undefined) {
      const b = input.bank;
      if (b.number !== undefined && b.number !== '' && !/^\d{1,7}$/.test(String(b.number))) return { error: '口座番号は 7 桁までの数字です' };
      next.bank = {
        bank: String(b.bank ?? '').slice(0, 50), branch: String(b.branch ?? '').slice(0, 50),
        ...(b.type === '当座' ? { type: '当座' as const } : { type: '普通' as const }), number: String(b.number ?? ''), holder: String(b.holder ?? '').slice(0, 60),
      };
    }
    await this.deps.store.saveProfile(tenantId, next, userId);
    await this.audit(tenantId, userId, 'hr.payroll.profile', employeeId, { fields: Object.keys(input) });
    return { profile: next };
  }

  /** 標準報酬月額の履歴。 */
  async standardPays(tenantId: string, employeeId: string): Promise<HrStandardPay[]> {
    return this.deps.store.listStandardPay(tenantId, employeeId);
  }

  /**
   * 標準報酬月額を足す。報酬の額を入れれば、等級表で標準報酬月額に直す。
   */
  async addStandardPay(tenantId: string, userId: string, employeeId: string, fromMonth: string, pay: number): Promise<{ standardPay: HrStandardPay; grade: number } | { error: string }> {
    if (!YM.test(fromMonth)) return { error: '適用の月を YYYY-MM で入れてください' };
    if (!Number.isFinite(pay) || pay <= 0) return { error: '額を入れてください' };
    const g = this.law.grade(Math.round(pay), fromMonth);
    if (!g) return { error: 'その月の等級表がありません' };
    const s: HrStandardPay = { id: randomUUID(), employeeId, fromMonth, amount: g.value.health.amount, kind: 'manual' };
    await this.deps.store.addStandardPay(tenantId, { ...s, createdBy: userId });
    await this.audit(tenantId, userId, 'hr.payroll.standard', employeeId, { fromMonth, grade: g.value.health.grade });
    return { standardPay: s, grade: g.value.health.grade };
  }

  /** 家族。 */
  async family(tenantId: string, employeeId: string): Promise<HrFamilyMember[]> {
    return this.deps.store.listFamily(tenantId, employeeId);
  }

  async addFamily(tenantId: string, userId: string, employeeId: string, input: Partial<HrFamilyMember>): Promise<{ member: HrFamilyMember } | { error: string }> {
    const name = String(input.name ?? '').trim().slice(0, 100);
    if (!name) return { error: '氏名を入れてください' };
    const birth = input.birthDate ? String(input.birthDate) : null;
    if (birth && !/^\d{4}-\d{2}-\d{2}$/.test(birth)) return { error: '生年月日を YYYY-MM-DD で入れてください' };
    const m: HrFamilyMember = {
      id: randomUUID(), employeeId, name, relation: String(input.relation ?? '').slice(0, 20), birthDate: birth, cohabiting: input.cohabiting !== false,
      incomeEstimate: input.incomeEstimate === null || input.incomeEstimate === undefined ? null : Math.max(0, Math.round(Number(input.incomeEstimate))), dependent: !!input.dependent,
    };
    await this.deps.store.addFamily(tenantId, m);
    await this.audit(tenantId, userId, 'hr.payroll.family', employeeId, { add: true });
    return { member: m };
  }

  async removeFamily(tenantId: string, userId: string, employeeId: string, id: string): Promise<boolean> {
    const ok = await this.deps.store.removeFamily(tenantId, employeeId, id);
    if (ok) await this.audit(tenantId, userId, 'hr.payroll.family', employeeId, { remove: true });
    return ok;
  }

  /** 支給月の支払日と、勤怠の期間（その月に支払日が来る締めの期間）。 */
  async schedule(tenantId: string, payMonth: string): Promise<{ payDate: string; period: { start: string; end: string; label: string } }> {
    const s = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const [y, m] = payMonth.split('-').map(Number) as [number, number];
    const payDate = dayOfMonth(y, m - 1, s.pay.payDay);
    const period = periodOf(s.pay.payMonth === 'next' ? shiftMonth(payMonth, -1) : payMonth, s.pay.closingDay);
    return { payDate, period };
  }

  /**
   * 支給月の月の給与を計算し、下書きとして残す（同じ支給月の下書きは置き換える）。
   *
   * @returns 回と明細
   */
  async calculate(tenantId: string, userId: string, payMonth: string): Promise<{ run: PayRun; slips: PaySlip[] } | { error: string }> {
    if (!YM.test(payMonth)) return { error: '支給月を YYYY-MM で入れてください' };
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const { payDate, period } = await this.schedule(tenantId, payMonth);
    const premiumMonth = settings.payroll.collect === 'next' ? shiftMonth(payMonth, -1) : payMonth;
    const employees = (await this.deps.hrStore.listEmployees(tenantId))
      .filter((e) => e.category !== 'owner' && (!e.hiredOn || e.hiredOn <= period.end) && (!e.leftOn || e.leftOn >= period.start));
    const [profiles, stdAll] = await Promise.all([this.deps.store.listProfiles(tenantId), this.deps.store.listStandardPay(tenantId)]);
    const runWarnings: string[] = [];
    if (!(await this.deps.attendance.isClosed(tenantId, period.end))) runWarnings.push(`勤怠（${period.label}）が締まっていません。いまの勤怠で計算しました`);
    const runId = randomUUID();
    const law: PayRun['law'] = {};
    const slips: PaySlip[] = [];
    for (const e of employees) {
      const terms = termsOn(await this.deps.hrStore.listTerms(tenantId, e.id), period.end);
      const { days, totals } = await this.deps.attendance.days(tenantId, e, { ...period });
      const std = stdAll.filter((s) => s.employeeId === e.id && s.fromMonth <= premiumMonth).sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))[0]?.amount ?? null;
      const r = calcSlip({
        employee: e, terms, profile: profiles.find((p) => p.employeeId === e.id) ?? null, standardPay: std, totals, days, settings,
        payMonth, payDate, periodEnd: period.end, law: this.law,
      });
      for (const t of r.tables) law[t.version] = { version: t.version, source: t.source, reviewed: t.review.status === 'verified' };
      slips.push({ id: randomUUID(), runId, employeeId: e.id, employeeName: e.name, gross: r.gross, deductions: r.deductions, net: r.net, lines: r.lines, warnings: r.warnings });
    }
    if (Object.values(law).some((l) => !l.reviewed)) runWarnings.push('法令の表が監修前です。この回は確定に使えません');
    const run: PayRun = {
      id: runId, kind: 'monthly', payMonth, payDate, periodStart: period.start, periodEnd: period.end, status: 'draft', law, warnings: runWarnings,
      calculatedAt: new Date().toISOString(),
    };
    await this.deps.store.replaceDraft(tenantId, { ...run, calculatedBy: userId }, slips);
    await this.audit(tenantId, userId, 'hr.payroll.calculate', `${payMonth}`, { employees: slips.length, warnings: slips.reduce((s, x) => s + x.warnings.length, 0) });
    return { run, slips };
  }

  /** 回の一覧（新しい順）。 */
  async runs(tenantId: string): Promise<PayRun[]> {
    return this.deps.store.listRuns(tenantId);
  }

  /** 回と明細。 */
  async run(tenantId: string, userId: string, runId: string): Promise<{ run: PayRun; slips: PaySlip[] } | null> {
    const run = await this.deps.store.getRun(tenantId, runId);
    if (!run) return null;
    const slips = await this.deps.store.listSlips(tenantId, runId);
    await this.audit(tenantId, userId, 'hr.payroll.view', runId, { slips: slips.length });
    return { run, slips };
  }

  /** 従業員（計算の対象か確かめる）。 */
  async employee(tenantId: string, id: string): Promise<HrEmployee | null> {
    return this.deps.hrStore.getEmployee(tenantId, id);
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = {
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: action.startsWith('hr.payroll.calculate') || action === 'hr.payroll.view' ? 'hr' : 'hr_employee',
      targetId, detail, occurredAt: new Date().toISOString(),
    };
    await this.deps.repo.appendAudit(ev);
  }
}
