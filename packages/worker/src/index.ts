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
  RunEngine, Scheduler, buildConnector, LocalFileStore, createLoggerFromEnv, ExtensionHub, HttpMcpClient,
  loadExtensions, OFFICIAL_AGENTS, type LlmProvider,
} from '@m2office/core';
import { fileURLToPath } from 'node:url';

const log = createLoggerFromEnv('worker');

const repo = new PostgresRepository(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
);
const registry = new ToolRegistry();
for (const tool of BUILTIN_TOOLS) registry.register(tool);
const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock');

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

const engine = new RunEngine({
  repo, llm: buildLlm(), registry, connector, files, resolveDefinition, isAvailable, logger: log,
  registryFor: async (tenantId) => (await hub.forTenant(tenantId)).registry,
});
const scheduler = new Scheduler({ repo, resolveDefinition, isAvailable, logger: log });

const POLL_INTERVAL_MS = 1000;
/** 定時実行の見回り間隔。分単位の指定に対して十分に短くする。 */
const SCHEDULE_INTERVAL_MS = Number(process.env['SCHEDULE_INTERVAL_MS'] ?? 15_000);
let running = true;
let lastScheduleCheck = 0;

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

log.info('待ち行列の監視を開始しました', {
  connector: connector.source, scheduleIntervalMs: SCHEDULE_INTERVAL_MS,
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
      {
        fast: process.env['MODEL_FAST'] ?? 'gemini-flash-latest',
        standard: process.env['MODEL_STANDARD'] ?? 'gemini-flash-latest',
        advanced: process.env['MODEL_ADVANCED'] ?? 'gemini-pro-latest',
      },
      process.env['GEMINI_BASE_URL'] ??
        'https://generativelanguage.googleapis.com/v1beta/openai',
    );
  }
  // 鍵が無い開発環境では、拡張機能の評価のケースにある見本の応答を再生する（仕様書 第12.9.4節）
  // 実行エンジンは実行中の定義の評価のケースを渡す。ここでは公式の配布元の分を予備として引く
  return new StubLlmProvider((agentId) => hub.officialAgents().find((a) => a.id === agentId)?.evals);
}
