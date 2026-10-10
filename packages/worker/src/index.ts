/**
 * @file ジョブ実行ワーカーの起動口。待ち行列の実行を進め、定時実行を見回る常駐プロセス。
 *
 * 承認による中断と再開は数分から数十分にまたがるため、常駐プロセスとして動かす。
 * 承認待ちで中断した実行は状態を永続化してワーカーの担当を離れ、承認後は
 * **別のワーカーが文脈を読み直して**続きを実行する。
 *
 * @see 仕様書 第20.6節 配備上の制約
 * @see 仕様書 第24.3.2節 通すべき一本の流れ（段階 5 と 7）
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  PostgresRepository, ToolRegistry, BUILTIN_TOOLS,
  RunEngine, Scheduler, scheduleChecks, CardService, PostgresContactStore, GoogleContactsService, KnowledgeEmbedder, cardsAccess, SignatureWatcher, BulkMailService, PostgresBulkMailStore, InventoryService, InventoryWatch, InventoryBookings, InventoryPublisher, InventorySales, PostgresSalesStore, ExternalApps, PostgresAppStore, PostgresInventoryStore, inventoryAccess, ColumnService, PostgresColumnStore, webColumnsAccess, InquiryService, PostgresInquiryStore, InquiryWatch, inquiriesAccess, contactBookFrom, CompetitorService, PostgresCompetitorStore, CompetitorWatch, competitorsAccess, crawlerUserAgent, isLocalPolicy, AnnouncementService, PostgresAnnouncementStore, announcementsAccess, ContractService, PostgresContractStore, contractsAccess, CONTRACT_REVIEW_AGENT_ID, ReservationService, PostgresReservationStore, reservationsAccess, SubsidyService, PostgresSubsidyStore, MockResearchProvider, JGrantsApi, MockJGrants, subsidiesAccess, MemberService, PostgresMemberStore, membersAccess, PrintDesignService, PostgresPrintDesignStore, printDesignsAccess, MEMBER_LINE_SEND, signageForAnnouncements, ANNOUNCEMENT_PUBLISH, businessDayChecker, announcementMailFrom, WebReviewService, PostgresWebReviewStore, webReviewAccess, webReviewColumnsFrom, inquiryCountsFrom, competitorLinksFrom, ColumnPlanner, columnMaterialsFrom, HttpPageFetcher, ColumnSignageService, PostgresColumnSignageStore, signageForColumns, SignageService, SignageInterrupts, PostgresSignageStore, applyStockChanges, sweepStockNotices, AttendanceService, PostgresAttendanceStore, PostgresHrStore, PostgresPayrollStore, PostgresLaborStore, PostgresShiftStore, LaborCalendar, hrAccess, LAW_BOOK, NoticeService, PostgresNoticeStore, buildConnector, LocalFileStore, createLoggerFromEnv, ExtensionHub, HttpMcpClient, GoogleDataRetention, GoogleRevocation, agentUsesGoogle, BufferedHealthSink, PostgresHealthStore, installHealthSink, installPoolLogger,
  NotificationDelivery, MockNotificationSender, ConversationRotation, MemoryLearning, SecretaryConductor, PlanRunner, enqueueJob,
  loadExtensions, OFFICIAL_AGENTS, TenantAiResolver, platformAi, secretBoxFromEnv, deploymentFromEnv, localLlmFromEnv,
  defaultGeminiModels, warnHotSwapModels, ProactiveWatcher, ConnectionCredentials, Consolidator, aiUsageMeterFromEnv, enterAiUsage, withAiUsage, setEnqueueAiGuard, AutoMinutes, MINUTES_AGENT_ID, appPath, backupConfigFromEnv, machineDir, readBackupStatus, takeUnnotifiedUpdateFailure, takeClosedMaintenanceSessions, heartbeatConfigFromEnv, sendHeartbeat, HEARTBEAT_INTERVAL_MS, machineStatus, machineConfigFromEnv, restoreTest, runBackup, takeBackupRequest, writeWorkerBeat, OpsAppSide, createPool, offsiteConfigFromEnv, readOffsiteStatus, runOffsite, checkOffsite
} from '@m2office/core';
import { canRunAgent, fileInputKey } from '@m2office/shared';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const log = createLoggerFromEnv('worker');
// データベースの接続が切れたときの警告の書き先。置き場を作る前に置く
installPoolLogger(log.child({ component: 'db' }));

const repo = new PostgresRepository(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
);
const registry = new ToolRegistry();
for (const tool of BUILTIN_TOOLS) registry.register(tool);
// 秘密の値の箱。接続口（google）がリフレッシュ トークンを戻すのにも使う
const { box } = secretBoxFromEnv();
// 接続先の健全性（仕様書 第6.7.6節）。ワーカーで動く業務の推論・Google・会社の接続の成否と時間を、30 秒ごとに置き場へ流す
const healthSink = new BufferedHealthSink(new PostgresHealthStore(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
));
installHealthSink(healthSink);
setInterval(() => { void healthSink.flush(); }, 30_000).unref();
// Google の側で許可が外されたときの後始末（仕様書 第6.5.2.1節 経路 2・3）。後始末の役は下で組み立ててから結び付ける
let onGrantLost: ((tenantId: string, userId: string, refreshTokenEnc: string) => Promise<unknown>) | null = null;
const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock', {
  repo, box, mockTenants: (process.env['CONNECTOR_MOCK_TENANTS'] ?? '').split(','),
  production: process.env['NODE_ENV'] === 'production',
  onRevoked: async (p, enc) => { await onGrantLost?.(p.tenantId, p.userId, enc); },
});

// API と同じ置き場を使う。既定はリポジトリ直下の .data/files
const files = new LocalFileStore(
  process.env['FILE_STORAGE_DIR'] ?? appPath('.data', 'files'),
);
// API と同じく拡張機能を読み込む（仕様書 第12.9.2節）。検証を通らないものは使わない
const extensions = loadExtensions(
  process.env['EXTENSIONS_DIR'] ?? appPath('extensions'),
  registry, OFFICIAL_AGENTS.map((a) => a.id),
);
for (const e of extensions.errors) log.warn('拡張機能を読み込めませんでした', { dir: e.dir, problems: e.problems });
// 会社ごとの見え方（公式の配布元と、会社がファイルから取り込んだもの。仕様書 第12.10節）。
// コネクタのツールは、このワーカーから MCP サーバを呼ぶ（第12.11.3節）
// 認証の要る接続は、依頼した本人の認可（会社の鍵なら会社の鍵）を付けて呼ぶ（第12.11.6.4節）
const hub = new ExtensionHub({
  repo, registry, official: OFFICIAL_AGENTS, packages: extensions.packages, mcp: new HttpMcpClient(), logger: log,
  connectionAuth: new ConnectionCredentials({ repo, box }),
});
const resolveDefinition = async (id: string, version: number, tenantId: string) =>
  (await hub.forTenant(tenantId)).resolve(id, version);
const isAvailable = async (tenantId: string, agentId: string) => (await hub.forTenant(tenantId)).isAvailable(agentId);

// 会社の鍵が無いときの推論と Web の調査（第20.2.4節）。運営の鍵があれば Gemini、無ければ「設定されていない」。
// スタブは自動テスト専用（LLM_PROVIDER=stub）。API と同じ判定
// 別のモデルへ退避したことはアプリのログに残す（仕様書 第20.2.5節）
const platform = platformAi(process.env, (agentId) => hub.officialAgents().find((a) => a.id === agentId)?.evals, log);
const llm = platform.llm;
const research = platform.research;
// 会社ごとの Gemini（会社が自社の鍵を登録していればその鍵。仕様書 第14.3.3節）
// 役割ごとのモデル。既定は安いほうから選ぶ（仕様書 第20.2.2節）。API と同じ
const models = defaultGeminiModels();
warnHotSwapModels(models, log);
// AI の利用の記録と上限（仕様書 第6.6.2節、ADR-0079）。ワーカーの処理は利用者なし・用途「worker」で残す（名前のある処理は内側で決める）
const aiMeter = aiUsageMeterFromEnv({
  repo, connectionString: process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office', env: process.env,
  onError: (err) => log.warn('AI の利用を記録できませんでした', { err }),
});
setEnqueueAiGuard((tenantId, userId) => aiMeter.assert(tenantId, userId));
enterAiUsage({ purpose: 'worker' });
const ai = new TenantAiResolver({
  repo, box, fallbackLlm: llm, fallbackResearch: research, meter: aiMeter,
  platformKey: platform.platformKey, testMode: platform.testMode,
  defaults: models,
  baseUrl: platform.baseUrl,
  logger: log,
  // 配備の形とローカル AI（仕様書 第8.6節・第16.3.7.1節、ADR-0059）
  deployment: deploymentFromEnv(process.env), local: localLlmFromEnv(process.env),
});
// Google から取得したデータの保持（仕様書 第14.3.2節）。Google のツールは、内蔵のツールのうち権限を宣言しているもの
const retention = new GoogleDataRetention({ repo, isGoogleTool: (name) => !!registry.get(name)?.google, logger: log });
// 許可がなくなったときの後始末（仕様書 第6.5.2.1節）。ワーカーで動く業務が取り直しに失敗したときも、API と同じ後始末を行う
const revocation = new GoogleRevocation({
  repo, logger: log,
  usesGoogle: async (tenantId, agentId, version) => {
    const view = await hub.forTenant(tenantId);
    const def = view.resolve(agentId, version);
    return !!def && agentUsesGoogle(def, view.registry);
  },
  purgeUser: (tenantId, userId, now) => retention.purgeUser(tenantId, userId, now),
});
onGrantLost = (tenantId, userId, enc) => revocation.lostGrant(tenantId, userId, enc, new Date());
// 名刺管理（内蔵の拡張。仕様書 第27章）。名刺のツール（第27.9節）と、後ろでの読み取り（第27.4節）が同じ置き場を使う
const contactStore = new PostgresContactStore(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
);
const cards = new CardService({ store: contactStore, repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log });
// まとめてのメール（仕様書 第27.9.1節、ADR-0058）。承認されたものを 1 人に 1 通ずつ送る
const bulkMail = new BulkMailService({
  store: new PostgresBulkMailStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  // お知らせの作成のメールは窓口のアカウントから送る（第35.6.3節）
  mailbox: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
});
// メールの署名から異動・昇進・電話の変更を見つけて名刺に反映する見張り（仕様書 第27.6.1節、ADR-0057）。
// 同じ見回りで、まとめてのメールへの「配信停止」の返信も見つける（第27.9.1節）
const signatures = new SignatureWatcher({
  repo, store: contactStore, connector, llmFor: (tenantId) => ai.llmFor(tenantId), access: cardsAccess(repo), logger: log,
  optOutFromReplies: (who, mails) => bulkMail.optOutFromReplies(who, mails),
});
// 知識の節の埋め込みを後から作る（意味での検索。仕様書 第11.7.6.1節）
const knowledgeEmbedder = new KnowledgeEmbedder({ repo, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log });
// 名刺を本人の Google の連絡先に入れる（仕様書 第27.15節、ADR-0084）。直された名刺を写し、自動で入れる名刺を入れる
const googleContacts = new GoogleContactsService({ store: contactStore, connector, repo, logger: log });
// 社内のお知らせ（仕様書 第10.15節）。朝のブリーフが本人宛てのものを読む
const notices = new NoticeService({
  store: new PostgresNoticeStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo,
});
// 在庫管理（内蔵の拡張。仕様書 第29章）。秘書から頼まれた入出庫の記録（第29.15節）が使う
let inventoryWatch: InventoryWatch | null = null;
// 秘書から頼まれた記録のあとも、Web への公開を作り直す（第29.12.1節）
let inventoryPublisher: InventoryPublisher | null = null;
const inventory = new InventoryService({
  store: new PostgresInventoryStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, llm: (tenantId) => ai.llmFor(tenantId),
  // 秘書から頼まれた記録のあとも、見張りが見直す（第29.14節）
  onChanged: async (tenantId, itemIds) => inventoryWatch?.afterMoves(tenantId, itemIds),
  onPublicChange: (tenantId) => inventoryPublisher?.changed(tenantId),
});
inventoryPublisher = new InventoryPublisher({ store: inventory.store, service: inventory, repo, logger: log });
// 予約との引き当て（第29.13節）。秘書から頼まれた取り置きと、毎朝の見直しが使う
const inventoryBookings = new InventoryBookings({ store: inventory.store, service: inventory, repo, llm: (tenantId) => ai.llmFor(tenantId) });
// 販売管理とのつなぎ（第29.20.1節）。毎朝の見直しで、品目を照らせなかった販売を知らせる
const inventorySales = new InventorySales({
  store: new PostgresSalesStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'), service: inventory, repo,
  apps: new ExternalApps({ store: new PostgresAppStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'), repo }),
});
inventoryWatch = new InventoryWatch({ repo, service: inventory, bookings: inventoryBookings, sales: inventorySales, logger: log });
// 人事・給与の勤怠と有給（第30.7.1節）。毎朝、付与の日が来た分を作り、有給の取得義務を知らせる
const hrStore = new PostgresHrStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
const attendance = new AttendanceService({
  store: new PostgresAttendanceStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  hrStore,
  repo,
  shiftStore: new PostgresShiftStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
});
// 労務カレンダー（第30.19.1節）。毎朝、期限の 14 日前と 3 日前に人事区画の人へ知らせ、朝のブリーフが読む
const laborCalendar = new LaborCalendar({
  hrStore, attendance, repo, law: LAW_BOOK,
  payrollStore: new PostgresPayrollStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  laborStore: new PostgresLaborStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
});
// 店頭サイネージ（第31章）。つながらない画面を知らせ、切れた登録の番号などを消す
const signage = new SignageService({
  store: new PostgresSignageStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'), repo, files,
});
// 在庫の公開を作り直したときの品切れ・入荷を、店頭サイネージの案内にする（第31.6.7節。会社が入れたときだけ）
inventoryPublisher.onStockChange(async (tenantId, changes, current) => { await applyStockChanges(signage, tenantId, changes, current); });
// 割り込みの文を出し終えて 24 時間で消し、行を 90 日で消す（第31.13節）
const signageInterrupts = new SignageInterrupts({ service: signage, repo });
// Web のコラム（内蔵の拡張。仕様書 第32章）。秘書から頼まれた下書きと、承認の後に WordPress に入れるのが使う
const columns: ColumnService = new ColumnService({
  store: new PostgresColumnStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'), files,
  repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId), logger: log,
  // 似すぎの確かめで出典のページを読む口（見本の会社では読まない。第32.18.4節）
  pagesFor: (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? null : new HttpPageFetcher(crawlerUserAgent(appVersion(), process.env['CRAWLER_CONTACT_URL']), 1_000)),
  // 読まれたコラムの書き方の傾向（Webの分析。第32.18.5節）。Webの分析は後で作るので、呼ぶときに引く
  tendencyFor: (tenantId: string): Promise<string | null> => webReview.columnTendency(tenantId),
});
// 問い合わせの記録（内蔵の拡張。仕様書 第33章）。秘書から頼まれた記録と、期限の知らせ・原文の片付けが使う
// お知らせの置き場（休業の期間を、問い合わせの記録と定時実行も読む。第35.7節）
const announcementStore = new PostgresAnnouncementStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
// 契約の管理（第38章）。解約の申し出の期限と終わりを見張り、自動更新の契約を次の期間に進める。秘書から台帳に入れる・引く・直す
const contracts = new ContractService({
  store: new PostgresContractStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, files, drive: connector.drive, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  ocrFor: async (tenantId) => {
    const llm = await ai.llmFor(tenantId).catch(() => null);
    return llm?.readImage ? async (r) => (await llm.readImage!(r)).text : undefined;
  },
  latestReview: async (tenantId, userId) => {
    const rows = await repo.listRunsWithJobs(tenantId, { limit: 50, requestedBy: userId });
    return rows.find((r) => r.job.agentId === CONTRACT_REVIEW_AGENT_ID && r.run.status === 'completed')?.run.id ?? null;
  },
  reviewFile: async (tenantId, userId, runId) => {
    const run = await repo.getRun(tenantId, runId);
    const job = run ? await repo.getJob(tenantId, run.jobId) : null;
    if (!job || job.requestedBy !== userId || job.agentId !== CONTRACT_REVIEW_AGENT_ID) return null;
    const def = await resolveDefinition(job.agentId, job.agentVersion, tenantId);
    const key = def ? fileInputKey(def) : null;
    const v = key ? job.input[key] : null;
    return typeof v === 'string' && v ? v : null;
  },
});
// 予約（第37章）。ワーカーは終わって 1 年を過ぎた予約を消すだけ
const reservations = new ReservationService({
  store: new PostgresReservationStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, calendar: connector.calendar, logger: log,
});
// 補助金・助成金の案内（第39章）。月の調べもの（毎月 1 日の 8 時を過ぎたら）と、「気になる」にした制度の締め切りの知らせ
const jgrants = new JGrantsApi();
const mockJGrants = new MockJGrants();
const subsidies = new SubsidyService({
  store: new PostgresSubsidyStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, logger: log, llmFor: (tenantId) => ai.llmFor(tenantId), 
  // 見本の会社では Web の調べものも使わない（外に読みに行かない）
  researchFor: async (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? new MockResearchProvider() : ai.researchFor(tenantId)),
  sourceFor: (tenantId) => (connector.sourceFor(tenantId) === 'mock' ? mockJGrants : jgrants),
  employeesOf: async (tenantId) => {
    if (!(await repo.getTenantSettings(tenantId)).hr.enabled) return null;
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    return (await hrStore.listEmployees(tenantId)).filter((e) => e.category !== 'owner' && (!e.leftOn || e.leftOn >= today)).length;
  },
});
// 販促物の作成（第41章）。ワーカーは掲示の期間の見張り（サイネージに流す・外すを含む）と、秘書の業務からの頼みを扱う
const printDesigns = new PrintDesignService({
  store: new PostgresPrintDesignStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  signage: signageForAnnouncements(signage),
  // お知らせの作成は後で作るので、呼ばれたときに引く（第41.18節）
  announcements: {
    access: async (tenantId, userId) => !!(await announcementsAccess(repo)(tenantId, userId)),
    draft: async (who, request) => {
      const r = await announcements.draft(who, request);
      return 'error' in r ? r : { id: r.announcement.id };
    },
  },
  inventory: {
    access: async (tenantId, userId) => !!(await inventoryAccess(repo)(tenantId, userId)),
    items: (tenantId) => inventory.store.listItems(tenantId),
  },
  // 会員の特典のポップ（第41.19.1節。会員とポイントは後で作るので、呼ばれたときに引く）
  members: {
    access: async (tenantId, userId) => !!(await membersAccess(repo)(tenantId, userId)),
    rewards: (tenantId) => members.rewards({ tenantId, userId: 'system' }),
  },
});
// 会員とポイント（第40章）。ワーカーは有効期限の失効（1 日に 1 回）と、秘書の業務からの頼みを扱う
const members = new MemberService({
  store: new PostgresMemberStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, logger: log,
  // 失効の前の知らせを用意して承認へ進め、承認の後に LINE で送る（第40.18節）
  line: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
  submitter: async (tenantId, userId, messageId) => {
    const def = await resolveDefinition(MEMBER_LINE_SEND.id, MEMBER_LINE_SEND.version, tenantId);
    if (!def) throw new Error('会員に LINE で知らせる業務が見つかりません');
    return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input: { messageId }, origin: 'menu', actor: { type: 'system', id: 'member-watch' } })).runId;
  },
  runStatus: async (tenantId, runId) => (await repo.getRun(tenantId, runId))?.status ?? null,
  // 特典の期間が変わったら、店頭サイネージの 1 枚を作り直す（第40.19節）
  signage,
});
const inquiryStore = new PostgresInquiryStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
const inquiries = new InquiryService({
  store: inquiryStore, repo, llmFor: (tenantId) => ai.llmFor(tenantId), contacts: contactBookFrom(contactStore, cardsAccess(repo)), logger: log,
  // 窓口のアカウント（第33.18節）。見本の会社では見本の箱
  mailbox: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
  // LINE 公式アカウント（第33.19節）。承認の後に返事を送るのに使う
  line: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
  // 休業中に届いた問い合わせに「〇日から順にお返事します」の下書きを用意する（第35.7節）
  closureOn: (tenantId, day) => announcementStore.closureOn(tenantId, day),
});
const inquiryWatch = new InquiryWatch({ store: inquiryStore, repo, logger: log });
// 競合の分析（内蔵の拡張。仕様書 第36章）。受け付けた探す・読む作業を 1 つずつ行う（相手のサイトは間を空けて 1 本ずつ読む）
const competitorStore = new PostgresCompetitorStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
const competitors = new CompetitorService({
  store: competitorStore, repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), placesKeyFor: async (tenantId) => (await ai.geminiFor(tenantId)).apiKey,
  sourceFor: (tenantId) => connector.sourceFor(tenantId), externalAllowed: async (tenantId) => !isLocalPolicy(await ai.policyFor(tenantId)),
  userAgent: crawlerUserAgent(appVersion(), process.env['CRAWLER_CONTACT_URL']), logger: log,
  // 問い合わせの「どこで知ったか」（競合の名前が出た件数だけをレポートに添える。第36.20節）
  inquirySources: async (tenantId, since) => ((await repo.getTenantSettings(tenantId)).inquiries.enabled
    ? (await inquiryStore.list(tenantId, { status: 'all', since, limit: 500 })).map((i) => i.source) : []),
});
const competitorWatch = new CompetitorWatch({ service: competitors, store: competitorStore, repo, logger: log });
// Webの分析（内蔵の拡張。仕様書 第34章）。毎月 3 日の 8 時（日本時間）を過ぎたら、先月の便りを 1 回だけ作る
const webReview: WebReviewService = new WebReviewService({
  store: new PostgresWebReviewStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, data: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) }, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  // 公開されたコラムの数字を読む（段 2。第34.19節）
  columns: webReviewColumnsFrom({ store: columns.store, repo, box }),
  // 問い合わせの件数と競合の動きの数（段 3・第36.21節。件数と数だけ）
  inquiries: inquiryCountsFrom({ store: inquiryStore, repo }),
  competitors: competitorLinksFrom({ store: competitorStore, repo }),
  closedOn: (tenantId, day) => announcementStore.closedOn(tenantId, day),
});
// お知らせの作成（内蔵の拡張。仕様書 第35章）。承認の後に出し、予約の時刻と期間の後を見回る
const announcements = new AnnouncementService({
  store: announcementStore,
  repo, box, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  line: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
  signage: signageForAnnouncements(signage),
  // メール（名刺管理のまとめてのメール。段 2。第35.18節）
  mail: announcementMailFrom({
    bulk: bulkMail, contacts: contactStore, cardsAccess: cardsAccess(repo), mailbox: { repo, box, sourceFor: (tenantId) => connector.sourceFor(tenantId) },
    inquiries: async (tenantId) => ((await repo.getTenantSettings(tenantId)).inquiries.enabled ? inquiryStore : null),
  }),
  submitter: async (tenantId, userId, announcementId) => {
    const def = await resolveDefinition(ANNOUNCEMENT_PUBLISH.id, ANNOUNCEMENT_PUBLISH.version, tenantId);
    if (!def) throw new Error('お知らせを出す業務が見つかりません');
    return (await enqueueJob(repo, { tenantId, requestedBy: userId, def, input: { announcementId }, origin: 'menu', actor: { type: 'user', id: userId } })).runId;
  },
  runStatus: async (tenantId, runId) => (await repo.getRun(tenantId, runId))?.status ?? null,
});
// コラムのテーマ案・予定表と先回り・予約から入れる（第32.18.4節）。材料はほかの拡張から（使っていなければ空）
const columnPlanner = new ColumnPlanner({
  service: columns, store: columns.store, repo, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  // テーマ案のニュースと制度の変更（第32.18.7節）
  researchFor: (tenantId) => ai.researchFor(tenantId),
  materials: columnMaterialsFrom({ repo, webReview, competitorStore, inquiries }),
});
// 店頭サイネージ用の画像を後ろで作り、期間の過ぎた組を外す（第32.18.6節）
const columnSignage = new ColumnSignageService({
  store: new PostgresColumnSignageStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  columns: columns.store, repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log,
  signage: signageForColumns(signage),
  runStatus: async (tenantId, runId) => (await repo.getRun(tenantId, runId))?.status ?? null,
  // 動画のモデル（段 2。既定は Veo 3.1 Lite）
  ...(process.env['MODEL_VIDEO']?.trim() ? { videoModel: process.env['MODEL_VIDEO'].trim() } : {}),
});
const engine = new RunEngine({
  repo, llm, registry, connector, files, resolveDefinition, isAvailable, logger: log, research, notices,
  // お知らせで出した休業の期間（予定の候補で休業日を避ける。第35.7節）
  closedOn: (tenantId, day) => announcementStore.closedOn(tenantId, day),
  cards: { store: contactStore, service: cards, access: cardsAccess(repo), bulk: bulkMail, google: googleContacts },
  inventory: { service: inventory, bookings: inventoryBookings, access: inventoryAccess(repo) },
  hr: { calendar: laborCalendar, access: hrAccess(repo) },
  columns: { service: columns, access: webColumnsAccess(repo), planner: columnPlanner, signage: columnSignage },
  inquiries: { service: inquiries, access: inquiriesAccess(repo) },
  competitors: { service: competitors, access: competitorsAccess(repo) },
  announcements: { service: announcements, access: announcementsAccess(repo) },
  webReview: { service: webReview, access: webReviewAccess(repo) },
  contracts: { service: contracts, access: contractsAccess(repo) },
  subsidies: { service: subsidies, access: subsidiesAccess(repo) },
  members: { service: members, access: membersAccess(repo) },
  printDesigns: { service: printDesigns, access: printDesignsAccess(repo) },
  // 日程調整で会議と一緒に会議室を取る（第37.18節）
  reservations: { service: reservations, access: reservationsAccess(repo) },
  llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId),
  // 業務ごとの AI（ローカル・外部）と、社外の接続に送ってよいか（第16.3.7.1節）
  llmForRun: (tenantId, def, registry, previous) => ai.llmForRun(tenantId, def, registry, previous),
  // まだ始まっていない実行は、AI の利用の上限に当たっていれば始めない（第6.6.2節）
  aiGuard: async (tenantId, userId) => (await aiMeter.check(tenantId, userId)).blocked?.message ?? null,
  connectionBlocked: (tenantId, connectionId) => ai.connectionBlocked(tenantId, connectionId),
  registryFor: async (tenantId) => (await hub.forTenant(tenantId)).registry,
  // 止めた実行に後から書き込まれた中身も消す（仕様書 第6.5.2.1節）
  onCancelled: async (run) => { await retention.purgeRun(run, 'disconnect', new Date()); },
});
// 動かない理由の判定は、管理者の「定時実行の一覧」と同じもの（仕様書 第6.6.8.2節）。
// 本物の Google の接続口の会社で接続の無い人・止めたツール・未接続のサービス（Slack など）の定時実行は飛ばす
// 「会社の営業日」の定時実行（朝のブリーフの既定）は、営業しない曜日・祝日・お知らせで出した休業の期間には動かさない（第 0.243.0 版）
const scheduler = new Scheduler({
  ...scheduleChecks({ repo, hub, connector }), logger: log,
  businessDay: businessDayChecker({ repo, closedOn: (tenantId, day) => announcementStore.closedOn(tenantId, day) }),
});

// 秘書の先回り（会議の直前の準備・前日の移動の知らせ。仕様書 第10.12節）。本人が使える業務だけを使う（利用範囲。第16.7節）
const proactive = new ProactiveWatcher({
  repo, connector, logger: log,
  agentsFor: async (tenantId, userId) => {
    const view = await hub.forTenant(tenantId);
    const [settings, groups, compartments] = await Promise.all([
      repo.getTenantSettings(tenantId), repo.listUserGroupIds(tenantId, userId), repo.listUserCompartments(tenantId, userId),
    ]);
    return view.agents.filter((def) => canRunAgent(settings.access, def, userId, groups, compartments));
  },
});

// 通知の控えを Chat へ届ける（仕様書 第6.5.5.2節）。送信口は B-2 のあとに差し替える
/**
 * 会社の画面のアドレス。通知の控えに載せるリンクに使う（仕様書 第6.5.5.2節）。
 *
 * @remarks `APP_BASE_URL` の `{tenant}` をサブドメインに置き換える。開発では `http://{tenant}.lvh.me:3100`
 */
