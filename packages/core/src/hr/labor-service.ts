/**
 * @file 労働保険の年度更新の処理（仕様書 第30.13.1節）。前年度の賃金の集計・足りない月の合計と申告済の概算保険料を残す・計算・
 * 確定保険料・一般拠出金算定基礎賃金集計表と申告書に書く額の下書き（表計算）。
 *
 * 額は labor-insurance.ts（決まったプログラム）で出す。申告と納付は会社が行う（H-7）。人事区画の確かめは呼ぶ側（API）が行う。
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent, LaborInsuranceData, LaborInsuranceView, LaborSupplement } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { HrStore } from './store.js';
import type { PayrollStore } from './payroll-store.js';
import type { LaborStore } from './labor-store.js';
import { termsOn } from './attendance-service.js';
import { Law } from './law/lookup.js';
import type { LawBook } from './law/types.js';
import { fiscalMonths, laborCalc, laborMonths, type LaborInput } from './labor-insurance.js';
import type { FilingSheet } from './social-service.js';

/** 年度更新の処理に要るもの。 */
export interface LaborServiceDeps {
  store: LaborStore;
  payrollStore: PayrollStore;
  hrStore: HrStore;
  repo: Repository;
  law: LawBook;
}

const int = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
const yen = (n: number) => n.toLocaleString('ja-JP');

/**
 * 労働保険の年度更新。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。監査ログには額を入れない
 */
export class LaborInsuranceService {
  readonly law: Law;

  constructor(readonly deps: LaborServiceDeps) {
    this.law = new Law(deps.law);
  }

  /** 担当者が入れたもの（無ければ、前の年の下書きの概算保険料を申告済の額の既定にする）。 */
  private async data(tenantId: string, year: number): Promise<{ data: LaborInsuranceData; filedAt: string | null }> {
    const rec = await this.deps.store.get(tenantId, year);
    if (rec) return { data: { supplements: rec.data.supplements ?? {}, declaredEstimate: rec.data.declaredEstimate ?? null, estimateWages: rec.data.estimateWages ?? null }, filedAt: rec.filedAt };
    const prev = await this.deps.store.get(tenantId, year - 1);
    return { data: { supplements: {}, declaredEstimate: prev?.result?.estimate.total ?? null, estimateWages: null }, filedAt: null };
  }

  private async input(tenantId: string, year: number, data: LaborInsuranceData): Promise<LaborInput> {
    const [settings, employees, slips, runs] = await Promise.all([
      this.deps.repo.getTenantSettings(tenantId).then((s) => s.hr), this.deps.hrStore.listEmployees(tenantId),
      this.deps.payrollStore.listLaborSlips(tenantId, `${year - 1}-04-01`, `${year}-03-31`), this.deps.payrollStore.listRuns(tenantId),
    ]);
    const terms = new Map(await Promise.all(employees.map(async (e) => [e.id, await this.deps.hrStore.listTerms(tenantId, e.id)] as const)));
    const months = new Set(fiscalMonths(year - 1));
    const confirmedMonths = new Set(runs.filter((r) => r.kind === 'monthly' && (r.status === 'confirmed' || r.status === 'paid') && months.has(r.periodEnd.slice(0, 7))).map((r) => r.periodEnd.slice(0, 7)));
    return {
      law: this.law, year, settings: settings.labor, employees: new Map(employees.map((e) => [e.id, e])), termsAt: (id, d) => termsOn(terms.get(id) ?? [], d),
      slips: slips.map((s) => ({ slip: s, run: { kind: s.run.kind, payDate: s.run.payDate, periodEnd: s.run.periodEnd } })), confirmedMonths, data,
    };
  }

  /**
   * 年度更新の画面（前年度の月ごとの集計・足りない月・計算の結果）。
   *
   * @param year 年度更新の年（申告する年）
   */
  async view(tenantId: string, year: number): Promise<LaborInsuranceView> {
    const { data, filedAt } = await this.data(tenantId, year);
    const input = await this.input(tenantId, year, data);
    const months = laborMonths(input);
    const calc = laborCalc(input, months);
    return {
      year, period: { from: `${year - 1}-04-01`, to: `${year}-03-31` }, estimatePeriod: { from: `${year}-04-01`, to: `${year + 1}-03-31` },
      months, missing: months.filter((m) => m.source === 'missing').map((m) => m.key), data,
      result: 'result' in calc ? calc.result : null, tables: 'result' in calc ? calc.tables : [], error: 'error' in calc ? calc.error : null,
      notes: [
        ...('result' in calc ? calc.notes : []),
        ...(months.some((m) => m.source === 'm2office') ? ['役員と同居の親族は労災保険の対象に入れていません（役員で労働者扱いの人がいれば、その賃金を足してください）'] : []),
      ],
      filedAt,
    };
  }

  /** 足りない月の合計・申告済の概算保険料・見込みの賃金を残す（送った項目だけ）。 */
  async save(tenantId: string, userId: string, year: number, input: Partial<LaborInsuranceData>): Promise<LaborInsuranceView | { error: string }> {
    const { data } = await this.data(tenantId, year);
    const next: LaborInsuranceData = { ...data, supplements: { ...data.supplements } };
    if (input.supplements !== undefined) {
      const months = new Set(fiscalMonths(year - 1));
      for (const [m, v] of Object.entries(input.supplements ?? {})) {
        if (!months.has(m)) return { error: `${m} は ${year} 年の年度更新の期間（前の年の 4 月〜3 月）にありません` };
        if (v === null) { delete next.supplements[m]; continue; }
        const s: LaborSupplement = { workers: int(v.workers), wages: int(v.wages), insured: int(v.insured), insuredWages: int(v.insuredWages) };
        if (s.insured > s.workers || s.insuredWages > s.wages) return { error: '雇用保険の人数と賃金は、労災保険の人数と賃金より多くできません' };
        next.supplements[m] = s;
      }
    }
    if (input.declaredEstimate !== undefined) next.declaredEstimate = input.declaredEstimate === null ? null : int(input.declaredEstimate);
    if (input.estimateWages !== undefined) next.estimateWages = input.estimateWages === null ? null : { wages: int(input.estimateWages.wages), insuredWages: int(input.estimateWages.insuredWages) };
    await this.deps.store.save(tenantId, year, next, userId);
    await this.audit(tenantId, userId, 'hr.labor.save', String(year), { fields: Object.keys(input) });
    return this.view(tenantId, year);
  }

