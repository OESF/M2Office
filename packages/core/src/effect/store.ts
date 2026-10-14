/**
 * @file 効果の欄とレポートの置き場（仕様書 第6.7.13節）。期間の実行と AI の利用を集計し、レポート（`effect_reports`）を会社と月で 1 つ置く。
 *
 * PostgreSQL（行単位のセキュリティで会社を絞る）と、試験用のメモリの 2 つ。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { EffectFigures, EffectReport, EffectReportBody, EffectReportBrief, EffectReportKind } from '@m2office/shared';
import { createPool } from '../repository/pool.js';
import { purposeGroup } from '../usage/ai-usage.js';
import type { EffectAiRow, EffectRunRow } from './figures.js';

/** 新しいレポート。 */
export interface NewEffectReport {
  month: string;
  kind: EffectReportKind;
  figures: EffectFigures;
  body: EffectReportBody;
  createdBy: string | null;
}

/** 効果の置き場。 */
export interface EffectStore {
  /** 期間（`from` 以上 `until` 未満に始まった実行）の、業務ごとの完了の件数と推計の削減時間 */
  runTotals(tenantId: string, from: Date, until: Date): Promise<EffectRunRow[]>;
  /** 期間の AI の利用（用途はまとめた後） */
  aiTotals(tenantId: string, from: Date, until: Date): Promise<EffectAiRow[]>;
  /** その会社の最初の実行か AI の利用の時刻。どちらも無ければ `null` */
  firstActivity(tenantId: string): Promise<Date | null>;
  /** 新しい順の一覧 */
  list(tenantId: string, limit: number): Promise<EffectReportBrief[]>;
  get(tenantId: string, id: string): Promise<EffectReport | null>;
  /** その月のレポート */
  byMonth(tenantId: string, month: string): Promise<EffectReport | null>;
  /**
   * レポートを置く。
   *
   * @param replace 同じ月があれば置き換えるか（手で作り直すとき）。`false` なら、あれば置かない
   * @returns 置いたレポート。置かなければ `null`
   */
  save(tenantId: string, r: NewEffectReport, replace: boolean): Promise<EffectReport | null>;
  /** `beforeMonth` より前の月のレポートを消す。消した数 */
  prune(tenantId: string, beforeMonth: string): Promise<number>;
}

interface Row {
  id: string; month: string; kind: EffectReportKind; figures: EffectFigures; body: EffectReportBody; created_by: string | null; created_at: Date | string;
}
const toReport = (r: Row): EffectReport => ({
  id: r.id, month: r.month, kind: r.kind, figures: r.figures, body: r.body, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
});
const COLUMNS = 'id, month, kind, figures, body, created_by, created_at';

/** PostgreSQL の置き場。 */
export class PostgresEffectStore implements EffectStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'effect' });
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

  async runTotals(tenantId: string, from: Date, until: Date): Promise<EffectRunRow[]> {
    return this.q<EffectRunRow>(tenantId,
      `select j.agent_id as "agentId",
              (count(*) filter (where r.status = 'completed'))::int as completed,
              coalesce(sum(r.saved_minutes) filter (where r.status = 'completed'), 0)::float8 as "savedMinutes"
         from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1 and r.started_at >= $2 and r.started_at < $3
        group by j.agent_id`, [tenantId, from.toISOString(), until.toISOString()]);
  }

  async aiTotals(tenantId: string, from: Date, until: Date): Promise<EffectAiRow[]> {
    const rows = await this.q<{ purpose: string; cost: number; calls: number }>(tenantId,
      `select purpose, coalesce(sum(cost_jpy), 0)::float8 as cost, count(*)::int as calls
         from ai_usage where tenant_id = $1 and at >= $2 and at < $3 group by purpose`, [tenantId, from.toISOString(), until.toISOString()]);
    const by = new Map<string, EffectAiRow>();
    for (const r of rows) {
      const key = purposeGroup(r.purpose);
      const x = by.get(key) ?? { purpose: key, costJpy: 0, calls: 0 };
      x.costJpy += r.cost; x.calls += r.calls; by.set(key, x);
    }
    return [...by.values()];
  }

  async firstActivity(tenantId: string): Promise<Date | null> {
    const rows = await this.q<{ at: Date | string | null }>(tenantId,
      `select least((select min(started_at) from runs where tenant_id = $1), (select min(at) from ai_usage where tenant_id = $1)) as at`, [tenantId]);
    return rows[0]?.at ? new Date(rows[0].at) : null;
  }

  async list(tenantId: string, limit: number): Promise<EffectReportBrief[]> {
    const rows = await this.q<{ id: string; month: string; kind: EffectReportKind; headline: string | null; created_at: Date | string }>(tenantId,
      `select id, month, kind, body->'summary'->>0 as headline, created_at from effect_reports where tenant_id = $1 order by month desc limit $2`, [tenantId, limit]);
    return rows.map((r) => ({ id: r.id, month: r.month, kind: r.kind, headline: r.headline ?? '', createdAt: new Date(r.created_at).toISOString() }));
  }

  async get(tenantId: string, id: string): Promise<EffectReport | null> {
    const rows = await this.q<Row>(tenantId, `select ${COLUMNS} from effect_reports where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async byMonth(tenantId: string, month: string): Promise<EffectReport | null> {
    const rows = await this.q<Row>(tenantId, `select ${COLUMNS} from effect_reports where tenant_id = $1 and month = $2`, [tenantId, month]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async save(tenantId: string, r: NewEffectReport, replace: boolean): Promise<EffectReport | null> {
    const rows = await this.q<Row>(tenantId,
      `insert into effect_reports (id, tenant_id, month, kind, figures, body, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, month) do ${replace
        ? 'update set kind = excluded.kind, figures = excluded.figures, body = excluded.body, created_by = excluded.created_by, created_at = now()'
        : 'nothing'}
       returning ${COLUMNS}`,
      [`ef-${randomUUID()}`, tenantId, r.month, r.kind, JSON.stringify(r.figures), JSON.stringify(r.body), r.createdBy]);
    return rows[0] ? toReport(rows[0]) : null;
  }

  async prune(tenantId: string, beforeMonth: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from effect_reports where tenant_id = $1 and month < $2 returning id`, [tenantId, beforeMonth]);
    return rows.length;
  }
}

