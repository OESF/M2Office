/**
 * @file 永続化層のインターフェース。取得系はすべてテナント ID を引数に取る。
 *
 * @see 仕様書 第19章 データモデル
 */

import type {
  Approval, Artifact, AuditEvent, Job, Notification, Run, RunStep, Schedule, Session,
  StoredFile, Tenant, TenantSettings, User, UserGroup, UserSettings,
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

  appendRunStep(tenantId: string, step: RunStep): Promise<void>;
  updateRunStep(tenantId: string, step: RunStep): Promise<void>;
  listRunSteps(tenantId: string, runId: string): Promise<RunStep[]>;
  /** ステップ ID から 1 件取得する。テナントを跨いだ取得は `null` を返す。 */
  getRunStepById(tenantId: string, runStepId: string): Promise<RunStep | null>;

  createApproval(approval: Approval): Promise<void>;
  getApproval(tenantId: string, approvalId: string): Promise<Approval | null>;
  listPendingApprovals(tenantId: string): Promise<Approval[]>;
  /** 1 つの実行の承認（判断済みを含む）。実行の中身を見られる人の判定に使う（仕様書 第6.2.1節）。 */
  listRunApprovals(tenantId: string, runId: string): Promise<Approval[]>;
  /** 入力にそのファイルの ID を含む依頼の実行の承認（判断済みを含む）。利用者が上げたファイルを開ける人の判定に使う。 */
  listApprovalsForFileInput(tenantId: string, fileId: string): Promise<Approval[]>;
  updateApproval(approval: Approval): Promise<void>;

  createArtifact(artifact: Artifact): Promise<void>;
  listArtifacts(tenantId: string, runId: string): Promise<Artifact[]>;

  /**
   * 組織知識を検索し、関係の深い節を返す（仕様書 第11.7.3節）。区画外の利用者には区画内の節を返さない。
   *
   * @remarks 古い分け方で分けた知識があれば、検索の前に分け直す（第11.7.5節）。
   */
  searchKnowledge(
    tenantId: string,
    query: string,
    compartment: string | null,
  ): Promise<KnowledgeSearchResult>;

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
  findActiveSession(tenantId: string, id: string, now: Date): Promise<Session | null>;
  touchSession(tenantId: string, id: string, now: Date): Promise<void>;
  revokeSession(tenantId: string, id: string, now: Date): Promise<void>;

  /** 会社の設定を返す。未保存の区分は既定値で補う。 */
  getTenantSettings(tenantId: string): Promise<TenantSettings>;
  /** 会社の設定の 1 区分を保存する。 */
  saveTenantSettings<K extends keyof TenantSettings>(
    tenantId: string, section: K, value: TenantSettings[K], updatedBy: string,
  ): Promise<void>;

  /** 本人の設定を返す。未保存の区分は既定値で補う。 */
  getUserSettings(tenantId: string, userId: string): Promise<UserSettings>;
  saveUserSettings<K extends keyof UserSettings>(
    tenantId: string, userId: string, section: K, value: UserSettings[K],
  ): Promise<void>;
  /** 本人の有効なログイン状態の一覧（第6.5.8節）。 */
  listSessions(tenantId: string, userId: string, now: Date): Promise<Session[]>;
  /** 本人の実行件数と費用（期間内）。 */
  usageForUser(tenantId: string, userId: string, since: string): Promise<{ runs: number; costJpy: number }>;
  /** 本人が所属する権限区画の名前。 */
  /** 本人が入れる権限区画の名前。個別の割当と、割り当てたグループへの所属の両方を含む（第16.7.5節）。 */
  listUserCompartments(tenantId: string, userId: string): Promise<string[]>;

  /** 会社が導入した拡張機能（仕様書 第12.9.3節）。 */
  listInstalledExtensions(tenantId: string): Promise<InstalledExtension[]>;
  installExtension(record: InstalledExtension): Promise<void>;
  /** 導入をやめる。導入していなければ `false`。 */
  uninstallExtension(tenantId: string, extensionId: string): Promise<boolean>;
  /** 権限区画と、その割当（グループと個人）。管理者ページで使う。無効な区画も含む。 */
  listCompartmentAssignments(tenantId: string): Promise<CompartmentAssignment[]>;
  /** 権限区画を作る。名前は会社の中で重ならない。 */
  createCompartment(c: { id: string; tenantId: string; name: string; description: string }): Promise<void>;
  /** 権限区画の割当を丸ごと置き換える。その会社のグループと利用者だけを入れる。 */
  setCompartmentAssignment(
    tenantId: string, compartmentId: string, a: { groups: string[]; users: string[] }, assignedBy: string,
  ): Promise<void>;
  /** 会社の接続の設定（仕様書 第14.3.3節）。秘密の値は暗号化されたまま返す。無ければ `null`。 */
  getTenantCredential(tenantId: string, kind: CredentialKind): Promise<TenantCredential | null>;
  saveTenantCredential(c: TenantCredential): Promise<void>;
  deleteTenantCredential(tenantId: string, kind: CredentialKind): Promise<boolean>;
  /** 利用者の Google の接続。無ければ `null`。 */
  getGoogleConnection(tenantId: string, userId: string): Promise<GoogleConnection | null>;
  /** 会社の全員の Google の接続（管理者の一覧に使う。トークンは画面に出さない）。 */
  listGoogleConnections(tenantId: string): Promise<GoogleConnection[]>;
  saveGoogleConnection(c: GoogleConnection): Promise<void>;
  deleteGoogleConnection(tenantId: string, userId: string): Promise<boolean>;
  /** 会社のグループ（仕様書 第16.7節）。所属する人の ID を含む。名前の順。 */
  listGroups(tenantId: string): Promise<UserGroup[]>;
  /** グループを作る、または名前と説明を変える。 */
  saveGroup(group: Omit<UserGroup, 'memberIds'>): Promise<void>;
  /** グループを消す。所属も消える。無ければ `false`。 */
  deleteGroup(tenantId: string, groupId: string): Promise<boolean>;
  /** グループの所属を丸ごと置き換える。その会社の利用者だけを入れる。 */
  setGroupMembers(tenantId: string, groupId: string, userIds: string[]): Promise<void>;
  /** 利用者が所属するグループの ID。利用範囲の判定に使う。 */
  listUserGroupIds(tenantId: string, userId: string): Promise<string[]>;
  /** 導入した拡張機能の有効・無効を切り替える（第12.10.4節）。導入していなければ `false`。 */
  setExtensionEnabled(tenantId: string, extensionId: string, enabled: boolean): Promise<boolean>;
  /** ファイルから取り込んだ拡張機能（自社専用。第12.10.3節）。 */
  listPrivateExtensions(tenantId: string): Promise<PrivateExtension[]>;
  /** 取り込んだ拡張機能を保存する。同じ ID があれば置き換える。 */
  savePrivateExtension(record: PrivateExtension): Promise<void>;
  /** 取り込んだ拡張機能を消す。無ければ `false`。 */
  deletePrivateExtension(tenantId: string, extensionId: string): Promise<boolean>;

  createFile(file: StoredFile): Promise<void>;
  getFile(tenantId: string, id: string): Promise<StoredFile | null>;

  createUser(user: User): Promise<void>;
  /** 表示名・ロール・状態を更新する。メールアドレスは変えない（Google 側で管理する）。 */
  updateUser(user: User): Promise<void>;

  /** 組織知識の一覧（管理用）。本文を含む。 */
  listKnowledge(tenantId: string): Promise<KnowledgeItem[]>;
  /** 保存し、本文を節に分け直す。古い節と新しい節は 1 つのトランザクションで入れ替える（第11.7.5節）。 */
  saveKnowledge(item: KnowledgeItem): Promise<void>;
  /** 1 件の知識の節（見出しと字数）。分け方の確認に使う（第6.6.6節）。知識が無ければ `null`。 */
  listKnowledgeSections(tenantId: string, itemId: string): Promise<KnowledgeSectionView[] | null>;
  deleteKnowledge(tenantId: string, id: string): Promise<boolean>;
  /** 権限区画の一覧。 */
  listCompartments(tenantId: string): Promise<{ id: string; name: string; description: string | null }[]>;

  /** 最近操作した利用者の人数（ダッシュボードの「ログイン中」。仕様書 第6.7.4節）。 */
  countActiveUsers(tenantId: string, since: Date): Promise<number>;
  /**
   * 動いている実行（待機・実行中・承認待ち）と、指定時刻以降に失敗した実行を返す。
   *
   * @remarks ジョブの入力（`job.input`）は空で返す。ダッシュボードは中身を見る画面ではない。
   */
  listLiveRuns(tenantId: string, failedSince: string): Promise<{ run: Run; job: Job }[]>;
  /** 実行を日（日本時間）・時・エージェント・状態で束ねた集計。 */
  runStats(tenantId: string, since: string): Promise<RunStatRow[]>;
  /** 監査ログの操作を種類と対象で数える。 */
  countAuditActions(
    tenantId: string, since: string, actions: string[],
  ): Promise<{ action: string; targetId: string; n: number }[]>;
  /** 指定した種類の監査ログを新しい順に返す。 */
  listAuditSince(tenantId: string, actions: string[], limit: number): Promise<AuditEvent[]>;
  countKnowledge(tenantId: string): Promise<number>;

  /** 監査ログを追記する。更新と削除は用意しない（仕様書 第16.6節）。 */
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(tenantId: string, limit: number): Promise<AuditEvent[]>;
}

