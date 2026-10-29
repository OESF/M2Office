/**
 * @file マスター管理画面（仕様書 第23.8.15節）のデータベースの口。運営の専用のロール `m2office_ops` で接続する。
 *
 * このロールは `ops` スキーマの表（運営者・運営のログイン状態・運営の操作の記録・機械）だけを触り、顧客の表には届かない（移行 111）。
 * 会社の数・会社を作る・状態を変えるは、所有者の権限で動く決めた関数（`ops.tenant_overview` など）だけを呼ぶ。
 */

import type { EvidencePackage, SystemLogDigest, SystemLogFilter, SystemLogLine } from '../log/store.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { RuntimeBeat, RuntimeEnvironment, RuntimeSampleDays, RuntimeSamplePoint, TaxRateEntry } from '@m2office/shared';
import { beatFromRow, databaseFromRow, DATABASE_USAGE_SQL, samplePointFromRow } from '../machine/runtime.js';
import type { MachineReport, NewTenantInput, OperatorRole } from './rules.js';
import type { IncidentImpact, ServiceIncident } from './incidents.js';

/** 運営者。 */
export interface Operator {
  id: string;
  email: string;
  displayName: string;
  role: OperatorRole;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
  /** 登録したパスキーの数（第23.8.15節「運営者のパスキー」）。 */
  passkeyCount?: number;
}

/** 運営のログイン状態。 */
export interface OpsSession {
  id: string;
  operatorId: string;
  csrfToken: string;
  expiresAt: string;
  /** パスキーで確かめたか（確かめるまでは本人とパスキーの操作しかできない）。 */
  verified: boolean;
}

/** 運営者のパスキー（公開鍵は秘密の値ではない）。 */
export interface OpsPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** 1 人が登録できるパスキーの数。 */
export const OPS_PASSKEY_MAX = 5;
/** 登録の合言葉の有効な時間（24 時間）。 */
export const OPS_ENROLL_CODE_HOURS = 24;

/** 会社ごとの数（件数・金額・状態だけ）。 */
export interface TenantOverview {
  id: string;
  subdomain: string;
  name: string;
  workspaceDomain: string | null;
  status: 'trial' | 'active' | 'suspended' | 'locked' | 'cancelled';
  createdAt: string;
  usersActive: number;
  usersInvited: number;
  users30d: number;
  lastUsedAt: string | null;
  runsToday: number;
  runs30d: number;
  runsFailed30d: number;
  conversations30d: number;
  aiCostMonth: number;
  filesBytes: number;
  extensions: number;
  googleConnections: number;
  /** この 24 時間の不正の兆しの数と、そのうち重いもの（第16.8節・第23.8.3節。中身と人は返さない）。 */
  securitySignals24h: number;
  securityHigh24h: number;
}

/** 体験（第23.3.2節）。相手の情報と数だけ。体験用の会社の中身は持たない。 */
export interface OpsDemo {
  id: string;
  loginId: string;
  tenantId: string;
  company: string;
  contact: string;
  email: string;
  aiCapJpy: number;
  aiUsedJpy: number;
  filesBytes: number;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  deletedAt: string | null;
  contactPurgedAt: string | null;
  termsAcceptedAt: string | null;
  loginCount: number;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  /** 使える・期限切れ（消す前）・終えた（消した）。 */
  state: 'active' | 'expired' | 'ended';
  /** 出し方（運営が出した・自分で申し込み）。 */
  origin: 'ops' | 'self';
}

/** 体験版の既定と、自分で申し込む体験の設定（第23.3.2節「既定」「設定」）。 */
export interface OpsDemoDefaults {
  days: number;
  aiCapJpy: number;
  /** 自分で申し込めるか。 */
  selfSignup: boolean;
  /** 自分で申し込む体験の 1 日の数。 */
  dailyLimit: number;
  /** 体験版全体の月の AI の上限（円）。 */
  monthlyAiCapJpy: number;
}

/** ローカルの形の機械。 */
export interface OpsMachine {
  id: string;
  name: string;
  createdAt: string;
  lastAt: string | null;
  report: MachineReport | null;
}

/** 運営の税率の表の 1 行（第15.1.1.1節）。 */
export interface OpsTaxRate extends TaxRateEntry {
  id: string;
  /** 出典（官公庁や国会の発表の URL） */
  sourceUrl: string;
  /** 確認した日 */
  checkedOn: string | null;
  updatedBy: string;
  updatedAt: string;
}

/** 運営主体の設定（第23.8.14節）。 */
/** 運営の AI の設定（鍵の値は持たない）。 */
export interface OpsPlatformAiSettings {
  keySet: boolean;
  /** 鍵の末尾 4 文字。 */
  keyTail: string | null;
  keySetAt: string | null;
  /** 入れた運営者のメールアドレス。 */
  keySetBy: string | null;
  tenantCapJpy: number | null;
  platformCapJpy: number | null;
}

export interface OperatorProfile {
  nameJa: string;
  nameEn: string;
  address: string;
  web: string;
  contact: string;
}

/** 会社の詳細（第23.8.15節）。数と状態と、シートの氏名とロールだけ。 */
export interface TenantDetail {
  tenant: { id: string; subdomain: string; name: string; workspaceDomain: string | null; status: TenantOverview['status']; createdAt: string };
  seats: { displayName: string; roles: string[]; status: string; email: string | null; lastUsedAt: string | null }[];
  months: { month: string; runs: number; failed: number; conversations: number; aiCost: number; usersMax: number }[];
  currentMonth: { month: string; runs: number; failed: number; conversations: number; aiCost: number };
  health: {
    runs30d: number; failed30d: number; approvalsPending: number; approvalsOldest: string | null; googleConnections: number;
    targets: { target: string; ok: number; fail: number; avgMs: number | null; lastError: string | null }[];
    failedAgents: { agentId: string; count: number }[];
  };
  history: { action: string; actorId: string; detail: Record<string, unknown>; occurredAt: string }[];
}

