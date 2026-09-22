/**
 * `@m2office/core` の公開窓口。
 *
 * ドメインロジックのみを置く。HTTP・フレームワーク・画面に依存しない
 * （仕様書 第20.5節）。API とワーカーの双方から同じロジックを呼ぶ。
 */
export * from './llm/provider.js';
export { StubLlmProvider } from './llm/stub.js';
export { OpenAiCompatibleProvider, LlmRequestError } from './llm/gemini.js';
export type { GeminiModelMap } from './llm/gemini.js';

export type { Repository, KnowledgeHit } from './repository/types.js';
export { PostgresRepository } from './repository/postgres.js';

export { buildConnector, MockWorkspaceConnector } from './connectors/index.js';
export type {
  WorkspaceConnector, ConnectorPrincipal, DataSource, MailSummary, MailMessage,
  CalendarEvent, TaskItem, BusySlot,
} from './connectors/types.js';

export { ToolRegistry } from './tools/registry.js';
export type { Tool, ToolContext } from './tools/registry.js';
export { BUILTIN_TOOLS } from './tools/builtin.js';

export { RunEngine, estimateCostJpy } from './engine/run-engine.js';
export type { AdvanceResult, RunEngineDeps } from './engine/run-engine.js';
export { validateDefinition } from './engine/validate.js';
export { enqueueJob } from './engine/enqueue.js';
export { Scheduler } from './scheduler/scheduler.js';
export { nextRunAt, validateRule, describeRule } from './scheduler/rule.js';
export { parseToolCalls } from './engine/tool-protocol.js';
export {
  RunNotResumableError, DefinitionInvalidError, TenantBoundaryError, ApprovalForbiddenError,
} from './engine/errors.js';

export { OFFICIAL_AGENTS, resolveOfficialAgent } from './agents/index.js';
export { Secretary } from './secretary/secretary.js';
export type { SecretaryReply, ResponseLayer } from './secretary/secretary.js';
export { DIRECT_QUERIES } from './secretary/catalog.js';
