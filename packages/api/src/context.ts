/**
 * @file API プロセスが共有する依存（永続化・LLM・接続口・ファイル・エンジン・秘書）を組み立てる。
 *
 * LLM の提供者と業務システムへの接続口は設定で切り替える。
 * 鍵や OAuth クライアントが無い開発環境では、スタブとダミー接続で動く。
 *
 * @see 仕様書 第20.2節 LLM 抽象化層
 * @see ADR-0003 外部接続の手前に接続口を設ける
 */

import {
  HelpFeedback, PostgresHelpFeedbackStore, PostgresHelpNoteStore, noteText, type HelpNoteStore,
  PostgresRepository, ToolRegistry, BUILTIN_TOOLS, GoogleDataRetention, GoogleRevocation, agentUsesGoogle,
  RunEngine, Secretary, OFFICIAL_AGENTS, buildConnector, LocalFileStore,
  createLoggerFromEnv, HelpCatalog, BufferedHealthSink, PostgresHealthStore, installHealthSink, installPoolLogger, type HealthStore, parseArticle, parseManual, ExtensionHub, HttpMcpClient, loadExtensions,
  TenantAiResolver, platformAi, secretBoxFromEnv, enqueueJob, LOOKUP_AGENT_ID, deploymentFromEnv, localLlmFromEnv,
  defaultGeminiModels, ConnectionCredentials, type ConnectionAuthProvider,
  CardService, PostgresContactStore, cardsAccess, type ContactStore, BulkMailService, PostgresBulkMailStore, NoticeService, PostgresNoticeStore,
  InventoryService, InventoryWatch, InventoryBookings, InventoryPublisher, JanLookupService, PostgresInventoryStore, inventoryAccess, ColumnService, PostgresColumnStore, InquiryService, PostgresInquiryStore, inquiriesAccess, contactBookFrom, CompetitorService, PostgresCompetitorStore, competitorsAccess, crawlerUserAgent, isLocalPolicy, AnnouncementService, PostgresAnnouncementStore, announcementsAccess, ContractService, PostgresContractStore, contractsAccess, CONTRACT_REVIEW_AGENT_ID, ReservationService, PostgresReservationStore, reservationsAccess, SubsidyService, PostgresSubsidyStore, MockResearchProvider, subsidiesAccess, MemberService, PostgresMemberStore, membersAccess, PrintDesignService, PostgresPrintDesignStore, printDesignsAccess, CanvaService, HttpCanvaApi, MockCanvaApi, PostgresCanvaConnectionStore, MEMBER_LINE_SEND, LineApiVerifier, MockLineVerifier, JGrantsApi, MockJGrants, signageForAnnouncements, ANNOUNCEMENT_PUBLISH, announcementMailFrom, WebReviewService, PostgresWebReviewStore, webReviewAccess, WEB_REVIEW_REQUEST, webReviewColumnsFrom, inquiryCountsFrom, competitorLinksFrom, ColumnPlanner, columnMaterialsFrom, HttpPageFetcher, webColumnsAccess, ColumnSignageService, PostgresColumnSignageStore, signageForColumns, WEB_COLUMN_SIGNAGE_PUBLISH, HrService, PostgresHrStore, hrAccess, SignageService, SignageInterrupts, PostgresSignageStore, signageAccess, applyStockChanges, AttendanceService, PostgresAttendanceStore, PayrollService, PostgresPayrollStore, LAW_BOOK, LaborCalendar, YearEndService, PostgresYeaStore, SocialInsuranceService, PostgresSocialStore, LaborInsuranceService, PostgresLaborStore, ShiftService, PostgresShiftStore, HrBooksExport,
  type SecretBox, type GeminiModels,
  type FileStore, type TenantExtensions, type HelpArticle, type ManualMeta, type LlmProvider, type Logger, type Repository, type WorkspaceConnector, aiUsageMeterFromEnv, setEnqueueAiGuard, appPath
} from '@m2office/core';
import { canRunAgent, type AgentDefinition, type ContactScope, type HrSettings, type InventorySettings, type SignageSettings, type WebColumnSettings, type InquirySettings, type CompetitorSettings, type AnnouncementSettings, type WebReviewSettings, type ContractSettings, type ReservationSettings, type SubsidySettings, type MemberSettings, type PrintDesignSettings, fileInputKey } from '@m2office/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, type AuthConfig } from './auth/config.js';
import { OAuthStateStore } from './auth/oauth-state.js';
import { HandoffStore } from './auth/handoff.js';
import { DebugLog, debugEnabled } from './debug/log.js';
import { QUIET_TRACES, traceTitle } from './debug/trace.js';
import { printDriveFor } from './print-drive.js';