/** 知識検索の結果の 1 節。出典を必ず伴う（仕様書 第11.7.4節）。 */
export interface KnowledgeHit {
  /** 知識（文書）の ID。 */
  id: string;
  /** 文書の題名。 */
  title: string;
  /** 節の見出し（例: `第23条（年次有給休暇）`）。見出しのない短い文書では空。 */
  heading: string;
  /** 上位の見出しの経路。 */
  path: string[];
  /** 出典（`文書名 › 見出しの経路`）。 */
  citation: string;
  /** 節の本文。文書の全文ではない。 */
  body: string;
  /** 登録時の出典（リンク・ファイル名など）。 */
  source: string;
  compartment: string | null;
  /** 並べ替えの点数（第11.7.3節）。 */
  score: number;
}

/** 知識検索の結果。 */
export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** 言い換えで読み替えて見つけた言葉（第11.7.7節）。答えに「読み替えて探しました」と示す。 */
  rewrites: { from: string; to: string[] }[];
}

/** 知識の節の見え方（管理者の確認用）。 */
export interface KnowledgeSectionView {
  heading: string;
  path: string[];
  chars: number;
}

/** 組織知識の 1 件（管理用）。 */
export interface KnowledgeItem {
  id: string;
  tenantId: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  /** 権限区画。区画外は `null`（仕様書 第16.3節）。 */
  compartment: string | null;
  updatedAt: string;
  /** 版。保存のたびに 1 つ上がる。一覧でだけ返す。 */
  version?: number;
  /** 分けた節の数。一覧でだけ返す。 */
  sectionCount?: number;
}

