/**
 * @file 在庫管理（内蔵の拡張）の型（仕様書 第29章、ADR-0045）。
 *
 * 在庫の数は入出庫の記録の合計で決まる。数はいちばん小さい使う単位で持つ（第29.9節）。
 * 人の情報を持たない（第29.17節）。
 */

/** 在庫管理の拡張の ID（内蔵の拡張。第12.13節）。 */
export const INVENTORY_EXTENSION_ID = 'inventory';

/** 会社ごとに入り切りする機能（第29.4節）。 */
export type InventoryFeature = 'lots' | 'units' | 'publish' | 'reserve' | 'order';

/** 機能の呼び方。 */
export const INVENTORY_FEATURES: { id: InventoryFeature; label: string }[] = [
  { id: 'lots', label: 'ロットと使用期限' },
  { id: 'units', label: '単位の換算' },
  { id: 'publish', label: 'Web への公開' },
  { id: 'reserve', label: '予約との引き当て' },
  { id: 'order', label: '発注の案' },
];

/** 会社の在庫管理の設定（第29.4.1節）。導入のときに会社が決める。 */
export interface InventorySettings {
  /** 在庫管理を使うか（既定は切り）。 */
  enabled: boolean;
  features: Record<InventoryFeature, boolean>;
  /** 残りわずかの目安の既定の数（品目ごとに変えられる）。 */
  lowDefault: number;
  /** 仕入れにかかる日数の既定（仕入先・品目に無いとき）。 */
  leadDaysDefault: number;
  /** 棚卸しの頻度（日）。`null` なら知らせない。 */
  countEveryDays: number | null;
  /** 在庫の正を M2Office にするか（ほかのソフトとのつなぎは Phase 2）。 */
  stockOfRecord: 'm2office' | 'other';
}

/** 在庫管理の既定の設定。既定は切り（第29.2節）。 */
export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  enabled: false,
  features: { lots: false, units: false, publish: false, reserve: false, order: true },
  lowDefault: 3,
  leadDaysDefault: 7,
  countEveryDays: null,
  stockOfRecord: 'm2office',
};

/** 仕入先（第29.4.1節）。 */
export interface InventorySupplier {
  id: string;
  name: string;
  /** 発注の方法。 */
  method: 'mail' | 'web' | 'phone';
  /** メールの宛先・発注の画面の URL・電話番号。 */
  contact: string;
  /** 仕入れにかかる日数。`null` なら会社の既定。 */
  leadDays: number | null;
  note: string;
  status: 'active' | 'stopped';
}

/** 品目（第29.6節）。 */
export interface InventoryItem {
  id: string;
  name: string;
  /** 公開の表に出す名前（空なら name）。 */
  publicName: string;
  /** 自社のコード（任意）。 */
  sku: string;
  category: string;
  /** いちばん小さい使う単位（例: 個・回）。在庫はこの単位で持つ。 */
  unit: string;
  /** 仕入れの単位（例: 箱）。単位の換算を使わないなら空。 */
  packUnit: string;
  /** 入り数（仕入れの単位 1 つが、使う単位でいくつか）。`null` なら換算しない。 */
  packSize: number | null;
  /** 公開の表に出す販売価格（在庫の評価ではない）。 */
  price: number | null;
  priceTaxIncluded: boolean;
  photoFileId: string | null;
  /** 残りわずかの目安。`null` なら会社の既定。 */
  lowThreshold: number | null;
  supplierId: string | null;
  /** 仕入れにかかる日数。`null` なら仕入先か会社の既定。 */
  leadDays: number | null;
  note: string;
  status: 'active' | 'stopped';
  /** バーコード（JAN・GS1 の商品コードなど）。 */
  codes: string[];
  updatedAt: string;
}

/** 場所（倉庫とその中の棚。第29.7節）。 */
export interface InventoryLocation {
  id: string;
  warehouse: string;
  /** 棚。空なら倉庫そのもの。 */
  shelf: string;
  /** 棚のラベルの QR に入れる値。 */
  labelKey: string;
}

/** 入出庫の種類（第29.9節）。 */
export type InventoryMoveKind = 'in' | 'out' | 'transfer' | 'adjust';

/** 入出庫の記録。追記のみ。 */
export interface InventoryMove {
  id: string;
  kind: InventoryMoveKind;
  itemId: string;
  itemName?: string;
  lotId: string | null;
  lot?: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  /** 増減の量（使う単位）。移動は動かした量（正）。 */
  delta: number;
  reason: string;
  source: 'manual' | 'slip' | 'count' | 'reservation' | 'secretary' | 'import' | 'undo';
  reversalOf: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
}

/** 場所とロットごとのいまの数。 */
export interface InventoryStockRow {
  locationId: string;
  lotId: string | null;
  lot: string | null;
  expiresOn: string | null;
  qty: number;
}

/** 一覧に出す品目（数と印つき）。 */
export interface InventoryItemView extends InventoryItem {
  /** 在庫（帳簿の数）。 */
  onHand: number;
  /** 引き当て（予約で取り置いた数）。 */
  reserved: number;
  /** 使用期限を過ぎた数。 */
  expired: number;
  /** 使える数（在庫 − 引き当て − 期限切れ）。 */
  available: number;
  /** 残りわずか（使える数が目安以下）。 */
  low: boolean;
  /** 残っているロットのうち、いちばん近い使用期限。 */
  nearestExpiry: string | null;
}

/** 棚卸しの対象（第29.10節）。 */
export type InventoryCountScope = 'all' | 'location' | 'category';

/** 棚卸し。会社で同時に開くのは 1 つ。 */
export interface InventoryCount {
  id: string;
  scope: InventoryCountScope;
  /** 対象の場所の ID か分類の名前（全体なら空）。 */
  scopeValue: string;
  status: 'open' | 'closed' | 'cancelled';
  startedBy: string;
  startedByName?: string;
  startedAt: string;
  closedBy: string | null;
  closedAt: string | null;
}

/** 棚卸しの 1 行（品目・場所・ロットごと）。数えていない行は `counted` が `null`。 */
export interface InventoryCountRow {
  itemId: string;
  itemName: string;
  unit: string;
  packUnit: string;
  packSize: number | null;
  locationId: string;
  lotId: string | null;
  lot: string | null;
  expiresOn: string | null;
  /** 数えた数（使う単位）。数えていなければ `null`。 */
  counted: number | null;
  /** 数えた時点の帳簿の数（数えていなければ、いまの帳簿の数）。 */
  book: number;
  /** 差（数えた数 − 帳簿の数）。数えていなければ `null`。 */
  diff: number | null;
}

/** 棚卸しの姿（差の大きい順の行と件数）。 */
export interface InventoryCountView {
  count: InventoryCount;
  rows: InventoryCountRow[];
  /** 数えた行の数。 */
  counted: number;
  /** 帳簿にあって、まだ数えていない行の数。確定しても 0 にしない。 */
  uncounted: number;
  /** 差のある行の数。 */
  differing: number;
}
