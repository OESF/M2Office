/**
 * @file システムログと証拠保全の置き場（仕様書 第16.10節、ADR-0098）。アプリのロールで、決まった関数を通して読み書きする。
 *
 * 読むのは本人の会社の分と、会社に属さない仕組みの分だけ（`m2o_read_system_logs`）。会社を横断して読むのは、
 * ワーカーの入れ替え・日ごとの改ざんの確かめ・証拠保全の組み立てだけ（決まった関数に閉じ込める）。
 */

import type pg from 'pg';
import { createHash } from 'node:crypto';
import { createPool } from '../repository/pool.js';

/** システムログの 1 行。 */
export interface SystemLogLine {
  id: string;
  at: string;
  level: string;
  service: string;
  msg: string;
  tenantId: string | null;
  userId: string | null;
  requestId: string | null;
  runId: string | null;
  fields: Record<string, unknown>;
}

/** システムログの絞り方。 */
export interface SystemLogFilter {
  from: string;
  to: string;
  levels?: string[] | null;
  service?: string | null;
  q?: string | null;
  requestId?: string | null;
  runId?: string | null;
  /** この行より前を読む（続きを読む）。 */
  before?: { at: string; id: string } | null;
  limit: number;
}

/** 日ごとの改ざんの確かめ。 */
export interface SystemLogDigest {
  day: string;
  rows: number;
  sha256: string;
  chain: string;
  /** いまの行から作り直した値（確かめたときだけ）。 */
  nowRows?: number;
  nowSha256?: string;
  /** 合っているか（確かめたときだけ）。 */
  intact?: boolean;
}

/** 証拠保全の 1 つ。 */
export interface EvidencePackage {
  id: string;
  scope: 'machine' | 'tenant' | 'all';
  tenantId: string | null;
  reason: string;
  createdKind: 'user' | 'operator' | 'system';
  createdBy: string;
  rangeFrom: string;
  rangeTo: string;
  status: 'pending' | 'building' | 'ready' | 'failed' | 'deleted';
  size: number | null;
  sha256: string | null;
  failure: string | null;
  createdAt: string;
  readyAt: string | null;
  deletedAt: string | null;
}

/** 証拠保全の ZIP を分けて持つ大きさ（バイト）。 */
export const EVIDENCE_CHUNK_BYTES = 8 * 1024 * 1024;
/** システムログを残す日数（第11.9.6節の 4 週）。 */
export const SYSTEM_LOG_KEEP_DAYS = 28;

const LINE_COLUMNS = `id::text as id, at, level, service, msg, tenant_id as "tenantId", user_id as "userId", request_id as "requestId", run_id as "runId", fields`;
const EVIDENCE_COLUMNS = `id, scope, tenant_id as "tenantId", reason, created_kind as "createdKind", created_by as "createdBy", range_from as "rangeFrom",
  range_to as "rangeTo", status, size::float8 as size, sha256, failure, created_at as "createdAt", ready_at as "readyAt", deleted_at as "deletedAt"`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const lineOf = (r: Record<string, unknown>): SystemLogLine => ({ ...(r as unknown as SystemLogLine), at: iso(r['at'])! });
const packageOf = (r: Record<string, unknown>): EvidencePackage => ({
  ...(r as unknown as EvidencePackage),
  rangeFrom: iso(r['rangeFrom'])!, rangeTo: iso(r['rangeTo'])!, createdAt: iso(r['createdAt'])!, readyAt: iso(r['readyAt']), deletedAt: iso(r['deletedAt']),
});

/** 前の日の鎖の値とこの日の値から、この日の鎖の値を作る（最初の日は前の値を空にする）。 */
export function chainOf(prev: string | null, sha256: string): string {
  return createHash('sha256').update(`${prev ?? ''}${sha256}`).digest('hex');
}

/**
 * システムログと証拠保全の置き場（PostgreSQL。アプリのロール）。
 *
 * @remarks テナント境界: 読むのは本人の会社の分（と会社に属さない分）だけ。会社を横断するのはワーカーの処理だけで、どれも決まった関数を通す
 */
