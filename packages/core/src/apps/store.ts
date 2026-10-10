/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）の置き場。アプリ・呼び出しの数・書き込みの通知の番号を持つ。
 *
 * 鍵はハッシュだけを持つ。通知の本文は持たず、二重に数えないための番号と中身のハッシュと返した答えだけを持つ。
 * PostgreSQL の置き場は、問い合わせごとに `app.tenant_id` を設定する（行単位の制限。移行 119）。
 */

import type pg from 'pg';
import type { AppFunctionId, AppSettings } from '@m2office/shared';
import { createPool } from '../repository/pool.js';

/** アプリの記録（鍵のハッシュを含む）。 */
export interface AppRecord {
  id: string;
  name: string;
  keyHash: string;
  status: 'active' | 'stopped';
  functions: AppFunctionId[];
  settings: AppSettings;
  /** 「商品の一覧」の範囲から外した品目と時刻。 */
  catalogRemoved: { itemId: string; at: string }[];
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 書き込みの通知の記録。 */
export interface AppEventRecord {
  bodyHash: string;
  response: unknown;
  createdAt: string;
}

/** アプリの置き場。 */
export interface AppStore {
  listApps(tenantId: string): Promise<AppRecord[]>;
  getApp(tenantId: string, id: string): Promise<AppRecord | null>;
  createApp(tenantId: string, app: AppRecord): Promise<void>;
  updateApp(tenantId: string, id: string, patch: Partial<Omit<AppRecord, 'id' | 'createdBy' | 'createdAt'>>): Promise<void>;
  deleteApp(tenantId: string, id: string): Promise<void>;
  /** 会社の判定より前に、鍵のハッシュから会社とアプリを 1 行だけ引く。 */
  findAppByHash(keyHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped'; functions: AppFunctionId[]; name: string } | null>;
  /** 呼び出しを 1 つ数え、最後に呼ばれた時刻を直す。 */
  recordCall(tenantId: string, appId: string, day: string, at: string): Promise<void>;
  /** アプリごとの、その日から後の呼び出しの数。 */
  countCalls(tenantId: string, sinceDay: string): Promise<Map<string, number>>;
  getEvent(tenantId: string, appId: string, kind: string, eventRef: string): Promise<AppEventRecord | null>;
  /** 通知を記録し始める。すでにあれば `false`。 */
  claimEvent(tenantId: string, appId: string, kind: string, eventRef: string, bodyHash: string, at: string): Promise<boolean>;
  /** 処理の途中のまま古くなった通知を、やり直すために取り直す。取り直せたら `true`。 */
  reclaimEvent(tenantId: string, appId: string, kind: string, eventRef: string, staleBefore: string, at: string): Promise<boolean>;
  finishEvent(tenantId: string, appId: string, kind: string, eventRef: string, response: unknown): Promise<void>;
}

interface AppRow {
  id: string; name: string; key_hash: string; status: 'active' | 'stopped'; functions: AppFunctionId[] | null; settings: AppSettings | null;
  catalog_removed: { itemId: string; at: string }[] | null; approved_by: string | null; approved_at: unknown; created_by: string; created_at: unknown; last_used_at: unknown;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toApp = (r: AppRow): AppRecord => ({
  id: r.id, name: r.name, keyHash: r.key_hash, status: r.status, functions: r.functions ?? [], settings: r.settings ?? {}, catalogRemoved: r.catalog_removed ?? [],
  approvedBy: r.approved_by, approvedAt: isoOrNull(r.approved_at), createdBy: r.created_by, createdAt: iso(r.created_at), lastUsedAt: isoOrNull(r.last_used_at),
});

/** PostgreSQL のアプリの置き場。 */
export class PostgresAppStore implements AppStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 3, name: 'apps' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const { rows } = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listApps(tenantId: string): Promise<AppRecord[]> {
    return (await this.q<AppRow>(tenantId, 'select * from ext_apps where tenant_id = $1 order by created_at', [tenantId])).map(toApp);
  }