/** サーバー全体の稼働状況（第23.8.7節のうち段 1 の分）。 */
export interface ServerStatus {
  queue: { queued: number; oldestQueuedAt: string | null; running: number; awaitingApproval: number };
  runs: { hour: number; hourFailed: number; today: number; todayFailed: number };
  workers: { id: string; at: string; version: string | null }[];
  schedulesLate: number;
  targets: { group: string; ok: number; fail: number; avgMs: number | null }[];
  database: { bytes: number; connections: number };
  filesBytes: number;
  ai: { today: number; month: number; lastMonthSamePeriod: number };
}

/** 停止・緊急停止・再開の申請（第23.8.6節）。 */
export interface StatusRequest {
  id: string;
  tenantId: string;
  tenantName: string | null;
  kind: 'suspend' | 'lock' | 'resume';
  reasonCode: string;
  reason: string;
  state: 'pending' | 'scheduled' | 'done' | 'rejected' | 'withdrawn';
  fromStatus: string | null;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  effectiveAt: string | null;
  doneAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  /** 申請した本人が 1 人で承認したときの理由（第23.8.6節、ADR-0116）。 */
  decidedSoloNote: string | null;
  /** 発動した本人が 1 人で確かめたときの理由。 */
  confirmedSoloNote: string | null;
}

/** 障害・計画停止（運営の画面が見る形。第16.11.3節 G-9）。 */
export interface OpsIncident extends ServiceIncident {
  /** 対象の会社。`null` ならすべての会社。 */
  tenantIds: string[] | null;
  /** 起こした運営者。 */
  createdLabel: string;
}

/** 代理アクセスの申請（運営の画面が見る形。第23.6.1節）。 */
export interface OpsProxyGrant {
  id: string;
  tenantId: string;
  tenantName: string;
  operatorId: string;
  operatorLabel: string;
  scope: 'admin' | 'runs';
  reason: string;
  state: 'requested' | 'approved' | 'denied' | 'revoked' | 'ended' | 'withdrawn' | 'expired';
  requestedAt: string;
  decidedAt: string | null;
  hours: number | null;
  expiresAt: string | null;
  endedAt: string | null;
  views: number;
}

