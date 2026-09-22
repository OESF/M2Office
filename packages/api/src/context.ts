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
  PostgresRepository, StubLlmProvider, OpenAiCompatibleProvider, ToolRegistry, BUILTIN_TOOLS,
  RunEngine, Secretary, OFFICIAL_AGENTS, resolveOfficialAgent, buildConnector, LocalFileStore,
  createLoggerFromEnv,
  type FileStore, type LlmProvider, type Logger, type Repository, type WorkspaceConnector,
} from '@m2office/core';
import { fileURLToPath } from 'node:url';
import { loadAuthConfig, type AuthConfig } from './auth/config.js';

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

  const log = createLoggerFromEnv('api');
  const files = new LocalFileStore(fileStorageDir());
  const engine = new RunEngine({
    repo, llm, registry, connector, files, resolveDefinition: resolveOfficialAgent, logger: log,
  });
  const secretary = new Secretary({ repo, llm, connector, agents: OFFICIAL_AGENTS });
  return { repo, llm, connector, files, registry, engine, secretary, auth: loadAuthConfig(), log };
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
