import {
  PostgresRepository, StubLlmProvider, OpenAiCompatibleProvider, ToolRegistry, BUILTIN_TOOLS,
  RunEngine, Secretary, OFFICIAL_AGENTS, resolveOfficialAgent, buildConnector,
  type LlmProvider, type Repository, type WorkspaceConnector,
} from '@m2office/core';
import { loadAuthConfig, type AuthConfig } from './auth/config.js';

/** API プロセス全体で共有する依存。 */
export interface AppDeps {
  repo: Repository;
  llm: LlmProvider;
  connector: WorkspaceConnector;
  registry: ToolRegistry;
  engine: RunEngine;
  secretary: Secretary;
  auth: AuthConfig;
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
  const repo = new PostgresRepository(
    process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office',
  );
  const llm = buildLlm();
  const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock');
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  const engine = new RunEngine({
    repo, llm, registry, connector, resolveDefinition: resolveOfficialAgent,
  });
  const secretary = new Secretary({ repo, llm, connector, agents: OFFICIAL_AGENTS });
  return { repo, llm, connector, registry, engine, secretary, auth: loadAuthConfig() };
}

/**
 * 設定に応じて LLM 提供者を選ぶ（仕様書 第20.2節）。
 *
 * @remarks ワーカーと同じ判定を用いる。
 */
export function buildLlm(): LlmProvider {
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
