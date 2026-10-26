/**
 * @file 販売の書類と受注の処理（仕様書 第42章、ADR-0112）。書類を作る・発行する・訂正する・取り消す・探す、受注を取り込む・直す・取り消す。
 * 見積書も書類の 1 つとして持ち、再見積（同じ番号の新しい版）・失注・見積からの受注を扱う（第42.14節）。
 *
 * **金額は決まった計算で出す**（推論に計算させない）。注文書・請求書・領収書は下書きで作り、発行は本人の判断で行う
 * （業務では承認の後に `sales.issue`、画面では本人の「発行」。第42.3.1節）。納品書は作ったら発行済みにする。
 * 発行した書類は書き換えず、訂正は同じ番号の新しい版、取り消しは状態で表す（第42.3.2節・第42.6節）。
 * 入金は確かめない（領収書は本人が入金を伝えたときに作る。第42.4.4節）。人に確かめを求めない（ADR-0028）。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  SALES_DOC_KIND_LABELS, SALES_DOC_NEEDS_ISSUE, SALES_DOC_PREFIX, SALES_DOCS_EXTENSION_ID, SALES_QUOTE_DISCOUNT_NAME, canUseAgent, salesQuoteLabel, salesQuoteState,
  effectiveTaxTable, guessTaxCategory, plannedTaxNote, taxCategoryNote, taxCategoryOf, taxRateOn,
  type SalesDocKind, type SalesDocsSettings, type SalesDocument, type SalesItem, type SalesOrder, type SalesOrderFlag, type SalesOrderSource,
  type SalesOrderProgress, type SalesOrderStatus, type SalesParty, type SalesStockLink, type SalesSuggestions, type TaxCategory, type TaxRateEntry,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import type { FileStore } from '../files/store.js';
import { fileToText, type OcrFn } from '../files/to-text.js';
import { saveFile } from '../files/service.js';
import { loadInvoiceStyle } from '../files/invoice-style.js';
import { QUOTE_VALID_DAYS, quoteItemKey } from '../tools/quote.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { addDays, closingCutoff, closingDayFrom, docTotals, dueDateFrom, itemAmount, jstToday, yenText } from './calc.js';
import { itemsFrom, readOrder } from './extract.js';
import { docFileName, renderSalesDoc } from './render.js';
import { partyKey, type DocPatch, type DocQuery, type NewDoc, type OrderQuery, type PartyMemo, type SalesDocStore, type StoredDoc, type StoredOrder } from './store.js';

/** 操作する人。 */
export interface SalesViewer {
  tenantId: string;
  userId: string;
}

/** 処理に要るもの。 */
export interface SalesDocServiceDeps {
  store: SalesDocStore;
  repo: Repository;
  files: FileStore;
  llmFor(tenantId: string): Promise<LlmProvider | null>;
  /** 画像と文字の無い PDF を読み取る口（無ければ読み取らない） */
  ocrFor?(tenantId: string): Promise<OcrFn | undefined>;
  /** 消費税の税率の表（運営がマスター管理画面で直したもの。無ければ同梱の表。第15.1.1.1節） */
  taxTable?(): Promise<TaxRateEntry[]>;
  /** 在庫管理とのつなぎ（第42.13.4節）。在庫管理を使わない環境では無い */
  inventory?: SalesInventory;
  logger?: Logger;
}

/**
 * 在庫管理とのつなぎ（第42.13.4節）。在庫管理の処理を、販売の書類に要る口だけに絞って渡す。
 */
export interface SalesInventory {
  /** その人が在庫管理を使えるか（使えなければ `null`） */
  access(tenantId: string, userId: string): Promise<unknown | null>;
  /** 品目と使える数。販売品（`sale`）は販売価格と消費税率も持つ（第42.14.3節。社員価格と仕入価格は渡さない） */
  items(tenantId: string): Promise<SalesStockItem[]>;
  /** 取り置く（受注の引き当て）。取り置きの ID を返す */
  hold(tenantId: string, userId: string, r: { itemId: string; qty: number; ref: string }): Promise<string>;
  /** 取り置きを外す */
  release(tenantId: string, reservationId: string): Promise<void>;
  /** 出庫を記録する（納品書）。記録の ID を返す（記録できなければ `null`） */
  out(tenantId: string, userId: string, r: { itemId: string; qty: number; reason: string; sourceId: string }): Promise<string | null>;
  /** 出庫を戻す（納品書の取り消し） */
  undo(tenantId: string, userId: string, moveId: string, reason: string, sourceId: string): Promise<void>;
}

/** 在庫の品目（販売の書類が使う形）。 */
export interface SalesStockItem {
  id: string;
  name: string;
  sku: string;
  unit: string;
  available: number;
  /** 区分が販売品か */
  sale?: boolean;
  /** 販売価格（無ければ `null`） */
  price?: number | null;
  /** 販売価格が税込か */
  priceTaxIncluded?: boolean;
  /** 消費税率（10 か 8） */
  taxRate?: number;
}

/** メールから取り込むもの（第42.13.1節）。 */
export interface MailOrderInput {
  /** Gmail のメールの ID */
  id: string;
  /** メールの Message-ID（同じメールを何人も受け取ったときに 1 回だけ取り込む） */
  messageId: string;
  subject: string;
  body: string;
  files: { name: string; mime: string; bytes: Uint8Array }[];
}

/**
 * 会社が販売の書類と受注を使っていて、利用者が利用範囲の中なら、会社の設定を返す。
 *
 * @returns 使えなければ `null`
 */
export function salesDocsAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<SalesDocsSettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.salesDocs.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, SALES_DOCS_EXTENSION_ID, userId, groups)) return null;
    return settings.salesDocs;
  };
}

/** 書類を作るときに渡すもの（第42.3節・第42.4節）。足りない項目はつないだ受注・納品書・請求書から埋める。 */
export interface CreateDocInput {
  kind: SalesDocKind;
  /** 直す下書き（あれば、新しく作らずにこの下書きを書き換える） */
  documentId?: string;
  party?: Partial<SalesParty>;
  subject?: string;
  items?: SalesItem[];
  /** つなぐ受注（納品書は受注の残りの数で作る） */
  orderId?: string;
  /** 請求書にまとめる納品書 */
  deliveryIds?: string[];
  /** 請求書: その取引先の未請求の納品書をまとめる（締めの区切りまで。第42.4.2節） */
  collectFor?: string;
  /** 領収書: 元の請求書 */
  invoiceId?: string;
  /** 領収書: 受け取った額（一部の入金。無ければ請求書の合計） */
  amount?: number;
  dueOn?: string;
  terms?: string;
  notes?: string;
}

/** 書類を作った結果。 */
export interface CreatedDoc {
  doc: SalesDocument;
  /** 示すこと（単価の無い品目・外した納品書・登録番号が無いなど） */
  warnings: string[];
  /** 添えること（前の書類の単価を使ったなど） */
  notes: string[];
}

/** 書類 1 通の詳しい中身（版とつながり）。 */
export interface DocDetail {
  doc: SalesDocument;
  /** まだ確定していない税率の変更の知らせ（食料品の 1% など。第15.1.1節） */
  taxNotes: string[];
  versions: SalesDocument[];
  order: SalesOrder | null;
  /** 請求書: まとめた納品書。領収書・納品書: 元の請求書 */
  deliveries: SalesDocument[];
  invoice: SalesDocument | null;
  receipts: SalesDocument[];
  /** 見積書: この見積書（どの版でも）に対する受注 */
  orders: SalesOrder[];
  /** 見積書: 前の版からの違い（第42.14.2節） */
  diff: string[];
}

/** 見積書を作るときに渡すもの（第42.14.1節）。 */
export interface QuoteInput {
  /** 宛先（「株式会社見本商事 山田様」のような書き方でもよい） */
  to?: string;
  party?: Partial<SalesParty>;
  items: SalesItem[];
  /** 有効期限（発行から何日。無ければ会社の見積書の既定） */
  validDays?: number;
  /** お支払い条件（無ければ会社の見積書の既定） */
  paymentTerms?: string;
  /** 納期などの条件 */
  terms?: string;
  notes?: string;
}

/** 再見積で直すこと（第42.14.2節）。 */
export interface QuoteRevision {
  /** 品目を入れ替える（無ければ前の版の品目） */
  items?: SalesItem[];
  /** 見積全体の値引き（円。税率ごとに分けて「出精値引き」の行にする。0 なら値引きの行を外す） */
  discountTotal?: number;
  to?: string;
  party?: Partial<SalesParty>;
  validDays?: number;
  paymentTerms?: string;
  terms?: string;
  notes?: string;
}

/** 見積書を作った結果。`stock` は在庫の数の知らせ（見積書には載せない。第42.14.3節）。`diff` は前の版からの違い。 */
export interface CreatedQuote extends CreatedDoc {
  stock: string[];
  diff: string[];
}

/** 受注 1 件の詳しい中身。 */
export interface OrderDetail {
  order: SalesOrder;
  documents: SalesDocument[];
}

/**
 * 取り込んだ結果。`linked` は、手で入れた受注に後から届いた注文書をつないだこと（第42.5.1.1節）。
 */
export type ImportedOrder = { order: SalesOrder; duplicate: false } | { order: SalesOrder; duplicate: true; linked?: boolean } | { error: string };

/** 手で入れる受注（電話などで受けた注文。第42.5.1.1節）。 */
export interface ManualOrderInput {
  /** 取引先の名前（略した呼び方でもよい。正式な名前に寄せる） */
  party: string;
  person?: string;
  /** 品目。名前が「いつもの」なら、その取引先の前の注文から読む */
  items: SalesItem[];
  orderedOn?: string;
  dueOn?: string;
  customerRef?: string;
  deliverTo?: string;
  terms?: string;
  notes?: string;
}

/** 品名が「いつもの」か（「いつものあれ」「いつものやつ」「例の」など）。 */
export function isUsualItem(name: string): boolean {
  return /^(?:いつもの|例の|いつも)(?:あれ|やつ|もの|品|商品)?$/.test(name.normalize('NFKC').replace(/[\s　「」]/g, ''));
}

const SYSTEM = 'system';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const emptyParty = (): SalesParty => ({ name: '', department: '', person: '', address: '', phone: '', email: '' });
const itemKey = (i: Pick<SalesItem, 'name' | 'code'>) => (i.code ? `#${i.code.normalize('NFKC').toLowerCase()}` : quoteItemKey(i.name));
const mmdd = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 番号の頭（`I-20261026-`）。 */
const prefixOf = (kind: SalesDocKind | 'order', day: string) => `${kind === 'order' ? 'S' : SALES_DOC_PREFIX[kind]}-${day.replace(/-/g, '')}-`;

/**
 * 販売の書類と受注の操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link salesDocsAccess} で確かめること
 */
export class SalesDocService {
  private readonly log: Logger;

