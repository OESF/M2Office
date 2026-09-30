/**
 * @file 給与の処理（仕様書 第30.10.1節・第30.10.3節。人事・給与の段 3・段 4）。
 *
 * 給与の情報・標準報酬月額・家族、月の給与の計算（下書き）と点検、確定（管理者が押すことを承認とする。ADR-0053）、
 * 明細の配布（本人の同意・本人の画面・PDF）、振込データ、賃金台帳、住民税の決定通知書の読み取り、試しの計算。
 * 額は calcSlip（決まったプログラム）で出す（H-1）。人事区画と管理者の確かめは呼ぶ側（API）が行う。
 */

import { randomUUID } from 'node:crypto';
import {
  HR_COMPARTMENT,
  type AuditEvent, type AttTotals, type HrEmployee, type HrFamilyMember, type HrPayrollProfile, type HrResidentTax, type HrStandardPay, type HrTerms,
  type BonusPlan, type NotificationKind, type PayAdjustment, type PayCheck, type PayLine, type PayRun, type PaySlip, type PayTrialCompare,
} from '@m2office/shared';
import { calcBonus } from './bonus.js';
import type { LlmProvider } from '../llm/provider.js';
import { scheduledMinutes } from './attendance.js';
import type { SlipWithRun } from './payroll-store.js';
import { reviewRun, reviewOther, explainDiff } from './payroll-review.js';
import { buildZenginFile, toZenginKana, type ZenginPayee, type ZenginProblem } from './zengin.js';
import { renderPayslipPdf } from './payslip-pdf.js';
import { readResidentNotice, noticeProblem } from './resident-notice.js';
import { mapTrialHeaders, trialTotals, compareTrialRow, emptyCompare, personKey, type TrialItem } from './payroll-trial.js';
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
  /** 会社の推論（住民税の通知書の読み取り・試しの計算の見出し）。 */
  llm?: (tenantId: string) => Promise<LlmProvider>;
  /** 監修前の表でも確定できるか（デバッグモードのときだけ `true`。ADR-0053）。 */
  allowUnverified?: boolean;
  /** 社会保険の知らせ（随時改定・加入の判定。第30.12.1節）。月の給与の点検に足す。 */
  socialHints?: (tenantId: string) => Promise<PayCheck[]>;
}

/** 本人に見せる明細の一覧の 1 つ。 */
export interface MySlipSummary {
  id: string;
  payMonth: string;
  payDate: string;
  kind: PayRun['kind'];
  gross: number;
  deductions: number;
  net: number;
}

/** 通知書を当てた結果。 */
export interface NoticeApplyResult {
  applied: { employeeId: string; name: string; fiscalYear: number; june: number; monthly: number }[];
  /** 当てられなかった人・額が確かめられなかった人。 */
  skipped: { name: string; reason: string }[];
}

