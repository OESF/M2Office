/**
 * @file 接続先の健全性（仕様書 第6.7.6節）。記録の受け口・置き場・状態の決め方。
 */

export { BufferedHealthSink, installHealthSink, recordHealth, type HealthSink } from './recorder.js';
export { llmHealthKind, observeLlm } from './llm.js';
export { PostgresHealthStore, type HealthBucket, type HealthStore, type HealthSummary } from './store.js';
export {
  HEALTH_ACTIVE_MIN, HEALTH_ERROR_LABELS, HEALTH_SLOW_MS, HEALTH_WINDOW_MIN, healthView, type HealthState, type HealthView,
} from './status.js';
