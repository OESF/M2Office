/**
 * @file 労働保険の年度更新の置き場（仕様書 第30.13.1節）。年度更新の年ごとに、担当者が入れたもの（足りない月の合計・申告済の概算保険料・
 * 見込みの賃金）と、下書きを作ったときの結果を持つ。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。
 */

import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { LaborInsuranceData, LaborInsuranceResult } from '@m2office/shared';

const iso = (v: unknown): string | null => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

/** 年度更新の 1 年分。 */
export interface LaborRecord {
  year: number;
  data: LaborInsuranceData;
  result: LaborInsuranceResult | null;
  filedAt: string | null;
}

/** 年度更新の置き場。 */
export interface LaborStore {
  get(tenantId: string, year: number): Promise<LaborRecord | null>;
  /** 担当者が入れたものを残す。 */
  save(tenantId: string, year: number, data: LaborInsuranceData, by: string): Promise<void>;
  /** 下書きを作ったときの結果を残す。 */
  file(tenantId: string, year: number, data: LaborInsuranceData, result: LaborInsuranceResult, by: string): Promise<void>;
}

interface Row { year: number; data: LaborInsuranceData; result: LaborInsuranceResult | null; filed_at: unknown }

/** PostgreSQL の年度更新の置き場。 */
export class PostgresLaborStore implements LaborStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'hr/labor' });
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

  async get(tenantId: string, year: number): Promise<LaborRecord | null> {
    const rows = await this.q<Row>(tenantId, `select year, data, result, filed_at from hr_labor_insurance where tenant_id = $1 and year = $2`, [tenantId, year]);
    const r = rows[0];
    return r ? { year: r.year, data: r.data, result: r.result, filedAt: iso(r.filed_at) } : null;
  }

  async save(tenantId: string, year: number, data: LaborInsuranceData, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_labor_insurance (tenant_id, year, data, updated_by) values ($1,$2,$3::jsonb,$4)
      on conflict (tenant_id, year) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`, [tenantId, year, JSON.stringify(data), by]);
  }

  async file(tenantId: string, year: number, data: LaborInsuranceData, result: LaborInsuranceResult, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_labor_insurance (tenant_id, year, data, result, filed_at, filed_by, updated_by) values ($1,$2,$3::jsonb,$4::jsonb, now(), $5, $5)
      on conflict (tenant_id, year) do update set data = excluded.data, result = excluded.result, filed_at = now(), filed_by = excluded.filed_by, updated_at = now()`,
    [tenantId, year, JSON.stringify(data), JSON.stringify(result), by]);
  }
}