const appUrl = (subdomain: string): string =>
  (process.env['APP_BASE_URL'] ?? `http://{tenant}.${process.env['BASE_DOMAIN'] ?? 'lvh.me'}:${process.env['WEB_PORT'] ?? 3100}`)
    .replace('{tenant}', subdomain);

const notifier = new NotificationDelivery({
  repo, sender: new MockNotificationSender(log), logger: log,
  linkFor: (tenant) => appUrl(tenant.subdomain),
});

// 会話ログ（逐語）の入れ替え。4 週を過ぎたものを消す（仕様書 第11.9.6節）
// ファイルの実体も消す（仕様書 第10.10.5節）
const conversations = new ConversationRotation({ repo, files, logger: log });
// 対話からの学習。前日の会話から、その日の要約と記憶の候補を作る（仕様書 第11.5.2節）
const learning = new MemoryLearning({ repo, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log });
// 秘書の受け手（指揮者）。業務と秘書のイベントを受け、その場で学ぶ（仕様書 第10.13節、ADR-0039）
// 秘書の分身（段取り役）。段取りを立て、本人として業務を起こし、返事を集めて報告する（仕様書 第10.14節、ADR-0040）
const planAgentsFor = async (tenantId: string, userId: string) => {
  const view = await hub.forTenant(tenantId);
  const [settings, groups, compartments] = await Promise.all([
    repo.getTenantSettings(tenantId), repo.listUserGroupIds(tenantId, userId), repo.listUserCompartments(tenantId, userId),
  ]);
  // 本人が使える業務だけ（利用範囲・無効にした業務・権限区画。不変則 I-9）
  return view.agents.filter((def) => !settings.agents.disabled.includes(def.id) && canRunAgent(settings.access, def, userId, groups, compartments));
};
// 会議が終わったら、主催した人の議事録を作り始める（仕様書 第9.5.2.1節、ADR-0081）。本人が使える議事録の業務があるときだけ
const autoMinutes = new AutoMinutes({
  repo, connector,
  agentFor: async (tenantId, userId) => (await planAgentsFor(tenantId, userId)).find((d) => d.id === MINUTES_AGENT_ID) ?? null,
});
const plans = new PlanRunner({
  repo, logger: log, llmFor: (tenantId) => ai.llmFor(tenantId), agentsFor: planAgentsFor,
  enqueue: async (tenantId, userId, def, input, planStepId) => {
    const view = await hub.forTenant(tenantId);
    if (!view.isAvailable(def.id)) return null;
    const { runId } = await enqueueJob(repo, {
      tenantId, requestedBy: userId, def, input, origin: 'secretary',
      actor: { type: 'system', id: 'secretary-plan' }, ...(planStepId ? { planStepId } : {}),
    });
    return runId;
  },
});
const conductor = new SecretaryConductor({
  repo, learning, plans, logger: log,
  // 業務の名前と権限区画を引く（本人が直接使った業務からも学ぶ。ADR-0038）
  agentsFor: async (tenantId) => (await hub.forTenant(tenantId)).allAgents,
});
/** 処理済みのイベントを残す日数。 */
const AGENT_EVENT_KEEP_DAYS = 7;

