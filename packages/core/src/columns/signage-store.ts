/**
 * @file コラムから作る店頭サイネージ用の組の置き場（仕様書 第32.18.6節、移行 087）。PostgreSQL と、自動テスト用のメモリの 2 つ。
 *
 * 会社の境界はデータベースの行単位の制限でも効く（移行 087）。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { ColumnSignageKind, ColumnSignageOutput, ColumnSignageScene, ColumnSignageSet, ColumnSignageStatus } from '@m2office/shared';

/** 組を書き換えるときの値。 */
export type ColumnSignagePatch = Partial<{
  status: ColumnSignageStatus;
  scenes: ColumnSignageScene[];
  outputs: ColumnSignageOutput[];
  aiAttempts: number;
  videoAttempts: number;
  note: string;
  error: string | null;
  runId: string | null;
  digest: string | null;
  screenIds: string[];
  assetIds: string[];
  publishUntil: string | null;
}>;

/** 置き場の中の組（承認の印と素材の ID を含む）。 */
export interface StoredColumnSignage extends ColumnSignageSet {
  digest: string | null;
  assetIds: string[];
  aiAttempts: number;
  /** 動画を作った回数（月の上限に数える）。 */
  videoAttempts: number;
}

/**
 * 店頭サイネージ用の組の置き場。
 *
 * @remarks どの操作も会社で絞る（不変則 I-2）
 */
export interface ColumnSignageStore {
  create(tenantId: string, s: { columnId: string; kind: ColumnSignageKind; createdBy: string }): Promise<string>;
  get(tenantId: string, id: string): Promise<StoredColumnSignage | null>;
  /** コラムの組（新しい順）。 */
  listByColumn(tenantId: string, columnId: string, limit?: number): Promise<StoredColumnSignage[]>;
  /** 状態の組（古い順）。 */
  listByStatus(tenantId: string, status: ColumnSignageStatus, limit?: number): Promise<StoredColumnSignage[]>;
  update(tenantId: string, id: string, patch: ColumnSignagePatch): Promise<void>;
  /** `making` の組を 1 つだけ受け持つ（同じ組を二重に作らない）。受け持てたら `true`。 */
  claim(tenantId: string, id: string, staleBeforeIso: string): Promise<boolean>;
  /** `since` 以降に作った動画の回数（会社で月の上限に数える）。 */
  videoAttemptsSince(tenantId: string, since: string): Promise<number>;
}

interface Row {
  tenant_id: string; id: string; column_id: string; kind: ColumnSignageKind; status: ColumnSignageStatus;
  scenes: ColumnSignageScene[]; outputs: ColumnSignageOutput[]; ai_attempts: number; video_attempts: number; note: string; error: string | null;
  run_id: string | null; digest: string | null; screen_ids: string[]; asset_ids: string[]; publish_until: unknown;
  created_by: string; created_at: unknown; updated_at: unknown;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

function toSet(r: Row): StoredColumnSignage {
  return {
    id: r.id, columnId: r.column_id, kind: r.kind, status: r.status, scenes: r.scenes ?? [], outputs: r.outputs ?? [], note: r.note,
    error: r.error, runId: r.run_id, screenIds: r.screen_ids ?? [], publishUntil: iso(r.publish_until), createdBy: r.created_by,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, digest: r.digest, assetIds: r.asset_ids ?? [], aiAttempts: r.ai_attempts, videoAttempts: r.video_attempts ?? 0,
  };
}

/** 書き換えの値を、列と値に直す。 */
function patchColumns(patch: ColumnSignagePatch): { sets: string[]; values: unknown[] } {
  const map: Record<keyof ColumnSignagePatch, [string, (v: unknown) => unknown]> = {
    status: ['status', (v) => v], scenes: ['scenes', (v) => JSON.stringify(v)], outputs: ['outputs', (v) => JSON.stringify(v)],
    aiAttempts: ['ai_attempts', (v) => v], videoAttempts: ['video_attempts', (v) => v], note: ['note', (v) => v], error: ['error', (v) => v], runId: ['run_id', (v) => v],
    digest: ['digest', (v) => v], screenIds: ['screen_ids', (v) => v], assetIds: ['asset_ids', (v) => v], publishUntil: ['publish_until', (v) => v],
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof ColumnSignagePatch, unknown][]) {
    if (v === undefined) continue;
    const [col, conv] = map[k];
    values.push(conv(v));
    sets.push(`${col} = $${values.length + 2}`);
  }
  return { sets, values };
}

/**
 * PostgreSQL の置き場。
 *
 * @remarks 問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する（行単位の制限）
 */