/** API プロセス全体で共有する依存。 */
export interface AppDeps {
  repo: Repository;
  llm: LlmProvider;
  connector: WorkspaceConnector;
  files: FileStore;
  registry: ToolRegistry;
  engine: RunEngine;
  secretary: Secretary;
  auth: AuthConfig;
  /** アプリログ（開発規約 第7章）。 */
  log: Logger;
  /** 接続先の健全性の置き場（仕様書 第6.7.6節）。ダッシュボードの「接続先」が読む。 */
  health: HealthStore;
  /** デバッグモードの記録（仕様書 第20.4.1節「デバッグモード」）。`M2O_DEBUG=true` のときだけある。 */
  debug: DebugLog | null;
  /** ヘルプの記事（仕様書 第6.10節）。業務のマニュアルの章を含む。 */
  help: HelpCatalog;
  /** ヘルプで読める業務のマニュアル（名前・木の区分の名前・どの内蔵の拡張のものか。第6.10.7.3節）。 */
  helpManuals: { id: string; title: string; extension: string }[];
  /** ヘルプを育てる（見つからなかった質問と、役に立ったか。仕様書 第6.10.10節） */
  helpFeedback: HelpFeedback;
  /** ヘルプの会社の補足（仕様書 第6.10.7節） */
  helpNotes: HelpNoteStore;
  /** Google から取得したデータの保持（仕様書 第14.3.2節）。連携の解除のときに中身を消す。 */
  retention: GoogleDataRetention;
  /** Google の許可がなくなったとき（取り消し・OAuth クライアントの削除・利用者の停止）の後始末（仕様書 第6.5.2.1節）。 */
  revocation: GoogleRevocation;
  /** 拡張機能（公式の配布元と、会社が取り込んだもの）。会社ごとの見え方は {@link tenantView} で引く。 */
  hub: ExtensionHub;
  /** 会社から見た拡張機能・業務エージェント・ツールの全体（仕様書 第12.10節）。 */
  tenantView(tenantId: string): Promise<TenantExtensions>;
  /**
   * その会社で使える業務エージェント（公式と、導入済み・有効な拡張機能）。
   * 管理者が業務と承認の画面で無効にしたもの（第6.6.5節）は含む。
   *
   * @param userId 指定すると、その人の利用範囲（第16.7節）の中のものだけに絞る。管理者ページの一覧では省く
   */
  agentsFor(tenantId: string, userId?: string): Promise<AgentDefinition[]>;
  /**
   * その人がその業務を使えるか（導入済み・有効、かつ利用範囲の中。第16.7.4節）。
   * 範囲の外の業務は、起動の API で「見つからない」として扱う。
   */
  canUse(tenantId: string, userId: string, agentId: string): Promise<boolean>;
  /** その会社で業務エージェントを使えるか。 */
  isAvailable(tenantId: string, agentId: string): Promise<boolean>;
  /** 秘密の値の暗号化（仕様書 第14.3.3節「保存」）。 */
  box: SecretBox;
  /** 会社ごとの AI（Gemini・ローカル AI と、会社の AI の方針。仕様書 第16.3.7.1節）。 */
  ai: TenantAiResolver;
  /**
   * ローカルの形（仕様書 第8.6節）で入っている 1 社のサブドメイン（`M2O_ONSITE_TENANT`）。クラウドの形では `null`。
   *
   * @remarks ローカルの形では、アドレスにかかわらずこの会社に決める
   */
  onsiteTenant: string | null;
  /**
   * OAuth の戻り先の URI と、使い捨ての state の置き場。
   * `redirectUri` は Google、`connectionRedirectUri` は認証の要る会社の接続（仕様書 第12.11.6.2節）の戻り先
   */
  oauth: { redirectUri: string; connectionRedirectUri: string; states: OAuthStateStore };
  /** 本人の Canva の接続（仕様書 第41.19.3節）。運営が設定していなければ `null`。 */
  canva: CanvaService | null;
  /** 認証の要る会社の接続の認可（仕様書 第12.11.6.4節）。接続の確認とツールの取り直しで使う。 */
  connections: ConnectionCredentials;
  /** ログインの `state`（仕様書 第16.1.2節）。業務の連携のものとは別に持つ。 */
  loginStates: OAuthStateStore;
  /** ログインの引換券（仕様書 第16.1.2節）。運営のホストから会社のホストへ渡す。 */
  handoffs: HandoffStore;
  /**
   * 名刺管理（内蔵の拡張。仕様書 第27章）。
   *
   * @remarks `access` は、会社が名刺管理を使っていて利用者が利用範囲の中なら、取り込んだ名刺の既定の範囲を返す（使えなければ `null`）
   */
  cards: {
    service: CardService; store: ContactStore; access(tenantId: string, userId: string): Promise<{ defaultScope: ContactScope } | null>;
    /** まとめてのメール（第27.9.1節）。 */
    bulk: BulkMailService;
  };
  /** 社内のお知らせ（仕様書 第10.15節）。画面の API・秘書・朝のブリーフが同じものを使う。 */
  notices: NoticeService;
  /**
   * 在庫管理（内蔵の拡張。仕様書 第29章）。
   *
   * @remarks `access` は、会社が在庫管理を使っていて利用者が利用範囲の中なら、会社の在庫管理の設定を返す（使えなければ `null`）
   */
  inventory: {
    service: InventoryService;
    /** 予約との引き当て（第29.13節）。 */
    bookings: InventoryBookings;
    /** Web への公開（第29.12節）。 */
    publisher: InventoryPublisher;
    /** JAN から商品名を引く（第29.6節、Q-111）。 */
    jan: JanLookupService;
    access(tenantId: string, userId: string): Promise<InventorySettings | null>;
  };
  /**
   * 店頭サイネージ（内蔵の拡張。仕様書 第31章）。
   *
   * @remarks `access` は、会社がサイネージを使っていて利用者が利用範囲の中なら、会社のサイネージの設定を返す（使えなければ `null`）
   */
  signage: {
    service: SignageService;
    /** 割り込み・よく出す案内・呼び出しの受け口・会社のジングルの音（段 2。第31.7節・第31.8節）。 */
    interrupts: SignageInterrupts;
    access(tenantId: string, userId: string): Promise<SignageSettings | null>;
  };
  /**
   * Web のコラム（内蔵の拡張。仕様書 第32章）。
   *
   * @remarks `access` は、会社が Web のコラムを使っていて利用者が利用範囲の中なら、会社の設定を返す（使えなければ `null`）
   */
  columns: {
    service: ColumnService;
    access(tenantId: string, userId: string): Promise<WebColumnSettings | null>;
    /** テーマ案・予定表・予約・貼るだけのページ（段 2。第32.18.4節） */
    planner?: ColumnPlanner;
    /** 店頭サイネージ用の画像（第32.18.6節） */
    signage?: ColumnSignageService;
  };
  /**
   * 問い合わせの記録（内蔵の拡張。仕様書 第33章）。
   *
   * @remarks `access` は、会社が問い合わせの記録を使っていて利用者が利用範囲の中なら、会社の設定を返す（使えなければ `null`）
   */
  inquiries: {
    service: InquiryService;
    access(tenantId: string, userId: string): Promise<InquirySettings | null>;
  };
  /**
   * 競合の分析（内蔵の拡張。仕様書 第36章）。探す・読むはワーカーが行い、API は受け付けと画面の読み出しをする。
   *
   * @remarks `access` は、会社が競合の分析を使っていて利用者が利用範囲の中なら、会社の設定を返す（使えなければ `null`）
   */
  competitors: {
    service: CompetitorService;
    access(tenantId: string, userId: string): Promise<CompetitorSettings | null>;
  };
  /**
   * お知らせの作成（内蔵の拡張。仕様書 第35章）。出すのは承認の後だけ（付属の業務「お知らせを出す」）。
   *
   * @remarks `access` は、会社がお知らせの作成を使っていて利用者が利用範囲の中なら、会社の設定を返す（使えなければ `null`）
   */
  announcements: {
    service: AnnouncementService;
    access(tenantId: string, userId: string): Promise<AnnouncementSettings | null>;
  };
  /** 契約の管理（内蔵の拡張。仕様書 第38章）。台帳と期限の見張り。契約書は会社の Google ドライブに置く。 */
  contracts: {
    service: ContractService;
    access(tenantId: string, userId: string): Promise<ContractSettings | null>;
  };
  /** 会議室・社用車・備品の予約（内蔵の拡張。仕様書 第37章）。予約した人の Google カレンダーにも予定を入れる。 */
  reservations: {
    service: ReservationService;
    access(tenantId: string, userId: string): Promise<ReservationSettings | null>;
  };
  /** 補助金・助成金の案内（内蔵の拡張。仕様書 第39章）。月の調べものと締め切りの知らせはワーカーが行う。 */
  subsidies: {
    service: SubsidyService;
    access(tenantId: string, userId: string): Promise<SubsidySettings | null>;
  };
  /** 会員とポイント（内蔵の拡張。仕様書 第40章）。ポイントの失効はワーカーが行う。 */
  members: {
    service: MemberService;
    access(tenantId: string, userId: string): Promise<MemberSettings | null>;
  };
  /** 販促物の作成（内蔵の拡張。仕様書 第41章）。字は M2Office が組み、画像は生成 AI（文字の無い画像）か渡した写真。 */
  printDesigns: {
    service: PrintDesignService;
    access(tenantId: string, userId: string): Promise<PrintDesignSettings | null>;
  };
  /**
   * Webの分析（内蔵の拡張。仕様書 第34章）。担当の許可で読み、月の便りはワーカーが作る。API は画面と設定の読み書きをする。
   *
   * @remarks `access` は、会社が Webの分析を使っていて利用者が利用範囲の中なら、会社の設定を返す（使えなければ `null`）
   */
  webReview: {
    service: WebReviewService;
    access(tenantId: string, userId: string): Promise<WebReviewSettings | null>;
  };
  /** 人事・給与（内蔵の拡張。仕様書 第30章）。使えるのは会社で入れていて人事区画に入っている人だけ。 */
  hr: {
    service: HrService;
    /** 勤怠と有給（段 2。第30.6.1節・第30.7.1節）。 */
    attendance: AttendanceService;
    /** 給与の計算（段 3。第30.10.1節）。 */
    payroll: PayrollService;
    /** 労務カレンダー（第30.19.1節）。 */
    calendar: LaborCalendar;
    /** 年末調整（第30.15.1節）。 */
    yea: YearEndService;
    /** 社会保険の定時決定・随時改定・資格・加入の判定（第30.12.1節）。 */
    social: SocialInsuranceService;
    /** 労働保険の年度更新（第30.13.1節）。 */
    labor: LaborInsuranceService;
    /** シフト（第30.6.2節）。 */
    shifts: ShiftService;
    /** 帳簿をまとめて書き出す（解約のときに渡す。第30.17節・ADR-0054）。 */
    books: HrBooksExport;
    access(tenantId: string, userId: string): Promise<HrSettings | null>;
  };
}