/** メールの署名を見る見回りの間隔（第27.6.1節。1 時間ごと）。 */
const SIGNATURE_INTERVAL_MS = Number(process.env['SIGNATURE_INTERVAL_MS'] ?? 3_600_000);
let lastSignatureCheck = 0;
// 直された名刺を Google の連絡先に写す見回りの間隔（第27.15節）。既定は 10 分
const GOOGLE_CONTACTS_INTERVAL_MS = Number(process.env['GOOGLE_CONTACTS_INTERVAL_MS'] ?? 600_000);
let lastGoogleContactsSync = 0;
// 知識の節の埋め込みを作る見回りの間隔（第11.7.6.1節）。既定は 30 秒（1 回に 32 節まで）
const KNOWLEDGE_EMBED_INTERVAL_MS = Number(process.env['KNOWLEDGE_EMBED_INTERVAL_MS'] ?? 30_000);
let lastKnowledgeEmbed = 0;
/** 期限を過ぎた名刺（ごみ箱に 30 日・読み取れなかったもの 4 週）を消す見回りの間隔。 */
const CARD_PURGE_INTERVAL_MS = Number(process.env['CARD_PURGE_INTERVAL_MS'] ?? 3_600_000);
let lastCardPurge = 0;
/** 在庫の毎朝の見直しを始める時刻（日本時間の時。仕様書 第29.14節）。朝のブリーフ（7:30）より前に知らせる。 */
const INVENTORY_WATCH_HOUR = Number(process.env['INVENTORY_WATCH_HOUR'] ?? 7);
/** 在庫の毎朝の見直しを済ませた日（日本時間）。1 日 1 回にする。 */
let inventoryWatchedOn = '';
/** Web への公開を作り直した日本時間の日付（日付が変わったら、使用期限を過ぎた数を外すために作り直す。第29.12.1節）。 */
let publicationRefreshedOn = '';
/** 有給の毎朝の見回りをした日（在庫と同じ時刻を過ぎたら 1 日 1 回）。 */
let leaveWatchedOn = '';

