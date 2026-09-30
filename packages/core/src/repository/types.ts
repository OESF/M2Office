/**
 * @file 永続化層のインターフェース。取得系はすべてテナント ID を引数に取る。
 *
 * @see 仕様書 第19章 データモデル
 */

import type {
  Approval, Artifact, AuditEvent, Job, Notification, Run, RunStep, Schedule, Session,
  StoredFile, Tenant, TenantSettings, User, UserGroup, UserSettings,
} from '@m2office/shared';
import type { ConnectorDeclaration } from '../extensions/connectors.js';

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
  /** ID でテナントを引く。サブドメインを持たない要求（Google からの戻りなど）で状態を確かめるのに使う。 */
  findTenantById(tenantId: string): Promise<Tenant | null>;
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
  /**
   * その人が判断した承認と却下（仕様書 第6.2.5節）。新しい順。自動で通過したもの・期限切れ・取り消しは含まない。
   *
   * @returns 承認と、その実行と依頼の要点（業務・依頼した人）
   */
  listDecidedApprovals(tenantId: string, userId: string, limit: number): Promise<DecidedApproval[]>;
  /** 入力にそのファイルの ID を含む依頼の実行の承認（判断済みを含む）。利用者が上げたファイルを開ける人の判定に使う。 */
  listApprovalsForFileInput(tenantId: string, fileId: string): Promise<Approval[]>;
  /** 指定した時刻より前から承認待ちの承認（期限切れの見回り。仕様書 第14.3.2節）。 */
  listStaleApprovals(tenantId: string, createdBefore: string): Promise<Approval[]>;

  /** すべての会社の ID（保持期間の見回りのため。テナント台帳の参照）。 */
  listTenantIds(): Promise<string[]>;
  /** 終わった実行のうち、保持期間の処理がまだで、指定した時刻より前に終わったもの（古い順）。 */
  listRunsForRetention(tenantId: string, endedBefore: string, limit: number): Promise<Run[]>;
  /** その人が依頼した終わった実行のうち、Google 由来の中身をまだ消していないもの（連携の解除のとき）。 */
  listUserRunsForPurge(tenantId: string, userId: string): Promise<Run[]>;
  /**
   * 保持期間の処理を済ませたことを記録する。`steps` を渡せば、1 つのトランザクションでステップの中身を置き換え、
   * 承認の表示（`present`）と、その実行の通知の本文も消す。`null` なら、消すものが無かったとして記録だけする。
   */
  markRunRetention(tenantId: string, runId: string, steps: RunStep[] | null, redactedPresent: string, at: string): Promise<void>;
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
    /** 秘書が考えた言い換え（第11.7.7.0節）。登録した言い換えと同じように効かせる。 */
    extraSynonyms?: readonly (readonly string[])[],
    opts?: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchResult>;

  /** 本人宛の通知を保存する。宛先の決定はツール側で行う。 */
  createNotification(n: Notification): Promise<void>;
  /** 本人の通知を新しい順に返す。他人の通知は返さない。 */
  listNotifications(tenantId: string, userId: string, limit: number): Promise<Notification[]>;
  /**
   * まだ控えを届けていない通知（仕様書 第6.5.5.2節）。古い順に返す。
   *
   * @param limit 1 回の見回りで扱う数
   */
  listUndeliveredNotifications(tenantId: string, limit: number): Promise<Notification[]>;
  /**
   * 控えの届け先と結果を記録する。
   *
   * @param deliveredAt 届け終えた時刻。`null` なら次の見回りでもう一度試す
   * @param note 届け先、または送れなかった理由
   */
  markNotificationDelivered(
    tenantId: string, id: string, deliveredAt: string | null, note: string,
  ): Promise<void>;
  /** 既読にする。本人の通知でなければ `false`。 */
  markNotificationRead(tenantId: string, userId: string, id: string): Promise<boolean>;
  /**
   * 本人の通知を消す（仕様書 第6.5.5節）。ほかの人の通知は消さない。
   *
   * @returns 消した数
   */
  deleteNotifications(tenantId: string, userId: string, ids: string[]): Promise<number>;

  createSchedule(s: Schedule): Promise<void>;
  /** 利用者の定時実行を返す。`userId` が `null` ならテナント全体。 */
  listSchedules(tenantId: string, userId: string | null): Promise<Schedule[]>;
  getSchedule(tenantId: string, id: string): Promise<Schedule | null>;
  updateSchedule(s: Schedule): Promise<void>;
  /** 定時実行を消す。消したら `true`（仕様書 第6.1.7節）。動いている実行は止めない。 */
  deleteSchedule(tenantId: string, id: string): Promise<boolean>;
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
  /**
   * 会社の全員の、秘書の設定（名前・アバター）を返す（仕様書 第6.7.4.4節）。未保存の人は含めない。
   *
   * @remarks ダッシュボードで本人と秘書を 1 組にして並べるために使う。1 人ずつ引くと、更新のたびに人数ぶん問い合わせるため
   */
  listSecretarySettings(tenantId: string): Promise<Map<string, UserSettings['secretary']>>;

  /**
   * 会話ログを 1 往復ぶん残す（仕様書 第11.9.4.1節）。
   *
   * @remarks 本人が「会話を残す」を切っている場合、呼び出し側が呼ばない。
   */
  appendConversation(c: Conversation): Promise<void>;
  /**
   * 本人の会話ログ（新しい順）。本人以外に渡さない（不変則 I-10）。
   *
   * @param query 語句。空なら絞り込まない
   */
  listConversations(
    tenantId: string, userId: string, opts: { query?: string; limit: number },
  ): Promise<Conversation[]>;
  /** 1 件を消す。本人のものでなければ消さず `false`。 */
  deleteConversation(tenantId: string, userId: string, id: string): Promise<boolean>;
  /**
   * 本人の会話を消す。
   *
   * @param since この時刻より後のものだけを消す（「この会話は残さないで」）。省略ならすべて
   */
  clearConversations(tenantId: string, userId: string, since?: string): Promise<number>;
  /** 直近の会話に、そこから始まった実行を結び付ける（評価を引くため。第11.9.5節 第 4 項）。 */
  linkConversationRun(tenantId: string, userId: string, runId: string, since: string): Promise<void>;
  /** 保持期間（4 週）を過ぎた逐語を消す。テナントを横断して呼ぶ（第11.9.6節）。 */
  deleteConversationsBefore(tenantId: string, before: string): Promise<number>;

  /** ある日の会話（要約と候補を作るために読む。仕様書 第11.5.2節）。 */
  listConversationsOfDay(tenantId: string, userId: string, day: { from: string; to: string }): Promise<Conversation[]>;
  /** 会話ログを持つ利用者の ID（その日ぶん）。 */
  listConversationUserIds(tenantId: string, day: { from: string; to: string }): Promise<string[]>;
  /** 会話を 1 往復読む。本人が消していれば `null`。 */
  getConversation(tenantId: string, id: string): Promise<Conversation | null>;

  /**
   * 次に処理する業務と秘書のイベントを 1 件確保する（仕様書 第10.13節、ADR-0039）。
   *
   * @remarks 会社をまたいで見るのはデータベースの関数だけ。確保すると 2 分間はほかのワーカーに渡らない
   */
  claimAgentEvent(): Promise<{ id: string; tenantId: string } | null>;
  getAgentEvent(tenantId: string, id: string): Promise<AgentEvent | null>;
  /** 処理を終える。`error` があれば処理済みにせず、理由を残す（確保の期限のあとにやり直す）。 */
  finishAgentEvent(tenantId: string, id: string, error: string | null): Promise<void>;
  /** 処理済みで、指定の時刻より古いイベントを消す。消した数を返す。 */
  purgeAgentEvents(tenantId: string, before: string): Promise<number>;

  /** 段取りを作る（仕様書 第10.14節）。作るとデータベースがイベント `plan.requested` を書く。 */
  createPlan(p: Plan): Promise<void>;
  getPlan(tenantId: string, id: string): Promise<Plan | null>;
  /** 本人の、まだ終わっていない段取り（新しい順）。 */
  listActivePlans(tenantId: string, userId: string): Promise<Plan[]>;
  /** 段取りを書き換える。`waiting_input` から `running` にするとイベント `plan.resumed` が書かれる。 */
  updatePlan(p: Plan): Promise<void>;
  createPlanSteps(steps: PlanStep[]): Promise<void>;
  listPlanSteps(tenantId: string, planId: string): Promise<PlanStep[]>;
  getPlanStep(tenantId: string, id: string): Promise<PlanStep | null>;
  updatePlanStep(step: PlanStep): Promise<void>;
  /** その日の会話の要約を保存する（長期に持つ。第11.9.6節）。 */
  saveConversationDigest(d: ConversationDigest): Promise<void>;
  /** 本人の会話の要約（新しい順）。 */
  listConversationDigests(tenantId: string, userId: string, limit: number): Promise<ConversationDigest[]>;

  /** 記憶の候補（第11.5.2節）。`status` で絞る。 */
  listMemoryCandidates(tenantId: string, userId: string, status: 'pending' | 'dismissed'): Promise<MemoryCandidate[]>;
  createMemoryCandidate(c: MemoryCandidate): Promise<void>;
  /** 候補の判断を記録する。採ったものは呼び出し側が記憶にしてから消す。 */
  updateMemoryCandidate(tenantId: string, userId: string, id: string, status: 'dismissed'): Promise<boolean>;
  deleteMemoryCandidate(tenantId: string, userId: string, id: string): Promise<MemoryCandidate | null>;

  /** 昇華の提案を作る（仕様書 第11.3.1節）。 */
  createPromotion(p: Promotion): Promise<void>;
  /** 会社の昇華の提案。`status` で絞る（組織の承認待ちの一覧などに使う）。 */
  listPromotions(tenantId: string, opts: { status?: Promotion['status']; userId?: string }): Promise<Promotion[]>;
  getPromotion(tenantId: string, id: string): Promise<Promotion | null>;
  updatePromotion(p: Promotion): Promise<void>;

  /** 本人の個人記憶（使っているものだけ。新しい順。仕様書 第11.5.1節）。本人以外に渡さない。 */
  listMemories(tenantId: string, userId: string): Promise<Memory[]>;
  /** 本人の記憶のうち、整理でしまったもの（新しい順。第11.11.4節）。 */
  listArchivedMemories(tenantId: string, userId: string): Promise<Memory[]>;
  /**
   * 記憶をしまう・戻す（第11.11.4節）。本人のものでなければ変えず `false` を返す。
   *
   * @param reason しまう理由（`merged`・`stale`・`unused`）。戻すときは `null`
   */
  setMemoryStatus(tenantId: string, userId: string, id: string, status: 'active' | 'archived', reason: string | null, mergedInto: string | null, at: string): Promise<boolean>;
  /** 会話の材料に使った記憶の、使った日を記録する（第11.11.4節「使われないもの」）。 */
  touchMemories(tenantId: string, userId: string, ids: string[], at: string): Promise<void>;
  /** 記憶を持っている利用者（週 1 回の整理の対象）。 */
  listMemoryOwners(tenantId: string): Promise<string[]>;
  /** しまってから指定の日時より前の記憶を消す。消した数を返す。 */
  purgeArchivedMemories(tenantId: string, before: string): Promise<number>;
  createMemory(memory: Memory): Promise<void>;
  /** 1 件を消す。本人のものでなければ消さず `false` を返す。 */
  deleteMemory(tenantId: string, userId: string, id: string): Promise<boolean>;
  /**
   * 1 件の文を本人が直す（仕様書 第11.5.2節）。きっかけは本人の指示（`secretary`）に改める。
   * 本人のものでなければ直さず `false` を返す。
   */
  updateMemory(tenantId: string, userId: string, id: string, text: string): Promise<boolean>;
  /** 本人の記憶をすべて消す。 */
  clearMemories(tenantId: string, userId: string): Promise<number>;
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
  /**
   * 管理者が個別に止めたコネクタのツール（仕様書 第6.6.3.1節）。
   *
   * @remarks 止めたものだけが返る。載っていないツールは有効である。
   */
  listDisabledConnectorTools(tenantId: string): Promise<DisabledConnectorTool[]>;
  /** 会社の接続（コネクタ。MCP サーバ。仕様書 第12.11節、ADR-0037）。ID の順。 */
  listConnections(tenantId: string): Promise<TenantConnection[]>;
  /** 会社の接続を登録する・書き換える（ID が同じなら置き換える）。 */
  saveConnection(c: TenantConnection): Promise<void>;
  /** 会社の接続を消す。無ければ `false`。認証情報と利用者ごとの認可も一緒に消える。 */
  deleteConnection(tenantId: string, id: string): Promise<boolean>;
  /** 会社の接続の認証情報（仕様書 第12.11.6節）。無ければ `null`。 */
  getConnectionSecret(tenantId: string, connectionId: string): Promise<ConnectionSecret | null>;
  saveConnectionSecret(s: ConnectionSecret): Promise<void>;
  /** 利用者の接続の認可。無ければ `null`。 */
  getUserConnection(tenantId: string, userId: string, connectionId: string): Promise<UserConnection | null>;
  /** 接続の認可の一覧。`userId` を渡せばその人のもの、`connectionId` を渡せばその接続のものだけ。 */
  listUserConnections(tenantId: string, filter?: { userId?: string; connectionId?: string }): Promise<UserConnection[]>;
  saveUserConnection(c: UserConnection): Promise<void>;
  /** 利用者の接続の認可を消す。無ければ `false`。 */
  deleteUserConnection(tenantId: string, userId: string, connectionId: string): Promise<boolean>;
  /** その接続の全員の認可を消す（クライアント ID を替えたとき。第12.11.6.2節）。消した数を返す。 */
  deleteUserConnectionsFor(tenantId: string, connectionId: string): Promise<number>;
  /**
   * 調べものの結果を伝えたことを記録する（仕様書 第10.11.7節「持ち越し」）。
   *
   * @returns **この呼び出しで記録できたら `true`**。すでに誰かが記録していれば `false`
   * @remarks
   * 伝える前に呼び、`true` のときだけ伝える。
   * 画面と音声の両方から伝えうるため、これで二度伝えることを防ぐ。
   */
  claimLookupDelivery(tenantId: string, runId: string): Promise<boolean>;
  /** すでに伝えた調べものの実行の ID（仕様書 第10.11.7節）。 */
  listToldLookups(tenantId: string, runIds: string[]): Promise<string[]>;
  /** 本人のアバター（Google のプロフィール写真。仕様書 第6.5.1.1節）。無ければ `null`。 */
  getUserPhoto(tenantId: string, userId: string): Promise<UserPhoto | null>;
  /** 本人のアバターを上書きする。1 人 1 枚で、古い写真は残さない。 */
  saveUserPhoto(photo: UserPhoto): Promise<void>;
  /**
   * 写真を持っている人と、取り込んだ時刻（仕様書 第6.7.4.4節）。画像そのものは読まない。
   *
   * @returns 利用者の ID → 取り込んだ時刻。画面の URL に添え、取り込み直したら読み直させる
   */
  listUserPhotoStamps(tenantId: string): Promise<Map<string, string>>;
  /**
   * 同じ依頼で動いている調べものを探す（仕様書 第10.11.4節）。
   *
   * @returns 動いていればその実行の ID。無ければ `null`
   * @remarks
   * 同じ依頼を二度起こさないために使う。推論は結果が返らないと
   * 「まだ実行できていない」と解釈して同じ依頼を繰り返す性質がある。
   */
  findActiveJobByInput(
    tenantId: string, userId: string, agentId: string, key: string, value: string,
  ): Promise<string | null>;
  /**
   * 秘書に渡しただけのファイルを消す（仕様書 第10.10.5節）。
   *
   * @param before この時刻より前に上げたものを消す
   * @returns 消したファイルの ID。呼び出し側が実体も消す
   *
   * @remarks
   * **どの依頼の入力にも使われていないもの**だけを消す。
   * 1 つのファイルは複数の実行で使われうるため、実行との 1 対 1 の紐づけは持たない。
   * **秘書のアバターに使っている画像も消さない**（仕様書 第10.10.5節）。
   */
  deleteLooseUploadsBefore(tenantId: string, before: string): Promise<string[]>;
  /**
   * コネクタのツールを 1 つ、有効または無効にする。
   *
   * @param by 決めた管理者。監査のために残す
   */
  setConnectorToolEnabled(
    tenantId: string, connectorId: string, toolName: string, enabled: boolean, by: string,
  ): Promise<void>;
  installExtension(record: InstalledExtension): Promise<void>;
  /** 導入をやめる。導入していなければ `false`。 */
  uninstallExtension(tenantId: string, extensionId: string): Promise<boolean>;
  /** 権限区画と、その割当（グループと個人）。管理者ページで使う。無効な区画も含む。 */
  listCompartmentAssignments(tenantId: string): Promise<CompartmentAssignment[]>;
  /** 権限区画を作る。名前は会社の中で重ならない。 */
  createCompartment(c: { id: string; tenantId: string; name: string; description: string }): Promise<void>;
  /**
   * 区画を使うか（仕様書 第16.3.6.1節）。無効の間は誰も区画に入れない。
   *
   * @returns 変えられたら `true`。区画が無ければ `false`
   */
  setCompartmentEnabled(tenantId: string, compartmentId: string, enabled: boolean): Promise<boolean>;
  /**
   * 区画を消す（割当も消える）。
   *
   * @remarks 区画に属する知識・業務が残っていないことは、呼び出し側が先に確かめる（第16.3.6.1節）。
   */
  deleteCompartment(tenantId: string, compartmentId: string): Promise<boolean>;
  /** その区画に属する組織知識の数（削除してよいかの判断に使う）。 */
  countKnowledgeInCompartment(tenantId: string, compartment: string): Promise<number>;
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

  /**
   * 組織知識の一覧（管理用）。本文を含む。
   *
   * @param opts.all 廃止した・しまったものも返す（管理者の一覧）。既定は使っているものだけ
   */
  listKnowledge(tenantId: string, opts?: { all?: boolean }): Promise<KnowledgeItem[]>;
  /**
   * 社内規程の版を保存する（第11.11.2節）。新しい規程なら作る。施行日が今日（日本時間）までなら施行している版に写して節に分け直し、
   * 先なら版だけを残す（施行日に検索の時点で切り替わる）。
   *
   * @returns 保存した版の番号と、施行している版に写したか。ほかの会社の同じ ID なら `null`
   */
  saveRuleVersion(item: KnowledgeItem & { effectiveFrom: string }, savedBy: string, today: string): Promise<{ version: number; applied: boolean } | null>;
  /** 社内規程の版の一覧（新しい版から。本文は含めない）。知識が無ければ `null`。 */
  listKnowledgeVersions(tenantId: string, itemId: string): Promise<KnowledgeVersion[] | null>;
  /** 社内規程の 1 つの版（本文つき）。 */
  getKnowledgeVersion(tenantId: string, itemId: string, version: number): Promise<KnowledgeVersion | null>;
  /**
   * 知識の状態を変える（廃止・しまう・戻す。第11.11節）。変えれば `true`。
   *
   * @param reason しまう理由。廃止と戻すは `null`
   */
  setKnowledgeStatus(tenantId: string, id: string, status: KnowledgeStatus, reason: string | null, mergedInto: string | null, at: string): Promise<boolean>;
  /** 答えの根拠に使った知識の、使った日を記録する。 */
  touchKnowledge(tenantId: string, ids: string[], at: string): Promise<void>;
  /**
   * 残す期間を過ぎた知識を消す（第11.11節）。しまった秘書が学んだことと廃止した議事録は 1 年、廃止した規程と古い版は 7 年。
   *
   * @returns 消した知識の数と版の数
   */
  purgeKnowledge(tenantId: string, now: Date): Promise<{ items: number; versions: number }>;
  /** 規程の版に、人事・給与の設定と食い違う項目を残す（第30.8.2節）。 */
  setRuleHrCheck(tenantId: string, itemId: string, version: number, check: unknown): Promise<void>;
  /** 見終えていない、人事・給与の設定と食い違う項目のある規程の版（新しいものから）。 */
  listRuleHrChecks(tenantId: string): Promise<KnowledgeVersion[]>;
  /** 人事・給与の設定との食い違いを見終えた。 */
  dismissRuleHrCheck(tenantId: string, itemId: string, version: number, at: string): Promise<boolean>;
  /** 保存し、本文を節に分け直す。古い節と新しい節は 1 つのトランザクションで入れ替える（第11.7.5節）。 */
  saveKnowledge(item: KnowledgeItem): Promise<void>;
  /** 1 件の知識の節（見出しと字数）。分け方の確認に使う（第6.6.6節）。知識が無ければ `null`。 */
  listKnowledgeSections(tenantId: string, itemId: string): Promise<KnowledgeSectionView[] | null>;
  deleteKnowledge(tenantId: string, id: string): Promise<boolean>;
  /** 権限区画の一覧。 */
  listCompartments(tenantId: string): Promise<{ id: string; name: string; description: string | null }[]>;

  /**
   * 有効なログイン状態を、利用者ごとに 1 つ（最後に操作したもの）返す（仕様書 第6.7.4.1節）。
   *
   * @remarks 人の状態を組み立てるのに使う。接続元の場所は持たない（第6.7.10節 規定 2）。
   */
  listActiveSessions(tenantId: string): Promise<{ userId: string; lastSeenAt: string; userAgent: string | null }[]>;
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
  /**
   * 監査ログを絞って探す（仕様書 第6.6.8.1節）。新しい順。
   *
   * @remarks
   * `userId` は、その人が行ったものと、その人の依頼で秘書や業務が行ったもの（記録の根拠の `runId` の実行を依頼した人）を返す。
   * `actions` は操作の名前の頭（`approval.` など）。どれかに当たれば返す
   */
  searchAudit(tenantId: string, q: AuditQuery): Promise<AuditEvent[]>;
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
  /** 知識の種類（第11.11.1節）。根拠は社内規程 → 議事録 → 秘書が学んだことの順に並ぶ。 */
  category: KnowledgeCategory;
  /** 改定前の規程の版から見つけたとき、その版と施行日（第11.11.2節）。 */
  oldVersion?: { version: number; effectiveFrom: string };
}