  constructor(readonly deps: SalesDocServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  private async audit(who: SalesViewer, action: string, targetType: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: who.userId === SYSTEM ? 'system' : 'user', actorId: who.userId,
      action, targetType, targetId: id, detail, occurredAt: new Date().toISOString(),
    });
  }

  private async names(tenantId: string): Promise<Map<string, string>> {
    return new Map((await this.deps.repo.listUsers(tenantId)).map((u) => [u.id, u.displayName || u.email]));
  }

  private async isAdmin(who: SalesViewer): Promise<boolean> {
    const u = await this.deps.repo.findUserById(who.tenantId, who.userId);
    return !!u?.roles.includes('admin');
  }

  private view(d: StoredDoc, names: Map<string, string>): SalesDocument {
    return { ...d, createdByName: names.get(d.createdBy) ?? '' };
  }

  // ───────── 書類 ─────────

  /** 書類の一覧（新しい版だけ。取引の日の新しい順）。 */
  async list(who: SalesViewer, q: DocQuery = {}): Promise<SalesDocument[]> {
    const [docs, names] = await Promise.all([this.deps.store.listDocs(who.tenantId, q), this.names(who.tenantId)]);
    return docs.map((d) => this.view(d, names));
  }

  /** 書類 1 通と、その版・つながった受注・納品書・請求書・領収書。 */
  async get(who: SalesViewer, id: string): Promise<DocDetail | null> {
    const d = await this.deps.store.getDoc(who.tenantId, id);
    if (!d) return null;
    const names = await this.names(who.tenantId);
    const all = await this.deps.store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 });
    const versions = d.number ? all.filter((x) => x.number === d.number && x.kind === d.kind).sort((a, b) => b.version - a.version) : [d];
    const order = d.orderId ? await this.getOrder(who, d.orderId).then((r) => r?.order ?? null) : null;
    const deliveries = d.kind === 'invoice' ? all.filter((x) => d.deliveryIds.includes(x.id)) : [];
    const invoice = d.invoiceId ? all.find((x) => x.id === d.invoiceId) ?? null : null;
    const receipts = d.kind === 'invoice' ? all.filter((x) => x.kind === 'receipt' && x.invoiceId === d.id && x.status !== 'cancelled') : [];
    const table = await this.table();
    const taxNotes = [...new Set(d.items.map((i) => plannedTaxNote(taxCategoryOf(i), d.issuedOn, table)).filter((x): x is string => !!x))];
    let orders: SalesOrder[] = [];
    let diff: string[] = [];
    if (d.kind === 'quote') {
      const ids = new Set(versions.map((x) => x.id));
      const memos = await this.memos(who.tenantId);
      orders = (await this.deps.store.listOrders(who.tenantId, { limit: 2000 })).filter((o) => o.quoteId && ids.has(o.quoteId)).map((o) => this.orderView(o, all, names, memos));
      const prev = d.previousId ? all.find((x) => x.id === d.previousId) : undefined;
      if (prev) diff = quoteDiff(prev, d);
    }
    return {
      doc: this.view(d, names), taxNotes, versions: versions.map((x) => this.view(x, names)), order,
      deliveries: deliveries.map((x) => this.view(x, names)), invoice: invoice ? this.view(invoice, names) : null,
      receipts: receipts.map((x) => this.view(x, names)), orders, diff,
    };
  }

  /** PDF の中身（会社の書類を使える人なら開ける）。 */
  async pdf(who: SalesViewer, id: string): Promise<{ name: string; bytes: Uint8Array } | null> {
    const d = await this.deps.store.getDoc(who.tenantId, id);
    if (!d?.fileId) return null;
    const bytes = await this.deps.files.get(who.tenantId, d.fileId);
    return bytes ? { name: docFileName(d), bytes } : null;
  }

  /** 次の番号（会社と種類と日付ごとの連番）。 */
  private async nextNumber(tenantId: string, kind: SalesDocKind | 'order', day: string): Promise<string> {
    const prefix = prefixOf(kind, day);
    const last = await this.deps.store.lastSeq(tenantId, kind === 'order' ? 'orders' : 'docs', prefix);
    // 見積書はいままでの見積番号（Q-日付-01）に合わせて 2 桁、ほかは 3 桁
    return `${prefix}${String(last + 1).padStart(kind === 'quote' ? 2 : 3, '0')}`;
  }

  /**
   * 品目の税の区分を決め、取引の日の税率を当てる（仕様書 第15.1.1節）。区分の無い品目は、前に同じ品目があればその区分、
   * 無ければ品名から推し量る（推論が業務で区分を渡していれば、それを使う）。
   *
   * @param fixed 税率をそのまま使う品目（まとめた納品書・元の請求書から写したもの。その取引の日の税率が当たっている）
   * @returns 区分を判断したことの言葉（軽減・対象外・迷ったもの）と、まだ確定していない税率の変更の知らせ
   */
  private async classify(who: SalesViewer, partyName: string, items: SalesItem[], day: string, fixed: Set<SalesItem> = new Set()): Promise<{ judged: string[]; planned: string[] }> {
    const table = await this.table();
    const judged: string[] = [];
    const planned = new Set<string>();
    const needPast = items.some((i) => !i.taxCategory && !fixed.has(i));
    const past = needPast ? (await this.suggestions(who, partyName)).items : [];
    for (const it of items) {
      if (fixed.has(it)) {
        it.taxCategory = taxCategoryOf(it);
        continue;
      }
      if (!it.taxCategory) {
        const before = past.find((x) => itemKey(x) === itemKey(it));
        if (before) it.taxCategory = before.taxCategory;
        else {
          const g = guessTaxCategory(it.name);
          it.taxCategory = g.category;
          const note = taxCategoryNote(it.name, g.category, g.unsure);
          if (note) judged.push(note);
        }
      }
      it.taxRate = taxRateOn(it.taxCategory, day, table);
      const p = plannedTaxNote(it.taxCategory, day, table);
      if (p) planned.add(p);
    }
    return { judged, planned: [...planned] };
  }

  /** 税率の表（運営が直したもの。無ければ同梱の表）。 */
  private async table(): Promise<TaxRateEntry[]> {
    return this.deps.taxTable ? this.deps.taxTable().catch(() => effectiveTaxTable(null)) : effectiveTaxTable(null);
  }

  /**
   * 単価の無い品目に単価を入れる。在庫管理の販売品の販売価格（税抜に直したもの）を先に使い、無ければ同じ取引先の前の書類（見積書を含む）・受注の
   * 同じ品目の単価を使う（第42.14.3節）。値引きの行には入れない。
   */
  private async fillPrices(who: SalesViewer, partyName: string, items: SalesItem[], defaultUnit = '個'): Promise<string[]> {
    const filled = await this.fromStock(who, items);
    if (!items.some((i) => i.unitPrice === null || !i.unit)) return filled;
    const key = partyKey(partyName);
    const past = (await this.deps.store.listDocs(who.tenantId, { limit: 300 }))
      .filter((d) => d.status !== 'cancelled' && (!key || partyKey(d.party.name) === key)).flatMap((d) => d.items).filter((i) => !isDiscountLine(i));
    // 受注（注文書から読んだもの・手で入れたもの）の単価も使う
    const orders = (await this.deps.store.listOrders(who.tenantId, { limit: 300 }))
      .filter((o) => !o.cancelled && (!key || partyKey(o.party.name) === key)).flatMap((o) => o.items).filter((i) => !isDiscountLine(i));
    for (const it of items) {
      // 単位が無ければ前の同じ品目の単位、それも無ければ「個」
      if (!it.unit) it.unit = [...past, ...orders].find((p) => itemKey(p) === itemKey(it) && p.unit)?.unit ?? defaultUnit;
      if (it.unitPrice !== null) continue;
      const hit = [...past, ...orders].find((p) => itemKey(p) === itemKey(it) && p.unitPrice !== null);
      if (hit) { it.unitPrice = hit.unitPrice; filled.push(it.name); }
    }
    return filled;
  }

  /** 在庫管理の販売品（その人が在庫管理を使えるときだけ）。 */
  private async saleItems(who: SalesViewer): Promise<SalesStockItem[]> {
    const inv = await this.stockOn(who);
    return inv ? (await inv.items(who.tenantId).catch(() => [])).filter((x) => x.sale) : [];
  }

  /**
   * 品目を在庫の販売品に当てる（品番が同じか、名前が同じ）。当たれば品番・単位・税の区分・単価（書かれていなければ販売価格を税抜にしたもの）を入れる。
   *
   * @returns 販売価格を使った品目の名前
   */
  private async fromStock(who: SalesViewer, items: SalesItem[], sale?: SalesStockItem[]): Promise<string[]> {
    const list = sale ?? await this.saleItems(who);
    if (list.length === 0) return [];
    const used: string[] = [];
    for (const it of items) {
      if (isDiscountLine(it)) continue;
      const hit = stockMatch(list, it);
      if (!hit) continue;
      it.inventoryItemId = hit.id;
      if (!it.code && hit.sku) it.code = hit.sku;
      if (!it.unit && hit.unit) it.unit = hit.unit;
      if (!it.taxCategory && hit.taxRate) it.taxCategory = hit.taxRate === 8 ? 'food' : 'standard';
      if (it.unitPrice === null && hit.price !== null && hit.price !== undefined) {
        // 税込の販売価格は税抜に直す（円未満は四捨五入。決まった計算）
        it.unitPrice = hit.priceTaxIncluded ? Math.round((hit.price * 100) / (100 + (hit.taxRate ?? 10))) : hit.price;
        used.push(it.name);
      }
    }
    return used;
  }

  /**
   * PDF を作り直してファイルとして残す。
   *
   * @remarks 実行には結び付けない（実行の記録の保存期間で消えると、書類を 10 年残せないため。第42.6節）。作った人のファイルにする
   */
  private async renderFile(who: SalesViewer, d: StoredDoc): Promise<string> {
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const style = await loadInvoiceStyle({ repo: this.deps.repo, files: this.deps.files, tenantId: who.tenantId });
    const bytes = await renderSalesDoc(d, style, settings);
    const file = await saveFile(this.deps.repo, this.deps.files, {
      tenantId: who.tenantId, ownerUserId: who.userId, name: docFileName(d), kind: 'pdf', bytes, origin: 'generated', runId: null,
    });
    return file.id;
  }

  /** ファイルの中身を、同じ ID のまま描き直す（発行のとき。承認の前に組み立てたメールの添付が、発行した PDF になるため）。 */
  private async rewriteFile(who: SalesViewer, d: StoredDoc): Promise<void> {
    if (!d.fileId) return;
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const style = await loadInvoiceStyle({ repo: this.deps.repo, files: this.deps.files, tenantId: who.tenantId });
    const bytes = await renderSalesDoc(d, style, settings);
    await this.deps.files.put(who.tenantId, d.fileId, bytes);
    await this.deps.repo.replaceFileMeta(who.tenantId, d.fileId, {
      name: docFileName(d), kind: 'pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  /** 古いファイルを消す（下書きを描き直したとき）。 */
  private async dropFile(tenantId: string, fileId: string | null): Promise<void> {
    if (!fileId) return;
    await this.deps.files.remove(tenantId, fileId).catch(() => undefined);
    await this.deps.repo.deleteFile(tenantId, fileId).catch(() => undefined);
  }

  /** 未請求の納品書（新しい版で、発行済みで、請求していないもの）。 */
  private async unbilledDeliveries(tenantId: string): Promise<StoredDoc[]> {
    const all = await this.deps.store.listDocs(tenantId, { withSuperseded: true, limit: 2000 });
    const billed = new Set(all.filter((d) => d.kind === 'invoice' && d.status === 'issued' && !d.superseded).flatMap((d) => d.deliveryIds));
    return all.filter((d) => d.kind === 'delivery' && d.status === 'issued' && !d.superseded && !d.invoiceId && !billed.has(d.id));
  }

  /**
   * 書類を作る（第42.3節・第42.4節）。下書きを渡せば、その下書きを書き換える。
   *
   * @param runId 作った実行（業務から。画面からは `null`）
   */
  async createDocument(who: SalesViewer, input: CreateDocInput, runId: string | null): Promise<CreatedDoc | { error: string }> {
    const { store } = this.deps;
    if (input.kind === 'quote') return { error: '見積書は業務「見積書の作成」で作ります' };
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const today = jstToday();
    const warnings: string[] = [];
    const notes: string[] = [];

    // 下書きを直す（同じ下書きを書き換え、PDF を描き直す）
    if (input.documentId) {
      const cur = await store.getDoc(who.tenantId, input.documentId);
      if (!cur) return { error: '書類が見つかりません' };
      if (cur.kind !== input.kind) return { error: `この書類は${SALES_DOC_KIND_LABELS[cur.kind]}です` };
      if (cur.status !== 'draft') return { error: '発行した書類は書き換えられません。訂正版を作ってください' };
      const items = input.items?.length ? input.items : cur.items;
      const party = { ...cur.party, ...cleanParty(input.party) };
      const filled = await this.fillPrices(who, party.name, items);
      // 品目を直さなければ、下書きを作ったときの税率をそのまま使う
      const fixedNow = new Set(input.items?.length ? [] : items);
      const tax = await this.classify(who, party.name, items, cur.issuedOn, fixedNow);
      notes.push(...tax.judged);
      warnings.push(...tax.planned);
      const totals = docTotals(items, settings.company.taxRounding);
      const next: StoredDoc = {
        ...cur, party, items, ...totals,
        subject: input.subject !== undefined ? str(input.subject, 80) : cur.subject,
        dueOn: input.dueOn && DATE.test(input.dueOn) ? input.dueOn : cur.dueOn,
        terms: input.terms !== undefined ? str(input.terms, 120) : cur.terms,
        notes: input.notes !== undefined ? str(input.notes, 400) : cur.notes,
        runId: runId ?? cur.runId,
      };
      const fileId = await this.renderFile(who, next);
      await this.dropFile(who.tenantId, cur.fileId);
      const patch: DocPatch = {
        party: next.party, items, subtotal: totals.subtotal, tax: totals.tax, total: totals.total, taxLines: totals.taxLines,
        subject: next.subject, dueOn: next.dueOn, terms: next.terms, notes: next.notes, fileId, runId: next.runId,
      };
      await store.updateDoc(who.tenantId, cur.id, patch);
      if (filled.length) notes.push(`前の書類・見積書の単価を使いました: ${filled.join('、')}`);
      const missing = items.filter((i) => i.unitPrice === null).map((i) => i.name);
      if (missing.length) warnings.push(`単価が入っていない品目があります（0 円で作りました）: ${missing.join('、')}`);
      await this.audit(who, 'sales_doc.update', 'sales_document', cur.id, { kind: cur.kind });
      return { doc: this.view({ ...next, fileId }, await this.names(who.tenantId)), warnings, notes };
    }

    let party: SalesParty = { ...emptyParty(), ...cleanParty(input.party) };
    let items: SalesItem[] = (input.items ?? []).map((i) => ({ ...i }));
    let orderId: string | null = null;
    let invoiceId: string | null = null;
    let deliveryIds: string[] = [];
    // 写した品目の税率をそのまま使う（納品書の納品の日・元の請求書の日の税率。第15.1.1節）
    const fixed = new Set<SalesItem>();
    let subject = str(input.subject, 80);
    let terms = str(input.terms, 120);
    let dueOn: string | null = input.dueOn && DATE.test(input.dueOn) ? input.dueOn : null;

    // 受注から（納品書は残りの数。ほかの書類は受注の品目）
    if (input.orderId) {
      const od = await this.getOrder(who, input.orderId);
      if (!od) return { error: '受注が見つかりません' };
      if (od.order.status === 'cancelled') return { error: 'この受注は取り消されています' };
      orderId = od.order.id;
      if (!party.name) party = { ...od.order.party };
      if (!terms) terms = od.order.terms;
      if (items.length === 0) {
        items = od.order.items.map((i, k) => ({ ...i, quantity: input.kind === 'delivery' ? Math.max(0, i.quantity - (od.order.delivered[k] ?? 0)) : i.quantity }))
          .filter((i) => i.quantity > 0);
        if (items.length === 0) return { error: 'この受注は、すべて納品済みです' };
      }
      if (!subject && od.order.customerRef) subject = `ご注文番号 ${od.order.customerRef}`;
    }

    // 請求書: 納品書をまとめる（第42.4.2節）
    if (input.kind === 'invoice' && (input.deliveryIds?.length || input.collectFor)) {
      const unbilled = await this.unbilledDeliveries(who.tenantId);
      let picked: StoredDoc[];
      if (input.deliveryIds?.length) {
        picked = [];
        for (const id of input.deliveryIds) {
          const d = await store.getDoc(who.tenantId, id);
          if (!d || d.kind !== 'delivery') { warnings.push('見つからない納品書を外しました'); continue; }
          if (!unbilled.some((u) => u.id === d.id)) {
            const inv = d.invoiceId ? await store.getDoc(who.tenantId, d.invoiceId) : null;
            warnings.push(`${d.number ?? '納品書'} はすでに${inv?.number ? ` ${inv.number} で` : ''}請求しているか、発行していないので外しました`);
            continue;
          }
          picked.push(d);
        }
      } else {
        const key = partyKey(input.collectFor!);
        const memo = await store.getParty(who.tenantId, key);
        const cutoff = closingCutoff(today, memo?.closingDay ?? null);
        picked = unbilled.filter((d) => partyKey(d.party.name) === key && d.issuedOn <= cutoff);
        if (picked.length === 0) return { error: `${input.collectFor} の未請求の納品書がありません（${mmdd(cutoff)} までの分）` };
      }
      if (picked.length === 0) return { error: 'まとめられる納品書がありません' };
      const names = new Set(picked.map((d) => partyKey(d.party.name)));
      if (names.size > 1) return { error: '取引先の違う納品書は、1 枚の請求書にまとめられません' };
      picked.sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || (a.number ?? '').localeCompare(b.number ?? ''));
      deliveryIds = picked.map((d) => d.id);
      if (!party.name) party = { ...picked[0]!.party };
      if (!orderId && picked.every((d) => d.orderId && d.orderId === picked[0]!.orderId)) orderId = picked[0]!.orderId;
      // 明細は納品書ごとに区分の見出しを付けて並べる
      items = picked.flatMap((d) => d.items.map((i) => ({ ...i, group: `${mmdd(d.issuedOn)} 納品 ${d.number ?? ''}`.trim() })));
      for (const i of items) fixed.add(i);
      if (!subject) subject = picked.length > 1 ? `${mmdd(picked[0]!.issuedOn)}〜${mmdd(picked.at(-1)!.issuedOn)} 納品分` : `${mmdd(picked[0]!.issuedOn)} 納品分`;
    }

    // 領収書: 元の請求書から（第42.4.4節）
    if (input.kind === 'receipt' && input.invoiceId) {
      const inv = await store.getDoc(who.tenantId, input.invoiceId);
      if (!inv || inv.kind !== 'invoice') return { error: '請求書が見つかりません' };
      if (inv.status !== 'issued') return { error: '発行していない請求書には、領収書を作れません' };
      invoiceId = inv.id;
      if (!party.name) party = { ...inv.party };
      if (!subject) subject = inv.subject || (inv.items[0]?.name ? `${inv.items[0].name}${inv.items.length > 1 ? 'ほか' : ''}代` : '');
      if (items.length === 0) {
        if (input.amount && input.amount > 0 && Math.round(input.amount) !== inv.total) {
          const part = partialItems(Math.round(input.amount), inv, settings.company.taxRounding);
          if ('error' in part) return part;
          items = part.items;
          notes.push(`一部の入金として ${yenText(Math.round(input.amount))} の領収書にしました`);
        } else items = inv.items.map((i) => ({ ...i }));
        for (const i of items) fixed.add(i);
      }
    }

    if (items.length === 0) return { error: '品目がありません' };
    if (!party.name && !party.person) warnings.push('宛先が入っていません');
    const filled = await this.fillPrices(who, party.name, items);
    if (filled.length) notes.push(`前の書類・見積書の単価を使いました: ${filled.join('、')}`);
    const missing = items.filter((i) => i.unitPrice === null).map((i) => i.name);
    if (missing.length) warnings.push(`単価が入っていない品目があります（0 円で作りました）: ${missing.join('、')}`);
    const tax = await this.classify(who, party.name, items, today, fixed);
    notes.push(...tax.judged);
    warnings.push(...tax.planned);
    if ((input.kind === 'invoice' || input.kind === 'receipt') && !settings.company.invoiceRegistrationNumber) {
      warnings.push('登録番号が会社情報にありません（適格請求書の記載が足りません）');
    }

    // 支払期限（請求書）: 渡された日 → 取引先の支払い条件 → 会社の既定
    const memo = party.name ? await store.getParty(who.tenantId, partyKey(party.name)) : null;
    if (input.kind === 'invoice' && !dueOn) {
      dueOn = dueDateFrom(terms || memo?.paymentTerms || '', today) ?? dueDateFrom(settings.invoice.paymentDue, today);
      if (!dueOn) warnings.push('支払期限が決められませんでした（取引先の支払い条件か、会社の支払期限の既定を入れてください）');
    }
    if (input.kind === 'invoice' && !terms && memo?.paymentTerms) terms = memo.paymentTerms;

    const totals = docTotals(items, settings.company.taxRounding);
    const issueNow = !SALES_DOC_NEEDS_ISSUE[input.kind];
    const base: NewDoc = {
      kind: input.kind, number: null, version: 1, previousId: null, superseded: false, status: issueNow ? 'issued' : 'draft',
      party, subject, items, ...totals, issuedOn: today, dueOn, terms, notes: str(input.notes, 400),
      orderId, invoiceId, deliveryIds, fileId: null, cancelReason: '', notices: [], runId, createdBy: who.userId, stockMoves: [],
      validUntil: null, outcome: null, outcomeNote: '',
    };
    // 納品書はすぐ番号を付ける（同じ番号が重なれば次の番号で作り直す）
    let id = '';
    let doc: StoredDoc | null = null;
    for (let attempt = 0; attempt < 5 && !doc; attempt++) {
      const number = issueNow ? await this.nextNumber(who.tenantId, input.kind, today) : null;
      const draft: StoredDoc = { ...base, number, id: '', createdAt: '', updatedAt: '' };
      const fileId = await this.renderFile(who, draft);
      try {
        id = await store.createDoc(who.tenantId, { ...base, number, fileId });
        doc = (await store.getDoc(who.tenantId, id))!;
      } catch (err) {
        await this.dropFile(who.tenantId, fileId);
        if (!issueNow || attempt === 4) throw err;
      }
    }
    await this.audit(who, issueNow ? 'sales_doc.issue' : 'sales_doc.create', 'sales_document', id, { kind: input.kind, total: totals.total, number: doc!.number });
    // 受注から作った納品書は、在庫につないだ品目を出庫し、取り置きを残りの数にする（第42.13.4節）
    if (input.kind === 'delivery' && orderId) {
      const moved = await this.stockOut(who, doc!, orderId).catch((err) => { this.log.warn('納品書の出庫を記録できませんでした', { err }); return []; });
      if (moved.length) { await store.updateDoc(who.tenantId, id, { stockMoves: moved }); doc = { ...doc!, stockMoves: moved }; notes.push(`在庫から出庫しました（${moved.length} 品目）`); }
    }
    return { doc: this.view(doc!, await this.names(who.tenantId)), warnings, notes };
  }

  /**
   * 下書きを発行する（番号を付け、「下書き」を外した PDF にする。第42.3.1節）。業務では承認の後に、画面では本人が押して行う。
   *
   * @remarks 請求書は、まとめた納品書を請求済みにする。ほかの請求書に入った納品書があれば発行しない
   */
  async issue(who: SalesViewer, id: string): Promise<SalesDocument | { error: string }> {
    const { store } = this.deps;
    const d = await store.getDoc(who.tenantId, id);
    if (!d) return { error: '書類が見つかりません' };
    if (d.status === 'issued') return { error: `${SALES_DOC_KIND_LABELS[d.kind]} ${d.number ?? ''} はもう発行しています` };
    if (d.status !== 'draft') return { error: '取り消した書類は発行できません' };
    if (d.kind === 'invoice' && d.deliveryIds.length) {
      const unbilled = new Set((await this.unbilledDeliveries(who.tenantId)).map((x) => x.id));
      for (const did of d.deliveryIds) {
        const dl = await store.getDoc(who.tenantId, did);
        // 訂正版の請求書は、前の版がまとめた納品書をそのまま引き継ぐ
        const ownedByPrev = !!dl?.invoiceId && dl.invoiceId === d.previousId;
        if (!dl || (!unbilled.has(did) && !ownedByPrev)) return { error: `${dl?.number ?? '納品書'} はほかの請求書で請求しているので、この請求書は発行できません。作り直してください` };
      }
    }
    const today = jstToday();
    // 発行の日の税率で計算し直す（下書きを作った後に税率が変わったとき。第15.1.1.1節）。納品書・請求書から写した品目は、その日の税率のまま
    let money: DocPatch = {};
    if (d.version === 1 && d.issuedOn !== today && d.deliveryIds.length === 0 && !d.invoiceId) {
      const settings = await this.deps.repo.getTenantSettings(who.tenantId);
      const items = d.items.map((i) => ({ ...i, taxCategory: taxCategoryOf(i) }));
      await this.classify(who, d.party.name, items, today);
      if (items.some((x, k) => x.taxRate !== d.items[k]!.taxRate)) money = { items, ...docTotals(items, settings.company.taxRounding) };
    }
    let number = d.number;
    for (let attempt = 0; attempt < 5; attempt++) {
      number = d.number ?? await this.nextNumber(who.tenantId, d.kind, today);
      const issued: StoredDoc = { ...d, ...money, number, status: 'issued', issuedOn: d.version > 1 ? d.issuedOn : today };
      try {
        await store.updateDoc(who.tenantId, d.id, { ...money, number, status: 'issued', issuedOn: issued.issuedOn });
        await this.rewriteFile(who, issued);
        break;
      } catch (err) {
        if (d.number || attempt === 4) throw err;
      }
    }
    // 訂正版を発行したら、前の版を置き換える
    if (d.previousId) await store.updateDoc(who.tenantId, d.previousId, { superseded: true });
    if (d.kind === 'invoice') for (const did of d.deliveryIds) await store.updateDoc(who.tenantId, did, { invoiceId: d.id });
    await this.audit(who, 'sales_doc.issue', 'sales_document', d.id, { kind: d.kind, number, total: d.total, version: d.version });
    return this.view((await store.getDoc(who.tenantId, d.id))!, await this.names(who.tenantId));
  }

  /**
   * 発行した書類の訂正版を作る（同じ番号の新しい版。第42.3.2節）。納品書は作ったら発行済み、ほかは下書き（承認で発行する）。
   */
  async revise(who: SalesViewer, id: string, changes: Omit<CreateDocInput, 'kind' | 'documentId' | 'orderId' | 'deliveryIds' | 'collectFor' | 'invoiceId' | 'amount'>, runId: string | null): Promise<CreatedDoc | { error: string }> {
    const { store } = this.deps;
    const cur = await store.getDoc(who.tenantId, id);
    if (!cur) return { error: '書類が見つかりません' };
    if (cur.kind === 'quote') return this.reviseQuote(who, id, changes, runId);
    if (cur.status === 'draft') return this.createDocument(who, { ...changes, kind: cur.kind, documentId: cur.id }, runId);
    if (cur.status !== 'issued') return { error: '取り消した書類は訂正できません' };
    if (cur.superseded) return { error: 'この版はもう訂正されています。新しい版を直してください' };
    const pending = (await store.listDocs(who.tenantId, { number: cur.number!, withSuperseded: true })).find((x) => x.status === 'draft' && x.kind === cur.kind);
    if (pending) return this.createDocument(who, { ...changes, kind: cur.kind, documentId: pending.id }, runId);
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const items = changes.items?.length ? changes.items.map((i) => ({ ...i })) : cur.items.map((i) => ({ ...i }));
    const filled = await this.fillPrices(who, cur.party.name, items);
    // 品目を直さなければ、前の版の税率をそのまま使う。直した品目は前の版の取引の日の税率を当てる
    const tax = await this.classify(who, cur.party.name, items, cur.issuedOn, new Set(changes.items?.length ? [] : items));
    const totals = docTotals(items, settings.company.taxRounding);
    const issueNow = !SALES_DOC_NEEDS_ISSUE[cur.kind];
    const next: NewDoc = {
      ...cur, party: { ...cur.party, ...cleanParty(changes.party) }, items, ...totals,
      subject: changes.subject !== undefined ? str(changes.subject, 80) : cur.subject,
      dueOn: changes.dueOn && DATE.test(changes.dueOn) ? changes.dueOn : cur.dueOn,
      terms: changes.terms !== undefined ? str(changes.terms, 120) : cur.terms,
      notes: changes.notes !== undefined ? str(changes.notes, 400) : cur.notes,
      version: cur.version + 1, previousId: cur.id, superseded: false, status: issueNow ? 'issued' : 'draft', fileId: null,
      cancelReason: '', notices: [], runId, createdBy: who.userId,
    };
    const fileId = await this.renderFile(who, { ...next, id: '', createdAt: '', updatedAt: '' });
    const newId = await store.createDoc(who.tenantId, { ...next, fileId });
    if (issueNow) {
      await store.updateDoc(who.tenantId, cur.id, { superseded: true });
      // 請求済みの納品書を訂正したら、請求書は直さず知らせる（第42.4.2節）
      if (cur.kind === 'delivery' && cur.invoiceId) await this.noticeOnInvoice(who, cur.invoiceId, `納品書 ${cur.number} が訂正されました（訂正版 ${next.version}）。請求書の訂正版を作るか確かめてください`);
    }
    await this.audit(who, 'sales_doc.revise', 'sales_document', newId, { kind: cur.kind, number: cur.number, version: next.version, from: cur.id });
    const notes = [...(filled.length ? [`前の書類・見積書の単価を使いました: ${filled.join('、')}`] : []), ...tax.judged];
    return { doc: this.view((await store.getDoc(who.tenantId, newId))!, await this.names(who.tenantId)), warnings: tax.planned, notes };
  }

  /** 請求書に知らせを付け、作った人に知らせる。 */
  private async noticeOnInvoice(who: SalesViewer, invoiceId: string, text: string): Promise<void> {
    const inv = await this.deps.store.getDoc(who.tenantId, invoiceId);
    if (!inv) return;
    await this.deps.store.updateDoc(who.tenantId, inv.id, { notices: [...inv.notices, text].slice(-10) });
    const user = await this.deps.repo.findUserById(who.tenantId, inv.createdBy);
    if (user?.status !== 'active') return;
    await this.deps.repo.createNotification({
      id: randomUUID(), tenantId: who.tenantId, userId: inv.createdBy, kind: 'run', title: `請求書 ${inv.number ?? ''} の納品書が訂正されました`,
      body: text, runId: null, readAt: null, createdAt: new Date().toISOString(),
    }).catch((err) => this.log.warn('請求書の知らせを送れませんでした', { err }));
  }

  /**
   * 発行した書類を取り消す（削除しない。理由を残す。第42.3.2節）。請求書を取り消すと、まとめた納品書は未請求に戻る。
   *
   * @remarks 作った人と管理者だけ。下書きは {@link SalesDocService.removeDraft}
   */
  async cancel(who: SalesViewer, id: string, reason: string): Promise<string | null> {
    const { store } = this.deps;
    const d = await store.getDoc(who.tenantId, id);
    if (!d) return '書類が見つかりません';
    if (d.status === 'draft') return '下書きは取り消しではなく削除してください';
    if (d.status === 'cancelled') return 'もう取り消しています';
    if (d.createdBy !== who.userId && !(await this.isAdmin(who))) return '取り消せるのは、作った人と管理者だけです';
    const why = str(reason, 200);
    if (!why) return '取り消しの理由を書いてください';
    await store.updateDoc(who.tenantId, d.id, { status: 'cancelled', cancelReason: why });
    await this.rewriteFile(who, { ...d, status: 'cancelled', cancelReason: why });
    if (d.kind === 'invoice') {
      for (const did of d.deliveryIds) {
        const dl = await store.getDoc(who.tenantId, did);
        if (dl?.invoiceId === d.id) await store.updateDoc(who.tenantId, did, { invoiceId: null });
      }
    }
    // 納品書を取り消したら、出庫を戻し、受注の取り置きを戻す（第42.13.4節）
    if (d.kind === 'delivery' && d.stockMoves.length && this.deps.inventory) {
      for (const m of d.stockMoves) await this.deps.inventory.undo(who.tenantId, who.userId, m, `納品書 ${d.number ?? ''} の取り消し`, d.id).catch((err) => this.log.warn('出庫を戻せませんでした', { err }));
      await store.updateDoc(who.tenantId, d.id, { stockMoves: [] });
      if (d.orderId) await this.syncHolds(who, d.orderId).catch(() => undefined);
    }
    await this.audit(who, 'sales_doc.cancel', 'sales_document', d.id, { kind: d.kind, number: d.number, reason: why });
    return null;
  }

  /** 下書きを削除する（作った人と管理者だけ。発行した書類は削除しない）。 */
  async removeDraft(who: SalesViewer, id: string): Promise<string | null> {
    const d = await this.deps.store.getDoc(who.tenantId, id);
    if (!d) return '書類が見つかりません';
    if (d.status !== 'draft') return '発行した書類は削除できません（取り消してください）';
    if (d.createdBy !== who.userId && !(await this.isAdmin(who))) return '削除できるのは、作った人と管理者だけです';
    await this.deps.store.deleteDoc(who.tenantId, d.id);
    await this.dropFile(who.tenantId, d.fileId);
    await this.audit(who, 'sales_doc.delete', 'sales_document', d.id, { kind: d.kind });
    return null;
  }

  // ───────── 見積書（第42.14節） ─────────

  /** 見積書の一覧（新しい版だけ。新しい順）。状態は {@link salesQuoteState} で出す。 */
  async listQuotes(who: SalesViewer, q: Omit<DocQuery, 'kind'> = {}): Promise<SalesDocument[]> {
    return this.list(who, { ...q, kind: 'quote' });
  }

  /** その番号の見積書のすべての版（新しい版から）。 */
  private async quoteVersions(tenantId: string, number: string): Promise<StoredDoc[]> {
    return (await this.deps.store.listDocs(tenantId, { kind: 'quote', number, withSuperseded: true })).sort((a, b) => b.version - a.version);
  }

  /** 見積書（ID か番号）の、いちばん新しい版。 */
  private async latestQuote(tenantId: string, ref: string): Promise<StoredDoc | null> {
    const r = ref.trim().replace(/（再見積\s*\d+）$/, '');
    if (!r) return null;
    const byId = await this.deps.store.getDoc(tenantId, r);
    const number = byId?.kind === 'quote' ? byId.number : byId ? null : r;
    if (!number) return null;
    return (await this.quoteVersions(tenantId, number)).find((x) => !x.superseded) ?? null;
  }

  /**
   * 見積書を作る（第42.14.1節）。作ったらすぐ提出できる形にする（番号が付く。見積書は金額を示す書類で、お金の確定ではない）。
   * 単価の無い品目は、販売品の販売価格・前の書類の単価を使う。在庫が見積の数より少なければ知らせる（見積書には載せない）。
   *
   * @param runId 作った実行（業務から）
   */
  async createQuote(who: SalesViewer, input: QuoteInput, runId: string | null): Promise<CreatedQuote | { error: string }> {
    const items = (input.items ?? []).slice(0, 50).map((i) => ({ ...i }));
    if (items.length === 0) return { error: '品目がありません' };
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const party: SalesParty = { ...emptyParty(), ...partyFromTo(input.to ?? ''), ...cleanParty(input.party) };
    const today = jstToday();
    const sale = await this.saleItems(who);
    const notes: string[] = [];
    const warnings: string[] = [];
    const fromStock = await this.fromStock(who, items, sale);
    if (fromStock.length) notes.push(`在庫の販売品の販売価格を使いました: ${fromStock.join('、')}`);
    // 見積書の単位の既定は「式」（作業や制作の見積が多いため。いままでの見積書と同じ）
    const filled = (await this.fillPrices(who, party.name, items, '式')).filter((n) => !fromStock.includes(n));
    if (filled.length) notes.push(`前の見積書・書類の単価を使いました: ${filled.join('、')}`);
    const missing = items.filter((i) => i.unitPrice === null).map((i) => i.name);
    if (missing.length) warnings.push(`単価が入っていない品目があります（0 円で作りました）: ${missing.join('、')}`);
    const tax = await this.classify(who, party.name, items, today);
    notes.push(...tax.judged);
    warnings.push(...tax.planned);
    const qs = settings.invoice.quote;
    const validDays = Math.min(Math.max(Math.round(input.validDays ?? qs.validDays ?? QUOTE_VALID_DAYS), 1), 365);
    const extra = [str(input.terms, 120) ? `条件: ${str(input.terms, 120)}` : '', str(input.notes, 400)].filter(Boolean).join('\n');
    const base: NewDoc = {
      kind: 'quote', number: null, version: 1, previousId: null, superseded: false, status: 'issued', party, subject: '',
      items, ...docTotals(items, settings.company.taxRounding), issuedOn: today, dueOn: null,
      terms: str(input.paymentTerms, 50) || qs.paymentTerms || '', notes: extra, orderId: null, invoiceId: null, deliveryIds: [], fileId: null,
      cancelReason: '', notices: [], runId, createdBy: who.userId, stockMoves: [], validUntil: addDays(today, validDays), outcome: null, outcomeNote: '',
    };
    const doc = await this.saveNumbered(who, base, today);
    await this.audit(who, 'sales_doc.issue', 'sales_document', doc.id, { kind: 'quote', total: doc.total, number: doc.number });
    return { doc: this.view(doc, await this.names(who.tenantId)), warnings, notes, stock: shortages(items, sale), diff: [] };
  }

  /** 番号を付けて残す（同じ番号が重なれば次の番号で作り直す）。 */
  private async saveNumbered(who: SalesViewer, base: NewDoc, day: string): Promise<StoredDoc> {
    for (let attempt = 0; ; attempt++) {
      const number = base.number ?? await this.nextNumber(who.tenantId, base.kind, day);
      const fileId = await this.renderFile(who, { ...base, number, id: '', createdAt: '', updatedAt: '' });
      try {
        const id = await this.deps.store.createDoc(who.tenantId, { ...base, number, fileId });
        return (await this.deps.store.getDoc(who.tenantId, id))!;
      } catch (err) {
        await this.dropFile(who.tenantId, fileId);
        if (base.number || attempt >= 4) throw err;
      }
    }
  }

  /**
   * 再見積（第42.14.2節）。同じ見積番号の新しい版を作り、前の版を置き換え済みにする。発行の日と有効期限は今日から数え直す。
   * 値引きは頼まれた額だけを使う（品目ごとの値引き、または見積全体の値引きを税率ごとの「出精値引き」の行にする）。
   *
   * @returns 前の版からの違い（`diff`）を添える
   */
  async reviseQuote(who: SalesViewer, ref: string, changes: QuoteRevision, runId: string | null): Promise<CreatedQuote | { error: string }> {
    const { store } = this.deps;
    const cur = await this.latestQuote(who.tenantId, ref);
    if (!cur) return { error: '見積書が見つかりません' };
    if (cur.status === 'cancelled') return { error: '取り消した見積書は再見積できません' };
    if (cur.outcome === 'won') return { error: `見積書 ${salesQuoteLabel(cur)} はもう受注済みです（受注を直してください）` };
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const today = jstToday();
    const sale = await this.saleItems(who);
    const replaced = !!changes.items?.length;
    let items = (replaced ? changes.items! : cur.items).map((i) => ({ ...i }));
    const notes: string[] = [];
    const warnings: string[] = [];
    const filled = await this.fillPrices(who, cur.party.name, items, '式');
    if (filled.length) notes.push(`単価を入れました: ${filled.join('、')}`);
    // 品目を直さなければ、前の版の税の区分のまま今日の税率を当てる
    const tax = await this.classify(who, cur.party.name, items, today);
    notes.push(...tax.judged);
    warnings.push(...tax.planned);
    if (changes.discountTotal !== undefined) {
      const lines = discountLines(items.filter((i) => !isDiscountLine(i)), Math.round(changes.discountTotal));
      if ('error' in lines) return lines;
      items = [...items.filter((i) => !isDiscountLine(i)), ...lines];
    }
    const totals = docTotals(items, settings.company.taxRounding);
    if (totals.subtotal < 0) return { error: '値引きが見積の金額より大きくなります' };
    const qs = settings.invoice.quote;
    const validDays = Math.min(Math.max(Math.round(changes.validDays ?? qs.validDays ?? QUOTE_VALID_DAYS), 1), 365);
    const party = { ...cur.party, ...partyFromTo(changes.to ?? ''), ...cleanParty(changes.party) };
    const extra = changes.terms !== undefined || changes.notes !== undefined
      ? [str(changes.terms, 120) ? `条件: ${str(changes.terms, 120)}` : '', str(changes.notes, 400)].filter(Boolean).join('\n') : cur.notes;
    const next: NewDoc = {
      ...cur, party, items, ...totals, issuedOn: today, validUntil: addDays(today, validDays), outcome: null, outcomeNote: '',
      terms: changes.paymentTerms !== undefined ? str(changes.paymentTerms, 50) : cur.terms, notes: extra,
      version: cur.version + 1, previousId: cur.id, superseded: false, status: 'issued', fileId: null, cancelReason: '', notices: [], runId, createdBy: who.userId,
    };
    const doc = await this.saveNumbered(who, next, today);
    await store.updateDoc(who.tenantId, cur.id, { superseded: true });
    await this.audit(who, 'sales_doc.revise', 'sales_document', doc.id, { kind: 'quote', number: cur.number, version: next.version, from: cur.id, total: doc.total });
    return { doc: this.view(doc, await this.names(who.tenantId)), warnings, notes, stock: shortages(items, sale), diff: quoteDiff(cur, doc) };
  }

  /**
   * 失注にする（理由を残す。第42.14.4節）。受注済みの見積書は失注にしない。
   */
  async loseQuote(who: SalesViewer, ref: string, reason: string): Promise<string | null> {
    const q = await this.latestQuote(who.tenantId, ref);
    if (!q) return '見積書が見つかりません';
    if (q.status === 'cancelled') return '取り消した見積書です';
    if (q.outcome === 'won') return 'この見積書は受注済みです（受注を取り消してください）';
    await this.deps.store.updateDoc(who.tenantId, q.id, { outcome: 'lost', outcomeNote: str(reason, 200) });
    await this.audit(who, 'sales_doc.lost', 'sales_document', q.id, { number: q.number, version: q.version });
    return null;
  }

  /**
   * 注文書に合う見積書を探す（同じ取引先の、提出済みで有効期限の内の見積書のうち、品目がいちばん合う新しいもの）。
   */
  private async matchQuote(tenantId: string, key: string, items: SalesItem[], day: string): Promise<StoredDoc | null> {
    if (!key || items.length === 0) return null;
    const quotes = (await this.deps.store.listDocs(tenantId, { kind: 'quote', limit: 500 }))
      .filter((d) => partyKey(d.party.name) === key && salesQuoteState(d, day) === 'submitted');
    let best: { q: StoredDoc; score: number } | null = null;
    for (const q of quotes) {
      const keys = new Set(q.items.filter((i) => !isDiscountLine(i)).map(itemKey));
      const score = items.filter((i) => keys.has(itemKey(i))).length;
      if (score > 0 && (!best || score > best.score)) best = { q, score };
    }
    return best?.q ?? null;
  }

  // ───────── 受注 ─────────

  /**
   * 受注に、納品書から求めた状態と納めた数と、受注から先の進み具合（請書・納品・請求・領収と次の一手。第42.14.6節）を足す。
   *
   * @param memos 取引先の覚え（締め日。未請求の納品書を「請求書を作る」と示すのは締めの区切りを過ぎたものだけ）
   */
  private orderView(o: StoredOrder, docs: StoredDoc[], names: Map<string, string>, memos: Map<string, PartyMemo> = new Map()): SalesOrder {
    const live = (d: StoredDoc) => d.status === 'issued' && !d.superseded;
    const deliveries = docs.filter((d) => d.kind === 'delivery' && d.orderId === o.id && live(d));
    const delivered = o.items.map((it) => deliveries.flatMap((d) => d.items).filter((x) => itemKey(x) === itemKey(it)).reduce((n, x) => n + x.quantity, 0));
    const invoices = docs.filter((d) => d.kind === 'invoice' && live(d));
    const billedOf = (d: StoredDoc) => !!d.invoiceId || invoices.some((i) => i.deliveryIds.includes(d.id));
    const allBilled = deliveries.length > 0 && deliveries.every(billedOf);
    const full = o.items.length > 0 && o.items.every((it, k) => (delivered[k] ?? 0) >= it.quantity);
    // 納品書を通さずに受注から作った請求書も、請求したものとして数える
    const direct = invoices.filter((i) => i.orderId === o.id && i.deliveryIds.length === 0);
    const status: SalesOrderStatus = o.cancelled ? 'cancelled' : full ? (allBilled ? 'invoiced' : 'delivered') : delivered.some((n) => n > 0) ? 'partial' : 'open';
    const unbilled = deliveries.filter((d) => !billedOf(d));
    const myInvoices = new Set([...direct.map((i) => i.id), ...deliveries.map((d) => d.invoiceId).filter((x): x is string => !!x)]);
    const totalQty = o.items.filter((i) => !isDiscountLine(i)).reduce((n, i) => n + i.quantity, 0);
    const doneQty = o.items.reduce((n, it, k) => (isDiscountLine(it) ? n : n + Math.min(it.quantity, delivered[k] ?? 0)), 0);
    const invoiced: SalesOrderProgress['invoiced'] = direct.length > 0 || allBilled ? 'all' : deliveries.some(billedOf) ? 'partial' : 'none';
    const receipted = docs.some((d) => d.kind === 'receipt' && live(d) && !!d.invoiceId && myInvoices.has(d.invoiceId));
    const cutoff = closingCutoff(jstToday(), memos.get(partyKey(o.party.name))?.closingDay ?? null);
    const next: SalesOrderProgress['next'] = o.cancelled ? null
      : !full && direct.length === 0 ? { label: '納品書を作る', action: 'delivery' }
        : unbilled.some((d) => d.issuedOn <= cutoff) ? { label: '請求書を作る', action: 'invoice' }
          : invoiced === 'all' && !receipted ? { label: '入金があれば領収書を作る', action: 'receipt' } : null;
    const progress: SalesOrderProgress = {
      acknowledged: docs.some((d) => d.kind === 'acknowledgement' && d.orderId === o.id && live(d)),
      deliveredRate: totalQty > 0 ? Math.min(100, Math.round((doneQty / totalQty) * 100)) : 0,
      invoiced, unbilledDeliveries: unbilled.length, receipted, next,
    };
    const { cancelled: _c, ...rest } = o;
    return { ...rest, status, delivered, progress, createdByName: names.get(o.createdBy) ?? '' };
  }

  /** 会社の取引先の覚え（締め日。名前を比べる形ごと）。 */
  private async memos(tenantId: string): Promise<Map<string, PartyMemo>> {
    const list = await this.deps.store.listParties(tenantId).catch(() => []);
    return new Map(list.map((p) => [p.key, p]));
  }

  /** 受注の一覧（新しい順）。 */
  async listOrders(who: SalesViewer, q: OrderQuery & { status?: SalesOrderStatus } = {}): Promise<SalesOrder[]> {
    const [orders, docs, names, memos] = await Promise.all([
      this.deps.store.listOrders(who.tenantId, { ...q, limit: q.status ? 2000 : q.limit ?? 200 }),
      this.deps.store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 }), this.names(who.tenantId), this.memos(who.tenantId),
    ]);
    const all = orders.map((o) => this.orderView(o, docs, names, memos));
    return (q.status ? all.filter((o) => o.status === q.status) : all).slice(0, q.limit ?? 200);
  }

  /** 受注 1 件と、つながった書類。 */
  async getOrder(who: SalesViewer, id: string): Promise<OrderDetail | null> {
    const o = await this.deps.store.getOrder(who.tenantId, id);
    if (!o) return null;
    const [docs, names] = await Promise.all([this.deps.store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 }), this.names(who.tenantId)]);
    const related = docs.filter((d) => d.orderId === o.id && !d.superseded);
    const invoiceIds = new Set(related.filter((d) => d.kind === 'delivery' && d.invoiceId).map((d) => d.invoiceId!));
    const linked = docs.filter((d) => !d.superseded && (invoiceIds.has(d.id) || (d.kind === 'receipt' && d.invoiceId && invoiceIds.has(d.invoiceId))));
    // つないだ見積書（その番号のいちばん新しい版まで）も並べる
    const quote = o.quoteId ? docs.find((d) => d.id === o.quoteId) : undefined;
    const quotes = quote ? docs.filter((d) => d.kind === 'quote' && d.number === quote.number && d.version >= quote.version) : [];
    const documents = [...new Map([...quotes, ...related, ...linked].map((d) => [d.id, d])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { order: this.orderView(o, docs, names, await this.memos(who.tenantId)), documents: documents.map((d) => this.view(d, names)) };
  }

  /** 取り込んだ元の注文書（受注を使える人なら開ける。会社の取引の記録。第42.6節）。 */
  async orderFile(who: SalesViewer, id: string): Promise<{ name: string; mime: string; bytes: Uint8Array } | null> {
    const o = await this.deps.store.getOrder(who.tenantId, id);
    if (!o?.sourceFileId) return null;
    const meta = await this.deps.repo.getFile(who.tenantId, o.sourceFileId);
    const bytes = meta ? await this.deps.files.get(who.tenantId, o.sourceFileId) : null;
    return meta && bytes ? { name: meta.name, mime: meta.mime, bytes } : null;
  }

  /** 受注の金額と、計算の食い違いの印を出す。 */
  private orderMoney(items: SalesItem[], statedTotal: number | null, rounding: 'floor' | 'round' | 'ceil'): { subtotal: number; tax: number; total: number; calc: SalesOrderFlag | null } {
    const t = docTotals(items, rounding);
    const calc = statedTotal !== null && items.every((i) => i.unitPrice !== null) && statedTotal !== t.total
      ? { kind: 'calc' as const, text: `相手の合計（${yenText(statedTotal)}）と、こちらの計算（${yenText(t.total)}）が違います` } : null;
    return { subtotal: t.subtotal, tax: t.tax, total: t.total, calc };
  }

  /**
   * 受け取った注文書を読み、受注にする（第42.5.1節・第42.5.2節）。計算・見積との違い・二重の取り込み・読めなかった項目を AI が確かめる。
   *
   * @returns 同じ注文がもうあれば、取り込まずにその受注を返す（`duplicate: true`）
   */
  async importOrder(who: SalesViewer, fileId: string, source: SalesOrderSource = 'upload', mailMessageId: string | null = null): Promise<ImportedOrder> {
    const ocr = this.deps.ocrFor ? await this.deps.ocrFor(who.tenantId).catch(() => undefined) : undefined;
    const read = await fileToText(this.deps.repo, this.deps.files, who.tenantId, fileId, who.userId, ocr);
    if (!read.ok) return { error: read.note ?? '注文書を読めませんでした' };
    if (read.text.trim().length < 20) return { error: '注文書から文字をほとんど読めませんでした（写真なら、明るく正面から撮り直してください）' };
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const company = settings.company.legalName || settings.company.shortName || '';
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const r = await readOrder(llm, read.text, company, jstToday());
    return this.saveOrder(who, { ...r, sourceFileId: fileId, source, quoteNumber: null, mailMessageId });
  }

  /**
   * 読んだ（または見積書から写した）受注を残す。二重の取り込みは残さず、既存の受注を返す。
   */
  async saveOrder(who: SalesViewer, r: {
    party: SalesParty; customerRef: string; orderedOn: string | null; dueOn: string | null; deliverTo: string; terms: string; notes: string;
    items: SalesItem[]; statedTotal: number | null; unread?: string[]; sourceFileId: string | null; source: SalesOrderSource; quoteNumber: string | null;
    /** つなぐ見積書（見積書から受注にしたとき。無ければ同じ取引先の見積書を探してつなぐ。第42.14.4節） */
    quoteId?: string | null;
    /** AI が読んだこと（「いつもの」を前の注文から読んだ、など） */
    guesses?: string[];
    /** 手で入れたときの、入っていない項目 */
    missing?: string[];
    /** 取り込んだメールの Message-ID（第42.13.1節） */
    mailMessageId?: string | null;
  }): Promise<ImportedOrder> {
    const { store } = this.deps;
    // 同じメール（何人も受け取ったもの）はもう取り込んでいれば、その受注を返す
    if (r.mailMessageId) {
      const same = (await store.listOrders(who.tenantId, { limit: 500 })).find((o) => o.mailMessageId === r.mailMessageId && !o.cancelled);
      if (same) return { order: this.orderView(same, await store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 }), await this.names(who.tenantId)), duplicate: true };
    }
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const key = partyKey(r.party.name);
    // 二重の取り込み: 同じ取引先で、相手の注文番号が同じ（無ければ同じ注文日と同じ品目）
    const existing = (await store.listOrders(who.tenantId, { limit: 500 })).filter((o) => !o.cancelled && key && partyKey(o.party.name) === key);
    // 品目と数が同じなら同じ注文とみなす（同じ日に同じ品目を数を変えて頼むことはあるため、数も比べる）
    const lineKey = (i: SalesItem) => `${itemKey(i)}:${i.quantity}`;
    const sameItems = (o: StoredOrder) => o.items.map(lineKey).sort().join('|') === r.items.map(lineKey).sort().join('|');
    // 手で入れた受注（注文書も相手の注文番号も無い）に、後から届いた注文書は、同じ品目で 14 日のうちならつなぐ（第42.5.1.1節）
    const recent = (o: StoredOrder) => Date.now() - Date.parse(o.createdAt) < 14 * 86_400_000;
    const dup = existing.find((o) => (r.customerRef && o.customerRef ? o.customerRef === r.customerRef : sameItems(o) && (
      o.orderedOn === r.orderedOn || (!!r.sourceFileId && !o.sourceFileId && !o.customerRef && recent(o)))));
    if (dup) {
      let linked = false;
      if (r.sourceFileId && !dup.sourceFileId) {
        const money = this.orderMoney(dup.items, r.statedTotal, settings.company.taxRounding);
        await store.updateOrder(who.tenantId, dup.id, {
          customerRef: dup.customerRef || r.customerRef, statedTotal: r.statedTotal, sourceFileId: r.sourceFileId,
          flags: [...dup.flags.filter((f) => f.kind !== 'calc'), ...(money.calc ? [money.calc] : [])],
        });
        await this.audit(who, 'sales_order.link_file', 'sales_order', dup.id, {});
        linked = true;
      }
      const docs = await store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 });
      const now = (await store.getOrder(who.tenantId, dup.id))!;
      return { order: this.orderView(now, docs, await this.names(who.tenantId)), duplicate: true, ...(linked ? { linked } : {}) };
    }
    // 税の区分を決める（受注の税率は目安。書類を作るときに取引の日の税率を当て直す）
    const tax = await this.classify(who, r.party.name, r.items, r.orderedOn ?? jstToday());
    const flags: SalesOrderFlag[] = [
      ...tax.judged.map((t) => ({ kind: 'guess' as const, text: t })),
      ...(r.unread ?? []).map((u) => ({ kind: 'unread' as const, text: `${u}が読み取れませんでした` })),
      ...(r.missing ?? []).map((u) => ({ kind: 'unread' as const, text: `${u}が入っていません` })),
      ...(r.guesses ?? []).map((g) => ({ kind: 'guess' as const, text: g })),
    ];
    const money = this.orderMoney(r.items, r.statedTotal, settings.company.taxRounding);
    if (money.calc) flags.push(money.calc);
    // 見積書につなぐ（渡されなければ、同じ取引先の提出済みで有効期限の内の見積書から、品目がいちばん合うものを探す）。違いは印にする
    const quote = r.quoteId ? await store.getDoc(who.tenantId, r.quoteId) : r.source === 'quote' ? null : await this.matchQuote(who.tenantId, key, r.items, r.orderedOn ?? jstToday());
    const quoteNumber = quote ? salesQuoteLabel(quote) : r.quoteNumber;
    if (quote && !r.quoteId) flags.push(...quoteFlags(r.items, quote));
    const today = jstToday();
    let id = '';
    for (let attempt = 0; attempt < 5 && !id; attempt++) {
      const number = await this.nextNumber(who.tenantId, 'order', today);
      try {
        id = await store.createOrder(who.tenantId, {
          number, party: r.party, customerRef: r.customerRef, orderedOn: r.orderedOn, dueOn: r.dueOn, deliverTo: r.deliverTo, terms: r.terms, notes: r.notes,
          items: r.items, subtotal: money.subtotal, tax: money.tax, total: money.total, statedTotal: r.statedTotal, cancelled: false, cancelReason: '',
          flags, sourceFileId: r.sourceFileId, source: r.source, quoteNumber, createdBy: who.userId,
          mailMessageId: r.mailMessageId ?? null, stock: [], dueNotifiedOn: null, quoteId: quote?.id ?? null,
        });
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
    // 支払い条件があれば、取引先の覚えにする（締め日と支払い条件。第42.4.2節）
    if (r.terms && r.party.name) await this.rememberParty(who, r.party.name, { paymentTerms: r.terms }, '注文書');
    await this.audit(who, 'sales_order.create', 'sales_order', id, { source: r.source, items: r.items.length, flags: flags.length });
    // つないだ見積書は「受注済み」にする
    if (quote && quote.outcome !== 'won') await store.updateDoc(who.tenantId, quote.id, { outcome: 'won', outcomeNote: '' });
    // 在庫管理を使う会社では、品目を在庫の品目につなぎ、取り置く（第42.13.4節）
    await this.linkStock(who, id).catch((err) => this.log.warn('受注を在庫につなげませんでした', { err }));
    const created = await store.getOrder(who.tenantId, id);
    return { order: this.orderView(created!, [], await this.names(who.tenantId)), duplicate: false };
  }

  /** 前の受注・書類・見積書の取引先の名前（新しい順・重ねない）。 */
  private async knownParties(tenantId: string): Promise<string[]> {
    const [orders, docs] = await Promise.all([this.deps.store.listOrders(tenantId, { limit: 500 }), this.deps.store.listDocs(tenantId, { limit: 500 })]);
    const names = [...orders.map((o) => o.party.name), ...docs.map((d) => d.party.name)].filter(Boolean);
    const seen = new Set<string>();
    return names.filter((n) => { const k = partyKey(n); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  }

  /**
   * 略した呼び方を、前の取引先の正式な名前に寄せる（「見本商事」→「株式会社見本商事」）。1 つに決まらなければそのまま。
   */
  async officialParty(who: SalesViewer, name: string): Promise<string> {
    const k = partyKey(name);
    if (!k) return name.trim();
    const known = await this.knownParties(who.tenantId);
    const exact = known.find((n) => partyKey(n) === k);
    if (exact) return exact;
    const near = known.filter((n) => partyKey(n).includes(k) || k.includes(partyKey(n)));
    return near.length === 1 ? near[0]! : name.trim();
  }

  /**
   * 手で入れるときの候補（第42.5.1.1節）。取引先の名前と、その取引先の前の品目（受注・納品書・請求書・見積書。多く頼まれた順）。
   *
   * @param party 取引先（無ければ会社全体の品目）
   * @param opts.ordered 実際に頼まれた品目だけ（受注と納品書。見積書と請求書は数えない。「いつもの」を読むため）
   */
  async suggestions(who: SalesViewer, party = '', opts: { ordered?: boolean } = {}): Promise<SalesSuggestions> {
    const { store } = this.deps;
    const k = party ? partyKey(await this.officialParty(who, party)) : '';
    const [orders, docs] = await Promise.all([store.listOrders(who.tenantId, { limit: 500 }), store.listDocs(who.tenantId, { limit: 500 })]);
    const mine = (name: string) => !k || partyKey(name) === k;
    // 新しい順に並べ、品目ごとに回数を数えて、単位と単価はいちばん新しいものを使う（値引きの行は数えない）
    const lines: SalesItem[] = [
      ...orders.filter((o) => !o.cancelled && mine(o.party.name)).flatMap((o) => o.items),
      ...docs.filter((d) => d.status !== 'cancelled' && (opts.ordered ? d.kind === 'delivery' : d.kind !== 'purchase_order' && d.kind !== 'receipt') && mine(d.party.name)).flatMap((d) => d.items),
    ].filter((i) => !isDiscountLine(i));
    const counted = new Map<string, SalesSuggestions['items'][number]>();
    for (const i of lines) {
      const key = itemKey(i);
      const cur = counted.get(key);
      if (cur) { cur.count++; if (cur.unitPrice === null) cur.unitPrice = i.unitPrice; continue; }
      counted.set(key, { name: i.name, code: i.code, unit: i.unit, unitPrice: i.unitPrice, taxCategory: taxCategoryOf(i), count: 1 });
    }
    // 在庫管理の販売品も候補に出す（販売価格を税抜にしたものと単位つき。第42.14.3節）
    const sale = opts.ordered ? [] : await this.saleItems(who);
    for (const x of sale) {
      const it: SalesItem = { name: x.name, code: x.sku, quantity: 1, unit: '', unitPrice: null, taxRate: 10 };
      if (counted.has(itemKey(it)) || counted.has(itemKey({ name: x.name, code: '' }))) continue;
      await this.fromStock(who, [it], [x]);
      counted.set(itemKey(it), { name: it.name, code: it.code, unit: it.unit, unitPrice: it.unitPrice, taxCategory: taxCategoryOf(it), count: 0 });
    }
    return {
      parties: (await this.knownParties(who.tenantId)).slice(0, 200),
      items: [...counted.values()].sort((a, b) => b.count - a.count).slice(0, 150),
    };
  }

  /**
   * 手で入れる（電話などで受けた注文。第42.5.1.1節）。足りない項目は聞き返さずに空けて印を付ける。
   * 品名が「いつもの」なら、その取引先の前の注文でいちばん多い品目と読み、読んだことを印にする。
   */
  async recordOrder(who: SalesViewer, input: ManualOrderInput, source: 'manual' | 'secretary'): Promise<ImportedOrder> {
    const raw = str(input.party, 100);
    if (!raw) return { error: '取引先を入れてください' };
    const name = await this.officialParty(who, raw);
    const guesses: string[] = [];
    const missing: string[] = [];
    const items: SalesItem[] = [];
    // 前の品目（「いつもの」と、空けた単位を埋めるため）
    const usual = (await this.suggestions(who, name, { ordered: true })).items;
    for (const it of (input.items ?? []).slice(0, 50)) {
      if (!str(it.name, 80)) continue;
      if (isUsualItem(it.name)) {
        const top = usual[0];
        if (!top) { missing.push('品名（「いつもの」と読める前の注文）'); continue; }
        items.push({ ...it, name: top.name, code: top.code, unit: top.unit, unitPrice: top.unitPrice, taxCategory: top.taxCategory });
        guesses.push(`「${it.name}」を ${top.name} と読みました（前の注文 ${top.count} 回）`);
        continue;
      }
      const before = usual.find((x) => itemKey(x) === itemKey(it));
      items.push({
        ...it, name: str(it.name, 80), code: str(it.code, 40) || before?.code || '', unit: str(it.unit, 10) || before?.unit || '個',
        ...(it.taxCategory ? {} : before ? { taxCategory: before.taxCategory } : {}),
      });
    }
    if (items.length === 0 && missing.length === 0) return { error: '品目を入れてください' };
    const filled = await this.fillPrices(who, name, items);
    if (filled.length) guesses.push(`前の単価を使いました: ${filled.join('、')}`);
    if (items.some((i) => i.unitPrice === null)) missing.push('単価');
    const dueOn = input.dueOn && DATE.test(input.dueOn) ? input.dueOn : null;
    if (!dueOn) missing.push('納期');
    return this.saveOrder(who, {
      party: { ...emptyParty(), name, person: str(input.person, 40) }, customerRef: str(input.customerRef, 60),
      orderedOn: input.orderedOn && DATE.test(input.orderedOn) ? input.orderedOn : jstToday(), dueOn,
      deliverTo: str(input.deliverTo, 120), terms: str(input.terms, 80), notes: str(input.notes, 300),
      items, statedTotal: null, missing, guesses, sourceFileId: null, source, quoteNumber: null,
    });
  }

  /**
   * 見積書から受注にする（第42.14.4節）。その番号のいちばん新しい版の宛先・品目・単価・値引きを写し、見積書を「受注済み」にする。
   *
   * @param ref 見積書の ID か番号
   * @returns その見積書からの受注がもうあれば、作らずにその受注を返す（`duplicate: true`）
   */
  async orderFromQuote(who: SalesViewer, ref: string): Promise<ImportedOrder> {
    const q = await this.latestQuote(who.tenantId, ref);
    if (!q) return { error: `見積書 ${ref} が見つかりません` };
    if (q.status === 'cancelled') return { error: `見積書 ${salesQuoteLabel(q)} は取り消されています` };
    const versions = await this.quoteVersions(who.tenantId, q.number!);
    const ids = new Set(versions.map((x) => x.id));
    const already = (await this.deps.store.listOrders(who.tenantId, { limit: 2000 })).find((o) => !o.cancelled && o.quoteId && ids.has(o.quoteId));
    if (already) return { order: this.orderView(already, await this.deps.store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 }), await this.names(who.tenantId)), duplicate: true };
    return this.saveOrder(who, {
      party: { ...q.party }, customerRef: '', orderedOn: jstToday(), dueOn: null, deliverTo: '', terms: q.terms, notes: '',
      items: q.items.map((i) => ({ ...i })), statedTotal: null, sourceFileId: null, source: 'quote', quoteNumber: salesQuoteLabel(q), quoteId: q.id,
    });
  }

  /**
   * 取引先のいちばん新しい提出済みの見積書から受注にする（「この前の見積でお願いします」と電話で受けたとき。第42.14.4節）。
   */
  async orderFromLatestQuote(who: SalesViewer, party: string): Promise<ImportedOrder> {
    const key = partyKey(await this.officialParty(who, party));
    if (!key) return { error: '取引先を入れてください' };
    const today = jstToday();
    const quotes = (await this.deps.store.listDocs(who.tenantId, { kind: 'quote', limit: 500 }))
      .filter((d) => partyKey(d.party.name) === key && salesQuoteState(d, today) === 'submitted');
    const q = quotes[0];
    if (!q) return { error: `${party} に出した、提出済みで有効期限の内の見積書がありません` };
    return this.orderFromQuote(who, q.id);
  }

  /**
   * 受注につなぐ見積書を直す（外す・ほかの見積書につなぎ直す。第42.14.4節）。外した見積書は、ほかの受注が無ければ提出済みに戻す。
   */
  async relinkQuote(who: SalesViewer, orderId: string, quoteRef: string | null): Promise<string | null> {
    const { store } = this.deps;
    const o = await store.getOrder(who.tenantId, orderId);
    if (!o) return '受注が見つかりません';
    const next = quoteRef ? await this.latestQuote(who.tenantId, quoteRef) : null;
    if (quoteRef && !next) return '見積書が見つかりません';
    if (next && next.status === 'cancelled') return '取り消した見積書にはつなげません';
    if (o.quoteId) {
      const old = await store.getDoc(who.tenantId, o.quoteId);
      const others = (await store.listOrders(who.tenantId, { limit: 2000 })).some((x) => x.id !== o.id && !x.cancelled && x.quoteId === o.quoteId);
      if (old && old.outcome === 'won' && !others && old.id !== next?.id) await store.updateDoc(who.tenantId, old.id, { outcome: null });
    }
    const flags = [...o.flags.filter((f) => f.kind !== 'quote'), ...(next ? quoteFlags(o.items, next) : [])];
    await store.updateOrder(who.tenantId, o.id, { quoteId: next?.id ?? null, quoteNumber: next ? salesQuoteLabel(next) : null, flags });
    if (next && next.outcome !== 'won') await store.updateDoc(who.tenantId, next.id, { outcome: 'won', outcomeNote: '' });
    await this.audit(who, 'sales_order.quote', 'sales_order', o.id, { quoteId: next?.id ?? null });
    return null;
  }

  /** 受注を直す（読み取りの直し。金額と計算の印を出し直す）。 */
  async updateOrder(who: SalesViewer, id: string, body: Record<string, unknown>): Promise<string | null> {
    const { store } = this.deps;
    const o = await store.getOrder(who.tenantId, id);
    if (!o) return '受注が見つかりません';
    if (o.cancelled) return '取り消した受注は直せません';
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const items = Array.isArray(body['items']) ? itemsFrom(body['items']) : o.items;
    const statedTotal = body['statedTotal'] === null ? null : typeof body['statedTotal'] === 'number' ? body['statedTotal'] : o.statedTotal;
    const money = this.orderMoney(items, statedTotal, settings.company.taxRounding);
    const day = (k: string, cur: string | null) => (body[k] === null ? null : typeof body[k] === 'string' && DATE.test(body[k] as string) ? body[k] as string : cur);
    const party = body['party'] && typeof body['party'] === 'object' ? { ...o.party, ...cleanParty(body['party'] as Partial<SalesParty>) } : o.party;
    // 直した項目の「読めなかった」印は外す
    const itemsChanged = Array.isArray(body['items']);
    // AI が読んだこと（「いつもの」など）の印は、品目を直したら外す
    const flags = o.flags.filter((f) => f.kind === 'quote' || f.kind === 'duplicate' || (f.kind === 'guess' && !itemsChanged)
      || (f.kind === 'unread' && f.text.startsWith('品名') && !itemsChanged)
      || (f.kind === 'unread' && !f.text.startsWith('品名') && !((f.text.startsWith('納期') && day('dueOn', o.dueOn)) || (f.text.startsWith('注文日') && day('orderedOn', o.orderedOn))
        || (f.text.startsWith('注文した会社') && party.name) || (f.text.startsWith('単価') && items.every((i) => i.unitPrice !== null)) || (f.text.startsWith('品目') && items.length))));
    if (money.calc) flags.push(money.calc);
    await store.updateOrder(who.tenantId, id, {
      party, items, statedTotal, subtotal: money.subtotal, tax: money.tax, total: money.total, flags,
      customerRef: typeof body['customerRef'] === 'string' ? str(body['customerRef'], 60) : o.customerRef,
      orderedOn: day('orderedOn', o.orderedOn), dueOn: day('dueOn', o.dueOn),
      deliverTo: typeof body['deliverTo'] === 'string' ? str(body['deliverTo'], 120) : o.deliverTo,
      terms: typeof body['terms'] === 'string' ? str(body['terms'], 80) : o.terms,
      notes: typeof body['notes'] === 'string' ? str(body['notes'], 300) : o.notes,
    });
    await this.audit(who, 'sales_order.update', 'sales_order', id, { fields: Object.keys(body).slice(0, 12) });
    // 品目を直したら、在庫のつながりを付け直す（品目の並びが変わるため。第42.13.4節）
    if (itemsChanged && o.stock.length && this.deps.inventory) {
      for (const l of o.stock) if (l.reservationId) await this.deps.inventory.release(who.tenantId, l.reservationId).catch(() => undefined);
      await store.updateOrder(who.tenantId, id, { stock: [] });
    }
    if (itemsChanged) await this.linkStock(who, id).catch(() => undefined);
    return null;
  }

  /** 受注を取り消す（理由を残す）。 */
  async cancelOrder(who: SalesViewer, id: string, reason: string): Promise<string | null> {
    const o = await this.deps.store.getOrder(who.tenantId, id);
    if (!o) return '受注が見つかりません';
    if (o.cancelled) return 'もう取り消しています';
    const why = str(reason, 200);
    if (!why) return '取り消しの理由を書いてください';
    await this.deps.store.updateOrder(who.tenantId, id, { cancelled: true, cancelReason: why });
    await this.syncHolds(who, id).catch((err) => this.log.warn('受注の取り置きを外せませんでした', { err }));
    await this.audit(who, 'sales_order.cancel', 'sales_order', id, { reason: why });
    return null;
  }

  /**
   * 受注を削除する（取り込み違いを消す。第42.5.1節）。作った人と管理者だけ。書類がつながっていれば削除せず取り消しを勧める。
   */
  async removeOrder(who: SalesViewer, id: string): Promise<string | null> {
    const o = await this.deps.store.getOrder(who.tenantId, id);
    if (!o) return '受注が見つかりません';
    if (o.createdBy !== who.userId && !(await this.isAdmin(who))) return '削除できるのは、取り込んだ人と管理者だけです';
    const docs = await this.deps.store.listDocs(who.tenantId, { orderId: id, withSuperseded: true });
    if (docs.some((d) => d.status !== 'draft')) return '発行した書類がつながっているので削除できません（取り消してください）';
    await this.deps.store.deleteOrder(who.tenantId, id);
    await this.audit(who, 'sales_order.delete', 'sales_order', id, {});
    return null;
  }

  // ───────── 在庫とのつなぎ（第42.13.4節） ─────────

  /** その人が在庫管理を使えるか。 */
  private async stockOn(who: SalesViewer): Promise<SalesInventory | null> {
    const inv = this.deps.inventory;
    if (!inv) return null;
    return (await inv.access(who.tenantId, who.userId).catch(() => null)) ? inv : null;
  }

  /**
   * 受注の品目を在庫の品目に当てる（品番が同じなら品番、無ければ名前。1 つに決まらなければつながない）。当たった品目は取り置く。
   * 足りない品目は印を付ける（取り置きは受注の数で行い、足りない分は在庫管理の発注の案に出る）
   */
  async linkStock(who: SalesViewer, orderId: string): Promise<void> {
    const inv = await this.stockOn(who);
    if (!inv) return;
    const o = await this.deps.store.getOrder(who.tenantId, orderId);
    if (!o || o.cancelled) return;
    const items = await inv.items(who.tenantId);
    const norm = (v: string) => quoteItemKey(v);
    const links: SalesStockLink[] = [...o.stock];
    for (const [index, it] of o.items.entries()) {
      if (links.some((l) => l.index === index)) continue;
      const byCode = it.code ? items.filter((x) => x.sku && x.sku.normalize('NFKC').toLowerCase() === it.code.normalize('NFKC').toLowerCase()) : [];
      const byName = items.filter((x) => norm(x.name) === norm(it.name));
      const near = byCode.length || byName.length ? [] : items.filter((x) => norm(x.name).includes(norm(it.name)) || norm(it.name).includes(norm(x.name)));
      const hit = byCode.length === 1 ? byCode[0] : byName.length === 1 ? byName[0] : near.length === 1 ? near[0] : undefined;
      if (!hit) continue;
      links.push({ index, itemId: hit.id, itemName: hit.name, held: 0, reservationId: null, availableAtLink: hit.available });
    }
    await this.deps.store.updateOrder(who.tenantId, orderId, { stock: links });
    await this.syncHolds(who, orderId);
  }

  /**
   * 受注の取り置きを、まだ納めていない数にそろえる（納品書・取り消しのたびに呼ぶ）。足りない品目は印にする。
   */
  async syncHolds(who: SalesViewer, orderId: string): Promise<void> {
    const inv = this.deps.inventory;
    if (!inv) return;
    const o = await this.deps.store.getOrder(who.tenantId, orderId);
    if (!o || o.stock.length === 0) return;
    const docs = await this.deps.store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 });
    const view = this.orderView(o, docs, new Map());
    const items = await inv.items(who.tenantId);
    const short: string[] = [];
    const links: SalesStockLink[] = [];
    for (const l of o.stock) {
      const need = o.cancelled ? 0 : Math.max(0, (o.items[l.index]?.quantity ?? 0) - (view.delivered[l.index] ?? 0));
      if (l.reservationId) await inv.release(who.tenantId, l.reservationId).catch(() => undefined);
      const available = (items.find((x) => x.id === l.itemId)?.available ?? 0) + l.held;
      const reservationId = need > 0 ? await inv.hold(who.tenantId, who.userId, { itemId: l.itemId, qty: need, ref: `受注 ${o.number}` }) : null;
      if (need > available) short.push(`${l.itemName} の在庫が ${Math.round((need - available) * 1000) / 1000} 足りません`);
      links.push({ ...l, held: need, reservationId });
    }
    const flags = [...o.flags.filter((f) => f.kind !== 'stock'), ...short.map((t) => ({ kind: 'stock' as const, text: t }))];
    await this.deps.store.updateOrder(who.tenantId, orderId, { stock: links, flags });
  }

  /** 受注の品目の在庫のつながりを直す（外す・別の品目につなぎ直す）。 */
  async relinkStock(who: SalesViewer, orderId: string, index: number, itemId: string | null): Promise<string | null> {
    const inv = await this.stockOn(who);
    if (!inv) return '在庫管理を使っていません';
    const o = await this.deps.store.getOrder(who.tenantId, orderId);
    if (!o) return '受注が見つかりません';
    if (!o.items[index]) return '品目が見つかりません';
    const cur = o.stock.find((l) => l.index === index);
    if (cur?.reservationId) await inv.release(who.tenantId, cur.reservationId).catch(() => undefined);
    const rest = o.stock.filter((l) => l.index !== index);
    if (itemId) {
      const hit = (await inv.items(who.tenantId)).find((x) => x.id === itemId);
      if (!hit) return '在庫の品目が見つかりません';
      rest.push({ index, itemId: hit.id, itemName: hit.name, held: 0, reservationId: null, availableAtLink: hit.available });
    }
    await this.deps.store.updateOrder(who.tenantId, orderId, { stock: rest.sort((a, b) => a.index - b.index) });
    await this.syncHolds(who, orderId);
    await this.audit(who, 'sales_order.stock', 'sales_order', orderId, { index, itemId });
    return null;
  }

  /** 納品書の品目のうち、受注で在庫につないだものを出庫する。記録の ID を返す。 */
  private async stockOut(who: SalesViewer, d: StoredDoc, orderId: string): Promise<string[]> {
    const inv = this.deps.inventory;
    const o = await this.deps.store.getOrder(who.tenantId, orderId);
    if (!inv || !o || o.stock.length === 0) return [];
    const moves: string[] = [];
    for (const it of d.items) {
      const index = o.items.findIndex((x) => itemKey(x) === itemKey(it));
      const link = o.stock.find((l) => l.index === index);
      if (!link || it.quantity <= 0) continue;
      const m = await inv.out(who.tenantId, who.userId, { itemId: link.itemId, qty: it.quantity, reason: `納品書 ${d.number ?? ''}`, sourceId: d.id });
      if (m) moves.push(m);
    }
    await this.syncHolds(who, orderId);
    return moves;
  }

  // ───────── メールから取り込む（第42.13.1節） ─────────

  /**
   * メールに届いた注文書を受注にする。添付があれば添付（注文書らしいものを 1 つ）、無ければ本文から読む。
   * 同じメール（同じ Message-ID）はもう取り込んでいれば、その受注を返す
   */
  async importMail(who: SalesViewer, mail: MailOrderInput): Promise<ImportedOrder> {
    const kindOf = (f: { name: string; mime: string }): 'pdf' | 'png' | 'jpeg' | 'xlsx' | 'docx' | 'csv' | null => {
      const n = f.name.toLowerCase();
      if (f.mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
      if (f.mime === 'image/png' || n.endsWith('.png')) return 'png';
      if (f.mime === 'image/jpeg' || /\.jpe?g$/.test(n)) return 'jpeg';
      if (n.endsWith('.xlsx')) return 'xlsx';
      if (n.endsWith('.docx')) return 'docx';
      if (n.endsWith('.csv')) return 'csv';
      return null;
    };
    const files = mail.files.filter((f) => kindOf(f) && f.bytes.byteLength <= 10 * 1024 * 1024);
    // 名前に「注文」「発注」が入った添付を先に使う
    const file = files.find((f) => /注文|発注|order|po/i.test(f.name)) ?? files[0];
    if (file) {
      const saved = await saveFile(this.deps.repo, this.deps.files, {
        tenantId: who.tenantId, ownerUserId: who.userId, name: file.name, kind: kindOf(file)!, bytes: file.bytes, origin: 'upload', runId: null,
      });
      return this.importOrder(who, saved.id, 'mail', mail.messageId || null);
    }
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const company = settings.company.legalName || settings.company.shortName || '';
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const r = await readOrder(llm, `${mail.subject}\n${mail.body}`.slice(0, 30_000), company, jstToday());
    if (r.items.length === 0) return { error: '品目が読み取れませんでした' };
    return this.saveOrder(who, { ...r, sourceFileId: null, source: 'mail', quoteNumber: null, mailMessageId: mail.messageId || null });
  }

  /** 未請求の納品書（朝の見回りが使う。第42.13.2節）。 */
  async unbilled(tenantId: string): Promise<SalesDocument[]> {
    const names = await this.names(tenantId);
    return (await this.unbilledDeliveries(tenantId)).map((d) => this.view(d, names));
  }

  /** 下書きの請求書に入っている納品書の ID（締めの下書きを重ねないため）。 */
  async draftedDeliveryIds(tenantId: string): Promise<Set<string>> {
    const drafts = await this.deps.store.listDocs(tenantId, { kind: 'invoice', status: 'draft', limit: 2000 });
    return new Set(drafts.flatMap((d) => d.deliveryIds));
  }

  // ───────── 取引先の覚え ─────────

  /** 取引先の締め日・支払い条件・敬称を覚える（会話・注文書・書類から。第42.4.2節）。 */
  async rememberParty(who: SalesViewer, name: string, v: { paymentTerms?: string; closingDay?: number | null; honorific?: string }, from: string): Promise<void> {
    const key = partyKey(name);
    if (!key) return;
    const cur = await this.deps.store.getParty(who.tenantId, key);
    const paymentTerms = v.paymentTerms !== undefined ? str(v.paymentTerms, 80) : cur?.paymentTerms ?? '';
    const closingDay = v.closingDay !== undefined ? v.closingDay : v.paymentTerms ? closingDayFrom(v.paymentTerms) ?? cur?.closingDay ?? null : cur?.closingDay ?? null;
    await this.deps.store.saveParty(who.tenantId, {
      key, name: str(name, 100), honorific: v.honorific !== undefined ? str(v.honorific, 4) : cur?.honorific ?? '', closingDay, paymentTerms, learnedFrom: from,
    });
  }

  /** 取引先の覚え。 */
  async party(who: SalesViewer, name: string) {
    return this.deps.store.getParty(who.tenantId, partyKey(name));
  }
}

