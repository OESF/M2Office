/**
 * @file 給与の情報・標準報酬月額・家族・給与の回と明細の置き場（仕様書 第30.24節。人事・給与の段 3）。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。
 * 月の給与の下書きは、計算し直すたびに同じ支給月の下書きを丸ごと置き換える。
 * 確定した回と明細は書き換えない（H-6。データベースの段でも、アプリの利用者からの書き換えと削除を拒む。移行 044）。
 */

import pg from 'pg';
import type { BonusPlan, HrFamilyMember, HrPayrollProfile, HrStandardPay, PayAdjustment, PayRun, PaySlip } from '@m2office/shared';

/** 明細と、その回の要点（本人の画面・賃金台帳に使う）。 */
export interface SlipWithRun extends PaySlip {
  run: Pick<PayRun, 'id' | 'kind' | 'payMonth' | 'payDate' | 'periodStart' | 'periodEnd' | 'status' | 'confirmedAt'>;
  employeeCode?: string;
  employeeGender?: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/**
 * 明細の行の根拠を、並びを保ったまま残す（jsonb は物の鍵を並べ替えるため、[鍵, 値] の並びで持つ）。
 * 前に物のまま残した行も読める。
 */
const packLines = (lines: PaySlip['lines']) => JSON.stringify(lines.map((l) => ({ ...l, basis: Object.entries(l.basis) })));
const unpackLines = (lines: unknown): PaySlip['lines'] => (Array.isArray(lines) ? lines : []).map((l: PaySlip['lines'][number] & { basis: unknown }) => ({
  ...l, basis: Array.isArray(l.basis) ? Object.fromEntries(l.basis as [string, string | number][]) : (l.basis ?? {}) as PaySlip['lines'][number]['basis'],
}));
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
  /** 下書きを確定する（下書きのときだけ。確定した回を返す）。 */
  confirmRun(tenantId: string, id: string, by: string, unverified: boolean): Promise<PayRun | null>;
  /** 管理者に確定を頼んだ日時を残す。 */
  markConfirmRequested(tenantId: string, id: string): Promise<void>;
  /** 振込データを作ったことを残す。 */
  markTransfer(tenantId: string, id: string, by: string): Promise<void>;
  /** 支給月より前の、最も新しい確定した回の明細。 */
  previousConfirmed(tenantId: string, kind: PayRun['kind'], payMonth: string): Promise<PaySlip[]>;
  /** 1 人の確定した明細（新しい順）。 */
  listConfirmedSlips(tenantId: string, employeeId: string, limit?: number): Promise<SlipWithRun[]>;
  /** 明細 1 つと回。 */
  getSlip(tenantId: string, slipId: string): Promise<SlipWithRun | null>;
  /** 年の確定した月の給与の明細（賃金台帳）。 */
  listYearSlips(tenantId: string, year: number): Promise<SlipWithRun[]>;
  /** `fromMonth` 以上 `toMonth` 以下に支払った、確定した月の給与と訂正の回の明細（社会保険の報酬。第30.12.1節）。 */
  listPaidSlips(tenantId: string, fromMonth: string, toMonth: string): Promise<SlipWithRun[]>;
  /** 労働保険の年度（`from`〜`to` の日）の、確定した月の給与と訂正の回（締めの日で）と賞与（支払った日で）の明細（第30.13.1節）。 */
  listLaborSlips(tenantId: string, from: string, to: string): Promise<SlipWithRun[]>;
  /** 明細を画面で受け取る同意（`null` で取り消し）。 */
  setConsent(tenantId: string, employeeId: string, at: string | null): Promise<void>;
  /** 回ごと・人ごとの調整の行。 */
  listAdjustments(tenantId: string, kind: PayAdjustment['kind'], payMonth: string): Promise<PayAdjustment[]>;
  addAdjustment(tenantId: string, a: PayAdjustment & { createdBy: string; sourceRunId?: string | null }): Promise<void>;
  removeAdjustment(tenantId: string, id: string): Promise<PayAdjustment | null>;
  /** 賞与の回の入力。 */
  getBonusPlan(tenantId: string, payMonth: string): Promise<BonusPlan | null>;
  saveBonusPlan(tenantId: string, plan: BonusPlan, by: string): Promise<void>;
  /** その月（YYYY-MM）に支払った、確定した回の明細。 */
  slipsPaidIn(tenantId: string, month: string, kind: PayRun['kind']): Promise<PaySlip[]>;
  /** `fromMonth` 以上 `toMonth` 未満に支払った、確定した賞与の健康保険の標準賞与額の累計（従業員ごと）。 */
  bonusHealthSoFar(tenantId: string, fromMonth: string, toMonth: string): Promise<Map<string, number>>;
  /** 確定した月の給与を、支払った月ごとに集計する（労務カレンダーの納付に使う）。 */
  monthlyTotals(tenantId: string, fromMonth: string): Promise<{ month: string; people: number; gross: number; tax: number; resident: number }[]>;
}

