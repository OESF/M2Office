/**
 * @file 在庫管理（内蔵の拡張）の型（仕様書 第29章、ADR-0045）。
 *
 * 在庫の数は入出庫の記録の合計で決まる。数はいちばん小さい使う単位で持つ（第29.9節）。
 * 人の情報を持たない（第29.17節）。
 */

/** 在庫管理の拡張の ID（内蔵の拡張。第12.13節）。 */
export const INVENTORY_EXTENSION_ID = 'inventory';

/** 会社ごとに入り切りする機能（第29.4節）。 */
export type InventoryFeature = 'lots' | 'units' | 'publish' | 'reserve' | 'order' | 'forecast' | 'market';

/** 機能の呼び方。 */
export const INVENTORY_FEATURES: { id: InventoryFeature; label: string }[] = [
  { id: 'lots', label: 'ロットと使用期限' },
  { id: 'units', label: '単位の換算' },
  { id: 'publish', label: 'Web への公開' },
  { id: 'reserve', label: '予約との引き当て' },
  { id: 'order', label: '発注の案' },
  { id: 'forecast', label: '需要の予測（季節と行事から目安を決め直す）' },
  { id: 'market', label: '相場の比較（販売品の市場の価格を調べる）' },
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
  /**
   * JAN から商品名を引く Yahoo!ショッピングの商品検索の Client ID（第29.11.3節）。会社が Yahoo!デベロッパーネットワークで取って管理者ページで入れる。
   * 空なら運営の環境変数（`YAHOO_CLIENT_ID`）、それも無ければ使わない。画面には末尾だけを出す（`maskClientId`）。
   */
  yahooClientId?: string;
}

/** Client ID を画面に出す形（末尾 4 文字だけ。空なら空）。 */
export const maskClientId = (id: string | undefined): string => (id ? `••••${id.slice(-4)}` : '');

/** 在庫管理の既定の設定。既定は切り（第29.2節）。 */
export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  enabled: false,
  features: { lots: false, units: false, publish: false, reserve: false, order: true, forecast: true, market: true },
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

/** 発注の状態（第29.14.4節、Q-249）。 */
export type InventoryOrderStatus = 'pending' | 'ordered' | 'partial' | 'received' | 'cancelled';

/** 発注の状態の呼び方。`pending` はメールなら承認待ち、Web・電話なら発注待ち（まだ発注していない）。 */
export function inventoryOrderStatusLabel(status: InventoryOrderStatus, method: InventorySupplier['method']): string {
  if (status === 'pending') return method === 'mail' ? '承認待ち' : '発注待ち';
  return { ordered: '入荷待ち', partial: '一部入荷', received: '入荷済み', cancelled: '取り消し' }[status];
}

/** 発注の品目 1 行。数は使う単位。 */
export interface InventoryOrderLine {
  id: string;
  itemId: string;
  itemName?: string;
  unit?: string;
  packUnit?: string;
  packSize?: number | null;
  qty: number;
  /** 届いた数（入庫で消し込んだ数）。 */
  received: number;
}

/** 発注 1 件（仕入先ごと。第29.14.4節）。 */
export interface InventoryOrder {
  id: string;
  /** 発注番号（例: `PO-202610-001`）。発注書と同じ。 */
  number: string;
  supplierId: string | null;
  supplierName: string;
  method: InventorySupplier['method'];
  status: InventoryOrderStatus;
  orderedAt: string | null;
  /** 届く予定の日（YYYY-MM-DD）。 */
  dueOn: string | null;
  /** メールの発注の実行（承認と送信）。 */
  runId: string | null;
  /** 発注書の PDF（第29.14.5節）。 */
  fileId: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  closedAt: string | null;
  lines: InventoryOrderLine[];
  /** 届く予定の日を過ぎた日数（入荷待ち・一部入荷で過ぎていれば）。 */
  overdueDays?: number;
}

/** メーカーの終売の見込み（第29.24.1節、Q-248）。出典で確かめられたものだけを持つ。 */
export interface InventoryDiscontinued {
  /** `planned` 終売予定・`ended` 終売済み。 */
  status: 'planned' | 'ended';
  /** 終売の日（YYYY-MM-DD）。分からなければ `null`。 */
  date: string | null;
  /** 後継品の名前（無ければ空）。 */
  successor: string;
  /** 出典の URL（秘書に渡された文書なら空）。 */
  url: string;
  /** 出典の名前（サイトの名前、または「仕入先からの知らせ」）。 */
  source: string;
  checkedAt: string;
}

