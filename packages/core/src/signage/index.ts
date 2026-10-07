/**
 * @file 店頭サイネージ（内蔵の拡張）の公開窓口（仕様書 第31章）。
 */

export { SIGNAGE_PACKAGE, SIGNAGE_EXTENSION_VERSION } from './package.js';
export { PostgresSignageStore, type SignageStore, type ScreenRecord, type PairingRecord, type StockNotice } from './store.js';
export {
  SignageService, signageAccess, hashSecret, assetKey, jstSlot, usualSlot, cleanReport, SECRET_FORMAT, isPlaceholderAssetName, cleanAiAssetName,
  type SignageServiceDeps, type AssetUpload, type PlayAsset,
} from './service.js';
export { readMp4, type Mp4Info, type ReadAt } from './mp4.js';
export { imageSize } from './image-size.js';
export { thumbnailMime, thumbnailPng } from './thumbnail.js';
export { externalRefs } from './service.js';
export {
  SignageInterrupts, normalizeText, fillTemplate, leadingNumber, phraseTemplate, valueSkeleton, pickPath, soundMime,
  type SignageInterruptsDeps, type InterruptError,
} from './interrupts.js';
export { type TargetRecord, type InterruptRecord } from './store.js';
export { applyStockChanges, sweepStockNotices, stockCardText, STOCK_BACK_DAYS, STOCK_NOTICE_MAX } from './stock.js';
