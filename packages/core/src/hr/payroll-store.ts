/**
 * @file 給与の情報・標準報酬月額・家族・給与の回と明細の置き場（仕様書 第30.24節。人事・給与の段 3）。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。
 * 月の給与の下書きは、計算し直すたびに同じ支給月の下書きを丸ごと置き換える（確定した回は段 4 で書き換えを禁じる）。
 */

import pg from 'pg';
import type { HrFamilyMember, HrPayrollProfile, HrStandardPay, PayRun, PaySlip } from '@m2office/shared';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

/** 給与の置き場。 */
export interface PayrollStore {
  getProfile(tenantId: string, employeeId: string): Promise<HrPayrollProfile | null>;
  listProfiles(tenantId: string): Promise<HrPayrollProfile[]>;
  saveProfile(tenantId: string, p: HrPayrollProfile, by: string): Promise<void>;
  listStandardPay(tenantId: string, employeeId?: string): Promise<HrStandardPay[]>;
  addStandardPay(tenantId: string, s: HrStandardPay & { createdBy: string }): Promise<void>;
  listFamily(tenantId: string, employeeId: string): Promise<HrFamilyMember[]>;
  addFamily(tenantId: string, f: HrFamilyMember): Promise<void>;
  removeFamily(tenantId: string, employeeId: string, id: string): Promise<boolean>;
  /** 同じ支給月の月の給与の下書きを置き換える。 */
  replaceDraft(tenantId: string, run: PayRun & { calculatedBy: string }, slips: PaySlip[]): Promise<void>;
  listRuns(tenantId: string): Promise<PayRun[]>;
  getRun(tenantId: string, id: string): Promise<PayRun | null>;
  listSlips(tenantId: string, runId: string): Promise<PaySlip[]>;
}

interface ProfileRow { employee_id: string; tax_column: 'ko' | 'otsu'; dependents: number; resident_tax: HrPayrollProfile['residentTax']; commute: HrPayrollProfile['commute']; bank: HrPayrollProfile['bank'] }
const toProfile = (r: ProfileRow): HrPayrollProfile => ({
  employeeId: r.employee_id, taxColumn: r.tax_column, dependents: r.dependents,
  residentTax: Array.isArray(r.resident_tax) ? r.resident_tax : [], commute: r.commute ?? {}, bank: r.bank ?? {},
});

interface RunRow { id: string; kind: PayRun['kind']; pay_month: string; pay_date: unknown; period_start: unknown; period_end: unknown; status: PayRun['status']; law: PayRun['law']; warnings: string[]; calculated_at: unknown }
const toRun = (r: RunRow): PayRun => ({
  id: r.id, kind: r.kind, payMonth: r.pay_month, payDate: day(r.pay_date), periodStart: day(r.period_start), periodEnd: day(r.period_end),
  status: r.status, law: r.law ?? {}, warnings: r.warnings ?? [], calculatedAt: iso(r.calculated_at),
});

