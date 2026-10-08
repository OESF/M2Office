/**
 * @file マスター管理画面（仕様書 第23.8.15節）のデータベースの口。運営の専用のロール `m2office_ops` で接続する。
 *
 * このロールは `ops` スキーマの表（運営者・運営のログイン状態・運営の操作の記録・機械）だけを触り、顧客の表には届かない（移行 111）。
 * 会社の数・会社を作る・状態を変えるは、所有者の権限で動く決めた関数（`ops.tenant_overview` など）だけを呼ぶ。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { MachineReport, NewTenantInput, OperatorRole } from './rules.js';

/** 運営者。 */
export interface Operator {
  id: string;
  email: string;
  displayName: string;
  role: OperatorRole;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
}

/** 運営のログイン状態。 */
export interface OpsSession {
  id: string;
  operatorId: string;
  csrfToken: string;
  expiresAt: string;
}

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
}

/** ローカルの形の機械。 */
export interface OpsMachine {
  id: string;
  name: string;
  createdAt: string;
  lastAt: string | null;
  report: MachineReport | null;
}

/** 運営主体の設定（第23.8.14節）。 */
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
  };
}

/** データベースの関数が出した理由（`raise exception '…'`）。 */
export class OpsRuleError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** データベースの関数の失敗を、決めた理由に直す（決めた理由でなければそのまま投げる）。 */
function rethrow(err: unknown): never {
  const msg = err instanceof Error ? err.message : '';
  if (/^(subdomain_invalid|subdomain_taken|domain_taken|admin_domain|status_invalid|status_locked|not_found|reason_required|already_requested|not_stopped|not_pending|same_operator|kind_invalid)$/.test(msg)) throw new OpsRuleError(msg);
  throw err;
}

/**
 * マスター管理画面のデータベースの口。
 *
 * @remarks 接続は運営の専用のロールで行う。顧客の表に届かないことはデータベースの権限で守る（このクラスの作りに頼らない）
 */
export class OpsStore {
  constructor(private readonly pool: pg.Pool) {}

  /** 運営者の一覧。 */
  async listOperators(): Promise<Operator[]> {
    const { rows } = await this.pool.query('select * from ops.operators order by created_at');
    return rows.map(toOperator);
  }

  async findOperatorByEmail(email: string): Promise<Operator | null> {
    const { rows } = await this.pool.query('select * from ops.operators where email = $1', [email.toLowerCase()]);
    return rows[0] ? toOperator(rows[0]) : null;
  }

  async findOperator(id: string): Promise<Operator | null> {
    const { rows } = await this.pool.query('select * from ops.operators where id = $1', [id]);
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

  /** ロールと状態を変える。無効にしたらログイン状態も失効させる。 */
  async updateOperator(id: string, p: { role?: OperatorRole; status?: Operator['status'] }): Promise<Operator | null> {
    const { rows } = await this.pool.query(
      'update ops.operators set role = coalesce($2, role), status = coalesce($3, status) where id = $1 returning *',
      [id, p.role ?? null, p.status ?? null],
    );
    if (p.status === 'disabled') await this.pool.query('update ops.sessions set revoked_at = now() where operator_id = $1 and revoked_at is null', [id]);
    return rows[0] ? toOperator(rows[0]) : null;
  }

  /** 運営管理者の数（最後の 1 人を外させないため）。 */
  async activeAdminCount(): Promise<number> {
    const { rows } = await this.pool.query(`select count(*)::int as n from ops.operators where role = 'admin' and status = 'active'`);
    return rows[0].n as number;
  }

  /** ログイン状態を作る。Cookie に入れる値を返す（データベースには SHA-256 だけを持つ）。 */
  async createSession(operatorId: string, provider: string, userAgent: string | null, ttlHours: number): Promise<{ token: string; session: OpsSession }> {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
    await this.pool.query(
      'insert into ops.sessions (id, operator_id, csrf_token, provider, user_agent, expires_at) values ($1,$2,$3,$4,$5,$6)',
      [sha256(token), operatorId, csrf, provider, userAgent?.slice(0, 300) ?? null, expires],
    );
    await this.pool.query('update ops.operators set last_login_at = now() where id = $1', [operatorId]);
    return { token, session: { id: sha256(token), operatorId, csrfToken: csrf, expiresAt: expires } };
  }

  /** 有効なログイン状態と運営者（無効にした運営者は通さない）。 */
  async findSession(token: string): Promise<{ session: OpsSession; operator: Operator } | null> {
    const { rows } = await this.pool.query(
      `select s.id as sid, s.csrf_token, s.expires_at as s_expires, o.* from ops.sessions s join ops.operators o on o.id = s.operator_id
        where s.id = $1 and s.revoked_at is null and s.expires_at > now() and o.status = 'active'`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    return { session: { id: r.sid, operatorId: r.id, csrfToken: r.csrf_token, expiresAt: iso(r.s_expires)! }, operator: toOperator(r) };
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

  /** サーバー全体の稼働状況。 */
  async serverStatus(): Promise<ServerStatus> {
    const { rows } = await this.pool.query('select ops.server_status() as s');
    return rows[0].s as ServerStatus;
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

  /** 申請を承認するか、しない（申請した人は承認できない）。 */
  async decideStatus(requestId: string, approve: boolean, operatorId: string): Promise<string> {
    try {
      const { rows } = await this.pool.query('select ops.decide_status($1,$2,$3) as s', [requestId, approve, operatorId]);
      return rows[0].s as string;
    } catch (err) { rethrow(err); }
  }

  /** 承認待ちか予告中の申請を取り下げる。 */
  async withdrawStatus(requestId: string, operatorId: string): Promise<void> {
    try { await this.pool.query('select ops.withdraw_status($1,$2)', [requestId, operatorId]); } catch (err) { rethrow(err); }
  }

  /** 緊急停止を、事後に別の運営者が確かめる。 */
  async confirmLock(requestId: string, operatorId: string): Promise<void> {
    try { await this.pool.query('select ops.confirm_lock($1,$2)', [requestId, operatorId]); } catch (err) { rethrow(err); }
  }

  /** 会社ごとの数（その場で数える）。 */
  async tenantOverview(): Promise<TenantOverview[]> {
    const { rows } = await this.pool.query('select * from ops.tenant_overview()');
    return rows.map((r) => ({
      id: r.id, subdomain: r.subdomain, name: r.name, workspaceDomain: r.workspace_domain, status: r.status, createdAt: iso(r.created_at)!,
      usersActive: r.users_active, usersInvited: r.users_invited, users30d: r.users_30d, lastUsedAt: iso(r.last_used_at),
      runsToday: r.runs_today, runs30d: r.runs_30d, runsFailed30d: r.runs_failed_30d, conversations30d: r.conversations_30d,
      aiCostMonth: Number(r.ai_cost_month), filesBytes: Number(r.files_bytes), extensions: r.extensions, googleConnections: r.google_connections,
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
