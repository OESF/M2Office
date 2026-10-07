/**
 * @file 契約の管理の置き場（仕様書 第38.12節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * 台帳だけを持つ。契約書のファイルは会社のドライブに置き、ここにはファイルの ID だけを持つ（第38.7節）。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { Contract, ContractKind, ContractStatus, ContractUnknownField } from '@m2office/shared';

/** 置き場に持つ 1 件（担当の名前は持たない。見せるときに引く）。 */
export type StoredContract = Omit<Contract, 'ownerName'> & {
  /** 知らせた期限（`notice:60`・`end:30` のように。期間が進んだら空にする） */
  notified: string[];
};

/** 新しく入れる 1 件。 */
export type NewContract = Omit<StoredContract, 'id' | 'createdAt' | 'updatedAt' | 'renewedCount' | 'notified'> & { renewedCount?: number };

/** 直せる項目。 */
export type ContractPatch = Partial<Pick<StoredContract,
  'party' | 'kind' | 'title' | 'signedOn' | 'startOn' | 'endOn' | 'autoRenew' | 'renewMonths' | 'noticeRule' | 'noticeDays' | 'noticeDeadline'
  | 'status' | 'ownerId' | 'driveFileId' | 'driveFileName' | 'note' | 'unknown' | 'renewedCount' | 'notified' | 'previousId'>>;

/** 一覧の絞り込み。 */
export interface ContractQuery {
  status?: ContractStatus | 'all';
  kind?: ContractKind;
  ownerId?: string;
  /** 相手・件名・メモの一部 */
  search?: string;
  limit?: number;
}

/** 契約の管理の置き場。 */
export interface ContractStore {
  list(tenantId: string, q?: ContractQuery): Promise<StoredContract[]>;
  get(tenantId: string, id: string): Promise<StoredContract | null>;
  create(tenantId: string, c: NewContract): Promise<string>;
  update(tenantId: string, id: string, patch: ContractPatch, by: string): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
  /** 同じ契約（相手・種類・締結日が同じ）を探す。 */
  findSame(tenantId: string, party: string, kind: ContractKind, signedOn: string | null): Promise<StoredContract | null>;
}

/** 期限の近い順の鍵（申し出の期限か終わりの日の早いほう。どちらも無ければ最後）。 */
export function nextDue(c: Pick<StoredContract, 'noticeDeadline' | 'endOn' | 'status' | 'autoRenew'>): string | null {
  if (c.status === 'ended') return null;
  const dates = [c.status === 'active' && c.autoRenew ? c.noticeDeadline : null, c.endOn].filter((x): x is string => !!x);
  return dates.sort()[0] ?? null;
}

const byDue = (a: StoredContract, b: StoredContract) =>
  (nextDue(a) ?? '9999').localeCompare(nextDue(b) ?? '9999') || b.createdAt.localeCompare(a.createdAt);

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

interface Row {
  id: string; party: string; kind: ContractKind; title: string; signed_on: unknown; start_on: unknown; end_on: unknown; auto_renew: boolean;
  renew_months: number | null; notice_rule: string; notice_days: number | null; notice_deadline: unknown; status: ContractStatus; owner_id: string;
  drive_file_id: string | null; drive_file_name: string; review_run_id: string | null; previous_id: string | null; note: string;
  unknown: ContractUnknownField[] | null; renewed_count: number; notified: string[] | null; created_by: string; created_at: unknown; updated_at: unknown;
}

