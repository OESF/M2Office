import pg from 'pg';
import type {
  Approval, Artifact, AuditEvent, Job, Run, RunStep, Tenant, User,
} from '@m2office/shared';
import type { KnowledgeHit, Repository } from './types.js';

/**
 * PostgreSQL による永続化。
 *
 * @remarks
 * テナント境界: すべての問い合わせに `tenant_id` の条件を含める。
 * 接続プールを使うため、**トランザクション単位で**テナントを設定する方針をとる
 * （仕様書 第6.5.5節）。行レベルセキュリティの有効化は次段階で行う。
 */
/**
 * PostgreSQL が返す値を、型定義どおりの JavaScript の値に揃える。
 *
 * @remarks
 * 既定では `numeric` は文字列、`timestamptz` は `Date` で返る。
 * 型定義（`@m2office/shared`）は数値と ISO 文字列を宣言しているため、
 * ここで合わせておかないと、加算が文字列連結になるなどの不整合が起きる。
 */
/**
 * 問い合わせ文を検索語に分割する。
 *
 * @param query 利用者の問い合わせ文
 * @returns 2 文字以上の検索語。助詞と記号は区切りとして扱う
 *
 * @remarks
 * 日本語は分かち書きをしないため、文全体で部分一致を取ると何も当たらない。
 * プロトタイプでは助詞と記号で区切る簡易な方法を用いる。
 * 本格的な検索は、全文検索と意味的検索の併用に置き換える（仕様書 第9.7節）。
 */
function tokenize(query: string): string[] {
  const separators = /[\s、。，．,.?？!！「」『』（）()：:；;・/]|[はがをにでとのへやもからまでより]/g;
  return [...new Set(query.split(separators).filter((t) => t.length >= 2))];
}

function configureTypeParsers(): void {
  const NUMERIC = 1700;
  const TIMESTAMPTZ = 1184;
  const TIMESTAMP = 1114;
  pg.types.setTypeParser(NUMERIC, (v) => Number(v));
  pg.types.setTypeParser(TIMESTAMPTZ, (v) => new Date(v).toISOString());
  pg.types.setTypeParser(TIMESTAMP, (v) => new Date(v).toISOString());
}
configureTypeParsers();

