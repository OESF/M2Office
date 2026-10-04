/**
 * @file 接続先の健全性の置き場（仕様書 第6.7.6節、移行 086）。会社ごと・接続ごとの 1 分単位の回数と時間。
 *
 * 会社の境界はデータベースの行単位の制限でも効く（移行 086）。
 */

import pg from 'pg';

/** 1 分ぶんの記録。 */
export interface HealthBucket {
  tenantId: string;
  target: string;
  /** その 1 分の始まり（ISO 8601）。 */
  minute: string;
  ok: number;
  fail: number;
  totalMs: number;
  /** 最後の失敗の種類。失敗が無ければ `null`。 */
  lastError: string | null;
}

/** 接続 1 つの、見る範囲の集計。 */
export interface HealthSummary {
  target: string;
  ok: number;
  fail: number;
  totalMs: number;
  /** 呼び出しのあった最後の 1 分の始まり。 */
  lastMinute: string;
  /** 呼び出しのあった最後の 1 分の成功と失敗の数。 */
  lastOk: number;
  lastFail: number;
  /** 範囲の中で最後の失敗の種類。 */
  lastError: string | null;
}

/**
 * 健全性の置き場。
 *
 * @remarks どの操作も会社で絞る（不変則 I-2）
 */
export interface HealthStore {
  /** 1 分ぶんを足し込む（同じ 1 分があれば数を足す）。 */
  add(b: HealthBucket): Promise<void>;
  /** `since` 以降の記録を接続ごとにまとめる。 */
  summary(tenantId: string, since: string): Promise<HealthSummary[]>;
  /** `before` より前の記録を消す。 */
  prune(tenantId: string, before: string): Promise<number>;
}

/**
 * PostgreSQL の置き場。
 *
 * @remarks 問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する（行単位の制限）
 */
export class PostgresHealthStore implements HealthStore {
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

  async add(b: HealthBucket): Promise<void> {
    await this.q(b.tenantId,
      `insert into connection_health (tenant_id, target, minute, ok, fail, total_ms, last_error)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (tenant_id, target, minute) do update set
         ok = connection_health.ok + excluded.ok,
         fail = connection_health.fail + excluded.fail,
         total_ms = connection_health.total_ms + excluded.total_ms,
         last_error = coalesce(excluded.last_error, connection_health.last_error)`,
      [b.tenantId, b.target, b.minute, b.ok, b.fail, b.totalMs, b.lastError]);
  }

  async summary(tenantId: string, since: string): Promise<HealthSummary[]> {
    const rows = await this.q<{
      target: string; ok: number; fail: number; total_ms: string; last_minute: Date | string;
      last_ok: number; last_fail: number; last_error: string | null;
    }>(tenantId,
      `with r as (
         select * from connection_health where tenant_id = $1 and minute >= $2
       ), latest as (
         select distinct on (target) target, minute, ok, fail from r order by target, minute desc
       ), err as (
         select distinct on (target) target, last_error from r where last_error is not null order by target, minute desc
       )
       select r.target, sum(r.ok)::int as ok, sum(r.fail)::int as fail, sum(r.total_ms)::text as total_ms,
              l.minute as last_minute, l.ok as last_ok, l.fail as last_fail, e.last_error
         from r join latest l on l.target = r.target left join err e on e.target = r.target
        group by r.target, l.minute, l.ok, l.fail, e.last_error`,
      [tenantId, since]);
    return rows.map((r) => ({
      target: r.target, ok: r.ok, fail: r.fail, totalMs: Number(r.total_ms),
      lastMinute: r.last_minute instanceof Date ? r.last_minute.toISOString() : String(r.last_minute),
      lastOk: r.last_ok, lastFail: r.last_fail, lastError: r.last_error,
    }));
  }

  async prune(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ target: string }>(tenantId,
      `delete from connection_health where tenant_id = $1 and minute < $2 returning target`, [tenantId, before]);
    return rows.length;
  }
}