/** PostgreSQL の給与の置き場。 */
export class PostgresPayrollStore implements PayrollStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(tenantId, async (c) => (await c.query<T>(text, params as never[])).rows);
  }

  async getProfile(tenantId: string, employeeId: string): Promise<HrPayrollProfile | null> {
    const rows = await this.q<ProfileRow>(tenantId, `select employee_id, tax_column, dependents, resident_tax, commute, bank from hr_payroll_profiles where tenant_id = $1 and employee_id = $2`, [tenantId, employeeId]);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async listProfiles(tenantId: string): Promise<HrPayrollProfile[]> {
    const rows = await this.q<ProfileRow>(tenantId, `select employee_id, tax_column, dependents, resident_tax, commute, bank from hr_payroll_profiles where tenant_id = $1`, [tenantId]);
    return rows.map(toProfile);
  }

  async saveProfile(tenantId: string, p: HrPayrollProfile, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_payroll_profiles (employee_id, tenant_id, tax_column, dependents, resident_tax, commute, bank, updated_by)
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)
      on conflict (employee_id) do update set tax_column = excluded.tax_column, dependents = excluded.dependents, resident_tax = excluded.resident_tax,
        commute = excluded.commute, bank = excluded.bank, updated_by = excluded.updated_by, updated_at = now()`,
    [p.employeeId, tenantId, p.taxColumn, p.dependents, JSON.stringify(p.residentTax), JSON.stringify(p.commute), JSON.stringify(p.bank), by]);
  }

  async listStandardPay(tenantId: string, employeeId?: string): Promise<HrStandardPay[]> {
    const rows = await this.q<{ id: string; employee_id: string; from_month: string; amount: number; kind: HrStandardPay['kind'] }>(tenantId,
      `select id, employee_id, from_month, amount, kind from hr_standard_pay where tenant_id = $1 ${employeeId ? 'and employee_id = $2' : ''}
       order by employee_id, from_month desc, created_at desc`, employeeId ? [tenantId, employeeId] : [tenantId]);
    return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, fromMonth: r.from_month, amount: r.amount, kind: r.kind }));
  }

  async addStandardPay(tenantId: string, s: HrStandardPay & { createdBy: string }): Promise<void> {
    await this.q(tenantId, `insert into hr_standard_pay (id, tenant_id, employee_id, from_month, amount, kind, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
      [s.id, tenantId, s.employeeId, s.fromMonth, s.amount, s.kind, s.createdBy]);
  }

  async listFamily(tenantId: string, employeeId: string): Promise<HrFamilyMember[]> {
    const rows = await this.q<{ id: string; employee_id: string; name: string; relation: string; birth_date: unknown; cohabiting: boolean; income_estimate: number | null; dependent: boolean }>(tenantId,
      `select id, employee_id, name, relation, birth_date::text, cohabiting, income_estimate, dependent from hr_family where tenant_id = $1 and employee_id = $2 order by created_at`, [tenantId, employeeId]);
    return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, name: r.name, relation: r.relation, birthDate: r.birth_date ? day(r.birth_date) : null, cohabiting: r.cohabiting, incomeEstimate: r.income_estimate, dependent: r.dependent }));
  }

  async addFamily(tenantId: string, f: HrFamilyMember): Promise<void> {
    await this.q(tenantId, `insert into hr_family (id, tenant_id, employee_id, name, relation, birth_date, cohabiting, income_estimate, dependent) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [f.id, tenantId, f.employeeId, f.name, f.relation, f.birthDate, f.cohabiting, f.incomeEstimate, f.dependent]);
  }

  async removeFamily(tenantId: string, employeeId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from hr_family where tenant_id = $1 and employee_id = $2 and id = $3 returning id`, [tenantId, employeeId, id]);
    return rows.length > 0;
  }

  async replaceDraft(tenantId: string, run: PayRun & { calculatedBy: string }, slips: PaySlip[]): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query(`delete from pay_runs where tenant_id = $1 and kind = $2 and pay_month = $3 and status = 'draft'`, [tenantId, run.kind, run.payMonth]);
      await c.query(`insert into pay_runs (id, tenant_id, kind, pay_month, pay_date, period_start, period_end, status, law, warnings, calculated_by)
        values ($1,$2,$3,$4,$5,$6,$7,'draft',$8::jsonb,$9::jsonb,$10)`,
      [run.id, tenantId, run.kind, run.payMonth, run.payDate, run.periodStart, run.periodEnd, JSON.stringify(run.law), JSON.stringify(run.warnings), run.calculatedBy]);
      for (const s of slips) {
        await c.query(`insert into pay_slips (id, tenant_id, run_id, employee_id, gross, deductions, net, lines, warnings) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
          [s.id, tenantId, run.id, s.employeeId, s.gross, s.deductions, s.net, JSON.stringify(s.lines), JSON.stringify(s.warnings)]);
      }
    });
  }

  async listRuns(tenantId: string): Promise<PayRun[]> {
    const rows = await this.q<RunRow>(tenantId, `select id, kind, pay_month, pay_date::text, period_start::text, period_end::text, status, law, warnings, calculated_at
      from pay_runs where tenant_id = $1 order by pay_month desc, calculated_at desc limit 60`, [tenantId]);
    return rows.map(toRun);
  }

  async getRun(tenantId: string, id: string): Promise<PayRun | null> {
    const rows = await this.q<RunRow>(tenantId, `select id, kind, pay_month, pay_date::text, period_start::text, period_end::text, status, law, warnings, calculated_at
      from pay_runs where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listSlips(tenantId: string, runId: string): Promise<PaySlip[]> {
    const rows = await this.q<{ id: string; run_id: string; employee_id: string; employee_name: string; gross: number; deductions: number; net: number; lines: PaySlip['lines']; warnings: string[] }>(tenantId,
      `select s.id, s.run_id, s.employee_id, e.name as employee_name, s.gross, s.deductions, s.net, s.lines, s.warnings
       from pay_slips s join hr_employees e on e.id = s.employee_id where s.tenant_id = $1 and s.run_id = $2 order by nullif(e.kana, ''), e.name`, [tenantId, runId]);
    return rows.map((r) => ({ id: r.id, runId: r.run_id, employeeId: r.employee_id, employeeName: r.employee_name, gross: r.gross, deductions: r.deductions, net: r.net, lines: r.lines, warnings: r.warnings }));
  }
}
