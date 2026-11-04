/**
 * @file 意思決定支援の置き場（仕様書 第43.15節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * 行を書くたびに通し番号（`rev`）を振り直し、画面は前に受け取った番号より大きい行だけを受け取る（第43.11.2節「開き直したとき」）。
 * 見せる範囲（始めた人と共有された人だけ）は、この置き場ではなく処理（`service.ts`）で絞る。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type {
  DecisionClaim, DecisionComparison, DecisionDig, DecisionEndReason, DecisionIssueState, DecisionMaterial, DecisionReport,
  DecisionSession, DecisionStage, DecisionStatus, DecisionStreamEvent, DecisionSummary, DecisionTurn, DecisionRole,
} from '@m2office/shared';

/** 討論のあとに頼まれたこと（ワーカーが受け取って行う）。 */
export type DecisionPending =
  | { kind: 'continue'; turns: number }
  | { kind: 'dig'; issue: string; turns: number };

/** 置き場に持つ相談（画面に出さない欄を足したもの）。 */
export interface StoredDecision extends DecisionSession {
  fileIds: string[];
  /** 材料を集める業務の実行の ID */
  gatherRunId: string | null;
  pending: DecisionPending | null;
  stopRequested: boolean;
  workerAt: string | null;
  trashedAt: string | null;
}

/** 相談の書き換えられる欄。 */
export type DecisionPatch = Partial<Pick<StoredDecision,
  'question' | 'viewpoints' | 'status' | 'endReason' | 'endNote' | 'progress' | 'missing' | 'digs' | 'comparison' | 'report' | 'ai' | 'costJpy' |
  'pending' | 'stopRequested' | 'turns' | 'gatherRunId'>>;

/** 新しい発言。 */
export interface DecisionTurnDraft {
  debate: number;
  turn: number;
  stage: DecisionStage;
  issue: string | null;
  role: DecisionRole;
  text?: string;
  done?: boolean;
}

/** 置き場。 */
export interface DecisionStore {
  create(tenantId: string, d: { createdBy: string; topic: string; turns: number; crossCheck: boolean; fileIds: string[] }): Promise<StoredDecision>;
  get(tenantId: string, id: string): Promise<StoredDecision | null>;
  /** 自分の相談と、共有された相談（ゴミ箱のものは除く）。新しい順。 */
  list(tenantId: string, userId: string): Promise<DecisionSummary[]>;
  update(tenantId: string, id: string, patch: DecisionPatch): Promise<void>;
  /** 動かす必要のある相談（始める前・途中のもの）の ID。 */
  workList(tenantId: string): Promise<string[]>;
  /**
   * 相談を受け持つ印を付ける。ほかのワーカーが `staleMs` より新しく印を付けていれば受け持たない。
   *
   * @returns 受け持てたか
   */
  claim(tenantId: string, id: string, staleMs: number): Promise<boolean>;
  /** 受け持っている印を新しくする。 */
  heartbeat(tenantId: string, id: string): Promise<void>;
  /** 受け持つ印を外す。 */
  release(tenantId: string, id: string): Promise<void>;
  addMaterials(tenantId: string, sessionId: string, materials: DecisionMaterial[]): Promise<void>;
  materials(tenantId: string, sessionId: string): Promise<DecisionMaterial[]>;
  createTurn(tenantId: string, sessionId: string, d: DecisionTurnDraft): Promise<DecisionTurn>;
  /** 発言の本文と印を書き換える（書きかけの間は何度も呼ぶ）。 */
  setTurn(tenantId: string, turnId: string, patch: { text?: string; done?: boolean; stopped?: boolean; rewritten?: boolean }): Promise<void>;
  deleteTurn(tenantId: string, turnId: string): Promise<void>;
  turns(tenantId: string, sessionId: string): Promise<DecisionTurn[]>;
  upsertClaims(tenantId: string, sessionId: string, claims: DecisionClaim[]): Promise<void>;
  claims(tenantId: string, sessionId: string): Promise<DecisionClaim[]>;
  addIssueStates(tenantId: string, sessionId: string, states: DecisionIssueState[]): Promise<void>;
  issueStates(tenantId: string, sessionId: string): Promise<DecisionIssueState[]>;
  setShares(tenantId: string, sessionId: string, userIds: string[], by: string): Promise<void>;
  /** ゴミ箱に入れる（30 日後に消す。第43.9節）。 */
  trash(tenantId: string, id: string): Promise<void>;
  /** ゴミ箱に入れてから `before` より前の相談を消す。 */
  purge(tenantId: string, before: Date): Promise<number>;
  /** `since` より後に変わったもの（画面に流す差分）。 */
  changes(tenantId: string, sessionId: string, since: number): Promise<DecisionStreamEvent>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());
