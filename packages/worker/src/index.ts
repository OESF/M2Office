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
  PostgresRepository, StubLlmProvider, OpenAiCompatibleProvider, ToolRegistry, BUILTIN_TOOLS,
  RunEngine, Scheduler, buildConnector, LocalFileStore, createLoggerFromEnv, ExtensionHub, HttpMcpClient, GoogleDataRetention, agentUsesGoogle,
  NotificationDelivery, MockNotificationSender, ConversationRotation, MemoryLearning,
  loadExtensions, OFFICIAL_AGENTS, GeminiResearchProvider, MockResearchProvider, TenantAiResolver, secretBoxFromEnv,
  defaultGeminiModels, warnHotSwapModels,
  type LlmProvider,
} from '@m2office/core';
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
const hub = new ExtensionHub({
  repo, registry, official: OFFICIAL_AGENTS, packages: extensions.packages, mcp: new HttpMcpClient(), logger: log,
});
const resolveDefinition = async (id: string, version: number, tenantId: string) =>
  (await hub.forTenant(tenantId)).resolve(id, version);
const isAvailable = async (tenantId: string, agentId: string) => (await hub.forTenant(tenantId)).isAvailable(agentId);

const llm = buildLlm();
// Web の調査（第9.4.2節）。鍵があれば Gemini の Google 検索、無ければ見本。API と同じ判定
const research = process.env['LLM_PROVIDER'] === 'gemini' && process.env['GEMINI_API_KEY']
  ? new GeminiResearchProvider(process.env['GEMINI_API_KEY'], defaultGeminiModels().research)
  : new MockResearchProvider();
// 会社ごとの Gemini（会社が自社の鍵を登録していればその鍵。仕様書 第14.3.3節）
// 役割ごとのモデル。既定は安いほうから選ぶ（仕様書 第20.2.2節）。API と同じ
const models = defaultGeminiModels();
warnHotSwapModels(models, log);
const ai = new TenantAiResolver({
  repo, box, fallbackLlm: llm, fallbackResearch: research,
  platformKey: process.env['LLM_PROVIDER'] === 'gemini' ? process.env['GEMINI_API_KEY'] || null : null,
  defaults: models,
  baseUrl: process.env['GEMINI_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
});
// Google から取得したデータの保持（仕様書 第14.3.2節）。Google のツールは、内蔵のツールのうち権限を宣言しているもの
const retention = new GoogleDataRetention({ repo, isGoogleTool: (name) => !!registry.get(name)?.google, logger: log });
const engine = new RunEngine({
  repo, llm, registry, connector, files, resolveDefinition, isAvailable, logger: log, research,
  llmFor: (tenantId) => ai.llmFor(tenantId), researchFor: (tenantId) => ai.researchFor(tenantId),
  registryFor: async (tenantId) => (await hub.forTenant(tenantId)).registry,
  // 止めた実行に後から書き込まれた中身も消す（仕様書 第6.5.2.1節）
  onCancelled: async (run) => { await retention.purgeRun(run, 'disconnect', new Date()); },
});
const scheduler = new Scheduler({
  repo, resolveDefinition, isAvailable, logger: log,
  // 本物の Google の接続口で動かすときだけ、接続の無い人の Google を使う定時実行を飛ばす（仕様書 第6.5.2.1節）
  missingGoogleConnection: async (tenantId, userId, def) => {
    if (connector.sourceFor(tenantId) !== 'google') return false;
    if (!agentUsesGoogle(def, (await hub.forTenant(tenantId)).registry)) return false;
    return !(await repo.getGoogleConnection(tenantId, userId));
  },
  // 管理者が止めたコネクタのツールを使う業務は動かせない（仕様書 第6.6.3.1節）
  disabledToolOf: async (tenantId, def) => {
    const { disabledTools } = await hub.forTenant(tenantId);
    return def.tools.find((name) => disabledTools.has(name)) ?? null;
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

const POLL_INTERVAL_MS = 1000;
/** 定時実行の見回り間隔。分単位の指定に対して十分に短くする。 */
const SCHEDULE_INTERVAL_MS = Number(process.env['SCHEDULE_INTERVAL_MS'] ?? 15_000);
/** 通知の控えの見回り間隔。通知しない時間帯が明けたときの遅れを、この間隔に収める。 */
const NOTIFY_INTERVAL_MS = Number(process.env['NOTIFY_INTERVAL_MS'] ?? 10_000);
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

  if (Date.now() - lastConversationCheck >= CONVERSATION_INTERVAL_MS) {
    lastConversationCheck = Date.now();
    try {
      await conversations.sweep(new Date());
      const learned = await learning.sweep(new Date());
      if (learned.learned > 0 || learned.digests > 0 || learned.promoted > 0) log.info('対話からの学習を行いました', learned);
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
  if (!handled) await sleep(POLL_INTERVAL_MS);
}

log.info('停止しました');
await repo.close();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 設定に応じて LLM 提供者を選ぶ（仕様書 第20.2節）。API と同じ判定を用いる。 */
function buildLlm(): LlmProvider {
  const provider = process.env['LLM_PROVIDER'] ?? 'stub';
  const key = process.env['GEMINI_API_KEY'] ?? '';
  if (provider === 'gemini' && key) {
    return new OpenAiCompatibleProvider(
      key,
      defaultGeminiModels(),
      process.env['GEMINI_BASE_URL'] ??
        'https://generativelanguage.googleapis.com/v1beta/openai',
    );
  }
  // 鍵が無い開発環境では、拡張機能の評価のケースにある見本の応答を再生する（仕様書 第12.9.4節）
  // 実行エンジンは実行中の定義の評価のケースを渡す。ここでは公式の配布元の分を予備として引く
  return new StubLlmProvider((agentId) => hub.officialAgents().find((a) => a.id === agentId)?.evals);
}
