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
  PostgresRepository, ToolRegistry, BUILTIN_TOOLS, GoogleDataRetention, GoogleRevocation, agentUsesGoogle,
  RunEngine, Secretary, OFFICIAL_AGENTS, buildConnector, LocalFileStore,
  createLoggerFromEnv, HelpCatalog, parseArticle, ExtensionHub, HttpMcpClient, loadExtensions,
  TenantAiResolver, platformAi, secretBoxFromEnv, enqueueJob, LOOKUP_AGENT_ID,
  defaultGeminiModels, ConnectionCredentials, type ConnectionAuthProvider,
  CardService, PostgresContactStore, cardsAccess, type ContactStore, NoticeService, PostgresNoticeStore,
  InventoryService, InventoryWatch, InventoryBookings, PostgresInventoryStore, inventoryAccess, HrService, PostgresHrStore, hrAccess, AttendanceService, PostgresAttendanceStore, PayrollService, PostgresPayrollStore, LAW_BOOK,
  type SecretBox, type GeminiModels,
  type FileStore, type TenantExtensions, type HelpArticle, type LlmProvider, type Logger, type Repository, type WorkspaceConnector,
} from '@m2office/core';
import { canRunAgent, type AgentDefinition, type ContactScope, type HrSettings, type InventorySettings } from '@m2office/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, type AuthConfig } from './auth/config.js';
import { OAuthStateStore } from './auth/oauth-state.js';
import { HandoffStore } from './auth/handoff.js';
import { DebugLog, debugEnabled } from './debug/log.js';
import { QUIET_TRACES, traceTitle } from './debug/trace.js';

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
  /** デバッグモードの記録（仕様書 第20.4.1節「デバッグモード」）。`M2O_DEBUG=true` のときだけある。 */
  debug: DebugLog | null;
  /** ヘルプの記事（仕様書 第6.10節）。 */
  help: HelpCatalog;
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
  /** 会社ごとの Gemini（自社の鍵か運営の設定）。 */
  ai: TenantAiResolver;
  /**
   * OAuth の戻り先の URI と、使い捨ての state の置き場。
   * `redirectUri` は Google、`connectionRedirectUri` は認証の要る会社の接続（仕様書 第12.11.6.2節）の戻り先
   */
  oauth: { redirectUri: string; connectionRedirectUri: string; states: OAuthStateStore };
  /** 認証の要る会社の接続の認可（仕様書 第12.11.6.4節）。接続の確認と道具の取り直しで使う。 */
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
  cards: { service: CardService; store: ContactStore; access(tenantId: string, userId: string): Promise<{ defaultScope: ContactScope } | null> };
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
    access(tenantId: string, userId: string): Promise<InventorySettings | null>;
  };
  /** 人事・給与（内蔵の拡張。仕様書 第30章）。使えるのは会社で入れていて人事区画に入っている人だけ。 */
  hr: {
    service: HrService;
    /** 勤怠と有給（段 2。第30.6.1節・第30.7.1節）。 */
    attendance: AttendanceService;
    /** 給与の計算（段 3。第30.10.1節）。 */
    payroll: PayrollService;
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
  const repo = new PostgresRepository(
    process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
  );
  // 秘密の値の箱。接続口（google）がリフレッシュ トークンを戻すのにも使う
  const { box, devKey } = secretBoxFromEnv();
  const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock', {
    repo, box, mockTenants: (process.env['CONNECTOR_MOCK_TENANTS'] ?? '').split(','),
    production: process.env['NODE_ENV'] === 'production',
  });
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  // 認証の要る会社の接続の認可（仕様書 第12.11.6.4節）。道具を呼ぶときに依頼した本人の認可を付ける
  const connections = new ConnectionCredentials({ repo, box });
  const hub = buildHub(repo, registry, log, connections);
  const platform = buildAi(hub);
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
  const ai = new TenantAiResolver({
    repo, box, fallbackLlm: llm, fallbackResearch: research,
    platformKey: platform.platformKey, testMode: platform.testMode,
    defaults: defaultGeminiModels(),
    baseUrl: platform.baseUrl,
  });
  // 名刺管理（内蔵の拡張。仕様書 第27章）。自分だけの名刺は持ち主でも絞るため、置き場は利用者を設定して問い合わせる
  const contactStore = new PostgresContactStore(
    process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
  );
  const cards = {
    store: contactStore,
    service: new CardService({ store: contactStore, repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log }),
    access: cardsAccess(repo),
  };
  // 社内のお知らせ（仕様書 第10.15節）
  const notices = new NoticeService({
    store: new PostgresNoticeStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    repo,
  });
  // 在庫管理（内蔵の拡張。仕様書 第29章）。在庫は会社で共有する
  // 数が変わったら見張りが見直す（第29.14節）。見張りは処理を使うため、後から結び付ける
  let inventoryWatch: InventoryWatch | null = null;
  const inventoryService = new InventoryService({
    store: new PostgresInventoryStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    repo, llm: (tenantId) => ai.llmFor(tenantId),
    onChanged: async (tenantId, itemIds) => inventoryWatch?.afterMoves(tenantId, itemIds),
  });
  // 予約との引き当て（第29.13節）
  const inventoryBookings = new InventoryBookings({
    store: inventoryService.store, service: inventoryService, repo, llm: (tenantId) => ai.llmFor(tenantId),
  });
  inventoryWatch = new InventoryWatch({ repo, service: inventoryService, bookings: inventoryBookings, logger: log });
  const inventory = { service: inventoryService, bookings: inventoryBookings, access: inventoryAccess(repo) };
  const engine = new RunEngine({
    repo, llm, registry, connector, files, logger: log, research, cards, notices, inventory,
    llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId),
    resolveDefinition: async (id, version, tenantId) => (await tenantView(tenantId)).resolve(id, version),
    registryFor: async (tenantId) => (await tenantView(tenantId)).registry,
    isAvailable,
    // 止めた実行に後から書き込まれた中身も消す（仕様書 第6.5.2.1節）
    onCancelled: async (run) => { await retentionRef.purgeRun(run, 'disconnect', new Date()); },
  });
  // デバッグモード（仕様書 第20.4.1節「デバッグモード」）。本番で有効にすると起動を断る
  const debug = debugEnabled() ? new DebugLog() : null;
  // 人事・給与（第30章）。秘書が本人の打刻と有給に答えるため、秘書より先に作る
  const hrService = new HrService({
    store: new PostgresHrStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    repo, llm: (tenantId) => ai.llmFor(tenantId),
  });
  const attendance = new AttendanceService({
    store: new PostgresAttendanceStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
    hrStore: hrService.deps.store, repo,
  });
  const help = new HelpCatalog(loadHelpArticles(helpDir(), log), OFFICIAL_AGENTS, registry);
  const secretary = new Secretary({
    // 勤怠と有給（第30.20節）
    attendance,
    repo, llm, connector, agents: OFFICIAL_AGENTS, help, agentsFor, llmFor: (t) => ai.llmFor(t), notices,
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
    // 時間のかかる依頼を、読むだけの業務として後ろへ回す（仕様書 第10.11.4節）
    startLookup: async (tenantId, userId, request, fileId, context) => {
      const view = await tenantView(tenantId);
      const def = view.resolve(LOOKUP_AGENT_ID, 1);
      if (!def || !view.isAvailable(LOOKUP_AGENT_ID)) return null;
      // 同じ依頼が動いている間は、新しく起こさない（第10.11.4節）
      const same = await repo.findActiveJobByInput(tenantId, userId, LOOKUP_AGENT_ID, 'request', request);
      if (same) return { runId: same, already: true };
      const { runId } = await enqueueJob(repo, {
        tenantId, requestedBy: userId, def,
        input: { request, ...(fileId ? { fileId } : {}), ...(context ? { context } : {}) },
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
  });
  const googleRedirect = process.env['GOOGLE_OAUTH_REDIRECT_URI'] ?? 'http://localhost:3100/v1/oauth/google/callback';
  return {
    repo, llm, connector, files, registry, engine, secretary, auth: loadAuthConfig(), log, debug, help, retention, revocation,
    hub, tenantView, agentsFor, canUse, isAvailable, box, ai, connections,
    oauth: {
      // Google は http の戻り先を localhost にしか認めないため、開発では localhost の画面の転送を通す（ADR-0007）
      redirectUri: googleRedirect,
      // 会社の接続の戻り先。無ければ Google の戻り先と同じホストに置く（Slack は https の戻り先だけを認める）
      connectionRedirectUri: process.env['CONNECTION_OAUTH_REDIRECT_URI']
        ?? new URL('/v1/oauth/connection/callback', googleRedirect).toString(),
      states: new OAuthStateStore(),
    },
    loginStates: new OAuthStateStore(),
    handoffs: new HandoffStore(),
    cards,
    notices,
    inventory,
    // 人事・給与（第30章）。台帳は人事区画の人だけが扱い、勤怠と有給は本人も扱う
    hr: {
      service: hrService, attendance, access: hrAccess(repo),
      payroll: new PayrollService({
        store: new PostgresPayrollStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
        hrStore: hrService.deps.store, attendance, repo, law: LAW_BOOK,
      }),
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
  const dir = process.env['EXTENSIONS_DIR'] ?? fileURLToPath(new URL('../../../extensions', import.meta.url));
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
  return process.env['HELP_DIR'] ?? fileURLToPath(new URL('../../../docs/help', import.meta.url));
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

/**
 * ファイルの置き場（開発用のローカルディレクトリ）。
 *
 * @remarks 既定はリポジトリ直下の `.data/files`。本番はオブジェクトストレージに差し替える。
 */
export function fileStorageDir(): string {
  return process.env['FILE_STORAGE_DIR'] ?? fileURLToPath(new URL('../../../.data/files', import.meta.url));
}

/**
 * 運営の設定から、会社の鍵が無いときの推論と調べものを決める（仕様書 第20.2節・第20.2.4節）。
 *
 * @remarks
 * 運営の鍵があれば Gemini。`LLM_PROVIDER=stub` は自動テスト専用のスタブ（見本の応答を再生する）。
 * どちらでもなければ「設定されていない」になり、秘書も業務も動かさない（ADR-0030）。ワーカーと同じ判定。
 */
export function buildAi(hub?: ExtensionHub) {
  return platformAi(process.env, (agentId) => hub?.officialAgents().find((a) => a.id === agentId)?.evals);
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
