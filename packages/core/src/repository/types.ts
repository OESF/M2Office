import type {
  Approval, Artifact, AuditEvent, Job, Notification, Run, RunStep, Schedule, Session,
  Tenant, User,
} from '@m2office/shared';

/**
 * 永続化層のインターフェース。
 *
 * @remarks
 * テナント境界: 取得系はすべて `tenantId` を引数に取る。
 * 実装側では、さらにデータベースの行レベルセキュリティで二重に守る
 * （仕様書 第8.5.5節、不変則 I-2）。
 */
export interface Repository {
  /** サブドメインからテナントを解決する。見つからなければ `null`。 */
  findTenantBySubdomain(subdomain: string): Promise<Tenant | null>;
  findUserByEmail(tenantId: string, email: string): Promise<User | null>;
  findUserById(tenantId: string, userId: string): Promise<User | null>;
  listUsers(tenantId: string): Promise<User[]>;

  createJob(job: Job): Promise<void>;
  createRun(run: Run): Promise<void>;
  /** 実行を取得する。テナントを跨いだ取得は `null` を返す。 */
  getRun(tenantId: string, runId: string): Promise<Run | null>;
  getJob(tenantId: string, jobId: string): Promise<Job | null>;
  updateRun(run: Run): Promise<void>;
  listRuns(tenantId: string, limit: number): Promise<Run[]>;
  /**
   * 実行とジョブを組にして新しい順に返す。
   *
   * @param opts.requestedBy 指定すれば、その利用者が依頼したものに絞る
   */
  listRunsWithJobs(
    tenantId: string,
    opts: { limit: number; requestedBy?: string },
  ): Promise<{ run: Run; job: Job }[]>;
  /** エージェント別の実行件数・トークン・費用を集計する。 */
  usageByAgent(tenantId: string): Promise<{ agentId: string; runs: number; tokens: number; costJpy: number }[]>;
  /** 実行待ちのジョブを 1 件取り出して `running` にする（ワーカー用）。 */
  claimNextRun(): Promise<Run | null>;

  appendRunStep(step: RunStep): Promise<void>;
  updateRunStep(step: RunStep): Promise<void>;
  listRunSteps(tenantId: string, runId: string): Promise<RunStep[]>;
  /** ステップ ID から 1 件取得する。テナントを跨いだ取得は `null` を返す。 */
  getRunStepById(tenantId: string, runStepId: string): Promise<RunStep | null>;

  createApproval(approval: Approval): Promise<void>;
  getApproval(tenantId: string, approvalId: string): Promise<Approval | null>;
  listPendingApprovals(tenantId: string): Promise<Approval[]>;
  updateApproval(approval: Approval): Promise<void>;

  createArtifact(artifact: Artifact): Promise<void>;
  listArtifacts(tenantId: string, runId: string): Promise<Artifact[]>;

  /** 組織知識を全文で検索する。区画外の利用者には区画内の文書を返さない。 */
  searchKnowledge(
    tenantId: string,
    query: string,
    compartment: string | null,
  ): Promise<KnowledgeHit[]>;

  /** 本人宛の通知を保存する。宛先の決定はツール側で行う。 */
  createNotification(n: Notification): Promise<void>;
  /** 本人の通知を新しい順に返す。他人の通知は返さない。 */
  listNotifications(tenantId: string, userId: string, limit: number): Promise<Notification[]>;
  /** 既読にする。本人の通知でなければ `false`。 */
  markNotificationRead(tenantId: string, userId: string, id: string): Promise<boolean>;

  createSchedule(s: Schedule): Promise<void>;
  /** 利用者の定時実行を返す。`userId` が `null` ならテナント全体。 */
  listSchedules(tenantId: string, userId: string | null): Promise<Schedule[]>;
  getSchedule(tenantId: string, id: string): Promise<Schedule | null>;
  updateSchedule(s: Schedule): Promise<void>;
  /**
   * 実行時刻を過ぎた定時実行を 1 件確保し、次回の時刻を進める（ワーカー用）。
   *
   * @param now 現在時刻
   * @param computeNext 次回の実行時刻を求める関数
   * @returns 確保した定時実行（次回時刻を進める前の値）。無ければ `null`
   *
   * @remarks
   * ワーカーを複数動かしても同じ回を二重に起動しない。
   */
  claimDueSchedule(now: Date, computeNext: (s: Schedule) => string): Promise<Schedule | null>;

  createSession(s: Session): Promise<void>;
  /** 有効なログイン状態を返す。失効・期限切れは `null`。 */
  findActiveSession(id: string, now: Date): Promise<Session | null>;
  touchSession(id: string, now: Date): Promise<void>;
  revokeSession(id: string, now: Date): Promise<void>;

  /** 監査ログを追記する。更新と削除は用意しない（仕様書 第16.6節）。 */
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(tenantId: string, limit: number): Promise<AuditEvent[]>;
}

/** 知識検索の結果。出典を必ず伴う（仕様書 第11.7節）。 */
export interface KnowledgeHit {
  id: string;
  title: string;
  body: string;
  source: string;
  compartment: string | null;
}