interface ProfileRow { employee_id: string; tax_column: 'ko' | 'otsu'; dependents: number; resident_tax: HrPayrollProfile['residentTax']; commute: HrPayrollProfile['commute']; bank: HrPayrollProfile['bank']; payslip_consent_at: unknown; insurance: HrPayrollProfile['insurance'] | null }
const toProfile = (r: ProfileRow): HrPayrollProfile => ({
  employeeId: r.employee_id, taxColumn: r.tax_column, dependents: r.dependents,
  residentTax: Array.isArray(r.resident_tax) ? r.resident_tax : [], commute: r.commute ?? {}, bank: r.bank ?? {},
  payslipConsentAt: r.payslip_consent_at ? iso(r.payslip_consent_at) : null, insurance: r.insurance ?? {},
});
const PROFILE_COLS = 'employee_id, tax_column, dependents, resident_tax, commute, bank, payslip_consent_at, insurance';

interface RunRow {
  id: string; kind: PayRun['kind']; pay_month: string; pay_date: unknown; period_start: unknown; period_end: unknown; status: PayRun['status']; law: PayRun['law']; warnings: string[]; calculated_at: unknown;
  checks: PayRun['checks']; compare: PayRun['compare']; confirmed_by: string | null; confirmed_at: unknown; confirmed_unverified: boolean; confirm_requested_at: unknown; transfer_at: unknown;
  source_run_id: string | null;
}
const opt = (v: unknown) => (v ? iso(v) : null);
const toRun = (r: RunRow): PayRun => ({
  id: r.id, kind: r.kind, payMonth: r.pay_month, payDate: day(r.pay_date), periodStart: day(r.period_start), periodEnd: day(r.period_end),
  status: r.status, law: r.law ?? {}, warnings: r.warnings ?? [], calculatedAt: iso(r.calculated_at), checks: r.checks ?? [], compare: r.compare ?? null,
  confirmedBy: r.confirmed_by, confirmedAt: opt(r.confirmed_at), confirmedUnverified: r.confirmed_unverified, confirmRequestedAt: opt(r.confirm_requested_at), transferAt: opt(r.transfer_at),
  sourceRunId: r.source_run_id,
});
const RUN_COLS = `id, kind, pay_month, pay_date::text, period_start::text, period_end::text, status, law, warnings, calculated_at,
  checks, compare, confirmed_by, confirmed_at, confirmed_unverified, confirm_requested_at, transfer_at, source_run_id`;

