/**
 * @file 会社の見た目の置き場（仕様書 第46.9節、移行 205）。会社ごとに版を重ね、いちばん新しい版をいまの見た目とする。直近の 20 版を残す。
 */

import pg from 'pg';
import { COMPANY_DESIGN_LIMITS, type CompanyDesignSource, type CompanyDesignTokens, type CompanyDesignView } from '@m2office/shared';
import { createPool } from '../repository/pool.js';

/** 新しい版。 */
export interface NewCompanyDesign {
  tokens: CompanyDesignTokens;
  summary: string;
  source: CompanyDesignSource;
  sourceName: string;
  createdBy: string;
}

/** 会社の見た目の置き場。 */
export interface CompanyDesignStore {
  /** いまの見た目（無ければ `null`）。 */
  current(tenantId: string): Promise<CompanyDesignView | null>;
  get(tenantId: string, version: number): Promise<CompanyDesignView | null>;
  /** 新しい順。 */
  list(tenantId: string, limit?: number): Promise<CompanyDesignView[]>;
  /** 新しい版を足し、古い版を消す（直近の 20 版を残す）。 */
  add(tenantId: string, d: NewCompanyDesign): Promise<CompanyDesignView>;
}

interface Row extends pg.QueryResultRow {
  version: number; tokens: CompanyDesignTokens; summary: string; source: CompanyDesignSource; source_name: string; created_by: string; created_at: Date | string;
}
const toView = (r: Row): CompanyDesignView => ({
  version: Number(r.version), tokens: r.tokens, summary: r.summary, source: r.source, sourceName: r.source_name, createdBy: r.created_by,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
});
const COLUMNS = 'version, tokens, summary, source, source_name, created_by, created_at';

/** PostgreSQL の置き場。 */
export class PostgresCompanyDesignStore implements CompanyDesignStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'company-design' });
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

  async current(tenantId: string): Promise<CompanyDesignView | null> {
    const [r] = await this.q<Row>(tenantId, `select ${COLUMNS} from company_designs where tenant_id = $1 order by version desc limit 1`, [tenantId]);
    return r ? toView(r) : null;
  }

  async get(tenantId: string, version: number): Promise<CompanyDesignView | null> {
    const [r] = await this.q<Row>(tenantId, `select ${COLUMNS} from company_designs where tenant_id = $1 and version = $2`, [tenantId, version]);
    return r ? toView(r) : null;
  }

  async list(tenantId: string, limit: number = COMPANY_DESIGN_LIMITS.versions): Promise<CompanyDesignView[]> {
    return (await this.q<Row>(tenantId, `select ${COLUMNS} from company_designs where tenant_id = $1 order by version desc limit $2`, [tenantId, limit])).map(toView);
  }

  async add(tenantId: string, d: NewCompanyDesign): Promise<CompanyDesignView> {
    const [r] = await this.q<Row>(tenantId,
      `insert into company_designs (tenant_id, version, tokens, summary, source, source_name, created_by)
       values ($1, coalesce((select max(version) from company_designs where tenant_id = $1), 0) + 1, $2, $3, $4, $5, $6)
       returning ${COLUMNS}`,
      [tenantId, JSON.stringify(d.tokens), d.summary, d.source, d.sourceName, d.createdBy]);
    await this.q(tenantId, 'delete from company_designs where tenant_id = $1 and version <= $2', [tenantId, Number(r!.version) - COMPANY_DESIGN_LIMITS.versions]);
    return toView(r!);
  }
}

/** 手元の置き場（テストと見本の会社）。 */
export class MemoryCompanyDesignStore implements CompanyDesignStore {
  private readonly rows = new Map<string, CompanyDesignView[]>();

  async current(tenantId: string): Promise<CompanyDesignView | null> {
    return structuredClone(this.rows.get(tenantId)?.at(-1) ?? null);
  }

  async get(tenantId: string, version: number): Promise<CompanyDesignView | null> {
    return structuredClone(this.rows.get(tenantId)?.find((v) => v.version === version) ?? null);
  }

  async list(tenantId: string, limit: number = COMPANY_DESIGN_LIMITS.versions): Promise<CompanyDesignView[]> {
    return structuredClone([...(this.rows.get(tenantId) ?? [])].reverse().slice(0, limit));
  }

  async add(tenantId: string, d: NewCompanyDesign): Promise<CompanyDesignView> {
    const list = this.rows.get(tenantId) ?? [];
    const v: CompanyDesignView = { ...structuredClone(d), version: (list.at(-1)?.version ?? 0) + 1, createdAt: new Date().toISOString() };
    this.rows.set(tenantId, [...list, v].slice(-COMPANY_DESIGN_LIMITS.versions));
    return structuredClone(v);
  }
}