export class PostgresColumnSignageStore implements ColumnSignageStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'columns/signage' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const res = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return res.rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async create(tenantId: string, s: { columnId: string; kind: ColumnSignageKind; createdBy: string }): Promise<string> {
    const id = `csg-${randomUUID()}`;
    await this.q(tenantId, `insert into column_signage (tenant_id, id, column_id, kind, created_by) values ($1, $2, $3, $4, $5)`,
      [tenantId, id, s.columnId, s.kind, s.createdBy]);
    return id;
  }

  async get(tenantId: string, id: string): Promise<StoredColumnSignage | null> {
    const rows = await this.q<Row>(tenantId, `select * from column_signage where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toSet(rows[0]) : null;
  }

  async listByColumn(tenantId: string, columnId: string, limit = 10): Promise<StoredColumnSignage[]> {
    const rows = await this.q<Row>(tenantId,
      `select * from column_signage where tenant_id = $1 and column_id = $2 order by created_at desc limit $3`, [tenantId, columnId, limit]);
    return rows.map(toSet);
  }

  async listByStatus(tenantId: string, status: ColumnSignageStatus, limit = 50): Promise<StoredColumnSignage[]> {
    const rows = await this.q<Row>(tenantId,
      `select * from column_signage where tenant_id = $1 and status = $2 order by created_at limit $3`, [tenantId, status, limit]);
    return rows.map(toSet);
  }

  async update(tenantId: string, id: string, patch: ColumnSignagePatch): Promise<void> {
    const { sets, values } = patchColumns(patch);
    if (!sets.length) return;
    await this.q(tenantId, `update column_signage set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, ...values]);
  }

  async claim(tenantId: string, id: string, staleBeforeIso: string): Promise<boolean> {
    // 受け持った日時を残す。止まったまま古くなった受け持ちは、ほかが受け持ち直せる
    const rows = await this.q<{ id: string }>(tenantId,
      `update column_signage set claimed_at = now()
        where tenant_id = $1 and id = $2 and status = 'making' and (claimed_at is null or claimed_at < $3) returning id`, [tenantId, id, staleBeforeIso]);
    return rows.length > 0;
  }

  async videoAttemptsSince(tenantId: string, since: string): Promise<number> {
    const rows = await this.q<{ n: string | null }>(tenantId,
      `select coalesce(sum(video_attempts), 0) as n from column_signage where tenant_id = $1 and created_at >= $2`, [tenantId, since]);
    return Number(rows[0]?.n ?? 0);
  }
}

/** 自動テスト用のメモリの置き場。 */
export class MemoryColumnSignageStore implements ColumnSignageStore {
  readonly rows: (StoredColumnSignage & { tenantId: string; claimed: boolean })[] = [];

  async create(tenantId: string, s: { columnId: string; kind: ColumnSignageKind; createdBy: string }): Promise<string> {
    const now = new Date().toISOString();
    const id = `csg-${randomUUID()}`;
    this.rows.unshift({
      tenantId, id, columnId: s.columnId, kind: s.kind, status: 'making', scenes: [], outputs: [], note: '', error: null, runId: null,
      screenIds: [], publishUntil: null, createdBy: s.createdBy, createdAt: now, updatedAt: now, digest: null, assetIds: [], aiAttempts: 0, videoAttempts: 0, claimed: false,
    });
    return id;
  }

  async get(tenantId: string, id: string): Promise<StoredColumnSignage | null> {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id);
    return r ? { ...r } : null;
  }

  async listByColumn(tenantId: string, columnId: string, limit = 10): Promise<StoredColumnSignage[]> {
    return this.rows.filter((x) => x.tenantId === tenantId && x.columnId === columnId).slice(0, limit).map((r) => ({ ...r }));
  }

  async listByStatus(tenantId: string, status: ColumnSignageStatus, limit = 50): Promise<StoredColumnSignage[]> {
    return this.rows.filter((x) => x.tenantId === tenantId && x.status === status).reverse().slice(0, limit).map((r) => ({ ...r }));
  }

  async update(tenantId: string, id: string, patch: ColumnSignagePatch): Promise<void> {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id);
    if (!r) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
    r.updatedAt = new Date().toISOString();
  }

  async claim(tenantId: string, id: string): Promise<boolean> {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id && x.status === 'making');
    if (!r || r.claimed) return false;
    r.claimed = true;
    return true;
  }

  async videoAttemptsSince(tenantId: string, since: string): Promise<number> {
    return this.rows.filter((x) => x.tenantId === tenantId && x.createdAt >= since).reduce((n, x) => n + x.videoAttempts, 0);
  }
}
