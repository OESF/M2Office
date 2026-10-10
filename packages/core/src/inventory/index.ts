/**
 * @file 在庫管理（内蔵の拡張）の入口。置き場・バーコードの読み方・処理・ツール・付属の業務をまとめて出す。
 *
 * @see 仕様書 第29章 在庫管理
 */

export { PostgresInventoryStore, MemoryInventoryStore } from './store.js';
export type { InventoryStore, PublicationRecord, ItemRecord, NewMove, StockRecord, LotRecord, MoveQuery, CountEntry, CountLineRecord, BookingRecord, ReservationRecord, MenuItemRecord, BookingQuery } from './store.js';
export { parseCode, gs1Date, validGtin, type ParsedCode } from './gs1.js';
export {
  InventoryService, inventoryAccess, formatQty, toNumber, toDate, splitUnit, UNIT_IS_NAME, MOVE_KIND_LABELS, DEFAULT_WAREHOUSE, IMPORT_MAX_ROWS,
} from './service.js';
export type { InventoryServiceDeps, SlipResult, CreateItemResult, ItemInput, MoveInput, MoveResult, ItemDetail, ImportResult, ImportField } from './service.js';
export { INVENTORY_TOOLS, type InventoryToolContext } from './tools.js';
export { INVENTORY_AGENTS, INVENTORY_RECORD, INVENTORY_SLIP, INVENTORY_ORDER, INVENTORY_PACKAGE, INVENTORY_EXTENSION_VERSION } from './agents.js';
export { renderShelfLabels, shelfUrl, shelfKeyOf, MOBILE_INVENTORY_PATH } from './labels.js';
export { forecastItem, sortForecast, USAGE_DAYS, COVER_DAYS, EXPIRY_NOTICE_DAYS } from './forecast.js';
export type { ForecastRow, OrderProposal, ExpiringLot } from './forecast.js';
export { InventoryWatch, proposalLine, statusLine, type InventoryWatchDeps } from './watch.js';
export { readSlip, parseSlipReading, matchLine, SLIP_PROMPT, type SlipLine, type SlipReading } from './slip.js';
export {
  InventoryBookings, STANDARD_BOOKING_MAPPING, BOOKING_PAYLOAD_MAX_BYTES, hookHash, menuKey, pick, toInstant, toBookingEvent, skeleton,
  type InventoryBookingsDeps, type BookingEvent, type IngestResult,
} from './bookings.js';
export { InventoryPublisher, buildPublicSnapshot, renderPublicPage, stockChanges, PUBLICATION_KEY, type InventoryPublisherDeps, type PublicationView, type StockChange, type StockChangeListener } from './publication.js';
export { JanLookupService, JAN_CACHE_MS, type JanLookup, type JanLookupDeps } from './jan.js';
export {
  InventorySales, PostgresSalesStore, MemorySalesStore, parseSaleEvent, parseReceiptEvent, catalogScopeOf, SALES_PAYLOAD_MAX_BYTES, SALES_LINES_MAX,
  type SalesStore, type SaleRecord, type ReceiptRecord, type UnmatchedRecord, type ReceiptEventInput, type ReceiptEventResult, type ReceiptLineResult, type SalesItem, type SalesItemList, type SalesItemQuery, type SaleEventInput,
  type SaleEventResult, type SaleLineResult, type HookResponse, type InventorySalesDeps,
} from './sales.js';