/** 終売の見込みの短い言い方（一覧の印のポップアップ・発注の案の理由）。 */
export function discontinuedText(d: InventoryDiscontinued): string {
  return `${d.status === 'ended' ? '終売済み' : '終売予定'}${d.date ? `（${d.date}）` : ''}${d.successor ? `。後継品: ${d.successor}` : ''}`;
}

/** 品目の区分（第29.6.1節、Q-242）。4 つに固定する（会社が増やさない）。 */
export type InventoryItemKind = 'sale' | 'supply' | 'material' | 'other';

/** 区分の呼び方（並びは画面の並び）。 */
export const INVENTORY_ITEM_KINDS: { id: InventoryItemKind; label: string }[] = [
  { id: 'sale', label: '販売品' },
  { id: 'supply', label: '消耗品' },
  { id: 'material', label: '原材料' },
  { id: 'other', label: 'その他' },
];

/** 区分の呼び方を引く。 */
export const inventoryKindLabel = (k: InventoryItemKind): string => INVENTORY_ITEM_KINDS.find((x) => x.id === k)?.label ?? 'その他';

/** 販売品の消費税率（%）。10 か 8（軽減税率）。 */
export type InventoryTaxRate = 10 | 8;

/** 品目（第29.6節）。 */
export interface InventoryItem {
  id: string;
  name: string;
  /** 公開の表に出す名前（空なら name）。 */
  publicName: string;
  /** 自社のコード（任意）。 */
  sku: string;
  category: string;
  /** 区分（販売品・消耗品・原材料・その他。第29.6.1節）。分類とは別に持つ。 */
  kind: InventoryItemKind;
  /** 消費税率（販売品だけが使う。第29.6.1節）。 */
  taxRate: InventoryTaxRate;
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
  /**
   * 仕入価格（使う単位 1 つあたり。第29.6.2節、Q-244）。**在庫管理の利用範囲の管理者だけ**に返す（ほかの人には API が取り除く）。
   * Web への公開・外部のアプリ・Web の調べものには渡さない。決算の在庫の評価ではない（Q-108）
   */
  purchasePrice?: number | null;
  /** 仕入価格が税込か（既定は税抜）。 */
  purchaseTaxIncluded?: boolean;
  photoFileId: string | null;
  /** 残りわずかの目安。`null` なら会社の既定（需要の予測があればその目安）。会社が決めた値は「固定」として予測で変えない（第29.14節）。 */
  lowThreshold: number | null;
  /**
   * 需要の予測（第29.14節、Q-116）。週に 1 回、ワーカーが決め直す。`low` は予測の目安（会社が目安を決めていない品目に効く）、
   * `factor` は次の 4 週の使う速さの倍率（0.5〜3）、`note` は理由（1 行）。予測していなければ無い
   */
  forecast?: {
    low: number | null; factor: number; note: string; at: string;
    /** 曜日の重み（日曜はじまりの 7 つ。営業日でない曜日は 0。第29.14.3節）。記録の足りない品目は無い（平らに数える）。 */
    weekdays?: number[] | null;
  } | null;
  /** メーカーの終売の見込み（第29.24.1節）。見込みが無ければ `null`。 */
  discontinued?: InventoryDiscontinued | null;
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

/** 出庫の用途（第29.9.1節、Q-247）。4 つに固定する（会社が増やさない）。 */
export type InventoryOutPurpose = 'sale' | 'internal' | 'disposal' | 'other';

/** 用途の呼び方（並びは画面の並び）。 */
export const INVENTORY_OUT_PURPOSES: { id: InventoryOutPurpose; label: string }[] = [
  { id: 'sale', label: '販売' },
  { id: 'internal', label: '社内消費' },
  { id: 'disposal', label: '廃棄' },
  { id: 'other', label: 'その他' },
];

/** 用途の呼び方を引く。用途の無い記録（第 0.407.0 版より前のもの）は空。 */
export const inventoryPurposeLabel = (p: InventoryOutPurpose | null | undefined): string => INVENTORY_OUT_PURPOSES.find((x) => x.id === p)?.label ?? '';

/**
 * 品目の出庫の用途の既定（第29.9.1節）。その品目で前に選んだ用途、無ければ区分が販売品なら販売、ほかは社内消費。
 *
 * @param last その品目の最後の出庫の用途（無ければ `null`）
 */
export function defaultOutPurpose(item: Pick<InventoryItemView, 'kind'>, last?: InventoryOutPurpose | null): InventoryOutPurpose {
  return last ?? (item.kind === 'sale' ? 'sale' : 'internal');
}

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
  /** 出庫の用途（第29.9.1節）。出庫のほかと、第 0.407.0 版より前の出庫は `null`。 */
  purpose?: InventoryOutPurpose | null;
  /** `sales` は外部のアプリの販売の通知からの販売・返品・取り消し（第29.20.1節）。 */
  source: 'manual' | 'slip' | 'count' | 'reservation' | 'secretary' | 'import' | 'undo' | 'sales' | 'app';
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
  /** 出庫の用途の既定（その品目で前に選んだ用途。無ければ区分から。第29.9.1節）。 */
  outPurpose?: InventoryOutPurpose;
  /** 入荷待ちの数（発注して、まだ届いていない数。第29.14.4節）と、いちばん早い届く予定の日。 */
  onOrder?: number;
  onOrderDue?: string | null;
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

/**
 * 区分と分類で品目を選ぶ条件（第29.12.3節、Q-245）。Web への公開と外部のアプリの「商品の一覧を読む」で使う。
 *
 * 条件は選び方を覚えるだけで、出す・渡すのは承認した `itemIds` だけ。あとで条件に当たる品目を足すと、
 * 画面では選んだ状態で並ぶが、承認し直すまで出さない（社外への送信の境界。第9.4.0節）。
 */
export interface InventoryItemRule {
  /** 区分（空なら区分では絞らない）。 */
  kinds: InventoryItemKind[];
  /** 分類（空なら分類では絞らない）。区分と両方あれば「かつ」。 */
  categories: string[];
  /** 条件に当たっても 1 つずつ外した品目。 */
  excluded: string[];
}

/** 品目が条件に当たるか（外した品目かどうかは見ない）。 */
export function inventoryRuleMatches(rule: Pick<InventoryItemRule, 'kinds' | 'categories'>, item: Pick<InventoryItemView, 'kind' | 'category'>): boolean {
  return (rule.kinds.length === 0 || rule.kinds.includes(item.kind))
    && (rule.categories.length === 0 || rule.categories.includes(item.category));
}

/**
 * 条件から選ぶ品目を出す（当たる品目から、外した品目を除く）。
 *
 * @param items 使っている品目（止めた品目を除いたもの）
 */
export function inventoryRuleItemIds(rule: InventoryItemRule, items: Pick<InventoryItemView, 'id' | 'kind' | 'category'>[]): string[] {
  const excluded = new Set(rule.excluded);
  return items.filter((i) => inventoryRuleMatches(rule, i) && !excluded.has(i.id)).map((i) => i.id);
}

/**
 * 受け取った条件を整える（知らない区分・空の分類を捨てる）。区分も分類も無ければ `null`（条件なし）。
 *
 * @remarks API の本文を読むときに使う。品目が止められたかどうかは見ない（承認のときに `itemIds` の側で除く）
 */
export function inventoryRuleOf(v: unknown): InventoryItemRule | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const known = new Set(INVENTORY_ITEM_KINDS.map((k) => k.id));
  const strs = (x: unknown, max: number) => (Array.isArray(x) ? [...new Set(x.filter((y): y is string => typeof y === 'string' && y.trim() !== ''))].slice(0, max) : []);
  const kinds = strs(b['kinds'], 4).filter((k): k is InventoryItemKind => known.has(k as InventoryItemKind));
  const categories = strs(b['categories'], 200);
  if (kinds.length === 0 && categories.length === 0) return null;
  return { kinds, categories, excluded: strs(b['excluded'], 5000) };
}