const toContract = (r: Row): StoredContract => ({
  id: r.id, party: r.party, kind: r.kind, title: r.title, signedOn: day(r.signed_on), startOn: day(r.start_on), endOn: day(r.end_on),
  autoRenew: r.auto_renew, renewMonths: r.renew_months, noticeRule: r.notice_rule, noticeDays: r.notice_days, noticeDeadline: day(r.notice_deadline),
  status: r.status, ownerId: r.owner_id, driveFileId: r.drive_file_id, driveFileName: r.drive_file_name, reviewRunId: r.review_run_id,
  previousId: r.previous_id, note: r.note, unknown: r.unknown ?? [], renewedCount: r.renewed_count, notified: r.notified ?? [],
  createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

/** 直せる項目と列の対応（利用者の入力を列名に使わない）。 */
const COLUMNS: Record<keyof ContractPatch, string> = {
  party: 'party', kind: 'kind', title: 'title', signedOn: 'signed_on', startOn: 'start_on', endOn: 'end_on', autoRenew: 'auto_renew',
  renewMonths: 'renew_months', noticeRule: 'notice_rule', noticeDays: 'notice_days', noticeDeadline: 'notice_deadline', status: 'status',
  ownerId: 'owner_id', driveFileId: 'drive_file_id', driveFileName: 'drive_file_name', note: 'note', unknown: 'unknown',
  renewedCount: 'renewed_count', notified: 'notified', previousId: 'previous_id',
};

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresContractStore implements ContractStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 4, name: 'contracts' });
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

  async list(tenantId: string, q: ContractQuery = {}): Promise<StoredContract[]> {
    const where = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q.status && q.status !== 'all') { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.kind) { params.push(q.kind); where.push(`kind = $${params.length}`); }
    if (q.ownerId) { params.push(q.ownerId); where.push(`owner_id = $${params.length}`); }
    if (q.search?.trim()) {
      // 検索の言葉は値として渡す（SQL に埋め込まない）。% と _ は文字として扱う
      params.push(`%${q.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const p = `$${params.length}`;
      where.push(`(party ilike ${p} or title ilike ${p} or note ilike ${p})`);
    }
    params.push(Math.min(Math.max(q.limit ?? 500, 1), 1000));
    const rows = await this.q<Row>(tenantId, `select * from contracts where ${where.join(' and ')} order by created_at desc limit $${params.length}`, params);
    return rows.map(toContract).sort(byDue);
  }

  async get(tenantId: string, id: string): Promise<StoredContract | null> {
    const rows = await this.q<Row>(tenantId, `select * from contracts where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toContract(rows[0]) : null;
  }

  async create(tenantId: string, c: NewContract): Promise<string> {
    const id = `ctr-${randomUUID()}`;
    await this.q(tenantId,
      `insert into contracts (id, tenant_id, party, kind, title, signed_on, start_on, end_on, auto_renew, renew_months, notice_rule, notice_days, notice_deadline,
         status, owner_id, drive_file_id, drive_file_name, review_run_id, previous_id, note, unknown, renewed_count, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23)`,
      [id, tenantId, c.party, c.kind, c.title, c.signedOn, c.startOn, c.endOn, c.autoRenew, c.renewMonths, c.noticeRule, c.noticeDays, c.noticeDeadline,
        c.status, c.ownerId, c.driveFileId, c.driveFileName, c.reviewRunId, c.previousId, c.note, c.unknown, c.renewedCount ?? 0, c.createdBy]);
    return id;
  }

  async update(tenantId: string, id: string, patch: ContractPatch, by: string): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch) as [keyof ContractPatch, unknown][]) {
      if (v === undefined || !COLUMNS[k]) continue;
      params.push(v);
      sets.push(`${COLUMNS[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    params.push(by);
    await this.q(tenantId, `update contracts set ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from contracts where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async findSame(tenantId: string, party: string, kind: ContractKind, signedOn: string | null): Promise<StoredContract | null> {
    if (!party || !signedOn) return null;
    const rows = await this.q<Row>(tenantId,
      `select * from contracts where tenant_id = $1 and party = $2 and kind = $3 and signed_on = $4 order by created_at limit 1`, [tenantId, party, kind, signedOn]);
    return rows[0] ? toContract(rows[0]) : null;
  }
}

/** テスト用のメモリの置き場。 */
export class MemoryContractStore implements ContractStore {
  readonly rows = new Map<string, StoredContract & { tenantId: string }>();

  async list(tenantId: string, q: ContractQuery = {}): Promise<StoredContract[]> {
    const w = q.search?.trim().toLowerCase() ?? '';
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId)
      .filter((r) => !q.status || q.status === 'all' || r.status === q.status)
      .filter((r) => !q.kind || r.kind === q.kind)
      .filter((r) => !q.ownerId || r.ownerId === q.ownerId)
      .filter((r) => !w || [r.party, r.title, r.note].some((x) => x.toLowerCase().includes(w)))
      .map(({ tenantId: _t, ...c }) => ({ ...c }))
      .sort(byDue)
      .slice(0, q.limit ?? 500);
  }

  async get(tenantId: string, id: string): Promise<StoredContract | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const { tenantId: _t, ...c } = r;
    return { ...c };
  }

  async create(tenantId: string, c: NewContract): Promise<string> {
    const id = `ctr-${randomUUID()}`;
    const at = new Date(Date.now() + this.rows.size).toISOString();
    this.rows.set(id, { ...c, id, tenantId, renewedCount: c.renewedCount ?? 0, notified: [], createdAt: at, updatedAt: at });
    return id;
  }

  async update(tenantId: string, id: string, patch: ContractPatch): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as Record<string, unknown>)[k] = v;
    r.updatedAt = new Date().toISOString();
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r && r.tenantId === tenantId) this.rows.delete(id);
  }

  async findSame(tenantId: string, party: string, kind: ContractKind, signedOn: string | null): Promise<StoredContract | null> {
    if (!party || !signedOn) return null;
    const hit = [...this.rows.values()].find((r) => r.tenantId === tenantId && r.party === party && r.kind === kind && r.signedOn === signedOn);
    return hit ? this.get(tenantId, hit.id) : null;
  }
}
