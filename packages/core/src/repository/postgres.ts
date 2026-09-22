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
  StoredFile, Tenant, TenantSettings, User, UserSettings,
} from '@m2office/shared';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS } from '@m2office/shared';
import type { KnowledgeHit, KnowledgeItem, Repository } from './types.js';

/**
 * 問い合わせ文を検索語に分割する。
 *
 * @param query 利用者の問い合わせ文
 * @returns 2 文字以上の検索語。助詞と記号は区切りとして扱う
 *
 * @remarks
 * 日本語は分かち書きをしないため、文全体で部分一致を取ると何も当たらない。
 * プロトタイプでは助詞と記号で区切る簡易な方法を用いる。
 * 本格的な検索は、全文検索と意味的検索の併用に置き換える（仕様書 第11.7節）。
 */
function tokenize(query: string): string[] {
  const separators = /[\s、。，．,.?？!！「」『』（）()：:；;・/]|[はがをにでとのへやもからまでより]/g;
  return [...new Set(query.split(separators).filter((t) => t.length >= 2))];
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
                         ended_at, tokens_used, cost_jpy, failure_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [run.id, run.jobId, run.tenantId, run.status, run.cursor, run.startedAt,
       run.endedAt, run.tokensUsed, run.costJpy, run.failureReason],
    );
  }

  async getRun(tenantId: string, runId: string): Promise<Run | null> {
    const rows = await this.q<Run>(tenantId, 
      `select id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
              started_at as "startedAt", ended_at as "endedAt",
              tokens_used as "tokensUsed", cost_jpy as "costJpy",
              failure_reason as "failureReason"
         from runs where tenant_id = $1 and id = $2`,
      [tenantId, runId],
    );
    return rows[0] ?? null;
  }

  async updateRun(run: Run): Promise<void> {
    await this.q(run.tenantId, 
      `update runs set status=$3, cursor=$4, ended_at=$5, tokens_used=$6,
                       cost_jpy=$7, failure_reason=$8
         where tenant_id=$1 and id=$2`,
      [run.tenantId, run.id, run.status, run.cursor, run.endedAt,
       run.tokensUsed, run.costJpy, run.failureReason],
    );
  }

  async listRuns(tenantId: string, limit: number): Promise<Run[]> {
    return this.q<Run>(tenantId, 
      `select id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
              started_at as "startedAt", ended_at as "endedAt",
              tokens_used as "tokensUsed", cost_jpy as "costJpy",
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
   * 組織知識を検索する。
   *
   * @remarks
   * 権限区画: 区画外の利用者には区画内の文書を返さない。
   * 「権限がない」ではなく、候補にも出さない（仕様書 第16.3.5節）。
   */
  async searchKnowledge(
    tenantId: string,
    query: string,
    compartment: string | null,
  ): Promise<KnowledgeHit[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const patterns = terms.map((t) => `%${t}%`);
    return this.q<KnowledgeHit>(tenantId, 
      `select id, title, body, source, compartment
         from knowledge_items
        where tenant_id = $1
          and (compartment is null or compartment = $3)
          and (title ilike any($2) or body ilike any($2))
        order by updated_at desc limit 5`,
      [tenantId, patterns, compartment],
    );
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
              run_id as "runId", read_at as "readAt", created_at as "createdAt"
         from notifications where tenant_id = $1 and user_id = $2
        order by created_at desc limit $3`,
      [tenantId, userId, limit],
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
    }>(tenantId, `select company, writing_style, automation, agents from tenant_settings where tenant_id = $1`,
      [tenantId]);
    const r = rows[0];
    const d = DEFAULT_TENANT_SETTINGS;
    return {
      company: { ...d.company, ...(r?.company ?? {}) },
      writingStyle: { ...d.writingStyle, ...(r?.writing_style ?? {}) },
      automation: r?.automation ?? d.automation,
      agents: { ...d.agents, ...(r?.agents ?? {}) },
    };
  }

  async saveTenantSettings<K extends keyof TenantSettings>(
    tenantId: string, section: K, value: TenantSettings[K], updatedBy: string,
  ): Promise<void> {
    const column = ({
      company: 'company', writingStyle: 'writing_style', automation: 'automation', agents: 'agents',
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
              updated_at as "updatedAt"
         from knowledge_items where tenant_id = $1 order by updated_at desc`,
      [tenantId]);
  }

  async saveKnowledge(k: KnowledgeItem): Promise<void> {
    await this.q(k.tenantId,
      `insert into knowledge_items (id, tenant_id, kind, title, body, source, compartment, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (id) do update set kind = excluded.kind, title = excluded.title,
         body = excluded.body, source = excluded.source, compartment = excluded.compartment,
         updated_at = excluded.updated_at
       where knowledge_items.tenant_id = excluded.tenant_id`,
      [k.id, k.tenantId, k.kind, k.title, k.body, k.source, k.compartment, k.updatedAt]);
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

  async getUserSettings(tenantId: string, userId: string): Promise<UserSettings> {
    const rows = await this.q<Partial<Record<keyof UserSettings, unknown>>>(tenantId,
      `select profile, secretary, notifications, menu from user_settings
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
      },
      menu: { ...d.menu, ...(r.menu ?? {}) },
    };
  }

  async saveUserSettings<K extends keyof UserSettings>(
    tenantId: string, userId: string, section: K, value: UserSettings[K],
  ): Promise<void> {
    const column = ({
      profile: 'profile', secretary: 'secretary', notifications: 'notifications', menu: 'menu',
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
      `select c.name from compartment_members m join compartments c on c.id = m.compartment_id
        where c.tenant_id = $1 and m.user_id = $2 and c.enabled order by c.name`,
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
}

function iso(v: string | null): string | null {
  return v ? new Date(v).toISOString() : null;
}

const SCHEDULE_COLUMNS = `id, tenant_id as "tenantId", user_id as "userId", agent_id as "agentId",
  agent_version as "agentVersion", input, rule, timezone, enabled, next_run_at as "nextRunAt",
  last_run_at as "lastRunAt", created_by as "createdBy", created_at as "createdAt"`;