/** 管理者が承認する公開の中身（第29.12節）。 */
export interface InventoryPublicationScope {
  /** 公開する品目。承認のあとに足した品目は、承認し直すまで出さない。 */
  itemIds: string[];
  fields: InventoryPublicField[];
  /** 使える数を出すか。`false` なら状態（在庫あり・残りわずか・終了）だけ。 */
  showCount: boolean;
  /** 区分と分類で選んだときの条件（第29.12.3節）。1 つずつ選んだときは無い。 */
  rule?: InventoryItemRule | null;
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
  /** 区分と分類で選んだときの条件（第29.12.3節）。1 つずつ選んだときは無い。 */
  rule?: InventoryItemRule | null;
}

/** 照らせなかった販売の行（品目を選べば、その時点で記録する。第29.20.1節）。金額とお客様の情報は持たない。 */
export interface InventorySaleUnmatched {
  id: string;
  appId: string;
  /** 外部のアプリの名前。 */
  appName: string;
  /** 販売管理の販売番号（入庫の通知なら入荷の番号）。 */
  saleRef: string;
  /** 行で行うはずだったこと（取り置き・使用・返品の入庫・入荷の入庫）。 */
  action: 'hold' | 'use' | 'return' | 'receive';
  /** 販売管理が送った品目の手がかり（M2Office の品目の ID・自社のコード・バーコード）。 */
  itemRef: string;
  code: string;
  barcode: string;
  qty: number;
  reason: string;
  createdAt: string;
}