const payMonthLabel = (ym: string) => `${Number(ym.slice(0, 4))} 年 ${Number(ym.slice(5, 7))} 月支給`;
/** 回の種類の呼び名（明細の題名と知らせに使う）。 */
const KIND_LABEL: Record<PayRun['kind'], string> = { monthly: '給与', bonus: '賞与', correction: '給与の訂正', yea: '年末調整', trial: '試しの計算' };
const YMD = /^\d{4}-\d{2}-\d{2}$/;

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
      const code = (v: unknown) => String(v ?? '').normalize('NFKC').trim();
      if (b.number !== undefined && b.number !== '' && !/^\d{1,7}$/.test(code(b.number))) return { error: '口座番号は 7 桁までの数字です' };
      if (b.bankCode && !/^\d{4}$/.test(code(b.bankCode))) return { error: '銀行コードは 4 桁の数字です' };
      if (b.branchCode && !/^\d{3}$/.test(code(b.branchCode))) return { error: '支店コードは 3 桁の数字です' };
      const holder = String(b.holder ?? '').trim().slice(0, 60);
      if (holder && toZenginKana(holder).bad.length) return { error: `名義はカナで入れてください（使えない字: ${toZenginKana(holder).bad.join('')}）` };
      next.bank = {
        bank: String(b.bank ?? '').slice(0, 50), bankCode: code(b.bankCode), branch: String(b.branch ?? '').slice(0, 50), branchCode: code(b.branchCode),
        ...(b.type === '当座' ? { type: '当座' as const } : { type: '普通' as const }), number: code(b.number), holder,
      };
    }
    if (input.insurance !== undefined) {
      const i = input.insurance ?? {};
      const number = String(i.number ?? cur.insurance?.number ?? '').normalize('NFKC').trim();
      if (number && !/^\d{1,10}$/.test(number)) return { error: '被保険者整理番号は数字で入れてください' };
      const ot = i.overtimeEstimate === undefined ? cur.insurance?.overtimeEstimate : Number(i.overtimeEstimate);
      if (ot !== undefined && (!Number.isFinite(ot) || ot < 0)) return { error: '見込みの時間外手当は 0 以上で入れてください' };
      next.insurance = { number, student: i.student === undefined ? !!cur.insurance?.student : !!i.student, ...(ot !== undefined ? { overtimeEstimate: Math.round(ot) } : {}) };
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
   * 支給月の全員分を計算する（残さない）。月の給与の下書きと試しの計算が使う。
   *
   * @param totalsOf 勤怠の集計を差し替える（試しの計算）。無ければ締めの期間の勤怠を使う
   */
  private async compute(tenantId: string, payMonth: string, runId: string, totalsOf?: (e: HrEmployee, days: import('@m2office/shared').AttDay[], terms: HrTerms | null) => AttTotals | null) {
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const { payDate, period } = await this.schedule(tenantId, payMonth);
    const premiumMonth = settings.payroll.collect === 'next' ? shiftMonth(payMonth, -1) : payMonth;
    const employees = (await this.deps.hrStore.listEmployees(tenantId))
      .filter((e) => e.category !== 'owner' && (!e.hiredOn || e.hiredOn <= period.end) && (!e.leftOn || e.leftOn >= period.start));
    const [profiles, stdAll, adjustments] = await Promise.all([
      this.deps.store.listProfiles(tenantId), this.deps.store.listStandardPay(tenantId), this.deps.store.listAdjustments(tenantId, 'monthly', payMonth),
    ]);
    const law: PayRun['law'] = {};
    const slips: PaySlip[] = [];
    const termsBy = new Map<string, HrTerms[]>();
    for (const e of employees) {
      const history = await this.deps.hrStore.listTerms(tenantId, e.id);
      termsBy.set(e.id, history);
      const terms = termsOn(history, period.end);
      const got = await this.deps.attendance.days(tenantId, e, { ...period });
      let totals = got.totals;
      if (totalsOf) {
        const t = totalsOf(e, got.days, terms);
        if (!t) continue;
        totals = t;
      }
      const std = stdAll.filter((x) => x.employeeId === e.id && x.fromMonth <= premiumMonth).sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))[0]?.amount ?? null;
      const r = calcSlip({
        employee: e, terms, profile: profiles.find((p) => p.employeeId === e.id) ?? null, standardPay: std, totals, days: got.days, settings,
        payMonth, payDate, periodEnd: period.end, law: this.law, adjustments: totalsOf ? [] : adjustments.filter((a) => a.employeeId === e.id),
      });
      for (const t of r.tables) law[t.version] = { version: t.version, source: t.source, reviewed: t.review.status === 'verified' };
      slips.push({ id: randomUUID(), runId, employeeId: e.id, employeeName: e.name, gross: r.gross, deductions: r.deductions, net: r.net, lines: r.lines, warnings: r.warnings, attendance: totals, meta: r.meta });
    }
    return { settings, payDate, period, premiumMonth, employees, profiles, slips, law, termsBy };
  }

  /**
   * 支給月の月の給与を計算して点検し、下書きとして残す（同じ支給月の下書きは置き換える）。確定した月は計算し直せない。
   *
   * @returns 回と明細
   */
  async calculate(tenantId: string, userId: string, payMonth: string): Promise<{ run: PayRun; slips: PaySlip[] } | { error: string }> {
    if (!YM.test(payMonth)) return { error: '支給月を YYYY-MM で入れてください' };
    const done = (await this.deps.store.listRuns(tenantId)).find((r) => r.kind === 'monthly' && r.payMonth === payMonth && (r.status === 'confirmed' || r.status === 'paid'));
    if (done) return { error: `${payMonthLabel(payMonth)}の給与は確定しています。確定した給与は計算し直せません` };
    const runId = randomUUID();
    const c = await this.compute(tenantId, payMonth, runId);
    const closed = !!(await this.deps.attendance.isClosed(tenantId, c.period.end));
    const unverified = Object.values(c.law).some((l) => !l.reviewed);
    const runWarnings: string[] = [];
    if (!closed) runWarnings.push(`勤怠（${c.period.label}）が締まっていません。いまの勤怠で計算しました`);
    if (unverified) runWarnings.push(this.deps.allowUnverified ? '法令の表が監修前です。開発の環境のため確定できますが、本番では確定できません' : '法令の表が監修前です。この回は確定に使えません');
    const [previous, family] = await Promise.all([
      this.deps.store.previousConfirmed(tenantId, 'monthly', payMonth),
      Promise.all(c.employees.map(async (e) => [e.id, await this.deps.store.listFamily(tenantId, e.id)] as const)),
    ]);
    const checks = reviewRun({
      payMonth, premiumMonth: c.premiumMonth, slips: c.slips, previous: new Map(previous.map((x) => [x.employeeId, x])),
      employees: new Map(c.employees.map((e) => [e.id, e])), profiles: new Map(c.profiles.map((p) => [p.employeeId, p])), family: new Map(family), terms: c.termsBy,
      attendanceClosed: closed, periodLabel: c.period.label, unverified,
    });
    // 社会保険の知らせは、この回に入っている人の分だけ足す（取れなくても計算は止めない）
    const inRun = new Set(c.slips.map((s) => s.employeeId));
    const hints = this.deps.socialHints ? await this.deps.socialHints(tenantId).catch(() => [] as PayCheck[]) : [];
    checks.push(...hints.filter((h) => h.employeeId && inRun.has(h.employeeId)));
    const run: PayRun = {
      id: runId, kind: 'monthly', payMonth, payDate: c.payDate, periodStart: c.period.start, periodEnd: c.period.end, status: 'draft', law: c.law, warnings: runWarnings,
      calculatedAt: new Date().toISOString(), checks,
    };
    await this.deps.store.replaceDraft(tenantId, { ...run, calculatedBy: userId }, c.slips);
    await this.audit(tenantId, userId, 'hr.payroll.calculate', `${payMonth}`, { employees: c.slips.length, stops: checks.filter((x) => x.level === 'stop').length, checks: checks.length });
    return { run, slips: c.slips };
  }

  /** 確定を止めているもの（開発の環境では、監修前の表を除く）。 */
  blockers(run: PayRun): PayCheck[] {
    return run.checks.filter((x) => x.level === 'stop' && !(x.code === 'unverified' && this.deps.allowUnverified));
  }

  /**
   * 月の給与を確定する（お金の確定。管理者が押すことを承認とする。ADR-0053）。確定したら明細を本人に出す。
   *
   * @remarks 危険度: financial。呼ぶ側が「管理者で人事区画に入っている」ことを確かめる
   */
  async confirm(tenantId: string, userId: string, runId: string): Promise<{ run: PayRun; published: number; pdf: string[] } | { error: string; blockers?: PayCheck[] }> {
    const run = await this.deps.store.getRun(tenantId, runId);
    if (!run || run.kind === 'trial') return { error: '回が見つかりません' };
    if (run.status !== 'draft') return { error: 'この回は確定しています' };
    const blockers = this.blockers(run);
    if (blockers.length) return { error: '点検で止まっているものがあるため、確定できません', blockers };
    const unverified = Object.values(run.law).some((l) => !l.reviewed);
    const done = await this.deps.store.confirmRun(tenantId, runId, userId, unverified);
    if (!done) return { error: 'この回は確定できません（すでに確定したか、計算し直されました）' };
    // 明細を本人に出す（画面で受け取る同意のある人だけ。無い人は PDF で渡す）
    const [slips, profiles] = await Promise.all([this.deps.store.listSlips(tenantId, runId), this.deps.store.listProfiles(tenantId)]);
    let published = 0;
    const pdf: string[] = [];
    for (const sl of slips) {
      const e = await this.deps.hrStore.getEmployee(tenantId, sl.employeeId);
      const consent = profiles.find((p) => p.employeeId === sl.employeeId)?.payslipConsentAt;
      if (e?.userId && consent) {
        await this.notify(tenantId, e.userId, 'attendance', `${KIND_LABEL[run.kind]}の明細（${payMonthLabel(run.payMonth)}）が届きました`, `差引支給 ${sl.net.toLocaleString('ja-JP')} 円。「給与・勤怠」で見られます`);
        published++;
      } else {
        pdf.push(sl.employeeName ?? '');
      }
    }
    // 訂正の回・年末調整の回で差額が控除（不足）になる人は、次の月の給与で差し引く（第30.10.4節・第30.15.1節。税と雇用保険は直し済み）
    let carried = 0;
    if (run.kind === 'correction' || run.kind === 'yea') {
      const next = shiftMonth(run.payMonth, 1);
      for (const sl of slips.filter((x) => x.net < 0)) {
        await this.deps.store.addAdjustment(tenantId, {
          id: randomUUID(), employeeId: sl.employeeId, kind: 'monthly', payMonth: next,
          label: run.kind === 'yea' ? `${run.payMonth.slice(0, 4)} 年の年末調整の不足` : `${Number(run.payMonth.slice(5, 7))} 月分の訂正`, direction: 'deduct',
          amount: -sl.net, taxable: false, insurable: false, reason: run.kind === 'yea' ? '年末調整の回の不足額' : '訂正の回の差額（控除）',
          source: run.kind === 'yea' ? 'yea' : 'correction', createdBy: userId, sourceRunId: run.id,
        });
        carried++;
      }
    }
    await this.audit(tenantId, userId, 'hr.payroll.confirm', runId, { kind: run.kind, payMonth: run.payMonth, slips: slips.length, published, unverified, carried });
    return { run: done, published, pdf };
  }

  /** 管理者に確定を頼む（人事区画に入っている管理者に知らせる）。 */
  async requestConfirm(tenantId: string, userId: string, runId: string): Promise<{ sent: number } | { error: string }> {
    const run = await this.deps.store.getRun(tenantId, runId);
    if (!run || run.kind === 'trial' || run.status !== 'draft') return { error: '確定を頼める回ではありません' };
    const slips = await this.deps.store.listSlips(tenantId, runId);
    const net = slips.reduce((s, x) => s + x.net, 0);
    let sent = 0;
    for (const u of await this.deps.repo.listUsers(tenantId)) {
      if (u.status !== 'active' || u.id === userId || !u.roles.includes('admin')) continue;
      if (!(await this.deps.repo.listUserCompartments(tenantId, u.id)).includes(HR_COMPARTMENT)) continue;
      sent += await this.notify(tenantId, u.id, 'approval', `給与の確定のお願い（${payMonthLabel(run.payMonth)}）`, `${slips.length} 人・差引支給の計 ${net.toLocaleString('ja-JP')} 円。人事・給与の「給与」で点検を見て確定してください`);
    }
    await this.deps.store.markConfirmRequested(tenantId, runId);
    await this.audit(tenantId, userId, 'hr.payroll.request', runId, { sent });
    return { sent };
  }

  /**
   * 振込データ（全銀協の形式）を作る。確定した回からだけ。振込先の無い人・差引支給が 0 円以下の人は入れない。
   *
   * @remarks 危険度: financial（確定を承認とみなす。ADR-0053）。呼ぶ側が管理者を確かめる。送金はしない
   */
  async transfer(tenantId: string, userId: string, runId: string): Promise<{ bytes: Uint8Array; filename: string; count: number; excluded: string[] } | { error: string; problems?: ZenginProblem[] }> {
    const run = await this.deps.store.getRun(tenantId, runId);
    if (!run || run.kind === 'trial') return { error: '回が見つかりません' };
    if (run.status !== 'confirmed' && run.status !== 'paid') return { error: '振込データは確定した回からだけ作れます' };
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const [slips, profiles] = await Promise.all([this.deps.store.listSlips(tenantId, runId), this.deps.store.listProfiles(tenantId)]);
    const payees: ZenginPayee[] = [];
    const excluded: string[] = [];
    for (const sl of slips) {
      const b = profiles.find((p) => p.employeeId === sl.employeeId)?.bank ?? {};
      if (sl.net <= 0 || !b.bankCode || !b.branchCode || !b.number) { excluded.push(sl.employeeName ?? ''); continue; }
      const e = await this.deps.hrStore.getEmployee(tenantId, sl.employeeId);
      payees.push({
        bankCode: b.bankCode, bankName: b.bank ?? '', branchCode: b.branchCode, branchName: b.branch ?? '', accountType: b.type ?? '普通', accountNumber: b.number,
        holder: b.holder || e?.kana || '', amount: sl.net, customerCode: e?.code ?? '',
      });
    }
    const built = buildZenginFile(settings.transfer, run.payDate, payees);
    if ('problems' in built) return { error: '振込データを作れません', problems: built.problems };
    await this.deps.store.markTransfer(tenantId, runId, userId);
    await this.audit(tenantId, userId, 'hr.payroll.transfer', runId, { payMonth: run.payMonth, count: built.count, excluded: excluded.length });
    return { bytes: built.bytes, filename: `furikomi-${run.payMonth}${run.kind === 'monthly' ? '' : `-${run.kind}`}.txt`, count: built.count, excluded };
  }

  /** 明細の PDF（担当者が渡す。本人も自分の分を出せる）。 */
  async slipPdf(tenantId: string, userId: string, slipId: string, onlyEmployeeId?: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
    const sl = await this.deps.store.getSlip(tenantId, slipId);
    if (!sl || sl.run.kind === 'trial' || (onlyEmployeeId && (sl.employeeId !== onlyEmployeeId || sl.run.status === 'draft'))) return null;
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const tenant = await this.deps.repo.findTenantById(tenantId);
    const bytes = await renderPayslipPdf({ run: sl.run, slip: sl, employeeName: sl.employeeName ?? '', employeeCode: sl.employeeCode, company: settings.office.name || tenant?.name || '', title: `${KIND_LABEL[sl.run.kind]}明細` });
    await this.audit(tenantId, userId, 'hr.payroll.pdf', slipId, { self: !!onlyEmployeeId });
    return { bytes, filename: `payslip-${sl.run.payMonth}.pdf` };
  }

  /**
   * 賃金台帳（年の確定した月の給与。法定の記載事項）。
   *
   * @returns 表計算に書き出す列と行
   */
  async ledger(tenantId: string, userId: string, year: number): Promise<{ columns: string[]; rows: (string | number | null)[][] }> {
    const slips = await this.deps.store.listYearSlips(tenantId, year);
    const payLabels: string[] = [];
    const dedLabels: string[] = [];
    for (const sl of slips) for (const l of sl.lines) {
      const list = l.kind === 'pay' ? payLabels : dedLabels;
      if (!list.includes(l.label)) list.push(l.label);
    }
    const h = (m?: number) => (m === undefined ? null : Math.round((m / 60) * 100) / 100);
    const gender = (g?: string) => (g === 'male' ? '男' : g === 'female' ? '女' : '');
    const columns = ['氏名', '社員番号', '性別', '種類', '支給月', '支払日', '賃金の計算期間', '労働日数', '労働時間数', '時間外労働時間数', '休日労働時間数', '深夜労働時間数',
      ...payLabels, '総支給', ...dedLabels, '控除の計', '差引支給'];
    const rows = slips.map((sl) => {
      const a = sl.attendance ?? {};
      const amount = (kind: 'pay' | 'deduct', label: string) => sl.lines.filter((l) => l.kind === kind && l.label === label).reduce((s, l) => s + l.amount, 0) || null;
      return [sl.employeeName ?? '', sl.employeeCode ?? '', gender(sl.employeeGender), KIND_LABEL[sl.run.kind], sl.run.payMonth, sl.run.payDate, sl.run.kind === 'bonus' ? '' : `${sl.run.periodStart}〜${sl.run.periodEnd}`,
        a.workDays ?? null, h(a.workMinutes), h(a.overtimeMinutes), h(a.holidayMinutes), h(a.nightMinutes),
        ...payLabels.map((l) => amount('pay', l)), sl.gross, ...dedLabels.map((l) => amount('deduct', l)), sl.deductions, sl.net];
    });
    await this.audit(tenantId, userId, 'hr.payroll.ledger', String(year), { rows: rows.length });
    return { columns, rows };
  }

  /**
   * 住民税の決定通知書を読み、氏名で従業員に当てて給与の情報に入れる。額が確かめられないもの・当てられない人は入れない。
   */
  async readNotice(tenantId: string, userId: string, bytes: Uint8Array, mimeType: string): Promise<NoticeApplyResult | { error: string }> {
    if (!this.deps.llm) return { error: 'AI が使えないため、通知書を読めません' };
    const reading = await readResidentNotice(await this.deps.llm(tenantId), bytes, mimeType);
    if (reading.status === 'unavailable') return { error: reading.reason };
    if (reading.status === 'not-notice' || reading.entries.length === 0) return { error: '住民税の決定通知書として読めませんでした' };
    const employees = await this.deps.hrStore.listEmployees(tenantId);
    const out: NoticeApplyResult = { applied: [], skipped: [] };
    for (const en of reading.entries) {
      const problem = noticeProblem(en);
      if (problem) { out.skipped.push({ name: en.name, reason: problem }); continue; }
      const byName = employees.filter((e) => personKey(e.name) === personKey(en.name));
      const hits = byName.length === 1 ? byName : en.kana ? employees.filter((e) => e.kana && personKey(e.kana) === personKey(en.kana)) : byName;
      if (hits.length !== 1) { out.skipped.push({ name: en.name, reason: hits.length ? '同じ名前の従業員が複数います' : '台帳に当てられる従業員がいません' }); continue; }
      const e = hits[0]!;
      const cur = await this.profile(tenantId, e.id);
      const entry: HrResidentTax = { fiscalYear: en.fiscalYear!, municipality: en.municipality, june: en.june!, monthly: en.monthly!, annual: en.annual!, source: 'notice' };
      await this.deps.store.saveProfile(tenantId, { ...cur, residentTax: [entry, ...cur.residentTax.filter((r) => r.fiscalYear !== entry.fiscalYear)].sort((a, b) => b.fiscalYear - a.fiscalYear).slice(0, 10) }, userId);
      out.applied.push({ employeeId: e.id, name: e.name, fiscalYear: entry.fiscalYear, june: entry.june, monthly: entry.monthly });
    }
    await this.audit(tenantId, userId, 'hr.payroll.resident', 'notice', { applied: out.applied.length, skipped: out.skipped.length });
    return out;
  }

  /**
   * 試しの計算。今の方法の給与の表（1 行目が見出し）と並べ、人ごと・項目ごとの差を出す。確定できず、本人にも出さない。
   *
   * @param rows 表の行（1 行目が見出し）
   */
  async trial(tenantId: string, userId: string, payMonth: string, rows: (string | number | boolean | null)[][]): Promise<{ run: PayRun; slips: PaySlip[] } | { error: string }> {
    if (!YM.test(payMonth)) return { error: '支給月を YYYY-MM で入れてください' };
    const [head, ...body] = rows;
    if (!head || body.length === 0) return { error: '表に行がありません' };
    const columns = await mapTrialHeaders(head.map((h) => String(h ?? '')), this.deps.llm ? await this.deps.llm(tenantId) : undefined);
    const idx = new Map<TrialItem, number>();
    columns.forEach((c, i) => { if (c.item) idx.set(c.item, i); });
    if (!idx.has('name') && !idx.has('code')) return { error: '表に氏名か社員番号の列が見つかりません' };
    const records = body.map((r) => Object.fromEntries([...idx].map(([k, i]) => [k, r[i]])) as Partial<Record<TrialItem, unknown>>)
      .filter((r) => String(r.name ?? r.code ?? '').trim());
    const compare: PayTrialCompare = emptyCompare(columns);
    const used = new Set<number>();
    const find = (e: HrEmployee) => {
      const i = records.findIndex((r, k) => !used.has(k) && ((r.code && e.code && String(r.code).trim() === e.code) || (r.name && personKey(String(r.name)) === personKey(e.name))));
      if (i >= 0) used.add(i);
      return i >= 0 ? records[i]! : null;
    };
    const matched = new Map<string, Partial<Record<TrialItem, unknown>>>();
    const runId = randomUUID();
    const c = await this.compute(tenantId, payMonth, runId, (e, days, terms) => {
      const r = find(e);
      if (!r) { compare.missing.push(e.name); return null; }
      matched.set(e.id, r);
      const daily = scheduledMinutes({ start: terms?.startTime || null, end: terms?.endTime || null, breakMinutes: terms?.breakMinutes ?? null }) ?? 480;
      return trialTotals(r, days, daily);
    });
    const present = new Set(idx.keys());
    for (const sl of c.slips) compare.rows.push(compareTrialRow(sl.employeeName ?? '', sl.employeeId, sl, matched.get(sl.employeeId) ?? {}, present));
    records.forEach((r, k) => { if (!used.has(k)) compare.unmatched.push(String(r.name ?? r.code ?? '')); });
    const run: PayRun = {
      id: runId, kind: 'trial', payMonth, payDate: c.payDate, periodStart: c.period.start, periodEnd: c.period.end, status: 'draft', law: c.law,
      warnings: ['試しの計算です。確定できず、本人にも出しません'], calculatedAt: new Date().toISOString(), checks: [], compare,
    };
    await this.deps.store.replaceDraft(tenantId, { ...run, calculatedBy: userId }, c.slips);
    await this.audit(tenantId, userId, 'hr.payroll.trial', payMonth, { employees: c.slips.length, unmatched: compare.unmatched.length });
    return { run, slips: c.slips };
  }

  // ---- 本人（H-3。本人の分だけ） ----

  /** 本人の明細の一覧と同意（同意が無ければ明細は出さない）。 */
  async mySlips(tenantId: string, employee: HrEmployee): Promise<{ consentAt: string | null; slips: MySlipSummary[] }> {
    const consentAt = (await this.deps.store.getProfile(tenantId, employee.id))?.payslipConsentAt ?? null;
    if (!consentAt) return { consentAt: null, slips: [] };
    const list = await this.deps.store.listConfirmedSlips(tenantId, employee.id);
    return { consentAt, slips: list.map((x) => ({ id: x.id, payMonth: x.run.payMonth, payDate: x.run.payDate, kind: x.run.kind, gross: x.gross, deductions: x.deductions, net: x.net })) };
  }

  /** 本人の明細 1 つと、前の回からの差の説明。 */
  async mySlip(tenantId: string, userId: string, employee: HrEmployee, slipId: string): Promise<{ slip: SlipWithRun; diff: string | null; previousNet: number | null } | null> {
    const consentAt = (await this.deps.store.getProfile(tenantId, employee.id))?.payslipConsentAt;
    if (!consentAt) return null;
    const list = await this.deps.store.listConfirmedSlips(tenantId, employee.id);
    const i = list.findIndex((x) => x.id === slipId);
    if (i < 0) return null;
    const prev = list.slice(i + 1).find((x) => x.run.kind === list[i]!.run.kind);
    await this.audit(tenantId, userId, 'hr.payroll.self', slipId, {});
    return { slip: list[i]!, diff: prev ? explainDiff(list[i]!, prev) || null : null, previousNet: prev?.net ?? null };
  }

  /** 明細を画面で受け取る同意（取り消しもできる）。 */
  async setConsent(tenantId: string, userId: string, employee: HrEmployee, consent: boolean): Promise<string | null> {
    const at = consent ? new Date().toISOString() : null;
    await this.deps.store.setConsent(tenantId, employee.id, at);
    await this.audit(tenantId, userId, 'hr.payroll.consent', employee.id, { consent });
    return at;
  }

  /**
   * 秘書が本人の直近の明細を答える文（本人の分だけ。H-3）。
   */
  async answerMySlip(tenantId: string, userId: string, employee: HrEmployee): Promise<string> {
    const mine = await this.mySlips(tenantId, employee);
    if (!mine.consentAt) return '給与明細を画面で受け取るには、同意が要ります。「給与・勤怠」の画面で同意すると、ここでも答えられます。';
    const latest = mine.slips[0];
    if (!latest) return 'まだ確定した給与明細がありません。';
    const d = await this.mySlip(tenantId, userId, employee, latest.id);
    const y = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
    let text = `${payMonthLabel(latest.payMonth)}（支払日 ${latest.payDate}）の${KIND_LABEL[latest.kind]}は、総支給 ${y(latest.gross)}、控除 ${y(latest.deductions)}、差引支給 ${y(latest.net)}です。`;
    if (d?.previousNet !== null && d?.previousNet !== undefined) {
      const diff = latest.net - d.previousNet;
      text += diff === 0 ? '前の回と同じ手取りです。' : `前の回より手取りが ${y(Math.abs(diff))}${diff > 0 ? '増えました' : '減りました'}${d.diff ? `（${d.diff}）` : ''}。`;
    }
    return text + '行ごとの内訳は「給与・勤怠」の画面で見られます。';
  }

  // ---- 調整の行（第30.10.4節） ----

  /** 回の調整の行。 */
  async adjustments(tenantId: string, kind: PayAdjustment['kind'], payMonth: string): Promise<PayAdjustment[]> {
    return this.deps.store.listAdjustments(tenantId, kind, payMonth);
  }

  /** その月のその種類の回が確定しているか。 */
  private async confirmedRun(tenantId: string, kind: PayRun['kind'], payMonth: string): Promise<PayRun | undefined> {
    return (await this.deps.store.listRuns(tenantId)).find((r) => r.kind === kind && r.payMonth === payMonth && (r.status === 'confirmed' || r.status === 'paid'));
  }

  /** 調整の行を足す（確定した月には足せない）。足したら、その月を計算し直すと入る。 */
  async addAdjustment(tenantId: string, userId: string, input: Partial<PayAdjustment>): Promise<{ adjustment: PayAdjustment } | { error: string }> {
    const kind = input.kind === 'bonus' ? 'bonus' : 'monthly';
    const payMonth = String(input.payMonth ?? '');
    if (!YM.test(payMonth)) return { error: '支給月を YYYY-MM で入れてください' };
    if (!input.employeeId || !(await this.deps.hrStore.getEmployee(tenantId, input.employeeId))) return { error: '従業員が見つかりません' };
    const label = String(input.label ?? '').trim().slice(0, 40);
    if (!label) return { error: '調整の名前を入れてください' };
    const amount = Math.round(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) return { error: '額は 1 円以上で入れてください' };
    if (await this.confirmedRun(tenantId, kind, payMonth)) return { error: 'この月は確定しています。次の月に足してください' };
    const direction = input.direction === 'deduct' ? 'deduct' : 'pay';
    const a: PayAdjustment = {
      id: randomUUID(), employeeId: input.employeeId, kind, payMonth, label, direction, amount,
      // 既定: 支給は所得税と雇用保険の対象に入れ、控除は入れない
      taxable: typeof input.taxable === 'boolean' ? input.taxable : direction === 'pay',
      insurable: typeof input.insurable === 'boolean' ? input.insurable : direction === 'pay',
      reason: String(input.reason ?? '').trim().slice(0, 200), source: 'manual',
    };
    await this.deps.store.addAdjustment(tenantId, { ...a, createdBy: userId });
    await this.audit(tenantId, userId, 'hr.payroll.adjust', a.employeeId, { kind, payMonth, direction, add: true });
    return { adjustment: a };
  }

  /** 調整の行を外す（確定した月の行は外せない）。 */
  async removeAdjustment(tenantId: string, userId: string, id: string, kind: PayAdjustment['kind'], payMonth: string): Promise<{ ok: true } | { error: string }> {
    if (await this.confirmedRun(tenantId, kind, payMonth)) return { error: 'この月は確定しているため、調整の行は外せません' };
    const removed = await this.deps.store.removeAdjustment(tenantId, id);
    if (!removed) return { error: '調整の行が見つかりません' };
    await this.audit(tenantId, userId, 'hr.payroll.adjust', removed.employeeId, { kind: removed.kind, payMonth: removed.payMonth, remove: true });
    return { ok: true };
  }

  // ---- 賞与（第30.11.1節） ----

  /** 賞与の回の入力。無ければ、前の賞与の額を既定にした案（支払日は空）。 */
  async bonusPlan(tenantId: string, payMonth: string): Promise<BonusPlan & { saved: boolean }> {
    const plan = await this.deps.store.getBonusPlan(tenantId, payMonth);
    if (plan) return { ...plan, saved: true };
    const prev = await this.deps.store.previousConfirmed(tenantId, 'bonus', payMonth);
    const amounts = Object.fromEntries(prev.map((s) => [s.employeeId, s.lines.find((l) => l.code === 'bonus')?.amount ?? 0]).filter(([, v]) => Number(v) > 0));
    return { payMonth, payDate: '', longPeriod: false, amounts, saved: false };
  }

  /** 賞与の回の入力を残す（確定した月は変えられない）。 */
  async saveBonusPlan(tenantId: string, userId: string, input: Partial<BonusPlan>): Promise<{ plan: BonusPlan } | { error: string }> {
    const payDate = String(input.payDate ?? '');
    if (!YMD.test(payDate)) return { error: '支払日を YYYY-MM-DD で入れてください' };
    const payMonth = payDate.slice(0, 7);
    if (await this.confirmedRun(tenantId, 'bonus', payMonth)) return { error: `${payMonthLabel(payMonth)}の賞与は確定しています` };
    const amounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.amounts ?? {})) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) return { error: '賞与の額は 0 以上の整数で入れてください' };
      if (n > 0) amounts[k] = n;
    }
    const plan: BonusPlan = { payMonth, payDate, longPeriod: !!input.longPeriod, amounts };
    await this.deps.store.saveBonusPlan(tenantId, plan, userId);
    return { plan };
  }

  /**
   * 賞与を計算して点検し、下書きとして残す（同じ月の下書きは置き換える）。確定した月は計算し直せない。
   */
  async calculateBonus(tenantId: string, userId: string, payMonth: string): Promise<{ run: PayRun; slips: PaySlip[] } | { error: string }> {
    if (!YM.test(payMonth)) return { error: '支給月を YYYY-MM で入れてください' };
    if (await this.confirmedRun(tenantId, 'bonus', payMonth)) return { error: `${payMonthLabel(payMonth)}の賞与は確定しています。確定した賞与は計算し直せません` };
    const plan = await this.deps.store.getBonusPlan(tenantId, payMonth);
    if (!plan) return { error: '先に支払日と賞与の額を入れてください' };
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const prevMonth = shiftMonth(payMonth, -1);
    const fyStart = Number(payMonth.slice(5, 7)) >= 4 ? `${payMonth.slice(0, 4)}-04` : `${Number(payMonth.slice(0, 4)) - 1}-04`;
    const [profiles, prevSlips, soFar, adjustments] = await Promise.all([
      this.deps.store.listProfiles(tenantId), this.deps.store.slipsPaidIn(tenantId, prevMonth, 'monthly'),
      this.deps.store.bonusHealthSoFar(tenantId, fyStart, payMonth), this.deps.store.listAdjustments(tenantId, 'bonus', payMonth),
    ]);
    const employees = (await this.deps.hrStore.listEmployees(tenantId))
      .filter((e) => e.category !== 'owner' && (plan.amounts[e.id] ?? 0) + adjustments.filter((a) => a.employeeId === e.id).length > 0);
    const runId = randomUUID();
    const law: PayRun['law'] = {};
    const slips: PaySlip[] = [];
    for (const e of employees) {
      const terms = termsOn(await this.deps.hrStore.listTerms(tenantId, e.id), plan.payDate);
      const prev = prevSlips.find((x) => x.employeeId === e.id);
      const r = calcBonus({
        employee: e, terms, profile: profiles.find((p) => p.employeeId === e.id) ?? null, settings, amount: plan.amounts[e.id] ?? 0, payDate: plan.payDate,
        longPeriod: plan.longPeriod, prevTaxable: prev ? prevTaxableOf(prev) : null, prevTax: prev?.lines.find((l) => l.code === 'income-tax')?.amount ?? 0,
        healthBonusSoFar: soFar.get(e.id) ?? 0, law: this.law, adjustments: adjustments.filter((a) => a.employeeId === e.id),
      });
      for (const t of r.tables) law[t.version] = { version: t.version, source: t.source, reviewed: t.review.status === 'verified' };
      slips.push({ id: randomUUID(), runId, employeeId: e.id, employeeName: e.name, gross: r.gross, deductions: r.deductions, net: r.net, lines: r.lines, warnings: r.warnings, meta: r.meta });
    }
    const unverified = Object.values(law).some((l) => !l.reviewed);
    const checks = reviewOther({ slips, employees: new Map(employees.map((e) => [e.id, e])), profiles: new Map(profiles.map((p) => [p.employeeId, p])), unverified });
    const run: PayRun = {
      id: runId, kind: 'bonus', payMonth, payDate: plan.payDate, periodStart: plan.payDate, periodEnd: plan.payDate, status: 'draft', law,
      warnings: unverified ? [this.deps.allowUnverified ? '法令の表が監修前です。開発の環境のため確定できますが、本番では確定できません' : '法令の表が監修前です。この回は確定に使えません'] : [],
      calculatedAt: new Date().toISOString(), checks,
    };
    await this.deps.store.replaceDraft(tenantId, { ...run, calculatedBy: userId }, slips);
    await this.audit(tenantId, userId, 'hr.payroll.calculate', payMonth, { kind: 'bonus', employees: slips.length, stops: checks.filter((x) => x.level === 'stop').length });
    return { run, slips };
  }

  /**
   * 賞与支払届の下書き（被保険者ごとの賞与の額と標準賞与額）。マイナンバーは載せない。
   */
  async bonusReport(tenantId: string, userId: string, runId: string): Promise<{ columns: string[]; rows: (string | number | null)[][]; payDate: string } | { error: string }> {
    const run = await this.deps.store.getRun(tenantId, runId);
    if (!run || run.kind !== 'bonus') return { error: '賞与の回が見つかりません' };
    if (run.status !== 'confirmed' && run.status !== 'paid') return { error: '賞与支払届は確定した回から作れます' };
    const slips = await this.deps.store.listSlips(tenantId, runId);
    const rows: (string | number | null)[][] = [];
    for (const sl of slips) {
      if (!sl.meta?.stdBonusHealth && !sl.meta?.stdBonusPension) continue;
      const e = await this.deps.hrStore.getEmployee(tenantId, sl.employeeId);
      const bonus = sl.lines.find((l) => l.code === 'bonus')?.amount ?? 0;
      rows.push([e?.name ?? '', e?.kana ?? '', e?.birthDate ?? '', run.payDate, bonus, sl.meta?.stdBonusHealth ?? 0, sl.meta?.stdBonusPension ?? 0,
        e?.birthDate && run.payMonth >= reachMonthOf(e.birthDate, 70) ? '70 歳以上被用者' : '']);
    }
    await this.audit(tenantId, userId, 'hr.payroll.bonus-report', runId, { rows: rows.length });
    return { columns: ['氏名', 'ふりがな', '生年月日', '賞与の支払年月日', '賞与の額', '標準賞与額（健康保険）', '標準賞与額（厚生年金）', '備考'], rows, payDate: run.payDate };
  }

  // ---- 訂正の回（第30.10.4節） ----

  /**
   * 確定した月の給与の訂正の回を作る。今の情報で同じ月を計算し直し、確定した明細との差を人ごとの差額の明細にする。
   *
   * @param payDate 差額を払う日
   */
  async createCorrection(tenantId: string, userId: string, runId: string, payDate: string): Promise<{ run: PayRun; slips: PaySlip[] } | { error: string }> {
    const original = await this.deps.store.getRun(tenantId, runId);
    if (!original || original.kind !== 'monthly' || (original.status !== 'confirmed' && original.status !== 'paid')) return { error: '訂正できるのは確定した月の給与です' };
    if (!YMD.test(payDate)) return { error: '差額を払う日を YYYY-MM-DD で入れてください' };
    if (await this.confirmedRun(tenantId, 'correction', original.payMonth)) return { error: 'この月の訂正の回は確定しています。さらに直すときは、次の月の調整の行を使ってください' };
    const newId = randomUUID();
    const [before, c] = await Promise.all([this.deps.store.listSlips(tenantId, runId), this.compute(tenantId, original.payMonth, newId)]);
    const ids = [...new Set([...before.map((s) => s.employeeId), ...c.slips.map((s) => s.employeeId)])];
    const slips: PaySlip[] = [];
    for (const id of ids) {
      const a = before.find((s) => s.employeeId === id);
      const b = c.slips.find((s) => s.employeeId === id);
      const lines = diffLines(a?.lines ?? [], b?.lines ?? []);
      if (lines.length === 0) continue;
      const gross = (b?.gross ?? 0) - (a?.gross ?? 0);
      const deductions = (b?.deductions ?? 0) - (a?.deductions ?? 0);
      slips.push({
        id: randomUUID(), runId: newId, employeeId: id, employeeName: b?.employeeName ?? a?.employeeName ?? '', gross, deductions, net: gross - deductions, lines,
        warnings: (b?.warnings ?? []).filter((w) => !w.startsWith('法令の表が監修前')),
        // 年末調整で足し合わせるため、課税の支給額・社会保険料等・所得税の差を控える
        meta: { taxablePay: metaOf(b).taxablePay - metaOf(a).taxablePay, social: metaOf(b).social - metaOf(a).social, tax: metaOf(b).tax - metaOf(a).tax },
      });
    }
    if (slips.length === 0) return { error: '確定した明細と、今の情報で計算した額に差がありません' };
    const unverified = Object.values(c.law).some((l) => !l.reviewed);
    const checks = reviewOther({ slips, employees: new Map(c.employees.map((e) => [e.id, e])), profiles: new Map(c.profiles.map((p) => [p.employeeId, p])), unverified });
    for (const sl of slips) {
      checks.push({ level: 'check', code: 'correction', text: `差額 ${sl.net >= 0 ? '+' : '−'}${Math.abs(sl.net).toLocaleString('ja-JP')} 円${sl.net < 0 ? '（次の月の給与で差し引きます）' : ''}`, employeeId: sl.employeeId, employeeName: sl.employeeName ?? '' });
    }
    const run: PayRun = {
      id: newId, kind: 'correction', payMonth: original.payMonth, payDate, periodStart: original.periodStart, periodEnd: original.periodEnd, status: 'draft', law: c.law,
      warnings: unverified ? ['法令の表が監修前です'] : [], calculatedAt: new Date().toISOString(), checks, sourceRunId: original.id,
    };
    await this.deps.store.replaceDraft(tenantId, { ...run, calculatedBy: userId }, slips);
    await this.audit(tenantId, userId, 'hr.payroll.correction', runId, { payMonth: original.payMonth, employees: slips.length });
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

  /** 1 人に知らせる（本人がその種類の知らせを切っていれば送らない）。 */
  private async notify(tenantId: string, userId: string, kind: NotificationKind, title: string, body: string): Promise<number> {
    const prefs = await this.deps.repo.getUserSettings(tenantId, userId);
    const kinds = prefs.notifications.kinds as Record<string, boolean>;
    if (kinds[kind] === false) return 0;
    await this.deps.repo.createNotification({ id: randomUUID(), tenantId, userId, kind, title, body, runId: null, readAt: null, createdAt: new Date().toISOString() });
    return 1;
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = {
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: ['hr.payroll.profile', 'hr.payroll.standard', 'hr.payroll.family', 'hr.payroll.consent'].includes(action) ? 'hr_employee' : 'hr',
      targetId, detail, occurredAt: new Date().toISOString(),
    };
    await this.deps.repo.appendAudit(ev);
  }
}