export class PostgresRepository implements Repository {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  /** 接続を閉じる。プロセス終了時に呼ぶ。 */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query<T>(text, params as never[]);
    return res.rows;
  }

  async findTenantBySubdomain(subdomain: string): Promise<Tenant | null> {
    const rows = await this.q<Tenant>(
      `select id, subdomain, name, workspace_domain as "workspaceDomain", status
         from tenants where subdomain = $1`,
      [subdomain],
    );
    return rows[0] ?? null;
  }

  async findUserByEmail(tenantId: string, email: string): Promise<User | null> {
    const rows = await this.q<User>(
      `select id, tenant_id as "tenantId", email, display_name as "displayName",
              roles, status
         from users where tenant_id = $1 and email = $2`,
      [tenantId, email],
    );
    return rows[0] ?? null;
  }

  async listUsers(tenantId: string): Promise<User[]> {
    return this.q<User>(
      `select id, tenant_id as "tenantId", email, display_name as "displayName",
              roles, status
         from users where tenant_id = $1 order by email`,
      [tenantId],
    );
  }

  async createJob(job: Job): Promise<void> {
    await this.q(
      `insert into jobs (id, tenant_id, agent_id, agent_version, requested_by,
                         origin, input, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [job.id, job.tenantId, job.agentId, job.agentVersion, job.requestedBy,
       job.origin, JSON.stringify(job.input), job.createdAt],
    );
  }

  async getJob(tenantId: string, jobId: string): Promise<Job | null> {
    const rows = await this.q<Job>(
      `select id, tenant_id as "tenantId", agent_id as "agentId",
              agent_version as "agentVersion", requested_by as "requestedBy",
              origin, input, created_at as "createdAt"
         from jobs where tenant_id = $1 and id = $2`,
      [tenantId, jobId],
    );
    return rows[0] ?? null;
  }

  async createRun(run: Run): Promise<void> {
    await this.q(
      `insert into runs (id, job_id, tenant_id, status, cursor, started_at,
                         ended_at, tokens_used, cost_jpy, failure_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [run.id, run.jobId, run.tenantId, run.status, run.cursor, run.startedAt,
       run.endedAt, run.tokensUsed, run.costJpy, run.failureReason],
    );
  }

  async getRun(tenantId: string, runId: string): Promise<Run | null> {
    const rows = await this.q<Run>(
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
    await this.q(
      `update runs set status=$3, cursor=$4, ended_at=$5, tokens_used=$6,
                       cost_jpy=$7, failure_reason=$8
         where tenant_id=$1 and id=$2`,
      [run.tenantId, run.id, run.status, run.cursor, run.endedAt,
       run.tokensUsed, run.costJpy, run.failureReason],
    );
  }

  async listRuns(tenantId: string, limit: number): Promise<Run[]> {
    return this.q<Run>(
      `select id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
              started_at as "startedAt", ended_at as "endedAt",
              tokens_used as "tokensUsed", cost_jpy as "costJpy",
              failure_reason as "failureReason"
         from runs where tenant_id = $1 order by started_at desc limit $2`,
      [tenantId, limit],
    );
  }

  /**
   * 実行待ちのジョブを 1 件だけ確保する。
   *
   * @remarks
   * `for update skip locked` により、ワーカーを複数動かしても
   * 同じ実行を二重に処理しない（仕様書 第15章 二重実行防止）。
   */
  async claimNextRun(): Promise<Run | null> {
    const rows = await this.q<Run>(
      `update runs set status = 'running'
         where id = (
           select id from runs where status = 'queued'
            order by started_at asc for update skip locked limit 1
         )
       returning id, job_id as "jobId", tenant_id as "tenantId", status, cursor,
                 started_at as "startedAt", ended_at as "endedAt",
                 tokens_used as "tokensUsed", cost_jpy as "costJpy",
                 failure_reason as "failureReason"`,
    );
    return rows[0] ?? null;
  }

  async appendRunStep(step: RunStep): Promise<void> {
    await this.q(
      `insert into run_steps (id, run_id, seq, step_id, kind, status, input,
                              output, started_at, ended_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [step.id, step.runId, step.seq, step.stepId, step.kind, step.status,
       JSON.stringify(step.input ?? null), JSON.stringify(step.output ?? null),
       step.startedAt, step.endedAt],
    );
  }

  async updateRunStep(step: RunStep): Promise<void> {
    await this.q(
      `update run_steps set status=$2, output=$3, ended_at=$4 where id=$1`,
      [step.id, step.status, JSON.stringify(step.output ?? null), step.endedAt],
    );
  }

  async listRunSteps(tenantId: string, runId: string): Promise<RunStep[]> {
    return this.q<RunStep>(
      `select s.id, s.run_id as "runId", s.seq, s.step_id as "stepId", s.kind,
              s.status, s.input, s.output, s.started_at as "startedAt",
              s.ended_at as "endedAt"
         from run_steps s join runs r on r.id = s.run_id
        where r.tenant_id = $1 and s.run_id = $2 order by s.seq`,
      [tenantId, runId],
    );
  }

  async getRunStepById(tenantId: string, runStepId: string): Promise<RunStep | null> {
    const rows = await this.q<RunStep>(
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
    await this.q(
      `insert into approvals (id, run_step_id, tenant_id, approver_role, present,
                              decision, decided_by, comment, decided_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [a.id, a.runStepId, a.tenantId, a.approverRole, a.present, a.decision,
       a.decidedBy, a.comment, a.decidedAt, a.createdAt],
    );
  }

  async getApproval(tenantId: string, id: string): Promise<Approval | null> {
    const rows = await this.q<Approval>(
      `select id, run_step_id as "runStepId", tenant_id as "tenantId",
              approver_role as "approverRole", present, decision,
              decided_by as "decidedBy", comment, decided_at as "decidedAt",
              created_at as "createdAt"
         from approvals where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    return rows[0] ?? null;
  }

  async listPendingApprovals(tenantId: string): Promise<Approval[]> {
    return this.q<Approval>(
      `select id, run_step_id as "runStepId", tenant_id as "tenantId",
              approver_role as "approverRole", present, decision,
              decided_by as "decidedBy", comment, decided_at as "decidedAt",
              created_at as "createdAt"
         from approvals
        where tenant_id = $1 and decision is null order by created_at`,
      [tenantId],
    );
  }

  async updateApproval(a: Approval): Promise<void> {
    await this.q(
      `update approvals set decision=$3, decided_by=$4, comment=$5, decided_at=$6
         where tenant_id=$1 and id=$2`,
      [a.tenantId, a.id, a.decision, a.decidedBy, a.comment, a.decidedAt],
    );
  }

  async createArtifact(a: Artifact): Promise<void> {
    await this.q(
      `insert into artifacts (id, run_id, tenant_id, kind, title, body, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [a.id, a.runId, a.tenantId, a.kind, a.title, a.body, a.createdAt],
    );
  }

  async listArtifacts(tenantId: string, runId: string): Promise<Artifact[]> {
    return this.q<Artifact>(
      `select id, run_id as "runId", tenant_id as "tenantId", kind, title, body,
              created_at as "createdAt"
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
    return this.q<KnowledgeHit>(
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
    await this.q(
      `insert into audit_events (id, tenant_id, actor_type, actor_id, action,
                                 target_type, target_id, detail, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.id, e.tenantId, e.actorType, e.actorId, e.action, e.targetType,
       e.targetId, JSON.stringify(e.detail), e.occurredAt],
    );
  }

  async listAudit(tenantId: string, limit: number): Promise<AuditEvent[]> {
    return this.q<AuditEvent>(
      `select id, tenant_id as "tenantId", actor_type as "actorType",
              actor_id as "actorId", action, target_type as "targetType",
              target_id as "targetId", detail, occurred_at as "occurredAt"
         from audit_events where tenant_id = $1
        order by occurred_at desc limit $2`,
      [tenantId, limit],
    );
  }
}