/** 販売品の在庫額（売価で見た目安。第29.6.1節）。在庫の評価（Q-108）ではない。 */
export interface InventorySaleValue {
  /** 税込の合計（円）。 */
  withTax: number;
  /** 税抜の合計（円）。 */
  withoutTax: number;
  /** 数えた販売品の数。 */
  counted: number;
  /** 販売価格が無いため数えなかった販売品の数。 */
  noPrice: number;
}

/**
 * 販売品の在庫額を出す（品目ごとに「在庫 − 期限切れ」× 販売価格。税込と税抜は品目の消費税率で直し、端数は税率ごとの合計で 1 回処理する）。
 *
 * @param items 数える品目（区分が販売品でないもの・止めた品目は数えない）
 * @param rounding 会社の端数の扱い
 * @remarks 販売価格の無い品目は推測で埋めず、`noPrice` に数える
 */
export function inventorySaleValue(items: InventoryItemView[], rounding: 'floor' | 'round' | 'ceil' = 'floor'): InventorySaleValue {
  const r = rounding === 'ceil' ? Math.ceil : rounding === 'round' ? Math.round : Math.floor;
  const sums = new Map<string, number>();
  let counted = 0;
  let noPrice = 0;
  for (const i of items) {
    if (i.kind !== 'sale' || i.status !== 'active') continue;
    if (i.price === null) { noPrice++; continue; }
    counted++;
    const qty = Math.max(0, i.onHand - i.expired);
    const key = `${i.taxRate}:${i.priceTaxIncluded ? 'in' : 'ex'}`;
    sums.set(key, (sums.get(key) ?? 0) + i.price * qty);
  }
  let withTax = 0;
  let withoutTax = 0;
  for (const [key, amount] of sums) {
    const [rate, mode] = key.split(':') as [string, 'in' | 'ex'];
    const t = Number(rate);
    const total = Math.round(amount);
    if (mode === 'in') {
      const tax = r((total * t) / (100 + t));
      withTax += total; withoutTax += total - tax;
    } else {
      const tax = r((total * t) / 100);
      withoutTax += total; withTax += total + tax;
    }
  }
  return { withTax, withoutTax, counted, noPrice };
}

/** 品目ごとの減り具合と次の見込み（第29.14.1節、Q-243）。 */
export interface InventoryUsageRow {
  itemId: string;
  name: string;
  kind: InventoryItemKind;
  category: string;
  unit: string;
  /** 直近 4 週の 1 日あたりの使用（販売品は売れた数）。 */
  daily: number;
  /** その前の 4 週の 1 日あたりの使用。 */
  prevDaily: number;
  /** 前の 4 週と比べた増減（%）。前の 4 週に使っていなければ `null`。 */
  changePct: number | null;
  /** あと何日で無くなるか（使っていなければ `null`）。 */
  daysLeft: number | null;
  /** 次の 4 週の見込み（1 日の使用 × 予測の倍率 × 28 日）。 */
  next4w: number;
  /** 需要の予測の倍率（予測が無ければ 1）と理由。 */
  factor: number;
  note: string;
  /** この先 4 週の予約の取り置き（次の 4 週の見込みに含む。第29.14.2節）。 */
  booked?: number;
  /** 曜日の重み（日曜はじまりの 7 つ。第29.14.3節）と短い言い方（例: 「土日に多い」）。記録の足りない品目は無い。 */
  weekdays?: number[] | null;
  weekdayNote?: string;
}

/** 週ごとの使用（品目の詳細のグラフ。第29.14.1節）。 */
export interface InventoryWeeklyUsage {
  /** 週の始まり（月曜。日本時間の `YYYY-MM-DD`）。 */
  week: string;
  qty: number;
}