/** 実行の集計の 1 行（日・時・エージェント・状態で束ねたもの）。 */
export interface RunStatRow {
  /** 日本時間の日付（YYYY-MM-DD）。 */
  day: string;
  /** 日本時間の時（0〜23）。 */
  hour: number;
  agentId: string;
  status: string;
  runs: number;
  costJpy: number;
  tokens: number;
  savedMinutes: number;
  /** 終了した実行の所要時間の合計（秒）。 */
  durationSec: number;
}

/** 接続の設定の種類。 */
export type CredentialKind = 'gemini' | 'google_oauth';

/** 会社の接続の設定。`secretEnc` は暗号化した秘密の値、`meta` は秘密でない値。 */
export interface TenantCredential {
  tenantId: string;
  kind: CredentialKind;
  secretEnc: string | null;
  meta: Record<string, unknown>;
  updatedBy: string;
  updatedAt: string;
}

/** 利用者の Google の接続。`refreshTokenEnc` は暗号化したリフレッシュ トークン。 */
export interface GoogleConnection {
  tenantId: string;
  userId: string;
  refreshTokenEnc: string;
  googleEmail: string | null;
  /** Google に実際に許可された範囲（短い名前）。最後に確かめたとき。 */
  scopes: string[];
  connectedAt: string;
  checkedAt: string;
}

/** 権限区画と、その割当。 */
export interface CompartmentAssignment {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** 割り当てたグループの ID。 */
  groups: string[];
  /** 個別に割り当てた利用者の ID。 */
  users: string[];
}

/** 会社が導入した拡張機能の記録。同意した権限を残す（不変則 I-8）。 */
export interface InstalledExtension {
  tenantId: string;
  extensionId: string;
  version: string;
  /** 同意した権限。コネクタの接続先とツールの危険度を含む（第12.11.2節）。 */
  consentedPermissions: { tools: string[]; max_risk_level: string; connectors?: unknown[] };
  installedBy: string;
  installedAt: string;
  /** 有効か（スイッチ）。無効なら業務エージェントもコネクタも使えない。 */
  enabled: boolean;
}

/** ファイルから取り込んだ拡張機能（自社専用）。 */
export interface PrivateExtension {
  tenantId: string;
  extensionId: string;
  version: string;
  /** パッケージの中のパス → 中身（Base64）。 */
  files: Record<string, string>;
  sizeBytes: number;
  importedBy: string;
  importedAt: string;
}
