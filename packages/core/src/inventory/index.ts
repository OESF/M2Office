/**
 * @file 在庫管理（内蔵の拡張）の入口。置き場・バーコードの読み方・処理・道具・付属の業務をまとめて出す。
 *
 * @see 仕様書 第29章 在庫管理
 */

export { PostgresInventoryStore, MemoryInventoryStore } from './store.js';
export type { InventoryStore, ItemRecord, NewMove, StockRecord, LotRecord, MoveQuery } from './store.js';
export { parseCode, gs1Date, validGtin, type ParsedCode } from './gs1.js';
export {
  InventoryService, inventoryAccess, formatQty, toNumber, toDate, splitUnit, UNIT_IS_NAME, MOVE_KIND_LABELS, DEFAULT_WAREHOUSE, IMPORT_MAX_ROWS,
} from './service.js';
export type { InventoryServiceDeps, CreateItemResult, ItemInput, MoveInput, MoveResult, ItemDetail, ImportResult, ImportField } from './service.js';
export { INVENTORY_TOOLS, type InventoryToolContext } from './tools.js';
export { INVENTORY_AGENTS, INVENTORY_RECORD, INVENTORY_PACKAGE, INVENTORY_EXTENSION_VERSION } from './agents.js';
