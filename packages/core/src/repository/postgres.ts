/**
 * @file PostgreSQL による永続化層の実装。
 *
 * 問い合わせごとにトランザクションを張って `app.tenant_id` を設定し、
 * データベースの行レベルセキュリティでテナントを分離する。
 *
 * @see 仕様書 第8.5.5節 RLS 実装上の注意
 */

import pg from 'pg';
import type {
  Approval, Artifact, AuditEvent, Job, Notification, Run, RunStep, Schedule, Session,
  StoredFile, Tenant, TenantSettings, User, UserGroup, UserSettings,
} from '@m2office/shared';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS, STANDARD_SYNONYMS } from '@m2office/shared';
import type { AgentEvent, Plan, PlanStep, DecidedApproval, AuditQuery, CompartmentAssignment, Conversation, ConversationDigest, MemoryCandidate, Promotion, CredentialKind, GoogleConnection, UserPhoto, TenantCredential, TenantConnection, ConnectionSecret, UserConnection, DisabledConnectorTool, InstalledExtension, PrivateExtension, KnowledgeItem, KnowledgeSearchOptions, KnowledgeSearchResult, KnowledgeSectionView, KnowledgeStatus, KnowledgeVersion, Memory, Repository, RunStatRow } from './types.js';
import { SPLIT_VERSION, citationOf, splitKnowledge } from '../knowledge/sections.js';
import { SEARCH_CANDIDATES, asksOldVersion, bigrams, expandTerms, extractTerms, normalizeForSearch, rankSections, rewritesOf } from '../knowledge/search.js';

/** 日本時間の今日（`YYYY-MM-DD`）。社内規程の施行日で版を切り替えるのに使う（第11.11.2節）。 */
const jstToday = (now = new Date()) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
/** 改定前の規程を探すときに見る古い版の数（第11.11.2節）。 */
const OLD_VERSION_SCAN = 30;
/** 知識の一覧の列（別名 `k`）。日付の列は文字にして返す（`date` を `Date` にしない）。 */
const KNOWLEDGE_COLUMNS = `k.id, k.tenant_id as "tenantId", k.kind, k.title, k.body, k.source, k.compartment,
  k.updated_at as "updatedAt", k.version, k.origin_run_id as "originRunId", k.google_derived as "googleDerived",
  k.category, k.status, k.status_at as "statusAt", k.status_reason as "statusReason", k.effective_from::text as "effectiveFrom",
  k.last_used_at as "lastUsedAt", k.merged_into as "mergedInto"`;
/** 版の一覧の列（別名 `v` と、その知識 `k`）。 */
const VERSION_COLUMNS = `v.item_id as "itemId", v.version, v.effective_from::text as "effectiveFrom", v.title, v.source,
  v.compartment, v.saved_by as "savedBy", v.saved_at as "savedAt", (v.version = k.version) as current,
  (v.version > k.version) as pending, char_length(v.body)::int as chars, v.hr_check as "hrCheck"`;

/** 実行の列（別名 `r` の表から、`Run` の形で取り出す）。 */
const RUN_COLUMNS = `r.id, r.job_id as "jobId", r.tenant_id as "tenantId", r.status, r.cursor,
  r.started_at as "startedAt", r.ended_at as "endedAt", r.tokens_used as "tokensUsed", r.cost_jpy as "costJpy",
  r.saved_minutes as "savedMinutes", r.failure_reason as "failureReason"`;

/** `LIKE` の特別な文字を、文字そのものとして扱うように逃がす。 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * PostgreSQL が返す値を、型定義どおりの JavaScript の値に揃える。
 *
 * @remarks
 * 既定では `numeric` は文字列、`timestamptz` は `Date` で返る。
 * 型定義（`@m2office/shared`）は数値と ISO 文字列を宣言しているため、
 * ここで合わせておかないと、加算が文字列連結になるなどの不整合が起きる。
 */
function configureTypeParsers(): void {
  const NUMERIC = 1700;
  const TIMESTAMPTZ = 1184;
  const TIMESTAMP = 1114;
  pg.types.setTypeParser(NUMERIC, (v) => Number(v));
  pg.types.setTypeParser(TIMESTAMPTZ, (v) => new Date(v).toISOString());
  pg.types.setTypeParser(TIMESTAMP, (v) => new Date(v).toISOString());
}
configureTypeParsers();

/**
 * PostgreSQL による永続化。
 *
 * @remarks
 * テナント境界: すべての問い合わせに `tenant_id` の条件を含めたうえで、
 * 問い合わせごとのトランザクションで `app.tenant_id` を設定し、
 * データベースの行レベルセキュリティでも二重に絞る（仕様書 第8.5.5節）。
 */