const POLL_INTERVAL_MS = 1000;
/** 定時実行の見回り間隔。分単位の指定に対して十分に短くする。 */
const SCHEDULE_INTERVAL_MS = Number(process.env['SCHEDULE_INTERVAL_MS'] ?? 15_000);
/** 通知の控えの見回り間隔。通知しない時間帯が明けたときの遅れを、この間隔に収める。 */
const NOTIFY_INTERVAL_MS = Number(process.env['NOTIFY_INTERVAL_MS'] ?? 10_000);
/** 秘書の先回りの見回り間隔（仕様書 第10.12節）。会議の準備を起こす窓（40 分）より短くする。 */
const PROACTIVE_INTERVAL_MS = Number(process.env['PROACTIVE_INTERVAL_MS'] ?? 600_000);
/** 会話ログの入れ替えの間隔。1 日 1 回で足りる（開発では確かめやすいよう短くできる）。 */
const CONVERSATION_INTERVAL_MS = Number(process.env['CONVERSATION_INTERVAL_MS'] ?? 24 * 3_600_000);
/** 保持期間の見回り間隔。本番は 10 分、開発は確かめやすいよう 15 秒。 */
const RETENTION_INTERVAL_MS = Number(
  process.env['RETENTION_INTERVAL_MS'] ?? (process.env['NODE_ENV'] === 'production' ? 600_000 : 15_000),
);
let running = true;
let lastScheduleCheck = 0;
let lastRetentionCheck = 0;
let lastNotifyCheck = 0;
let lastConversationCheck = 0;
let lastProactiveCheck = 0;
/** 店頭サイネージの見回りの間隔（つながらない画面の知らせ。第31.5.1節）。 */
const SIGNAGE_INTERVAL_MS = Number(process.env['SIGNAGE_INTERVAL_MS'] ?? 60_000);
let lastSignageCheck = 0;
/** 問い合わせの見張りの間隔（期限の知らせ・手つかずの知らせ・原文の片付け。第33.7節）。 */
const INQUIRY_INTERVAL_MS = Number(process.env['INQUIRY_INTERVAL_MS'] ?? 900_000);
let lastInquiryCheck = 0;
/** 問い合わせの窓口のアカウントのメールを読む間隔（第33.18節）。 */
const INQUIRY_MAIL_INTERVAL_MS = Number(process.env['INQUIRY_MAIL_INTERVAL_MS'] ?? 300_000);
let lastInquiryMailCheck = 0;
/** 競合の分析の作業を見る間隔（第36.18節）。 */
const COMPETITOR_INTERVAL_MS = Number(process.env['COMPETITOR_INTERVAL_MS'] ?? 10_000);
let lastCompetitorCheck = 0;
/** お知らせの予約と期間の後を見回る間隔（第35.17節）。 */
const ANNOUNCEMENT_INTERVAL_MS = Number(process.env['ANNOUNCEMENT_INTERVAL_MS'] ?? 60_000);
let lastAnnouncementCheck = 0;
/** 契約の期限を見張る間隔（第38.6節。既定は 1 時間。知らせは期限ごとに 1 回だけ）。 */
const CONTRACT_INTERVAL_MS = Number(process.env['CONTRACT_INTERVAL_MS'] ?? 3_600_000);
let lastContractCheck = 0;
/** 終わって 1 年を過ぎた予約を消す間隔（第37.11節。1 日に 1 回で足りる）。 */
const RESERVATION_PURGE_INTERVAL_MS = 86_400_000;
let lastReservationPurge = 0;
/** 補助金・助成金の月の調べものと締め切りの知らせを見る間隔（第39.7節。既定は 1 時間）。 */
const SUBSIDY_INTERVAL_MS = Number(process.env['SUBSIDY_INTERVAL_MS'] ?? 3_600_000);
let lastSubsidyCheck = 0;
/** 会員のポイントの失効と週の見立てを見る間隔（第40.6節・第40.18節。見立ては月曜の 8 時を過ぎたら週に 1 回）。 */
const MEMBER_EXPIRY_INTERVAL_MS = 3_600_000;
let lastMemberExpiry = 0;
let lastPrintCheck = 0;
// Webの分析（第34.18節・第34.19節）。既定は 1 分ごとに、月の便り（3 日の 8 時を過ぎ、先月の便りがまだ無いか）と、
// 直すべき所の見回りの番（週に 1 回・今すぐチェック）を見る
const WEB_REVIEW_INTERVAL_MS = Number(process.env['WEB_REVIEW_INTERVAL_MS'] ?? 60_000);
let lastWebReviewCheck = 0;
// コラムの作成（第32.18.4節）。既定は 1 分ごとに、予約の日時・飛ばす回・週に 1 回のテーマ案・7 日前の先回りを見る
const COLUMN_PLAN_INTERVAL_MS = Number(process.env['COLUMN_PLAN_INTERVAL_MS'] ?? 60_000);
let lastColumnPlanCheck = 0;
/** コラムの店頭サイネージ用の画像を見る間隔（ミリ秒。頼まれたものを早く作るため短くする）。 */
const COLUMN_SIGNAGE_INTERVAL_MS = Number(process.env['COLUMN_SIGNAGE_INTERVAL_MS'] ?? 10_000);
let lastColumnSignageCheck = 0;
// 秘書が学んだことの週 1 回の整理と、残す期間の片付け（仕様書 第11.11.4節）。1 時間ごとに「日曜の深夜で、前の整理から 6 日より経ったか」を見る
const CONSOLIDATE_INTERVAL_MS = Number(process.env['CONSOLIDATE_INTERVAL_MS'] ?? 3_600_000);
let lastConsolidateCheck = 0;
const consolidator = new Consolidator({ repo, llm: (tenantId) => ai.llmFor(tenantId) });

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

