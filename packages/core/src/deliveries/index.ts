/**
 * @file 外部のアプリからの配信の依頼（仕様書 第13.4.4節、Q-254）の入口。
 */

export {
  PostgresDeliveryStore, MemoryDeliveryStore, type DeliveryStore, type DeliveryRecord, type RecipientRecord, type RecipientResult, type RecipientCounts, type StopRecord,
} from './store.js';
export {
  DeliveryService, renderTemplate, unsubscribeAddress, stopRecipientOf, bouncedRecipientOf, isStopReply, isBounce, placeholdersOf, emailHash,
  type DeliveryDeps, type DeliveryAcceptResult,
} from './service.js';
export { DELIVERY_SEND, DELIVERY_SEND_AGENT_ID } from './agents.js';
export { deliveriesSend, DELIVERY_TOOLS, type DeliveryToolContext } from './tools.js';
