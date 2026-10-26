/**
 * @file 販売の書類と受注の処理（仕様書 第42章、ADR-0112）。書類を作る・発行する・訂正する・取り消す・探す、受注を取り込む・直す・取り消す。
 *
 * **金額は決まった計算で出す**（推論に計算させない）。注文書・請求書・領収書は下書きで作り、発行は本人の判断で行う
 * （業務では承認の後に `sales.issue`、画面では本人の「発行」。第42.3.1節）。納品書は作ったら発行済みにする。
 * 発行した書類は書き換えず、訂正は同じ番号の新しい版、取り消しは状態で表す（第42.3.2節・第42.6節）。
 * 入金は確かめない（領収書は本人が入金を伝えたときに作る。第42.4.4節）。人に確かめを求めない（ADR-0028）。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  SALES_DOC_KIND_LABELS, SALES_DOC_NEEDS_ISSUE, SALES_DOC_PREFIX, SALES_DOCS_EXTENSION_ID, canUseAgent,
  effectiveTaxTable, guessTaxCategory, plannedTaxNote, taxCategoryNote, taxCategoryOf, taxRateOn,
  type SalesDocKind, type SalesDocsSettings, type SalesDocument, type SalesItem, type SalesOrder, type SalesOrderFlag, type SalesOrderSource,
  type SalesOrderStatus, type SalesParty, type SalesSuggestions, type TaxRateEntry,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import type { FileStore } from '../files/store.js';
import { fileToText, type OcrFn } from '../files/to-text.js';
import { saveFile } from '../files/service.js';
import { loadInvoiceStyle } from '../files/invoice-style.js';
import { quoteItemKey } from '../tools/quote.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { closingCutoff, closingDayFrom, docTotals, dueDateFrom, jstToday, yenText } from './calc.js';
import { itemsFrom, readOrder } from './extract.js';
import { docFileName, renderSalesDoc } from './render.js';
import { partyKey, type DocPatch, type DocQuery, type NewDoc, type OrderQuery, type SalesDocStore, type StoredDoc, type StoredOrder } from './store.js';

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
  logger?: Logger;
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
    return {
      doc: this.view(d, names), taxNotes, versions: versions.map((x) => this.view(x, names)), order,
      deliveries: deliveries.map((x) => this.view(x, names)), invoice: invoice ? this.view(invoice, names) : null,
      receipts: receipts.map((x) => this.view(x, names)),
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
    return `${prefix}${String(last + 1).padStart(3, '0')}`;
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

  /** 単価の無い品目に、同じ取引先の前の書類・受注・見積書の同じ品目の単価を入れる。 */
  private async fillPrices(who: SalesViewer, partyName: string, items: SalesItem[]): Promise<string[]> {
    if (!items.some((i) => i.unitPrice === null || !i.unit)) return [];
    const key = partyKey(partyName);
    const past = (await this.deps.store.listDocs(who.tenantId, { limit: 300 }))
      .filter((d) => d.status !== 'cancelled' && (!key || partyKey(d.party.name) === key)).flatMap((d) => d.items);
    const quotes = (await this.deps.repo.listQuotes(who.tenantId, { limit: 100 }))
      .filter((q) => !key || partyKey(q.toName).includes(key)).flatMap((q) => q.items.map((i) => ({ ...i, code: '' })));
    // 受注（注文書から読んだもの・手で入れたもの）の単価も使う
    const orders = (await this.deps.store.listOrders(who.tenantId, { limit: 300 }))
      .filter((o) => !o.cancelled && (!key || partyKey(o.party.name) === key)).flatMap((o) => o.items);
    const filled: string[] = [];
    for (const it of items) {
      // 単位が無ければ前の同じ品目の単位、それも無ければ「個」
      if (!it.unit) it.unit = [...past, ...orders, ...quotes].find((p) => itemKey(p) === itemKey(it) && p.unit)?.unit ?? '個';
      if (it.unitPrice !== null) continue;
      const hit = [...past, ...orders, ...quotes].find((p) => itemKey(p) === itemKey(it) && p.unitPrice !== null);
      if (hit) { it.unitPrice = hit.unitPrice; filled.push(it.name); }
    }
    return filled;
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
      orderId, invoiceId, deliveryIds, fileId: null, cancelReason: '', notices: [], runId, createdBy: who.userId,
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

  // ───────── 受注 ─────────

  /** 受注に、納品書から求めた状態と納めた数を足す。 */
  private orderView(o: StoredOrder, docs: StoredDoc[], names: Map<string, string>): SalesOrder {
    const deliveries = docs.filter((d) => d.kind === 'delivery' && d.orderId === o.id && d.status === 'issued' && !d.superseded);
    const delivered = o.items.map((it) => deliveries.flatMap((d) => d.items).filter((x) => itemKey(x) === itemKey(it)).reduce((n, x) => n + x.quantity, 0));
    const invoices = docs.filter((d) => d.kind === 'invoice' && d.status === 'issued' && !d.superseded);
    const allBilled = deliveries.length > 0 && deliveries.every((d) => d.invoiceId || invoices.some((i) => i.deliveryIds.includes(d.id)));
    const full = o.items.length > 0 && o.items.every((it, k) => (delivered[k] ?? 0) >= it.quantity);
    const status: SalesOrderStatus = o.cancelled ? 'cancelled' : full ? (allBilled ? 'invoiced' : 'delivered') : delivered.some((n) => n > 0) ? 'partial' : 'open';
    const { cancelled: _c, ...rest } = o;
    return { ...rest, status, delivered, createdByName: names.get(o.createdBy) ?? '' };
  }

  /** 受注の一覧（新しい順）。 */
  async listOrders(who: SalesViewer, q: OrderQuery & { status?: SalesOrderStatus } = {}): Promise<SalesOrder[]> {
    const [orders, docs, names] = await Promise.all([
      this.deps.store.listOrders(who.tenantId, { ...q, limit: q.status ? 2000 : q.limit ?? 200 }),
      this.deps.store.listDocs(who.tenantId, { withSuperseded: true, limit: 2000 }), this.names(who.tenantId),
    ]);
    const all = orders.map((o) => this.orderView(o, docs, names));
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
    const documents = [...new Map([...related, ...linked].map((d) => [d.id, d])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { order: this.orderView(o, docs, names), documents: documents.map((d) => this.view(d, names)) };
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
  async importOrder(who: SalesViewer, fileId: string, source: SalesOrderSource = 'upload'): Promise<ImportedOrder> {
    const ocr = this.deps.ocrFor ? await this.deps.ocrFor(who.tenantId).catch(() => undefined) : undefined;
    const read = await fileToText(this.deps.repo, this.deps.files, who.tenantId, fileId, who.userId, ocr);
    if (!read.ok) return { error: read.note ?? '注文書を読めませんでした' };
    if (read.text.trim().length < 20) return { error: '注文書から文字をほとんど読めませんでした（写真なら、明るく正面から撮り直してください）' };
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const company = settings.company.legalName || settings.company.shortName || '';
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const r = await readOrder(llm, read.text, company, jstToday());
    return this.saveOrder(who, { ...r, sourceFileId: fileId, source, quoteNumber: null });
  }

  /**
   * 読んだ（または見積書から写した）受注を残す。二重の取り込みは残さず、既存の受注を返す。
   */
  async saveOrder(who: SalesViewer, r: {
    party: SalesParty; customerRef: string; orderedOn: string | null; dueOn: string | null; deliverTo: string; terms: string; notes: string;
    items: SalesItem[]; statedTotal: number | null; unread?: string[]; sourceFileId: string | null; source: SalesOrderSource; quoteNumber: string | null;
    /** AI が読んだこと（「いつもの」を前の注文から読んだ、など） */
    guesses?: string[];
    /** 手で入れたときの、入っていない項目 */
    missing?: string[];
  }): Promise<ImportedOrder> {
    const { store } = this.deps;
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
    // 見積との違い（同じ取引先の見積書の同じ品目の単価）
    let quoteNumber = r.quoteNumber;
    const quotes = key ? (await this.deps.repo.listQuotes(who.tenantId, { limit: 100 })).filter((q) => partyKey(q.toName).includes(key)) : [];
    for (const it of r.items) {
      const q = quotes.find((x) => x.items.some((i) => quoteItemKey(i.name) === quoteItemKey(it.name)));
      const qi = q?.items.find((i) => quoteItemKey(i.name) === quoteItemKey(it.name));
      if (!q || !qi) continue;
      quoteNumber = quoteNumber ?? q.number;
      if (qi.unitPrice !== null && it.unitPrice !== null && qi.unitPrice !== it.unitPrice) {
        flags.push({ kind: 'quote', text: `${it.name} の単価 ${yenText(it.unitPrice)} が、見積（${q.number}）の ${yenText(qi.unitPrice)} と違います` });
      }
    }
    const today = jstToday();
    let id = '';
    for (let attempt = 0; attempt < 5 && !id; attempt++) {
      const number = await this.nextNumber(who.tenantId, 'order', today);
      try {
        id = await store.createOrder(who.tenantId, {
          number, party: r.party, customerRef: r.customerRef, orderedOn: r.orderedOn, dueOn: r.dueOn, deliverTo: r.deliverTo, terms: r.terms, notes: r.notes,
          items: r.items, subtotal: money.subtotal, tax: money.tax, total: money.total, statedTotal: r.statedTotal, cancelled: false, cancelReason: '',
          flags, sourceFileId: r.sourceFileId, source: r.source, quoteNumber, createdBy: who.userId,
        });
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
    // 支払い条件があれば、取引先の覚えにする（締め日と支払い条件。第42.4.2節）
    if (r.terms && r.party.name) await this.rememberParty(who, r.party.name, { paymentTerms: r.terms }, '注文書');
    await this.audit(who, 'sales_order.create', 'sales_order', id, { source: r.source, items: r.items.length, flags: flags.length });
    const created = await store.getOrder(who.tenantId, id);
    return { order: this.orderView(created!, [], await this.names(who.tenantId)), duplicate: false };
  }

  /** 前の受注・書類・見積書の取引先の名前（新しい順・重ねない）。 */
  private async knownParties(tenantId: string): Promise<string[]> {
    const [orders, docs, quotes] = await Promise.all([
      this.deps.store.listOrders(tenantId, { limit: 500 }), this.deps.store.listDocs(tenantId, { limit: 500 }), this.deps.repo.listQuotes(tenantId, { limit: 200 }),
    ]);
    const names = [...orders.map((o) => o.party.name), ...docs.map((d) => d.party.name), ...quotes.map((q) => q.toName.replace(/\s*(御中|様|殿)$/, ''))].filter(Boolean);
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
    const [orders, docs, quotes] = await Promise.all([
      store.listOrders(who.tenantId, { limit: 500 }), store.listDocs(who.tenantId, { limit: 500 }), this.deps.repo.listQuotes(who.tenantId, { limit: 200 }),
    ]);
    const mine = (name: string) => !k || partyKey(name) === k;
    // 新しい順に並べ、品目ごとに回数を数えて、単位と単価はいちばん新しいものを使う
    const lines: SalesItem[] = [
      ...orders.filter((o) => !o.cancelled && mine(o.party.name)).flatMap((o) => o.items),
      ...docs.filter((d) => d.status !== 'cancelled' && (opts.ordered ? d.kind === 'delivery' : d.kind !== 'purchase_order' && d.kind !== 'receipt') && mine(d.party.name)).flatMap((d) => d.items),
      ...(opts.ordered ? [] : quotes.filter((q) => mine(q.toName.replace(/\s*(御中|様|殿)$/, ''))).flatMap((q) => q.items.map((i) => ({ ...i, code: '' })))),
    ];
    const counted = new Map<string, SalesSuggestions['items'][number]>();
    for (const i of lines) {
      const key = itemKey(i);
      const cur = counted.get(key);
      if (cur) { cur.count++; if (cur.unitPrice === null) cur.unitPrice = i.unitPrice; continue; }
      counted.set(key, { name: i.name, code: i.code, unit: i.unit, unitPrice: i.unitPrice, taxCategory: taxCategoryOf(i), count: 1 });
    }
    return {
      parties: (await this.knownParties(who.tenantId)).slice(0, 200),
      items: [...counted.values()].sort((a, b) => b.count - a.count).slice(0, 100),
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

  /** 見積書から受注にする（第42.2節）。 */
  async orderFromQuote(who: SalesViewer, quoteNumber: string): Promise<ImportedOrder> {
    const q = (await this.deps.repo.listQuotes(who.tenantId, { limit: 200 })).find((x) => x.number === quoteNumber.trim());
    if (!q) return { error: `見積書 ${quoteNumber} が見つかりません` };
    const name = q.toName.replace(/\s*(御中|様|殿)$/, '');
    return this.saveOrder(who, {
      party: { ...emptyParty(), name }, customerRef: '', orderedOn: jstToday(), dueOn: null, deliverTo: '', terms: '', notes: '',
      items: q.items.map((i) => ({ ...i, code: '' })), statedTotal: null, sourceFileId: null, source: 'quote', quoteNumber: q.number,
    });
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