log.info('待ち行列の監視を開始しました', {
  connector: process.env['CONNECTOR_MODE'] ?? 'mock', mockTenants: process.env['CONNECTOR_MOCK_TENANTS'] || undefined,
  scheduleIntervalMs: SCHEDULE_INTERVAL_MS,
});

/** AI の利用の見張りの間隔（1 時間。知らせは 1 日 1 回だけ）。 */
const AI_USAGE_INTERVAL_MS = 3_600_000;
/** AI の利用の記録を残す日数（13 か月）。 */
const AI_USAGE_KEEP_DAYS = 400;
let lastAiUsageCheck = 0;
/** お知らせの締切の前の知らせを見る間隔（15 分）。 */
const NOTICE_REMIND_INTERVAL_MS = 15 * 60_000;
let lastNoticeRemind = 0;
/** 控えの設定（ローカルの形で M2O_BACKUP_DIR があるときだけ。第8.6.5節）。 */
const onsite = deploymentFromEnv(process.env) === 'onsite';
const backupCfg = onsite ? backupConfigFromEnv(process.env) : null;
// 社外の控え（会社が選んだときだけ。restic で暗号化して S3 互換の置き場へ。第8.6.5節）。送るのに時間がかかるため、見回りを止めずに裏で行う
const offsiteCfg = backupCfg ? offsiteConfigFromEnv(process.env, machineDir(process.env)) : null;
let offsiteRunning = false;