const isoOrNull = (v: unknown): string | null => (v ? iso(v) : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

interface SessionRow {
  id: string; created_by: string; topic: string; question: string; viewpoints: unknown; turns: number; cross_check: boolean;
  status: DecisionStatus; end_reason: DecisionEndReason | null; end_note: string; progress: string; missing: unknown; digs: unknown;
  comparison: unknown; report: unknown; ai: 'local' | 'cloud' | null; cost_jpy: unknown; file_ids: string[] | null; gather_run_id: string | null; pending: unknown;
  stop_requested: boolean; worker_at: unknown; created_at: unknown; updated_at: unknown; trashed_at: unknown; rev: unknown; shared?: string[] | null;
}

const toSession = (r: SessionRow): StoredDecision => ({
  id: r.id, createdBy: r.created_by, topic: r.topic, question: r.question, viewpoints: arr<string>(r.viewpoints), turns: r.turns,
  crossCheck: r.cross_check, status: r.status, endReason: r.end_reason, endNote: r.end_note, progress: r.progress, missing: arr<string>(r.missing),
  digs: arr<DecisionDig>(r.digs), comparison: (r.comparison as DecisionComparison | null) ?? null, report: (r.report as DecisionReport | null) ?? null,
  ai: r.ai, costJpy: r.cost_jpy === null || r.cost_jpy === undefined ? null : Number(r.cost_jpy), sharedWith: r.shared ?? [],
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), rev: num(r.rev),
  fileIds: r.file_ids ?? [], gatherRunId: r.gather_run_id, pending: (r.pending as DecisionPending | null) ?? null, stopRequested: r.stop_requested,
  workerAt: isoOrNull(r.worker_at), trashedAt: isoOrNull(r.trashed_at),
});

interface TurnRow {
  id: string; debate: number; seq: number; turn: number; stage: DecisionStage; issue: string | null; role: DecisionRole; text: string;
  done: boolean; stopped: boolean; rewritten: boolean; created_at: unknown; rev: unknown;
}

const toTurn = (r: TurnRow): DecisionTurn => ({
  id: r.id, debate: r.debate, seq: r.seq, turn: r.turn, stage: r.stage, issue: r.issue, role: r.role, text: r.text,
  done: r.done, stopped: r.stopped, rewritten: r.rewritten, createdAt: iso(r.created_at), rev: num(r.rev),
});

interface ClaimRow {
  code: string; debate: number; turn_id: string; role: 'con' | 'pro' | 'human'; issue: string; kind: DecisionClaim['kind']; target: string | null;
  grounds: unknown; gist: string; body: string; state: DecisionClaim['state']; state_reason: string; refuted_by: string | null; pivot: boolean;
}

const toClaim = (r: ClaimRow): DecisionClaim => ({
  code: r.code, debate: r.debate, turnId: r.turn_id, role: r.role, issue: r.issue, kind: r.kind, target: r.target, grounds: arr<string>(r.grounds),
  gist: r.gist, body: r.body, state: r.state, stateReason: r.state_reason, refutedBy: r.refuted_by, pivot: r.pivot,
});

interface IssueRow { debate: number; issue: string; at: string; label: string; lean: DecisionIssueState['lean']; changed_by: string | null; reason: string }

const toIssue = (r: IssueRow): DecisionIssueState => ({ debate: r.debate, issue: r.issue, at: r.at, label: r.label, lean: r.lean, changedBy: r.changed_by, reason: r.reason });

interface MaterialRow { no: number; kind: DecisionMaterial['kind']; title: string; source: string; summary: string; ok: boolean }

const toMaterial = (r: MaterialRow): DecisionMaterial => ({ no: r.no, kind: r.kind, title: r.title, source: r.source, summary: r.summary, ok: r.ok });