/** 宛先の入力を整える（空の項目は上書きしない）。 */
function cleanParty(p: Partial<SalesParty> | undefined): Partial<SalesParty> {
  if (!p) return {};
  const out: Partial<SalesParty> = {};
  for (const k of ['name', 'department', 'person', 'address', 'phone', 'email'] as const) {
    const v = str(p[k], k === 'address' ? 160 : 100);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * 一部の入金の領収書の品目（第42.4.4節）。受け取った額（税込）になる税抜の額を、決まった計算で探す。
 *
 * @remarks 税率の混ざった請求書の一部の入金は、内訳を決められないので作らない
 */
function partialItems(amount: number, inv: StoredDoc, rounding: 'floor' | 'round' | 'ceil'): { items: SalesItem[] } | { error: string } {
  const rates = new Set(inv.items.map((i) => i.taxRate));
  if (rates.size > 1) return { error: '税率の混ざった請求書の一部の入金の領収書は、まだ作れません（全額で作るか、品目を指定してください）' };
  if (amount > inv.total) return { error: `受け取った額（${yenText(amount)}）が請求の合計（${yenText(inv.total)}）より多いです` };
  const rate = [...rates][0] ?? 10;
  const guess = Math.floor(amount / (1 + rate / 100));
  for (let base = guess - 2; base <= guess + 3; base++) {
    const item: SalesItem = { name: `${inv.number ?? '請求'} のお支払い（一部）`, code: '', quantity: 1, unit: '式', unitPrice: base, taxRate: rate, taxCategory: taxCategoryOf(inv.items[0] ?? {}) };
    if (docTotals([item], rounding).total === amount) return { items: [item] };
  }
  return { error: 'この額では、消費税の内訳を決められませんでした' };
}

/** 見積全体の値引きの行か。 */
export function isDiscountLine(i: Pick<SalesItem, 'name' | 'unitPrice'>): boolean {
  return i.name === SALES_QUOTE_DISCOUNT_NAME && (i.unitPrice ?? 0) <= 0;
}

/**
 * 見積全体の値引きを、税率ごとの「出精値引き」の行にする（税率ごとの金額の割合で分け、端数は最後の税率に寄せる。決まった計算）。
 *
 * @param amount 値引きの額（円。0 なら行を作らない）
 */
export function discountLines(items: SalesItem[], amount: number): SalesItem[] | { error: string } {
  if (amount <= 0) return [];
  const rates = [...new Set(items.map((i) => i.taxRate))].sort((a, b) => b - a);
  const base = rates.map((rate) => ({ rate, base: items.filter((i) => i.taxRate === rate).reduce((n, i) => n + itemAmount(i), 0), category: taxCategoryOf(items.find((i) => i.taxRate === rate)!) as TaxCategory }))
    .filter((x) => x.base > 0);
  const sum = base.reduce((n, x) => n + x.base, 0);
  if (amount > sum) return { error: `値引き（${yenText(amount)}）が、見積の金額（税抜 ${yenText(sum)}）より大きいです` };
  let left = amount;
  return base.map((x, k) => {
    const part = k === base.length - 1 ? left : Math.floor((amount * x.base) / sum);
    left -= part;
    return { name: SALES_QUOTE_DISCOUNT_NAME, code: '', quantity: 1, unit: '式', unitPrice: -part, taxRate: x.rate, taxCategory: x.category, ...(base.length > 1 ? { group: `${x.rate}% 対象` } : {}) };
  }).filter((l) => l.unitPrice !== 0);
}

/**
 * 再見積の前の版からの違い（第42.14.2節）。合計・品目ごとの単価と数・外した品目・足した品目・値引きを、決まった計算で出す。
 */
export function quoteDiff(prev: Pick<SalesDocument, 'items' | 'total'>, next: Pick<SalesDocument, 'items' | 'total'>): string[] {
  const out: string[] = [];
  const d = next.total - prev.total;
  if (d !== 0) out.push(`合計 ${yenText(prev.total)} → ${yenText(next.total)}（${d < 0 ? `${yenText(-d)} の値引き` : `${yenText(d)} 増`}）`);
  const goods = (items: SalesItem[]) => items.filter((i) => !isDiscountLine(i));
  const before = goods(prev.items);
  const after = goods(next.items);
  for (const b of before) {
    const a = after.find((x) => itemKey(x) === itemKey(b));
    if (!a) { out.push(`${b.name} を外しました`); continue; }
    if (itemAmount(a) !== itemAmount(b)) {
      if (a.quantity !== b.quantity) out.push(`${b.name} ${b.quantity} ${b.unit} → ${a.quantity} ${a.unit}`);
      if ((a.unitPrice ?? 0) !== (b.unitPrice ?? 0)) out.push(`${b.name} ${yenText(b.unitPrice ?? 0)} → ${yenText(a.unitPrice ?? 0)}`);
      if ((a.discount ?? 0) !== (b.discount ?? 0)) out.push(`${b.name} の値引き ${yenText(b.discount ?? 0)} → ${yenText(a.discount ?? 0)}`);
    }
  }
  for (const a of after) if (!before.some((x) => itemKey(x) === itemKey(a))) out.push(`${a.name} を足しました`);
  const disc = (items: SalesItem[]) => -items.filter(isDiscountLine).reduce((n, i) => n + itemAmount(i), 0);
  if (disc(prev.items) !== disc(next.items)) out.push(`出精値引き ${yenText(disc(prev.items))} → ${yenText(disc(next.items))}`);
  return out;
}

/** 受注と見積書の違いの印（単価・数・見積に無い品目・受注に無い品目。第42.5.2節）。 */
export function quoteFlags(items: SalesItem[], quote: Pick<SalesDocument, 'items' | 'number' | 'version'>): SalesOrderFlag[] {
  const label = salesQuoteLabel(quote);
  const goods = quote.items.filter((i) => !isDiscountLine(i));
  const flags: SalesOrderFlag[] = [];
  for (const it of items.filter((i) => !isDiscountLine(i))) {
    const qi = goods.find((i) => itemKey(i) === itemKey(it));
    if (!qi) { flags.push({ kind: 'quote', text: `${it.name} は見積（${label}）にありません` }); continue; }
    if (qi.unitPrice !== null && it.unitPrice !== null && qi.unitPrice !== it.unitPrice) {
      flags.push({ kind: 'quote', text: `${it.name} の単価 ${yenText(it.unitPrice)} が、見積（${label}）の ${yenText(qi.unitPrice)} と違います` });
    }
    if (qi.quantity !== it.quantity) flags.push({ kind: 'quote', text: `${it.name} の数 ${it.quantity} が、見積（${label}）の ${qi.quantity} と違います` });
  }
  for (const qi of goods) if (!items.some((i) => itemKey(i) === itemKey(qi))) flags.push({ kind: 'quote', text: `見積（${label}）の ${qi.name} が注文にありません` });
  return flags;
}

/** 品目に合う販売品（品番が同じか、名前が同じ。1 つに決まらなければ無し）。 */
function stockMatch(list: SalesStockItem[], it: Pick<SalesItem, 'name' | 'code' | 'inventoryItemId'>): SalesStockItem | undefined {
  if (it.inventoryItemId) {
    const same = list.find((x) => x.id === it.inventoryItemId);
    if (same) return same;
  }
  const code = it.code.normalize('NFKC').toLowerCase();
  const byCode = code ? list.filter((x) => x.sku && x.sku.normalize('NFKC').toLowerCase() === code) : [];
  if (byCode.length === 1) return byCode[0];
  const byName = list.filter((x) => quoteItemKey(x.name) === quoteItemKey(it.name));
  return byName.length === 1 ? byName[0] : undefined;
}

/** 在庫の数が見積の数より少ない品目の知らせ（見積書には載せない。第42.14.3節）。 */
function shortages(items: SalesItem[], sale: SalesStockItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const hit = it.inventoryItemId ? sale.find((x) => x.id === it.inventoryItemId) : undefined;
    if (hit && hit.available < it.quantity) out.push(`${it.name} の在庫が ${Math.round((it.quantity - hit.available) * 1000) / 1000} ${hit.unit || it.unit}足りません（納期に気をつけてください）`);
  }
  return out;
}

/** 「株式会社見本商事 山田様」のような宛先を、会社と担当に分ける。 */
export function partyFromTo(to: string): Partial<SalesParty> {
  const t = to.trim().replace(/\s*御中$/, '').slice(0, 100);
  if (!t) return {};
  const m = /^(.+?)[\s　]+([^\s　]+?)\s*(?:様|殿)$/.exec(t);
  if (m) return { name: m[1]!.trim(), person: m[2]!.trim() };
  if (/(?:様|殿)$/.test(t) && !/(株式会社|有限会社|合同会社|\(株\)|（株）)/.test(t)) return { person: t.replace(/\s*(?:様|殿)$/, '') };
  return { name: t.replace(/\s*(?:様|殿)$/, '') };
}