/** 相場の出典 1 つ（第29.24節）。価格は比べやすいよう税込にそろえたもの。 */
export interface InventoryMarketSource {
  /** 店・サイトの名前。 */
  shop: string;
  url: string;
  /** 税込にそろえた価格（円）。 */
  price: number;
  /** 出典に書かれていた価格と、税込だったか。 */
  listed: number;
  taxIncluded: boolean;
  /** Web の検索か、競合の分析のサイトの事実か。 */
  from: 'web' | 'competitor';
  /** 入り数（仕入れの相場で、ケースなどの価格を 1 つあたりに割ったとき。第29.6.2節）。 */
  pack?: number;
}

/** 販売品の相場を調べた結果（第29.24節、Q-243）。 */
export interface InventoryMarketCheck {
  id: string;
  itemId: string;
  /** この調べもので新しく終売の見込みが付いたか（知らせに使う。残さない。第29.24.1節）。 */
  discontinuedNew?: boolean;
  /**
   * 販売価格の相場（`sale`）か、仕入れの相場（`purchase`。第29.6.2節）か。仕入れの相場は自社の仕入価格を含むため、
   * 在庫管理の利用範囲の管理者にだけ返す
   */
  kind?: 'sale' | 'purchase';
  checkedAt: string;
  /** found（見つかった）・none（同じ商品と確かめられる価格が無かった）・unavailable（調べられなかった） */
  status: 'found' | 'none' | 'unavailable';
  /** 自社の販売価格（税込にそろえたもの）。 */
  ourPrice: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  offers: number;
  /** 自社の価格の、相場の中央値との差（%）。 */
  diffPct: number | null;
  /** 位置（安め・相場並み・高め。中央値から ±10% の内を相場並み）。 */
  position: 'low' | 'fair' | 'high' | null;
  /** ひとこと（数から決まった言い方で作る）。調べられなかったときは理由。 */
  comment: string;
  sources: InventoryMarketSource[];
  /** 調べた人の ID か、月の見回りなら `watch`。 */
  checkedBy: string;
}

/** 位置の呼び方。 */
export const INVENTORY_MARKET_POSITION_LABEL: Record<'low' | 'fair' | 'high', string> = { low: '安め', fair: '相場並み', high: '高め' };
/** 仕入れの相場の位置の呼び方（第29.6.2節）。 */
export const INVENTORY_PURCHASE_POSITION_LABEL: Record<'low' | 'fair' | 'high', string> = { low: '安く仕入れている', fair: '相場並み', high: '高く仕入れている' };

/** 品目の利益と利益率（第29.6.2節）。どちらも品目の消費税率で税抜にそろえる。 */
export interface InventoryMargin {
  /** 1 つあたりの利益（税抜。円）。 */
  profit: number;
  /** 利益率（%。小数第 1 位まで）。 */
  rate: number;
}

/** 税抜にそろえる。 */
const exTax = (price: number, included: boolean, rate: number) => (included ? (price * 100) / (100 + rate) : price);

/**
 * 利益と利益率を出す（販売価格 − 仕入価格。利益 ÷ 販売価格）。販売価格か仕入価格が無ければ `null`（推測しない）。
 */
export function inventoryMargin(i: Pick<InventoryItem, 'price' | 'priceTaxIncluded' | 'purchasePrice' | 'purchaseTaxIncluded' | 'taxRate'>): InventoryMargin | null {
  if (i.price === null || i.price <= 0 || i.purchasePrice === null || i.purchasePrice === undefined) return null;
  const sale = exTax(i.price, i.priceTaxIncluded, i.taxRate);
  const cost = exTax(i.purchasePrice, !!i.purchaseTaxIncluded, i.taxRate);
  const profit = Math.round(sale - cost);
  return { profit, rate: Math.round(((sale - cost) / sale) * 1000) / 10 };
}

/** 在庫額（仕入価格。税抜の目安。第29.6.2節）。仕入価格が無ければ `null`。 */
export function inventoryCostValue(i: Pick<InventoryItemView, 'purchasePrice' | 'purchaseTaxIncluded' | 'taxRate' | 'onHand' | 'expired'>): number | null {
  if (i.purchasePrice === null || i.purchasePrice === undefined) return null;
  return Math.round(exTax(i.purchasePrice, !!i.purchaseTaxIncluded, i.taxRate) * Math.max(0, i.onHand - i.expired));
}

/** 在庫管理の API の答えから、仕入価格の項目を取り除く（利用範囲の管理者でない人に返すとき。第29.6.2節）。 */
export function withoutPurchase<T>(v: T): T {
  if (Array.isArray(v)) return v.map(withoutPurchase) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'purchasePrice' && k !== 'purchaseTaxIncluded') out[k] = withoutPurchase(x);
    return out as T;
  }
  return v;
}