/** 明細から、社会保険料等を引いた後の額（控えが無い古い明細は、所得税の行の根拠から読む）。 */
function prevTaxableOf(slip: PaySlip): number | null {
  if (typeof slip.meta?.taxable === 'number') return slip.meta.taxable;
  const v = slip.lines.find((l) => l.code === 'income-tax')?.basis['社会保険料等を引いた後の額'];
  const n = typeof v === 'string' ? Number(v.replace(/[^\d]/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 年齢に達した月（payroll.ts の reachMonth と同じ。賞与支払届の備考に使う）。 */
function reachMonthOf(birthDate: string, age: number): string {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y + age, m - 1, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 7);
}

/** 訂正前と訂正後の行の差（行ごと。差の無い行は入れない）。 */
function diffLines(before: PayLine[], after: PayLine[]): PayLine[] {
  const codes = [...new Set([...before.map((l) => l.code), ...after.map((l) => l.code)])];
  const out: PayLine[] = [];
  const yen = (n: number) => `${n.toLocaleString('ja-JP')} 円`;
  for (const code of codes) {
    const a = before.find((l) => l.code === code);
    const b = after.find((l) => l.code === code);
    const d = (b?.amount ?? 0) - (a?.amount ?? 0);
    if (d === 0) continue;
    const kind = (b ?? a)!.kind;
    out.push({ code, label: `${(b ?? a)!.label}（差額）`, amount: d, kind, basis: { 訂正前: yen(a?.amount ?? 0), 訂正後: yen(b?.amount ?? 0) } });
  }
  return out;
}

/**
 * 明細の課税の支給額・社会保険料等・所得税（年末調整で足し合わせる）。控えの無い古い明細は行から求める。
 */
export function metaOf(slip: PaySlip | undefined): { taxablePay: number; social: number; tax: number } {
  if (!slip) return { taxablePay: 0, social: 0, tax: 0 };
  const sum = (codes: string[]) => slip.lines.filter((l) => codes.includes(l.code)).reduce((s, l) => s + l.amount, 0);
  const social = slip.meta?.social ?? sum(['health', 'child', 'pension', 'employment']);
  const tax = slip.meta?.tax ?? sum(['income-tax']);
  const taxablePay = slip.meta?.taxablePay ?? (slip.meta?.taxable !== undefined ? slip.meta.taxable + social : (prevTaxableOf(slip) ?? 0) + social);
  return { taxablePay, social, tax };
}
