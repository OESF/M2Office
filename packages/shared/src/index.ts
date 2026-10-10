/**
 * @file `@m2office/shared` の公開窓口。画面・API・ワーカーが共通で使う型と定数を書き出す。
 *
 * 実装（ドメインロジック）は `@m2office/core` に置き、ここには含めない。
 *
 * @see 仕様書 第20.5節 リポジトリ構成
 */

export * from './types/agent.js';
export * from './types/run.js';
export * from './types/tenant.js';
export * from './types/audit.js';
export * from './types/schedule.js';
export * from './types/approval.js';
export * from './types/settings.js';
export * from './types/access.js';
export * from './types/cards.js';
export * from './types/notice.js';
export * from './types/inventory.js';
export * from './types/apps.js';
export * from './types/hr.js';
export * from './types/signage.js';
export * from './types/web-columns.js';
export * from './types/inquiries.js';
export * from './types/competitors.js';
export * from './types/announcements.js';
export * from './types/contracts.js';
export * from './types/reservations.js';
export * from './types/subsidies.js';
export * from './types/print-designs.js';
export * from './types/members.js';
export * from './types/web-review.js';
export * from './text/internal-ids.js';
export * from './text/paths.js';
export * from './text/agent-name.js';
