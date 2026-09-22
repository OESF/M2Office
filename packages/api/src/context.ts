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
  RunEngine, Secretary, OFFICIAL_AGENTS, buildConnector, LocalFileStore,
  createLoggerFromEnv, HelpCatalog, parseArticle, AgentCatalog, loadExtensions,
  type FileStore, type HelpArticle, type LlmProvider, type Logger, type Repository, type WorkspaceConnector,
} from '@m2office/core';
import type { AgentDefinition } from '@m2office/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  /** ヘルプの記事（仕様書 第6.10節）。 */
  help: HelpCatalog;
  /** 業務エージェントの目録（公式と、読み込んだ拡張機能）。 */
  catalog: AgentCatalog;
  /** その会社で使える業務エージェント（公式と、導入した拡張機能）。無効にしたものも含む。 */
  agentsFor(tenantId: string): Promise<AgentDefinition[]>;
  /** その会社で業務エージェントを使えるか。 */
  isAvailable(tenantId: string, agentId: string): Promise<boolean>;
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
  const connector = buildConnector(process.env['CONNECTOR_MODE'] ?? 'mock');
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);

  const catalog = buildCatalog(registry, log);
  const llm = buildLlm(catalog);
  const agentsFor = async (tenantId: string) =>
    catalog.forTenant((await repo.listInstalledExtensions(tenantId)).map((e) => e.extensionId));
  const isAvailable = async (tenantId: string, agentId: string) =>
    catalog.availableFor(agentId, (await repo.listInstalledExtensions(tenantId)).map((e) => e.extensionId));

  const files = new LocalFileStore(fileStorageDir());
  const engine = new RunEngine({
    repo, llm, registry, connector, files, logger: log,
    resolveDefinition: (id, version) => catalog.resolve(id, version), isAvailable,
  });
  const help = new HelpCatalog(loadHelpArticles(helpDir(), log), OFFICIAL_AGENTS, registry);
  const secretary = new Secretary({ repo, llm, connector, agents: OFFICIAL_AGENTS, help, agentsFor });
  return {
    repo, llm, connector, files, registry, engine, secretary, auth: loadAuthConfig(), log, help,
    catalog, agentsFor, isAvailable,
  };
}

/**
 * 拡張機能を読み込み、業務エージェントの目録を作る（仕様書 第12.9.2節）。
 *
 * @remarks 検証を通らない拡張機能は使わず、理由を記録する。起動は止めない。
 */
export function buildCatalog(registry: ToolRegistry, log: Logger): AgentCatalog {
  const dir = process.env['EXTENSIONS_DIR'] ?? fileURLToPath(new URL('../../../extensions', import.meta.url));
  const { packages, errors } = loadExtensions(dir, registry, OFFICIAL_AGENTS.map((a) => a.id));
  for (const e of errors) log.warn('拡張機能を読み込めませんでした', { dir: e.dir, problems: e.problems });
  for (const p of packages) {
    log.info('拡張機能を読み込みました', {
      extensionId: p.manifest.id, version: p.manifest.version, agents: p.agents.map((a) => a.id),
    });
  }
  return new AgentCatalog(OFFICIAL_AGENTS, packages);
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
 * 設定に応じて LLM 提供者を選ぶ（仕様書 第20.2節）。
 *
 * @remarks ワーカーと同じ判定を用いる。
 */
export function buildLlm(catalog?: AgentCatalog): LlmProvider {
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
  return new StubLlmProvider((agentId) => catalog?.all().find((a) => a.id === agentId)?.evals);
}