/** 運営の操作の記録。 */
export interface OpsAuditEntry {
  id: string;
  operatorId: string;
  operatorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/** 秘密の値の SHA-256（Cookie と機械の鍵は、値そのものを持たない）。 */
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function toOperator(r: Record<string, unknown>): Operator {
  return {
    id: String(r['id']), email: String(r['email']), displayName: String(r['display_name']), role: r['role'] as OperatorRole,
    status: r['status'] as Operator['status'], createdAt: iso(r['created_at'])!, lastLoginAt: iso(r['last_login_at']),
    ...(r['passkey_count'] !== undefined ? { passkeyCount: Number(r['passkey_count']) } : {}),
  };
}

/** 登録の合言葉（読み違えにくい字だけで 4 字ずつ 3 組。例 `K7QM-2XPA-9DRT`）。 */
function enrollCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const s = [...bytes].map((b) => chars[b % chars.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** データベースの関数が出した理由（`raise exception '…'`）。 */
export class OpsRuleError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** データベースの関数の失敗を、決めた理由に直す（決めた理由でなければそのまま投げる）。 */
function rethrow(err: unknown): never {
  const msg = err instanceof Error ? err.message : '';
  if (/^(subdomain_invalid|subdomain_taken|domain_taken|admin_domain|status_invalid|status_locked|not_found|reason_required|already_requested|not_stopped|not_pending|same_operator|solo_note_required|kind_invalid|time_invalid|login_invalid|login_taken|days_invalid|cap_invalid|daily_invalid)$/.test(msg)) throw new OpsRuleError(msg);
  throw err;
}

/**
 * マスター管理画面のデータベースの口。
 *
 * @remarks 接続は運営の専用のロールで行う。顧客の表に届かないことはデータベースの権限で守る（このクラスの作りに頼らない）
 */
export class OpsStore {
  constructor(private readonly pool: pg.Pool) {}

  /** そのまま 1 つ送る（運営のプロセスのシステムログを書く口に渡す。第16.10.1節）。 */
  readonly query = async (sql: string, params: unknown[]): Promise<unknown> => (await this.pool.query(sql, params as never[])).rows;

  /**
   * すべての会社のシステムログ（新しい順。第16.10.4節）。
   *
   * @param tenantId 会社で絞る（`null` ならすべて）。`system` なら会社に属さない仕組みの分だけ
   */
  async readSystemLogs(tenantId: string | null, system: boolean, f: SystemLogFilter): Promise<SystemLogLine[]> {
    const { rows } = await this.pool.query(
      `select id::text as id, at, level, service, msg, tenant_id as "tenantId", user_id as "userId", request_id as "requestId", run_id as "runId", fields
         from ops.read_system_logs($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [tenantId, system, f.from, f.to, f.levels?.length ? f.levels : null, f.service || null, f.q || null, f.requestId || null, f.runId || null,
        f.before?.at ?? null, f.before ? Number(f.before.id) : null, f.limit]);
    return rows.map((r) => ({ ...r, at: iso(r.at)! }) as SystemLogLine);
  }

  /** 日ごとの改ざんの確かめ（いまの行から作り直して比べる）。 */
  async systemLogDigests(fromDay: string, toDay: string): Promise<SystemLogDigest[]> {
    const { rows } = await this.pool.query(
      `select to_char(day, 'YYYY-MM-DD') as day, rows, sha256, chain, now_rows, now_sha256 from ops.system_log_digests($1::date, $2::date)`, [fromDay, toDay]);
    return rows.map((r) => ({ day: r.day, rows: r.rows, sha256: r.sha256, chain: r.chain, nowRows: r.now_rows, nowSha256: r.now_sha256, intact: r.now_sha256 === r.sha256 }));
  }

  /** 証拠保全を頼む（会社ごとか、全体）。 */
  async requestEvidence(id: string, tenantId: string | null, reason: string, from: string, to: string, operatorId: string): Promise<void> {
    await this.pool.query('select ops.request_evidence($1, $2, $3, $4, $5, $6)', [id, tenantId, reason, from, to, operatorId]);
  }

  /** 証拠保全の一覧（新しい順に 500 件）。 */
  async listEvidence(): Promise<EvidencePackage[]> {
    const { rows } = await this.pool.query('select * from ops.list_evidence()');
    return rows.map((r) => ({
      id: r.id, scope: r.scope, tenantId: r.tenant_id, reason: r.reason, createdKind: r.created_kind, createdBy: r.created_by,
      rangeFrom: iso(r.range_from)!, rangeTo: iso(r.range_to)!, status: r.status, size: r.size === null ? null : Number(r.size), sha256: r.sha256,
      failure: r.failure, createdAt: iso(r.created_at)!, readyAt: iso(r.ready_at), deletedAt: iso(r.deleted_at),
    }));
  }

  /** できあがった ZIP の 1 切れ（無ければ `null`）。 */
  async evidenceChunk(id: string, seq: number): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query('select ops.evidence_chunk($1, $2) as b', [id, seq]);
    return rows[0]?.b ? new Uint8Array(rows[0].b as Buffer) : null;
  }

  /** 1 年を過ぎた保全を消す（消せなければ `false`）。 */
  async deleteEvidence(id: string, operatorId: string, reason: string): Promise<boolean> {
    const { rows } = await this.pool.query('select ops.delete_evidence($1, $2, $3) as ok', [id, operatorId, reason]);
    return rows[0]?.ok === true;
  }

  /** 運営者の一覧。 */
  async listOperators(): Promise<Operator[]> {
    const { rows } = await this.pool.query('select o.*, (select count(*) from ops.passkeys p where p.operator_id = o.id) as passkey_count from ops.operators o order by o.created_at');
    return rows.map(toOperator);
  }

  async findOperatorByEmail(email: string): Promise<Operator | null> {
    const { rows } = await this.pool.query('select * from ops.operators where email = $1', [email.toLowerCase()]);
    return rows[0] ? toOperator(rows[0]) : null;
  }

  async findOperator(id: string): Promise<Operator | null> {
    const { rows } = await this.pool.query('select o.*, (select count(*) from ops.passkeys p where p.operator_id = o.id) as passkey_count from ops.operators o where o.id = $1', [id]);
    return rows[0] ? toOperator(rows[0]) : null;
  }

  /** 運営者を足す（同じメールアドレスがあれば `null`）。 */
  async addOperator(p: { email: string; displayName: string; role: OperatorRole; by: string }): Promise<Operator | null> {
    const { rows } = await this.pool.query(
      `insert into ops.operators (id, email, display_name, role, created_by) values ($1,$2,$3,$4,$5)
       on conflict (email) do nothing returning *`,
      [`op-${randomUUID().slice(0, 12)}`, p.email.toLowerCase(), p.displayName, p.role, p.by],
    );
    return rows[0] ? toOperator(rows[0]) : null;
  }

  /** ロールと状態を変える。無効にしたらログイン状態を失効させ、その運営者の代理アクセスも終える。 */
  async updateOperator(id: string, p: { role?: OperatorRole; status?: Operator['status'] }): Promise<Operator | null> {
    const { rows } = await this.pool.query(
      'update ops.operators set role = coalesce($2, role), status = coalesce($3, status) where id = $1 returning *',
      [id, p.role ?? null, p.status ?? null],
    );
    if (p.status === 'disabled') {
      await this.pool.query('update ops.sessions set revoked_at = now() where operator_id = $1 and revoked_at is null', [id]);
      // 会社の側の代理アクセス（申請中・閲覧中）も終える（許した期限まで閲覧が残らないように。第23.6.1節）
      await this.pool.query('select ops.end_operator_proxies($1)', [id]);
    }
    return rows[0] ? toOperator(rows[0]) : null;
  }

  /** 運営管理者の数（最後の 1 人を外させないため）。 */
  async activeAdminCount(): Promise<number> {
    const { rows } = await this.pool.query(`select count(*)::int as n from ops.operators where role = 'admin' and status = 'active'`);
    return rows[0].n as number;
  }

  /** ログイン状態を作る。Cookie に入れる値を返す（データベースには SHA-256 だけを持つ）。 */
  /**
   * ログイン状態を作る。Cookie に入れる値を返す（データベースには SHA-256 だけを持つ）。
   *
   * @param verified パスキーで確かめたことにするか（開発用ログインだけ。本番では Google のあとにパスキーで確かめる）
   */
  async createSession(operatorId: string, provider: string, userAgent: string | null, ttlHours: number, verified = false): Promise<{ token: string; session: OpsSession }> {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
    await this.pool.query(
      'insert into ops.sessions (id, operator_id, csrf_token, provider, user_agent, expires_at, verified) values ($1,$2,$3,$4,$5,$6,$7)',
      [sha256(token), operatorId, csrf, provider, userAgent?.slice(0, 300) ?? null, expires, verified],
    );
    await this.pool.query('update ops.operators set last_login_at = now() where id = $1', [operatorId]);
    return { token, session: { id: sha256(token), operatorId, csrfToken: csrf, expiresAt: expires, verified } };
  }

  /** ログイン状態を、パスキーで確かめたものにする。 */
  async markSessionVerified(sessionId: string): Promise<void> {
    await this.pool.query('update ops.sessions set verified = true where id = $1', [sessionId]);
  }

  /** 運営者のパスキーの一覧。 */
  async listPasskeys(operatorId: string): Promise<OpsPasskey[]> {
    const { rows } = await this.pool.query('select * from ops.passkeys where operator_id = $1 order by created_at', [operatorId]);
    return rows.map((r) => ({
      id: r.id, publicKey: r.public_key, counter: Number(r.counter), transports: r.transports ?? [], name: r.name,
      createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at),
    }));
  }

  async addPasskey(operatorId: string, p: { id: string; publicKey: string; counter: number; transports: string[]; name: string }): Promise<void> {
    await this.pool.query(
      'insert into ops.passkeys (id, operator_id, public_key, counter, transports, name) values ($1,$2,$3,$4,$5,$6)',
      [p.id, operatorId, p.publicKey, p.counter, p.transports, p.name.slice(0, 60)],
    );
  }

  /** 確かめに使ったパスキーの回数を進める（使い回しの見破りに使う）。 */
  async touchPasskey(id: string, counter: number): Promise<void> {
    await this.pool.query('update ops.passkeys set counter = $2, last_used_at = now() where id = $1', [id, counter]);
  }

  async deletePasskey(operatorId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('delete from ops.passkeys where operator_id = $1 and id = $2', [operatorId, id]);
    return (rowCount ?? 0) > 0;
  }

  /** その人のパスキーをすべて削除し、ログイン状態も切る（なくしたとき。別の運営管理者が行う）。 */
  async resetPasskeys(operatorId: string): Promise<void> {
    await this.pool.query('delete from ops.passkeys where operator_id = $1', [operatorId]);
    await this.pool.query('update ops.sessions set revoked_at = now() where operator_id = $1 and revoked_at is null', [operatorId]);
  }

  /** 登録の合言葉を出す（前のものは使えなくなる）。合言葉そのものは返すだけで、SHA-256 だけを持つ。 */
  async issueEnrollCode(operatorId: string, by: string): Promise<{ code: string; expiresAt: string }> {
    const code = enrollCode();
    const expiresAt = new Date(Date.now() + OPS_ENROLL_CODE_HOURS * 3_600_000).toISOString();
    await this.pool.query(
      `insert into ops.enroll_codes (operator_id, code_hash, expires_at, created_by) values ($1,$2,$3,$4)
       on conflict (operator_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = now()`,
      [operatorId, sha256(code), expiresAt, by],
    );
    return { code, expiresAt };
  }

  /**
   * 登録の合言葉を確かめる。
   *
   * @param consume 合っていれば使い切る（登録が済んだとき）
   */
  async checkEnrollCode(operatorId: string, code: string, consume: boolean): Promise<boolean> {
    const normalized = code.trim().toUpperCase().replace(/\s+/g, '');
    const { rows } = await this.pool.query(
      `${consume ? 'delete' : 'select 1'} from ops.enroll_codes where operator_id = $1 and code_hash = $2 and expires_at > now()${consume ? ' returning 1' : ''}`,
      [operatorId, sha256(normalized)],
    );
    return rows.length > 0;
  }

  /** 有効なログイン状態と運営者（無効にした運営者は通さない）。 */
  async findSession(token: string): Promise<{ session: OpsSession; operator: Operator } | null> {
    const { rows } = await this.pool.query(
      // パスキーの数も読む（画面は、0 なら登録の画面、1 以上なら確かめの画面を出す）
      `select s.id as sid, s.csrf_token, s.expires_at as s_expires, s.verified, o.*,
              (select count(*) from ops.passkeys p where p.operator_id = o.id) as passkey_count
         from ops.sessions s join ops.operators o on o.id = s.operator_id
        where s.id = $1 and s.revoked_at is null and s.expires_at > now() and o.status = 'active'`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    return { session: { id: r.sid, operatorId: r.id, csrfToken: r.csrf_token, expiresAt: iso(r.s_expires)!, verified: !!r.verified }, operator: toOperator(r) };
  }

  async revokeSession(id: string): Promise<void> {
    await this.pool.query('update ops.sessions set revoked_at = now() where id = $1', [id]);
  }

  /** 運営の操作を記録する。 */
  async audit(operatorId: string, action: string, targetType: string, targetId: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      'insert into ops.audit (id, operator_id, action, target_type, target_id, detail) values ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), operatorId, action, targetType, targetId, JSON.stringify(detail)],
    );
  }

  /** 運営の操作の記録（新しい順）。 */
  async listAudit(limit = 200): Promise<OpsAuditEntry[]> {
    const { rows } = await this.pool.query(
      `select a.*, o.email from ops.audit a left join ops.operators o on o.id = a.operator_id order by a.occurred_at desc limit $1`,
      [Math.min(Math.max(limit, 1), 1000)],
    );
    return rows.map((r) => ({
      id: r.id, operatorId: r.operator_id, operatorEmail: r.email ?? null, action: r.action, targetType: r.target_type,
      targetId: r.target_id, detail: r.detail ?? {}, occurredAt: iso(r.occurred_at)!,
    }));
  }

  /** その対象への運営の操作の記録（会社の詳細の履歴）。 */
  async listAuditFor(targetId: string, limit = 50): Promise<OpsAuditEntry[]> {
    const { rows } = await this.pool.query(
      `select a.*, o.email from ops.audit a left join ops.operators o on o.id = a.operator_id where a.target_id = $1 order by a.occurred_at desc limit $2`,
      [targetId, limit],
    );
    return rows.map((r) => ({
      id: r.id, operatorId: r.operator_id, operatorEmail: r.email ?? null, action: r.action, targetType: r.target_type,
      targetId: r.target_id, detail: r.detail ?? {}, occurredAt: iso(r.occurred_at)!,
    }));
  }

  /** 会社の詳細。無ければ `null`。 */
  async tenantDetail(tenantId: string): Promise<TenantDetail | null> {
    const { rows } = await this.pool.query('select ops.tenant_detail($1) as d', [tenantId]);
    return (rows[0]?.d as TenantDetail | null) ?? null;
  }

  /** 動いている環境の知らせ（API とワーカー）と PostgreSQL の版（第8.6.7.1節。決めた関数 ops.runtime_beats() で読む）。 */
  async runtimeBeats(): Promise<{ beats: RuntimeBeat[]; postgres: string | null }> {
    const [{ rows }, pgv] = await Promise.all([
      this.pool.query('select * from ops.runtime_beats()'),
      this.pool.query<{ server_version: string }>('show server_version').then((r) => r.rows[0]?.server_version?.split(' ')[0] ?? null).catch(() => null),
    ]);
    return { beats: rows.map((r) => beatFromRow(r as Parameters<typeof beatFromRow>[0])), postgres: pgv };
  }

  /** データベースの大きさと接続の数・上限（第23.8.7節「機械の資源の図」）。取れなければ `null`。 */
  async databaseUsage(): Promise<RuntimeEnvironment['database']> {
    const { rows } = await this.pool.query(DATABASE_USAGE_SQL).catch(() => ({ rows: [] }));
    return databaseFromRow(rows[0]);
  }

  /** 機械の資源の推移（使っている割合 %。決めた関数 ops.runtime_samples() で読む）。 */
  async runtimeSamples(days: RuntimeSampleDays): Promise<RuntimeSamplePoint[]> {
    const { rows } = await this.pool.query('select * from ops.runtime_samples($1)', [days]);
    return rows.map(samplePointFromRow);
  }

  /** サーバー全体の稼働状況。 */
  async serverStatus(): Promise<ServerStatus> {
    const { rows } = await this.pool.query('select ops.server_status() as s');
    return rows[0].s as ServerStatus;
  }

  /**
   * 運営の税率の表（第15.1.1.1節）。運営がまだ直していなければ空。
   */
  async listTaxRates(): Promise<OpsTaxRate[]> {
    const { rows } = await this.pool.query('select * from ops.tax_rates order by category, from_on');
    const day = (v: unknown) => (v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
    return rows.map((r) => ({
      id: r.id, category: r.category, rate: Number(r.rate), from: day(r.from_on)!, ...(r.to_on ? { to: day(r.to_on)! } : {}), planned: r.planned,
      ...(r.note ? { note: r.note } : {}), sourceUrl: r.source_url, checkedOn: day(r.checked_on), updatedBy: r.updated_by, updatedAt: iso(r.updated_at)!,
    }));
  }

  /**
   * 運営の税率の表を置き換える（1 つの処理で。行の ID が同じで中身が変わらなければ、直した人と日時はそのまま）。
   */
  async saveTaxRates(rows: (TaxRateEntry & { id: string; sourceUrl: string; checkedOn: string | null })[], by: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const { rows: cur } = await c.query('select id, category, rate, from_on::text as f, to_on::text as t, planned, note, source_url, checked_on::text as k from ops.tax_rates');
      const same = (r: (typeof rows)[number]) => cur.some((x) => x.id === r.id && x.category === r.category && Number(x.rate) === r.rate && x.f === r.from
        && (x.t ?? null) === (r.to ?? null) && x.planned === !!r.planned && x.note === (r.note ?? '') && x.source_url === r.sourceUrl && (x.k ?? null) === r.checkedOn);
      await c.query('delete from ops.tax_rates where not (id = any($1::text[]))', [rows.map((r) => r.id)]);
      for (const r of rows) {
        if (same(r)) continue;
        await c.query(
          `insert into ops.tax_rates (id, category, rate, from_on, to_on, planned, note, source_url, checked_on, updated_by, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           on conflict (id) do update set category = excluded.category, rate = excluded.rate, from_on = excluded.from_on, to_on = excluded.to_on,
             planned = excluded.planned, note = excluded.note, source_url = excluded.source_url, checked_on = excluded.checked_on,
             updated_by = excluded.updated_by, updated_at = now()`,
          [r.id, r.category, r.rate, r.from, r.to ?? null, !!r.planned, r.note ?? '', r.sourceUrl, r.checkedOn, by],
        );
      }
      await c.query('commit');
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  /** 全社の書類の下書きの数（税率を直す前に見せる。中身は読まない）。 */
  async salesDraftCount(): Promise<number> {
    const { rows } = await this.pool.query('select ops.sales_draft_count() as n');
    return Number(rows[0]?.n ?? 0);
  }

  /** 税率が確定したことを、販売の書類と受注を使う会社の管理者に知らせる。 @returns 知らせた人の数 */
  async taxRateNotice(title: string, body: string): Promise<number> {
    const { rows } = await this.pool.query('select ops.tax_rate_notice($1, $2) as n', [title, body]);
    return Number(rows[0]?.n ?? 0);
  }

  /** 運営主体の設定（入れていなければ空の値）。 */
  async operatorProfile(): Promise<OperatorProfile> {
    const { rows } = await this.pool.query('select * from ops.operator_profile where id = 1');
    const r = rows[0];
    return { nameJa: r?.name_ja ?? '', nameEn: r?.name_en ?? '', address: r?.address ?? '', web: r?.web ?? '', contact: r?.contact ?? '' };
  }

  async setOperatorProfile(p: OperatorProfile, by: string): Promise<void> {
    await this.pool.query(
      `insert into ops.operator_profile (id, name_ja, name_en, address, web, contact, updated_by, updated_at) values (1,$1,$2,$3,$4,$5,$6,now())
       on conflict (id) do update set name_ja = excluded.name_ja, name_en = excluded.name_en, address = excluded.address, web = excluded.web,
         contact = excluded.contact, updated_by = excluded.updated_by, updated_at = now()`,
      [p.nameJa, p.nameEn, p.address, p.web, p.contact, by],
    );
  }

  /**
   * 運営の AI の設定（第23.8.14節「マスター管理画面の設定を広げる」）。鍵の値は返さず、入っているか・末尾・入れた日時と人だけ。
   */
  async platformAiSettings(): Promise<OpsPlatformAiSettings> {
    const { rows } = await this.pool.query(
      `select p.gemini_key_enc is not null as key_set, p.gemini_key_tail, p.gemini_key_set_at, o.email as set_by, p.ai_tenant_cap_jpy, p.ai_platform_cap_jpy
         from ops.platform_settings p left join ops.operators o on o.id = p.gemini_key_set_by where p.id = 1`,
    );
    const r = rows[0];
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      keySet: !!r?.key_set, keyTail: r?.gemini_key_tail ?? null, keySetAt: iso(r?.gemini_key_set_at ?? null), keySetBy: r?.set_by ?? null,
      tenantCapJpy: n(r?.ai_tenant_cap_jpy), platformCapJpy: n(r?.ai_platform_cap_jpy),
    };
  }

  /** 画面で入れた運営の鍵（暗号化したもの）。無ければ `null`。試すときだけ使う。 */
  async platformAiKeyEnc(): Promise<string | null> {
    const { rows } = await this.pool.query('select gemini_key_enc from ops.platform_settings where id = 1');
    return rows[0]?.gemini_key_enc ?? null;
  }

  /** 運営の鍵を入れる（暗号化したもの）・消す（`null`）。 */
  async setPlatformAiKey(keyEnc: string | null, tail: string | null, by: string): Promise<void> {
    await this.pool.query(
      `update ops.platform_settings set gemini_key_enc = $1, gemini_key_tail = $2, gemini_key_set_at = case when $1::text is null then null else now() end,
         gemini_key_set_by = case when $1::text is null then null else $3 end, updated_by = $3, updated_at = now() where id = 1`,
      [keyEnc, tail, by],
    );
  }

  /** 会社ごとの上限の既定と、全体の上限（円。決めないなら `null`）。 */
  async setPlatformAiCaps(tenantCapJpy: number | null, platformCapJpy: number | null, by: string): Promise<void> {
    await this.pool.query(
      'update ops.platform_settings set ai_tenant_cap_jpy = $1, ai_platform_cap_jpy = $2, updated_by = $3, updated_at = now() where id = 1',
      [tenantCapJpy, platformCapJpy, by],
    );
  }

  /** 運営の鍵での全社の合計（円。`since` から）。 */
  async platformAiTotal(since: Date): Promise<number> {
    const { rows } = await this.pool.query('select ops.ai_platform_total($1) as total', [since]);
    return Number(rows[0]?.total ?? 0);
  }

  /** 体験版の既定（日数と AI の上限）と、自分で申し込む体験の設定（第23.3.2節「既定」「設定」）。 */
  async demoDefaults(): Promise<OpsDemoDefaults> {
    const { rows } = await this.pool.query(
      'select demo_days, demo_ai_cap_jpy, demo_self_signup, demo_daily_limit, demo_monthly_ai_cap_jpy from ops.platform_settings where id = 1');
    const r = rows[0] ?? {};
    return {
      days: Number(r.demo_days ?? 14), aiCapJpy: Number(r.demo_ai_cap_jpy ?? 1000), selfSignup: r.demo_self_signup ?? true,
      dailyLimit: Number(r.demo_daily_limit ?? 20), monthlyAiCapJpy: Number(r.demo_monthly_ai_cap_jpy ?? 20000),
    };
  }

  async setDemoDefaults(days: number, aiCapJpy: number, by: string): Promise<void> {
    await this.pool.query('select ops.set_demo_defaults($1, $2, $3)', [days, aiCapJpy, by]).catch(rethrow);
  }

  /** 自分で申し込む体験の設定（使うか・1 日の数・体験版全体の月の AI の上限）。 */
  async setDemoSignup(enabled: boolean, dailyLimit: number, monthlyAiCapJpy: number, by: string): Promise<void> {
    await this.pool.query('select ops.set_demo_signup($1, $2, $3, $4)', [enabled, dailyLimit, monthlyAiCapJpy, by]).catch(rethrow);
  }

  /** 体験版全体の、その月（日本時間）の AI の利用（円。消した体験の会社の分を含む）。 */
  async demoAiMonthTotal(): Promise<number> {
    const { rows } = await this.pool.query('select ops.demo_ai_month_total() as t');
    return Math.round(Number(rows[0]?.t ?? 0) * 100) / 100;
  }

  /** 体験の一覧（新しい順）。 */
  async listDemos(): Promise<OpsDemo[]> {
    const { rows } = await this.pool.query('select l.*, g.origin from ops.list_demos() l join ops.demo_guests g on g.id = l.id order by l.created_at desc');
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id, loginId: r.login_id, tenantId: r.tenant_id, company: r.company, contact: r.contact, email: r.email,
      aiCapJpy: Number(r.ai_cap_jpy), aiUsedJpy: Math.round(Number(r.ai_used_jpy) * 100) / 100, filesBytes: Number(r.files_bytes),
      createdBy: r.created_by, createdAt: iso(r.created_at)!, expiresAt: iso(r.expires_at)!, endedAt: iso(r.ended_at), deletedAt: iso(r.deleted_at),
      contactPurgedAt: iso(r.contact_purged_at), termsAcceptedAt: iso(r.terms_accepted_at), loginCount: Number(r.login_count),
      lastLoginAt: iso(r.last_login_at), lockedUntil: iso(r.locked_until),
      state: r.ended_at || r.deleted_at ? 'ended' : Date.parse(iso(r.expires_at)!) <= now ? 'expired' : 'active',
      origin: r.origin === 'self' ? 'self' : 'ops',
    }));
  }

  /**
   * 体験を出す（体験用の会社・ゲストの利用者・ゲストの記録を作る）。
   *
   * @param passwordHash パスワードの控え（元に戻せない形）
   * @param companyName 体験用の会社の名前（見本の会社名）
   * @throws {OpsRuleError} ID が使われている・日数や上限が範囲の外
   */
  async createDemo(p: { loginId: string; passwordHash: string; company: string; contact: string; email: string; days: number; aiCapJpy: number; companyName: string }, operatorId: string): Promise<{ id: string; tenantId: string; expiresAt: string }> {
    const { rows } = await this.pool.query('select * from ops.create_demo($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [p.loginId, p.passwordHash, p.company, p.contact, p.email, p.days, p.aiCapJpy, p.companyName, operatorId]).catch(rethrow);
    return { id: rows[0].guest_id, tenantId: rows[0].tenant_id, expiresAt: iso(rows[0].expires_at)! };
  }

  /** 期限を延ばす（1 回に 7 日まで）。新しい期限を返す。 */
  async extendDemo(id: string, days: number, operatorId: string): Promise<string> {
    const { rows } = await this.pool.query('select ops.extend_demo($1,$2,$3) as at', [id, days, operatorId]).catch(rethrow);
    return iso(rows[0].at)!;
  }

  /** パスワードを出し直す（前のパスワードとログイン状態は使えなくなる）。 */
  async resetDemoPassword(id: string, passwordHash: string, operatorId: string): Promise<void> {
    await this.pool.query('select ops.reset_demo_password($1,$2,$3)', [id, passwordHash, operatorId]).catch(rethrow);
  }

  /** 早く終える（体験用の会社をすぐ消す）。消した会社の ID を返す。 */
  async endDemo(id: string, operatorId: string): Promise<string> {
    const { rows } = await this.pool.query('select ops.end_demo($1,$2) as t', [id, operatorId]).catch(rethrow);
    return String(rows[0].t);
  }

  /**
   * 停止・緊急停止・再開の申請の一覧（新しい順）。
   *
   * @param tenantId 会社を絞る。無ければ、扱いの残っているもの（承認待ち・予告中・確認待ちの緊急停止）と直近 30 日のもの
   */
  async listStatusRequests(tenantId?: string): Promise<StatusRequest[]> {
    const { rows } = await this.pool.query(
      `select r.*, (select o.name from ops.tenant_names() o where o.id = r.tenant_id) as tenant_name from ops.status_requests r
        where ($1::text is null and (r.state in ('pending', 'scheduled') or (r.kind = 'lock' and r.confirmed_at is null) or r.requested_at > now() - interval '30 days'))
           or r.tenant_id = $1
        order by r.requested_at desc limit 200`,
      [tenantId ?? null],
    );
    return rows.map((r) => ({
      id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name ?? null, kind: r.kind, reasonCode: r.reason_code, reason: r.reason, state: r.state,
      fromStatus: r.from_status, requestedBy: r.requested_by, requestedAt: iso(r.requested_at)!, decidedBy: r.decided_by, decidedAt: iso(r.decided_at),
      effectiveAt: iso(r.effective_at), doneAt: iso(r.done_at), confirmedBy: r.confirmed_by, confirmedAt: iso(r.confirmed_at),
      decidedSoloNote: r.decided_solo_note ?? null, confirmedSoloNote: r.confirmed_solo_note ?? null,
    }));
  }

  /**
   * 停止・緊急停止・再開を申請する（緊急停止はすぐに止める）。
   *
   * @throws {OpsRuleError} 理由が無い・状態が合わない・同じ申請があるなど
   */
  async requestStatus(tenantId: string, kind: StatusRequest['kind'], reasonCode: string, reason: string, operatorId: string): Promise<string> {
    try {
      const { rows } = await this.pool.query('select ops.request_status($1,$2,$3,$4,$5) as id', [tenantId, kind, reasonCode, reason, operatorId]);
      return rows[0].id as string;
    } catch (err) { rethrow(err); }
  }

  /**
   * 申請を承認するか、しない。申請した人は、ほかに承認できる運営者がいないときだけ、1 人で行う理由を書いて行える（第23.8.6節、ADR-0116）。
   *
   * @param soloNote 申請した本人が行うときの、1 人で行う理由
   * @throws {OpsRuleError} `same_operator`（ほかに運営者がいる）・`solo_note_required`（理由が無い）など
   */
  async decideStatus(requestId: string, approve: boolean, operatorId: string, soloNote?: string): Promise<string> {
    try {
      const { rows } = await this.pool.query('select ops.decide_status($1,$2,$3,$4) as s', [requestId, approve, operatorId, soloNote ?? null]);
      return rows[0].s as string;
    } catch (err) { rethrow(err); }
  }

  /** 承認待ちか予告中の申請を取り下げる。 */
  async withdrawStatus(requestId: string, operatorId: string): Promise<void> {
    try { await this.pool.query('select ops.withdraw_status($1,$2)', [requestId, operatorId]); } catch (err) { rethrow(err); }
  }

  /**
   * 緊急停止を、事後に別の運営者が確かめる。発動した人は、ほかに承認できる運営者がいないときだけ、1 人で行う理由を書いて確かめられる。
   *
   * @param soloNote 発動した本人が確かめるときの、1 人で行う理由
   */
  async confirmLock(requestId: string, operatorId: string, soloNote?: string): Promise<void> {
    try { await this.pool.query('select ops.confirm_lock($1,$2,$3)', [requestId, operatorId, soloNote ?? null]); } catch (err) { rethrow(err); }
  }

  /** この運営者が、承認できるただ 1 人の運営者か（2 人の決まりの承認と確認を本人が行えるか。ADR-0116）。 */
  async soloOperator(operatorId: string): Promise<boolean> {
    const { rows } = await this.pool.query('select ops.solo_operator($1) as solo', [operatorId]);
    return rows[0]?.solo === true;
  }

  /** 代理アクセスを申請する（会社の管理者全員に知らせる）。 */
  async requestProxy(tenantId: string, scope: 'admin' | 'runs', reason: string, operatorId: string, operatorLabel: string): Promise<string> {
    try {
      const { rows } = await this.pool.query('select ops.request_proxy($1,$2,$3,$4,$5) as id', [tenantId, scope, reason, operatorId, operatorLabel]);
      return rows[0].id as string;
    } catch (err) { rethrow(err); }
  }

  /**
   * 許された代理アクセスに入るための、1 回だけの引換券（2 分で切れる）を出す。申請した運営者だけ。
   *
   * @returns 引換券と会社のサブドメイン。券そのものはデータベースに残さず、SHA-256 だけを渡す
   */
  async proxyTicket(grantId: string, operatorId: string): Promise<{ ticket: string; subdomain: string }> {
    const ticket = randomBytes(32).toString('base64url');
    try {
      const { rows } = await this.pool.query('select ops.proxy_ticket($1,$2,$3) as sub', [grantId, operatorId, sha256(ticket)]);
      return { ticket, subdomain: rows[0].sub as string };
    } catch (err) { rethrow(err); }
  }

  /** 申請を取り下げるか、許された閲覧を運営者の側から終える。 */
  async endProxy(grantId: string, operatorId: string): Promise<void> {
    try { await this.pool.query('select ops.end_proxy($1,$2)', [grantId, operatorId]); } catch (err) { rethrow(err); }
  }

  /** 代理アクセスの申請の一覧（会社を絞るか、すべて）。 */
  /**
   * 障害・計画停止を起こし、対象の会社の管理者に知らせる（第16.11.3節 G-9）。
   *
   * @param tenants 対象の会社の ID。`null` ならすべての会社
   * @returns 起こしたものの ID と、知らせた会社の数
   */
  async openIncident(p: { title: string; impact: IncidentImpact; body: string; tenants: string[] | null; startedAt: string | null }, operatorId: string, operatorLabel: string): Promise<{ id: string; notified: number }> {
    try {
      const { rows } = await this.pool.query('select * from ops.open_incident($1,$2,$3,$4,$5,$6,$7)', [p.title, p.impact, p.body, p.tenants, p.startedAt, operatorId, operatorLabel]);
      return { id: rows[0].id as string, notified: Number(rows[0].notified) };
    } catch (err) { rethrow(err); }
  }

  /** 経過を書き、知らせる。知らせた会社の数を返す。 */
  async updateIncident(id: string, body: string, operatorId: string): Promise<number> {
    try {
      const { rows } = await this.pool.query('select ops.update_incident($1,$2,$3) as n', [id, body, operatorId]);
      return Number(rows[0].n);
    } catch (err) { rethrow(err); }
  }

  /** 終え（復旧・計画停止の終わり）、知らせる。知らせた会社の数を返す。 */
  async closeIncident(id: string, endedAt: string | null, body: string, operatorId: string): Promise<number> {
    try {
      const { rows } = await this.pool.query('select ops.close_incident($1,$2,$3,$4) as n', [id, endedAt, body, operatorId]);
      return Number(rows[0].n);
    } catch (err) { rethrow(err); }
  }

  /** 障害・計画停止の一覧（新しい順）。 */
  async listIncidents(limit = 100): Promise<OpsIncident[]> {
    const { rows } = await this.pool.query('select * from ops.list_incidents($1)', [limit]);
    return rows.map((r) => ({
      id: r.id, title: r.title, impact: r.impact, tenantIds: r.tenant_ids ?? null, body: r.body, updates: r.updates ?? [],
      startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at), createdLabel: r.created_label,
    }));
  }

  async listProxy(tenantId?: string): Promise<OpsProxyGrant[]> {
    const { rows } = await this.pool.query('select * from ops.list_proxy($1)', [tenantId ?? null]);
    return rows.map((r) => ({
      id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name, operatorId: r.operator_id, operatorLabel: r.operator_label, scope: r.scope,
      reason: r.reason, state: r.state, requestedAt: iso(r.requested_at)!, decidedAt: iso(r.decided_at), hours: r.hours,
      expiresAt: iso(r.expires_at), endedAt: iso(r.ended_at), views: Number(r.views),
    }));
  }

  /** 会社ごとの数（その場で数える）。 */
  async tenantOverview(): Promise<TenantOverview[]> {
    const [{ rows }, sec] = await Promise.all([
      this.pool.query('select * from ops.tenant_overview()'),
      // 不正の兆しの数（移行 124 より前のデータベースでは読めないので、0 として扱う）
      this.pool.query('select * from ops.tenant_security()').then((x) => x.rows as { tenant_id: string; signals_24h: number; high_24h: number }[]).catch(() => []),
    ]);
    const signals = new Map(sec.map((s) => [s.tenant_id, s]));
    return rows.map((r) => ({
      id: r.id, subdomain: r.subdomain, name: r.name, workspaceDomain: r.workspace_domain, status: r.status, createdAt: iso(r.created_at)!,
      usersActive: r.users_active, usersInvited: r.users_invited, users30d: r.users_30d, lastUsedAt: iso(r.last_used_at),
      runsToday: r.runs_today, runs30d: r.runs_30d, runsFailed30d: r.runs_failed_30d, conversations30d: r.conversations_30d,
      aiCostMonth: Number(r.ai_cost_month), filesBytes: Number(r.files_bytes), extensions: r.extensions, googleConnections: r.google_connections,
      securitySignals24h: signals.get(r.id)?.signals_24h ?? 0, securityHigh24h: signals.get(r.id)?.high_24h ?? 0,
    }));
  }

  /**
   * 会社と最初の管理者を作る。
   *
   * @throws {OpsRuleError} サブドメイン・ドメインが使われているなど
   */
  async createTenant(input: NewTenantInput, operatorId: string): Promise<string> {
    try {
      const { rows } = await this.pool.query('select ops.create_tenant($1,$2,$3,$4,$5,$6) as id',
        [input.subdomain, input.name, input.domain, input.admin, input.status, operatorId]);
      return rows[0].id as string;
    } catch (err) { rethrow(err); }
  }

  /**
   * 試用と稼働を切り替える。
   *
   * @returns 切り替える前の状態
   * @throws {OpsRuleError} 停止中・解約済みなど
   */
  async setTenantStatus(tenantId: string, status: 'trial' | 'active', operatorId: string): Promise<string> {
    try {
      const { rows } = await this.pool.query('select ops.set_tenant_status($1,$2,$3) as from', [tenantId, status, operatorId]);
      return rows[0].from as string;
    } catch (err) { rethrow(err); }
  }

  /** 機械の一覧。 */
  async listMachines(): Promise<OpsMachine[]> {
    const { rows } = await this.pool.query('select id, name, created_at, last_at, last_payload from ops.machines order by name');
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: iso(r.created_at)!, lastAt: iso(r.last_at), report: r.last_payload ?? null }));
  }

  /** 機械を登録する。受け口の鍵を返す（1 度だけ。データベースには SHA-256 だけを持つ）。 */
  async addMachine(name: string, by: string): Promise<{ machine: OpsMachine; token: string }> {
    const id = `m-${randomBytes(4).toString('hex')}`;
    const token = randomBytes(32).toString('base64url');
    const { rows } = await this.pool.query(
      'insert into ops.machines (id, name, token_hash, created_by) values ($1,$2,$3,$4) returning created_at',
      [id, name, sha256(token), by],
    );
    return { machine: { id, name, createdAt: iso(rows[0].created_at)!, lastAt: null, report: null }, token };
  }

  async removeMachine(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('delete from ops.machines where id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * 稼働の知らせを受け取る（鍵で機械を決める）。
   *
   * @returns 受け取った機械の ID（鍵が違えば `null`）
   */
  async receiveReport(token: string, report: MachineReport): Promise<string | null> {
    const { rows } = await this.pool.query(
      'update ops.machines set last_at = now(), last_payload = $2 where token_hash = $1 returning id',
      [sha256(token), JSON.stringify(report)],
    );
    return rows[0]?.id ?? null;
  }
}
