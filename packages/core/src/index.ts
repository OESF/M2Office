/**
 * @file `@m2office/core` の公開窓口。外から使うものをここでまとめて書き出す。
 *
 * ドメインロジックのみを置く。HTTP・フレームワーク・画面に依存しない。
 * API とワーカーの双方から同じロジックを呼ぶ。
 *
 * @see 仕様書 第20.5節 リポジトリ構成
 */

export {
  createLogger, createLoggerFromEnv, silentLogger, LOG_LEVELS,
  type Logger, type LogLevel, type LogFields, type LoggerOptions,
} from './log/logger.js';

export * from './llm/provider.js';
export { StubLlmProvider } from './llm/stub.js';
export { OpenAiCompatibleProvider, LlmRequestError } from './llm/gemini.js';
export type { GeminiModelMap } from './llm/gemini.js';

export type {
  Repository, KnowledgeHit, KnowledgeItem, KnowledgeSearchResult, KnowledgeSectionView, RunStatRow, InstalledExtension, PrivateExtension, CompartmentAssignment,
  CredentialKind, TenantCredential, GoogleConnection,
} from './repository/types.js';
export { PostgresRepository } from './repository/postgres.js';
export { canViewRun, type RunViewer } from './engine/run-access.js';
export * from './dashboard/presence.js';
export * from './notify/sender.js';
export * from './notify/delivery.js';
export * from './retention/google-data.js';
export * from './retention/revocation.js';
export * from './knowledge/index.js';

export { buildConnector, MockWorkspaceConnector } from './connectors/index.js';
export {
  HttpMcpClient, MCP_TIMEOUT_MS, MCP_RESULT_LIMIT,
  type McpClient, type McpToolInfo, type McpCallResult,
} from './connectors/mcp.js';
export type {
  WorkspaceConnector, ConnectorPrincipal, DataSource, MailSummary, MailMessage,
  CalendarEvent, TaskItem, BusySlot, DriveFile, DirectoryPerson, MeetTranscript, FormResponses,
} from './connectors/types.js';

export * from './files/index.js';
export { SecretBox, secretBoxFromEnv } from './secrets/box.js';
export {
  TenantAiResolver, type GeminiModels, type GeminiSettingsMeta, type ResolvedGemini, type TenantAiResolverDeps,
} from './secrets/tenant-ai.js';
export { checkGeminiText, checkGeminiLive, type CheckResult } from './secrets/gemini-check.js';
export {
  GOOGLE_OAUTH_ENDPOINTS, GOOGLE_LOGIN_SCOPES, googleScopeUrl, googleScopeLabel, createPkce, buildGoogleAuthUrl,
  exchangeGoogleCode, refreshGoogleAccessToken, googleGrantedScopes, googleUserEmail, revokeGoogleToken, GoogleOAuthError,
  type GoogleOAuthEndpoints,
} from './google/oauth.js';
export {
  GeminiResearchProvider, MockResearchProvider, type ResearchProvider, type ResearchResult,
} from './research/provider.js';
export {
  normalizeSlidePlan, planOutline, SLIDE_LAYOUTS, CHART_TYPES, MAX_SLIDES,
  type SlidePlan, type SlideSpec, type SlideLayout, type ChartType,
} from './slides/plan.js';
export * from './help/index.js';
export * from './extensions/index.js';

export { ToolRegistry, validateToolArgs } from './tools/registry.js';
export type { Tool, ToolContext, ArgSpec, ToolArgsSchema, GoogleScope, GoogleScopeLevel } from './tools/registry.js';
export { BUILTIN_TOOLS } from './tools/builtin.js';

export { RunEngine, estimateCostJpy } from './engine/run-engine.js';
export type { AdvanceResult, RunEngineDeps } from './engine/run-engine.js';
export { validateDefinition } from './engine/validate.js';
export { enqueueJob } from './engine/enqueue.js';
export { Scheduler, SCHEDULE_SKIP_TITLE } from './scheduler/scheduler.js';
export { nextRunAt, validateRule, describeRule } from './scheduler/rule.js';
export { parseToolCalls } from './engine/tool-protocol.js';
export {
  RunNotResumableError, DefinitionInvalidError, TenantBoundaryError, ApprovalForbiddenError,
} from './engine/errors.js';

export {
  OFFICIAL_AGENTS, resolveOfficialAgent, DEFAULT_STANDARD_MINUTES, standardMinutes, stepLabel,
} from './agents/index.js';
export { Secretary } from './secretary/secretary.js';
export type { SecretaryReply, ResponseLayer } from './secretary/secretary.js';
export { DIRECT_QUERIES } from './secretary/catalog.js';
export {
  MEMORY_MAX_CHARS, memoryTextOf, refuseToRemember, refusalMessage,
} from './secretary/memory.js';
