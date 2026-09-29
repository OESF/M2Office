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

import {
  PostgresRepository, ToolRegistry, BUILTIN_TOOLS,
  RunEngine, Scheduler, scheduleChecks, CardService, PostgresContactStore, cardsAccess, InventoryService, PostgresInventoryStore, inventoryAccess, NoticeService, PostgresNoticeStore, buildConnector, LocalFileStore, createLoggerFromEnv, ExtensionHub, HttpMcpClient, GoogleDataRetention,
  NotificationDelivery, MockNotificationSender, ConversationRotation, MemoryLearning, SecretaryConductor, PlanRunner, enqueueJob,
  loadExtensions, OFFICIAL_AGENTS, TenantAiResolver, platformAi, secretBoxFromEnv,
  defaultGeminiModels, warnHotSwapModels, ProactiveWatcher, ConnectionCredentials,
} from '@m2office/core';
import { canRunAgent } from '@m2office/shared';
import { fileURLToPath } from 'node:url';

const log = createLoggerFromEnv('worker');

const repo = new PostgresRepository(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
);
const registry = new ToolRegistry();
for (const tool of BUILTIN_TOOLS) registry.register(tool);
// 秘密の値の箱。接続口（google）がリフレッシュ トークンを戻すのにも使う
const { box } = secretBoxFromEnv();
const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock', {
  repo, box, mockTenants: (process.env['CONNECTOR_MOCK_TENANTS'] ?? '').split(','),
  production: process.env['NODE_ENV'] === 'production',
});

// API と同じ置き場を使う。既定はリポジトリ直下の .data/files
const files = new LocalFileStore(
  process.env['FILE_STORAGE_DIR'] ?? fileURLToPath(new URL('../../../.data/files', import.meta.url)),
);
// API と同じく拡張機能を読み込む（仕様書 第12.9.2節）。検証を通らないものは使わない
const extensions = loadExtensions(
  process.env['EXTENSIONS_DIR'] ?? fileURLToPath(new URL('../../../extensions', import.meta.url)),
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
const platform = platformAi(process.env, (agentId) => hub.officialAgents().find((a) => a.id === agentId)?.evals);
const llm = platform.llm;
const research = platform.research;
// 会社ごとの Gemini（会社が自社の鍵を登録していればその鍵。仕様書 第14.3.3節）
// 役割ごとのモデル。既定は安いほうから選ぶ（仕様書 第20.2.2節）。API と同じ
const models = defaultGeminiModels();
warnHotSwapModels(models, log);
const ai = new TenantAiResolver({
  repo, box, fallbackLlm: llm, fallbackResearch: research,
  platformKey: platform.platformKey, testMode: platform.testMode,
  defaults: models,
  baseUrl: platform.baseUrl,
});
// Google から取得したデータの保持（仕様書 第14.3.2節）。Google のツールは、内蔵のツールのうち権限を宣言しているもの
const retention = new GoogleDataRetention({ repo, isGoogleTool: (name) => !!registry.get(name)?.google, logger: log });
// 名刺管理（内蔵の拡張。仕様書 第27章）。名刺の道具（第27.9節）と、後ろでの読み取り（第27.4節）が同じ置き場を使う
const contactStore = new PostgresContactStore(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
);
const cards = new CardService({ store: contactStore, repo, files, llmFor: (tenantId) => ai.llmFor(tenantId), logger: log });
// 社内のお知らせ（仕様書 第10.15節）。朝のブリーフが本人宛てのものを読む
const notices = new NoticeService({
  store: new PostgresNoticeStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo,
});
// 在庫管理（内蔵の拡張。仕様書 第29章）。秘書から頼まれた入出庫の記録（第29.15節）が使う
const inventory = new InventoryService({
  store: new PostgresInventoryStore(process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office'),
  repo, llm: (tenantId) => ai.llmFor(tenantId),
});
const engine = new RunEngine({
  repo, llm, registry, connector, files, resolveDefinition, isAvailable, logger: log, research, notices,
  cards: { store: contactStore, service: cards, access: cardsAccess(repo) },
  inventory: { service: inventory, access: inventoryAccess(repo) },
  llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId),
  registryFor: async (tenantId) => (await hub.forTenant(tenantId)).registry,
  // 止めた実行に後から書き込まれた中身も消す（仕様書 第6.5.2.1節）
  onCancelled: async (run) => { await retention.purgeRun(run, 'disconnect', new Date()); },
});
// 動かない理由の判定は、管理者の「定時実行の一覧」と同じもの（仕様書 第6.6.8.2節）。
// 本物の Google の接続口の会社で接続の無い人・止めたツール・未接続のサービス（Slack など）の定時実行は飛ばす
const scheduler = new Scheduler({ ...scheduleChecks({ repo, hub, connector }), logger: log });

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

/** 期限を過ぎた名刺（ごみ箱に 30 日・読み取れなかったもの 4 週）を消す見回りの間隔。 */
const CARD_PURGE_INTERVAL_MS = Number(process.env['CARD_PURGE_INTERVAL_MS'] ?? 3_600_000);
let lastCardPurge = 0;

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

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

log.info('待ち行列の監視を開始しました', {
  connector: process.env['CONNECTOR_MODE'] ?? 'mock', mockTenants: process.env['CONNECTOR_MOCK_TENANTS'] || undefined,
  scheduleIntervalMs: SCHEDULE_INTERVAL_MS,
});

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
      const started = await proactive.tick(new Date());
      if (started.length > 0) log.info('秘書が先回りして業務を起こしました', { count: started.length });
    } catch (err) {
      log.error('先回りの見回りで例外が発生しました', { err });
    }
  }

  if (Date.now() - lastConversationCheck >= CONVERSATION_INTERVAL_MS) {
    lastConversationCheck = Date.now();
    try {
      await conversations.sweep(new Date());
      // 学習はイベントのたびに行う（第10.13節）。ここでは以前の形の候補の移し替えと、処理済みのイベントの片付けだけ
      const adopted = await learning.adoptLegacyCandidates(new Date());
      if (adopted > 0) log.info('以前の記憶の候補を覚えたことに移しました', { adopted });
      const before = new Date(Date.now() - AGENT_EVENT_KEEP_DAYS * 86_400_000).toISOString();
      for (const tenantId of await repo.listTenantIds()) await repo.purgeAgentEvents(tenantId, before);
    } catch (err) {
      log.error('会話ログの入れ替えで例外が発生しました', { err });
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
    if (await cards.processNext()) handled = true;
  } catch (err) {
    log.error('名刺の読み取りで例外が発生しました', { err });
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

