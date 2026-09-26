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
   * 承認の表示（`present`）も消す。`null` なら、消すものが無かったとして記録だけする。
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
  ): Promise<KnowledgeSearchResult>;

  /** 本人宛の通知を保存する。宛先の決定はツール側で行う。 */
  createNotification(n: Notification): Promise<void>;
  /** 本人の通知を新しい順に返す。他人の通知は返さない。 */
  listNotifications(tenantId: string, userId: string, limit: number): Promise<Notification[]>;
  /** 既読にする。本人の通知でなければ `false`。 */
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
  markNotificationRead(tenantId: string, userId: string, id: string): Promise<boolean>;

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

  /** 本人の個人記憶（新しい順。仕様書 第11.5.1節）。本人以外に渡さない。 */
  listMemories(tenantId: string, userId: string): Promise<Memory[]>;
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
  /** 会社の接続を消す。無ければ `false`。 */
  deleteConnection(tenantId: string, id: string): Promise<boolean>;
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

  /** 組織知識の一覧（管理用）。本文を含む。 */
  listKnowledge(tenantId: string): Promise<KnowledgeItem[]>;
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
  kind: 'run.finished' | 'run.awaiting_approval' | 'conversation.turn';
  runId: string | null;
  conversationId: string | null;
  /** 実行の状態（`run.*` のとき）。 */
  status: string | null;
  createdAt: string;
  attempts: number;
  processedAt: string | null;
  lastError: string | null;
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