/** 試験用の置き場。集計の元は `runs`・`ai` に入れておく。 */
export class MemoryEffectStore implements EffectStore {
  readonly reports: (EffectReport & { tenantId: string })[] = [];
  /** 集計の元（会社ごと。`at` で期間を絞る） */
  runs: (EffectRunRow & { tenantId: string; at: Date })[] = [];
  ai: (EffectAiRow & { tenantId: string; at: Date })[] = [];

  async runTotals(tenantId: string, from: Date, until: Date): Promise<EffectRunRow[]> {
    const by = new Map<string, EffectRunRow>();
    for (const r of this.runs.filter((x) => x.tenantId === tenantId && x.at >= from && x.at < until)) {
      const x = by.get(r.agentId) ?? { agentId: r.agentId, completed: 0, savedMinutes: 0 };
      x.completed += r.completed; x.savedMinutes += r.savedMinutes; by.set(r.agentId, x);
    }
    return [...by.values()];
  }

  async aiTotals(tenantId: string, from: Date, until: Date): Promise<EffectAiRow[]> {
    const by = new Map<string, EffectAiRow>();
    for (const r of this.ai.filter((x) => x.tenantId === tenantId && x.at >= from && x.at < until)) {
      const key = purposeGroup(r.purpose);
      const x = by.get(key) ?? { purpose: key, costJpy: 0, calls: 0 };
      x.costJpy += r.costJpy; x.calls += r.calls; by.set(key, x);
    }
    return [...by.values()];
  }

  async firstActivity(tenantId: string): Promise<Date | null> {
    const ts = [...this.runs, ...this.ai].filter((x) => x.tenantId === tenantId).map((x) => x.at.getTime());
    return ts.length ? new Date(Math.min(...ts)) : null;
  }

  async list(tenantId: string, limit: number): Promise<EffectReportBrief[]> {
    return this.reports.filter((r) => r.tenantId === tenantId).sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit)
      .map((r) => ({ id: r.id, month: r.month, kind: r.kind, headline: r.body.summary[0] ?? '', createdAt: r.createdAt }));
  }

  async get(tenantId: string, id: string): Promise<EffectReport | null> {
    const r = this.reports.find((x) => x.tenantId === tenantId && x.id === id);
    return r ? strip(r) : null;
  }

  async byMonth(tenantId: string, month: string): Promise<EffectReport | null> {
    const r = this.reports.find((x) => x.tenantId === tenantId && x.month === month);
    return r ? strip(r) : null;
  }

  async save(tenantId: string, r: NewEffectReport, replace: boolean): Promise<EffectReport | null> {
    const i = this.reports.findIndex((x) => x.tenantId === tenantId && x.month === r.month);
    if (i >= 0 && !replace) return null;
    const row = { ...r, id: i >= 0 ? this.reports[i]!.id : `ef-${randomUUID()}`, tenantId, createdAt: new Date().toISOString() };
    if (i >= 0) this.reports[i] = row; else this.reports.push(row);
    return strip(row);
  }

  async prune(tenantId: string, beforeMonth: string): Promise<number> {
    const before = this.reports.length;
    for (let i = this.reports.length - 1; i >= 0; i--) {
      if (this.reports[i]!.tenantId === tenantId && this.reports[i]!.month < beforeMonth) this.reports.splice(i, 1);
    }
    return before - this.reports.length;
  }
}

const strip = ({ tenantId: _t, ...r }: EffectReport & { tenantId: string }): EffectReport => r;
