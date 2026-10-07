/**
 * @file 年末調整の申告の置き場（仕様書 第30.15.1節）。年ごと・人ごとの申告と、出した日時・担当者が確かめた日時。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。マイナンバーは持たない。
 */

import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { YeaDeclaration, YeaDeclarationView } from '@m2office/shared';

const iso = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

/** 年末調整の申告の置き場。 */
export interface YeaStore {
  get(tenantId: string, employeeId: string, year: number): Promise<YeaDeclarationView | null>;
  list(tenantId: string, year: number): Promise<YeaDeclarationView[]>;
  /** 申告を残す（`submit` なら出した日時を入れる。担当者が確かめた印は外す）。 */
  save(tenantId: string, employeeId: string, year: number, data: YeaDeclaration, by: string, submit: boolean): Promise<void>;
  /** 担当者が確かめた（`null` で外す）。 */
  setChecked(tenantId: string, employeeId: string, year: number, by: string | null): Promise<boolean>;
}

interface Row { employee_id: string; employee_name: string; year: number; data: YeaDeclaration; submitted_at: unknown; checked_at: unknown }
const toView = (r: Row): YeaDeclarationView => ({ employeeId: r.employee_id, employeeName: r.employee_name, year: r.year, data: r.data, submittedAt: iso(r.submitted_at), checkedAt: iso(r.checked_at) });

/** PostgreSQL の年末調整の申告の置き場。 */
export class PostgresYeaStore implements YeaStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'hr/yea' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

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

  async get(tenantId: string, employeeId: string, year: number): Promise<YeaDeclarationView | null> {
    const rows = await this.q<Row>(tenantId, `select d.employee_id, e.name as employee_name, d.year, d.data, d.submitted_at, d.checked_at
      from yea_declarations d join hr_employees e on e.id = d.employee_id where d.tenant_id = $1 and d.employee_id = $2 and d.year = $3`, [tenantId, employeeId, year]);
    return rows[0] ? toView(rows[0]) : null;
  }

  async list(tenantId: string, year: number): Promise<YeaDeclarationView[]> {
    const rows = await this.q<Row>(tenantId, `select d.employee_id, e.name as employee_name, d.year, d.data, d.submitted_at, d.checked_at
      from yea_declarations d join hr_employees e on e.id = d.employee_id where d.tenant_id = $1 and d.year = $2`, [tenantId, year]);
    return rows.map(toView);
  }

  async save(tenantId: string, employeeId: string, year: number, data: YeaDeclaration, by: string, submit: boolean): Promise<void> {
    await this.q(tenantId, `insert into yea_declarations (tenant_id, employee_id, year, data, submitted_at, submitted_by)
      values ($1,$2,$3,$4::jsonb, case when $5 then now() end, case when $5 then $6 end)
      on conflict (tenant_id, employee_id, year) do update set data = excluded.data,
        submitted_at = coalesce(excluded.submitted_at, yea_declarations.submitted_at), submitted_by = coalesce(excluded.submitted_by, yea_declarations.submitted_by),
        checked_at = null, checked_by = null, updated_at = now()`,
    [tenantId, employeeId, year, JSON.stringify(data), submit, by]);
  }

  async setChecked(tenantId: string, employeeId: string, year: number, by: string | null): Promise<boolean> {
    const rows = await this.q<{ employee_id: string }>(tenantId, `update yea_declarations set checked_at = case when $4::text is null then null else now() end, checked_by = $4
      where tenant_id = $1 and employee_id = $2 and year = $3 returning employee_id`, [tenantId, employeeId, year, by]);
    return rows.length > 0;
  }
}
