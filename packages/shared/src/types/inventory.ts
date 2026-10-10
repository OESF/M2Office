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
  /** 販売価格と社員価格が税込か（税抜なら false）。 */
  priceTaxIncluded: boolean;
  /**
   * 社員価格（社員に売るときの値段。第29.6節）。**Web への公開には出さない**。外部のアプリ（販売管理など）には、渡すと承認したときだけ渡す。
   * 在庫の評価ではない。税込か税抜かは販売価格と同じ（`priceTaxIncluded`）。
   */
  employeePrice: number | null;
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
  /** `sales` は外部のアプリの販売の通知からの販売・返品・取り消し（第29.20.1節）。 */
  source: 'manual' | 'slip' | 'count' | 'reservation' | 'secretary' | 'import' | 'undo' | 'sales';
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

/** 予約の状態（第29.13節）。 */
export type InventoryBookingStatus = 'booked' | 'cancelled' | 'visited';

/**
 * 予約の受け口の「型」（通知の項目の対応。第29.13.1節）。値はドットでつないだ項目の道（例: `data.reservation.id`）。
 *
 * @remarks 標準の形は `id`・`startsAt`・`menu`・`status`。違う形は、初めて届いた通知から AI が推測する
 */
export interface InventoryBookingMapping {
  id: string;
  startsAt: string;
  /** 日付と時刻が別の項目のときの、時刻の項目（`startsAt` は日付の項目になる）。 */
  startTime?: string;
  menu: string;
  /** 状態の項目。無ければ空（いつも「予約」として扱う）。 */
  status: string;
  /** 取り消しを表す値（小文字でくらべる）。 */
  cancelledValues: string[];
  /** 来店済みを表す値。 */
  visitedValues: string[];
}

/** 予約の受け口。URL の鍵は持たない（作ったときに一度だけ見せる）。 */
export interface InventoryBookingSource {
  id: string;
  name: string;
  mapping: InventoryBookingMapping | null;
  status: 'active' | 'stopped';
  createdAt: string;
  lastReceivedAt: string | null;
}

/** 引き当ての 1 行（品目と数）。 */
export interface InventoryReservationLine {
  id: string;
  itemId: string;
  itemName?: string;
  unit?: string;
  qty: number;
  status: 'held' | 'used' | 'cancelled';
}

/** 予約と、その引き当て（第29.13節）。予約した人の情報は持たない。 */
export interface InventoryBooking {
  id: string;
  /** 受け口の ID か `manual`（画面・秘書）。 */
  sourceKey: string;
  sourceName?: string;
  /** 予約番号（予約のシステムの番号。手で入れたものは自動の番号）。 */
  externalId: string;
  startsAt: string | null;
  menu: string;
  status: InventoryBookingStatus;
  /** 品目に結び付いたか（メニューから品目が決まらなければ false）。 */
  mapped: boolean;
  lines: InventoryReservationLine[];
  updatedAt: string;
}

/** Web への公開に出せる項目（第29.12.1節）。名前と状態はいつも出す。 */
export type InventoryPublicField = 'category' | 'price';

/** 管理者が承認する公開の中身（第29.12節）。 */
export interface InventoryPublicationScope {
  /** 公開する品目。承認のあとに足した品目は、承認し直すまで出さない。 */
  itemIds: string[];
  fields: InventoryPublicField[];
  /** 使える数を出すか。`false` なら状態（在庫あり・残りわずか・終了）だけ。 */
  showCount: boolean;
}

/** 公開する状態。 */
export type InventoryPublicStatus = 'in' | 'low' | 'out';

/** 公開する状態の呼び方（第29.12節）。 */
export const INVENTORY_PUBLIC_STATUS_LABELS: Record<InventoryPublicStatus, string> = { in: '在庫あり', low: '残りわずか', out: '終了' };

/** 公開の 1 行。承認した項目だけが入る。 */
export interface InventoryPublicRow {
  name: string;
  category?: string;
  price?: number;
  priceTaxIncluded?: boolean;
  /** 使える数（数を出す会社だけ。0 未満は 0）。 */
  available?: number;
  unit?: string;
  status: InventoryPublicStatus;
}

/** 作り直して置いておく公開の中身。埋め込みのページと公開のデータはこれだけを返す。 */
export interface InventoryPublicSnapshot {
  generatedAt: string;
  showCount: boolean;
  items: InventoryPublicRow[];
}

/** 1 社で持てる公開のまとまりの数（第29.12.2節）。 */
export const INVENTORY_PUBLICATION_MAX = 8;

/** 公開のまとまり 1 つの状態（管理者に見せる。第29.12.2節）。承認する前（`draft`）は中身・鍵・承認した人を持たない。 */
export interface InventoryPublication {
  id: string;
  /** タブに出す名前（公開のページには出さない）。 */
  name: string;
  scope: InventoryPublicationScope | null;
  /** 承認した管理者。 */
  approvedBy: string | null;
  approvedByName?: string;
  approvedAt: string | null;
  status: 'draft' | 'live' | 'stopped';
  /** 公開の URL の鍵。最初の承認のときに作る。 */
  key: string | null;
  snapshotAt: string | null;
}

/** 外部のアプリの機能「商品の一覧を読む」で渡す範囲（管理者が承認する。第29.20.1節・第13.4.1節）。 */
export interface InventoryCatalogScope {
  itemIds: string[];
  /** 使える数を渡すか（渡さなければ状態だけ）。 */
  showCount: boolean;
  /** 販売価格を渡すか。 */
  price: boolean;
  /** 社員価格を渡すか（既定は渡さない）。 */
  employeePrice: boolean;
}

/** 照らせなかった販売の行（品目を選べば、その時点で記録する。第29.20.1節）。金額とお客様の情報は持たない。 */
export interface InventorySaleUnmatched {
  id: string;
  appId: string;
  /** 外部のアプリの名前。 */
  appName: string;
  /** 販売管理の販売番号。 */
  saleRef: string;
  /** 行で行うはずだったこと（取り置き・使用・入庫）。 */
  action: 'hold' | 'use' | 'return';
  /** 販売管理が送った品目の手がかり（M2Office の品目の ID・自社のコード・バーコード）。 */
  itemRef: string;
  code: string;
  barcode: string;
  qty: number;
  reason: string;
  createdAt: string;
}