/** 社内の控えの 1 回分を社外へ送り、月が変わって初めての回の後に置き場が壊れていないかを確かめる（裏で行う）。 */
function startOffsite(backupDir: string, name: string): void {
  if (!offsiteCfg || offsiteRunning) return;
  offsiteRunning = true;
  void (async () => {
    try {
      const before = await readOffsiteStatus(backupDir);
      const rec = await runOffsite(backupDir, name, offsiteCfg);
      log.info(rec.ok ? '社外の控えを送りました' : '社外の控えを送れませんでした', { name, snapshot: rec.snapshot, bytesAdded: rec.bytesAdded, error: rec.error });
      if (!rec.ok) await notifyMachine('社外の控えを送れませんでした', `${rec.error ?? ''}。管理者ページの「機械」で確かめてください。`);
      const month = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 7);
      if (rec.ok && (!before.check || month(before.check.at) !== month(rec.at))) {
        const c = await checkOffsite(backupDir, offsiteCfg);
        log.info(c.ok ? '社外の控えが壊れていないことを確かめました' : '社外の控えの確かめに失敗しました', { error: c.error });
        if (!c.ok) await notifyMachine('社外の控えの確かめに失敗しました', `${c.error ?? ''}。管理者ページの「機械」で確かめ、導入した技術者に伝えてください。`);
      }
    } catch (err) {
      log.warn('社外の控えで例外が発生しました', { err });
    } finally {
      offsiteRunning = false;
    }
  })();
}
let lastUpdateCheck = 0;
// 運営への稼働の知らせ（第8.6.8節）。受け口と鍵を入れた機械だけ
const heartbeatCfg = onsite ? heartbeatConfigFromEnv(process.env) : null;
let lastHeartbeat = 0;
let lastBackupCheck = 0;
// マスター管理画面のための、ワーカーの知らせと毎晩の数の記録（クラウドの形だけ。仕様書 第23.8.15節）
const opsSide = onsite ? null : new OpsAppSide(createPool(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office', { max: 1, name: 'ops' }));
const workerBeatId = `${hostname()}-${process.pid}`;
let lastOpsBeat = 0;
let lastDailyRecorded = '';

/** 機械の知らせを、会社の管理者に届ける（ローカルの形は 1 社。第8.6.7節）。 */
async function notifyMachine(title: string, body: string): Promise<void> {
  for (const tenantId of await repo.listTenantIds()) {
    for (const u of (await repo.listUsers(tenantId)).filter((x) => x.status === 'active' && x.roles.includes('admin'))) {
      await repo.createNotification({ id: randomUUID(), tenantId, userId: u.id, kind: 'machine', title, body, runId: null, readAt: null, createdAt: new Date().toISOString() });
    }
  }
}

/** 会議の後の議事録を見回る間隔（10 分）。 */
const AUTO_MINUTES_INTERVAL_MS = 10 * 60_000;
let lastAutoMinutes = 0;

while (running) {
  let handled = false;

  if (Date.now() - lastScheduleCheck >= SCHEDULE_INTERVAL_MS) {
    lastScheduleCheck = Date.now();
    try {
      const started = await scheduler.tick(new Date());
      for (const runId of started) log.info('定時実行を起動しました', { runId });
    } catch (err) {
      log.error('定時実行の見回りで例外が発生しました', { err });
    }
  }

  if (Date.now() - lastNotifyCheck >= NOTIFY_INTERVAL_MS) {
    lastNotifyCheck = Date.now();
    try {
      const r = await notifier.sweep(new Date());
      if (r.sent > 0) log.info('通知の控えを届けました', r);
    } catch (err) {
      log.error('通知の控えの見回りで例外が発生しました', { err });
    }
  }

  if (Date.now() - lastProactiveCheck >= PROACTIVE_INTERVAL_MS) {
    lastProactiveCheck = Date.now();
    try {
      const started = await withAiUsage({ purpose: 'worker:proactive' }, () => proactive.tick(new Date()));
      if (started.length > 0) log.info('秘書が先回りして業務を起こしました', { count: started.length });
    } catch (err) {
      log.error('先回りの見回りで例外が発生しました', { err });
    }
  }

  if (Date.now() - lastConversationCheck >= CONVERSATION_INTERVAL_MS) {
    lastConversationCheck = Date.now();
    try {
      await withAiUsage({ purpose: 'worker:memory' }, () => conversations.sweep(new Date()));
      // 学習はイベントのたびに行う（第10.13節）。ここでは以前の形の候補の移し替えと、処理済みのイベントの片付けだけ
      const adopted = await learning.adoptLegacyCandidates(new Date());
      if (adopted > 0) log.info('以前の記憶の候補を覚えたことに移しました', { adopted });
      const before = new Date(Date.now() - AGENT_EVENT_KEEP_DAYS * 86_400_000).toISOString();
      for (const tenantId of await repo.listTenantIds()) await repo.purgeAgentEvents(tenantId, before);
    } catch (err) {
      log.error('会話ログの入れ替えで例外が発生しました', { err });
    }
  }

  // ローカルの形の機械: ワーカーが動いていることを書き、毎晩 2 時（日本時間）か頼まれたときに控えを取り、毎月 1 回戻せるかを確かめる（第8.6.5節・第8.6.7節）
  await writeWorkerBeat(machineDir(process.env), appVersion()).catch(() => undefined);
  if (backupCfg && Date.now() - lastBackupCheck >= 60_000) {
    lastBackupCheck = Date.now();
    try {
      const now = new Date();
      const jst = new Date(now.getTime() + 9 * 3_600_000);
      const today = jst.toISOString().slice(0, 10).replace(/-/g, '');
      const status = await readBackupStatus(backupCfg.dir);
      const requested = await takeBackupRequest(backupCfg.dir);
      const due = jst.getUTCHours() >= 2 && !status.last?.name.startsWith(today);
      if (requested || due) {
        const rec = await runBackup(backupCfg, now);
        log.info(rec.ok ? '控えを取りました' : '控えを取れませんでした', { name: rec.name, bytes: rec.dbBytes, error: rec.error });
        if (!rec.ok) await notifyMachine('控えを取れませんでした', `${rec.error ?? ''}。管理者ページの「機械」で確かめてください。`);
        if (rec.ok) startOffsite(backupCfg.dir, rec.name);
        const lastTest = status.restoreTest?.at ? new Date(Date.parse(status.restoreTest.at) + 9 * 3_600_000).toISOString().slice(0, 7) : null;
        if (rec.ok && lastTest !== jst.toISOString().slice(0, 7)) {
          const t = await restoreTest(backupCfg, now);
          log.info(t?.ok ? '控えを戻せることを確かめました' : '控えを戻せませんでした', { tables: t?.tables, error: t?.error });
          if (t && !t.ok) await notifyMachine('控えを戻せませんでした', `${t.error ?? ''}。管理者ページの「機械」で確かめてください。`);
        }
      }
    } catch (err) {
      log.warn('控えの見回りで例外が発生しました', { err });
    }
  }
  // クラウドの形: ワーカーが動いていることを 1 分ごとに書き、毎晩 0 時 30 分（日本時間）すぎに前の日の数を残す（第23.8.15節）
  if (opsSide && Date.now() - lastOpsBeat >= 60_000) {
    lastOpsBeat = Date.now();
    await opsSide.beat(workerBeatId, appVersion()).catch((err) => log.debug('ワーカーの知らせを書けませんでした', { err }));
    // 予告の期限が来た通常の停止を行う（第23.8.6節）
    const stopped = await opsSide.applyDueSuspensions().catch((err) => { log.warn('予告の期限が来た停止を行えませんでした', { err }); return 0; });
    if (stopped > 0) log.info('予告の期限が来た会社のご利用を停止しました', { tenants: stopped });
    // 期限が来たか切られた代理アクセスの、終わったあとの知らせ（第23.6.1節）
    const ended = await opsSide.sweepProxy().catch((err) => { log.warn('代理アクセスの終わりを知らせられませんでした', { err }); return 0; });
    if (ended > 0) log.info('代理アクセスの終わりを会社の管理者に知らせました', { grants: ended });
    const jst = new Date(Date.now() + 9 * 3_600_000);
    const yesterday = new Date(jst.getTime() - 86_400_000).toISOString().slice(0, 10);
    if (jst.getUTCHours() * 60 + jst.getUTCMinutes() >= 30 && lastDailyRecorded !== yesterday) {
      try {
        const n = await opsSide.recordDaily(yesterday);
        lastDailyRecorded = yesterday;
        log.info('会社ごとの毎日の数を残しました', { day: yesterday, tenants: n });
      } catch (err) {
        log.warn('会社ごとの毎日の数を残せませんでした', { err });
      }
    }
  }
  // 遠隔の保守の閉じた回を、会社の監査ログに残す（開けた時刻・つないだ相手・閉じた時刻。第8.6.4節）
  if (onsite && Date.now() - lastUpdateCheck >= 60_000) {
    try {
      for (const s of await takeClosedMaintenanceSessions(machineDir(process.env))) {
        for (const tenantId of await repo.listTenantIds()) {
          await repo.appendAudit({
            id: randomUUID(), tenantId, actorType: 'system', actorId: 'machine', action: 'machine.maintenance_session', targetType: 'machine', targetId: 'maintenance',
            detail: { openedAt: s.openedAt, openedBy: s.by, closedAt: s.closedAt, peers: s.peers }, occurredAt: s.closedAt ?? new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      log.warn('遠隔の保守の記録で例外が発生しました', { err });
    }
  }
  // 運営への稼働の知らせ（1 時間に 1 回。件数と状態だけ。第8.6.8節）
  if (heartbeatCfg && Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = Date.now();
    const sent = await sendHeartbeat(machineDir(process.env), heartbeatCfg, () => machineStatus(machineConfigFromEnv(process.env, appVersion()))).catch(() => false);
    if (!sent) log.debug('稼働の知らせを送れませんでした（切っているか、受け口に届きません）');
  }
  // 更新（機械の上の update.sh が行う）に失敗していたら、会社の管理者に 1 度だけ知らせる（第8.6.4節）
  if (onsite && Date.now() - lastUpdateCheck >= 60_000) {
    lastUpdateCheck = Date.now();
    try {
      const failed = await takeUnnotifiedUpdateFailure(machineDir(process.env));
      if (failed) {
        await notifyMachine(failed.result === 'rolled-back' ? `新しい版（${failed.to}）を入れられず、前の版に戻しました` : `新しい版（${failed.to}）を入れられませんでした`,
          `${failed.error ?? ''}。管理者ページの「機械」で確かめ、導入した技術者に伝えてください。`);
      }
    } catch (err) {
      log.warn('更新の結果の見回りで例外が発生しました', { err });
    }
  }

  // 会議が終わったら議事録を作り始める（10 分ごと。第9.5.2.1節）
  if (Date.now() - lastAutoMinutes >= AUTO_MINUTES_INTERVAL_MS) {
    lastAutoMinutes = Date.now();
    try {
      const n = await withAiUsage({ purpose: 'worker:minutes' }, () => autoMinutes.tick(new Date()));
      if (n > 0) log.info('会議の後の議事録を始めました', { count: n });
    } catch (err) {
      log.warn('会議の後の議事録の見回りで例外が発生しました', { err });
    }
  }

  // 社内のお知らせの締切の前の知らせ（3 日前と当日の朝 8 時から。第10.15.1節）。会社ごとの失敗はほかの会社を止めない
  if (Date.now() - lastNoticeRemind >= NOTICE_REMIND_INTERVAL_MS) {
    lastNoticeRemind = Date.now();
    for (const tenantId of await repo.listTenantIds().catch(() => [] as string[])) {
      try {
        const n = await notices.remind(tenantId, new Date());
        if (n > 0) log.info('お知らせの締切の前の知らせを届けました', { tenantId, count: n });
      } catch (err) {
        log.warn('お知らせの締切の前の知らせで例外が発生しました', { tenantId, err });
      }
    }
  }

  // AI の利用の暴走の見張り（前の 14 日の平均の 3 倍を超えた日を、止めずに管理者に知らせる）と、13 か月を過ぎた記録の片付け（第6.6.2節）
  if (Date.now() - lastAiUsageCheck >= AI_USAGE_INTERVAL_MS) {
    lastAiUsageCheck = Date.now();
    for (const tenantId of await repo.listTenantIds().catch(() => [] as string[])) {
      try {
        if (await aiMeter.watchSpike(tenantId)) log.info('AI の利用がふだんより多い日を知らせました', { tenantId });
        await aiMeter.prune(tenantId, new Date(Date.now() - AI_USAGE_KEEP_DAYS * 86_400_000));
      } catch (err) {
        log.warn('AI の利用の見張りで例外が発生しました', { tenantId, err });
      }
    }
  }

  if (Date.now() - lastRetentionCheck >= RETENTION_INTERVAL_MS) {
    lastRetentionCheck = Date.now();
    try {
      const r = await retention.sweep(new Date());
      if (r.expired > 0 || r.redacted > 0) log.info('保持期間の見回りを行いました', r);
    } catch (err) {
      log.error('保持期間の見回りで例外が発生しました', { err });
    }
  }

  try {
    const run = await repo.claimNextRun();
    if (run) {
      handled = true;
      const runLog = log.child({ runId: run.id, tenantId: run.tenantId });
      const startedAt = Date.now();
      runLog.info('実行を開始', { cursor: run.cursor });
      const result = await engine.advance(run);
      const ms = Date.now() - startedAt;
      switch (result.outcome) {
        case 'completed':
          runLog.info('実行が完了', { ms });
          break;
        case 'awaiting_approval':
          runLog.info('承認待ちで中断', { approvalId: result.approvalId, ms });
          break;
        case 'failed':
          // 失敗の詳細はエンジンが warn で記録している
          runLog.info('実行を終了（失敗）', { ms });
          break;
        case 'cancelled':
          runLog.info('実行を終了（途中で止められた）', { ms, reason: result.reason });
          break;
      }
    }
  } catch (err) {
    // 個別の実行の失敗でワーカー全体を落とさない
    log.error('実行中に例外が発生しました', { err });
  }
  // 名刺を 1 枚読み取る（第27.4節）。業務の実行と同じ間隔で見る
  try {
    if (await withAiUsage({ purpose: 'worker:cards' }, () => cards.processNext())) handled = true;
    // 読み取る名刺が無いときだけ、これまでの名刺の裏を 1 枚読み直す（英語の表記と裏の文を足す。第27.5.1節、Q-216）
    else if (await withAiUsage({ purpose: 'worker:cards' }, () => cards.readOldBack())) handled = true;
  } catch (err) {
    log.error('名刺の読み取りで例外が発生しました', { err });
  }
  // 承認されたまとめてのメールを 1 通送る（第27.9.1節）。1 つのまとめてのメールは数秒おきに送る
  try {
    if (await bulkMail.processNext(connector, async (tenantId) => appUrl((await repo.findTenantById(tenantId))?.subdomain ?? ''))) handled = true;
  } catch (err) {
    log.error('まとめてのメールの送信で例外が発生しました', { err });
  }
  if (Date.now() - lastCardPurge >= CARD_PURGE_INTERVAL_MS) {
    lastCardPurge = Date.now();
    try {
      const n = await cards.purgeExpired();
      if (n > 0) log.info('期限を過ぎた名刺を消しました', { cards: n });
    } catch (err) {
      log.error('名刺の消去の見回りで例外が発生しました', { err });
    }
  }
  if (Date.now() - lastKnowledgeEmbed >= KNOWLEDGE_EMBED_INTERVAL_MS) {
    lastKnowledgeEmbed = Date.now();
    try {
      const r = await knowledgeEmbedder.tick();
      if (r.embedded + r.failed > 0) log.info('知識の節を埋め込みました', r);
    } catch (err) {
      log.error('知識の埋め込みの見回りで例外が発生しました', { err });
    }
  }
  if (Date.now() - lastGoogleContactsSync >= GOOGLE_CONTACTS_INTERVAL_MS) {
    lastGoogleContactsSync = Date.now();
    try {
      const r = await googleContacts.tick(cardsAccess(repo));
      if (r.updated + r.added > 0) log.info('名刺を Google の連絡先に写しました', r);
    } catch (err) {
      log.error('Google の連絡先の見回りで例外が発生しました', { err });
    }
  }
  if (Date.now() - lastSignatureCheck >= SIGNATURE_INTERVAL_MS) {
    lastSignatureCheck = Date.now();
    try {
      const { applied } = await signatures.tick(new Date());
      if (applied > 0) log.info('メールの署名から名刺を新しくしました', { contacts: applied });
    } catch (err) {
      log.error('メールの署名の見回りで例外が発生しました', { err });
    }
  }

  // 在庫の Web への公開を、日本時間の日付が変わったら作り直す（第29.12.1節）。使用期限を過ぎた数を外す
  {
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    if (publicationRefreshedOn !== today) {
      publicationRefreshedOn = today;
      try {
        const n = await inventoryPublisher.refreshAll(new Date());
        if (n > 0) log.info('在庫の公開を作り直しました', { tenants: n });
      } catch (err) {
        log.error('在庫の公開の作り直しで例外が発生しました', { err });
      }
    }
  }

  // 在庫の毎朝の見直し（第29.14節）。日本時間の決まった時刻を過ぎたら、その日 1 回だけ
  {
    const jst = new Date(Date.now() + 9 * 3_600_000);
    const today = jst.toISOString().slice(0, 10);
    if (inventoryWatchedOn !== today && jst.getUTCHours() >= INVENTORY_WATCH_HOUR) {
      inventoryWatchedOn = today;
      try {
        const n = await inventoryWatch.dailyAll(new Date());
        if (n > 0) log.info('在庫の見張りの知らせを送りました', { notifications: n });
      } catch (err) {
        log.error('在庫の見張りで例外が発生しました', { err });
      }
    }
  }

  // 有給の付与と取得義務の見回り（第30.7.1節）と労務の期限の知らせ（第30.19.1節）。会社ごとの失敗はほかの会社を止めない
  {
    const jst = new Date(Date.now() + 9 * 3_600_000);
    const today = jst.toISOString().slice(0, 10);
    if (leaveWatchedOn !== today && jst.getUTCHours() >= INVENTORY_WATCH_HOUR) {
      leaveWatchedOn = today;
      let n = 0;
      for (const tenantId of await repo.listTenantIds()) {
        try {
          n += await attendance.daily(tenantId);
          n += await laborCalendar.daily(tenantId);
        } catch (err) {
          log.warn('有給と労務の期限の見回りに失敗しました', { tenantId, err });
        }
      }
      if (n > 0) log.info('有給の取得義務と労務の期限を知らせました', { notifications: n });
    }
  }

  // 店頭サイネージの見回り（第31.5.1節）。ふだん動いている時間帯に 5 分つながらない画面を知らせる。会社ごとの失敗はほかの会社を止めない
  if (Date.now() - lastSignageCheck >= SIGNAGE_INTERVAL_MS) {
    lastSignageCheck = Date.now();
    for (const tenantId of await repo.listTenantIds()) {
      try {
        const r = await signage.sweep(tenantId);
        if (r.notified > 0) log.info('つながらないサイネージの画面を知らせました', { tenantId, screens: r.notified });
        const p = await signageInterrupts.sweep(tenantId);
        if (p.texts + p.rows > 0) log.info('サイネージの割り込みの文と古い行を消しました', { tenantId, texts: p.texts, rows: p.rows });
        // 在庫の入荷の案内は 3 日で外す（第31.6.7節）
        const stock = await sweepStockNotices(signage, tenantId);
        if (stock > 0) log.info('サイネージの在庫の案内を外しました', { tenantId, notices: stock });
      } catch (err) {
        log.warn('サイネージの見回りに失敗しました', { tenantId, err });
      }
    }
  }

  // 問い合わせの見張り（第33.7節）。期限の前の日・期限を過ぎたとき・手つかずを知らせ、90 日を過ぎた原文を消す
  if (Date.now() - lastInquiryCheck >= INQUIRY_INTERVAL_MS) {
    lastInquiryCheck = Date.now();
    try {
      const r = await withAiUsage({ purpose: 'worker:inquiries' }, () => inquiryWatch.tick(new Date()));
      if (r.notified + r.forgotten > 0) log.info('問い合わせの期限を知らせ、古い原文を消しました', { notified: r.notified, forgotten: r.forgotten });
    } catch (err) {
      log.warn('問い合わせの見張りに失敗しました', { err });
    }
  }

  // 問い合わせの窓口のアカウントのメールを読む（第33.18節）。会社ごとの失敗はほかの会社を止めない
  if (Date.now() - lastInquiryMailCheck >= INQUIRY_MAIL_INTERVAL_MS) {
    lastInquiryMailCheck = Date.now();
    for (const tenantId of await repo.listTenantIds()) {
      try {
        const r = await inquiries.ingest(tenantId, new Date());
        if (r.created + r.appended + r.skipped + r.sent > 0) log.info('問い合わせの窓口のメールを読みました', { tenantId, ...r });
      } catch (err) {
        log.warn('問い合わせの窓口のメールを読めませんでした', { tenantId, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 競合の分析の作業（第36.18節）。待っている作業を 1 つ取り、終わるのを待たずに次へ進む
  if (Date.now() - lastCompetitorCheck >= COMPETITOR_INTERVAL_MS) {
    lastCompetitorCheck = Date.now();
    try {
      await withAiUsage({ purpose: 'worker:competitors' }, () => competitorWatch.tick());
    } catch (err) {
      log.warn('競合の分析の作業を始められませんでした', { err });
    }
  }

  // お知らせの予約の時刻と期間の後（第35.17節）
  if (Date.now() - lastAnnouncementCheck >= ANNOUNCEMENT_INTERVAL_MS) {
    lastAnnouncementCheck = Date.now();
    try {
      const r = await withAiUsage({ purpose: 'worker:announcements' }, () => announcements.tick(new Date()));
      if (r.published + r.ended > 0) log.info('お知らせの予約を出し、期間の後を片付けました', { published: r.published, ended: r.ended });
    } catch (err) {
      log.warn('お知らせの見回りに失敗しました', { err });
    }
  }

  // 契約の解約の申し出の期限と終わりの知らせ、自動更新の繰り越し（第38.6節）
  if (Date.now() - lastContractCheck >= CONTRACT_INTERVAL_MS) {
    lastContractCheck = Date.now();
    try {
      const r = await contracts.tick(new Date());
      if (r.notified + r.renewed > 0) log.info('契約の期限を知らせ、自動更新を進めました', { notified: r.notified, renewed: r.renewed });
    } catch (err) {
      log.warn('契約の期限の見張りに失敗しました', { err });
    }
  }

  // 補助金・助成金の月の調べものと、「気になる」にした制度の締め切りの知らせ（第39.7節）と、公募の変更の読み直し（第39.18節）
  if (Date.now() - lastSubsidyCheck >= SUBSIDY_INTERVAL_MS) {
    lastSubsidyCheck = Date.now();
    try {
      const r = await withAiUsage({ purpose: 'worker:subsidies' }, () => subsidies.tick(new Date()));
      if (r.searched + r.reminded + r.changed > 0) log.info('補助金・助成金を調べ、締め切りと公募の変更を知らせました', { searched: r.searched, reminded: r.reminded, changed: r.changed });
    } catch (err) {
      log.warn('補助金・助成金の見張りに失敗しました', { err });
    }
  }

  // 最後に貯めた日から有効期限の日数がたった会員のポイントを失効させる（第40.6節）
  if (Date.now() - lastMemberExpiry >= MEMBER_EXPIRY_INTERVAL_MS) {
    lastMemberExpiry = Date.now();
    try {
      const expired = await members.tick(new Date());
      if (expired > 0) log.info('会員のポイントを失効させました', { members: expired });
    } catch (err) {
      log.warn('会員のポイントの失効に失敗しました', { err });
    }
  }

  // 掲示の期間が終わった販促物を、作った人に知らせる（第41.8節。会員と同じ 1 時間ごとに見る）
  if (Date.now() - lastPrintCheck >= MEMBER_EXPIRY_INTERVAL_MS) {
    lastPrintCheck = Date.now();
    try {
      const told = await printDesigns.tick(new Date());
      if (told > 0) log.info('掲示の期間が終わった販促物を知らせました', { designs: told });
    } catch (err) {
      log.warn('販促物の見張りに失敗しました', { err });
    }
  }

  // 終わって 1 年を過ぎた予約を消す（第37.11節）
  if (Date.now() - lastReservationPurge >= RESERVATION_PURGE_INTERVAL_MS) {
    lastReservationPurge = Date.now();
    try {
      const removed = await reservations.tick(new Date());
      if (removed > 0) log.info('終わって 1 年を過ぎた予約を消しました', { removed });
    } catch (err) {
      log.warn('終わった予約の片付けに失敗しました', { err });
    }
  }

  // コラムの店頭サイネージ用の画像を作り、期間の過ぎた組を外す（第32.18.6節）
  if (Date.now() - lastColumnSignageCheck >= COLUMN_SIGNAGE_INTERVAL_MS) {
    lastColumnSignageCheck = Date.now();
    try {
      const n = await withAiUsage({ purpose: 'worker:columns' }, () => columnSignage.tick(new Date()));
      if (n > 0) log.info('コラムの店頭サイネージ用の画像を作りました', { sets: n });
    } catch (err) {
      log.warn('コラムの店頭サイネージ用の画像の見回りに失敗しました', { err });
    }
  }

  // コラムの作成の予約・予定表・テーマ案（第32.18.4節）。会社ごとの失敗はほかの会社を止めない
  if (Date.now() - lastColumnPlanCheck >= COLUMN_PLAN_INTERVAL_MS) {
    lastColumnPlanCheck = Date.now();
    try {
      const r = await withAiUsage({ purpose: 'worker:columns' }, () => columnPlanner.tick(new Date()));
      if (r.themes + r.prepared + r.skipped + r.placed > 0) log.info('コラムの予約・予定表・テーマ案を見回りました', r);
    } catch (err) {
      log.warn('コラムの作成の見回りに失敗しました', { err });
    }
  }

  // Webの分析の月の便り（第34.18節）。会社ごとの失敗はほかの会社を止めない
  if (Date.now() - lastWebReviewCheck >= WEB_REVIEW_INTERVAL_MS) {
    lastWebReviewCheck = Date.now();
    try {
      const r = await withAiUsage({ purpose: 'worker:web-review' }, () => webReview.tick(new Date()));
      if (r.created + r.checked > 0) log.info('Web の月の便りを作り、直すべき所を探しました', { created: r.created, checked: r.checked });
    } catch (err) {
      log.warn('Webの分析の見回りに失敗しました', { err });
    }
  }

  // 秘書が学んだことの整理（第11.11.4節）。会社ごとの失敗はほかの会社を止めない
  if (Date.now() - lastConsolidateCheck >= CONSOLIDATE_INTERVAL_MS) {
    lastConsolidateCheck = Date.now();
    for (const tenantId of await repo.listTenantIds()) {
      try {
        const now = new Date();
        if (!(await consolidator.due(tenantId, now))) continue;
        const r = await withAiUsage({ purpose: 'worker:knowledge' }, () => consolidator.run(tenantId, now));
        log.info('秘書が学んだことを整理しました', { tenantId, knowledge: r.knowledge, memories: r.memories, purged: r.purged });
      } catch (err) {
        log.warn('秘書が学んだことの整理に失敗しました', { tenantId, err });
      }
    }
  }

  // 業務と秘書のイベントを 1 件処理する（第10.13節）。業務の実行と同じ間隔で見る
  try {
    const outcome = await conductor.tick(new Date());
    if (outcome) {
      handled = true;
      if (outcome.action === 'learned' && (outcome.learned > 0 || outcome.promoted > 0)) {
        log.info('秘書がその場で学びました', { tenantId: outcome.event.tenantId, kind: outcome.event.kind, learned: outcome.learned, promoted: outcome.promoted });
      }
    }
  } catch (err) {
    log.error('秘書の受け手で例外が発生しました', { err });
  }

  if (!handled) await sleep(POLL_INTERVAL_MS);
}

log.info('停止しました');
await repo.close();
await contactStore.close();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** サービス本体の版（ルートの package.json。競合の分析が読むときの名乗りに入れる）。 */
function appVersion(): string {
  try {
    return (JSON.parse(readFileSync(appPath('package.json'), 'utf8')) as { version?: string }).version ?? '0';
  } catch {
    return '0';
  }
}