export class PostgresRepository implements Repository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  /** 接続を閉じる。プロセス終了時に呼ぶ。 */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * テナントの範囲で問い合わせる。
   *
   * @param tenantId 対象のテナント。`null` はテナント台帳（`tenants`）の参照に限る
   * @param text SQL
   * @param params パラメーター
   *
   * @remarks
   * テナント境界: 1 件ごとにトランザクションを張り、その中だけで
   * `app.tenant_id` を設定する（`set_config(..., true)`）。データベースの
   * 行レベルセキュリティがこの値で行を絞るため、SQL の条件を書き漏らしても
   * 他社の行は返らない（仕様書 第8.5.5節）。
   *
   * セッション変数（`set` のみ）にしないのは、接続プールで接続が使い回されたときに
   * 前のテナントの値が残るためである。`null` のときは何も設定しないので、
   * テナントのデータは 1 行も見えない（閉じた側に倒れる）。
   */
  private async q<T extends pg.QueryResultRow>(
    tenantId: string | null,
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (tenantId === null) {
      const res = await this.pool.query<T>(text, params as never[]);
      return res.rows;
    }
    return this.inTenant(tenantId, async (client) => {
      const res = await client.query<T>(text, params as never[]);
      return res.rows;
    });
  }

  /** テナントを設定したトランザクションの中で処理する。 */
  private async inTenant<R>(tenantId: string, fn: (client: pg.PoolClient) => Promise<R>): Promise<R> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findTenantBySubdomain(subdomain: string): Promise<Tenant | null> {
    const rows = await this.q<Tenant>(null, 
      `select id, subdomain, name, workspace_domain as "workspaceDomain", status
         from tenants where subdomain = $1`,
      [subdomain],
    );
    return rows[0] ?? null;
  }

  async findTenantById(tenantId: string): Promise<Tenant | null> {
    const rows = await this.q<Tenant>(null,
      `select id, subdomain, name, workspace_domain as "workspaceDomain", status
         from tenants where id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
  }

  async findUserByEmail(tenantId: string, email: string): Promise<User | null> {
    const rows = await this.q<User>(tenantId, 
      `select id, tenant_id as "tenantId", email, display_name as "displayName",
              roles, status
         from users where tenant_id = $1 and email = $2`,
      [tenantId, email],
    );
    return rows[0] ?? null;
  }

  async findUserById(tenantId: string, userId: string): Promise<User | null> {
    const rows = await this.q<User>(tenantId, 
      `select id, tenant_id as "tenantId", email, display_name as "displayName",
              roles, status
         from users where tenant_id = $1 and id = $2`,
      [tenantId, userId],
    );
    return rows[0] ?? null;
  }

  async listUsers(tenantId: string): Promise<User[]> {
    return this.q<User>(tenantId, 
      `select id, tenant_id as "tenantId", email, display_name as "displayName",
              roles, status
         from users where tenant_id = $1 order by email`,
      [tenantId],
    );
  }

  async createJob(job: Job): Promise<void> {
    await this.q(job.tenantId, 
      `insert into jobs (id, tenant_id, agent_id, agent_version, requested_by,
                         origin, input, created_at, plan_step_id, agent_name)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [job.id, job.tenantId, job.agentId, job.agentVersion, job.requestedBy,
       job.origin, JSON.stringify(job.input), job.createdAt, job.planStepId ?? null, job.agentName ?? null],
    );
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | null> {
    const rows = await this.q<Job>(tenantId, 
      `select id, tenant_id as "tenantId", agent_id as "agentId",
              agent_version as "agentVersion", requested_by as "requestedBy",
              origin, input, created_at as "createdAt", plan_step_id as "planStepId", agent_name as "agentName"
         from jobs where tenant_id = $1 and id = $2`,
      [tenantId, jobId],
    );
    return rows[0] ?? null;
  }

  async createRun(run: Run): Promise<void> {
    await this.q(run.tenantId, 
      `insert into runs (id, job_id, tenant_id, status, cursor, started_at,
                         ended_at, tokens_used, cost_jpy, saved_minutes, failure_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [run.id, run.jobId, run.tenantId, run.status, run.cursor, run.startedAt,
       run.endedAt, run.tokensUsed, run.costJpy, run.savedMinutes ?? 0, run.failureReason],
    );
  }

  async getRun(tenantId: string, runId: string): Promise<Run | null> {
    const rows = await this.q<Run>(tenantId, 
      `select id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
              started_at as "startedAt", ended_at as "endedAt",
              tokens_used as "tokensUsed", cost_jpy as "costJpy",
              saved_minutes as "savedMinutes",
              failure_reason as "failureReason"
         from runs where tenant_id = $1 and id = $2`,
      [tenantId, runId],
    );
    return rows[0] ?? null;
  }

  async updateRun(run: Run): Promise<void> {
    await this.q(run.tenantId, 
      `update runs set status=$3, cursor=$4, ended_at=$5, tokens_used=$6,
                       cost_jpy=$7, failure_reason=$8, saved_minutes=$9
         where tenant_id=$1 and id=$2`,
      [run.tenantId, run.id, run.status, run.cursor, run.endedAt,
       run.tokensUsed, run.costJpy, run.failureReason, run.savedMinutes ?? 0],
    );
  }

  async listRuns(tenantId: string, limit: number): Promise<Run[]> {
    return this.q<Run>(tenantId, 
      `select id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
              started_at as "startedAt", ended_at as "endedAt",
              tokens_used as "tokensUsed", cost_jpy as "costJpy",
              saved_minutes as "savedMinutes",
              failure_reason as "failureReason"
         from runs where tenant_id = $1 order by started_at desc limit $2`,
      [tenantId, limit],
    );
  }

  async listRunsWithJobs(
    tenantId: string,
    opts: { limit: number; requestedBy?: string },
  ): Promise<{ run: Run; job: Job }[]> {
    const rows = await this.q<{ run: Run; job: Job }>(tenantId, 
      `select json_build_object(
                'id', r.id, 'jobId', r.job_id, 'tenantId', r.tenant_id, 'status', r.status,
                'cursor', r.cursor, 'startedAt', r.started_at, 'endedAt', r.ended_at,
                'tokensUsed', r.tokens_used, 'costJpy', r.cost_jpy::float8,
                'savedMinutes', r.saved_minutes::float8,
                'failureReason', r.failure_reason) as run,
              json_build_object(
                'id', j.id, 'tenantId', j.tenant_id, 'agentId', j.agent_id,
                'agentVersion', j.agent_version, 'requestedBy', j.requested_by,
                'origin', j.origin, 'input', j.input, 'createdAt', j.created_at,
                'planStepId', j.plan_step_id) as job
         from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1 and ($2::text is null or j.requested_by = $2)
        order by r.started_at desc limit $3`,
      [tenantId, opts.requestedBy ?? null, opts.limit],
    );
    // json_build_object は時刻を ISO 形式の文字列で返すが、タイムゾーン表記を揃える
    return rows.map(({ run, job }) => ({
      run: { ...run, startedAt: iso(run.startedAt)!, endedAt: iso(run.endedAt) },
      job: { ...job, createdAt: iso(job.createdAt)! },
    }));
  }

  async usageByAgent(
    tenantId: string,
  ): Promise<{ agentId: string; runs: number; tokens: number; costJpy: number }[]> {
    return this.q(tenantId, 
      `select j.agent_id as "agentId", count(*)::int as runs,
              coalesce(sum(r.tokens_used), 0)::int as tokens,
              coalesce(sum(r.cost_jpy), 0)::float8 as "costJpy"
         from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1
        group by j.agent_id order by runs desc`,
      [tenantId],
    );
  }

  /**
   * 実行待ちのジョブを 1 件だけ確保する。
   *
   * @remarks
   * `for update skip locked` により、ワーカーを複数動かしても
   * 同じ実行を二重に処理しない（仕様書 第17章 二重実行防止）。
   */
  async claimNextRun(): Promise<Run | null> {
    // テナントを横断して待ち行列を見るのはこの関数だけであり、
    // データベース側の関数（security definer）に閉じ込めている
    const rows = await this.q<Run>(
      null,
      `select id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
              started_at as "startedAt", ended_at as "endedAt",
              tokens_used as "tokensUsed", cost_jpy as "costJpy",
              saved_minutes as "savedMinutes",
              failure_reason as "failureReason"
         from m2o_claim_next_run()`,
    );
    return rows[0] ?? null;
  }

  async appendRunStep(tenantId: string, step: RunStep): Promise<void> {
    await this.q(tenantId, 
      `insert into run_steps (id, run_id, seq, step_id, kind, status, input,
                              output, started_at, ended_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [step.id, step.runId, step.seq, step.stepId, step.kind, step.status,
       JSON.stringify(step.input ?? null), JSON.stringify(step.output ?? null),
       step.startedAt, step.endedAt],
    );
  }

  async updateRunStep(tenantId: string, step: RunStep): Promise<void> {
    await this.q(tenantId, 
      `update run_steps set status=$2, output=$3, ended_at=$4 where id=$1`,
      [step.id, step.status, JSON.stringify(step.output ?? null), step.endedAt],
    );
  }

  async listRunSteps(tenantId: string, runId: string): Promise<RunStep[]> {
    return this.q<RunStep>(tenantId, 
      `select s.id, s.run_id as "runId", s.seq, s.step_id as "stepId", s.kind,
              s.status, s.input, s.output, s.started_at as "startedAt",
              s.ended_at as "endedAt"
         from run_steps s join runs r on r.id = s.run_id
        where r.tenant_id = $1 and s.run_id = $2 order by s.seq`,
      [tenantId, runId],
    );
  }

  async getRunStepById(tenantId: string, runStepId: string): Promise<RunStep | null> {
    const rows = await this.q<RunStep>(tenantId, 
      `select s.id, s.run_id as "runId", s.seq, s.step_id as "stepId", s.kind,
              s.status, s.input, s.output, s.started_at as "startedAt",
              s.ended_at as "endedAt"
         from run_steps s join runs r on r.id = s.run_id
        where r.tenant_id = $1 and s.id = $2`,
      [tenantId, runStepId],
    );
    return rows[0] ?? null;
  }

  async createApproval(a: Approval): Promise<void> {
    await this.q(a.tenantId, 
      `insert into approvals (id, run_step_id, tenant_id, approver_role, approver_user_id,
                              present, decision, decided_by, comment, decided_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [a.id, a.runStepId, a.tenantId, a.approverRole, a.approverUserId, a.present, a.decision,
       a.decidedBy, a.comment, a.decidedAt, a.createdAt],
    );
  }

  async getApproval(tenantId: string, id: string): Promise<Approval | null> {
    const rows = await this.q<Approval>(tenantId, 
      `select id, run_step_id as "runStepId", tenant_id as "tenantId",
              approver_role as "approverRole",
              approver_user_id as "approverUserId", present, decision,
              decided_by as "decidedBy", comment, decided_at as "decidedAt",
              created_at as "createdAt"
         from approvals where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }

  async listPendingApprovals(tenantId: string): Promise<Approval[]> {
    return this.q<Approval>(tenantId, 
      `select id, run_step_id as "runStepId", tenant_id as "tenantId",
              approver_role as "approverRole",
              approver_user_id as "approverUserId", present, decision,
              decided_by as "decidedBy", comment, decided_at as "decidedAt",
              created_at as "createdAt"
         from approvals
        where tenant_id = $1 and decision is null order by created_at`,
      [tenantId],
    );
  }

  async listDecidedApprovals(tenantId: string, userId: string, limit: number): Promise<DecidedApproval[]> {
    return this.q<DecidedApproval>(tenantId,
      `select a.id, a.run_step_id as "runStepId", a.tenant_id as "tenantId",
              a.approver_role as "approverRole", a.approver_user_id as "approverUserId", a.present,
              a.decision, a.decided_by as "decidedBy", a.comment, a.decided_at as "decidedAt",
              a.created_at as "createdAt",
              s.run_id as "runId", j.agent_id as "agentId", j.agent_version as "agentVersion", j.requested_by as "requestedBy",
              j.agent_name as "agentName"
         from approvals a
         join run_steps s on s.id = a.run_step_id
         join runs r on r.id = s.run_id and r.tenant_id = a.tenant_id
         join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where a.tenant_id = $1 and a.decided_by = $2 and a.decision in ('approved', 'rejected')
        order by a.decided_at desc
        limit $3`,
      [tenantId, userId, limit]);
  }

  async listRunApprovals(tenantId: string, runId: string): Promise<Approval[]> {
    return this.q<Approval>(tenantId,
      `select a.id, a.run_step_id as "runStepId", a.tenant_id as "tenantId",
              a.approver_role as "approverRole", a.approver_user_id as "approverUserId", a.present,
              a.decision, a.decided_by as "decidedBy", a.comment, a.decided_at as "decidedAt",
              a.created_at as "createdAt"
         from approvals a join run_steps s on s.id = a.run_step_id
        where a.tenant_id = $1 and s.run_id = $2`,
      [tenantId, runId]);
  }

  async listApprovalsForFileInput(tenantId: string, fileId: string): Promise<Approval[]> {
    // 依頼の入力（JSON）の値にファイルの ID がそのまま入っているものを探す。ID は利用者の入力ではなく M2Office が付けたもの
    return this.q<Approval>(tenantId,
      `select a.id, a.run_step_id as "runStepId", a.tenant_id as "tenantId",
              a.approver_role as "approverRole", a.approver_user_id as "approverUserId", a.present,
              a.decision, a.decided_by as "decidedBy", a.comment, a.decided_at as "decidedAt",
              a.created_at as "createdAt"
         from approvals a
         join run_steps s on s.id = a.run_step_id
         join runs r on r.id = s.run_id and r.tenant_id = a.tenant_id
         join jobs j on j.id = r.job_id and j.tenant_id = a.tenant_id
        where a.tenant_id = $1
          and exists (select 1 from jsonb_each_text(j.input) e where e.value = $2)`,
      [tenantId, fileId]);
  }

  async listStaleApprovals(tenantId: string, createdBefore: string): Promise<Approval[]> {
    return this.q<Approval>(tenantId,
      `select id, run_step_id as "runStepId", tenant_id as "tenantId",
              approver_role as "approverRole", approver_user_id as "approverUserId", present, decision,
              decided_by as "decidedBy", comment, decided_at as "decidedAt", created_at as "createdAt"
         from approvals
        where tenant_id = $1 and decision is null and created_at < $2 order by created_at`,
      [tenantId, createdBefore]);
  }

  async listTenantIds(): Promise<string[]> {
    const rows = await this.q<{ id: string }>(null, `select id from tenants order by id`);
    return rows.map((r) => r.id);
  }

  async listRunsForRetention(tenantId: string, endedBefore: string, limit: number): Promise<Run[]> {
    return this.q<Run>(tenantId,
      `select ${RUN_COLUMNS} from runs r
        where r.tenant_id = $1 and r.status in ('completed', 'failed', 'cancelled', 'expired')
          and r.ended_at is not null and r.ended_at < $2 and r.google_data_checked_at is null
        order by r.ended_at limit $3`,
      [tenantId, endedBefore, limit]);
  }

  async listUserRunsForPurge(tenantId: string, userId: string): Promise<Run[]> {
    return this.q<Run>(tenantId,
      `select ${RUN_COLUMNS} from runs r
         join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1 and j.requested_by = $2
          and r.status in ('completed', 'failed', 'cancelled', 'expired')
          and r.google_data_redacted_at is null`,
      [tenantId, userId]);
  }

  async markRunRetention(
    tenantId: string, runId: string, steps: RunStep[] | null, redactedPresent: string, at: string,
  ): Promise<void> {
    await this.inTenant(tenantId, async (client) => {
      if (steps) {
        for (const s of steps) {
          await client.query(
            `update run_steps set input = $3, output = $4
              where id = $2 and run_id in (select id from runs where tenant_id = $1)`,
            [tenantId, s.id, s.input === null ? null : JSON.stringify(s.input), s.output === null ? null : JSON.stringify(s.output)]);
        }
        await client.query(
          `update approvals set present = $3
            where tenant_id = $1 and run_step_id in (select id from run_steps where run_id = $2)`,
          [tenantId, runId, redactedPresent]);
        // その実行の通知の本文も消す（ブリーフの通知は、予定やメールから作った文を本文に持つ。仕様書 第14.3.2節）
        await client.query(
          `update notifications set body = $3 where tenant_id = $1 and run_id = $2`,
          [tenantId, runId, redactedPresent]);
      }
      await client.query(
        `update runs set google_data_checked_at = $3,
                         google_data_redacted_at = case when $4 then $3::timestamptz else google_data_redacted_at end
          where tenant_id = $1 and id = $2`,
        [tenantId, runId, at, steps !== null]);
    });
  }

  async updateApproval(a: Approval): Promise<void> {
    await this.q(a.tenantId, 
      `update approvals set decision=$3, decided_by=$4, comment=$5, decided_at=$6
         where tenant_id=$1 and id=$2`,
      [a.tenantId, a.id, a.decision, a.decidedBy, a.comment, a.decidedAt],
    );
  }

  async createArtifact(a: Artifact): Promise<void> {
    await this.q(a.tenantId, 
      `insert into artifacts (id, run_id, tenant_id, kind, title, body, file_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a.id, a.runId, a.tenantId, a.kind, a.title, a.body, a.fileId ?? null, a.createdAt],
    );
  }

  async listArtifacts(tenantId: string, runId: string): Promise<Artifact[]> {
    return this.q<Artifact>(tenantId, 
      `select id, run_id as "runId", tenant_id as "tenantId", kind, title, body,
              file_id as "fileId", created_at as "createdAt"
         from artifacts where tenant_id = $1 and run_id = $2 order by created_at`,
      [tenantId, runId],
    );
  }

  /**
   * 組織知識を検索する（仕様書 第11.7.3節）。
   *
   * @remarks
   * 権限区画: 区画外の利用者には区画内の節を返さない。
   * 「権限がない」ではなく、候補にも出さない（仕様書 第16.3.5節）。
   *
   * データベースでは、質問の言葉の 2 文字の組を 1 つでも含む節を候補として絞るだけにし、
   * 並べ方は `rankSections` で決める。pg_bigm の索引を足しても結果は変わらない（ADR-0008）。
   */
  async searchKnowledge(
    tenantId: string,
    query: string,
    compartment: string | null,
    extraSynonyms: readonly (readonly string[])[] = [],
    opts: KnowledgeSearchOptions = {},
  ): Promise<KnowledgeSearchResult> {
    const terms = extractTerms(query);
    if (terms.length === 0) return { hits: [], rewrites: [] };
    // 施行日を迎えた規程の版に切り替えてから探す（夜中の処理を待たない。第11.11.2節）
    await this.applyDueVersions(tenantId);
    await this.resplitStaleKnowledge(tenantId);
    // 言い換え（標準・以前に登録した組・秘書が考えたもの）を足す（第11.7.7節・第11.7.7.0節）
    const { knowledge } = await this.getTenantSettings(tenantId);
    const concepts = expandTerms(terms, [
      ...(knowledge.standardSynonyms ? STANDARD_SYNONYMS : []), ...knowledge.synonyms, ...extraSynonyms,
    ]);
    const patterns = [...new Set(concepts.flatMap((c) => c.alternatives.flatMap(bigrams)))].map((g) => `%${escapeLike(g)}%`);
    const rows = await this.q<{
      id: string; title: string; heading: string; path: string[]; body: string; source: string;
      compartment: string | null; updatedAt: string; category: 'rule' | 'minutes' | 'learned';
    }>(tenantId,
      `select s.item_id as id, k.title, s.heading, s.path, s.body, k.source, s.compartment,
              k.updated_at as "updatedAt", k.category
         from knowledge_sections s
         join knowledge_items k on k.id = s.item_id and k.tenant_id = s.tenant_id
        where s.tenant_id = $1
          and k.status = 'active'
          and ($5::text[] is null or k.category = any($5::text[]))
          and (s.compartment is null or s.compartment = $3)
          and s.search_text like any($2)
        order by (select count(*) from unnest($2::text[]) p where s.search_text like p) desc,
                 k.updated_at desc
        limit $4`,
      [tenantId, patterns, compartment, SEARCH_CANDIDATES, opts.categories ?? null],
    );
    const ranked = rankSections(concepts, rows);
    const hits: KnowledgeSearchResult['hits'] = ranked.map((r) => ({
      id: r.id, title: r.title, heading: r.heading, path: r.path, citation: citationOf(r.title, r),
      body: r.body, source: r.source, compartment: r.compartment, score: Math.round(r.score * 100) / 100, category: r.category,
    }));
    // 改定前の規程を尋ねられたら、古い版からも探し、版と施行日を添える（第11.11.2節）
    if (asksOldVersion(query) && (!opts.categories || opts.categories.includes('rule'))) {
      hits.push(...await this.searchOldVersions(tenantId, concepts, patterns, compartment));
    }
    if (opts.touch !== false && hits.length > 0) {
      await this.touchKnowledge(tenantId, [...new Set(hits.filter((h) => !h.oldVersion).map((h) => h.id))], new Date().toISOString()).catch(() => undefined);
    }
    return { hits, rewrites: rewritesOf(concepts, ranked) };
  }

  /** 社内規程の古い版の節から探す（改定前を尋ねられたとき）。古い版は節に分けて持たないため、ここで分ける。 */
  private async searchOldVersions(
    tenantId: string, concepts: ReturnType<typeof expandTerms>, patterns: string[], compartment: string | null,
  ): Promise<KnowledgeSearchResult['hits']> {
    const versions = await this.q<{
      id: string; version: number; effectiveFrom: string; title: string; body: string; source: string; compartment: string | null; savedAt: string;
    }>(tenantId,
      `select v.item_id as id, v.version, v.effective_from::text as "effectiveFrom", v.title, v.body, v.source, v.compartment,
              v.saved_at as "savedAt"
         from knowledge_item_versions v
         join knowledge_items k on k.id = v.item_id and k.tenant_id = v.tenant_id
        where v.tenant_id = $1 and k.status = 'active' and k.category = 'rule' and v.version < k.version
          and (v.compartment is null or v.compartment = $2)
          and v.body like any($3)
        order by v.saved_at desc limit $4`,
      [tenantId, compartment, patterns, OLD_VERSION_SCAN]);
    const candidates = versions.flatMap((v) => splitKnowledge(v.body).map((x) => ({
      id: v.id, title: v.title, heading: x.heading, path: x.path, body: x.body, source: v.source, compartment: v.compartment,
      updatedAt: v.savedAt, category: 'rule' as const, oldVersion: { version: v.version, effectiveFrom: v.effectiveFrom },
    })));
    return rankSections(concepts, candidates).slice(0, 3).map((r) => ({
      id: r.id, title: r.title, heading: r.heading, path: r.path,
      citation: `${citationOf(r.title, r)}（第 ${r.oldVersion.version} 版・${r.oldVersion.effectiveFrom} 施行）`,
      body: r.body, source: r.source, compartment: r.compartment, score: Math.round(r.score * 100) / 100, category: 'rule' as const,
      oldVersion: r.oldVersion,
    }));
  }

  /**
   * 施行日を迎えた社内規程の版を、施行している版に写して節に分け直す（第11.11.2節）。
   * 検索と一覧の前に呼ぶ。同じ規程に施行日を迎えた版がいくつもあれば、いちばん新しい版にする。
   */
  private async applyDueVersions(tenantId: string): Promise<void> {
    const due = await this.q<{ id: string; version: number; effectiveFrom: string; title: string; body: string; source: string; compartment: string | null }>(tenantId,
      `select distinct on (v.item_id) v.item_id as id, v.version, v.effective_from::text as "effectiveFrom", v.title, v.body, v.source, v.compartment
         from knowledge_item_versions v
         join knowledge_items k on k.id = v.item_id and k.tenant_id = v.tenant_id
        where v.tenant_id = $1 and k.status = 'active' and v.version > k.version and v.effective_from <= $2::date
        order by v.item_id, v.version desc`,
      [tenantId, jstToday()]);
    for (const v of due) {
      await this.inTenant(tenantId, async (client) => {
        await client.query(
          `update knowledge_items set title = $3, body = $4, source = $5, compartment = $6, version = $7,
                  effective_from = $8::date, updated_at = now()
            where tenant_id = $1 and id = $2 and version < $7`,
          [tenantId, v.id, v.title, v.body, v.source, v.compartment, v.version, v.effectiveFrom]);
        await this.writeSections(client, tenantId, v);
      });
    }
  }

  /** 古い分け方で分けた（または、まだ分けていない）知識を分け直す（第11.7.5節）。 */
  private async resplitStaleKnowledge(tenantId: string): Promise<void> {
    const stale = await this.q<{ id: string; title: string; body: string; compartment: string | null }>(tenantId,
      `select id, title, body, compartment from knowledge_items
        where tenant_id = $1 and split_version < $2`, [tenantId, SPLIT_VERSION]);
    for (const k of stale) {
      await this.inTenant(tenantId, (client) => this.writeSections(client, tenantId, k));
    }
  }

  /** 1 件の知識の節を作り直す。呼び出し側のトランザクションの中で使う。 */
  private async writeSections(
    client: pg.PoolClient, tenantId: string,
    k: { id: string; title: string; body: string; compartment: string | null },
  ): Promise<void> {
    const sections = splitKnowledge(k.body);
    await client.query(`delete from knowledge_sections where tenant_id = $1 and item_id = $2`, [tenantId, k.id]);
    if (sections.length > 0) {
      await client.query(
        `insert into knowledge_sections (tenant_id, item_id, ordinal, heading, path, body, search_text, compartment)
         select $1, $2, t.ordinal, t.heading, array(select jsonb_array_elements_text(t.path)),
                t.body, t.search_text, $3
           from jsonb_to_recordset($4::jsonb)
             as t(ordinal int, heading text, path jsonb, body text, search_text text)`,
        [tenantId, k.id, k.compartment, JSON.stringify(sections.map((x) => ({
          ...x, search_text: normalizeForSearch([...x.path, x.heading, x.body].join('\n')),
        })))],
      );
    }
    await client.query(`update knowledge_items set split_version = $3 where tenant_id = $1 and id = $2`,
      [tenantId, k.id, SPLIT_VERSION]);
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.q(e.tenantId, 
      `insert into audit_events (id, tenant_id, actor_type, actor_id, action,
                                 target_type, target_id, detail, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.id, e.tenantId, e.actorType, e.actorId, e.action, e.targetType,
       e.targetId, JSON.stringify(e.detail), e.occurredAt],
    );
  }

  async searchAudit(tenantId: string, q: AuditQuery): Promise<AuditEvent[]> {
    return this.q<AuditEvent>(tenantId,
      `select a.id, a.tenant_id as "tenantId", a.actor_type as "actorType",
              a.actor_id as "actorId", a.action, a.target_type as "targetType",
              a.target_id as "targetId", a.detail, a.occurred_at as "occurredAt"
         from audit_events a
        where a.tenant_id = $1
          and ($2::timestamptz is null or a.occurred_at >= $2)
          and ($3::timestamptz is null or a.occurred_at < $3)
          and ($4::text is null or a.actor_id = $4 or (a.detail->>'runId') in (
                select r.id from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
                 where r.tenant_id = $1 and j.requested_by = $4))
          and ($5::text[] is null or a.action like any($5))
        order by a.occurred_at desc, a.id desc
        limit $6 offset $7`,
      [tenantId, q.from ?? null, q.to ?? null, q.userId ?? null,
        q.actions && q.actions.length > 0 ? q.actions.map((x) => `${x.replace(/[%_]/g, '\\$&')}%`) : null,
        q.limit, q.offset ?? 0]);
  }

  async listAudit(tenantId: string, limit: number): Promise<AuditEvent[]> {
    return this.q<AuditEvent>(tenantId, 
      `select id, tenant_id as "tenantId", actor_type as "actorType",
              actor_id as "actorId", action, target_type as "targetType",
              target_id as "targetId", detail, occurred_at as "occurredAt"
         from audit_events where tenant_id = $1
        order by occurred_at desc limit $2`,
      [tenantId, limit],
    );
  }

  async createNotification(n: Notification): Promise<void> {
    await this.q(n.tenantId, 
      `insert into notifications (id, tenant_id, user_id, kind, title, body, run_id,
                                  read_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [n.id, n.tenantId, n.userId, n.kind, n.title, n.body, n.runId, n.readAt, n.createdAt],
    );
  }

  async listNotifications(tenantId: string, userId: string, limit: number): Promise<Notification[]> {
    return this.q<Notification>(tenantId, 
      `select id, tenant_id as "tenantId", user_id as "userId", kind, title, body,
              run_id as "runId", read_at as "readAt", created_at as "createdAt",
              delivered_at as "deliveredAt"
         from notifications where tenant_id = $1 and user_id = $2
        order by created_at desc limit $3`,
      [tenantId, userId, limit],
    );
  }

  async listUndeliveredNotifications(tenantId: string, limit: number): Promise<Notification[]> {
    return this.q<Notification>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", kind, title, body,
              run_id as "runId", read_at as "readAt", created_at as "createdAt",
              delivered_at as "deliveredAt", delivery_note as "deliveryNote"
         from notifications where tenant_id = $1 and delivered_at is null
        order by created_at limit $2`,
      [tenantId, limit],
    );
  }

  async markNotificationDelivered(
    tenantId: string, id: string, deliveredAt: string | null, note: string,
  ): Promise<void> {
    await this.q(tenantId,
      `update notifications set delivered_at = $3, delivery_note = $4
        where tenant_id = $1 and id = $2`,
      [tenantId, id, deliveredAt, note],
    );
  }

  async deleteNotifications(tenantId: string, userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from notifications where tenant_id = $1 and user_id = $2 and id = any($3::text[]) returning id`,
      [tenantId, userId, ids],
    );
    return rows.length;
  }

  async markNotificationRead(tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, 
      `update notifications set read_at = coalesce(read_at, now())
        where tenant_id = $1 and user_id = $2 and id = $3 returning id`,
      [tenantId, userId, id],
    );
    return rows.length > 0;
  }

  async createSchedule(s: Schedule): Promise<void> {
    await this.q(s.tenantId, 
      `insert into schedules (id, tenant_id, user_id, agent_id, agent_version, input, rule,
                              timezone, enabled, next_run_at, last_run_at, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [s.id, s.tenantId, s.userId, s.agentId, s.agentVersion, JSON.stringify(s.input),
       JSON.stringify(s.rule), s.timezone, s.enabled, s.nextRunAt, s.lastRunAt,
       s.createdBy, s.createdAt],
    );
  }

  async listSchedules(tenantId: string, userId: string | null): Promise<Schedule[]> {
    return this.q<Schedule>(tenantId, 
      `select ${SCHEDULE_COLUMNS} from schedules
        where tenant_id = $1 and ($2::text is null or user_id = $2)
        order by created_at`,
      [tenantId, userId],
    );
  }

  async getSchedule(tenantId: string, id: string): Promise<Schedule | null> {
    const rows = await this.q<Schedule>(tenantId, 
      `select ${SCHEDULE_COLUMNS} from schedules where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }

  async updateSchedule(s: Schedule): Promise<void> {
    await this.q(s.tenantId, 
      `update schedules set input=$3, rule=$4, timezone=$5, enabled=$6, next_run_at=$7,
                            last_run_at=$8
         where tenant_id=$1 and id=$2`,
      [s.tenantId, s.id, JSON.stringify(s.input), JSON.stringify(s.rule), s.timezone,
       s.enabled, s.nextRunAt, s.lastRunAt],
    );
  }

  async deleteSchedule(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from schedules where tenant_id = $1 and id = $2 returning id`,
      [tenantId, id],
    );
    return rows.length > 0;
  }

  async claimDueSchedule(
    now: Date,
    computeNext: (s: Schedule) => string,
  ): Promise<Schedule | null> {
    // 候補の一覧だけはテナントを横断して取る（security definer の関数）。
    // 確保と更新は、そのテナントの範囲のトランザクションで行う
    const candidates = await this.q<{ id: string; tenant_id: string }>(
      null, `select id, tenant_id from m2o_due_schedules($1, 20)`, [now.toISOString()],
    );
    for (const c of candidates) {
      const claimed = await this.inTenant(c.tenant_id, async (client) => {
        const res = await client.query<Schedule>(
          `select ${SCHEDULE_COLUMNS} from schedules
            where id = $1 and enabled and next_run_at <= $2
            for update skip locked`,
          [c.id, now.toISOString()],
        );
        const due = res.rows[0];
        if (!due) return null;
        await client.query(
          `update schedules set next_run_at = $2, last_run_at = $3 where id = $1`,
          [due.id, computeNext(due), now.toISOString()],
        );
        return due;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  async createSession(s: Session): Promise<void> {
    await this.q(s.tenantId, 
      `insert into sessions (id, tenant_id, user_id, csrf_token, provider, user_agent,
                             created_at, last_seen_at, expires_at, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [s.id, s.tenantId, s.userId, s.csrfToken, s.provider, s.userAgent, s.createdAt,
       s.lastSeenAt, s.expiresAt, s.revokedAt],
    );
  }

  async findActiveSession(tenantId: string, id: string, now: Date): Promise<Session | null> {
    const rows = await this.q<Session>(tenantId, 
      `select id, tenant_id as "tenantId", user_id as "userId", csrf_token as "csrfToken",
              provider, user_agent as "userAgent", created_at as "createdAt",
              last_seen_at as "lastSeenAt", expires_at as "expiresAt",
              revoked_at as "revokedAt"
         from sessions where id = $1 and revoked_at is null and expires_at > $2`,
      [id, now.toISOString()],
    );
    return rows[0] ?? null;
  }

  async touchSession(tenantId: string, id: string, now: Date): Promise<void> {
    await this.q(tenantId, `update sessions set last_seen_at = $2 where id = $1`, [id, now.toISOString()]);
  }

  async revokeSession(tenantId: string, id: string, now: Date): Promise<void> {
    await this.q(tenantId, 
      `update sessions set revoked_at = coalesce(revoked_at, $2) where id = $1`,
      [id, now.toISOString()],
    );
  }

  async getTenantSettings(tenantId: string): Promise<TenantSettings> {
    const rows = await this.q<{
      company: TenantSettings['company'] | null; writing_style: TenantSettings['writingStyle'] | null;
      automation: TenantSettings['automation'] | null; agents: TenantSettings['agents'] | null;
      effect: TenantSettings['effect'] | null; onboarding: TenantSettings['onboarding'] | null;
      access: TenantSettings['access'] | null; slides: TenantSettings['slides'] | null;
      knowledge: TenantSettings['knowledge'] | null; privacy: TenantSettings['privacy'] | null;
      dashboard: TenantSettings['dashboard'] | null; invoice: TenantSettings['invoice'] | null;
      cards: TenantSettings['cards'] | null; inventory: Partial<TenantSettings['inventory']> | null;
      hr: Partial<TenantSettings['hr']> | null; signage: Partial<TenantSettings['signage']> | null;
      ai_policy: Partial<TenantSettings['aiPolicy']> | null; web_columns: Partial<TenantSettings['webColumns']> | null;
      inquiries: Partial<TenantSettings['inquiries']> | null;
      competitors: Partial<TenantSettings['competitors']> | null;
      announcements: Partial<TenantSettings['announcements']> | null;
      web_review: Partial<TenantSettings['webReview']> | null;
    }>(tenantId, `select company, writing_style, automation, agents, effect, onboarding, access, slides, knowledge, privacy, dashboard, invoice, cards, inventory, hr, signage, ai_policy, web_columns, inquiries, competitors, announcements, web_review
                    from tenant_settings where tenant_id = $1`,
      [tenantId]);
    const r = rows[0];
    const d = DEFAULT_TENANT_SETTINGS;
    return {
      company: { ...d.company, ...(r?.company ?? {}) },
      writingStyle: { ...d.writingStyle, ...(r?.writing_style ?? {}) },
      automation: r?.automation ?? d.automation,
      agents: { ...d.agents, ...(r?.agents ?? {}) },
      effect: { minutesPerRun: { ...(r?.effect?.minutesPerRun ?? {}) } },
      onboarding: { ...d.onboarding, ...(r?.onboarding ?? {}) },
      access: { scopes: { ...(r?.access?.scopes ?? {}) } },
      slides: { templates: [...(r?.slides?.templates ?? [])] },
      knowledge: {
        standardSynonyms: r?.knowledge?.standardSynonyms ?? d.knowledge.standardSynonyms,
        synonyms: [...(r?.knowledge?.synonyms ?? [])],
      },
      privacy: { ...d.privacy, ...(r?.privacy ?? {}) },
      dashboard: { ...d.dashboard, ...(r?.dashboard ?? {}) },
      invoice: { ...d.invoice, ...(r?.invoice ?? {}) },
      cards: { ...d.cards, ...(r?.cards ?? {}) },
      inventory: { ...d.inventory, ...(r?.inventory ?? {}), features: { ...d.inventory.features, ...(r?.inventory?.features ?? {}) } },
      hr: {
        ...d.hr, ...(r?.hr ?? {}),
        office: { ...d.hr.office, ...(r?.hr?.office ?? {}) },
        health: { ...d.hr.health, ...(r?.hr?.health ?? {}) },
        pay: { ...d.hr.pay, ...(r?.hr?.pay ?? {}) },
        work: { ...d.hr.work, ...(r?.hr?.work ?? {}) },
        agreement: { ...d.hr.agreement, ...(r?.hr?.agreement ?? {}) },
        leave: { ...d.hr.leave, ...(r?.hr?.leave ?? {}) },
        payroll: {
          ...d.hr.payroll, ...(r?.hr?.payroll ?? {}),
          premiums: { ...d.hr.payroll.premiums, ...(r?.hr?.payroll?.premiums ?? {}) },
          kumiai: { ...d.hr.payroll.kumiai, ...(r?.hr?.payroll?.kumiai ?? {}) },
        },
        transfer: { ...d.hr.transfer, ...(r?.hr?.transfer ?? {}) },
        duties: { ...d.hr.duties, ...(r?.hr?.duties ?? {}) },
        notice: { ...d.hr.notice, ...(r?.hr?.notice ?? {}) },
        insurance: { ...d.hr.insurance, ...(r?.hr?.insurance ?? {}) },
        labor: { ...d.hr.labor, ...(r?.hr?.labor ?? {}) },
        shift: { ...d.hr.shift, ...(r?.hr?.shift ?? {}) },
      },
      signage: { ...d.signage, ...(r?.signage ?? {}) },
      aiPolicy: { ...d.aiPolicy, ...(r?.ai_policy ?? {}) },
      webColumns: { ...d.webColumns, ...(r?.web_columns ?? {}) },
      inquiries: { ...d.inquiries, ...(r?.inquiries ?? {}) },
      competitors: { ...d.competitors, ...(r?.competitors ?? {}) },
      announcements: { ...d.announcements, ...(r?.announcements ?? {}) },
      webReview: { ...d.webReview, ...(r?.web_review ?? {}) },
    };
  }

  async saveTenantSettings<K extends keyof TenantSettings>(
    tenantId: string, section: K, value: TenantSettings[K], updatedBy: string,
  ): Promise<void> {
    const column = ({
      company: 'company', writingStyle: 'writing_style', automation: 'automation', agents: 'agents',
      effect: 'effect', onboarding: 'onboarding', access: 'access', slides: 'slides', knowledge: 'knowledge', privacy: 'privacy',
      dashboard: 'dashboard', invoice: 'invoice', cards: 'cards', inventory: 'inventory', hr: 'hr', signage: 'signage',
      aiPolicy: 'ai_policy', webColumns: 'web_columns', inquiries: 'inquiries', competitors: 'competitors', announcements: 'announcements', webReview: 'web_review',
    } as const)[section];
    // 列名は上の固定の対応表からのみ取る。利用者の入力を SQL に埋め込まない
    await this.q(tenantId,
      `insert into tenant_settings (tenant_id, ${column}, updated_by, updated_at)
       values ($1, $2, $3, now())
       on conflict (tenant_id) do update
         set ${column} = excluded.${column}, updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, JSON.stringify(value), updatedBy]);
  }

  async createUser(u: User): Promise<void> {
    await this.q(u.tenantId,
      `insert into users (id, tenant_id, email, display_name, roles, status)
       values ($1,$2,$3,$4,$5,$6)`,
      [u.id, u.tenantId, u.email, u.displayName, u.roles, u.status]);
  }

  async updateUser(u: User): Promise<void> {
    await this.q(u.tenantId,
      // 止めた日時を持つ（止めてから 30 日で自分だけの名刺を削除するため。第27.7節、Q-94）。戻したら空にする
      `update users set display_name = $3, roles = $4, status = $5,
              disabled_at = case when $5 = 'disabled' then coalesce(disabled_at, now()) else null end
        where tenant_id = $1 and id = $2`,
      [u.tenantId, u.id, u.displayName, u.roles, u.status]);
  }

  async listKnowledge(tenantId: string, opts: { all?: boolean } = {}): Promise<KnowledgeItem[]> {
    await this.applyDueVersions(tenantId);
    return this.q<KnowledgeItem>(tenantId,
      `select ${KNOWLEDGE_COLUMNS},
              (select count(*)::int from knowledge_sections s
                where s.tenant_id = k.tenant_id and s.item_id = k.id) as "sectionCount",
              (select json_build_object('version', v.version, 'effectiveFrom', v.effective_from::text)
                 from knowledge_item_versions v
                where v.tenant_id = k.tenant_id and v.item_id = k.id and v.version > k.version
                order by v.version desc limit 1) as pending
         from knowledge_items k where k.tenant_id = $1 and ($2 or k.status = 'active') order by k.updated_at desc`,
      [tenantId, !!opts.all]);
  }

  async saveKnowledge(k: KnowledgeItem): Promise<void> {
    // 種類は登録の経路で決める（第11.11.1節）。最初の登録のときだけ書く
    const category = k.category ?? (k.kind === 'promoted' ? 'learned' : k.originRunId ? 'minutes' : 'rule');
    await this.inTenant(k.tenantId, async (client) => {
      const res = await client.query(
        `insert into knowledge_items
           (id, tenant_id, kind, title, body, source, compartment, updated_at, origin_run_id, google_derived, category, last_used_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8)
         on conflict (id) do update set kind = excluded.kind, title = excluded.title,
           body = excluded.body, source = excluded.source, compartment = excluded.compartment,
           updated_at = excluded.updated_at, version = knowledge_items.version + 1
         where knowledge_items.tenant_id = excluded.tenant_id`,
        // 由来（origin_run_id・google_derived）は最初の登録のときだけ書く。上書きの対象に入れない（第9.5.2節）
        [k.id, k.tenantId, k.kind, k.title, k.body, k.source, k.compartment, k.updatedAt,
          k.originRunId ?? null, k.googleDerived ?? false, category]);
      // 他社の同じ ID には書かない（上の where で更新されない）。その場合は節も作らない
      if (res.rowCount === 0) return;
      await this.writeSections(client, k.tenantId, k);
    });
  }

  async listKnowledgeSections(tenantId: string, itemId: string): Promise<KnowledgeSectionView[] | null> {
    const found = await this.q<{ id: string }>(tenantId,
      `select id from knowledge_items where tenant_id = $1 and id = $2`, [tenantId, itemId]);
    if (found.length === 0) return null;
    await this.resplitStaleKnowledge(tenantId);
    return this.q<KnowledgeSectionView>(tenantId,
      `select heading, path, char_length(body) as chars from knowledge_sections
        where tenant_id = $1 and item_id = $2 order by ordinal`, [tenantId, itemId]);
  }

  async saveRuleVersion(k: KnowledgeItem & { effectiveFrom: string }, savedBy: string, today: string): Promise<{ version: number; applied: boolean } | null> {
    return this.inTenant(k.tenantId, async (client) => {
      const found = await client.query<{ version: number }>(
        `select version from knowledge_items where tenant_id = $1 and id = $2 for update`, [k.tenantId, k.id]);
      if (found.rowCount === 0) {
        // 新しい規程。施行日にかかわらず、すぐに探せるようにする（前の版が無いため）
        const res = await client.query(
          `insert into knowledge_items (id, tenant_id, kind, title, body, source, compartment, updated_at, category, effective_from, last_used_at)
           values ($1,$2,$3,$4,$5,$6,$7,now(),'rule',$8::date,now()) on conflict (id) do nothing`,
          [k.id, k.tenantId, k.kind, k.title, k.body, k.source, k.compartment, k.effectiveFrom]);
        // ほかの会社の同じ ID（行レベルセキュリティで見えない）には書かない
        if (res.rowCount === 0) return null;
        await client.query(
          `insert into knowledge_item_versions (tenant_id, item_id, version, effective_from, title, body, source, compartment, saved_by)
           values ($1,$2,1,$3::date,$4,$5,$6,$7,$8)`,
          [k.tenantId, k.id, k.effectiveFrom, k.title, k.body, k.source, k.compartment, savedBy]);
        await this.writeSections(client, k.tenantId, k);
        return { version: 1, applied: true };
      }
      const max = await client.query<{ v: number }>(
        `select coalesce(max(version), 0)::int as v from knowledge_item_versions where tenant_id = $1 and item_id = $2`, [k.tenantId, k.id]);
      const version = Math.max(max.rows[0]!.v, found.rows[0]!.version) + 1;
      await client.query(
        `insert into knowledge_item_versions (tenant_id, item_id, version, effective_from, title, body, source, compartment, saved_by)
         values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9)`,
        [k.tenantId, k.id, version, k.effectiveFrom, k.title, k.body, k.source, k.compartment, savedBy]);
      if (k.effectiveFrom > today) return { version, applied: false };
      await client.query(
        `update knowledge_items set title = $3, body = $4, source = $5, compartment = $6, version = $7, effective_from = $8::date,
                updated_at = now() where tenant_id = $1 and id = $2`,
        [k.tenantId, k.id, k.title, k.body, k.source, k.compartment, version, k.effectiveFrom]);
      await this.writeSections(client, k.tenantId, k);
      return { version, applied: true };
    });
  }

  async listKnowledgeVersions(tenantId: string, itemId: string): Promise<KnowledgeVersion[] | null> {
    const found = await this.q<{ id: string }>(tenantId, `select id from knowledge_items where tenant_id = $1 and id = $2`, [tenantId, itemId]);
    if (found.length === 0) return null;
    return this.q<KnowledgeVersion>(tenantId,
      `select ${VERSION_COLUMNS}, '' as body from knowledge_item_versions v
         join knowledge_items k on k.id = v.item_id and k.tenant_id = v.tenant_id
        where v.tenant_id = $1 and v.item_id = $2 order by v.version desc`, [tenantId, itemId]);
  }

  async getKnowledgeVersion(tenantId: string, itemId: string, version: number): Promise<KnowledgeVersion | null> {
    const rows = await this.q<KnowledgeVersion>(tenantId,
      `select ${VERSION_COLUMNS}, v.body from knowledge_item_versions v
         join knowledge_items k on k.id = v.item_id and k.tenant_id = v.tenant_id
        where v.tenant_id = $1 and v.item_id = $2 and v.version = $3`, [tenantId, itemId, version]);
    return rows[0] ?? null;
  }

  async setKnowledgeStatus(tenantId: string, id: string, status: KnowledgeStatus, reason: string | null, mergedInto: string | null, at: string): Promise<boolean> {
    // 戻したものは、使った日を戻した日にする（戻した直後に「使われない」でしまわないように）
    const rows = await this.q<{ id: string }>(tenantId,
      `update knowledge_items set status = $3, status_at = $6, status_reason = $4, merged_into = $5,
              last_used_at = case when $3 = 'active' then $6::timestamptz else last_used_at end
        where tenant_id = $1 and id = $2 and status <> $3 returning id`,
      [tenantId, id, status, reason, mergedInto, at]);
    return rows.length > 0;
  }

  async touchKnowledge(tenantId: string, ids: string[], at: string): Promise<void> {
    if (ids.length === 0) return;
    await this.q(tenantId, `update knowledge_items set last_used_at = $3 where tenant_id = $1 and id = any($2::text[])`, [tenantId, ids, at]);
  }

  async purgeKnowledge(tenantId: string, now: Date): Promise<{ items: number; versions: number }> {
    const year = new Date(now.getTime() - 365 * 86_400_000).toISOString();
    const seven = new Date(now.getTime() - 7 * 365 * 86_400_000).toISOString();
    const items = await this.q<{ id: string }>(tenantId,
      `delete from knowledge_items where tenant_id = $1 and (
          (category = 'learned' and status = 'archived' and status_at < $2)
       or (category = 'minutes' and status = 'retired' and status_at < $2)
       or (category = 'rule' and status = 'retired' and status_at < $3)) returning id`, [tenantId, year, seven]);
    // 古い版は、次の版が施行されてから 7 年で消す（施行している版と施行日が先の版は消さない）
    const versions = await this.q<{ version: number }>(tenantId,
      `delete from knowledge_item_versions v using knowledge_items k
        where v.tenant_id = $1 and k.tenant_id = v.tenant_id and k.id = v.item_id and v.version < k.version
          and (select min(n.effective_from) from knowledge_item_versions n
                where n.tenant_id = v.tenant_id and n.item_id = v.item_id and n.version > v.version) < $2::date
        returning v.version`, [tenantId, seven.slice(0, 10)]);
    return { items: items.length, versions: versions.length };
  }

  async setRuleHrCheck(tenantId: string, itemId: string, version: number, check: unknown): Promise<void> {
    await this.q(tenantId,
      `update knowledge_item_versions set hr_check = $4::jsonb, hr_check_dismissed_at = null
        where tenant_id = $1 and item_id = $2 and version = $3`, [tenantId, itemId, version, JSON.stringify(check)]);
  }

  async listRuleHrChecks(tenantId: string): Promise<KnowledgeVersion[]> {
    return this.q<KnowledgeVersion>(tenantId,
      `select ${VERSION_COLUMNS}, '' as body from knowledge_item_versions v
         join knowledge_items k on k.id = v.item_id and k.tenant_id = v.tenant_id
        where v.tenant_id = $1 and k.status = 'active' and v.hr_check is not null and v.hr_check_dismissed_at is null
        order by v.saved_at desc limit 10`, [tenantId]);
  }

  async dismissRuleHrCheck(tenantId: string, itemId: string, version: number, at: string): Promise<boolean> {
    const rows = await this.q<{ version: number }>(tenantId,
      `update knowledge_item_versions set hr_check_dismissed_at = $4
        where tenant_id = $1 and item_id = $2 and version = $3 and hr_check is not null returning version`, [tenantId, itemId, version, at]);
    return rows.length > 0;
  }

  async deleteKnowledge(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from knowledge_items where tenant_id = $1 and id = $2 returning id`, [tenantId, id]);
    return rows.length > 0;
  }

  async listCompartments(tenantId: string) {
    return this.q<{ id: string; name: string; description: string | null }>(tenantId,
      `select id, name, description from compartments where tenant_id = $1 and enabled order by name`,
      [tenantId]);
  }

  async appendConversation(c: Conversation): Promise<void> {
    await this.q(c.tenantId,
      `insert into conversations
         (id, tenant_id, user_id, message, reply, layer, agent_id, run_id, search_text, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.id, c.tenantId, c.userId, c.message, c.reply, c.layer, c.agentId, c.runId,
        normalizeForSearch(`${c.message} ${c.reply}`), c.createdAt]);
  }

  async listConversations(
    tenantId: string, userId: string, opts: { query?: string; limit: number },
  ): Promise<Conversation[]> {
    const query = (opts.query ?? '').trim();
    const like = `%${escapeLike(normalizeForSearch(query))}%`;
    return this.q<Conversation>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", message, reply, layer,
              agent_id as "agentId", run_id as "runId", created_at as "createdAt"
         from conversations
        where tenant_id = $1 and user_id = $2 and ($3 = '' or search_text like $4 escape '\\')
        order by created_at desc limit $5`,
      [tenantId, userId, query, like, opts.limit]);
  }

  async deleteConversation(tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from conversations where tenant_id = $1 and user_id = $2 and id = $3 returning id`,
      [tenantId, userId, id]);
    return rows.length > 0;
  }

  async clearConversations(tenantId: string, userId: string, since?: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from conversations
        where tenant_id = $1 and user_id = $2 and ($3::timestamptz is null or created_at >= $3)
        returning id`,
      [tenantId, userId, since ?? null]);
    return rows.length;
  }

  async linkConversationRun(
    tenantId: string, userId: string, runId: string, since: string,
  ): Promise<void> {
    await this.q(tenantId,
      `update conversations set run_id = $3
        where id = (select id from conversations
                     where tenant_id = $1 and user_id = $2 and run_id is null and created_at >= $4
                     order by created_at desc limit 1)`,
      [tenantId, userId, runId, since]);
  }

  async deleteConversationsBefore(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from conversations where tenant_id = $1 and created_at < $2 returning id`,
      [tenantId, before]);
    return rows.length;
  }

  async listConversationsOfDay(
    tenantId: string, userId: string, day: { from: string; to: string },
  ): Promise<Conversation[]> {
    return this.q<Conversation>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", message, reply, layer,
              agent_id as "agentId", run_id as "runId", created_at as "createdAt"
         from conversations
        where tenant_id = $1 and user_id = $2 and created_at >= $3 and created_at < $4
        order by created_at`,
      [tenantId, userId, day.from, day.to]);
  }

  async getConversation(tenantId: string, id: string): Promise<Conversation | null> {
    const rows = await this.q<Conversation>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", message, reply, layer,
              agent_id as "agentId", run_id as "runId", created_at as "createdAt"
         from conversations where tenant_id = $1 and id = $2`,
      [tenantId, id]);
    return rows[0] ?? null;
  }

  async claimAgentEvent(): Promise<{ id: string; tenantId: string } | null> {
    // テナントを横断してイベントを見るのはこの関数だけであり、データベース側の関数（security definer）に閉じ込めている
    const rows = await this.q<{ id: string; tenantId: string }>(null,
      `select id, tenant_id as "tenantId" from m2o_claim_agent_event()`);
    return rows[0] ?? null;
  }

  async getAgentEvent(tenantId: string, id: string): Promise<AgentEvent | null> {
    const rows = await this.q<AgentEvent>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", kind, run_id as "runId",
              conversation_id as "conversationId", plan_id as "planId", status, created_at as "createdAt", attempts,
              processed_at as "processedAt", last_error as "lastError"
         from agent_events where tenant_id = $1 and id = $2`,
      [tenantId, id]);
    return rows[0] ?? null;
  }

  async finishAgentEvent(tenantId: string, id: string, error: string | null): Promise<void> {
    await this.q(tenantId,
      error === null
        ? `update agent_events set processed_at = now(), last_error = null where tenant_id = $1 and id = $2`
        : `update agent_events set last_error = $3 where tenant_id = $1 and id = $2`,
      error === null ? [tenantId, id] : [tenantId, id, error.slice(0, 500)]);
  }

  async createPlan(p: Plan): Promise<void> {
    await this.q(p.tenantId,
      `insert into plans (id, tenant_id, user_id, request, context, status, question, report_run_id, note,
                          created_at, updated_at, finished_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [p.id, p.tenantId, p.userId, p.request, p.context, p.status, p.question, p.reportRunId, p.note,
       p.createdAt, p.updatedAt, p.finishedAt]);
  }

  async getPlan(tenantId: string, id: string): Promise<Plan | null> {
    const rows = await this.q<Plan>(tenantId, `select ${PLAN_COLUMNS} from plans where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ?? null;
  }

  async listActivePlans(tenantId: string, userId: string): Promise<Plan[]> {
    return this.q<Plan>(tenantId,
      `select ${PLAN_COLUMNS} from plans
        where tenant_id = $1 and user_id = $2 and status in ('planning', 'running', 'waiting_input')
        order by created_at desc limit 20`,
      [tenantId, userId]);
  }

  async updatePlan(p: Plan): Promise<void> {
    await this.q(p.tenantId,
      `update plans set context = $3, status = $4, question = $5, report_run_id = $6, note = $7,
                        updated_at = $8, finished_at = $9
        where tenant_id = $1 and id = $2`,
      [p.tenantId, p.id, p.context, p.status, p.question, p.reportRunId, p.note, p.updatedAt, p.finishedAt]);
  }

  async createPlanSteps(steps: PlanStep[]): Promise<void> {
    for (const s of steps) {
      await this.q(s.tenantId,
        `insert into plan_steps (id, tenant_id, plan_id, seq, agent_id, purpose, depends_on, status, run_id,
                                 attempts, asked, answer, note, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [s.id, s.tenantId, s.planId, s.seq, s.agentId, s.purpose, s.dependsOn, s.status, s.runId,
         s.attempts, s.asked, s.answer, s.note, s.updatedAt]);
    }
  }

  async listPlanSteps(tenantId: string, planId: string): Promise<PlanStep[]> {
    return this.q<PlanStep>(tenantId,
      `select ${PLAN_STEP_COLUMNS} from plan_steps where tenant_id = $1 and plan_id = $2 order by seq`, [tenantId, planId]);
  }

  async getPlanStep(tenantId: string, id: string): Promise<PlanStep | null> {
    const rows = await this.q<PlanStep>(tenantId,
      `select ${PLAN_STEP_COLUMNS} from plan_steps where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ?? null;
  }

  async updatePlanStep(s: PlanStep): Promise<void> {
    await this.q(s.tenantId,
      `update plan_steps set status = $3, run_id = $4, attempts = $5, asked = $6, answer = $7, note = $8, updated_at = $9
        where tenant_id = $1 and id = $2`,
      [s.tenantId, s.id, s.status, s.runId, s.attempts, s.asked, s.answer, s.note, s.updatedAt]);
  }

  async purgeAgentEvents(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from agent_events where tenant_id = $1 and processed_at is not null and processed_at < $2 returning id`,
      [tenantId, before]);
    return rows.length;
  }

  async listConversationUserIds(tenantId: string, day: { from: string; to: string }): Promise<string[]> {
    const rows = await this.q<{ userId: string }>(tenantId,
      `select distinct user_id as "userId" from conversations
        where tenant_id = $1 and created_at >= $2 and created_at < $3`,
      [tenantId, day.from, day.to]);
    return rows.map((r) => r.userId);
  }

  async saveConversationDigest(d: ConversationDigest): Promise<void> {
    await this.q(d.tenantId,
      `insert into conversation_digests (tenant_id, user_id, day, summary, compartment, created_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tenant_id, user_id, day)
         do update set summary = excluded.summary, compartment = excluded.compartment`,
      [d.tenantId, d.userId, d.day, d.summary, d.compartment, d.createdAt]);
  }

  async listConversationDigests(
    tenantId: string, userId: string, limit: number,
  ): Promise<ConversationDigest[]> {
    return this.q<ConversationDigest>(tenantId,
      `select tenant_id as "tenantId", user_id as "userId", day, summary, compartment,
              created_at as "createdAt"
         from conversation_digests where tenant_id = $1 and user_id = $2
        order by day desc limit $3`,
      [tenantId, userId, limit]);
  }

  async listMemoryCandidates(
    tenantId: string, userId: string, status: 'pending' | 'dismissed',
  ): Promise<MemoryCandidate[]> {
    return this.q<MemoryCandidate>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", text, status,
              source_day as "sourceDay", created_at as "createdAt"
         from memory_candidates where tenant_id = $1 and user_id = $2 and status = $3
        order by created_at desc`,
      [tenantId, userId, status]);
  }

  async createMemoryCandidate(c: MemoryCandidate): Promise<void> {
    await this.q(c.tenantId,
      `insert into memory_candidates (id, tenant_id, user_id, text, status, source_day, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [c.id, c.tenantId, c.userId, c.text, c.status, c.sourceDay, c.createdAt]);
  }

  async updateMemoryCandidate(
    tenantId: string, userId: string, id: string, status: 'dismissed',
  ): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update memory_candidates set status = $4
        where tenant_id = $1 and user_id = $2 and id = $3 returning id`,
      [tenantId, userId, id, status]);
    return rows.length > 0;
  }

  async deleteMemoryCandidate(
    tenantId: string, userId: string, id: string,
  ): Promise<MemoryCandidate | null> {
    const rows = await this.q<MemoryCandidate>(tenantId,
      `delete from memory_candidates where tenant_id = $1 and user_id = $2 and id = $3
        returning id, tenant_id as "tenantId", user_id as "userId", text, status,
                  source_day as "sourceDay", created_at as "createdAt"`,
      [tenantId, userId, id]);
    return rows[0] ?? null;
  }

  async createPromotion(p: Promotion): Promise<void> {
    await this.q(p.tenantId,
      `insert into promotions (id, tenant_id, user_id, memory_id, text, status, knowledge_id,
                               decided_by, comment, created_at, decided_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [p.id, p.tenantId, p.userId, p.memoryId, p.text, p.status, p.knowledgeId,
        p.decidedBy, p.comment, p.createdAt, p.decidedAt]);
  }

  async listPromotions(
    tenantId: string, opts: { status?: Promotion['status']; userId?: string },
  ): Promise<Promotion[]> {
    return this.q<Promotion>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", memory_id as "memoryId", text, status,
              knowledge_id as "knowledgeId", decided_by as "decidedBy", comment,
              created_at as "createdAt", decided_at as "decidedAt"
         from promotions
        where tenant_id = $1
          and ($2::text is null or status = $2)
          and ($3::text is null or user_id = $3)
        order by created_at desc`,
      [tenantId, opts.status ?? null, opts.userId ?? null]);
  }

  async getPromotion(tenantId: string, id: string): Promise<Promotion | null> {
    const rows = await this.q<Promotion>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", memory_id as "memoryId", text, status,
              knowledge_id as "knowledgeId", decided_by as "decidedBy", comment,
              created_at as "createdAt", decided_at as "decidedAt"
         from promotions where tenant_id = $1 and id = $2`,
      [tenantId, id]);
    return rows[0] ?? null;
  }

  async updatePromotion(p: Promotion): Promise<void> {
    await this.q(p.tenantId,
      `update promotions set status = $3, knowledge_id = $4, decided_by = $5, comment = $6, decided_at = $7
        where tenant_id = $1 and id = $2`,
      [p.tenantId, p.id, p.status, p.knowledgeId, p.decidedBy, p.comment, p.decidedAt]);
  }

  async listMemories(tenantId: string, userId: string): Promise<Memory[]> {
    return this.q<Memory>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", text, source,
              created_at as "createdAt", last_used_at as "lastUsedAt"
         from memories where tenant_id = $1 and user_id = $2 and status = 'active' order by created_at desc`,
      [tenantId, userId]);
  }

  async listArchivedMemories(tenantId: string, userId: string): Promise<Memory[]> {
    return this.q<Memory>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", text, source, created_at as "createdAt",
              last_used_at as "lastUsedAt", archived_at as "archivedAt", archive_reason as "archiveReason"
         from memories where tenant_id = $1 and user_id = $2 and status = 'archived' order by archived_at desc`,
      [tenantId, userId]);
  }

  async setMemoryStatus(tenantId: string, userId: string, id: string, status: 'active' | 'archived', reason: string | null, mergedInto: string | null, at: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update memories set status = $4, archive_reason = $5, merged_into = $6,
              archived_at = case when $4 = 'archived' then $7::timestamptz else null end,
              last_used_at = case when $4 = 'active' then $7::timestamptz else last_used_at end
        where tenant_id = $1 and user_id = $2 and id = $3 and status <> $4 returning id`,
      [tenantId, userId, id, status, reason, mergedInto, at]);
    return rows.length > 0;
  }

  async touchMemories(tenantId: string, userId: string, ids: string[], at: string): Promise<void> {
    if (ids.length === 0) return;
    await this.q(tenantId, `update memories set last_used_at = $4 where tenant_id = $1 and user_id = $2 and id = any($3::text[])`,
      [tenantId, userId, ids, at]);
  }

  async listMemoryOwners(tenantId: string): Promise<string[]> {
    return (await this.q<{ userId: string }>(tenantId,
      `select distinct user_id as "userId" from memories where tenant_id = $1 and status = 'active'`, [tenantId])).map((r) => r.userId);
  }

  async purgeArchivedMemories(tenantId: string, before: string): Promise<number> {
    return (await this.q<{ id: string }>(tenantId,
      `delete from memories where tenant_id = $1 and status = 'archived' and archived_at < $2 returning id`, [tenantId, before])).length;
  }

  async createMemory(m: Memory): Promise<void> {
    await this.q(m.tenantId,
      `insert into memories (id, tenant_id, user_id, text, source, created_at, last_used_at)
       values ($1,$2,$3,$4,$5,$6,$6)`,
      [m.id, m.tenantId, m.userId, m.text, m.source, m.createdAt]);
  }

  async deleteMemory(tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from memories where tenant_id = $1 and user_id = $2 and id = $3 returning id`,
      [tenantId, userId, id]);
    return rows.length > 0;
  }

  async updateMemory(tenantId: string, userId: string, id: string, text: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update memories set text = $4, source = 'secretary'
        where tenant_id = $1 and user_id = $2 and id = $3 returning id`,
      [tenantId, userId, id, text]);
    return rows.length > 0;
  }

  async clearMemories(tenantId: string, userId: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from memories where tenant_id = $1 and user_id = $2 returning id`,
      [tenantId, userId]);
    return rows.length;
  }

  async getUserSettings(tenantId: string, userId: string): Promise<UserSettings> {
    const rows = await this.q<Partial<Record<keyof UserSettings, unknown>>>(tenantId,
      `select profile, secretary, notifications, memory, menu, brief, onboarding from user_settings
        where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    const r = rows[0] ?? {};
    const d = DEFAULT_USER_SETTINGS;
    const n = (r.notifications ?? {}) as Partial<UserSettings['notifications']>;
    return {
      profile: { ...d.profile, ...(r.profile ?? {}) },
      secretary: { ...d.secretary, ...(r.secretary ?? {}) },
      notifications: {
        kinds: { ...d.notifications.kinds, ...(n.kinds ?? {}) },
        quietHours: n.quietHours ?? d.notifications.quietHours,
        channels: { ...d.notifications.channels, ...(n.channels ?? {}) },
      },
      memory: { ...d.memory, ...(r.memory ?? {}) },
      menu: { ...d.menu, ...(r.menu ?? {}) },
      // 朝のブリーフの中身（移行 037。仕様書 第9.5.5.1.1節）
      brief: { ...d.brief, ...(r.brief ?? {}) },
      onboarding: { ...d.onboarding, ...(r.onboarding ?? {}) },
    };
  }

  async listSecretarySettings(tenantId: string): Promise<Map<string, UserSettings['secretary']>> {
    const rows = await this.q<{ userId: string; secretary: Partial<UserSettings['secretary']> | null }>(tenantId,
      `select user_id as "userId", secretary from user_settings where tenant_id = $1`, [tenantId]);
    return new Map(rows.map((r) => [r.userId, { ...DEFAULT_USER_SETTINGS.secretary, ...(r.secretary ?? {}) }]));
  }

  async saveUserSettings<K extends keyof UserSettings>(
    tenantId: string, userId: string, section: K, value: UserSettings[K],
  ): Promise<void> {
    const column = ({
      profile: 'profile', secretary: 'secretary', notifications: 'notifications', memory: 'memory',
      menu: 'menu', brief: 'brief', onboarding: 'onboarding',
    } as const)[section];
    await this.q(tenantId,
      `insert into user_settings (tenant_id, user_id, ${column}, updated_at)
       values ($1, $2, $3, now())
       on conflict (tenant_id, user_id) do update set ${column} = excluded.${column}, updated_at = now()`,
      [tenantId, userId, JSON.stringify(value)]);
  }

  async listSessions(tenantId: string, userId: string, now: Date): Promise<Session[]> {
    return this.q<Session>(tenantId,
      `select id, tenant_id as "tenantId", user_id as "userId", csrf_token as "csrfToken",
              provider, user_agent as "userAgent", created_at as "createdAt",
              last_seen_at as "lastSeenAt", expires_at as "expiresAt", revoked_at as "revokedAt"
         from sessions
        where tenant_id = $1 and user_id = $2 and revoked_at is null and expires_at > $3
        order by last_seen_at desc`,
      [tenantId, userId, now.toISOString()]);
  }

  async usageForUser(tenantId: string, userId: string, since: string) {
    const rows = await this.q<{ runs: number; costJpy: number }>(tenantId,
      `select count(*)::int as runs, coalesce(sum(r.cost_jpy), 0)::float8 as "costJpy"
         from runs r join jobs j on j.id = r.job_id
        where r.tenant_id = $1 and j.requested_by = $2 and r.started_at >= $3`,
      [tenantId, userId, since]);
    return rows[0] ?? { runs: 0, costJpy: 0 };
  }

  async listUserCompartments(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.q<{ name: string }>(tenantId,
      `select c.name from compartments c
        where c.tenant_id = $1 and c.enabled
          and (exists (select 1 from compartment_members m where m.compartment_id = c.id and m.user_id = $2)
            or exists (select 1 from compartment_groups g
                         join user_group_members gm on gm.group_id = g.group_id and gm.tenant_id = g.tenant_id
                        where g.compartment_id = c.id and g.tenant_id = $1 and gm.user_id = $2))
        order by c.name`,
      [tenantId, userId]);
    return rows.map((r) => r.name);
  }

  async createFile(f: StoredFile): Promise<void> {
    await this.q(f.tenantId,
      `insert into files (id, tenant_id, owner_user_id, name, kind, mime, size, sha256, origin,
                          run_id, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [f.id, f.tenantId, f.ownerUserId, f.name, f.kind, f.mime, f.size, f.sha256, f.origin,
       f.runId, f.createdAt]);
  }

  async getFile(tenantId: string, id: string): Promise<StoredFile | null> {
    const rows = await this.q<StoredFile>(tenantId,
      `select id, tenant_id as "tenantId", owner_user_id as "ownerUserId", name, kind, mime, size,
              sha256, origin, run_id as "runId", created_at as "createdAt"
         from files where tenant_id = $1 and id = $2`,
      [tenantId, id]);
    return rows[0] ?? null;
  }

  async listActiveSessions(
    tenantId: string,
  ): Promise<{ userId: string; lastSeenAt: string; userAgent: string | null }[]> {
    return this.q<{ userId: string; lastSeenAt: string; userAgent: string | null }>(tenantId,
      `select distinct on (user_id)
              user_id as "userId", last_seen_at as "lastSeenAt", user_agent as "userAgent"
         from sessions
        where tenant_id = $1 and revoked_at is null and expires_at > now()
        order by user_id, last_seen_at desc`,
      [tenantId]);
  }

  async countActiveUsers(tenantId: string, since: Date): Promise<number> {
    const rows = await this.q<{ n: number }>(tenantId,
      `select count(distinct user_id)::int as n from sessions
        where tenant_id = $1 and revoked_at is null and expires_at > now() and last_seen_at >= $2`,
      [tenantId, since.toISOString()]);
    return rows[0]?.n ?? 0;
  }

  async listLiveRuns(tenantId: string, failedSince: string): Promise<{ run: Run; job: Job }[]> {
    const rows = await this.q<{ run: Run; job: Job }>(tenantId,
      `select json_build_object(
                'id', r.id, 'jobId', r.job_id, 'tenantId', r.tenant_id, 'status', r.status,
                'cursor', r.cursor, 'startedAt', r.started_at, 'endedAt', r.ended_at,
                'tokensUsed', r.tokens_used, 'costJpy', r.cost_jpy::float8,
                'savedMinutes', r.saved_minutes::float8, 'failureReason', r.failure_reason) as run,
              json_build_object(
                'id', j.id, 'tenantId', j.tenant_id, 'agentId', j.agent_id,
                'agentVersion', j.agent_version, 'requestedBy', j.requested_by,
                'origin', j.origin, 'input', '{}'::jsonb, 'createdAt', j.created_at, 'agentName', j.agent_name) as job
         from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1
          and (r.status in ('queued', 'running', 'awaiting_approval')
               or (r.status = 'failed' and r.started_at >= $2))
        order by r.started_at desc limit 50`,
      [tenantId, failedSince]);
    return rows.map(({ run, job }) => ({
      run: { ...run, startedAt: iso(run.startedAt)!, endedAt: iso(run.endedAt) },
      job: { ...job, createdAt: iso(job.createdAt)! },
    }));
  }

  async runStats(tenantId: string, since: string): Promise<RunStatRow[]> {
    // 日本時間の日付と時刻で束ねる。画面の「今日」「時間帯」と一致させるため
    return this.q<RunStatRow>(tenantId,
      `select to_char(r.started_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD') as day,
              extract(hour from r.started_at at time zone 'Asia/Tokyo')::int as hour,
              j.agent_id as "agentId", r.status,
              count(*)::int as runs,
              coalesce(sum(r.cost_jpy), 0)::float8 as "costJpy",
              coalesce(sum(r.tokens_used), 0)::int as tokens,
              coalesce(sum(r.saved_minutes), 0)::float8 as "savedMinutes",
              coalesce(sum(extract(epoch from (r.ended_at - r.started_at)))
                filter (where r.ended_at is not null), 0)::float8 as "durationSec"
         from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1 and r.started_at >= $2
        group by 1, 2, 3, 4`,
      [tenantId, since]);
  }

  async countAuditActions(tenantId: string, since: string, actions: string[]) {
    return this.q<{ action: string; targetId: string; n: number }>(tenantId,
      `select action, target_id as "targetId", count(*)::int as n from audit_events
        where tenant_id = $1 and occurred_at >= $2 and action = any($3)
        group by 1, 2`,
      [tenantId, since, actions]);
  }

  async listAuditSince(tenantId: string, actions: string[], limit: number): Promise<AuditEvent[]> {
    return this.q<AuditEvent>(tenantId,
      `select id, tenant_id as "tenantId", actor_type as "actorType", actor_id as "actorId", action,
              target_type as "targetType", target_id as "targetId", detail, occurred_at as "occurredAt"
         from audit_events where tenant_id = $1 and action = any($2)
        order by occurred_at desc limit $3`,
      [tenantId, actions, limit]);
  }

  async countKnowledge(tenantId: string): Promise<number> {
    const rows = await this.q<{ n: number }>(tenantId,
      `select count(*)::int as n from knowledge_items where tenant_id = $1 and status = 'active'`, [tenantId]);
    return rows[0]?.n ?? 0;
  }

  async listInstalledExtensions(tenantId: string): Promise<InstalledExtension[]> {
    return this.q<InstalledExtension>(tenantId,
      `select tenant_id as "tenantId", extension_id as "extensionId", version,
              consented_permissions as "consentedPermissions", installed_by as "installedBy",
              installed_at as "installedAt", enabled
         from tenant_extensions where tenant_id = $1 order by installed_at`,
      [tenantId]);
  }

  async claimLookupDelivery(tenantId: string, runId: string): Promise<boolean> {
    // 記録できた側だけが伝える。二度伝えないための取り合いである
    const rows = await this.q<{ run_id: string }>(tenantId,
      `insert into lookup_deliveries (tenant_id, run_id) values ($1, $2)
       on conflict (tenant_id, run_id) do nothing
       returning run_id`,
      [tenantId, runId]);
    return rows.length > 0;
  }

  async getUserPhoto(tenantId: string, userId: string): Promise<UserPhoto | null> {
    const rows = await this.q<{ mime: UserPhoto['mime']; bytes: Buffer; fetchedAt: Date }>(tenantId,
      `select mime, bytes, fetched_at as "fetchedAt" from user_photos where tenant_id = $1 and user_id = $2`,
      [tenantId, userId]);
    const r = rows[0];
    return r ? { tenantId, userId, mime: r.mime, bytes: new Uint8Array(r.bytes), fetchedAt: new Date(r.fetchedAt).toISOString() } : null;
  }

  async listUserPhotoStamps(tenantId: string): Promise<Map<string, string>> {
    const rows = await this.q<{ userId: string; fetchedAt: Date }>(tenantId,
      `select user_id as "userId", fetched_at as "fetchedAt" from user_photos where tenant_id = $1`, [tenantId]);
    return new Map(rows.map((r) => [r.userId, new Date(r.fetchedAt).toISOString()]));
  }

  async saveUserPhoto(photo: UserPhoto): Promise<void> {
    // 1 人 1 枚。上書きして、古い写真を残さない
    await this.q(photo.tenantId,
      `insert into user_photos (tenant_id, user_id, mime, bytes, fetched_at) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, user_id) do update
         set mime = excluded.mime, bytes = excluded.bytes, fetched_at = excluded.fetched_at`,
      [photo.tenantId, photo.userId, photo.mime, Buffer.from(photo.bytes), photo.fetchedAt]);
  }

  async listToldLookups(tenantId: string, runIds: string[]): Promise<string[]> {
    if (runIds.length === 0) return [];
    const rows = await this.q<{ runId: string }>(tenantId,
      `select run_id as "runId" from lookup_deliveries
        where tenant_id = $1 and run_id = any($2)`,
      [tenantId, runIds]);
    return rows.map((r) => r.runId);
  }

  async findActiveJobByInput(
    tenantId: string, userId: string, agentId: string, key: string, value: string,
  ): Promise<string | null> {
    const rows = await this.q<{ id: string }>(tenantId,
      `select r.id
         from runs r join jobs j on j.id = r.job_id and j.tenant_id = r.tenant_id
        where r.tenant_id = $1 and j.requested_by = $2 and j.agent_id = $3
          and j.input ->> $4 = $5
          and r.status in ('queued', 'running')
        order by r.started_at desc limit 1`,
      [tenantId, userId, agentId, key, value]);
    return rows[0]?.id ?? null;
  }

  async deleteLooseUploadsBefore(tenantId: string, before: string): Promise<string[]> {
    // どの依頼の入力にも現れないものだけを消す。1 つのファイルは複数の実行で使われうる。
    // **秘書のアバターに使っている画像も消さない**（仕様書 第10.10.5節）。依頼の入力には現れないが、
    // 秘書に渡しただけのファイルではない。替えて使わなくなれば、次の見回りで消える
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from files f
        where f.tenant_id = $1 and f.origin = 'upload' and f.run_id is null and f.created_at < $2
          and not exists (
            select 1 from jobs j, jsonb_each_text(j.input) e
             where j.tenant_id = f.tenant_id and e.value = f.id)
          and not exists (
            select 1 from user_settings s
             where s.tenant_id = f.tenant_id and s.secretary->>'avatar' = 'file:' || f.id)
          -- 会社のロゴと帳票のロゴに使っている画像も消さない（仕様書 第6.6.1節・第15.2.2節）
          and not exists (
            select 1 from tenant_settings t
             where t.tenant_id = f.tenant_id
               and (t.company->>'logoFileId' = f.id or t.invoice->>'logoFileId' = f.id))
        returning f.id`,
      [tenantId, before]);
    return rows.map((r) => r.id);
  }

  async listDisabledConnectorTools(tenantId: string): Promise<DisabledConnectorTool[]> {
    return this.q<DisabledConnectorTool>(tenantId,
      `select connector_id as "connectorId", tool_name as "toolName",
              disabled_by as "disabledBy", disabled_at as "disabledAt"
         from disabled_connector_tools where tenant_id = $1 order by connector_id, tool_name`,
      [tenantId]);
  }

  async listConnections(tenantId: string): Promise<TenantConnection[]> {
    return this.q<TenantConnection>(tenantId,
      `select tenant_id as "tenantId", id, name, description, transport, url, auth, tools, origin,
              coalesce(send_policy, 'block') as "sendPolicy",
              created_by as "createdBy", created_at as "createdAt", updated_at as "updatedAt"
         from tenant_connections where tenant_id = $1 order by id`,
      [tenantId]);
  }

  async saveConnection(c: TenantConnection): Promise<void> {
    await this.q(c.tenantId,
      `insert into tenant_connections (tenant_id, id, name, description, transport, url, auth, tools, origin, created_by, created_at, updated_at, send_policy)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (tenant_id, id) do update set
         name = excluded.name, description = excluded.description, transport = excluded.transport, url = excluded.url,
         auth = excluded.auth, tools = excluded.tools, origin = excluded.origin, updated_at = excluded.updated_at,
         send_policy = excluded.send_policy`,
      [c.tenantId, c.id, c.name, c.description, c.transport, c.url, JSON.stringify(c.auth), JSON.stringify(c.tools),
        c.origin, c.createdBy, c.createdAt, c.updatedAt, c.sendPolicy ?? 'block']);
  }

  async deleteConnection(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      'delete from tenant_connections where tenant_id = $1 and id = $2 returning id', [tenantId, id]);
    return rows.length > 0;
  }

  async getConnectionSecret(tenantId: string, connectionId: string): Promise<ConnectionSecret | null> {
    const rows = await this.q<ConnectionSecret>(tenantId,
      `select tenant_id as "tenantId", connection_id as "connectionId", client_id as "clientId",
              client_secret_enc as "clientSecretEnc", api_key_enc as "apiKeyEnc", auto_registered as "autoRegistered",
              updated_by as "updatedBy", updated_at as "updatedAt"
         from connection_secrets where tenant_id = $1 and connection_id = $2`, [tenantId, connectionId]);
    return rows[0] ?? null;
  }

  async saveConnectionSecret(s: ConnectionSecret): Promise<void> {
    await this.q(s.tenantId,
      `insert into connection_secrets (tenant_id, connection_id, client_id, client_secret_enc, api_key_enc, auto_registered, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, connection_id) do update set
         client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc, api_key_enc = excluded.api_key_enc,
         auto_registered = excluded.auto_registered, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [s.tenantId, s.connectionId, s.clientId, s.clientSecretEnc, s.apiKeyEnc, s.autoRegistered ?? false, s.updatedBy, s.updatedAt]);
  }

  async getUserConnection(tenantId: string, userId: string, connectionId: string): Promise<UserConnection | null> {
    const rows = await this.q<UserConnection>(tenantId,
      `select ${USER_CONNECTION_COLUMNS} from user_connections where tenant_id = $1 and user_id = $2 and connection_id = $3`,
      [tenantId, userId, connectionId]);
    return rows[0] ?? null;
  }

  async listUserConnections(tenantId: string, filter: { userId?: string; connectionId?: string } = {}): Promise<UserConnection[]> {
    return this.q<UserConnection>(tenantId,
      `select ${USER_CONNECTION_COLUMNS} from user_connections
        where tenant_id = $1 and ($2::text is null or user_id = $2) and ($3::text is null or connection_id = $3)
        order by connected_at`,
      [tenantId, filter.userId ?? null, filter.connectionId ?? null]);
  }

  async saveUserConnection(c: UserConnection): Promise<void> {
    await this.q(c.tenantId,
      `insert into user_connections (tenant_id, user_id, connection_id, access_token_enc, refresh_token_enc, expires_at,
                                     scopes, account_label, client_id, connected_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (tenant_id, user_id, connection_id) do update set
         access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
         expires_at = excluded.expires_at, scopes = excluded.scopes, account_label = excluded.account_label,
         client_id = excluded.client_id, connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
      [c.tenantId, c.userId, c.connectionId, c.accessTokenEnc, c.refreshTokenEnc, c.expiresAt, c.scopes,
        c.accountLabel, c.clientId, c.connectedAt, c.updatedAt]);
  }

  async deleteUserConnection(tenantId: string, userId: string, connectionId: string): Promise<boolean> {
    const rows = await this.q<{ user_id: string }>(tenantId,
      `delete from user_connections where tenant_id = $1 and user_id = $2 and connection_id = $3 returning user_id`,
      [tenantId, userId, connectionId]);
    return rows.length > 0;
  }

  async deleteUserConnectionsFor(tenantId: string, connectionId: string): Promise<number> {
    const rows = await this.q<{ user_id: string }>(tenantId,
      `delete from user_connections where tenant_id = $1 and connection_id = $2 returning user_id`, [tenantId, connectionId]);
    return rows.length;
  }

  async setConnectorToolEnabled(
    tenantId: string, connectorId: string, toolName: string, enabled: boolean, by: string,
  ): Promise<void> {
    // 止めたものだけを残す。有効に戻すことは、行を消すことである
    if (enabled) {
      await this.q(tenantId,
        `delete from disabled_connector_tools
          where tenant_id = $1 and connector_id = $2 and tool_name = $3`,
        [tenantId, connectorId, toolName]);
      return;
    }
    await this.q(tenantId,
      `insert into disabled_connector_tools (tenant_id, connector_id, tool_name, disabled_by)
       values ($1,$2,$3,$4)
       on conflict (tenant_id, connector_id, tool_name) do nothing`,
      [tenantId, connectorId, toolName, by]);
  }

  async installExtension(r: InstalledExtension): Promise<void> {
    await this.q(r.tenantId,
      `insert into tenant_extensions (tenant_id, extension_id, version, consented_permissions, installed_by, installed_at, enabled)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tenant_id, extension_id) do update
         set version = excluded.version, consented_permissions = excluded.consented_permissions,
             installed_by = excluded.installed_by, installed_at = excluded.installed_at, enabled = excluded.enabled`,
      [r.tenantId, r.extensionId, r.version, JSON.stringify(r.consentedPermissions), r.installedBy, r.installedAt, r.enabled]);
  }

  async uninstallExtension(tenantId: string, extensionId: string): Promise<boolean> {
    const rows = await this.q<{ extension_id: string }>(tenantId,
      `delete from tenant_extensions where tenant_id = $1 and extension_id = $2 returning extension_id`,
      [tenantId, extensionId]);
    return rows.length > 0;
  }

  async getTenantCredential(tenantId: string, kind: CredentialKind): Promise<TenantCredential | null> {
    const rows = await this.q<TenantCredential>(tenantId,
      `select tenant_id as "tenantId", kind, secret_enc as "secretEnc", meta, updated_by as "updatedBy", updated_at as "updatedAt"
         from tenant_credentials where tenant_id = $1 and kind = $2`, [tenantId, kind]);
    return rows[0] ?? null;
  }

  async saveTenantCredential(c: TenantCredential): Promise<void> {
    await this.q(c.tenantId,
      `insert into tenant_credentials (tenant_id, kind, secret_enc, meta, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (tenant_id, kind) do update
         set secret_enc = excluded.secret_enc, meta = excluded.meta, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [c.tenantId, c.kind, c.secretEnc, JSON.stringify(c.meta), c.updatedBy, c.updatedAt]);
  }

  async deleteTenantCredential(tenantId: string, kind: CredentialKind): Promise<boolean> {
    const rows = await this.q<{ kind: string }>(tenantId,
      `delete from tenant_credentials where tenant_id = $1 and kind = $2 returning kind`, [tenantId, kind]);
    return rows.length > 0;
  }

  async getGoogleConnection(tenantId: string, userId: string): Promise<GoogleConnection | null> {
    const rows = await this.q<GoogleConnection>(tenantId,
      `select ${GOOGLE_CONNECTION_COLUMNS} from user_google_connections where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    return rows[0] ?? null;
  }

  async listGoogleConnections(tenantId: string): Promise<GoogleConnection[]> {
    return this.q<GoogleConnection>(tenantId,
      `select ${GOOGLE_CONNECTION_COLUMNS} from user_google_connections where tenant_id = $1 order by connected_at`, [tenantId]);
  }

  async saveGoogleConnection(c: GoogleConnection): Promise<void> {
    await this.q(c.tenantId,
      `insert into user_google_connections (tenant_id, user_id, refresh_token_enc, google_email, scopes, connected_at, checked_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tenant_id, user_id) do update
         set refresh_token_enc = excluded.refresh_token_enc, google_email = excluded.google_email,
             scopes = excluded.scopes, connected_at = excluded.connected_at, checked_at = excluded.checked_at`,
      [c.tenantId, c.userId, c.refreshTokenEnc, c.googleEmail, c.scopes, c.connectedAt, c.checkedAt]);
  }

  async deleteGoogleConnection(tenantId: string, userId: string): Promise<boolean> {
    const rows = await this.q<{ user_id: string }>(tenantId,
      `delete from user_google_connections where tenant_id = $1 and user_id = $2 returning user_id`, [tenantId, userId]);
    return rows.length > 0;
  }

  async listCompartmentAssignments(tenantId: string): Promise<CompartmentAssignment[]> {
    const rows = await this.q<Omit<CompartmentAssignment, 'groups' | 'users'> & { groups: string[] | null; users: string[] | null }>(tenantId,
      `select c.id, c.name, c.description, c.enabled,
              (select array_agg(g.group_id order by g.group_id) from compartment_groups g
                where g.compartment_id = c.id and g.tenant_id = c.tenant_id) as groups,
              (select array_agg(m.user_id order by m.user_id) from compartment_members m
                where m.compartment_id = c.id) as users
         from compartments c where c.tenant_id = $1 order by c.name`,
      [tenantId]);
    return rows.map((r) => ({ ...r, groups: r.groups ?? [], users: r.users ?? [] }));
  }

  async createCompartment(c: { id: string; tenantId: string; name: string; description: string }): Promise<void> {
    await this.q(c.tenantId,
      `insert into compartments (id, tenant_id, name, description) values ($1,$2,$3,$4)`,
      [c.id, c.tenantId, c.name, c.description]);
  }

  async setCompartmentEnabled(tenantId: string, compartmentId: string, enabled: boolean): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update compartments set enabled = $3 where tenant_id = $1 and id = $2 returning id`,
      [tenantId, compartmentId, enabled]);
    return rows.length > 0;
  }

  async deleteCompartment(tenantId: string, compartmentId: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from compartments where tenant_id = $1 and id = $2 returning id`,
      [tenantId, compartmentId]);
    return rows.length > 0;
  }

  async countKnowledgeInCompartment(tenantId: string, compartment: string): Promise<number> {
    const rows = await this.q<{ n: number }>(tenantId,
      // 廃止した・しまった知識は数えない（区画を消すと、それらは誰の検索にも出ない。第11.11節）
      `select count(*)::int as n from knowledge_items where tenant_id = $1 and compartment = $2 and status = 'active'`,
      [tenantId, compartment]);
    return rows[0]?.n ?? 0;
  }

  async setCompartmentAssignment(
    tenantId: string, compartmentId: string, a: { groups: string[]; users: string[] }, assignedBy: string,
  ): Promise<void> {
    // 区画がこの会社のものかを先に確かめる。compartment_members は親の表を通じて RLS がかかる
    const own = await this.q<{ id: string }>(tenantId,
      `select id from compartments where tenant_id = $1 and id = $2`, [tenantId, compartmentId]);
    if (own.length === 0) return;
    await this.q(tenantId, `delete from compartment_groups where tenant_id = $1 and compartment_id = $2`, [tenantId, compartmentId]);
    await this.q(tenantId, `delete from compartment_members where compartment_id = $1`, [compartmentId]);
    if (a.groups.length > 0) {
      await this.q(tenantId,
        `insert into compartment_groups (tenant_id, compartment_id, group_id, assigned_by)
         select $1, $2, g.id, $4 from user_groups g where g.tenant_id = $1 and g.id = any($3::text[])`,
        [tenantId, compartmentId, a.groups, assignedBy]);
    }
    if (a.users.length > 0) {
      await this.q(tenantId,
        `insert into compartment_members (compartment_id, user_id, assigned_by)
         select $2, u.id, $4 from users u where u.tenant_id = $1 and u.id = any($3::text[])`,
        [tenantId, compartmentId, a.users, assignedBy]);
    }
  }

  async listGroups(tenantId: string): Promise<UserGroup[]> {
    const rows = await this.q<Omit<UserGroup, 'memberIds'> & { memberIds: string[] | null }>(tenantId,
      `select g.id, g.tenant_id as "tenantId", g.name, g.description,
              array_remove(array_agg(m.user_id order by m.user_id), null) as "memberIds"
         from user_groups g left join user_group_members m on m.group_id = g.id and m.tenant_id = g.tenant_id
        where g.tenant_id = $1
        group by g.id order by g.name`,
      [tenantId]);
    return rows.map((r) => ({ ...r, memberIds: r.memberIds ?? [] }));
  }

  async saveGroup(g: Omit<UserGroup, 'memberIds'>): Promise<void> {
    await this.q(g.tenantId,
      `insert into user_groups (id, tenant_id, name, description) values ($1,$2,$3,$4)
       on conflict (id) do update set name = excluded.name, description = excluded.description
       where user_groups.tenant_id = excluded.tenant_id`,
      [g.id, g.tenantId, g.name, g.description]);
  }

  async deleteGroup(tenantId: string, groupId: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from user_groups where tenant_id = $1 and id = $2 returning id`, [tenantId, groupId]);
    return rows.length > 0;
  }

  async setGroupMembers(tenantId: string, groupId: string, userIds: string[]): Promise<void> {
    // 所属を丸ごと置き換える。同じテナントの利用者だけを入れる（RLS と users の絞り込みの両方で守る）
    await this.q(tenantId, `delete from user_group_members where tenant_id = $1 and group_id = $2`, [tenantId, groupId]);
    if (userIds.length === 0) return;
    await this.q(tenantId,
      `insert into user_group_members (tenant_id, group_id, user_id)
       select $1, $2, u.id from users u where u.tenant_id = $1 and u.id = any($3::text[])`,
      [tenantId, groupId, userIds]);
  }

  async listUserGroupIds(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.q<{ group_id: string }>(tenantId,
      `select group_id from user_group_members where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    return rows.map((r) => r.group_id);
  }

  async setExtensionEnabled(tenantId: string, extensionId: string, enabled: boolean): Promise<boolean> {
    const rows = await this.q<{ extension_id: string }>(tenantId,
      `update tenant_extensions set enabled = $3 where tenant_id = $1 and extension_id = $2 returning extension_id`,
      [tenantId, extensionId, enabled]);
    return rows.length > 0;
  }

  async listPrivateExtensions(tenantId: string): Promise<PrivateExtension[]> {
    return this.q<PrivateExtension>(tenantId,
      `select tenant_id as "tenantId", extension_id as "extensionId", version, files,
              size_bytes as "sizeBytes", imported_by as "importedBy", imported_at as "importedAt"
         from tenant_extension_packages where tenant_id = $1 order by imported_at`,
      [tenantId]);
  }

  async savePrivateExtension(r: PrivateExtension): Promise<void> {
    await this.q(r.tenantId,
      `insert into tenant_extension_packages (tenant_id, extension_id, version, files, size_bytes, imported_by, imported_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tenant_id, extension_id) do update
         set version = excluded.version, files = excluded.files, size_bytes = excluded.size_bytes,
             imported_by = excluded.imported_by, imported_at = excluded.imported_at`,
      [r.tenantId, r.extensionId, r.version, JSON.stringify(r.files), r.sizeBytes, r.importedBy, r.importedAt]);
  }

  async deletePrivateExtension(tenantId: string, extensionId: string): Promise<boolean> {
    const rows = await this.q<{ extension_id: string }>(tenantId,
      `delete from tenant_extension_packages where tenant_id = $1 and extension_id = $2 returning extension_id`,
      [tenantId, extensionId]);
    return rows.length > 0;
  }
}

function iso(v: string | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

/** 利用者ごとの接続の認可の列（仕様書 第12.11.6.3節）。 */
const USER_CONNECTION_COLUMNS = `tenant_id as "tenantId", user_id as "userId", connection_id as "connectionId",
  access_token_enc as "accessTokenEnc", refresh_token_enc as "refreshTokenEnc", expires_at as "expiresAt",
  scopes, account_label as "accountLabel", client_id as "clientId", connected_at as "connectedAt", updated_at as "updatedAt"`;

const GOOGLE_CONNECTION_COLUMNS = `tenant_id as "tenantId", user_id as "userId", refresh_token_enc as "refreshTokenEnc",
  google_email as "googleEmail", scopes, connected_at as "connectedAt", checked_at as "checkedAt"`;

/** 段取りの列（仕様書 第10.14節）。 */
const PLAN_COLUMNS = `id, tenant_id as "tenantId", user_id as "userId", request, context, status, question,
  report_run_id as "reportRunId", note, created_at as "createdAt", updated_at as "updatedAt", finished_at as "finishedAt"`;

/** 段取りの段の列。 */
const PLAN_STEP_COLUMNS = `id, tenant_id as "tenantId", plan_id as "planId", seq, agent_id as "agentId", purpose,
  depends_on as "dependsOn", status, run_id as "runId", attempts, asked, answer, note, updated_at as "updatedAt"`;

const SCHEDULE_COLUMNS = `id, tenant_id as "tenantId", user_id as "userId", agent_id as "agentId",
  agent_version as "agentVersion", input, rule, timezone, enabled, next_run_at as "nextRunAt",
  last_run_at as "lastRunAt", created_by as "createdBy", created_at as "createdAt"`;
