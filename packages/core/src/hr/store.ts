/**
 * @file 人事の台帳の置き場（仕様書 第30.24節）。従業員・雇用条件の履歴・入退社の手続きを PostgreSQL に持つ。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行い、行の絞り込み（RLS）を効かせる（不変則 I-2）。
 * 雇用条件は足すだけで書き換えない（履歴）。台帳は消さない（法定の保存の期間。Q-134）。
 */

import pg from 'pg';
import type { HrEmployee, HrTask, HrTerms } from '@m2office/shared';

/** 従業員を保存するときの値（ID と更新の日時は置き場が持つ）。 */
export type EmployeeRecord = Omit<HrEmployee, 'updatedAt'>;
/** 雇用条件を足すときの値。 */
export type TermsRecord = Omit<HrTerms, 'createdAt'> & { createdBy: string };

/** 人事の台帳の置き場。 */
export interface HrStore {
  listEmployees(tenantId: string): Promise<HrEmployee[]>;
  getEmployee(tenantId: string, id: string): Promise<HrEmployee | null>;
  findEmployeeByCode(tenantId: string, code: string): Promise<HrEmployee | null>;
  findEmployeeByUser(tenantId: string, userId: string): Promise<HrEmployee | null>;
  insertEmployee(tenantId: string, e: EmployeeRecord, by: string): Promise<void>;
  updateEmployee(tenantId: string, e: EmployeeRecord, by: string): Promise<void>;
  addTerms(tenantId: string, t: TermsRecord): Promise<void>;
  /** 雇用条件の履歴（新しい順）。 */
  listTerms(tenantId: string, employeeId: string): Promise<HrTerms[]>;
  /** 従業員ごとのいまの雇用条件（適用日が今日以前で最も新しいもの。無ければ最も古いもの）。 */
  currentTerms(tenantId: string, today: string): Promise<Map<string, HrTerms>>;
  /** 手続きを作るか、済んでいなければ期限と名前を直す（同じ従業員・同じ手続きは 1 つ）。 */
  upsertTask(tenantId: string, t: Omit<HrTask, 'doneAt' | 'doneBy' | 'employeeName'>): Promise<void>;
  listTasks(tenantId: string, q: { employeeId?: string; openOnly?: boolean }): Promise<HrTask[]>;
  /** 労務カレンダーの知らせを送ったことを残す（初めてなら `true`）。 */
  markCalendarAlert(tenantId: string, key: string): Promise<boolean>;
  setTaskDone(tenantId: string, id: string, done: boolean, by: string): Promise<HrTask | null>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
/** date の列を YYYY-MM-DD にする（pg は日付を Date にするため、時差でずれないよう文字で受け取る）。 */
const day = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface EmployeeRow {
  id: string; code: string; name: string; kana: string; birth_date: unknown; gender: HrEmployee['gender']; address: string;
  phone: string; email: string; hired_on: unknown; left_on: unknown; leave_reason: string; employment: HrEmployee['employment'];
  category: HrEmployee['category']; department: string; title: string; user_id: string | null; status: HrEmployee['status'];
  note: string; updated_at: unknown;
}

const EMPLOYEE_SELECT = `select id, code, name, kana, birth_date::text, gender, address, phone, email, hired_on::text, left_on::text,
  leave_reason, employment, category, department, title, user_id, status, note, updated_at from hr_employees`;

const toEmployee = (r: EmployeeRow): HrEmployee => ({
  id: r.id, code: r.code, name: r.name, kana: r.kana, birthDate: day(r.birth_date), gender: r.gender, address: r.address,
  phone: r.phone, email: r.email, hiredOn: day(r.hired_on), leftOn: day(r.left_on), leaveReason: r.leave_reason,
  employment: r.employment, category: r.category, department: r.department, title: r.title, userId: r.user_id,
  status: r.status, note: r.note, updatedAt: iso(r.updated_at),
});

interface TermsRow {
  id: string; employee_id: string; effective_on: unknown; contract_start: unknown; contract_end: unknown; renewal: string; renewal_limit: string;
  probation_until: unknown; weekly_hours: unknown; weekly_days: unknown; start_time: string; end_time: string; break_minutes: unknown;
  wage_type: HrTerms['wageType']; wage_amount: unknown; allowances: HrTerms['allowances']; workplace: string; work: string;
  workplace_scope: string; work_scope: string; social_insurance: boolean; employment_insurance: boolean; created_at: unknown;
}

const TERMS_SELECT = `select id, employee_id, effective_on::text, contract_start::text, contract_end::text, renewal, renewal_limit, probation_until::text,
  weekly_hours, weekly_days, start_time, end_time, break_minutes, wage_type, wage_amount, allowances, workplace, work,
  workplace_scope, work_scope, social_insurance, employment_insurance, created_at from hr_terms`;

const toTerms = (r: TermsRow): HrTerms => ({
  id: r.id, employeeId: r.employee_id, effectiveOn: day(r.effective_on)!, contractStart: day(r.contract_start),
  contractEnd: day(r.contract_end), renewal: r.renewal, renewalLimit: r.renewal_limit ?? '', probationUntil: day(r.probation_until), weeklyHours: num(r.weekly_hours),
  weeklyDays: num(r.weekly_days), startTime: r.start_time, endTime: r.end_time, breakMinutes: num(r.break_minutes),
  wageType: r.wage_type, wageAmount: num(r.wage_amount), allowances: Array.isArray(r.allowances) ? r.allowances : [],
  workplace: r.workplace, work: r.work, workplaceScope: r.workplace_scope, workScope: r.work_scope,
  socialInsurance: r.social_insurance, employmentInsurance: r.employment_insurance, createdAt: iso(r.created_at),
});

interface TaskRow {
  id: string; employee_id: string; employee_name?: string; kind: HrTask['kind']; code: string; title: string;
  due_on: unknown; done_at: unknown; done_by: string | null;
}

const toTask = (r: TaskRow): HrTask => ({
  id: r.id, employeeId: r.employee_id, ...(r.employee_name ? { employeeName: r.employee_name } : {}), kind: r.kind, code: r.code,
  title: r.title, dueOn: day(r.due_on), doneAt: r.done_at ? iso(r.done_at) : null, doneBy: r.done_by,
});

/** PostgreSQL の人事の台帳の置き場。 */
export class PostgresHrStore implements HrStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 会社を設定したトランザクションの中で問い合わせる。 */
  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const rows = (await client.query<T>(text, params as never[])).rows;
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listEmployees(tenantId: string): Promise<HrEmployee[]> {
    const rows = await this.q<EmployeeRow>(tenantId, `${EMPLOYEE_SELECT} where tenant_id = $1 order by status, nullif(kana, ''), name`, [tenantId]);
    return rows.map(toEmployee);
  }

