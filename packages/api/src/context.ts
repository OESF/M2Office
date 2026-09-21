import {
  PostgresRepository, StubLlmProvider, OpenAiCompatibleProvider,
  ToolRegistry, BUILTIN_TOOLS, RunEngine, Secretary, OFFICIAL_AGENTS,
  resolveOfficialAgent, type LlmProvider, type Repository,
} from '@m2office/core';

/** API プロセス全体で共有する依存。 */
export interface AppDeps {
  repo: Repository;
  llm: LlmProvider;
  registry: ToolRegistry;
  engine: RunEngine;
  secretary: Secretary;
}

/**
 * 設定から依存を組み立てる。
 *
 * @remarks
 * LLM の提供者は設定で切り替える（仕様書 第21.2節）。
 * 鍵が未設定の場合はスタブを使い、鍵が無くても全体の流れを確認できるようにする。
 */
export function buildDeps(): AppDeps {
  const repo = new PostgresRepository(
    process.env['DATABASE_URL'] ?? 'postgres://m2office:m2office@localhost:3105/m2office',
  );
  const llm = buildLlm();
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  const engine = new RunEngine({
    repo, llm, registry, resolveDefinition: resolveOfficialAgent,
  });
  const secretary = new Secretary({ repo, llm, agents: OFFICIAL_AGENTS });
  return { repo, llm, registry, engine, secretary };
}

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
