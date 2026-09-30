/**
 * @file 社会保険の届出の下書きを作った記録の置き場（仕様書 第30.12.1節）。人ごと・届出の種類ごと・対象ごとに 1 つ。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。マイナンバー・基礎年金番号は持たない。
 */

import pg from 'pg';
import type { HrFilingKind } from '@m2office/shared';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** 届出の下書きを作った記録。`data` は届出に載せた中身（決定・取得・喪失の 1 人分）。 */
export interface HrFilingRecord {
  id: string;
  employeeId: string;
  kind: HrFilingKind;
  /** 対象（定時決定と随時改定は適用の月 YYYY-MM、取得・喪失・70 歳到達は日 YYYY-MM-DD）。 */
  target: string;
  data: Record<string, unknown>;
  createdAt: string;
}

/** 届出の記録の置き場。 */
export interface SocialStore {
  list(tenantId: string, kind?: HrFilingKind): Promise<HrFilingRecord[]>;
  /** 残す（同じ人・種類・対象があれば置き換える）。 */
  save(tenantId: string, f: Omit<HrFilingRecord, 'createdAt'>, by: string): Promise<void>;
}

interface Row { id: string; employee_id: string; kind: HrFilingKind; target: string; data: Record<string, unknown>; created_at: unknown }

/** PostgreSQL の届出の記録の置き場。 */
export class PostgresSocialStore implements SocialStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
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

  async list(tenantId: string, kind?: HrFilingKind): Promise<HrFilingRecord[]> {
    const rows = await this.q<Row>(tenantId, `select id, employee_id, kind, target, data, created_at from hr_insurance_filings
      where tenant_id = $1 ${kind ? 'and kind = $2' : ''} order by created_at desc`, kind ? [tenantId, kind] : [tenantId]);
    return rows.map((r) => ({ id: r.id, employeeId: r.employee_id, kind: r.kind, target: r.target, data: r.data ?? {}, createdAt: iso(r.created_at) }));
  }

  async save(tenantId: string, f: Omit<HrFilingRecord, 'createdAt'>, by: string): Promise<void> {
    await this.q(tenantId, `insert into hr_insurance_filings (id, tenant_id, employee_id, kind, target, data, created_by) values ($1,$2,$3,$4,$5,$6::jsonb,$7)
      on conflict (tenant_id, employee_id, kind, target) do update set data = excluded.data, created_by = excluded.created_by, created_at = now()`,
    [f.id, tenantId, f.employeeId, f.kind, f.target, JSON.stringify(f.data), by]);
  }
}
