/**
 * @file 有効になっていない Google の API を、会社ごとに覚える（仕様書 第6.6.2節「足りない API を知らせる」、Q-269）。
 *
 * Google の呼び出し（`connectors/google/http.ts`）が、断られたときに {@link noteApiDisabled}、成功したときに {@link noteApiOk} を呼ぶ。
 * 受け口はプロセスに 1 つ置く（{@link installApiGapSink}。API とワーカー）。受け口が無ければ何もしない（自動テストと道具）。
 * 残すのは API の名前と日時だけ。初めて見つけたときは管理者に知らせる（同じ API は 1 日に 1 回まで）。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { googleApiLabel } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { createPool } from '../repository/pool.js';

/** 呼び出しの結果を受け取る口。 */
export interface ApiGapSink {
  disabled(tenantId: string, service: string): void;
  ok(tenantId: string, service: string): void;
}

let sink: ApiGapSink | null = null;

/** このプロセスの受け口を置く（外すときは `null`）。API とワーカーの起動のときに 1 度だけ呼ぶ。 */
export function installApiGapSink(next: ApiGapSink | null): void {
  sink = next;
}

/** Google が「API が有効になっていません」と断った。記録に失敗しても呼び出し側には伝えない。 */
export function noteApiDisabled(tenantId: string, service: string): void {
  try { sink?.disabled(tenantId, service); } catch { /* 本来の仕事を止めない */ }
}

/** Google の呼び出しが成功した（その API が足りないと覚えていれば消す）。 */
export function noteApiOk(tenantId: string, service: string): void {
  try { sink?.ok(tenantId, service); } catch { /* 本来の仕事を止めない */ }
}

/** 足りない API 1 つ。 */
export interface ApiGap {
  service: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** 覚えている足りない API を、会社ごとに覚えておく時間（ほかのプロセスが消した・足したものを読み直すまで）。 */
const CACHE_MS = 60_000;
/** 同じ API を管理者に知らせる間隔。 */
const NOTIFY_EVERY_MS = 24 * 60 * 60_000;
/** 日時を ISO の文字にする（接続の設定によって、日時は文字でも Date でも返る）。 */
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/**
 * 足りない API の置き場と受け口（PostgreSQL。移行 164）。成功のたびに書かないよう、会社ごとの足りない API を手元に覚えておく。
 */
export class PostgresApiGapStore implements ApiGapSink {
  private readonly pool: pg.Pool;
  private readonly cache = new Map<string, { at: number; services: Set<string> }>();

  constructor(connectionString: string, private readonly deps: { repo?: Repository; logger?: { warn(msg: string, meta?: Record<string, unknown>): void } } = {}) {
    this.pool = createPool(connectionString, { max: 2, name: 'google-api-gaps' });
  }

  private async q<T>(tenantId: string, sql: string, params: unknown[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await client.query(sql, params);
      await client.query('commit');
      return out.rows as T[];
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 会社の足りない API（古い順）。 */
  async list(tenantId: string): Promise<ApiGap[]> {
    const rows = await this.q<{ service: string; firstSeenAt: Date | string; lastSeenAt: Date | string }>(tenantId,
      `select service, first_seen_at as "firstSeenAt", last_seen_at as "lastSeenAt" from google_api_gaps where tenant_id = $1 order by first_seen_at`, [tenantId]);
    this.cache.set(tenantId, { at: Date.now(), services: new Set(rows.map((r) => r.service)) });
    return rows.map((r) => ({ service: r.service, firstSeenAt: iso(r.firstSeenAt), lastSeenAt: iso(r.lastSeenAt) }));
  }

  /** 管理者が「有効にした」と押した（まだ有効でなければ、次に断られたときにまた出る）。 */
  async clear(tenantId: string, service: string): Promise<void> {
    await this.q(tenantId, 'delete from google_api_gaps where tenant_id = $1 and service = $2', [tenantId, service]);
    this.cache.get(tenantId)?.services.delete(service);
  }

  disabled(tenantId: string, service: string): void {
    void this.recordDisabled(tenantId, service).catch((err: unknown) => this.deps.logger?.warn('足りない API を記録できませんでした', { tenantId, error: String(err) }));
  }

  ok(tenantId: string, service: string): void {
    void this.recordOk(tenantId, service).catch(() => undefined);
  }

  private async known(tenantId: string): Promise<Set<string>> {
    const c = this.cache.get(tenantId);
    if (c && Date.now() - c.at < CACHE_MS) return c.services;
    await this.list(tenantId);
    return this.cache.get(tenantId)!.services;
  }

  private async recordOk(tenantId: string, service: string): Promise<void> {
    if (!(await this.known(tenantId)).has(service)) return;
    await this.clear(tenantId, service);
  }

  private async recordDisabled(tenantId: string, service: string): Promise<void> {
    const rows = await this.q<{ notifiedAt: Date | string | null }>(tenantId,
      `insert into google_api_gaps (tenant_id, service) values ($1, $2)
       on conflict (tenant_id, service) do update set last_seen_at = now()
       returning notified_at as "notifiedAt"`, [tenantId, service]);
    (await this.known(tenantId)).add(service);
    const last = rows[0]?.notifiedAt ? Date.parse(iso(rows[0].notifiedAt)) : 0;
    if (!this.deps.repo || Date.now() - last < NOTIFY_EVERY_MS) return;
    await this.q(tenantId, 'update google_api_gaps set notified_at = now() where tenant_id = $1 and service = $2', [tenantId, service]);
    // 管理者に知らせる（有効にする画面は管理者ページの「状態」から開ける）
    const admins = (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin'));
    const label = googleApiLabel(service);
    for (const a of admins) {
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId, userId: a.id, kind: 'service', title: `Google Cloud で ${label} が有効になっていません`,
        body: `業務が ${label} を使おうとして、Google に断られました。管理者ページ「接続 › Google Workspace」の「状態」から、有効にする画面を開けます。`,
        runId: null, readAt: null, createdAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
  }

  /** 終わるときに呼ぶ。 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
