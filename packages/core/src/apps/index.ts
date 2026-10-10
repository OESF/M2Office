/**
 * @file 外部のアプリ（仕様書 第13.4.1節・第13.4.2節、ADR-0090）の入口。置き場とアプリの扱い・確かめと、アカウントの結び付け・ナレッジの検索を出す。
 */

export {
  PostgresAppStore, MemoryAppStore, type AppStore, type AppRecord, type AppEventRecord, type AppRefKind, type BindingRecord, type LinkRequestRecord,
} from './store.js';
export {
  AppLinks, BINDING_ID_PATTERN, LINK_CODE_MAX_ATTEMPTS, LINK_CODE_TTL_MS, LINK_REQUESTS_PER_HOUR, type AppLinksDeps, type LinkingApp,
} from './links.js';
export {
  AppKnowledgeSearch, KNOWLEDGE_QUESTION_MAX, KNOWLEDGE_SEARCH_PER_MINUTE, type AppKnowledgeAnswer, type AppKnowledgeSearchDeps, type AppKnowledgeSource,
} from './knowledge.js';
export {
  ExternalApps, appFunctionFor, appKeyHash, APP_KEY_PREFIX, APP_KEY_PATTERN, APP_RATE_PER_MINUTE, type ExternalAppsDeps, type ClaimResult,
} from './service.js';
