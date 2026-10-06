/**
 * @file 補助金・助成金の候補の置き場（仕様書 第39.13節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * 同じ制度は見分けの鍵（`key`）で 1 件にする。中身の印（`digest`）が変わったら出し直す。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Subsidy, SubsidyFit, SubsidyKind, SubsidyStatus } from '@m2office/shared';

/** 置き場に持つ 1 件。 */
export type StoredSubsidy = Subsidy & {
  /** 見分けの鍵（jGrants の ID か、出典の URL か、名前から作る） */
  key: string;
  /** 中身の印（締め切り・上限額・補助率・名前。変わったら出し直す） */
  digest: string;
  /** 知らせた締め切り（`deadline:14` のように） */
  notified: string[];
};

/** 新しく入れる・中身を置き換える 1 件。 */
export type SubsidyDraft = Pick<StoredSubsidy,
  'key' | 'name' | 'provider' | 'kind' | 'fit' | 'reason' | 'conditions' | 'amount' | 'rate' | 'startOn' | 'deadline' | 'sourceTitle' | 'sourceUrl' | 'origin' | 'digest'>;

/** 候補の置き場。 */
export interface SubsidyStore {
  list(tenantId: string): Promise<StoredSubsidy[]>;
  get(tenantId: string, id: string): Promise<StoredSubsidy | null>;
  getByKey(tenantId: string, key: string): Promise<StoredSubsidy | null>;
  create(tenantId: string, d: SubsidyDraft): Promise<string>;
  /** 中身を置き換える（状態は `status` を渡したときだけ変える）。 */
  replace(tenantId: string, id: string, d: SubsidyDraft, status?: SubsidyStatus): Promise<void>;
  setStatus(tenantId: string, id: string, status: SubsidyStatus, by: string | null): Promise<void>;
  setNotified(tenantId: string, id: string, notified: string[]): Promise<void>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

interface Row {
  id: string; key: string; name: string; provider: string; kind: SubsidyKind; fit: SubsidyFit; reason: string; conditions: string;
  amount: string; rate: string; start_on: unknown; deadline: unknown; source_title: string; source_url: string; origin: 'jgrants' | 'web';
  status: SubsidyStatus; status_by: string | null; digest: string; notified: string[] | null; found_at: unknown; updated_at: unknown;
}

const toSubsidy = (r: Row): StoredSubsidy => ({
  id: r.id, key: r.key, name: r.name, provider: r.provider, kind: r.kind, fit: r.fit, reason: r.reason, conditions: r.conditions,
  amount: r.amount, rate: r.rate, startOn: day(r.start_on), deadline: day(r.deadline), sourceTitle: r.source_title, sourceUrl: r.source_url,
  origin: r.origin, status: r.status, statusBy: r.status_by, digest: r.digest, notified: r.notified ?? [], foundAt: iso(r.found_at), updatedAt: iso(r.updated_at),
});

/** 締め切りの近い順（締め切りの無いものは後ろ）。 */
const byDeadline = (a: StoredSubsidy, b: StoredSubsidy) =>
  (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') || b.foundAt.localeCompare(a.foundAt);

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresSubsidyStore implements SubsidyStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query<T>(text, params);
      await c.query('commit');
      return r.rows;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async list(tenantId: string): Promise<StoredSubsidy[]> {
    return (await this.q<Row>(tenantId, `select * from subsidy_candidates where tenant_id = $1 order by found_at desc limit 500`, [tenantId])).map(toSubsidy).sort(byDeadline);
  }

  async get(tenantId: string, id: string): Promise<StoredSubsidy | null> {
    const rows = await this.q<Row>(tenantId, `select * from subsidy_candidates where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toSubsidy(rows[0]) : null;
  }

  async getByKey(tenantId: string, key: string): Promise<StoredSubsidy | null> {
    const rows = await this.q<Row>(tenantId, `select * from subsidy_candidates where tenant_id = $1 and key = $2`, [tenantId, key]);
    return rows[0] ? toSubsidy(rows[0]) : null;
  }

  async create(tenantId: string, d: SubsidyDraft): Promise<string> {
    const id = `sbs-${randomUUID()}`;
    await this.q(tenantId,
      `insert into subsidy_candidates (id, tenant_id, key, name, provider, kind, fit, reason, conditions, amount, rate, start_on, deadline, source_title, source_url, origin, digest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [id, tenantId, d.key, d.name, d.provider, d.kind, d.fit, d.reason, d.conditions, d.amount, d.rate, d.startOn, d.deadline, d.sourceTitle, d.sourceUrl, d.origin, d.digest]);
    return id;
  }

  async replace(tenantId: string, id: string, d: SubsidyDraft, status?: SubsidyStatus): Promise<void> {
    await this.q(tenantId,
      `update subsidy_candidates set name = $3, provider = $4, kind = $5, fit = $6, reason = $7, conditions = $8, amount = $9, rate = $10, start_on = $11,
         deadline = $12, source_title = $13, source_url = $14, origin = $15, digest = $16, status = coalesce($17, status), notified = '{}', updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, id, d.name, d.provider, d.kind, d.fit, d.reason, d.conditions, d.amount, d.rate, d.startOn, d.deadline, d.sourceTitle, d.sourceUrl, d.origin, d.digest, status ?? null]);
  }

  async setStatus(tenantId: string, id: string, status: SubsidyStatus, by: string | null): Promise<void> {
    await this.q(tenantId, `update subsidy_candidates set status = $3, status_by = $4, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, status, by]);
  }

  async setNotified(tenantId: string, id: string, notified: string[]): Promise<void> {
    await this.q(tenantId, `update subsidy_candidates set notified = $3 where tenant_id = $1 and id = $2`, [tenantId, id, notified]);
  }
}

/** テスト用のメモリの置き場。 */
export class MemorySubsidyStore implements SubsidyStore {
  readonly rows = new Map<string, StoredSubsidy & { tenantId: string }>();