  async getApp(tenantId: string, id: string): Promise<AppRecord | null> {
    const [r] = await this.q<AppRow>(tenantId, 'select * from ext_apps where tenant_id = $1 and id = $2', [tenantId, id]);
    return r ? toApp(r) : null;
  }

  async createApp(tenantId: string, a: AppRecord): Promise<void> {
    await this.q(tenantId,
      `insert into ext_apps (id, tenant_id, name, key_hash, status, functions, settings, catalog_removed, approved_by, approved_at, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [a.id, tenantId, a.name, a.keyHash, a.status, a.functions, JSON.stringify(a.settings), JSON.stringify(a.catalogRemoved), a.approvedBy, a.approvedAt, a.createdBy, a.createdAt]);
  }

  async updateApp(tenantId: string, id: string, patch: Partial<Omit<AppRecord, 'id' | 'createdBy' | 'createdAt'>>): Promise<void> {
    const cols: Record<string, string> = {
      name: 'name', keyHash: 'key_hash', status: 'status', functions: 'functions', settings: 'settings', catalogRemoved: 'catalog_removed',
      approvedBy: 'approved_by', approvedAt: 'approved_at', lastUsedAt: 'last_used_at',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      params.push(k === 'settings' || k === 'catalogRemoved' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.q(tenantId, `update ext_apps set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async deleteApp(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from ext_apps where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  async findAppByHash(keyHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped'; functions: AppFunctionId[]; name: string } | null> {
    // 会社の判定より前に呼ぶ。鍵のハッシュで 1 行だけ返す関数を使う（移行 119）
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ id: string; tenant_id: string; status: 'active' | 'stopped'; functions: AppFunctionId[] | null; name: string }>(
        'select id, tenant_id, status, functions, name from m2o_ext_app($1)', [keyHash]);
      const r = rows[0];
      return r ? { id: r.id, tenantId: r.tenant_id, status: r.status, functions: r.functions ?? [], name: r.name } : null;
    } finally {
      client.release();
    }
  }

  async recordCall(tenantId: string, appId: string, day: string, at: string): Promise<void> {
    await this.q(tenantId,
      `with u as (insert into ext_app_usage (tenant_id, app_id, day, calls) values ($1,$2,$3,1)
         on conflict (tenant_id, app_id, day) do update set calls = ext_app_usage.calls + 1 returning 1)
       update ext_apps set last_used_at = $4 where tenant_id = $1 and id = $2`, [tenantId, appId, day, at]);
  }

  async countCalls(tenantId: string, sinceDay: string): Promise<Map<string, number>> {
    const rows = await this.q<{ app_id: string; n: string }>(tenantId,
      'select app_id, sum(calls) as n from ext_app_usage where tenant_id = $1 and day >= $2 group by app_id', [tenantId, sinceDay]);
    return new Map(rows.map((r) => [r.app_id, Number(r.n)]));
  }

  async getEvent(tenantId: string, appId: string, kind: string, eventRef: string): Promise<AppEventRecord | null> {
    const [r] = await this.q<{ body_hash: string; response: unknown; created_at: unknown }>(tenantId,
      'select body_hash, response, created_at from ext_app_events where tenant_id = $1 and app_id = $2 and kind = $3 and event_ref = $4', [tenantId, appId, kind, eventRef]);
    return r ? { bodyHash: r.body_hash, response: r.response, createdAt: iso(r.created_at) } : null;
  }

  async claimEvent(tenantId: string, appId: string, kind: string, eventRef: string, bodyHash: string, at: string): Promise<boolean> {
    const rows = await this.q(tenantId,
      `insert into ext_app_events (tenant_id, app_id, kind, event_ref, body_hash, created_at) values ($1,$2,$3,$4,$5,$6)
       on conflict do nothing returning event_ref`, [tenantId, appId, kind, eventRef, bodyHash, at]);
    return rows.length === 1;
  }

  async reclaimEvent(tenantId: string, appId: string, kind: string, eventRef: string, staleBefore: string, at: string): Promise<boolean> {
    const rows = await this.q(tenantId,
      `update ext_app_events set created_at = $6 where tenant_id = $1 and app_id = $2 and kind = $3 and event_ref = $4 and response is null and created_at < $5
       returning event_ref`, [tenantId, appId, kind, eventRef, staleBefore, at]);
    return rows.length === 1;
  }

  async finishEvent(tenantId: string, appId: string, kind: string, eventRef: string, response: unknown): Promise<void> {
    await this.q(tenantId, 'update ext_app_events set response = $5 where tenant_id = $1 and app_id = $2 and kind = $3 and event_ref = $4',
      [tenantId, appId, kind, eventRef, JSON.stringify(response)]);
  }
}

/** メモリのアプリの置き場（試験用）。 */
export class MemoryAppStore implements AppStore {
  readonly apps = new Map<string, AppRecord & { tenantId: string }>();
  readonly usage = new Map<string, number>();
  readonly events = new Map<string, AppEventRecord>();