/**
 * 設定から依存を組み立てる。
 *
 * @remarks
 * LLM の提供者と業務システムへの接続口は、設定で切り替える（仕様書 第20.2節、第24.2節）。
 * 鍵や OAuth クライアントが未設定でも全体の流れを確認できるよう、
 * 既定ではスタブとダミー接続を使う。
 */
export function buildDeps(): AppDeps {
  const log = createLoggerFromEnv('api');
  // データベースの接続が切れたときの警告の書き先。置き場を作る前に置く
  installPoolLogger(log.child({ component: 'db' }));
  const repo = new PostgresRepository(
    process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
  );
  // 秘密の値の箱。接続口（google）がリフレッシュ トークンを戻すのにも使う
  const { box, devKey } = secretBoxFromEnv();
  // 接続先の健全性（仕様書 第6.7.6節）。呼び出しの成否と時間を手元に貯め、30 秒ごとに置き場へ流す
  const health = new PostgresHealthStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const healthSink = new BufferedHealthSink(health);
  installHealthSink(healthSink);
  setInterval(() => { void healthSink.flush(); }, 30_000).unref();
  // Google の側で許可が外されたときの後始末（仕様書 第6.5.2.1節 経路 2・3）。後始末の役は下で組み立ててから結び付ける
  let onGrantLost: ((tenantId: string, userId: string, refreshTokenEnc: string) => Promise<unknown>) | null = null;
  const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock', {
    repo, box, mockTenants: (process.env['CONNECTOR_MOCK_TENANTS'] ?? '').split(','),
    production: process.env['NODE_ENV'] === 'production',
    onRevoked: async (p, enc) => { await onGrantLost?.(p.tenantId, p.userId, enc); },
  });
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  // 認証の要る会社の接続の認可（仕様書 第12.11.6.4節）。ツールを呼ぶときに依頼した本人の認可を付ける
  const connections = new ConnectionCredentials({ repo, box });
  const hub = buildHub(repo, registry, log, connections);
  // 別のモデルへ退避したことはアプリのログに残す（仕様書 第20.2.5節）
  const platform = buildAi(hub, log);
  const llm = platform.llm;
  const tenantView = (tenantId: string) => hub.forTenant(tenantId);
  /** その人の利用範囲の判定を作る。会社の設定と、その人の所属するグループを読む。 */
  // 利用範囲（第16.7節）と権限区画（第16.3.6節）の両方を見る
  const scopeOf = async (tenantId: string, userId: string) => {
    const [settings, groups, compartments] = await Promise.all([
      repo.getTenantSettings(tenantId), repo.listUserGroupIds(tenantId, userId), repo.listUserCompartments(tenantId, userId),
    ]);
    return (def: AgentDefinition) => canRunAgent(settings.access, def, userId, groups, compartments);
  };
  const agentsFor = async (tenantId: string, userId?: string) => {
    const { agents } = await tenantView(tenantId);
    if (!userId) return agents;
    const allowed = await scopeOf(tenantId, userId);
    return agents.filter(allowed);
  };
  const canUse = async (tenantId: string, userId: string, agentId: string) => {
    const def = (await tenantView(tenantId)).agents.find((a) => a.id === agentId);
    return !!def && (await scopeOf(tenantId, userId))(def);
  };
  const isAvailable = async (tenantId: string, agentId: string) => (await tenantView(tenantId)).isAvailable(agentId);

  const files = new LocalFileStore(fileStorageDir());
  // Google のデータを扱うツールは、内蔵のツールのうち権限（google）を宣言しているもの（第9.4.4節）
  const retentionRef = new GoogleDataRetention({ repo, isGoogleTool: (name) => !!registry.get(name)?.google, logger: log });
  const research = platform.research;
  if (devKey) log.warn('M2OFFICE_SECRET_KEY が未設定のため、開発用の固定の鍵で秘密の値を暗号化しています（本番では起動しません）');
  // AI の利用の記録と上限（仕様書 第6.6.2節、ADR-0079）
  const aiMeter = aiUsageMeterFromEnv({
    repo, connectionString: process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office', env: process.env,
    onError: (err) => log.warn('AI の利用を記録できませんでした', { err }),
  });
  setEnqueueAiGuard((tenantId, userId) => aiMeter.assert(tenantId, userId));
  const ai = new TenantAiResolver({
    repo, box, fallbackLlm: llm, fallbackResearch: research, meter: aiMeter,
    platformKey: platform.platformKey, testMode: platform.testMode,
    defaults: defaultGeminiModels(),
    baseUrl: platform.baseUrl,
    logger: log,
    // 配備の形とローカル AI（仕様書 第8.6節・第16.3.7.1節、ADR-0059）
    deployment: deploymentFromEnv(process.env), local: localLlmFromEnv(process.env),
  });
  // 名刺管理（内蔵の拡張。仕様書 第27章）。自分だけの名刺は持ち主でも絞るため、置き場は利用者を設定して問い合わせる
  const contactStore = new PostgresContactStore(
    process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
  );
  const cards = {
    store: contactStore,
    service: new CardService({ store: contactStore, repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log }),
    access: cardsAccess(repo),
    bulk: new BulkMailService({
      store: new PostgresBulkMailStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
      // お知らせの作成のメールは窓口のアカウントから送る（第35.6.3節）
      mailbox: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
    }),
  };
  // 社内のお知らせ（仕様書 第10.15節）
  const notices = new NoticeService({
    store: new PostgresNoticeStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    repo,
    // グループ宛てのお知らせを合う Chat のスペースにも投稿する（第10.15.1節、ADR-0080）
    chat: { connector, repo },
  });
  // 在庫管理（内蔵の拡張。仕様書 第29章）。在庫は会社で共有する
  // 数が変わったら見張りが見直す（第29.14節）。見張りは処理を使うため、後から結び付ける
  let inventoryWatch: InventoryWatch | null = null;
  // 在庫が変わったら Web への公開を作り直す（第29.12.1節）。公開は処理を使うため、後から結び付ける
  let inventoryPublisher: InventoryPublisher | null = null;
  const inventoryService = new InventoryService({
    store: new PostgresInventoryStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    repo, llm: (tenantId) => ai.llmFor(tenantId),
    onChanged: async (tenantId, itemIds) => inventoryWatch?.afterMoves(tenantId, itemIds),
    onPublicChange: (tenantId) => inventoryPublisher?.changed(tenantId),
  });
  inventoryPublisher = new InventoryPublisher({ store: inventoryService.store, service: inventoryService, repo, logger: log });
  // 予約との引き当て（第29.13節）
  const inventoryBookings = new InventoryBookings({
    store: inventoryService.store, service: inventoryService, repo, llm: (tenantId) => ai.llmFor(tenantId),
  });
  inventoryWatch = new InventoryWatch({ repo, service: inventoryService, bookings: inventoryBookings, logger: log });
  // JAN から商品名を Gemini の Google 検索で引く（第29.6節）。「ローカルだけ」の会社では調べものが断られ、空のまま作る
  const inventoryJan = new JanLookupService({ research: (tenantId) => ai.researchFor(tenantId), llm: (tenantId) => ai.llmFor(tenantId), logger: log });
  const inventory = { service: inventoryService, bookings: inventoryBookings, publisher: inventoryPublisher, jan: inventoryJan, access: inventoryAccess(repo) };
  // 店頭サイネージ（第31章）。秘書が割り込みを出すため、秘書より先に作る。画面と素材は会社で共有する
  const signageService = new SignageService({ store: new PostgresSignageStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'), repo, files, llmFor: (tenantId) => ai.llmFor(tenantId) });
  const signage = { service: signageService, interrupts: new SignageInterrupts({ service: signageService, repo, llm: (tenantId) => ai.llmFor(tenantId) }), access: signageAccess(repo) };
  // 在庫の公開を作り直したときの品切れ・入荷を、店頭サイネージの案内にする（第31.6.7節。会社が入れたときだけ）
  inventoryPublisher.onStockChange(async (tenantId, changes, current) => { await applyStockChanges(signageService, tenantId, changes, current); });
  // 人事・給与（第30章）。秘書が本人の打刻と有給に答え、朝のブリーフが労務の期限を読むため、業務と秘書より先に作る
  const hrService = new HrService({
    store: new PostgresHrStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    repo, llm: (tenantId) => ai.llmFor(tenantId),
  });
  const shiftStore = new PostgresShiftStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const attendance = new AttendanceService({
    store: new PostgresAttendanceStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    hrStore: hrService.deps.store, repo, shiftStore,
  });
  const payrollStore = new PostgresPayrollStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  // 労務カレンダー（第30.19.1節）
  const laborStore = new PostgresLaborStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const laborCalendar = new LaborCalendar({ hrStore: hrService.deps.store, payrollStore, attendance, repo, law: LAW_BOOK, laborStore });
  // Web のコラム（内蔵の拡張。仕様書 第32章）。コラムは会社で共有する
  // Webの分析への参照（コラムの作成が書き方の傾向を読む。Webの分析はこの後で作る）
  const webReviewRef: { service?: WebReviewService } = {};
  const columns = {
    service: new ColumnService({
      store: new PostgresColumnStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'), files,
      repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId), logger: log,
      // 似すぎの確かめで出典のページを読む口（見本の会社では読まない。第32.18.4節）
      pagesFor: (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? null : new HttpPageFetcher(crawlerUserAgent(appVersion(), process.env['CRAWLER_CONTACT_URL']), 1_000)),
      // 読まれたコラムの書き方の傾向（Webの分析。第32.18.5節）。Webの分析は後で作るので、呼ぶときに引く
      tendencyFor: (tenantId) => webReviewRef.service?.columnTendency(tenantId) ?? Promise.resolve(null),
    }),
    access: webColumnsAccess(repo),
  } as AppDeps['columns'];
  // 問い合わせの記録（内蔵の拡張。仕様書 第33章）。問い合わせは会社で共有し、名刺管理が使えれば連絡先とつなぐ
  // お知らせの置き場（休業の期間を、問い合わせの記録と定時実行も読む。第35.7節）
  const announcementStore = new PostgresAnnouncementStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const inquiries = {
    service: new InquiryService({
      store: new PostgresInquiryStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, llmFor: (tenantId) => ai.llmFor(tenantId), contacts: contactBookFrom(contactStore, cardsAccess(repo)), logger: log,
      // 窓口のアカウント（第33.18節）。見本の会社では見本の箱
      mailbox: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
      // LINE 公式アカウント（第33.19節）。見本の会社では見本の口
      line: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
      // 休業中に届いた問い合わせに「〇日から順にお返事します」の下書きを用意する（第35.7節）
      closureOn: (tenantId, day) => announcementStore.closureOn(tenantId, day),
    }),
    access: inquiriesAccess(repo),
  };
  // 競合の分析（内蔵の拡張。仕様書 第36章）。地図は会社の Gemini の鍵で Places API を呼ぶ。見本の会社では見本の地図とサイト
  const competitors = {
    service: new CompetitorService({
      store: new PostgresCompetitorStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), placesKeyFor: async (tenantId) => (await ai.geminiFor(tenantId)).apiKey,
      sourceFor: (tenantId) => connector.sourceFor(tenantId), externalAllowed: async (tenantId) => !isLocalPolicy(await ai.policyFor(tenantId)),
      userAgent: crawlerUserAgent(appVersion(), process.env['CRAWLER_CONTACT_URL']), logger: log,
      // 問い合わせの「どこで知ったか」（競合の名前が出た件数だけをレポートに添える。第36.20節）
      inquirySources: async (tenantId, since) => ((await repo.getTenantSettings(tenantId)).inquiries.enabled
        ? (await inquiries.service.store.list(tenantId, { status: 'all', since, limit: 500 })).map((i) => i.source) : []),
    }),
    access: competitorsAccess(repo),
  };
  // お知らせの作成（内蔵の拡張。仕様書 第35章）。Web はコラムの作成の WordPress、LINE は問い合わせの記録の接続、サイネージの画面は店頭サイネージを使う
  const announcements = {
    service: new AnnouncementService({
      store: announcementStore,
      repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
      // メール（名刺管理のまとめてのメール。段 2。第35.18節）
      mail: announcementMailFrom({
        bulk: cards.bulk, contacts: contactStore, cardsAccess: cardsAccess(repo), mailbox: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
        inquiries: async (tenantId) => ((await repo.getTenantSettings(tenantId)).inquiries.enabled ? inquiries.service.store : null),
      }),
      line: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
      signage: signageForAnnouncements(signageService),
      // 承認へ進める（付属の業務「お知らせを出す」を始める）
      submitter: async (tenantId, userId, announcementId) => {
        const def = (await tenantView(tenantId)).resolve(ANNOUNCEMENT_PUBLISH.id, ANNOUNCEMENT_PUBLISH.version);
        if (!def) throw new Error('お知らせを出す業務が見つかりません');
        return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input: { announcementId }, origin: 'menu', actor: { type: 'user', id: userId } })).runId;
      },
      runStatus: async (tenantId, runId) => (await repo.getRun(tenantId, runId))?.status ?? null,
    }),
    access: announcementsAccess(repo),
  };
  // 契約の管理（内蔵の拡張。仕様書 第38章）。契約書は置き場をつないだ管理者の Google ドライブ（drive.file）に置く
  const contracts = {
    service: new ContractService({
      store: new PostgresContractStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, files, drive: connector.drive, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
      ocrFor: async (tenantId) => {
        const llm = await ai.llmFor(tenantId).catch(() => null);
        return llm?.readImage ? async (r) => (await llm.readImage!(r)).text : undefined;
      },
      // 契約書チェックの実行の契約書（依頼した本人の実行だけ。第38.5節 ①）
      reviewFile: async (tenantId, userId, runId) => {
        const run = await repo.getRun(tenantId, runId);
        const job = run ? await repo.getJob(tenantId, run.jobId) : null;
        if (!job || job.requestedBy !== userId || job.agentId !== CONTRACT_REVIEW_AGENT_ID) return null;
        const def = (await tenantView(tenantId)).resolve(job.agentId, job.agentVersion);
        const key = def ? fileInputKey(def) : null;
        const v = key ? job.input[key] : null;
        return typeof v === 'string' && v ? v : null;
      },
      latestReview: async (tenantId, userId) => {
        const rows = await repo.listRunsWithJobs(tenantId, { limit: 50, requestedBy: userId });
        return rows.find((r) => r.job.agentId === CONTRACT_REVIEW_AGENT_ID && r.run.status === 'completed')?.run.id ?? null;
      },
      // 更新の前に契約書チェックで見直す（第38.18節）。本人が使える契約書チェックだけを起こす
      reviewStarter: async (tenantId, userId, fileId) => {
        const def = (await agentsFor(tenantId, userId)).find((a) => a.id === CONTRACT_REVIEW_AGENT_ID);
        const key = def ? fileInputKey(def) : null;
        if (!def || !key) return null;
        return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input: { [key]: fileId }, origin: 'menu', actor: { type: 'user', id: userId } })).runId;
      },
    }),
    access: contractsAccess(repo),
  };
  // 会議室・社用車・備品の予約（内蔵の拡張。仕様書 第37章）。予定は予約した人のカレンダーにいまの権限で入れる
  const reservations = {
    service: new ReservationService({
      store: new PostgresReservationStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, calendar: connector.calendar, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
    }),
    access: reservationsAccess(repo),
  };
  // 補助金・助成金の案内（内蔵の拡張。仕様書 第39章）。国は jGrants の公開の API、自治体と助成金は Web の調べもの。見本の会社では外に読みに行かない
  const jgrants = new JGrantsApi();
  const mockJGrants = new MockJGrants();
  const subsidies = {
    service: new SubsidyService({
      store: new PostgresSubsidyStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, logger: log, llmFor: (tenantId) => ai.llmFor(tenantId), 
      // 見本の会社では Web の調べものも使わない（外に読みに行かない）
      researchFor: async (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? new MockResearchProvider() : ai.researchFor(tenantId)),
      sourceFor: (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? mockJGrants : jgrants),
      // 人事・給与を使っていれば、在籍している従業員の数（幅にして使う。名前などは渡さない）
      employeesOf: async (tenantId) => {
        if (!(await repo.getTenantSettings(tenantId)).hr.enabled) return null;
        const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
        return (await hrService.deps.store.listEmployees(tenantId)).filter((e) => e.category !== 'owner' && (!e.leftOn || e.leftOn >= today)).length;
      },
    }),
    access: subsidiesAccess(repo),
  };
  // 会員とポイント（内蔵の拡張。仕様書 第40章）。LINE の会員証は LIFF の ID トークンを LINE で確かめる（見本の会社では見本）
  const lineVerifier = new LineApiVerifier();
  const mockLineVerifier = new MockLineVerifier();
  const members = {
    service: new MemberService({
      store: new PostgresMemberStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, logger: log, lineFor: (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? mockLineVerifier : lineVerifier),
      // 会員への LINE の知らせ（第40.18節）。会社の LINE 公式アカウントで、承認の後に送る
      line: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
      submitter: async (tenantId, userId, messageId) => {
        const def = (await tenantView(tenantId)).resolve(MEMBER_LINE_SEND.id, MEMBER_LINE_SEND.version);
        if (!def) throw new Error('会員に LINE で知らせる業務が見つかりません');
        return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input: { messageId }, origin: 'menu', actor: { type: 'user', id: userId } })).runId;
      },
      runStatus: async (tenantId, runId) => (await repo.getRun(tenantId, runId))?.status ?? null,
      // 店頭サイネージに特典を流す（第40.19節）
      signage: signageService,
    }),
    access: membersAccess(repo),
  };
  // 販促物の作成（内蔵の拡張。仕様書 第41章）。画像はファイルの置き場（print-<版>-…）に置く。
  // 店頭サイネージに流す・お知らせの下書きにする・在庫の品目から値札（第41.18節）
  // Canva（第41.19.3節）。運営が公開のつなぎを登録して入れた鍵か、開発の見本（CANVA_MOCK=true）のときだけ
  const canvaRedirect = process.env['CANVA_OAUTH_REDIRECT_URI']
    ?? new URL('/v1/oauth/canva/callback', process.env['GOOGLE_OAUTH_REDIRECT_URI'] ?? 'http://localhost:3100/v1/oauth/google/callback').toString();
  const canvaApi = process.env['CANVA_MOCK'] === 'true' ? new MockCanvaApi()
    : process.env['CANVA_CLIENT_ID'] && process.env['CANVA_CLIENT_SECRET']
      ? new HttpCanvaApi({ clientId: process.env['CANVA_CLIENT_ID'], clientSecret: process.env['CANVA_CLIENT_SECRET'] }) : null;
  const canva = canvaApi ? new CanvaService({
    api: canvaApi, box, redirectUri: canvaRedirect,
    store: new PostgresCanvaConnectionStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  }) : null;
  const printAnnouncementsAccess = announcementsAccess(repo);
  const printInventoryAccess = inventoryAccess(repo);
  const printDesigns = {
    service: new PrintDesignService({
      store: new PostgresPrintDesignStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
      signage: signageForAnnouncements(signageService),
      announcements: {
        access: async (tenantId, userId) => !!(await printAnnouncementsAccess(tenantId, userId)),
        draft: async (who, request) => {
          const r = await announcements.service.draft(who, request);
          return 'error' in r ? r : { id: r.announcement.id };
        },
      },
      inventory: {
        access: async (tenantId, userId) => !!(await printInventoryAccess(tenantId, userId)),
        items: (tenantId) => inventoryService.store.listItems(tenantId),
      },
      // ドライブの写真（第41.19.2節）
      drive: printDriveFor({ repo, box, connector }),
      ...(canva ? { canva } : {}),
      // 会員の特典のポップ（第41.19.1節）
      members: {
        access: async (tenantId, userId) => !!(await members.access(tenantId, userId)),
        rewards: (tenantId) => members.service.rewards({ tenantId, userId: 'system' }),
      },
    }),
    access: printDesignsAccess(repo),
  };
  // Webの分析（内蔵の拡張。仕様書 第34章）。担当の許可（アナリティクスと Search Console の読み取りだけ）で読む
  const webReview = {
    service: new WebReviewService({
      store: new PostgresWebReviewStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
      repo, data: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) }, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
      // 公開されたコラムの数字を読む（段 2。第34.19節）
      columns: webReviewColumnsFrom({ store: columns.service.store, repo, box }),
      // 問い合わせの件数と競合の動きの数（段 3・第36.21節。件数と数だけ）
      inquiries: inquiryCountsFrom({ store: inquiries.service.store, repo }),
      competitors: competitorLinksFrom({ store: competitors.service.store, repo }),
      closedOn: (tenantId, day) => announcementStore.closedOn(tenantId, day),
      // 依頼文を送る業務を始める（承認の後に送る。第34.21節）
      submitter: async (tenantId, userId, input) => {
        const def = (await tenantView(tenantId)).resolve(WEB_REVIEW_REQUEST.id, WEB_REVIEW_REQUEST.version);
        if (!def) throw new Error('Web の依頼文を送る業務が見つかりません');
        return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input, origin: 'menu', actor: { type: 'user', id: userId } })).runId;
      },
    }),
    access: webReviewAccess(repo),
  };
  webReviewRef.service = webReview.service;
  // コラムのテーマ案・予定表・予約・貼るだけのページ（第32.18.4節）。材料はほかの拡張から（使っていなければ空）
  // 店頭サイネージ用の画像（第32.18.6節）。作るのはワーカー。画面からは作り始め・承認へ・外すを行う
  columns.signage = new ColumnSignageService({
    store: new PostgresColumnSignageStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    columns: columns.service.store, repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
    signage: signageForColumns(signageService),
    submitter: async (tenantId, userId, setId, images) => {
      const def = (await tenantView(tenantId)).resolve(WEB_COLUMN_SIGNAGE_PUBLISH.id, WEB_COLUMN_SIGNAGE_PUBLISH.version);
      if (!def) throw new Error('コラムをサイネージに流す業務が見つかりません');
      const input: Record<string, unknown> = { setId };
      images.forEach((id, i) => { input[`image${i + 1}`] = id; });
      return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input, origin: 'menu', actor: { type: 'user', id: userId } })).runId;
    },
    runStatus: async (tenantId, runId) => (await repo.getRun(tenantId, runId))?.status ?? null,
    // 動画のモデル（段 2。既定は Veo 3.1 Lite）
    ...(process.env['MODEL_VIDEO']?.trim() ? { videoModel: process.env['MODEL_VIDEO'].trim() } : {}),
  });
  columns.planner = new ColumnPlanner({
    service: columns.service, store: columns.service.store, repo, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
    researchFor: (tenantId) => ai.researchFor(tenantId),
    materials: columnMaterialsFrom({ repo, webReview: webReview.service, competitorStore: competitors.service.store, inquiries: inquiries.service }),
  });
  const engine = new RunEngine({
    repo, llm, registry, connector, files, logger: log, research, cards, notices, inventory, columns, inquiries, competitors, announcements, webReview, contracts, subsidies, members, printDesigns, reservations,
    closedOn: (tenantId, day) => announcementStore.closedOn(tenantId, day),
    hr: { calendar: laborCalendar, access: hrAccess(repo) },
    llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId),
    // 業務ごとの AI（ローカル・外部）と、社外の接続に送ってよいか（第16.3.7.1節）
    llmForRun: (tenantId, def, registry, previous) => ai.llmForRun(tenantId, def, registry, previous),
    connectionBlocked: (tenantId, connectionId) => ai.connectionBlocked(tenantId, connectionId),
    resolveDefinition: async (id, version, tenantId) => (await tenantView(tenantId)).resolve(id, version),
    registryFor: async (tenantId) => (await tenantView(tenantId)).registry,
    isAvailable,
    // 止めた実行に後から書き込まれた中身も消す（仕様書 第6.5.2.1節）
    onCancelled: async (run) => { await retentionRef.purgeRun(run, 'disconnect', new Date()); },
  });
  // デバッグモード（仕様書 第20.4.1節「デバッグモード」）。本番で有効にすると起動を断る
  const debug = debugEnabled() ? new DebugLog() : null;
  // 給与（第30.10節）。秘書が本人の明細に答えるため、秘書より先に作る。監修前の表での確定はデバッグモードだけ（ADR-0053）
  // 社会保険（第30.12.1節）。月の給与の点検に随時改定と加入の判定の知らせを足す
  const social = new SocialInsuranceService({
    store: new PostgresSocialStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    payrollStore, hrStore: hrService.deps.store, repo, law: LAW_BOOK,
  });
  const labor = new LaborInsuranceService({ store: laborStore, payrollStore, hrStore: hrService.deps.store, repo, law: LAW_BOOK });
  const yea = new YearEndService({
    store: new PostgresYeaStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    payrollStore, hrStore: hrService.deps.store, repo, law: LAW_BOOK, llm: (tenantId) => ai.llmFor(tenantId), allowUnverified: debug !== null,
  });
  const payroll = new PayrollService({
    store: payrollStore,
    hrStore: hrService.deps.store, attendance, repo, law: LAW_BOOK, llm: (tenantId) => ai.llmFor(tenantId), allowUnverified: debug !== null,
    socialHints: (tenantId) => social.hints(tenantId),
  });
  const manuals = loadManuals(manualDir(), log);
  const help = new HelpCatalog([...loadHelpArticles(helpDir(), log), ...manuals.articles], OFFICIAL_AGENTS, registry);
  const helpFeedback = new HelpFeedback(new PostgresHelpFeedbackStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'));
  const helpNotes = new PostgresHelpNoteStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const secretary = new Secretary({
    aiShareChanged: (tenantId) => aiMeter.forget(tenantId),
    // 勤怠と有給・本人の給与明細（第30.20節）
    attendance, payroll,
    // 人事の担当者の依頼（第30.20.1節）
    hrStaff: { service: hrService, payroll, calendar: laborCalendar, access: hrAccess(repo) },
    // 会議室・社用車・備品の予約（第37.7節）。本人が話した回にだけ、予約する・空きに答える・変える・取り消す
    reservations: { ...reservations, llmFor: (t: string) => ai.llmFor(t) },
    // 店頭サイネージ（第31.11.1節・第31.11.2節）。本人が話した回にだけ、割り込みを出す・消す・流れと時間帯と設定を変える
    signage: {
      ...signage,
      // 秘書に渡された画像（本人のファイルだけ）を、流れに足す素材にする
      file: async (tenantId: string, userId: string, fileId: string) => {
        const f = await repo.getFile(tenantId, fileId);
        if (!f || f.ownerUserId !== userId) return null;
        const bytes = await files.get(tenantId, fileId);
        return bytes ? { name: f.name, bytes } : null;
      },
    },
    // アプリの一覧に入れる公式サイトを、実際に開けるか確かめる（社内のアドレスは開かない。見本の会社では外を読まない。第6.1.1.2節）
    launcherReachable: async (tenantId, url) => {
      if (connector.sourceFor(tenantId) === 'mock') return false;
      const page = await new HttpPageFetcher(crawlerUserAgent(appVersion(), process.env['CRAWLER_CONTACT_URL']), 0).get(url, 'html').catch(() => null);
      return !!page && page.status < 400;
    },
    repo, llm, connector, agents: OFFICIAL_AGENTS, help, agentsFor, llmFor: (t) => ai.llmFor(t), notices,
    // ヘルプに見当たらなかった使い方の質問を残す（名前は残さない。第6.10.10節）
    helpMiss: (tenantId, question) => helpFeedback.miss(tenantId, question),
    // 使い方の答えに、会社の補足を添える（第6.10.7節）
    helpNote: async (tenantId, articleId) => (await helpNotes.get(tenantId, articleId))?.text ?? null,
    // 管理者が秘書に頼んで、会社の補足を書く・消す（秘書の側で管理者かを確かめる。第6.10.7節）
    helpNoteSet: async (tenantId, userId, articleId, text) => {
      await helpNotes.set(tenantId, articleId, noteText(text), userId);
      await repo.appendAudit({
        id: crypto.randomUUID(), tenantId, actorType: 'user', actorId: userId, action: text ? 'help.note.set' : 'help.note.remove',
        targetType: 'help', targetId: articleId, detail: { chars: noteText(text).length, via: 'secretary' }, occurredAt: new Date().toISOString(),
      });
    },
    // デバッグモードでは、振り分けの経過を記録に残す（仕様書 第20.4.1節「デバッグモード」）
    ...(debug ? { onTrace: (tenantId: string, userId: string, action: string, target: string, detail?: Record<string, unknown>) => {
      if (!QUIET_TRACES.has(action)) debug.add(tenantId, userId, 'secretary', traceTitle(action, target, detail), { action, target, ...detail });
    } } : {}),
    // 在庫の問いは推論に選ばせず、その場で答える（仕様書 第29.15節）
    inventory,
    // 渡されたファイルの名前だけを引く。中身は読まない（後ろへ回すため。仕様書 第10.11.3節）
    fileName: async (tenantId, userId, fileId) => {
      const f = await repo.getFile(tenantId, fileId);
      // 本人のファイルでなければ、存在も示さない（第9.4.1節）
      return f && f.ownerUserId === userId ? f.name : null;
    },
    // 本人が同じ業務に前に渡したファイル（「前の版と比べて」。仕様書 第28.13節）。本人の実行だけを見る
    previousFile: async (tenantId, userId, agentId) => {
      const rows = await repo.listRunsWithJobs(tenantId, { limit: 50, requestedBy: userId });
      const view = await tenantView(tenantId);
      for (const r of rows) {
        if (r.job.agentId !== agentId || r.job.requestedBy !== userId) continue;
        const def = view.resolve(r.job.agentId, r.job.agentVersion);
        const key = def ? fileInputKey(def) : null;
        const v = key ? r.job.input[key] : null;
        if (typeof v !== 'string' || !v) continue;
        const f = await repo.getFile(tenantId, v);
        if (f && f.ownerUserId === userId) return v;
      }
      return null;
    },
    // 時間のかかる依頼を、読むだけの業務として後ろへ回す（仕様書 第10.11.4節）
    startLookup: async (tenantId, userId, request, fileIds, context) => {
      // いくつものファイルは、1 つ目を書類の欄に、残りを「ほかに渡された書類」に入れる（仕様書 第10.10.7節）
      const files = Array.isArray(fileIds) ? fileIds : fileIds ? [fileIds] : [];
      const [fileId, ...more] = files;
      const view = await tenantView(tenantId);
      const def = view.resolve(LOOKUP_AGENT_ID, 1);
      if (!def || !view.isAvailable(LOOKUP_AGENT_ID)) return null;
      // 同じ依頼が動いている間は、新しく起こさない（第10.11.4節）
      const same = await repo.findActiveJobByInput(tenantId, userId, LOOKUP_AGENT_ID, 'request', request);
      if (same) return { runId: same, already: true };
      const { runId } = await enqueueJob(repo, {
        tenantId, requestedBy: userId, def,
        input: { request, ...(fileId ? { fileId } : {}), ...(more.length ? { moreFileIds: more.join(',') } : {}), ...(context ? { context } : {}) },
        origin: 'secretary', actor: { type: 'user', id: userId },
      });
      return { runId, already: false };
    },
    // 業務に頼んで実行する（仕様書 第10.9.6節、ADR-0033）。本人として起こし、承認ゲートはそのまま効く
    startAgent: async (tenantId, userId, agent, input) => {
      const view = await tenantView(tenantId);
      const def = view.resolve(agent.id, agent.version);
      if (!def || !view.isAvailable(agent.id)) return null;
      const request = typeof input['request'] === 'string' ? input['request'] : null;
      const same = request ? await repo.findActiveJobByInput(tenantId, userId, agent.id, 'request', request) : null;
      if (same) return { runId: same, already: true };
      const { runId } = await enqueueJob(repo, {
        tenantId, requestedBy: userId, def, input, origin: 'secretary', actor: { type: 'user', id: userId },
      });
      return { runId, already: false };
    },
  });
  // Google のデータを扱うツールは、内蔵のツールのうち権限（google）を宣言しているもの（第9.4.4節）
  const retention = retentionRef;
  // 許可がなくなったときの後始末（仕様書 第6.5.2.1節）
  const revocation = new GoogleRevocation({
    repo, logger: log,
    usesGoogle: async (tenantId, agentId, version) => {
      const view = await tenantView(tenantId);
      const def = view.resolve(agentId, version);
      return !!def && agentUsesGoogle(def, view.registry);
    },
    purgeUser: (tenantId, userId, now) => retention.purgeUser(tenantId, userId, now),
  });
  onGrantLost = (tenantId, userId, enc) => revocation.lostGrant(tenantId, userId, enc, new Date());
  const googleRedirect = process.env['GOOGLE_OAUTH_REDIRECT_URI'] ?? 'http://localhost:3100/v1/oauth/google/callback';
  return {
    repo, llm, connector, files, registry, engine, secretary, auth: loadAuthConfig(), log, health, debug, help, helpManuals: manuals.list, helpFeedback, helpNotes, retention, revocation,
    hub, tenantView, agentsFor, canUse, isAvailable, box, ai, connections,
    onsiteTenant: ai.deployment() === 'onsite' ? (process.env['M2O_ONSITE_TENANT']?.trim() || null) : null,
    oauth: {
      // Google は http の戻り先を localhost にしか認めないため、開発では localhost の画面の転送を通す（ADR-0007）
      redirectUri: googleRedirect,
      // 会社の接続の戻り先。無ければ Google の戻り先と同じホストに置く（Slack は https の戻り先だけを認める）
      connectionRedirectUri: process.env['CONNECTION_OAUTH_REDIRECT_URI']
        ?? new URL('/v1/oauth/connection/callback', googleRedirect).toString(),
      states: new OAuthStateStore(),
    },
    canva,
    loginStates: new OAuthStateStore(),
    handoffs: new HandoffStore(),
    cards,
    notices,
    inventory,
    columns,
    inquiries,
    competitors,
    announcements,
    contracts,
    reservations,
    subsidies,
    members,
    printDesigns,
    webReview,
    // 店頭サイネージ（第31章）
    signage,
    // 人事・給与（第30章）。台帳は人事区画の人だけが扱い、勤怠と有給は本人も扱う
    hr: {
      service: hrService, attendance, access: hrAccess(repo),
      payroll, calendar: laborCalendar,
      social,
      shifts: new ShiftService({ store: shiftStore, hrStore: hrService.deps.store, repo }),
      labor, yea,
      books: new HrBooksExport({ service: hrService, attendance, payroll, yea, social: social.deps.store, labor, repo }),
    },
  };
}

