import {
  PostgresRepository, StubLlmProvider, OpenAiCompatibleProvider, ToolRegistry, BUILTIN_TOOLS,
  RunEngine, Scheduler, resolveOfficialAgent, buildConnector, type LlmProvider,
} from '@m2office/core';

/**
 * ジョブ実行ワーカー。
 *
 * 待ち行列から実行を 1 件ずつ取り出し、完了するか承認待ちになるまで進める。
 * あわせて、定時実行の時刻を見回り、時刻を過ぎたものを待ち行列へ入れる。
 *
 * @remarks
 * **常駐プロセスとして動かす**（仕様書 第20.6節）。
 * 承認による中断と再開は数分から数十分にまたがるため、
 * リクエスト単位で終了する実行環境では実装できない。
 *
 * 承認待ちで中断した実行は、状態が永続化されたうえでワーカーの担当を離れる。
 * 承認後は待ち行列へ戻り、**別のワーカーが文脈を読み直して**続きを実行する
 * （仕様書 第24.3.2節 段階 5 と 7）。
 */

const repo = new PostgresRepository(
  process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
);
const registry = new ToolRegistry();
for (const tool of BUILTIN_TOOLS) registry.register(tool);
const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock');

const engine = new RunEngine({
  repo, llm: buildLlm(), registry, connector, resolveDefinition: resolveOfficialAgent,
});
const scheduler = new Scheduler({ repo, resolveDefinition: resolveOfficialAgent });

const POLL_INTERVAL_MS = 1000;
/** 定時実行の見回り間隔。分単位の指定に対して十分に短くする。 */
const SCHEDULE_INTERVAL_MS = Number(process.env['SCHEDULE_INTERVAL_MS'] ?? 15_000);
let running = true;
let lastScheduleCheck = 0;

process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

console.log('[worker] 待ち行列の監視を開始しました');
console.log(`[worker] 業務システムへの接続: ${connector.source === 'mock' ? 'ダミーデータ' : 'Google'}`);

while (running) {
  let handled = false;

  if (Date.now() - lastScheduleCheck >= SCHEDULE_INTERVAL_MS) {
    lastScheduleCheck = Date.now();
    try {
      const started = await scheduler.tick(new Date());
      for (const id of started) console.log(`[worker] 定時実行を起動: ${id.slice(0, 8)}`);
    } catch (err) {
      console.error('[worker] 定時実行の見回りで例外が発生しました:', err);
    }
  }

  try {
    const run = await repo.claimNextRun();
    if (run) {
      handled = true;
      const label = `${run.id.slice(0, 8)} (${run.tenantId})`;
      console.log(`[worker] 実行を開始: ${label} cursor=${run.cursor}`);
      const result = await engine.advance(run);
      switch (result.outcome) {
        case 'completed':
          console.log(`[worker] 完了: ${label}`);
          break;
        case 'awaiting_approval':
          console.log(`[worker] 承認待ちで中断: ${label} approval=${result.approvalId.slice(0, 8)}`);
          break;
        case 'failed':
          console.log(`[worker] 失敗: ${label} 理由=${result.reason}`);
          break;
      }
    }
  } catch (err) {
    // 個別の実行の失敗でワーカー全体を落とさない
    console.error('[worker] 実行中に例外が発生しました:', err);
  }
  if (!handled) await sleep(POLL_INTERVAL_MS);
}

console.log('[worker] 停止しました');
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
  return new StubLlmProvider();
}