export class PostgresSystemLogStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 3, name: 'system-logs' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** そのまま 1 つ送る（システムログを書く口に渡す）。 */
  readonly query = async (sql: string, params: unknown[]): Promise<unknown> => (await this.pool.query(sql, params as never[])).rows;

  private async q<T extends pg.QueryResultRow>(tenantId: string | null, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (tenantId) await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
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

  /** 本人の会社の分と、会社に属さない分を読む（新しい順）。 */
  async read(tenantId: string, f: SystemLogFilter): Promise<SystemLogLine[]> {
    const rows = await this.q<Record<string, unknown>>(tenantId,
      `select ${LINE_COLUMNS} from m2o_read_system_logs($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [f.from, f.to, f.levels?.length ? f.levels : null, f.service || null, f.q || null, f.requestId || null, f.runId || null,
        f.before?.at ?? null, f.before ? Number(f.before.id) : null, f.limit]);
    return rows.map(lineOf);
  }

  /** 区切りを作る（今日から 2 日先まで）。 */
  async prepare(): Promise<void> {
    await this.pool.query('select m2o_system_logs_prepare()');
  }

  /** 残す日数を過ぎた区切りを捨てる。捨てた日の数。 */
  async rotate(keepDays = SYSTEM_LOG_KEEP_DAYS): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>('select m2o_system_logs_rotate($1) as n', [keepDays]);
    return rows[0]?.n ?? 0;
  }

  /** まだ値を残していない日（昨日まで）に、日ごとの値を残す。残した日の数。 */
  async sealDays(today: string): Promise<number> {
    const { rows: last } = await this.pool.query<{ day: string; chain: string }>(`select to_char(day, 'YYYY-MM-DD') as day, chain from system_log_digests order by day desc limit 1`);
    const { rows: first } = await this.pool.query<{ day: string | null }>(`select to_char(m2o_system_logs_first_day(), 'YYYY-MM-DD') as day`);
    let day = last[0] ? nextDay(last[0].day) : first[0]?.day ?? null;
    let prev = last[0]?.chain ?? null;
    let n = 0;
    while (day && day < today) {
      const { rows } = await this.pool.query<{ rows: number; sha256: string }>('select rows, sha256 from m2o_system_log_day_digest($1::date)', [day]);
      const d = rows[0] ?? { rows: 0, sha256: createHash('sha256').update('').digest('hex') };
      const chain = chainOf(prev, d.sha256);
      await this.pool.query('insert into system_log_digests (day, rows, sha256, chain) values ($1, $2, $3, $4) on conflict (day) do nothing', [day, d.rows, d.sha256, chain]);
      prev = chain;
      day = nextDay(day);
      n++;
    }
    return n;
  }

  /** 日ごとの値（`verify` なら、いまの行から作り直して比べる。7 日まで）。 */
  async digests(fromDay: string, toDay: string, verify: boolean): Promise<SystemLogDigest[]> {
    const { rows } = await this.pool.query<{ day: string; rows: number; sha256: string; chain: string }>(
      `select to_char(day, 'YYYY-MM-DD') as day, rows, sha256, chain from system_log_digests where day >= $1::date and day <= $2::date order by day`, [fromDay, toDay]);
    if (!verify) return rows;
    const out: SystemLogDigest[] = [];
    for (const d of rows.slice(-7)) {
      const { rows: now } = await this.pool.query<{ rows: number; sha256: string }>('select rows, sha256 from m2o_system_log_day_digest($1::date)', [d.day]);
      out.push({ ...d, nowRows: now[0]?.rows ?? 0, nowSha256: now[0]?.sha256 ?? '', intact: now[0]?.sha256 === d.sha256 });
    }
    return out;
  }

  /** 証拠保全を頼む（会社の管理者・自動）。 */
  async requestEvidence(tenantId: string, p: { id: string; scope: 'machine' | 'tenant'; reason: string; createdKind: 'user' | 'system'; createdBy: string; from: string; to: string }): Promise<void> {
    await this.q(tenantId,
      `insert into evidence_packages (id, scope, tenant_id, reason, created_kind, created_by, range_from, range_to) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.id, p.scope, tenantId, p.reason, p.createdKind, p.createdBy, p.from, p.to]);
  }

  /** 本人の会社の証拠保全（新しい順）。 */
  async listEvidence(tenantId: string): Promise<EvidencePackage[]> {
    const rows = await this.q<Record<string, unknown>>(tenantId, `select ${EVIDENCE_COLUMNS} from evidence_packages order by created_at desc limit 200`);
    return rows.map(packageOf);
  }

  /** 本人の会社の証拠保全の 1 つ。 */
  async getEvidence(tenantId: string, id: string): Promise<EvidencePackage | null> {
    const rows = await this.q<Record<string, unknown>>(tenantId, `select ${EVIDENCE_COLUMNS} from evidence_packages where id = $1`, [id]);
    return rows[0] ? packageOf(rows[0]) : null;
  }

  /** 本人の会社の、できあがった ZIP の 1 切れ（無ければ `null`）。 */
  async evidenceChunk(tenantId: string, id: string, seq: number): Promise<Uint8Array | null> {
    const rows = await this.q<{ b: Buffer | null }>(tenantId, 'select m2o_evidence_chunk($1, $2) as b', [id, seq]);
    return rows[0]?.b ? new Uint8Array(rows[0].b) : null;
  }

  /** 1 年を過ぎた本人の会社の保全を消す（消せなければ `false`）。 */
  async deleteEvidence(tenantId: string, id: string, by: string, reason: string): Promise<boolean> {
    const rows = await this.q<{ ok: boolean }>(tenantId, 'select m2o_evidence_delete($1, $2, $3) as ok', [id, by, reason]);
    return rows[0]?.ok === true;
  }

  /** ワーカー: 待っている保全を 1 つ取る。 */
  async claimEvidence(): Promise<EvidencePackage | null> {
    const { rows } = await this.pool.query<Record<string, unknown>>(`select ${EVIDENCE_COLUMNS} from m2o_claim_evidence()`);
    return rows[0] ? packageOf(rows[0]) : null;
  }

  /** ワーカー: 保全に入れるシステムログを、古い順に続きから読む。 */
  async evidenceLogs(p: { tenantId: string | null; all: boolean; from: string; to: string; after: { at: string; id: string } | null; limit: number }): Promise<SystemLogLine[]> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `select ${LINE_COLUMNS} from m2o_evidence_logs($1, $2, $3, $4, $5, $6, $7)`,
      [p.tenantId, p.all, p.from, p.to, p.after?.at ?? null, p.after ? Number(p.after.id) : null, p.limit]);
    return rows.map(lineOf);
  }

  /** ワーカー: ZIP を分けて書き、できあがりの印を付ける。 */
  async putEvidence(id: string, zip: Uint8Array, sha256: string, manifest: unknown): Promise<void> {
    for (let seq = 0, at = 0; at < zip.length; seq++, at += EVIDENCE_CHUNK_BYTES) {
      await this.pool.query('select m2o_evidence_put_chunk($1, $2, $3)', [id, seq, Buffer.from(zip.subarray(at, at + EVIDENCE_CHUNK_BYTES))]);
    }
    await this.pool.query('select m2o_evidence_finish($1, true, $2, $3, $4, null)', [id, zip.length, sha256, JSON.stringify(manifest)]);
  }

  /** ワーカー: 作れなかった印を付ける。 */
  async failEvidence(id: string, reason: string): Promise<void> {
    await this.pool.query('select m2o_evidence_finish($1, false, null, null, null, $2)', [id, reason.slice(0, 300)]);
  }
}

/** 次の日（`YYYY-MM-DD`）。 */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