  private strip(r: StoredSubsidy & { tenantId: string }): StoredSubsidy {
    const { tenantId: _t, ...rest } = r;
    return { ...rest, notified: [...rest.notified] };
  }

  async list(tenantId: string): Promise<StoredSubsidy[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).map((r) => this.strip(r)).sort(byDeadline);
  }

  async get(tenantId: string, id: string): Promise<StoredSubsidy | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? this.strip(r) : null;
  }

  async getByKey(tenantId: string, key: string): Promise<StoredSubsidy | null> {
    const r = [...this.rows.values()].find((x) => x.tenantId === tenantId && x.key === key);
    return r ? this.strip(r) : null;
  }

  async create(tenantId: string, d: SubsidyDraft): Promise<string> {
    const id = `sbs-${randomUUID()}`;
    const at = new Date(Date.now() + this.rows.size).toISOString();
    this.rows.set(id, { ...d, id, tenantId, status: 'new', statusBy: null, notified: [], foundAt: at, updatedAt: at });
    return id;
  }

  async replace(tenantId: string, id: string, d: SubsidyDraft, status?: SubsidyStatus): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    this.rows.set(id, { ...r, ...d, status: status ?? r.status, notified: [], updatedAt: new Date().toISOString() });
  }

  async setStatus(tenantId: string, id: string, status: SubsidyStatus, by: string | null): Promise<void> {
    const r = this.rows.get(id);
    if (r && r.tenantId === tenantId) this.rows.set(id, { ...r, status, statusBy: by, updatedAt: new Date().toISOString() });
  }

  async setNotified(tenantId: string, id: string, notified: string[]): Promise<void> {
    const r = this.rows.get(id);
    if (r && r.tenantId === tenantId) this.rows.set(id, { ...r, notified: [...notified] });
  }
}
