/**
 * @file 店頭サイネージ（内蔵の拡張）の型（仕様書 第31章、ADR-0051）。
 *
 * 画面（端末 1 台に 1 画面・1 社 3 台まで）・素材（画像・動画）・流れ（画面ごとの素材の並び）を持つ。段 1 の範囲。
 * 料金は取らない標準の機能で、会社ごとに入り切りする（既定は切り。第31.2節）。
 */

/** 店頭サイネージの拡張の ID（内蔵の拡張。第12.13節）。 */
export const SIGNAGE_EXTENSION_ID = 'signage';

/** 1 社で登録できる画面の数（全社共通の決まり。第31.4節）。 */
export const SIGNAGE_MAX_SCREENS = 3;

/** 1 社の素材の合計の上限（バイト。案 2 GB。第31.4節・Q-141）。 */
export const SIGNAGE_STORAGE_LIMIT = 2 * 1024 * 1024 * 1024;

/** 素材の大きさの上限（第31.6.1節）。画像は縮めた後、動画はそのまま。 */
export const SIGNAGE_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  /** 動画の長さの上限（ミリ秒。案 10 分）。 */
  videoMs: 10 * 60 * 1000,
  thumbnailBytes: 100 * 1024,
  /** 画面ごとの流れの行の数。 */
  entries: 100,
  /** 画像を出す秒数の範囲。 */
  minSeconds: 3,
  maxSeconds: 120,
} as const;

/** 会社のサイネージの設定（第31.4節・第31.15.1節）。段 1 は入り切り・画像の秒数・店の色。 */
export interface SignageSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** 画像を出す秒数の既定（3〜120）。 */
  imageSeconds: number;
  /** 店の色（`#RRGGBB`）。`null` なら濃い青。 */
  color: string | null;
}

/** サイネージの既定の設定。 */
export const DEFAULT_SIGNAGE_SETTINGS: SignageSettings = { enabled: false, imageSeconds: 10, color: null };

/** 店の色が無いときの色（濃い青。第31.4節）。 */
export const SIGNAGE_DEFAULT_COLOR = '#1f3a5f';

/** 画面の向き。 */
export type SignageOrientation = 'landscape' | 'portrait';

/** 画面を回す角度。 */
export type SignageRotation = 0 | 90 | 180 | 270;

/** 画面の生きている知らせ（第31.5.1節）。割り込みの文を入れない。 */
export interface SignageReport {
  /** いま出している素材の ID（無ければ `null`）。 */
  current: string | null;
  flowVersion: number;
  /** 取り置けた素材の数。 */
  cached: number;
  /** 取り置けなかった素材の ID。 */
  uncached: string[];
  /** 流せなかった素材の ID。 */
  failed: string[];
  /** ページの版。 */
  pageVersion: string;
  /** 端末の画面の縦横（回す前）。 */
  viewport: { width: number; height: number };
  /** 取り置きの場所の空き（バイト。分からなければ `null`）。 */
  storageFree: number | null;
}

/** 画面（第31.15.1節）。鍵のハッシュは画面に出さない。 */
export interface SignageScreen {
  id: string;
  name: string;
  orientation: SignageOrientation;
  rotation: SignageRotation;
  flowVersion: number;
  lastSeenAt: string | null;
  lastReport: SignageReport | null;
  /** 最後の知らせから 3 分以内か。 */
  online: boolean;
  registeredAt: string;
}

/** 素材の種類（段 1 は画像と動画）。 */
export type SignageAssetKind = 'image' | 'video';

/** 素材（第31.6.1節）。 */
export interface SignageAsset {
  id: string;
  kind: SignageAssetKind;
  name: string;
  mime: 'image/jpeg' | 'image/png' | 'video/mp4';
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  /** 動画の長さ（ミリ秒）。画像は `null`。 */
  durationMs: number | null;
  hasThumbnail: boolean;
  createdAt: string;
}

/** 流れの 1 行（第31.6.2節）。 */
export interface SignageEntry {
  assetId: string;
  /** 画像の秒数（`null` なら会社の既定。動画は `null`）。 */
  seconds: number | null;
}