  /**
   * 確定保険料・一般拠出金算定基礎賃金集計表と、申告書に書く額の下書き。結果を残す（次の年の申告済の概算保険料と、延納の納期限に使う）。
   */
  async report(tenantId: string, userId: string, year: number): Promise<FilingSheet | { error: string }> {
    const v = await this.view(tenantId, year);
    if (!v.result) return { error: v.error ?? '計算できません' };
    const sheet = await this.sheetOf(tenantId, v);
    await this.deps.store.file(tenantId, year, v.data, v.result, userId);
    await this.audit(tenantId, userId, 'hr.labor.report', String(year), { installments: v.result.installments.length });
    return sheet;
  }

  /**
   * 年度更新の表（集計表と申告書に書く額）を、結果を残さずに作る（帳簿をまとめて書き出すときに使う）。計算できない年は `null`。
   */
  async bookSheet(tenantId: string, year: number): Promise<FilingSheet | null> {
    const v = await this.view(tenantId, year);
    return v.result ? this.sheetOf(tenantId, v) : null;
  }

  private async sheetOf(tenantId: string, v: LaborInsuranceView): Promise<FilingSheet> {
    const r = v.result!;
    const year = v.year;
    const settings = (await this.deps.repo.getTenantSettings(tenantId)).hr;
    const rows: (string | number | null)[][] = [];
    for (const m of v.months) {
      rows.push([m.kind === 'bonus' ? '賞与' : '月', m.kind === 'bonus' ? m.key : `${Number(m.key.slice(0, 4))} 年 ${Number(m.key.slice(5, 7))} 月`,
        m.kind === 'bonus' ? null : m.workers, m.wages, m.kind === 'bonus' ? null : m.insured, m.insuredWages, m.source === 'manual' ? '担当者が入れた' : 'M2Office']);
    }
    const sum = (k: 'wages' | 'insuredWages' | 'workers' | 'insured') => v.months.reduce((s, m) => s + m[k], 0);
    rows.push(['合計', '', sum('workers'), sum('wages'), sum('insured'), sum('insuredWages'), '']);
    rows.push(['', '', '', '', '', '', '']);
    const put = (label: string, value: string | number | null) => rows.push(['申告書', label, null, null, null, null, value === null ? '' : String(value)]);
    put('労働保険番号', settings.labor.number);
    put('事業の種類（労災保険）', `${r.industry.code} ${r.industry.name}`);
    put('算定期間（確定）', `${v.period.from} 〜 ${v.period.to}`);
    put('④ 常時使用労働者数', r.workers);
    put('⑤ 雇用保険被保険者数', r.insured);
    put('⑧ 算定基礎額（千円）労災保険分・一般拠出金', r.confirmed.workersComp.base / 1000);
    put('⑧ 算定基礎額（千円）雇用保険分', r.confirmed.employment.base / 1000);
    put('⑨ 率（1,000 分の）労災・雇用・一般拠出金', `${r.confirmed.workersComp.rate}・${r.confirmed.employment.rate}・${r.generalContribution.rate}`);
    put('⑩ 確定保険料（労働保険料・労災・雇用）', `${yen(r.confirmed.total)}・${yen(r.confirmed.workersComp.amount)}・${yen(r.confirmed.employment.amount)}`);
    put('⑩ 一般拠出金', yen(r.generalContribution.amount));
    put('算定期間（概算）', `${v.estimatePeriod.from} 〜 ${v.estimatePeriod.to}`);
    put('⑫ 算定基礎額の見込額（千円）労災・雇用', `${r.estimate.workersComp.base / 1000}・${r.estimate.employment.base / 1000}`);
    put('⑬ 率（1,000 分の）労災・雇用', `${r.estimate.workersComp.rate}・${r.estimate.employment.rate}`);
    put('⑭ 概算保険料（労働保険料・労災・雇用）', `${yen(r.estimate.total)}・${yen(r.estimate.workersComp.amount)}・${yen(r.estimate.employment.amount)}`);
    put('⑰ 延納の申請（納付回数）', r.installments.length);
    put('⑱ 申告済概算保険料額', r.declaredEstimate === null ? '（前の年の申告書から書き入れる）' : yen(r.declaredEstimate));
    put('⑳ 差引額（充当額・還付額・不足額）', r.declaredEstimate === null ? '' : `${yen(Math.max(0, r.surplus - r.refund))}・${yen(r.refund)}・${yen(r.shortage)}`);
    for (const [i, p] of r.installments.entries()) put(`㉒ 第 ${i + 1} 期の納付額（納期限 ${p.due}）`, yen(p.amount));
    return { title: `労働保険の年度更新（下書き）${year}`, columns: ['区分', '月', '労災保険の人数', '労災保険の賃金', '雇用保険の人数', '雇用保険の賃金', '出どころ・値'], rows, applied: 0 };
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'hr', targetId, detail, occurredAt: new Date().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }
}
