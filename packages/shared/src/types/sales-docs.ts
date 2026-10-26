/**
 * @file 販売の書類と受注（内蔵の拡張）の型（仕様書 第42章、ADR-0112）。
 *
 * 注文書・納品書・請求書・領収書を作り、受け取った注文書を読み込んで受注として整理する。
 * **書類を作るところまでを扱い、入金・支払い・会計は扱わない**（入金は確かめない。領収書は本人が入金を伝えたときに作る）。
 * 金額は数量と単価から決まった計算で出す（推論に計算させない）。
 */

/** 販売の書類と受注の拡張の ID（内蔵の拡張。第12.13節）。 */
export const SALES_DOCS_EXTENSION_ID = 'sales-docs';

/** 書類の種類（第42.4節）。 */
export type SalesDocKind = 'purchase_order' | 'delivery' | 'invoice' | 'receipt';

/** 種類の呼び方。 */
export const SALES_DOC_KIND_LABELS: Record<SalesDocKind, string> = {
  purchase_order: '注文書', delivery: '納品書', invoice: '請求書', receipt: '領収書',
};

/** 番号の頭文字（第42.3節。見積書の `Q-` と同じ形）。 */
export const SALES_DOC_PREFIX: Record<SalesDocKind, string> = { purchase_order: 'O', delivery: 'D', invoice: 'I', receipt: 'R' };

/**
 * 発行に本人の承認が要る種類（第42.3.1節）。作ったときは下書きで、承認で発行する。
 * 納品書は作ったら発行済み（見積書と同じ）。
 */
export const SALES_DOC_NEEDS_ISSUE: Record<SalesDocKind, boolean> = { purchase_order: true, delivery: false, invoice: true, receipt: true };

/** 書類の状態（第42.3.1節・第42.3.2節）。 */
export type SalesDocStatus = 'draft' | 'issued' | 'cancelled';

/** 状態の呼び方。 */
export const SALES_DOC_STATUS_LABELS: Record<SalesDocStatus, string> = { draft: '下書き', issued: '発行済み', cancelled: '取り消し' };

/** 取引先（宛先）。名刺・前の書類・受注から AI が埋める。 */
export interface SalesParty {
  /** 会社名（個人なら氏名） */
  name: string;
  department: string;
  person: string;
  address: string;
  phone: string;
  email: string;
}

/** 書類と受注の品目 1 行（見積書の品目と同じ形。第42.3節）。 */
export interface SalesItem {
  name: string;
  /** 品番（無ければ空） */
  code: string;
  quantity: number;
  unit: string;
  /** 単価（円）。分からなければ `null`（推測で埋めない） */
  unitPrice: number | null;
  /** 消費税率（%）。10 か 8（軽減税率）。 */
  taxRate: 10 | 8;
  /** 区分の見出し（まとめた請求書の納品書ごとの見出しなど） */
  group?: string;
  /** 値引きの額（正の数。依頼に書かれた額だけ） */
  discount?: number;
}

/** 税率ごとの小計と消費税。 */
export interface SalesTaxLine {
  rate: 10 | 8;
  base: number;
  tax: number;
}

/** 書類 1 通（1 つの版）。日付は `YYYY-MM-DD`。 */
export interface SalesDocument {
  id: string;
  kind: SalesDocKind;
  /** 番号。下書きは `null`（発行したときに付ける） */
  number: string | null;
  /** 版（訂正するたびに 1 つ増える。第42.3.2節） */
  version: number;
  /** 前の版（訂正版なら） */
  previousId: string | null;
  /** 新しい版で置き換えられたか（一覧には新しい版だけを出す） */
  superseded: boolean;
  status: SalesDocStatus;
  party: SalesParty;
  /** 件名（請求書の「〇〇の件」など） */
  subject: string;
  items: SalesItem[];
  subtotal: number;
  tax: number;
  total: number;
  taxLines: SalesTaxLine[];
  /** 取引の日（発行日。下書きは作った日） */
  issuedOn: string;
  /** 支払期限（請求書）・納期（注文書）。無ければ `null` */
  dueOn: string | null;
  /** 支払い条件・納品場所などの条件 */
  terms: string;
  notes: string;
  /** つないだ受注 */
  orderId: string | null;
  /** 納品書: 請求した請求書。領収書: 元の請求書 */
  invoiceId: string | null;
  /** 請求書: まとめた納品書 */
  deliveryIds: string[];
  /** PDF のファイル */
  fileId: string | null;
  /** 取り消しの理由 */
  cancelReason: string;
  /** 知らせ（請求済みの納品書が訂正された、など。第42.4.2節） */
  notices: string[];
  runId: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/** 受注の状態（第42.5.3節）。取り消し以外は納品書と請求書から決まる。 */
export type SalesOrderStatus = 'open' | 'partial' | 'delivered' | 'invoiced' | 'cancelled';

/** 状態の呼び方。 */
export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  open: '受注', partial: '一部納品', delivered: '納品済み', invoiced: '請求済み', cancelled: '取り消し',
};

/** 受注に付ける印（AI が確かめて合わなかったもの。第42.5.2節）。 */
export interface SalesOrderFlag {
  /** `guess` は AI が読んだもの（「いつもの」を前の注文から読んだ、など。第42.5.1.1節） */
  kind: 'calc' | 'quote' | 'unread' | 'duplicate' | 'guess';
  text: string;
}

/** 受注の入り口（`manual` は受注の画面で手で入れたもの。第42.5.1.1節）。 */
export type SalesOrderSource = 'upload' | 'secretary' | 'mail' | 'quote' | 'manual';

/** 手で入れるときの候補（取引先と、その取引先の前の品目。第42.5.1.1節）。 */
export interface SalesSuggestions {
  /** 前の受注・書類・見積書の取引先の名前 */
  parties: string[];
  /** 取引先の前の品目（多く頼まれた順）。取引先を指定しないときは会社全体 */
  items: { name: string; code: string; unit: string; unitPrice: number | null; taxRate: 10 | 8; count: number }[];
}

/** 受注 1 件（第42.5.3節）。 */
export interface SalesOrder {
  id: string;
  /** 受注番号（`S-日付-連番`） */
  number: string;
  party: SalesParty;
  /** 相手の注文番号 */
  customerRef: string;
  orderedOn: string | null;
  dueOn: string | null;
  deliverTo: string;
  terms: string;
  notes: string;
  items: SalesItem[];
  /** こちらの決まった計算の額 */
  subtotal: number;
  tax: number;
  total: number;
  /** 相手が書いた合計（読めなければ `null`） */
  statedTotal: number | null;
  status: SalesOrderStatus;
  /** 品目ごとの納めた数（納品書から求めたもの。品目の並びと同じ順） */
  delivered: number[];
  flags: SalesOrderFlag[];
  /** 取り込んだ注文書のファイル */
  sourceFileId: string | null;
  source: SalesOrderSource;
  /** つないだ見積書の番号 */
  quoteNumber: string | null;
  cancelReason: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/** 会社の設定 `salesDocs`（第42章）。 */
export interface SalesDocsSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
}

/** 既定（切り）。 */
export const DEFAULT_SALES_DOCS_SETTINGS: SalesDocsSettings = { enabled: false };

/** 書類と元の注文書を残す年数（第42.6節。法人の帳簿書類は 7 年、欠損金のある年度は 10 年のため長いほう）。 */
export const SALES_DOC_RETENTION_YEARS = 10;