/**
 * 公式の配布元の拡張機能を読み込み、会社ごとの見え方をまとめる部品を作る（仕様書 第12.9.2節、第12.10節）。
 *
 * @remarks
 * 検証を通らない拡張機能は使わず、理由を記録する。起動は止めない。
 * 会社がファイルから取り込んだ拡張機能は、要求のたびにデータベースから読む（再起動は要らない）。
 */
export function buildHub(repo: Repository, registry: ToolRegistry, log: Logger, connectionAuth?: ConnectionAuthProvider): ExtensionHub {
  const dir = process.env['EXTENSIONS_DIR'] ?? appPath('extensions');
  const { packages, errors } = loadExtensions(dir, registry, OFFICIAL_AGENTS.map((a) => a.id));
  for (const e of errors) log.warn('拡張機能を読み込めませんでした', { dir: e.dir, problems: e.problems });
  for (const p of packages) {
    log.info('拡張機能を読み込みました', {
      extensionId: p.manifest.id, version: p.manifest.version, agents: p.agents.map((a) => a.id),
      connectors: p.connectors.map((c) => c.id),
    });
  }
  return new ExtensionHub({
    repo, registry, official: OFFICIAL_AGENTS, packages, mcp: new HttpMcpClient(), logger: log,
    ...(connectionAuth ? { connectionAuth } : {}),
  });
}