interface SlipRow {
  id: string; run_id: string; employee_id: string; employee_name: string; gross: number; deductions: number; net: number; lines: PaySlip['lines']; warnings: string[]; attendance: PaySlip['attendance']; meta?: PaySlip['meta'];
  kind?: PayRun['kind']; pay_month?: string; pay_date?: unknown; period_start?: unknown; period_end?: unknown; status?: PayRun['status']; confirmed_at?: unknown; code?: string; gender?: string;
}
const toSlip = (r: SlipRow): PaySlip => ({
  id: r.id, runId: r.run_id, employeeId: r.employee_id, employeeName: r.employee_name, gross: r.gross, deductions: r.deductions, net: r.net, lines: unpackLines(r.lines), warnings: r.warnings, attendance: r.attendance ?? {},
  meta: r.meta ?? {},
});
const toSlipWithRun = (r: SlipRow): SlipWithRun => ({
  ...toSlip(r), employeeCode: r.code ?? '', employeeGender: r.gender ?? '',
  run: { id: r.run_id, kind: r.kind!, payMonth: r.pay_month!, payDate: day(r.pay_date), periodStart: day(r.period_start), periodEnd: day(r.period_end), status: r.status!, confirmedAt: opt(r.confirmed_at) },
});
const SLIP_RUN_SELECT = `select s.id, s.run_id, s.employee_id, e.name as employee_name, e.code, e.gender, s.gross, s.deductions, s.net, s.lines, s.warnings, s.attendance, s.meta,
  r.kind, r.pay_month, r.pay_date::text, r.period_start::text, r.period_end::text, r.status, r.confirmed_at
  from pay_slips s join pay_runs r on r.id = s.run_id join hr_employees e on e.id = s.employee_id`;

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
    const rows = await this.q<ProfileRow>(tenantId, `select ${PROFILE_COLS} from hr_payroll_profiles where tenant_id = $1 and employee_id = $2`, [tenantId, employeeId]);
    return rows[0] ? toProfile(rows[0]) : null;
  }

  async listProfiles(tenantId: string): Promise<HrPayrollProfile[]> {
    const rows = await this.q<ProfileRow>(tenantId, `select ${PROFILE_COLS} from hr_payroll_profiles where tenant_id = $1`, [tenantId]);
    return rows.map(toProfile);
  }

  async saveProfile(tenantId: string, p: HrPayrollProfile, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_payroll_profiles (employee_id, tenant_id, tax_column, dependents, resident_tax, commute, bank, insurance, updated_by)
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9)
      on conflict (employee_id) do update set tax_column = excluded.tax_column, dependents = excluded.dependents, resident_tax = excluded.resident_tax,
        commute = excluded.commute, bank = excluded.bank, insurance = excluded.insurance, updated_by = excluded.updated_by, updated_at = now()`,
    [p.employeeId, tenantId, p.taxColumn, p.dependents, JSON.stringify(p.residentTax), JSON.stringify(p.commute), JSON.stringify(p.bank), JSON.stringify(p.insurance ?? {}), by]);
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
      await c.query(`insert into pay_runs (id, tenant_id, kind, pay_month, pay_date, period_start, period_end, status, law, warnings, calculated_by, checks, compare, source_run_id)
        values ($1,$2,$3,$4,$5,$6,$7,'draft',$8::jsonb,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13)`,
      [run.id, tenantId, run.kind, run.payMonth, run.payDate, run.periodStart, run.periodEnd, JSON.stringify(run.law), JSON.stringify(run.warnings), run.calculatedBy,
        JSON.stringify(run.checks ?? []), run.compare ? JSON.stringify(run.compare) : null, run.sourceRunId ?? null]);
      for (const s of slips) {
        await c.query(`insert into pay_slips (id, tenant_id, run_id, employee_id, gross, deductions, net, lines, warnings, attendance, meta) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)`,
          [s.id, tenantId, run.id, s.employeeId, s.gross, s.deductions, s.net, packLines(s.lines), JSON.stringify(s.warnings), JSON.stringify(s.attendance ?? {}), JSON.stringify(s.meta ?? {})]);
      }
    });
  }

  async listRuns(tenantId: string): Promise<PayRun[]> {
    const rows = await this.q<RunRow>(tenantId, `select ${RUN_COLS} from pay_runs where tenant_id = $1 order by pay_month desc, calculated_at desc limit 60`, [tenantId]);
    return rows.map(toRun);
  }

  async getRun(tenantId: string, id: string): Promise<PayRun | null> {
    const rows = await this.q<RunRow>(tenantId, `select ${RUN_COLS} from pay_runs where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listSlips(tenantId: string, runId: string): Promise<PaySlip[]> {
    const rows = await this.q<SlipRow>(tenantId,
      `select s.id, s.run_id, s.employee_id, e.name as employee_name, s.gross, s.deductions, s.net, s.lines, s.warnings, s.attendance, s.meta
       from pay_slips s join hr_employees e on e.id = s.employee_id where s.tenant_id = $1 and s.run_id = $2 order by nullif(e.kana, ''), e.name`, [tenantId, runId]);
    return rows.map(toSlip);
  }

  async confirmRun(tenantId: string, id: string, by: string, unverified: boolean): Promise<PayRun | null> {
    const rows = await this.q<RunRow>(tenantId, `update pay_runs set status = 'confirmed', confirmed_by = $3, confirmed_at = now(), confirmed_unverified = $4
      where tenant_id = $1 and id = $2 and status = 'draft' and kind <> 'trial' returning ${RUN_COLS}`, [tenantId, id, by, unverified]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async markConfirmRequested(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `update pay_runs set confirm_requested_at = now() where tenant_id = $1 and id = $2 and status = 'draft'`, [tenantId, id]);
  }

  async markTransfer(tenantId: string, id: string, by: string): Promise<void> {
    await this.q(tenantId, `update pay_runs set transfer_by = $3, transfer_at = now() where tenant_id = $1 and id = $2 and status in ('confirmed', 'paid')`, [tenantId, id, by]);
  }

  async previousConfirmed(tenantId: string, kind: PayRun['kind'], payMonth: string): Promise<PaySlip[]> {
    const rows = await this.q<SlipRow>(tenantId,
      `select s.id, s.run_id, s.employee_id, e.name as employee_name, s.gross, s.deductions, s.net, s.lines, s.warnings, s.attendance, s.meta
       from pay_slips s join hr_employees e on e.id = s.employee_id
       where s.tenant_id = $1 and s.run_id = (select id from pay_runs where tenant_id = $1 and kind = $2 and pay_month < $3 and status in ('confirmed', 'paid') order by pay_month desc limit 1)`,
      [tenantId, kind, payMonth]);
    return rows.map(toSlip);
  }

  async listConfirmedSlips(tenantId: string, employeeId: string, limit = 24): Promise<SlipWithRun[]> {
    const rows = await this.q<SlipRow>(tenantId, `${SLIP_RUN_SELECT}
      where s.tenant_id = $1 and s.employee_id = $2 and r.status in ('confirmed', 'paid') and r.kind <> 'trial' order by r.pay_month desc, r.confirmed_at desc limit $3`, [tenantId, employeeId, limit]);
    return rows.map(toSlipWithRun);
  }

  async getSlip(tenantId: string, slipId: string): Promise<SlipWithRun | null> {
    const rows = await this.q<SlipRow>(tenantId, `${SLIP_RUN_SELECT} where s.tenant_id = $1 and s.id = $2`, [tenantId, slipId]);
    return rows[0] ? toSlipWithRun(rows[0]) : null;
  }

  async listYearSlips(tenantId: string, year: number): Promise<SlipWithRun[]> {
    const rows = await this.q<SlipRow>(tenantId, `${SLIP_RUN_SELECT}
      where s.tenant_id = $1 and r.kind <> 'trial' and r.status in ('confirmed', 'paid') and to_char(r.pay_date, 'YYYY') = $2 order by nullif(e.kana, ''), e.name, r.pay_date, r.kind`, [tenantId, String(year)]);
    return rows.map(toSlipWithRun);
  }

  async listPaidSlips(tenantId: string, fromMonth: string, toMonth: string): Promise<SlipWithRun[]> {
    const rows = await this.q<SlipRow>(tenantId, `${SLIP_RUN_SELECT}
      where s.tenant_id = $1 and r.kind in ('monthly', 'correction') and r.status in ('confirmed', 'paid')
        and to_char(r.pay_date, 'YYYY-MM') between $2 and $3 order by r.pay_date, r.kind`, [tenantId, fromMonth, toMonth]);
    return rows.map(toSlipWithRun);
  }

  async listLaborSlips(tenantId: string, from: string, to: string): Promise<SlipWithRun[]> {
    const rows = await this.q<SlipRow>(tenantId, `${SLIP_RUN_SELECT}
      where s.tenant_id = $1 and r.status in ('confirmed', 'paid')
        and ((r.kind in ('monthly', 'correction') and r.period_end between $2::date and $3::date) or (r.kind = 'bonus' and r.pay_date between $2::date and $3::date))
      order by r.pay_date, r.kind`, [tenantId, from, to]);
    return rows.map(toSlipWithRun);
  }

  async monthlyTotals(tenantId: string, fromMonth: string): Promise<{ month: string; people: number; gross: number; tax: number; resident: number }[]> {
    const rows = await this.q<{ month: string; people: string; gross: string; tax: string; resident: string }>(tenantId,
      `select to_char(r.pay_date, 'YYYY-MM') as month, count(*) as people, sum(s.gross) as gross,
         coalesce(sum((select sum((l->>'amount')::int) from jsonb_array_elements(s.lines) l where l->>'code' = 'income-tax')), 0) as tax,
         coalesce(sum((select sum((l->>'amount')::int) from jsonb_array_elements(s.lines) l where l->>'code' = 'resident-tax')), 0) as resident
       from pay_slips s join pay_runs r on r.id = s.run_id
       where s.tenant_id = $1 and r.status in ('confirmed', 'paid') and r.kind <> 'trial' and to_char(r.pay_date, 'YYYY-MM') >= $2
       group by 1 order by 1`, [tenantId, fromMonth]);
    return rows.map((r) => ({ month: r.month, people: Number(r.people), gross: Number(r.gross), tax: Number(r.tax), resident: Number(r.resident) }));
  }

  async listAdjustments(tenantId: string, kind: PayAdjustment['kind'], payMonth: string): Promise<PayAdjustment[]> {
    const rows = await this.q<{ id: string; employee_id: string; employee_name: string; kind: PayAdjustment['kind']; pay_month: string; label: string; direction: PayAdjustment['direction']; amount: number; taxable: boolean; insurable: boolean; reason: string; source: PayAdjustment['source'] }>(tenantId,
      `select a.id, a.employee_id, e.name as employee_name, a.kind, a.pay_month, a.label, a.direction, a.amount, a.taxable, a.insurable, a.reason, a.source
       from pay_adjustments a join hr_employees e on e.id = a.employee_id where a.tenant_id = $1 and a.kind = $2 and a.pay_month = $3 order by a.created_at`, [tenantId, kind, payMonth]);
    return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, kind: r.kind, payMonth: r.pay_month, label: r.label, direction: r.direction, amount: r.amount, taxable: r.taxable, insurable: r.insurable, reason: r.reason, source: r.source }));
  }

  async addAdjustment(tenantId: string, a: PayAdjustment & { createdBy: string; sourceRunId?: string | null }): Promise<void> {
    await this.q(tenantId, `insert into pay_adjustments (id, tenant_id, employee_id, kind, pay_month, label, direction, amount, taxable, insurable, reason, source, source_run_id, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [a.id, tenantId, a.employeeId, a.kind, a.payMonth, a.label, a.direction, a.amount, a.taxable, a.insurable, a.reason, a.source, a.sourceRunId ?? null, a.createdBy]);
  }

  async removeAdjustment(tenantId: string, id: string): Promise<PayAdjustment | null> {
    const rows = await this.q<{ id: string; employee_id: string; kind: PayAdjustment['kind']; pay_month: string; label: string; direction: PayAdjustment['direction']; amount: number; taxable: boolean; insurable: boolean; reason: string; source: PayAdjustment['source'] }>(tenantId,
      `delete from pay_adjustments where tenant_id = $1 and id = $2 returning id, employee_id, kind, pay_month, label, direction, amount, taxable, insurable, reason, source`, [tenantId, id]);
    const r = rows[0];
    return r ? { id: r.id, employeeId: r.employee_id, kind: r.kind, payMonth: r.pay_month, label: r.label, direction: r.direction, amount: r.amount, taxable: r.taxable, insurable: r.insurable, reason: r.reason, source: r.source } : null;
  }

  async getBonusPlan(tenantId: string, payMonth: string): Promise<BonusPlan | null> {
    const rows = await this.q<{ pay_month: string; pay_date: unknown; long_period: boolean; amounts: Record<string, number> }>(tenantId,
      `select pay_month, pay_date::text, long_period, amounts from pay_bonus_plans where tenant_id = $1 and pay_month = $2`, [tenantId, payMonth]);
    const r = rows[0];
    return r ? { payMonth: r.pay_month, payDate: day(r.pay_date), longPeriod: r.long_period, amounts: r.amounts ?? {} } : null;
  }

  async saveBonusPlan(tenantId: string, plan: BonusPlan, by: string): Promise<void> {
    await this.q(tenantId, `insert into pay_bonus_plans (tenant_id, pay_month, pay_date, long_period, amounts, updated_by) values ($1,$2,$3,$4,$5::jsonb,$6)
      on conflict (tenant_id, pay_month) do update set pay_date = excluded.pay_date, long_period = excluded.long_period, amounts = excluded.amounts, updated_by = excluded.updated_by, updated_at = now()`,
    [tenantId, plan.payMonth, plan.payDate, plan.longPeriod, JSON.stringify(plan.amounts), by]);
  }

  async slipsPaidIn(tenantId: string, month: string, kind: PayRun['kind']): Promise<PaySlip[]> {
    const rows = await this.q<SlipRow>(tenantId, `${SLIP_RUN_SELECT}
      where s.tenant_id = $1 and r.kind = $2 and r.status in ('confirmed', 'paid') and to_char(r.pay_date, 'YYYY-MM') = $3`, [tenantId, kind, month]);
    return rows.map(toSlip);
  }

  async bonusHealthSoFar(tenantId: string, fromMonth: string, toMonth: string): Promise<Map<string, number>> {
    const rows = await this.q<{ employee_id: string; total: string }>(tenantId,
      `select s.employee_id, coalesce(sum((s.meta->>'stdBonusHealth')::int), 0) as total from pay_slips s join pay_runs r on r.id = s.run_id
       where s.tenant_id = $1 and r.kind = 'bonus' and r.status in ('confirmed', 'paid') and r.pay_month >= $2 and r.pay_month < $3 group by s.employee_id`, [tenantId, fromMonth, toMonth]);
    return new Map(rows.map((r) => [r.employee_id, Number(r.total)]));
  }

  async setConsent(tenantId: string, employeeId: string, at: string | null): Promise<void> {
    await this.q(tenantId, `insert into hr_payroll_profiles (employee_id, tenant_id, payslip_consent_at) values ($1, $2, $3)
      on conflict (employee_id) do update set payslip_consent_at = excluded.payslip_consent_at, updated_at = now()`, [employeeId, tenantId, at]);
  }
}
