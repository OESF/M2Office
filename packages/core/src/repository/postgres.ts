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
import type { CompartmentAssignment, Conversation, ConversationDigest, MemoryCandidate, Promotion, CredentialKind, GoogleConnection, TenantCredential, DisabledConnectorTool, InstalledExtension, PrivateExtension, KnowledgeItem, KnowledgeSearchResult, KnowledgeSectionView, Memory, Repository, RunStatRow } from './types.js';
import { SPLIT_VERSION, citationOf, splitKnowledge } from '../knowledge/sections.js';
import { SEARCH_CANDIDATES, bigrams, expandTerms, extractTerms, normalizeForSearch, rankSections, rewritesOf } from '../knowledge/search.js';

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
                         origin, input, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job.id, job.tenantId, job.agentId, job.agentVersion, job.requestedBy,
       job.origin, JSON.stringify(job.input), job.createdAt],
    );
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | null> {
    const rows = await this.q<Job>(tenantId, 
      `select id, tenant_id as "tenantId", agent_id as "agentId",
              agent_version as "agentVersion", requested_by as "requestedBy",
              origin, input, created_at as "createdAt"
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
                'origin', j.origin, 'input', j.input, 'createdAt', j.created_at) as job
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
  ): Promise<KnowledgeSearchResult> {
    const terms = extractTerms(query);
    if (terms.length === 0) return { hits: [], rewrites: [] };
    await this.resplitStaleKnowledge(tenantId);
    // 言い換え（標準と自社）を足す（第11.7.7節）
    const { knowledge } = await this.getTenantSettings(tenantId);
    const concepts = expandTerms(terms, [...(knowledge.standardSynonyms ? STANDARD_SYNONYMS : []), ...knowledge.synonyms]);
    const patterns = [...new Set(concepts.flatMap((c) => c.alternatives.flatMap(bigrams)))].map((g) => `%${escapeLike(g)}%`);
    const rows = await this.q<{
      id: string; title: string; heading: string; path: string[]; body: string; source: string;
      compartment: string | null; updatedAt: string;
    }>(tenantId,
      `select s.item_id as id, k.title, s.heading, s.path, s.body, k.source, s.compartment,
              k.updated_at as "updatedAt"
         from knowledge_sections s
         join knowledge_items k on k.id = s.item_id and k.tenant_id = s.tenant_id
        where s.tenant_id = $1
          and (s.compartment is null or s.compartment = $3)
          and s.search_text like any($2)
        order by (select count(*) from unnest($2::text[]) p where s.search_text like p) desc,
                 k.updated_at desc
        limit $4`,
      [tenantId, patterns, compartment, SEARCH_CANDIDATES],
    );
    const ranked = rankSections(concepts, rows);
    return {
      hits: ranked.map((r) => ({
        id: r.id, title: r.title, heading: r.heading, path: r.path, citation: citationOf(r.title, r),
        body: r.body, source: r.source, compartment: r.compartment, score: Math.round(r.score * 100) / 100,
      })),
      rewrites: rewritesOf(concepts, ranked),
    };
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
    }>(tenantId, `select company, writing_style, automation, agents, effect, onboarding, access, slides, knowledge, privacy, dashboard, invoice
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
    };
  }

  async saveTenantSettings<K extends keyof TenantSettings>(
    tenantId: string, section: K, value: TenantSettings[K], updatedBy: string,
  ): Promise<void> {
    const column = ({
      company: 'company', writingStyle: 'writing_style', automation: 'automation', agents: 'agents',
      effect: 'effect', onboarding: 'onboarding', access: 'access', slides: 'slides', knowledge: 'knowledge', privacy: 'privacy',
      dashboard: 'dashboard', invoice: 'invoice',
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
      `update users set display_name = $3, roles = $4, status = $5 where tenant_id = $1 and id = $2`,
      [u.tenantId, u.id, u.displayName, u.roles, u.status]);
  }

  async listKnowledge(tenantId: string): Promise<KnowledgeItem[]> {
    return this.q<KnowledgeItem>(tenantId,
      `select id, tenant_id as "tenantId", kind, title, body, source, compartment,
              updated_at as "updatedAt", version,
              origin_run_id as "originRunId", google_derived as "googleDerived",
              (select count(*)::int from knowledge_sections s
                where s.tenant_id = k.tenant_id and s.item_id = k.id) as "sectionCount"
         from knowledge_items k where tenant_id = $1 order by updated_at desc`,
      [tenantId]);
  }

  async saveKnowledge(k: KnowledgeItem): Promise<void> {
    await this.inTenant(k.tenantId, async (client) => {
      const res = await client.query(
        `insert into knowledge_items
           (id, tenant_id, kind, title, body, source, compartment, updated_at, origin_run_id, google_derived)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (id) do update set kind = excluded.kind, title = excluded.title,
           body = excluded.body, source = excluded.source, compartment = excluded.compartment,
           updated_at = excluded.updated_at, version = knowledge_items.version + 1
         where knowledge_items.tenant_id = excluded.tenant_id`,
        // 由来（origin_run_id・google_derived）は最初の登録のときだけ書く。上書きの対象に入れない（第9.5.2節）
        [k.id, k.tenantId, k.kind, k.title, k.body, k.source, k.compartment, k.updatedAt,
          k.originRunId ?? null, k.googleDerived ?? false]);
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
              created_at as "createdAt"
         from memories where tenant_id = $1 and user_id = $2 order by created_at desc`,
      [tenantId, userId]);
  }

  async createMemory(m: Memory): Promise<void> {
    await this.q(m.tenantId,
      `insert into memories (id, tenant_id, user_id, text, source, created_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [m.id, m.tenantId, m.userId, m.text, m.source, m.createdAt]);
  }

  async deleteMemory(tenantId: string, userId: string, id: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from memories where tenant_id = $1 and user_id = $2 and id = $3 returning id`,
      [tenantId, userId, id]);
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
      `select profile, secretary, notifications, memory, menu, onboarding from user_settings
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
      onboarding: { ...d.onboarding, ...(r.onboarding ?? {}) },
    };
  }

  async saveUserSettings<K extends keyof UserSettings>(
    tenantId: string, userId: string, section: K, value: UserSettings[K],
  ): Promise<void> {
    const column = ({
      profile: 'profile', secretary: 'secretary', notifications: 'notifications', memory: 'memory',
      menu: 'menu', onboarding: 'onboarding',
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
                'origin', j.origin, 'input', '{}'::jsonb, 'createdAt', j.created_at) as job
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
      `select count(*)::int as n from knowledge_items where tenant_id = $1`, [tenantId]);
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

  async attachFileToRun(tenantId: string, fileId: string, runId: string, ownerUserId: string): Promise<boolean> {
    // 本人のファイルだけを紐づける。他人の ID を書かれても触らない（仕様書 第9.4.1節）
    const rows = await this.q<{ id: string }>(tenantId,
      `update files set run_id = $3
        where tenant_id = $1 and id = $2 and owner_user_id = $4 and run_id is null
        returning id`,
      [tenantId, fileId, runId, ownerUserId]);
    return rows.length > 0;
  }

  async deleteLooseUploadsBefore(tenantId: string, before: string): Promise<string[]> {
    const rows = await this.q<{ id: string }>(tenantId,
      `delete from files
        where tenant_id = $1 and origin = 'upload' and run_id is null and created_at < $2
        returning id`,
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
      `select count(*)::int as n from knowledge_items where tenant_id = $1 and compartment = $2`,
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

const GOOGLE_CONNECTION_COLUMNS = `tenant_id as "tenantId", user_id as "userId", refresh_token_enc as "refreshTokenEnc",
  google_email as "googleEmail", scopes, connected_at as "connectedAt", checked_at as "checkedAt"`;

const SCHEDULE_COLUMNS = `id, tenant_id as "tenantId", user_id as "userId", agent_id as "agentId",
  agent_version as "agentVersion", input, rule, timezone, enabled, next_run_at as "nextRunAt",
  last_run_at as "lastRunAt", created_by as "createdBy", created_at as "createdAt"`;
