/**
 * @file Web の振り返りの置き場（仕様書 第34.14節・第34.18節）。月の便り（`web_review_reports`）を会社ごとに、月ごとに 1 つ置く。
 * PostgreSQL（行単位のセキュリティで会社を絞る）と、試験用のメモリの 2 つ。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { WebReviewFigures, WebReviewReport, WebReviewReportBrief } from '@m2office/shared';

/** 新しい月の便り。 */
export type NewWebReviewReport = Omit<WebReviewReport, 'id' | 'createdAt'>;

/** 月の便りの置き場。 */
export interface WebReviewStore {
  /** 新しい順の一覧 */
  list(tenantId: string, limit: number): Promise<WebReviewReportBrief[]>;
  /** その月の便り。無ければ `null` */
  get(tenantId: string, month: string): Promise<WebReviewReport | null>;
  /** いちばん新しい便り */
  latest(tenantId: string): Promise<WebReviewReport | null>;
  /**
   * 便りを置く。その月の便りがすでにあれば置かない（月に 1 回だけ）。
   *
   * @returns 置いたら ID、すでにあれば `null`
   */
  add(tenantId: string, r: NewWebReviewReport): Promise<string | null>;
}

interface Row {
  id: string;
  month: string;
  figures: WebReviewFigures;
  summary: string;
  good: string;
  concern: string;
  next: string[];
  created_at: Date | string;
}

const toReport = (r: Row): WebReviewReport => ({
  id: r.id, month: r.month, figures: r.figures, summary: r.summary, good: r.good, concern: r.concern, next: r.next ?? [],
  createdAt: new Date(r.created_at).toISOString(),
});

/** PostgreSQL の置き場。 */
export class PostgresWebReviewStore implements WebReviewStore {
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

  async list(tenantId: string, limit: number): Promise<WebReviewReportBrief[]> {
    const rows = await this.q<{ id: string; month: string; summary: string; created_at: Date | string }>(tenantId,
      `select id, month, summary, created_at from web_review_reports where tenant_id = $1 order by month desc limit $2`, [tenantId, limit]);
    return rows.map((r) => ({ id: r.id, month: r.month, summary: r.summary, createdAt: new Date(r.created_at).toISOString() }));
  }

  async get(tenantId: string, month: string): Promise<WebReviewReport | null> {
    const rows = await this.q<Row>(tenantId, `select id, month, figures, summary, good, concern, next, created_at from web_review_reports where tenant_id = $1 and month = $2`, [tenantId, month]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async latest(tenantId: string): Promise<WebReviewReport | null> {
    const rows = await this.q<Row>(tenantId, `select id, month, figures, summary, good, concern, next, created_at from web_review_reports where tenant_id = $1 order by month desc limit 1`, [tenantId]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async add(tenantId: string, r: NewWebReviewReport): Promise<string | null> {
    const id = `wr-${randomUUID()}`;
    const rows = await this.q<{ id: string }>(tenantId,
      `insert into web_review_reports (id, tenant_id, month, figures, summary, good, concern, next) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tenant_id, month) do nothing returning id`,
      [id, tenantId, r.month, JSON.stringify(r.figures), r.summary, r.good, r.concern, r.next]);
    return rows[0]?.id ?? null;
  }
}

/** 試験用のメモリの置き場。 */
export class MemoryWebReviewStore implements WebReviewStore {
  private readonly rows = new Map<string, WebReviewReport & { tenantId: string }>();

  async list(tenantId: string, limit: number): Promise<WebReviewReportBrief[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit)
      .map((r) => ({ id: r.id, month: r.month, summary: r.summary, createdAt: r.createdAt }));
  }

  async get(tenantId: string, month: string): Promise<WebReviewReport | null> {
    const r = this.rows.get(`${tenantId}:${month}`);
    return r ? { ...r } : null;
  }

  async latest(tenantId: string): Promise<WebReviewReport | null> {
    const [first] = await this.list(tenantId, 1);
    return first ? this.get(tenantId, first.month) : null;
  }

  async add(tenantId: string, r: NewWebReviewReport): Promise<string | null> {
    const key = `${tenantId}:${r.month}`;
    if (this.rows.has(key)) return null;
    const id = `wr-${randomUUID()}`;
    this.rows.set(key, { ...r, id, tenantId, createdAt: new Date().toISOString() });
    return id;
  }
}