  async listApps(tenantId: string): Promise<AppRecord[]> {
    return [...this.apps.values()].filter((a) => a.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ tenantId: _t, ...a }) => structuredClone(a));
  }

  async getApp(tenantId: string, id: string): Promise<AppRecord | null> {
    const a = this.apps.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = a;
    return structuredClone(rest);
  }

  async createApp(tenantId: string, app: AppRecord): Promise<void> {
    this.apps.set(app.id, { ...structuredClone(app), tenantId });
  }

  async updateApp(tenantId: string, id: string, patch: Partial<Omit<AppRecord, 'id' | 'createdBy' | 'createdAt'>>): Promise<void> {
    const a = this.apps.get(id);
    if (!a || a.tenantId !== tenantId) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (a as unknown as Record<string, unknown>)[k] = structuredClone(v);
  }

  async deleteApp(tenantId: string, id: string): Promise<void> {
    if (this.apps.get(id)?.tenantId === tenantId) this.apps.delete(id);
  }

  async findAppByHash(keyHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped'; functions: AppFunctionId[]; name: string } | null> {
    const a = [...this.apps.values()].find((x) => x.keyHash === keyHash);
    return a ? { id: a.id, tenantId: a.tenantId, status: a.status, functions: [...a.functions], name: a.name } : null;
  }

  async recordCall(tenantId: string, appId: string, day: string, at: string): Promise<void> {
    const k = `${tenantId}\u0000${appId}\u0000${day}`;
    this.usage.set(k, (this.usage.get(k) ?? 0) + 1);
    const a = this.apps.get(appId);
    if (a && a.tenantId === tenantId) a.lastUsedAt = at;
  }

  async countCalls(tenantId: string, sinceDay: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const [k, n] of this.usage) {
      const [t, app, day] = k.split('\u0000') as [string, string, string];
      if (t === tenantId && day >= sinceDay) out.set(app, (out.get(app) ?? 0) + n);
    }
    return out;
  }

  private key = (tenantId: string, appId: string, kind: string, ref: string) => [tenantId, appId, kind, ref].join('\u0000');

  async getEvent(tenantId: string, appId: string, kind: string, eventRef: string): Promise<AppEventRecord | null> {
    const e = this.events.get(this.key(tenantId, appId, kind, eventRef));
    return e ? { ...e } : null;
  }

  async claimEvent(tenantId: string, appId: string, kind: string, eventRef: string, bodyHash: string, at: string): Promise<boolean> {
    const k = this.key(tenantId, appId, kind, eventRef);
    if (this.events.has(k)) return false;
    this.events.set(k, { bodyHash, response: null, createdAt: at });
    return true;
  }

  async reclaimEvent(tenantId: string, appId: string, kind: string, eventRef: string, staleBefore: string, at: string): Promise<boolean> {
    const e = this.events.get(this.key(tenantId, appId, kind, eventRef));
    if (!e || e.response !== null || e.createdAt >= staleBefore) return false;
    e.createdAt = at;
    return true;
  }

  async finishEvent(tenantId: string, appId: string, kind: string, eventRef: string, response: unknown): Promise<void> {
    const e = this.events.get(this.key(tenantId, appId, kind, eventRef));
    if (e) e.response = structuredClone(response);
  }
}
