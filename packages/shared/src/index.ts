/**
 * `@m2office/shared` の公開窓口。
 *
 * 画面・API・ワーカーが共通で参照する型と定数のみを置く。
 * 実装（ドメインロジック）は `@m2office/core` に置き、ここには含めない。
 */
export * from './types/agent.js';
export * from './types/run.js';
export * from './types/tenant.js';
export * from './types/audit.js';
export * from './types/schedule.js';
export * from './types/approval.js';
export * from './types/settings.js';