/** 知識の種類（第11.11.1節）。`rule`: 社内規程、`minutes`: 議事録、`learned`: 秘書が学んだこと。 */
export type KnowledgeCategory = 'rule' | 'minutes' | 'learned';
/** 知識の状態。`retired`: 廃止した（社内規程・議事録）、`archived`: しまった（秘書が学んだこと）。 */
export type KnowledgeStatus = 'active' | 'retired' | 'archived';

/** 組織知識の検索の選び方。 */
export interface KnowledgeSearchOptions {
  /** 探す種類。既定はすべて。 */
  categories?: KnowledgeCategory[];
  /** 見つけた知識の「使った日」を記録するか。既定は記録する（整理の確かめのための検索では記録しない）。 */
  touch?: boolean;
}

/** 社内規程の 1 つの版（第11.11.2節）。 */
export interface KnowledgeVersion {
  itemId: string;
  version: number;
  effectiveFrom: string;
  title: string;
  /** 本文。一覧では空。 */
  body: string;
  source: string;
  compartment: string | null;
  savedBy: string | null;
  savedAt: string;
  /** いま施行している版か。 */
  current: boolean;
  /** 施行日が先の版か。 */
  pending: boolean;
  /** 本文の字数。 */
  chars: number;
  /** 人事・給与の設定と食い違う項目（第30.8.2節）。無ければ `null`。 */
  hrCheck?: unknown;
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
/**
 * 会話ログの 1 往復（仕様書 第11.9.4.1節）。
 *
 * @remarks 読めるのは本人だけである。管理者にも運営にも渡さない（不変則 I-10）。
 */
/**
 * 業務と秘書をつなぐイベント（仕様書 第10.13節、ADR-0039）。
 *
 * @remarks 実行の状態の変更と会話の保存と同じトランザクションの中で、データベースのトリガーが書く。
 */
export interface AgentEvent {
  id: string;
  tenantId: string;
  /** 持ち主（業務を依頼した人・会話した人）。この人の秘書だけが受け取る。 */
  userId: string;
  kind: 'run.finished' | 'run.awaiting_approval' | 'conversation.turn' | 'plan.requested' | 'plan.resumed';
  runId: string | null;
  conversationId: string | null;
  /** 段取り（`plan.*` のとき。第10.14節）。 */
  planId: string | null;
  /** 実行の状態（`run.*` のとき）。 */
  status: string | null;
  createdAt: string;
  attempts: number;
  processedAt: string | null;
  lastError: string | null;
}

/** 秘書の段取り（仕様書 第10.14節、ADR-0040）。 */
export interface Plan {
  id: string;
  tenantId: string;
  /** 依頼した本人。分身はこの人として業務を起こす。 */
  userId: string;
  request: string;
  /** 段取りを立てる材料（今日の会話・本人の返事）。 */
  context: string;
  status: 'planning' | 'running' | 'waiting_input' | 'reported' | 'cancelled';
  /** 本人に聞いていること（`waiting_input` のとき）。 */
  question: string | null;
  reportRunId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** 段取りの段。1 つの業務への依頼。 */
export interface PlanStep {
  id: string;
  tenantId: string;
  planId: string;
  /** 1 から始まる順番。 */
  seq: number;
  agentId: string;
  /** この段で頼むこと。 */
  purpose: string;
  /** 先に終わっている必要がある段（`seq`）。 */
  dependsOn: number[];
  status: 'pending' | 'needs_input' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  runId: string | null;
  attempts: number;
  /** 本人に聞いたか（1 回だけ聞く）。 */
  asked: boolean;
  /** 業務の答え（完了したとき）。 */
  answer: string | null;
  note: string | null;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  userId: string;
  /** 本人の依頼。 */
  message: string;
  /** 秘書の応答。 */
  reply: string;
  /** 応答の層（仕様書 第10.9節）。 */
  layer: 'direct' | 'light' | 'full';
  /** 取り次いだ業務。 */
  agentId: string | null;
  /** そこから始まった実行。評価はこの実行の承認から引く。 */
  runId: string | null;
  createdAt: string;
}

/** その日の会話の要約（仕様書 第11.9.6節）。逐語が消えた後も残る。 */
export interface ConversationDigest {
  tenantId: string;
  userId: string;
  /** 日本時間の `YYYY-MM-DD`。 */
  day: string;
  summary: string;
  compartment: string | null;
  createdAt: string;
}

/**
 * 昇華の提案（仕様書 第11.3.1節）。個人の記憶を組織知識へ引き上げる。
 *
 * @remarks 二重の承認を経る。`proposed`（本人の判断待ち）→ `pending`（組織の承認待ち）→ `approved`。
 */
export interface Promotion {
  id: string;
  tenantId: string;
  /** 記憶の持ち主（提案者）。 */
  userId: string;
  memoryId: string | null;
  /** 昇華する一文。記憶を消しても判断できるよう写しを持つ。 */
  text: string;
  status: 'proposed' | 'pending' | 'approved' | 'rejected' | 'withdrawn';
  /** 承認して登録した組織知識。 */
  knowledgeId: string | null;
  decidedBy: string | null;
  comment: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** 記憶の候補（仕様書 第11.5.2節）。本人が採ると個人記憶になる。 */
export interface MemoryCandidate {
  id: string;
  tenantId: string;
  userId: string;
  text: string;
  /** `pending`: 判断待ち、`dismissed`: 不要（同じ文を再び候補にしないために残す）。 */
  status: 'pending' | 'dismissed';
  /** 元にした日（日本時間の `YYYY-MM-DD`）。 */
  sourceDay: string;
  createdAt: string;
}

/**
 * 個人記憶の 1 件（仕様書 第11.1・11.5.1節）。
 *
 * @remarks 参照できるのは本人だけである。ほかの利用者にも業務エージェントにも渡さない。
 */
export interface Memory {
  id: string;
  tenantId: string;
  userId: string;
  /** 覚えた一文。本人が指示したそのまま。 */
  text: string;
  /** きっかけ（`secretary`: 本人の指示や本人が直したもの、`learned`: 秘書が会話から自分で覚えたもの。第11.5.2節）。 */
  source: string;
  createdAt: string;
  /** しまった日と理由（`merged`・`stale`・`unused`。第11.11.4節）。しまったものの一覧でだけ返す。 */
  archivedAt?: string | null;
  archiveReason?: string | null;
  /** 会話の材料に最後に使った日。 */
  lastUsedAt?: string | null;
}

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
  /**
   * 業務から登録した場合、登録した実行の ID（仕様書 第9.5.2節）。管理者が登録したものは `null`。
   *
   * @remarks 最初に登録したときだけ書く。管理者が本文を直しても変わらない。
   */
  originRunId?: string | null;
  /**
   * Google から読んだデータで作ったか（第9.5.2節・第14.3.2節）。会社の求めに応じて探して消せるようにするための印。
   *
   * @remarks `originRunId` と同じく、最初に登録したときだけ書く。
   */
  googleDerived?: boolean;
  /** 種類（第11.11.1節）。保存のときに省けば、`kind` と由来から決める（`promoted` は秘書が学んだこと、業務から登録したものは議事録、ほかは社内規程）。最初の登録のときだけ書く。 */
  category?: KnowledgeCategory;
  /** 状態と、変えた日・理由（一覧でだけ返す）。 */
  status?: KnowledgeStatus;
  statusAt?: string | null;
  statusReason?: string | null;
  /** 施行している版の施行日（社内規程）。 */
  effectiveFrom?: string | null;
  /** 答えの根拠に最後に使った日。 */
  lastUsedAt?: string | null;
  /** まとめた先（しまったもの）。 */
  mergedInto?: string | null;
  /** 施行日が先の版（社内規程。一覧でだけ返す）。 */
  pending?: { version: number; effectiveFrom: string } | null;
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
/** 本人のアバターの画像（仕様書 第6.5.1.1節）。 */
export interface UserPhoto {
  tenantId: string;
  userId: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  fetchedAt: string;
}

/** 判断した承認 1 件と、その実行の要点（仕様書 第6.2.5節）。 */
export interface DecidedApproval extends Approval {
  runId: string;
  agentId: string;
  agentVersion: number;
  requestedBy: string;
}

/** 監査ログの絞り込み（仕様書 第6.6.8.1節）。 */
export interface AuditQuery {
  /** この時刻以降（含む）。 */
  from?: string;
  /** この時刻より前。 */
  to?: string;
  userId?: string;
  /** 操作の名前の頭。 */
  actions?: string[];
  limit: number;
  offset?: number;
}

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

/** 管理者が個別に止めたコネクタのツール（仕様書 第6.6.3.1節）。 */
/**
 * 会社の接続（コネクタ。仕様書 第12.11節、ADR-0037）。拡張機能の一部ではなく、道具を供給する会社の資源。
 *
 * @remarks `tools` の危険度は管理者が決めたもの（初期値は同梱の宣言の推奨か、MCP の読むだけの目印）
 */
export interface TenantConnection extends ConnectorDeclaration {
  tenantId: string;
  /** 登録の由来。`manual`（管理者が登録）か `extension:<拡張機能の ID>`（同梱）。 */
  origin: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 会社の接続の認証情報（仕様書 第12.11.6節）。**秘密の値は暗号化したまま**持ち、画面にも API にも出さない。
 */
export interface ConnectionSecret {
  tenantId: string;
  connectionId: string;
  /** `oauth`: クライアント ID（秘密ではない）。 */
  clientId: string | null;
  /** `oauth`: クライアント シークレット（暗号化）。 */
  clientSecretEnc: string | null;
  /** `api_key`: 会社の鍵（暗号化）。 */
  apiKeyEnc: string | null;
  updatedBy: string;
  updatedAt: string;
}

/**
 * 利用者ごとの接続の認可（`oauth`。仕様書 第12.11.6.3節）。認可は暗号化したまま持つ。
 */
export interface UserConnection {
  tenantId: string;
  userId: string;
  connectionId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  /** 認可の期限。相手が期限を返さなければ `null`（期限なし）。 */
  expiresAt: string | null;
  /** 許可された権限。 */
  scopes: string[];
  /** 許可したアカウントの表示名（例: 「OESF / 三浦」）。 */
  accountLabel: string;
  /** 認可を受けたときのクライアント ID。会社がクライアント ID を替えたら使えない。 */
  clientId: string;
  connectedAt: string;
  updatedAt: string;
}

export interface DisabledConnectorTool {
  connectorId: string;
  toolName: string;
  disabledBy: string;
  disabledAt: string;
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
