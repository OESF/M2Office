/**
 * @file 店頭サイネージ（内蔵の拡張）の公開窓口（仕様書 第31章）。
 */

export { SIGNAGE_PACKAGE, SIGNAGE_EXTENSION_VERSION } from './package.js';
export { PostgresSignageStore, type SignageStore, type ScreenRecord, type PairingRecord } from './store.js';
export {
  SignageService, signageAccess, hashSecret, assetKey, jstSlot, usualSlot, cleanReport, SECRET_FORMAT,
  type SignageServiceDeps, type AssetUpload, type PlayAsset,
} from './service.js';
export { readMp4, type Mp4Info, type ReadAt } from './mp4.js';
export { imageSize } from './image-size.js';