const SESSION_SELECT = `select s.*, coalesce((select array_agg(user_id order by user_id) from decision_shares x where x.session_id = s.id), '{}') as shared from decision_sessions s`;

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresDecisionStore implements DecisionStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 6, name: 'decisions' });
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

  async create(tenantId: string, d: { createdBy: string; topic: string; turns: number; crossCheck: boolean; fileIds: string[] }): Promise<StoredDecision> {
    const id = `dcs-${randomUUID()}`;
    await this.q(tenantId,
      `insert into decision_sessions (id, tenant_id, created_by, topic, turns, cross_check, file_ids) values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, tenantId, d.createdBy, d.topic, d.turns, d.crossCheck, d.fileIds]);
    return (await this.get(tenantId, id))!;
  }

  async get(tenantId: string, id: string): Promise<StoredDecision | null> {
    const rows = await this.q<SessionRow>(tenantId, `${SESSION_SELECT} where s.tenant_id = $1 and s.id = $2`, [tenantId, id]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async list(tenantId: string, userId: string): Promise<DecisionSummary[]> {
    const rows = await this.q<SessionRow>(tenantId,
      `${SESSION_SELECT} where s.tenant_id = $1 and s.trashed_at is null
         and (s.created_by = $2 or exists (select 1 from decision_shares x where x.session_id = s.id and x.user_id = $2))
       order by s.updated_at desc limit 200`, [tenantId, userId]);
    return rows.map(toSession).map((s) => summaryOf(s, userId));
  }

  async update(tenantId: string, id: string, patch: DecisionPatch): Promise<void> {
    const cols: Record<keyof DecisionPatch, string> = {
      question: 'question', viewpoints: 'viewpoints', status: 'status', endReason: 'end_reason', endNote: 'end_note', progress: 'progress',
      missing: 'missing', digs: 'digs', comparison: 'comparison', report: 'report', ai: 'ai', costJpy: 'cost_jpy', pending: 'pending',
      stopRequested: 'stop_requested', turns: 'turns', gatherRunId: 'gather_run_id',
    };
    const json = new Set(['viewpoints', 'missing', 'digs', 'comparison', 'report', 'pending']);
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch) as [keyof DecisionPatch, unknown][]) {
      if (v === undefined) continue;
      const col = cols[k];
      params.push(json.has(col) ? (v === null ? null : JSON.stringify(v)) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.q(tenantId, `update decision_sessions set ${sets.join(', ')}, updated_at = now(), rev = nextval('decision_rev') where tenant_id = $1 and id = $2`, params);
  }

  async workList(tenantId: string): Promise<string[]> {
    const rows = await this.q<{ id: string }>(tenantId,
      `select id from decision_sessions where tenant_id = $1 and trashed_at is null and status in ('queued', 'gathering', 'debating', 'summarizing') order by created_at`, [tenantId]);
    return rows.map((r) => r.id);
  }

  async claim(tenantId: string, id: string, staleMs: number): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update decision_sessions set worker_at = now() where tenant_id = $1 and id = $2
         and (worker_at is null or worker_at < now() - ($3::text || ' milliseconds')::interval) returning id`, [tenantId, id, String(staleMs)]);
    return rows.length > 0;
  }

  async heartbeat(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `update decision_sessions set worker_at = now() where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async release(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `update decision_sessions set worker_at = null where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async addMaterials(tenantId: string, sessionId: string, materials: DecisionMaterial[]): Promise<void> {
    for (const m of materials) {
      await this.q(tenantId,
        `insert into decision_materials (tenant_id, session_id, no, kind, title, source, summary, ok) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (session_id, no) do update set kind = excluded.kind, title = excluded.title, source = excluded.source, summary = excluded.summary,
           ok = excluded.ok, rev = nextval('decision_rev')`,
        [tenantId, sessionId, m.no, m.kind, m.title, m.source, m.summary, m.ok]);
    }
  }

  async materials(tenantId: string, sessionId: string): Promise<DecisionMaterial[]> {
    return (await this.q<MaterialRow>(tenantId, `select * from decision_materials where tenant_id = $1 and session_id = $2 order by no`, [tenantId, sessionId])).map(toMaterial);
  }

  async createTurn(tenantId: string, sessionId: string, d: DecisionTurnDraft): Promise<DecisionTurn> {
    const id = `dct-${randomUUID()}`;
    const rows = await this.q<TurnRow>(tenantId,
      `insert into decision_turns (id, tenant_id, session_id, debate, seq, turn, stage, issue, role, text, done, done_at)
       values ($1, $2, $3, $4, coalesce((select max(seq) from decision_turns where session_id = $3), 0) + 1, $5, $6, $7, $8, $9, $10, case when $10 then now() end)
       returning *`,
      [id, tenantId, sessionId, d.debate, d.turn, d.stage, d.issue, d.role, d.text ?? '', d.done ?? false]);
    return toTurn(rows[0]!);
  }

  async setTurn(tenantId: string, turnId: string, patch: { text?: string; done?: boolean; stopped?: boolean; rewritten?: boolean }): Promise<void> {
    await this.q(tenantId,
      `update decision_turns set text = coalesce($3, text), done = coalesce($4, done), stopped = coalesce($5, stopped), rewritten = coalesce($6, rewritten),
         done_at = case when $4 then now() else done_at end, rev = nextval('decision_rev')
       where tenant_id = $1 and id = $2`,
      [tenantId, turnId, patch.text ?? null, patch.done ?? null, patch.stopped ?? null, patch.rewritten ?? null]);
  }

  async deleteTurn(tenantId: string, turnId: string): Promise<void> {
    await this.q(tenantId, `delete from decision_turns where tenant_id = $1 and id = $2`, [tenantId, turnId]);
  }

  async turns(tenantId: string, sessionId: string): Promise<DecisionTurn[]> {
    return (await this.q<TurnRow>(tenantId, `select * from decision_turns where tenant_id = $1 and session_id = $2 order by seq`, [tenantId, sessionId])).map(toTurn);
  }

  async upsertClaims(tenantId: string, sessionId: string, claims: DecisionClaim[]): Promise<void> {
    for (const c of claims) {
      await this.q(tenantId,
        `insert into decision_claims (tenant_id, session_id, code, debate, turn_id, role, issue, kind, target, grounds, gist, body, state, state_reason, refuted_by, pivot)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         on conflict (session_id, code) do update set issue = excluded.issue, kind = excluded.kind, target = excluded.target, grounds = excluded.grounds,
           gist = excluded.gist, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason, refuted_by = excluded.refuted_by,
           pivot = excluded.pivot, rev = nextval('decision_rev')`,
        [tenantId, sessionId, c.code, c.debate, c.turnId, c.role, c.issue, c.kind, c.target, JSON.stringify(c.grounds), c.gist, c.body, c.state, c.stateReason, c.refutedBy, c.pivot]);
    }
  }

  async claims(tenantId: string, sessionId: string): Promise<DecisionClaim[]> {
    return (await this.q<ClaimRow>(tenantId, `select * from decision_claims where tenant_id = $1 and session_id = $2 order by rev`, [tenantId, sessionId])).map(toClaim);
  }

  async addIssueStates(tenantId: string, sessionId: string, states: DecisionIssueState[]): Promise<void> {
    for (const s of states) {
      await this.q(tenantId,
        `insert into decision_issue_states (tenant_id, session_id, debate, issue, at, label, lean, changed_by, reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (session_id, debate, issue, at) do update set label = excluded.label, lean = excluded.lean, changed_by = excluded.changed_by,
           reason = excluded.reason, rev = nextval('decision_rev')`,
        [tenantId, sessionId, s.debate, s.issue, s.at, s.label, s.lean, s.changedBy, s.reason]);
    }
  }

  async issueStates(tenantId: string, sessionId: string): Promise<DecisionIssueState[]> {
    return (await this.q<IssueRow>(tenantId, `select * from decision_issue_states where tenant_id = $1 and session_id = $2 order by rev`, [tenantId, sessionId])).map(toIssue);
  }

  async setShares(tenantId: string, sessionId: string, userIds: string[], by: string): Promise<void> {
    await this.q(tenantId, `delete from decision_shares where tenant_id = $1 and session_id = $2 and not (user_id = any($3))`, [tenantId, sessionId, userIds]);
    for (const u of userIds) {
      await this.q(tenantId, `insert into decision_shares (tenant_id, session_id, user_id, shared_by) values ($1, $2, $3, $4) on conflict do nothing`, [tenantId, sessionId, u, by]);
    }
    await this.q(tenantId, `update decision_sessions set rev = nextval('decision_rev'), updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, sessionId]);
  }

  async trash(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `update decision_sessions set trashed_at = now(), stop_requested = true, rev = nextval('decision_rev') where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async purge(tenantId: string, before: Date): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from decision_sessions where tenant_id = $1 and trashed_at < $2 returning id`, [tenantId, before]);
    return rows.length;
  }

  async changes(tenantId: string, sessionId: string, since: number): Promise<DecisionStreamEvent> {
    const [session] = await this.q<SessionRow>(tenantId, `${SESSION_SELECT} where s.tenant_id = $1 and s.id = $2`, [tenantId, sessionId]);
    const maxRev = async (table: string) => num((await this.q<{ m: unknown }>(tenantId, `select coalesce(max(rev), 0) as m from ${table} where tenant_id = $1 and session_id = $2`, [tenantId, sessionId]))[0]?.m);
    const [materials, turns, claims, issues] = await Promise.all([
      this.q<MaterialRow & { rev: unknown }>(tenantId, `select * from decision_materials where tenant_id = $1 and session_id = $2 and rev > $3 order by no`, [tenantId, sessionId, since]),
      this.q<TurnRow>(tenantId, `select * from decision_turns where tenant_id = $1 and session_id = $2 and rev > $3 order by seq`, [tenantId, sessionId, since]),
      this.q<ClaimRow & { rev: unknown }>(tenantId, `select * from decision_claims where tenant_id = $1 and session_id = $2 and rev > $3 order by rev`, [tenantId, sessionId, since]),
      this.q<IssueRow & { rev: unknown }>(tenantId, `select * from decision_issue_states where tenant_id = $1 and session_id = $2 and rev > $3 order by rev`, [tenantId, sessionId, since]),
    ]);
    const revs = [session ? num(session.rev) : 0, ...materials.map((r) => num(r.rev)), ...turns.map((r) => num(r.rev)), ...claims.map((r) => num(r.rev)), ...issues.map((r) => num(r.rev))];
    void maxRev;
    const event: DecisionStreamEvent = { rev: Math.max(since, ...revs) };
    if (session && num(session.rev) > since) event.session = toSession(session);
    if (materials.length) event.materials = materials.map(toMaterial);
    if (turns.length) event.turns = turns.map(toTurn);
    if (claims.length) event.claims = claims.map(toClaim);
    if (issues.length) event.issueStates = issues.map(toIssue);
    return event;
  }
}

/** 一覧の 1 件にする。 */
export function summaryOf(s: StoredDecision, userId: string): DecisionSummary {
  return {
    id: s.id, title: s.question || s.topic.slice(0, 80), status: s.status, verdict: s.report?.verdict ?? null, createdBy: s.createdBy,
    mine: s.createdBy === userId, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

/** テスト用のメモリの置き場。 */
export class MemoryDecisionStore implements DecisionStore {
  private revSeq = 0;
  readonly sessions = new Map<string, StoredDecision & { tenantId: string }>();
  readonly materialRows: (DecisionMaterial & { tenantId: string; sessionId: string; rev: number })[] = [];
  readonly turnRows: (DecisionTurn & { tenantId: string; sessionId: string })[] = [];
  readonly claimRows: (DecisionClaim & { tenantId: string; sessionId: string; rev: number })[] = [];
  readonly issueRows: (DecisionIssueState & { tenantId: string; sessionId: string; rev: number })[] = [];
  readonly shares: { tenantId: string; sessionId: string; userId: string }[] = [];

  private next(): number { return ++this.revSeq; }
  private now(): string { return new Date().toISOString(); }

  private view(s: StoredDecision & { tenantId: string }): StoredDecision {
    const { tenantId: _t, ...rest } = s;
    return structuredClone({ ...rest, sharedWith: this.shares.filter((x) => x.sessionId === s.id).map((x) => x.userId).sort() });
  }

  async create(tenantId: string, d: { createdBy: string; topic: string; turns: number; crossCheck: boolean; fileIds: string[] }): Promise<StoredDecision> {
    const id = `dcs-${randomUUID()}`;
    const at = this.now();
    this.sessions.set(id, {
      tenantId, id, createdBy: d.createdBy, topic: d.topic, question: '', viewpoints: [], turns: d.turns, crossCheck: d.crossCheck, status: 'queued',
      endReason: null, endNote: '', progress: '', missing: [], digs: [], comparison: null, report: null, ai: null, costJpy: null, sharedWith: [],
      createdAt: at, updatedAt: at, rev: this.next(), fileIds: [...d.fileIds], gatherRunId: null, pending: null, stopRequested: false, workerAt: null, trashedAt: null,
    });
    return this.view(this.sessions.get(id)!);
  }

  async get(tenantId: string, id: string): Promise<StoredDecision | null> {
    const s = this.sessions.get(id);
    return s && s.tenantId === tenantId ? this.view(s) : null;
  }

  async list(tenantId: string, userId: string): Promise<DecisionSummary[]> {
    return [...this.sessions.values()]
      .filter((s) => s.tenantId === tenantId && !s.trashedAt && (s.createdBy === userId || this.shares.some((x) => x.sessionId === s.id && x.userId === userId)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => summaryOf(this.view(s), userId));
  }

  async update(tenantId: string, id: string, patch: DecisionPatch): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.tenantId !== tenantId) return;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(s, structuredClone(clean), { updatedAt: this.now(), rev: this.next() });
  }

  async workList(tenantId: string): Promise<string[]> {
    return [...this.sessions.values()].filter((s) => s.tenantId === tenantId && !s.trashedAt && ['queued', 'gathering', 'debating', 'summarizing'].includes(s.status)).map((s) => s.id);
  }

  async claim(tenantId: string, id: string, staleMs: number): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || s.tenantId !== tenantId) return false;
    if (s.workerAt && Date.now() - Date.parse(s.workerAt) < staleMs) return false;
    s.workerAt = this.now();
    return true;
  }

  async heartbeat(tenantId: string, id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s && s.tenantId === tenantId) s.workerAt = this.now();
  }

  async release(tenantId: string, id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s && s.tenantId === tenantId) s.workerAt = null;
  }

  async addMaterials(tenantId: string, sessionId: string, materials: DecisionMaterial[]): Promise<void> {
    for (const m of materials) {
      const i = this.materialRows.findIndex((r) => r.sessionId === sessionId && r.no === m.no);
      const row = { ...m, tenantId, sessionId, rev: this.next() };
      if (i >= 0) this.materialRows[i] = row; else this.materialRows.push(row);
    }
  }

  async materials(tenantId: string, sessionId: string): Promise<DecisionMaterial[]> {
    return this.materialRows.filter((r) => r.tenantId === tenantId && r.sessionId === sessionId).sort((a, b) => a.no - b.no)
      .map(({ tenantId: _t, sessionId: _s, rev: _r, ...m }) => ({ ...m }));
  }

  async createTurn(tenantId: string, sessionId: string, d: DecisionTurnDraft): Promise<DecisionTurn> {
    const seq = Math.max(0, ...this.turnRows.filter((r) => r.sessionId === sessionId).map((r) => r.seq)) + 1;
    const row = {
      tenantId, sessionId, id: `dct-${randomUUID()}`, debate: d.debate, seq, turn: d.turn, stage: d.stage, issue: d.issue, role: d.role,
      text: d.text ?? '', done: d.done ?? false, stopped: false, rewritten: false, createdAt: this.now(), rev: this.next(),
    };
    this.turnRows.push(row);
    const { tenantId: _t, sessionId: _s, ...t } = row;
    return { ...t };
  }

  async setTurn(tenantId: string, turnId: string, patch: { text?: string; done?: boolean; stopped?: boolean; rewritten?: boolean }): Promise<void> {
    const r = this.turnRows.find((x) => x.id === turnId && x.tenantId === tenantId);
    if (!r) return;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    Object.assign(r, clean, { rev: this.next() });
  }

  async deleteTurn(tenantId: string, turnId: string): Promise<void> {
    const i = this.turnRows.findIndex((x) => x.id === turnId && x.tenantId === tenantId);
    if (i >= 0) this.turnRows.splice(i, 1);
  }

  async turns(tenantId: string, sessionId: string): Promise<DecisionTurn[]> {
    return this.turnRows.filter((r) => r.tenantId === tenantId && r.sessionId === sessionId).sort((a, b) => a.seq - b.seq)
      .map(({ tenantId: _t, sessionId: _s, ...t }) => ({ ...t }));
  }

  async upsertClaims(tenantId: string, sessionId: string, claims: DecisionClaim[]): Promise<void> {
    for (const c of claims) {
      const i = this.claimRows.findIndex((r) => r.sessionId === sessionId && r.code === c.code);
      const row = { ...structuredClone(c), tenantId, sessionId, rev: this.next() };
      if (i >= 0) this.claimRows[i] = row; else this.claimRows.push(row);
    }
  }

  async claims(tenantId: string, sessionId: string): Promise<DecisionClaim[]> {
    return this.claimRows.filter((r) => r.tenantId === tenantId && r.sessionId === sessionId).sort((a, b) => a.rev - b.rev)
      .map(({ tenantId: _t, sessionId: _s, rev: _r, ...c }) => structuredClone(c));
  }

  async addIssueStates(tenantId: string, sessionId: string, states: DecisionIssueState[]): Promise<void> {
    for (const st of states) {
      const i = this.issueRows.findIndex((r) => r.sessionId === sessionId && r.debate === st.debate && r.issue === st.issue && r.at === st.at);
      const row = { ...st, tenantId, sessionId, rev: this.next() };
      if (i >= 0) this.issueRows[i] = row; else this.issueRows.push(row);
    }
  }

  async issueStates(tenantId: string, sessionId: string): Promise<DecisionIssueState[]> {
    return this.issueRows.filter((r) => r.tenantId === tenantId && r.sessionId === sessionId).sort((a, b) => a.rev - b.rev)
      .map(({ tenantId: _t, sessionId: _s, rev: _r, ...st }) => ({ ...st }));
  }

  async setShares(tenantId: string, sessionId: string, userIds: string[], _by: string): Promise<void> {
    for (let i = this.shares.length - 1; i >= 0; i--) {
      const x = this.shares[i]!;
      if (x.tenantId === tenantId && x.sessionId === sessionId && !userIds.includes(x.userId)) this.shares.splice(i, 1);
    }
    for (const u of userIds) {
      if (!this.shares.some((x) => x.sessionId === sessionId && x.userId === u)) this.shares.push({ tenantId, sessionId, userId: u });
    }
    const s = this.sessions.get(sessionId);
    if (s) { s.rev = this.next(); s.updatedAt = this.now(); }
  }

  async trash(tenantId: string, id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s && s.tenantId === tenantId) Object.assign(s, { trashedAt: this.now(), stopRequested: true, rev: this.next() });
  }

  async purge(tenantId: string, before: Date): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.tenantId === tenantId && s.trashedAt && Date.parse(s.trashedAt) < before.getTime()) { this.sessions.delete(id); n++; }
    }
    return n;
  }

  async changes(tenantId: string, sessionId: string, since: number): Promise<DecisionStreamEvent> {
    const s = this.sessions.get(sessionId);
    if (!s || s.tenantId !== tenantId) return { rev: since };
    const own = <T extends { sessionId: string; rev: number }>(rows: T[]) => rows.filter((r) => r.sessionId === sessionId && r.rev > since);
    const materials = own(this.materialRows);
    const turns = own(this.turnRows).sort((a, b) => a.seq - b.seq);
    const claims = own(this.claimRows);
    const issues = own(this.issueRows);
    const event: DecisionStreamEvent = { rev: Math.max(since, s.rev, ...materials.map((r) => r.rev), ...turns.map((r) => r.rev), ...claims.map((r) => r.rev), ...issues.map((r) => r.rev)) };
    if (s.rev > since) event.session = this.view(s);
    if (materials.length) event.materials = materials.map(({ tenantId: _t, sessionId: _s, rev: _r, ...m }) => ({ ...m }));
    if (turns.length) event.turns = turns.map(({ tenantId: _t, sessionId: _s, ...t }) => ({ ...t }));
    if (claims.length) event.claims = claims.map(({ tenantId: _t, sessionId: _s, rev: _r, ...c }) => structuredClone(c));
    if (issues.length) event.issueStates = issues.map(({ tenantId: _t, sessionId: _s, rev: _r, ...st }) => ({ ...st }));
    return event;
  }
}