/** 公式のヘルプの記事の置き場。既定はリポジトリ直下の `docs/help`。 */
function helpDir(): string {
  return process.env['HELP_DIR'] ?? appPath('docs', 'help');
}

/**
 * 公式のヘルプの記事を読み込む。
 *
 * @remarks
 * 読めない記事があっても起動は止めず、記録して飛ばす。ヘルプの誤りで業務を止めないため。
 * 記事の形式の誤りは `npm test` で検出する。
 */
export function loadHelpArticles(dir: string, log: Logger): HelpArticle[] {
  const articles: HelpArticle[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch (err) {
    log.warn('ヘルプの記事を読み込めませんでした', { dir, err });
    return articles;
  }
  for (const f of files) {
    try {
      articles.push(parseArticle(readFileSync(join(dir, f), 'utf8')));
    } catch (err) {
      log.warn('ヘルプの記事の形式が不正です', { file: f, err });
    }
  }
  log.info('ヘルプの記事を読み込みました', { count: articles.length });
  return articles;
}

function manualDir(): string {
  return process.env['MANUAL_DIR'] ?? appPath('docs', 'manual');
}

/**
 * 業務のマニュアル（`docs/manual/<名前>/`）を読み、章ごとのヘルプの記事にする（仕様書 第6.10.7.3節）。
 *
 * @remarks
 * `manual.json`（名前と内蔵の拡張の ID）の無いフォルダーは読まない。読めないマニュアルがあっても起動は止めず、記録して飛ばす。
 */
export function loadManuals(dir: string, log: Logger): { list: { id: string; title: string; extension: string }[]; articles: HelpArticle[] } {
  const list: { id: string; title: string; extension: string }[] = [];
  const articles: HelpArticle[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    log.warn('業務のマニュアルを読み込めませんでした', { dir, err });
    return { list, articles };
  }
  for (const id of names) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, id, 'manual.json'), 'utf8')) as ManualMeta;
      if (!meta.title || !meta.extension) throw new Error('manual.json に title と extension が要ります');
      const files = readdirSync(join(dir, id)).filter((f) => f.endsWith('.md')).map((name) => ({ name, text: readFileSync(join(dir, id, name), 'utf8') }));
      articles.push(...parseManual(id, meta, files));
      list.push({ id, title: meta.title, extension: meta.extension });
    } catch (err) {
      log.warn('業務のマニュアルを読めませんでした', { manual: id, err });
    }
  }
  log.info('業務のマニュアルを読み込みました', { manuals: list.length, chapters: articles.length });
  return { list, articles };
}