  async getEmployee(tenantId: string, id: string): Promise<HrEmployee | null> {
    const rows = await this.q<EmployeeRow>(tenantId, `${EMPLOYEE_SELECT} where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  async findEmployeeByCode(tenantId: string, code: string): Promise<HrEmployee | null> {
    const rows = await this.q<EmployeeRow>(tenantId, `${EMPLOYEE_SELECT} where tenant_id = $1 and code = $2 and code <> ''`, [tenantId, code]);
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  async findEmployeeByUser(tenantId: string, userId: string): Promise<HrEmployee | null> {
    const rows = await this.q<EmployeeRow>(tenantId, `${EMPLOYEE_SELECT} where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    return rows[0] ? toEmployee(rows[0]) : null;
  }

  private values(tenantId: string, e: EmployeeRecord, by: string): unknown[] {
    return [e.id, tenantId, e.code, e.name, e.kana, e.birthDate, e.gender, e.address, e.phone, e.email, e.hiredOn, e.leftOn,
      e.leaveReason, e.employment, e.category, e.department, e.title, e.userId, e.status, e.note, by];
  }

  async insertEmployee(tenantId: string, e: EmployeeRecord, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_employees (id, tenant_id, code, name, kana, birth_date, gender, address, phone, email,
      hired_on, left_on, leave_reason, employment, category, department, title, user_id, status, note, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, this.values(tenantId, e, by));
  }

  async updateEmployee(tenantId: string, e: EmployeeRecord, by: string): Promise<void> {
    await this.q(tenantId, `update hr_employees set code=$3, name=$4, kana=$5, birth_date=$6, gender=$7, address=$8, phone=$9, email=$10,
      hired_on=$11, left_on=$12, leave_reason=$13, employment=$14, category=$15, department=$16, title=$17, user_id=$18, status=$19,
      note=$20, updated_by=$21, updated_at=now() where id=$1 and tenant_id=$2`, this.values(tenantId, e, by));
  }

  async addTerms(tenantId: string, t: TermsRecord): Promise<void> {
    await this.q(tenantId, `insert into hr_terms (id, tenant_id, employee_id, effective_on, contract_start, contract_end, renewal,
      probation_until, weekly_hours, weekly_days, start_time, end_time, break_minutes, wage_type, wage_amount, allowances, workplace,
      work, workplace_scope, work_scope, social_insurance, employment_insurance, created_by, renewal_limit)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [t.id, tenantId, t.employeeId, t.effectiveOn, t.contractStart, t.contractEnd, t.renewal, t.probationUntil, t.weeklyHours,
      t.weeklyDays, t.startTime, t.endTime, t.breakMinutes, t.wageType, t.wageAmount, JSON.stringify(t.allowances), t.workplace,
      t.work, t.workplaceScope, t.workScope, t.socialInsurance, t.employmentInsurance, t.createdBy, t.renewalLimit ?? '']);
  }

  async listTerms(tenantId: string, employeeId: string): Promise<HrTerms[]> {
    const rows = await this.q<TermsRow>(tenantId, `${TERMS_SELECT} where tenant_id = $1 and employee_id = $2
      order by effective_on desc, created_at desc`, [tenantId, employeeId]);
    return rows.map(toTerms);
  }

  async currentTerms(tenantId: string, today: string): Promise<Map<string, HrTerms>> {
    // 今日までに効いている最も新しいもの。まだ効いていないもの（入社前）しか無ければ、最も早いもの。日付は YYYY-MM-DD の文字でくらべる
    const rows = await this.q<TermsRow>(tenantId, `select distinct on (employee_id) * from (${TERMS_SELECT} where tenant_id = $1) t
      order by employee_id, (effective_on <= $2::text) desc,
        case when effective_on <= $2::text then effective_on end desc nulls last, effective_on asc, created_at desc`, [tenantId, today]);
    return new Map(rows.map((r) => [r.employee_id, toTerms(r)]));
  }

  async upsertTask(tenantId: string, t: Omit<HrTask, 'doneAt' | 'doneBy' | 'employeeName'>): Promise<void> {
    await this.q(tenantId, `insert into hr_tasks (id, tenant_id, employee_id, kind, code, title, due_on) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (tenant_id, employee_id, kind, code) do update set title = excluded.title, due_on = excluded.due_on
      where hr_tasks.done_at is null`, [t.id, tenantId, t.employeeId, t.kind, t.code, t.title, t.dueOn]);
  }

  async markCalendarAlert(tenantId: string, key: string): Promise<boolean> {
    const rows = await this.q<{ key: string }>(tenantId, `insert into hr_calendar_alerts (tenant_id, key) values ($1, $2) on conflict do nothing returning key`, [tenantId, key]);
    return rows.length > 0;
  }

  async listTasks(tenantId: string, q: { employeeId?: string; openOnly?: boolean }): Promise<HrTask[]> {
    const params: unknown[] = [tenantId];
    let where = 't.tenant_id = $1';
    if (q.employeeId) { params.push(q.employeeId); where += ` and t.employee_id = $${params.length}`; }
    if (q.openOnly) where += ' and t.done_at is null';
    const rows = await this.q<TaskRow>(tenantId, `select t.id, t.employee_id, e.name as employee_name, t.kind, t.code, t.title,
      t.due_on::text, t.done_at, t.done_by from hr_tasks t join hr_employees e on e.id = t.employee_id
      where ${where} order by t.done_at is not null, t.due_on nulls last, t.created_at`, params);
    return rows.map(toTask);
  }

  async setTaskDone(tenantId: string, id: string, done: boolean, by: string): Promise<HrTask | null> {
    const rows = await this.q<TaskRow>(tenantId, `update hr_tasks set done_at = case when $3 then now() else null end,
      done_by = case when $3 then $4 else null end where tenant_id = $1 and id = $2
      returning id, employee_id, kind, code, title, due_on::text, done_at, done_by`, [tenantId, id, done, by]);
    return rows[0] ? toTask(rows[0]) : null;
  }
}
