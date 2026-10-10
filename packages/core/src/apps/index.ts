/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）の入口。置き場とアプリの扱い・確かめを出す。
 */

export { PostgresAppStore, MemoryAppStore, type AppStore, type AppRecord, type AppEventRecord } from './store.js';
export {
  ExternalApps, appFunctionFor, appKeyHash, APP_KEY_PREFIX, APP_KEY_PATTERN, APP_RATE_PER_MINUTE, type ExternalAppsDeps, type ClaimResult,
} from './service.js';