/**
 * ファイルの置き場（開発用のローカルディレクトリ）。
 *
 * @remarks 既定はリポジトリ直下の `.data/files`。本番はオブジェクトストレージに差し替える。
 */
export function fileStorageDir(): string {
  return process.env['FILE_STORAGE_DIR'] ?? appPath('.data', 'files');
}

/**
 * 運営の設定から、会社の鍵が無いときの推論と調べものを決める（仕様書 第20.2節・第20.2.4節）。
 *
 * @remarks
 * 運営の鍵があれば Gemini。`LLM_PROVIDER=stub` は自動テスト専用のスタブ（見本の応答を再生する）。
 * どちらでもなければ「設定されていない」になり、秘書も業務も動かさない（ADR-0030）。ワーカーと同じ判定。
 */
export function buildAi(hub?: ExtensionHub, logger?: Pick<Logger, 'warn'>) {
  return platformAi(process.env, (agentId) => hub?.officialAgents().find((a) => a.id === agentId)?.evals, logger);
}

/**
 * 画面に出す会社名（仕様書 第6.6.1節）。会社情報の正式な会社名、入っていなければ申し込みのときの名前。
 *
 * @remarks 上の帯・ログイン画面・眺める画面で同じ名前を出すため、ここで 1 つに決める
 */
export async function companyName(deps: Pick<AppDeps, 'repo'>, tenant: { id: string; name: string }): Promise<string> {
  return (await companyView(deps, tenant)).name;
}

/**
 * 画面に渡す会社の見え方（仕様書 第6.6.1節）: 会社名・略称・ロゴの URL。
 *
 * @returns 略称が無ければ会社名、ロゴが無ければ `null`
 */
export async function companyView(
  deps: Pick<AppDeps, 'repo'>, tenant: { id: string; name: string },
): Promise<{ name: string; shortName: string; logo: string | null }> {
  const company = (await deps.repo.getTenantSettings(tenant.id).catch(() => null))?.company;
  const name = company?.legalName?.trim() || tenant.name;
  return {
    name,
    shortName: company?.shortName?.trim() || name,
    logo: company?.logoFileId ? `/v1/me/company-logo?v=${encodeURIComponent(company.logoFileId)}` : null,
  };
}

/** サービス本体の版（ルートの package.json。競合の分析が読むときの名乗りに入れる）。 */
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(appPath('package.json'), 'utf8')) as { version?: string }).version ?? '0';
  } catch {
    return '0';
  }
}
