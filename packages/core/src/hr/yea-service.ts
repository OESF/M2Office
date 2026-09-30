/**
 * @file 年末調整の処理（仕様書 第30.15.1節）。申告の収集・証明書の読み取り・不備の指摘・計算・年末調整の回・源泉徴収票と提出用の下書き。
 *
 * 額は yea-calc.ts（決まったプログラム）で出す。精算は種類「年末調整」の回で行い、確定は給与の処理（管理者が押す）に任せる。
 * 還付は年末調整の回の振込データで払い、不足は確定のときに翌月の調整の行で差し引く（payroll-service.ts）。人事区画の確かめは呼ぶ側が行う。
 */

import { randomUUID } from 'node:crypto';
import {
  HR_COMPARTMENT,
  type AuditEvent, type HrEmployee, type HrFamilyMember, type PayCheck, type PayRun, type PaySlip, type YeaDeclaration, type YeaDeclarationView, type YeaResult,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import type { HrStore } from './store.js';
import type { PayrollStore } from './payroll-store.js';
import type { YeaStore } from './yea-store.js';
import { Law } from './law/lookup.js';
import type { LawBook } from './law/types.js';
import { metaOf } from './payroll-service.js';
import { calcYea, declarationProblems } from './yea-calc.js';
import { readCertificate, type CertificateReading } from './yea-certificate.js';
import { renderWithholdingPdf } from './withholding-pdf.js';

/** 年末調整の処理に要るもの。 */
export interface YearEndServiceDeps {
  store: YeaStore;
  payrollStore: PayrollStore;
  hrStore: HrStore;
  repo: Repository;
  law: LawBook;
  llm?: (tenantId: string) => Promise<LlmProvider>;
  /** 監修前の表でも確定できるか（デバッグモードだけ。ADR-0053）。 */
  allowUnverified?: boolean;
}

/** 年の給与の集計（この会社の分）。 */
export interface YearTotals {
  pay: number;
  social: number;
  tax: number;
  /** 12 月に支払った月の給与が確定しているか。 */
  decemberConfirmed: boolean;
}

/** 一覧の 1 人。 */
export interface YeaOverviewRow {
  employeeId: string;
  name: string;
  target: boolean;
  reason: string | null;
  submittedAt: string | null;
  checkedAt: string | null;
  problems: string[];
}

const intOf = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
const DISABILITY = ['none', 'general', 'special', 'special-cohabiting'] as const;

/**
 * 年末調整。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。マイナンバーは扱わない（第30.26.2節）
 */
export class YearEndService {
  readonly law: Law;

  constructor(readonly deps: YearEndServiceDeps) {
    this.law = new Law(deps.law);
  }

  /** 台帳の家族から作る、申告の既定。 */
  private defaultDeclaration(year: number, family: HrFamilyMember[]): YeaDeclaration {
    const isSpouse = (f: HrFamilyMember) => /配偶者|妻|夫/.test(f.relation);
    const toPerson = (f: HrFamilyMember) => ({ name: f.name, relation: f.relation, birthDate: f.birthDate, incomeEstimate: f.incomeEstimate ?? 0, disability: 'none' as const, cohabiting: f.cohabiting });
    const spouse = family.find(isSpouse);
    return {
      year,
      self: { otherIncome: 0, disability: 'none', widow: 'none', workingStudent: false },
      spouse: spouse ? toPerson(spouse) : null,
      dependents: family.filter((f) => !isSpouse(f) && f.dependent).map(toPerson),
      insurance: { lifeNewGeneral: 0, lifeOldGeneral: 0, lifeNewCare: 0, lifeNewPension: 0, lifeOldPension: 0, earthquake: 0, oldLongTerm: 0, social: 0, smallBusiness: 0 },
      housingCredit: 0,
      previousJob: null,
    };
  }

  /** 申告（無ければ台帳の家族から作った既定）。 */
  async declaration(tenantId: string, employee: HrEmployee, year: number): Promise<YeaDeclarationView> {
    const saved = await this.deps.store.get(tenantId, employee.id, year);
    if (saved) return saved;
    const family = await this.deps.payrollStore.listFamily(tenantId, employee.id);
    return { employeeId: employee.id, employeeName: employee.name, year, data: this.defaultDeclaration(year, family), submittedAt: null, checkedAt: null };
  }

  /** 入力を確かめて申告の形にする。 */
  private clean(year: number, input: Partial<YeaDeclaration>): YeaDeclaration | { error: string } {
    const person = (p: unknown) => {
      const x = (p ?? {}) as Record<string, unknown>;
      const birth = x['birthDate'] ? String(x['birthDate']) : null;
      return {
        name: String(x['name'] ?? '').trim().slice(0, 60), relation: String(x['relation'] ?? '').trim().slice(0, 20),
        birthDate: birth && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : null, incomeEstimate: intOf(x['incomeEstimate']),
        disability: DISABILITY.includes(x['disability'] as never) ? x['disability'] as (typeof DISABILITY)[number] : 'none', cohabiting: x['cohabiting'] !== false,
      };
    };
    const s = (input.self ?? {}) as Partial<YeaDeclaration['self']>;
    const ins = (input.insurance ?? {}) as Partial<YeaDeclaration['insurance']>;
    const dependents = Array.isArray(input.dependents) ? input.dependents.slice(0, 20).map(person) : [];
    if (dependents.some((p) => !p.name)) return { error: '扶養する親族の氏名を入れてください' };
    const spouse = input.spouse ? person(input.spouse) : null;
    if (spouse && !spouse.name) return { error: '配偶者の氏名を入れてください' };
    const pj = input.previousJob as Partial<NonNullable<YeaDeclaration['previousJob']>> | null | undefined;
    return {
      year,
      self: {
        otherIncome: intOf(s.otherIncome), disability: s.disability === 'general' || s.disability === 'special' ? s.disability : 'none',
        widow: s.widow === 'widow' || s.widow === 'single-parent' ? s.widow : 'none', workingStudent: !!s.workingStudent,
      },
      spouse, dependents,
      insurance: {
        lifeNewGeneral: intOf(ins.lifeNewGeneral), lifeOldGeneral: intOf(ins.lifeOldGeneral), lifeNewCare: intOf(ins.lifeNewCare), lifeNewPension: intOf(ins.lifeNewPension),
        lifeOldPension: intOf(ins.lifeOldPension), earthquake: intOf(ins.earthquake), oldLongTerm: intOf(ins.oldLongTerm), social: intOf(ins.social), smallBusiness: intOf(ins.smallBusiness),
      },
      housingCredit: intOf(input.housingCredit),
      previousJob: pj ? { pay: intOf(pj.pay), social: intOf(pj.social), tax: intOf(pj.tax) } : null,
    };
  }

  /**
   * 申告を残す。本人は、担当者が確かめた後は直せない。担当者が直すと、確かめた印は外れる。
   */
  async save(tenantId: string, userId: string, employee: HrEmployee, year: number, input: Partial<YeaDeclaration>, opts: { submit: boolean; byStaff: boolean }): Promise<{ declaration: YeaDeclarationView } | { error: string }> {
    const cur = await this.deps.store.get(tenantId, employee.id, year);
    if (!opts.byStaff && cur?.checkedAt) return { error: '担当者が確かめたため、直せません。直すときは担当者に伝えてください' };
    if (await this.confirmedRun(tenantId, year)) return { error: `${year} 年の年末調整は確定しています` };
    const data = this.clean(year, input);
    if ('error' in data) return data;
    await this.deps.store.save(tenantId, employee.id, year, data, userId, opts.submit || opts.byStaff);
    await this.audit(tenantId, userId, 'hr.yea.declare', employee.id, { year, submit: opts.submit, byStaff: opts.byStaff });
    return { declaration: (await this.deps.store.get(tenantId, employee.id, year))! };
  }

  /** 担当者が確かめた（外すこともできる）。 */
  async check(tenantId: string, userId: string, employeeId: string, year: number, checked: boolean): Promise<boolean> {
    const ok = await this.deps.store.setChecked(tenantId, employeeId, year, checked ? userId : null);
    if (ok) await this.audit(tenantId, userId, 'hr.yea.check', employeeId, { year, checked });
    return ok;
  }

  /** 控除証明書か前の勤め先の源泉徴収票を読む（申告には入れない。本人が確かめて入れる）。 */
  async readCertificate(tenantId: string, bytes: Uint8Array, mimeType: string): Promise<CertificateReading> {
    if (!this.deps.llm) return { status: 'unreadable', reason: 'AI が使えないため、書類を読めません。額を手で入れてください' };
    return readCertificate(await this.deps.llm(tenantId), bytes, mimeType);
  }

  /** その年に支払った確定した給与・賞与・訂正の回の集計（この会社の分）。 */
  async totals(tenantId: string, year: number): Promise<{ byEmployee: Map<string, YearTotals>; decemberConfirmed: boolean }> {
    const slips = (await this.deps.payrollStore.listYearSlips(tenantId, year)).filter((s) => s.run.kind === 'monthly' || s.run.kind === 'bonus' || s.run.kind === 'correction');
    const decemberConfirmed = (await this.deps.payrollStore.listRuns(tenantId)).some((r) => r.kind === 'monthly' && r.payMonth === `${year}-12` && (r.status === 'confirmed' || r.status === 'paid'));
    const byEmployee = new Map<string, YearTotals>();
    for (const s of slips) {
      const t = byEmployee.get(s.employeeId) ?? { pay: 0, social: 0, tax: 0, decemberConfirmed };
      const m = metaOf(s);
      t.pay += m.taxablePay;
      t.social += m.social;
      t.tax += m.tax;
      byEmployee.set(s.employeeId, t);
    }
    return { byEmployee, decemberConfirmed };
  }

  /** 年末調整の対象か（対象でなければ理由）。 */
  private async targetOf(tenantId: string, e: HrEmployee, year: number, pay: number): Promise<{ target: boolean; reason: string | null }> {
    if (e.category === 'owner') return { target: false, reason: '事業主本人は対象外です' };
    if (e.leftOn && e.leftOn < `${year}-12-31`) return { target: false, reason: '年の途中で退職したため対象外です（源泉徴収票だけを出します）' };
    if (!e.hiredOn || e.hiredOn > `${year}-12-31`) return { target: false, reason: 'その年に在籍していません' };
    const profile = await this.deps.payrollStore.getProfile(tenantId, e.id);
    if (profile?.taxColumn === 'otsu') return { target: false, reason: '乙欄（扶養控除等申告書を出していない）のため対象外です' };
    const limit = this.law.yeaRules(year)?.payLimit ?? 20_000_000;
    if (pay > limit) return { target: false, reason: `その年の給与が ${limit.toLocaleString('ja-JP')} 円を超えるため対象外です（本人が確定申告をします）` };
    return { target: true, reason: null };
  }

  /** 担当者の一覧（対象・申告の状態・不備）。 */
  async overview(tenantId: string, userId: string, year: number): Promise<{ rows: YeaOverviewRow[]; runs: PayRun[]; decemberConfirmed: boolean }> {
    const [employees, decls, totals, runs] = await Promise.all([
      this.deps.hrStore.listEmployees(tenantId), this.deps.store.list(tenantId, year), this.totals(tenantId, year), this.deps.payrollStore.listRuns(tenantId),
    ]);
    const rows: YeaOverviewRow[] = [];
    for (const e of employees) {
      if (e.hiredOn && e.hiredOn > `${year}-12-31`) continue;
      if (e.leftOn && e.leftOn < `${year}-01-01`) continue;
      const t = totals.byEmployee.get(e.id);
      const { target, reason } = await this.targetOf(tenantId, e, year, t?.pay ?? 0);
      const d = decls.find((x) => x.employeeId === e.id);
      const data = d?.data ?? this.defaultDeclaration(year, await this.deps.payrollStore.listFamily(tenantId, e.id));
      rows.push({
        employeeId: e.id, name: e.name, target, reason, submittedAt: d?.submittedAt ?? null, checkedAt: d?.checkedAt ?? null,
        problems: target ? declarationProblems(this.law, year, e, data, t?.pay ?? 0) : [],
      });
    }
    await this.audit(tenantId, userId, 'hr.yea.view', String(year), { rows: rows.length });
    return { rows, runs: runs.filter((r) => r.kind === 'yea' && r.payMonth.startsWith(`${year}-`)), decemberConfirmed: totals.decemberConfirmed };
  }

  /** 対象の人に申告を頼む（本人に知らせる）。 */
  async request(tenantId: string, userId: string, year: number): Promise<{ sent: number }> {
    const { rows } = await this.overview(tenantId, userId, year);
    let sent = 0;
    for (const r of rows.filter((x) => x.target && !x.submittedAt)) {
      const e = await this.deps.hrStore.getEmployee(tenantId, r.employeeId);
      if (!e?.userId) continue;
      const prefs = await this.deps.repo.getUserSettings(tenantId, e.userId);
      if (!prefs.notifications.kinds.attendance) continue;
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId, userId: e.userId, kind: 'attendance', title: `${year} 年の年末調整の申告をお願いします`,
        body: '「給与・勤怠」の画面の「年末調整」から、家族・保険料などを申告してください。控除証明書は写真を撮ると読み取ります', runId: null, readAt: null, createdAt: new Date().toISOString(),
      });
      sent++;
    }
    await this.audit(tenantId, userId, 'hr.yea.request', String(year), { sent });
    return { sent };
  }

  /** その年の確定した年末調整の回。 */
  private async confirmedRun(tenantId: string, year: number): Promise<PayRun | undefined> {
    return (await this.deps.payrollStore.listRuns(tenantId)).find((r) => r.kind === 'yea' && r.payMonth === `${year}-12` && (r.status === 'confirmed' || r.status === 'paid'));
  }

  /**
   * 年末調整を計算して、年末調整の回（下書き）にする。12 月の給与が確定していなければ、止めるものとして示す。
   *
   * @param payDate 還付を払う日
   */
  async calculate(tenantId: string, userId: string, year: number, payDate: string): Promise<{ run: PayRun; slips: PaySlip[] } | { error: string }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) return { error: '還付を払う日を YYYY-MM-DD で入れてください' };
    if (await this.confirmedRun(tenantId, year)) return { error: `${year} 年の年末調整は確定しています` };
    const rules = this.law.yeaRules(year);
    if (!rules) return { error: `${year} 年分の年末調整の表が未登録です` };
    // 令和8年分は改正の後の決まり（12 月 1 日以後に行う年末調整）だけを持つ。それより前の年末調整は扱わない
    if (payDate < rules.appliesFrom) return { error: `${year} 年分の年末調整は ${rules.appliesFrom} 以後に払う日で計算します（それより前の年末調整はまだ扱えません）` };
    const [employees, decls, totals] = await Promise.all([this.deps.hrStore.listEmployees(tenantId), this.deps.store.list(tenantId, year), this.totals(tenantId, year)]);
    const runId = randomUUID();
    const slips: PaySlip[] = [];
    const checks: PayCheck[] = [];
    if (!totals.decemberConfirmed) checks.push({ level: 'stop', code: 'december', text: `${year} 年 12 月に支払う給与が確定していません。12 月の給与（と賞与）を確定してから計算し直してください` });
    if (rules.review.status !== 'verified') checks.push({ level: 'stop', code: 'unverified', text: '年末調整の法令の表が監修前です。監修が済むまで確定できません' });
    for (const e of employees) {
      const t = totals.byEmployee.get(e.id);
      if (!t) continue;
      const { target } = await this.targetOf(tenantId, e, year, t.pay);
      if (!target) continue;
      const d = decls.find((x) => x.employeeId === e.id);
      const who = { employeeId: e.id, employeeName: e.name };
      if (!d?.checkedAt) checks.push({ level: 'stop', code: 'not-checked', text: d?.submittedAt ? '申告を担当者がまだ確かめていません' : '申告が出ていません', ...who });
      const data = d?.data ?? this.defaultDeclaration(year, await this.deps.payrollStore.listFamily(tenantId, e.id));
      for (const p of declarationProblems(this.law, year, e, data, t.pay)) checks.push({ level: 'check', code: 'declaration', text: p, ...who });
      const r = calcYea({ law: this.law, year, employee: e, declaration: data, payHere: t.pay, socialHere: t.social, withheldHere: t.tax });
      if ('error' in r) { checks.push({ level: 'stop', code: 'missing-table', text: r.error, ...who }); continue; }
      const diff = r.result.difference;
      if (diff === 0) checks.push({ level: 'check', code: 'zero', text: '過不足はありません', ...who });
      slips.push({
        id: randomUUID(), runId, employeeId: e.id, employeeName: e.name, gross: Math.max(0, diff), deductions: Math.max(0, -diff), net: diff,
        lines: [{ code: 'yea', label: diff >= 0 ? '年末調整の還付' : '年末調整の不足', amount: Math.abs(diff), kind: diff >= 0 ? 'pay' : 'deduct', basis: Object.fromEntries(r.result.basis) }],
        warnings: r.warnings, meta: { yea: r.result },
      });
    }
    const law: PayRun['law'] = { [rules.version]: { version: rules.version, source: rules.source, reviewed: rules.review.status === 'verified' } };
    const run: PayRun = {
      id: runId, kind: 'yea', payMonth: `${year}-12`, payDate, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, status: 'draft', law,
      warnings: rules.review.status !== 'verified' && this.deps.allowUnverified ? ['年末調整の法令の表が監修前です。開発の環境のため確定できますが、本番では確定できません'] : [],
      calculatedAt: new Date().toISOString(), checks,
    };
    await this.deps.payrollStore.replaceDraft(tenantId, { ...run, calculatedBy: userId }, slips);
    await this.audit(tenantId, userId, 'hr.yea.calculate', String(year), { employees: slips.length, stops: checks.filter((c) => c.level === 'stop').length });
    return { run, slips };
  }

  /** 源泉徴収票の中身（年末調整をした人は結果から、しなかった人は年の集計から）。 */
  async withholding(tenantId: string, employee: HrEmployee, year: number): Promise<{ result: YeaResult | null; totals: YearTotals | null; adjusted: boolean }> {
    const run = await this.confirmedRun(tenantId, year);
    if (run) {
      const slip = (await this.deps.payrollStore.listSlips(tenantId, run.id)).find((s) => s.employeeId === employee.id);
      if (slip?.meta?.yea) return { result: slip.meta.yea, totals: null, adjusted: true };
    }
    const totals = (await this.totals(tenantId, year)).byEmployee.get(employee.id) ?? null;
    return { result: null, totals, adjusted: false };
  }

  /**
   * 源泉徴収票（本人交付用）の PDF。
   *
   * @param audit 監査ログに残すか（帳簿をまとめて書き出すときは `false`）
   */
  async withholdingPdf(tenantId: string, userId: string, employee: HrEmployee, year: number, audit = true): Promise<Uint8Array | null> {
    const w = await this.withholding(tenantId, employee, year);
    if (!w.result && !w.totals) return null;
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const tenant = await this.deps.repo.findTenantById(tenantId);
    const bytes = await renderWithholdingPdf({ year, employee, result: w.result, totals: w.totals, payer: { name: settings.office.name || tenant?.name || '', address: settings.office.address } });
    if (audit) await this.audit(tenantId, userId, 'hr.yea.withholding', employee.id, { year, adjusted: w.adjusted });
    return bytes;
  }

  /**
   * 税務署提出用の源泉徴収票・給与支払報告書・法定調書合計表の集計の下書き（表計算）。マイナンバーの欄は空ける。
   *
   * @param audit 監査ログに残すか（帳簿をまとめて書き出すときは `false`）
   */
  async report(tenantId: string, userId: string, year: number, audit = true): Promise<{ columns: string[]; rows: (string | number | null)[][] }> {
    const employees = await this.deps.hrStore.listEmployees(tenantId);
    const columns = ['氏名', 'ふりがな', '住所', '生年月日', '個人番号', '年末調整', '支払金額', '給与所得控除後の金額', '所得控除の額の合計額', '源泉徴収税額',
      '社会保険料等の金額', '生命保険料の控除額', '地震保険料の控除額', '住宅借入金等特別控除の額', '配偶者（特別）控除の額', '控除対象扶養親族の数（特定・老人・その他）', '16 歳未満の扶養親族の数', '退職年月日'];
    const rows: (string | number | null)[][] = [];
    for (const e of employees) {
      const w = await this.withholding(tenantId, e, year);
      if (!w.result && !w.totals) continue;
      const r = w.result;
      rows.push([e.name, e.kana, e.address, e.birthDate, '', w.adjusted ? '済' : '未', r ? r.pay : w.totals!.pay, r ? r.afterDeduction : null, r ? r.deductionTotal : null,
        r ? r.annualTax : w.totals!.tax, r ? r.deductions.social + r.deductions.smallBusiness : w.totals!.social, r ? r.deductions.life : null, r ? r.deductions.earthquake : null,
        r ? r.housingCredit : null, r ? r.deductions.spouse + r.deductions.spouseSpecial : null, r ? `${r.counts.specific}・${r.counts.elderly}・${r.counts.general}` : null,
        r ? r.counts.under16 : null, e.leftOn && e.leftOn.startsWith(String(year)) ? e.leftOn : '']);
    }
    // 法定調書合計表の「給与所得の源泉徴収票」の欄に写す集計（人員・支払金額・源泉徴収税額）
    const sum = (i: number) => rows.reduce((a, row) => a + (typeof row[i] === 'number' ? row[i] as number : 0), 0);
    if (rows.length > 0) rows.push([`合計（${rows.length} 人）`, '', '', '', '', '', sum(6), null, null, sum(9), sum(10), null, null, null, null, null, null, '']);
    if (audit) await this.audit(tenantId, userId, 'hr.yea.report', String(year), { rows: rows.length });
    return { columns, rows };
  }

  /** 本人に結び付いた、確定した年末調整の結果（明細を画面で受け取る同意のある人だけ）。 */
  async selfResult(tenantId: string, employee: HrEmployee, year: number): Promise<YeaResult | null> {
    const consent = (await this.deps.payrollStore.getProfile(tenantId, employee.id))?.payslipConsentAt;
    if (!consent) return null;
    return (await this.withholding(tenantId, employee, year)).result;
  }

  /** 本人の画面（申告・対象か・直せるか・不備・結果）。 */
  async selfView(tenantId: string, employee: HrEmployee, year: number): Promise<{ declaration: YeaDeclarationView; target: boolean; reason: string | null; canEdit: boolean; result: YeaResult | null; problems: string[] }> {
    const [declaration, totals] = await Promise.all([this.declaration(tenantId, employee, year), this.totals(tenantId, year)]);
    const pay = totals.byEmployee.get(employee.id)?.pay ?? 0;
    const { target, reason } = await this.targetOf(tenantId, employee, year, pay);
    const confirmed = !!(await this.confirmedRun(tenantId, year));
    return {
      declaration, target, reason, canEdit: target && !declaration.checkedAt && !confirmed, result: await this.selfResult(tenantId, employee, year),
      problems: target ? declarationProblems(this.law, year, employee, declaration.data, pay) : [],
    };
  }

  /** 人事区画の人に知らせる（本人が申告を出したとき）。 */
  async notifyStaff(tenantId: string, exceptUserId: string, title: string, body: string): Promise<void> {
    for (const u of await this.deps.repo.listUsers(tenantId)) {
      if (u.status !== 'active' || u.id === exceptUserId) continue;
      if (!(await this.deps.repo.listUserCompartments(tenantId, u.id)).includes(HR_COMPARTMENT)) continue;
      const prefs = await this.deps.repo.getUserSettings(tenantId, u.id);
      if (!prefs.notifications.kinds.attendance) continue;
      await this.deps.repo.createNotification({ id: randomUUID(), tenantId, userId: u.id, kind: 'attendance', title, body, runId: null, readAt: null, createdAt: new Date().toISOString() });
    }
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'hr', targetId, detail, occurredAt: new Date().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }
}
