/**
 * @file 販売の書類と受注の置き場（仕様書 第42.10節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * 書類（注文書・納品書・請求書・領収書）・受注・取引先の覚えを持つ。PDF と元の注文書はファイルの置き場に置き、ここには ID だけを持つ。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type {
  SalesDocKind, SalesDocStatus, SalesDocument, SalesItem, SalesOrder, SalesOrderFlag, SalesOrderSource, SalesParty, SalesStockLink, SalesTaxLine,
} from '@m2office/shared';

/** 置き場に持つ書類（作った人の名前は持たない。見せるときに引く）。`stockMoves` は納品書で出庫した在庫の記録（第42.13.4節） */
export type StoredDoc = Omit<SalesDocument, 'createdByName'> & { stockMoves: string[] };

/** 新しく作る書類。 */
export type NewDoc = Omit<StoredDoc, 'id' | 'createdAt' | 'updatedAt'>;

/** 直せる書類の項目。 */
export type DocPatch = Partial<Pick<StoredDoc,
  'number' | 'status' | 'superseded' | 'party' | 'subject' | 'items' | 'subtotal' | 'tax' | 'total' | 'taxLines' | 'issuedOn' | 'dueOn'
  | 'terms' | 'notes' | 'orderId' | 'invoiceId' | 'deliveryIds' | 'fileId' | 'cancelReason' | 'notices' | 'runId' | 'stockMoves'>>;

/** 置き場に持つ受注（状態と納めた数は書類から求める）。`dueNotifiedOn` は納期の見張りで知らせた日（第42.13.3節） */
export type StoredOrder = Omit<SalesOrder, 'status' | 'delivered' | 'createdByName'> & { cancelled: boolean; dueNotifiedOn: string | null };

/** 新しく作る受注。 */
export type NewOrder = Omit<StoredOrder, 'id' | 'createdAt' | 'updatedAt'>;

/** 直せる受注の項目。 */
export type OrderPatch = Partial<Pick<StoredOrder,
  'party' | 'customerRef' | 'orderedOn' | 'dueOn' | 'deliverTo' | 'terms' | 'notes' | 'items' | 'subtotal' | 'tax' | 'total' | 'statedTotal'
  | 'cancelled' | 'cancelReason' | 'flags' | 'quoteNumber' | 'sourceFileId' | 'mailMessageId' | 'stock' | 'dueNotifiedOn'>>;

/** 書類の絞り込み（第42.6節: 取引の日付・金額・取引先で探せる）。 */
export interface DocQuery {
  kind?: SalesDocKind;
  status?: SalesDocStatus;
  /** 置き換えられた古い版も含める */
  withSuperseded?: boolean;
  /** 取引先の名前の一部 */
  party?: string;
  /** 取引の日の範囲（`YYYY-MM-DD`。両端を含む） */
  from?: string;
  to?: string;
  /** 合計の範囲（円。両端を含む） */
  min?: number;
  max?: number;
  orderId?: string;
  /** 番号（版はすべて） */
  number?: string;
  limit?: number;
}

/** 受注の絞り込み。 */
export interface OrderQuery {
  /** 取引先・相手の注文番号・受注番号・品名の一部 */
  search?: string;
  limit?: number;
}

/** 取引先の覚え（第42.4.2節。会話・注文書・前の書類から AI が覚える）。 */
export interface PartyMemo {
  key: string;
  name: string;
  /** 敬称（御中・様） */
  honorific: string;
  /** 締め日（1〜28。0 は月末。分からなければ `null`） */
  closingDay: number | null;
  /** 支払い条件（「翌月末払い」など） */
  paymentTerms: string;
  /** 覚えた出どころ（会話・注文書・書類） */
  learnedFrom: string;
  updatedAt: string;
}

/** 販売の書類と受注の置き場。 */
export interface SalesDocStore {
  listDocs(tenantId: string, q?: DocQuery): Promise<StoredDoc[]>;
  getDoc(tenantId: string, id: string): Promise<StoredDoc | null>;
  createDoc(tenantId: string, d: NewDoc): Promise<string>;
  updateDoc(tenantId: string, id: string, patch: DocPatch): Promise<void>;
  deleteDoc(tenantId: string, id: string): Promise<void>;
  /** その頭（`I-20261026-`）で付けた番号のうち、いちばん大きい連番（無ければ 0） */
  lastSeq(tenantId: string, table: 'docs' | 'orders', prefix: string): Promise<number>;
  listOrders(tenantId: string, q?: OrderQuery): Promise<StoredOrder[]>;
  getOrder(tenantId: string, id: string): Promise<StoredOrder | null>;
  createOrder(tenantId: string, o: NewOrder): Promise<string>;
  updateOrder(tenantId: string, id: string, patch: OrderPatch): Promise<void>;
  deleteOrder(tenantId: string, id: string): Promise<void>;
  getParty(tenantId: string, key: string): Promise<PartyMemo | null>;
  saveParty(tenantId: string, p: Omit<PartyMemo, 'updatedAt'>): Promise<void>;
  /** メールの見回りの印（見た時刻・その日の取り込みの数）。無ければ `null` */
  getMailCursor(tenantId: string, userId: string): Promise<{ checkedAt: string; day: string | null; dayCount: number } | null>;
  setMailCursor(tenantId: string, userId: string, c: { checkedAt: string; day: string | null; dayCount: number }): Promise<void>;
  /** まだ見ていないメールの ID だけを返す */
  unseenMails(tenantId: string, userId: string, mailIds: string[]): Promise<string[]>;
  markMailSeen(tenantId: string, userId: string, mailId: string): Promise<void>;
  /** その日のその見回りを、まだしていなければ記録して `true`（日に 1 回にする） */
  claimWatchRun(tenantId: string, kind: string, day: string): Promise<boolean>;
  /** 締めの請求書の下書きを作った区切りを記録する。もう記録してあれば `false` */
  claimClosing(tenantId: string, partyKey: string, cutoff: string): Promise<boolean>;
}

/** 取引先の名前を比べる形（法人格と空白を除く）。 */
export function partyKey(name: string): string {
  return name.normalize('NFKC').replace(/株式会社|有限会社|合同会社|合資会社|合名会社|\(株\)|（株）|\(有\)|（有）|御中|様|殿|[\s　]/g, '').toLowerCase();
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const n = (v: unknown): number => Number(v ?? 0);
const party = (v: unknown): SalesParty => {
  const o = (v ?? {}) as Partial<SalesParty>;
  return { name: o.name ?? '', department: o.department ?? '', person: o.person ?? '', address: o.address ?? '', phone: o.phone ?? '', email: o.email ?? '' };
};

interface DocRow {
  id: string; kind: SalesDocKind; number: string | null; version: number; previous_id: string | null; superseded: boolean; status: SalesDocStatus;
  party: unknown; subject: string; items: SalesItem[] | null; subtotal: unknown; tax: unknown; total: unknown; tax_lines: SalesTaxLine[] | null;
  issued_on: unknown; due_on: unknown; terms: string; notes: string; order_id: string | null; invoice_id: string | null; delivery_ids: string[] | null;
  file_id: string | null; cancel_reason: string; notices: string[] | null; run_id: string | null; created_by: string; created_at: unknown; updated_at: unknown;
  stock_moves: string[] | null;
}

const toDoc = (r: DocRow): StoredDoc => ({
  id: r.id, kind: r.kind, number: r.number, version: r.version, previousId: r.previous_id, superseded: r.superseded, status: r.status,
  party: party(r.party), subject: r.subject, items: r.items ?? [], subtotal: n(r.subtotal), tax: n(r.tax), total: n(r.total), taxLines: r.tax_lines ?? [],
  issuedOn: day(r.issued_on) ?? '', dueOn: day(r.due_on), terms: r.terms, notes: r.notes, orderId: r.order_id, invoiceId: r.invoice_id,
  deliveryIds: r.delivery_ids ?? [], fileId: r.file_id, cancelReason: r.cancel_reason, notices: r.notices ?? [], runId: r.run_id,
  createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), stockMoves: r.stock_moves ?? [],
});

interface OrderRow {
  id: string; number: string; party: unknown; customer_ref: string; ordered_on: unknown; due_on: unknown; deliver_to: string; terms: string; notes: string;
  items: SalesItem[] | null; subtotal: unknown; tax: unknown; total: unknown; stated_total: unknown; cancelled: boolean; cancel_reason: string;
  flags: SalesOrderFlag[] | null; source_file_id: string | null; source: SalesOrderSource; quote_number: string | null; created_by: string;
  created_at: unknown; updated_at: unknown; mail_message_id: string | null; stock: SalesStockLink[] | null; due_notified_on: unknown;
}

const toOrder = (r: OrderRow): StoredOrder => ({
  id: r.id, number: r.number, party: party(r.party), customerRef: r.customer_ref, orderedOn: day(r.ordered_on), dueOn: day(r.due_on),
  deliverTo: r.deliver_to, terms: r.terms, notes: r.notes, items: r.items ?? [], subtotal: n(r.subtotal), tax: n(r.tax), total: n(r.total),
  statedTotal: r.stated_total === null || r.stated_total === undefined ? null : n(r.stated_total), cancelled: r.cancelled, cancelReason: r.cancel_reason,
  flags: r.flags ?? [], sourceFileId: r.source_file_id, source: r.source, quoteNumber: r.quote_number, createdBy: r.created_by,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), mailMessageId: r.mail_message_id, stock: r.stock ?? [], dueNotifiedOn: day(r.due_notified_on),
});

/** 直せる項目と列の対応（利用者の入力を列名に使わない）。jsonb の列は値を JSON にして渡す。 */
const DOC_COLUMNS: Record<keyof DocPatch, [string, boolean]> = {
  number: ['number', false], status: ['status', false], superseded: ['superseded', false], party: ['party', true], subject: ['subject', false],
  items: ['items', true], subtotal: ['subtotal', false], tax: ['tax', false], total: ['total', false], taxLines: ['tax_lines', true],
  issuedOn: ['issued_on', false], dueOn: ['due_on', false], terms: ['terms', false], notes: ['notes', false], orderId: ['order_id', false],
  invoiceId: ['invoice_id', false], deliveryIds: ['delivery_ids', true], fileId: ['file_id', false], cancelReason: ['cancel_reason', false],
  notices: ['notices', true], runId: ['run_id', false], stockMoves: ['stock_moves', true],
};
const ORDER_COLUMNS: Record<keyof OrderPatch, [string, boolean]> = {
  party: ['party', true], customerRef: ['customer_ref', false], orderedOn: ['ordered_on', false], dueOn: ['due_on', false], deliverTo: ['deliver_to', false],
  terms: ['terms', false], notes: ['notes', false], items: ['items', true], subtotal: ['subtotal', false], tax: ['tax', false], total: ['total', false],
  statedTotal: ['stated_total', false], cancelled: ['cancelled', false], cancelReason: ['cancel_reason', false], flags: ['flags', true],
  quoteNumber: ['quote_number', false], sourceFileId: ['source_file_id', false], mailMessageId: ['mail_message_id', false], stock: ['stock', true],
  dueNotifiedOn: ['due_notified_on', false],
};

/** 書類の絞り込みをメモリの上で当てる（メモリの置き場とテストのため）。 */
export function matchDoc(d: StoredDoc, q: DocQuery): boolean {
  if (q.kind && d.kind !== q.kind) return false;
  if (q.status && d.status !== q.status) return false;
  if (!q.withSuperseded && d.superseded) return false;
  if (q.party && !partyKey(d.party.name).includes(partyKey(q.party))) return false;
  if (q.from && d.issuedOn < q.from) return false;
  if (q.to && d.issuedOn > q.to) return false;
  if (q.min !== undefined && d.total < q.min) return false;
  if (q.max !== undefined && d.total > q.max) return false;
  if (q.orderId && d.orderId !== q.orderId) return false;
  if (q.number && d.number !== q.number) return false;
  return true;
}

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresSalesDocStore implements SalesDocStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 4, name: 'sales-docs' });
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query<T>(text, params);
      await c.query('commit');
      return r.rows;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async listDocs(tenantId: string, q: DocQuery = {}): Promise<StoredDoc[]> {
    const rows = await this.q<DocRow>(tenantId,
      `select * from sales_documents
        where tenant_id = $1
          and ($2::text is null or kind = $2)
          and ($3::text is null or status = $3)
          and ($4::boolean or not superseded)
          and ($5::date is null or issued_on >= $5)
          and ($6::date is null or issued_on <= $6)
          and ($7::bigint is null or total >= $7)
          and ($8::bigint is null or total <= $8)
          and ($9::text is null or order_id = $9)
          and ($10::text is null or number = $10)
        order by issued_on desc, created_at desc
        limit $11`,
      [tenantId, q.kind ?? null, q.status ?? null, !!q.withSuperseded, q.from ?? null, q.to ?? null, q.min ?? null, q.max ?? null,
        q.orderId ?? null, q.number ?? null, q.party ? 2000 : Math.min(q.limit ?? 200, 2000)]);
    const docs = rows.map(toDoc);
    // 取引先は法人格の書き方の違いをならして比べる（SQL では比べない）
    return (q.party ? docs.filter((d) => matchDoc(d, { party: q.party!, withSuperseded: true })) : docs).slice(0, q.limit ?? 200);
  }

  async getDoc(tenantId: string, id: string): Promise<StoredDoc | null> {
    const rows = await this.q<DocRow>(tenantId, 'select * from sales_documents where tenant_id = $1 and id = $2', [tenantId, id]);
    return rows[0] ? toDoc(rows[0]) : null;
  }

  async createDoc(tenantId: string, d: NewDoc): Promise<string> {
    const id = `sd-${randomUUID()}`;
    await this.q(tenantId,
      `insert into sales_documents (id, tenant_id, kind, number, version, previous_id, superseded, status, party, subject, items, subtotal, tax, total,
         tax_lines, issued_on, due_on, terms, notes, order_id, invoice_id, delivery_ids, file_id, cancel_reason, notices, run_id, created_by, stock_moves)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [id, tenantId, d.kind, d.number, d.version, d.previousId, d.superseded, d.status, JSON.stringify(d.party), d.subject, JSON.stringify(d.items),
        d.subtotal, d.tax, d.total, JSON.stringify(d.taxLines), d.issuedOn, d.dueOn, d.terms, d.notes, d.orderId, d.invoiceId,
        JSON.stringify(d.deliveryIds), d.fileId, d.cancelReason, JSON.stringify(d.notices), d.runId, d.createdBy, JSON.stringify(d.stockMoves ?? [])]);
    return id;
  }

  async updateDoc(tenantId: string, id: string, patch: DocPatch): Promise<void> {
    const keys = (Object.keys(patch) as (keyof DocPatch)[]).filter((k) => k in DOC_COLUMNS);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${DOC_COLUMNS[k][0]} = $${i + 3}`);
    const values = keys.map((k) => (DOC_COLUMNS[k][1] ? JSON.stringify(patch[k]) : patch[k]));
    await this.q(tenantId, `update sales_documents set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, ...values]);
  }

  async deleteDoc(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from sales_documents where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  async lastSeq(tenantId: string, table: 'docs' | 'orders', prefix: string): Promise<number> {
    const name = table === 'docs' ? 'sales_documents' : 'sales_orders';
    const rows = await this.q<{ number: string }>(tenantId, `select number from ${name} where tenant_id = $1 and number like $2`, [tenantId, `${prefix}%`]);
    return Math.max(0, ...rows.map((r) => Number(r.number.slice(prefix.length)) || 0));
  }

  async listOrders(tenantId: string, q: OrderQuery = {}): Promise<StoredOrder[]> {
    const rows = await this.q<OrderRow>(tenantId, 'select * from sales_orders where tenant_id = $1 order by created_at desc limit 2000', [tenantId]);
    const orders = rows.map(toOrder);
    return (q.search ? orders.filter((o) => orderMatches(o, q.search!)) : orders).slice(0, q.limit ?? 200);
  }

  async getOrder(tenantId: string, id: string): Promise<StoredOrder | null> {
    const rows = await this.q<OrderRow>(tenantId, 'select * from sales_orders where tenant_id = $1 and id = $2', [tenantId, id]);
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async createOrder(tenantId: string, o: NewOrder): Promise<string> {
    const id = `so-${randomUUID()}`;
    await this.q(tenantId,
      `insert into sales_orders (id, tenant_id, number, party, customer_ref, ordered_on, due_on, deliver_to, terms, notes, items, subtotal, tax, total,
         stated_total, cancelled, cancel_reason, flags, source_file_id, source, quote_number, created_by, mail_message_id, stock, due_notified_on)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [id, tenantId, o.number, JSON.stringify(o.party), o.customerRef, o.orderedOn, o.dueOn, o.deliverTo, o.terms, o.notes, JSON.stringify(o.items),
        o.subtotal, o.tax, o.total, o.statedTotal, o.cancelled, o.cancelReason, JSON.stringify(o.flags), o.sourceFileId, o.source, o.quoteNumber, o.createdBy,
        o.mailMessageId ?? null, JSON.stringify(o.stock ?? []), o.dueNotifiedOn ?? null]);
    return id;
  }

  async updateOrder(tenantId: string, id: string, patch: OrderPatch): Promise<void> {
    const keys = (Object.keys(patch) as (keyof OrderPatch)[]).filter((k) => k in ORDER_COLUMNS);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${ORDER_COLUMNS[k][0]} = $${i + 3}`);
    const values = keys.map((k) => (ORDER_COLUMNS[k][1] ? JSON.stringify(patch[k]) : patch[k]));
    await this.q(tenantId, `update sales_orders set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, ...values]);
  }

  async deleteOrder(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from sales_orders where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  async getParty(tenantId: string, key: string): Promise<PartyMemo | null> {
    const rows = await this.q<{ key: string; name: string; honorific: string; closing_day: number | null; payment_terms: string; learned_from: string; updated_at: unknown }>(
      tenantId, 'select * from sales_parties where tenant_id = $1 and key = $2', [tenantId, key]);
    const r = rows[0];
    return r ? { key: r.key, name: r.name, honorific: r.honorific, closingDay: r.closing_day, paymentTerms: r.payment_terms, learnedFrom: r.learned_from, updatedAt: iso(r.updated_at) } : null;
  }

  async saveParty(tenantId: string, p: Omit<PartyMemo, 'updatedAt'>): Promise<void> {
    await this.q(tenantId,
      `insert into sales_parties (tenant_id, key, name, honorific, closing_day, payment_terms, learned_from, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7, now())
       on conflict (tenant_id, key) do update set name = excluded.name, honorific = excluded.honorific, closing_day = excluded.closing_day,
         payment_terms = excluded.payment_terms, learned_from = excluded.learned_from, updated_at = now()`,
      [tenantId, p.key, p.name, p.honorific, p.closingDay, p.paymentTerms, p.learnedFrom]);
  }

  async getMailCursor(tenantId: string, userId: string): Promise<{ checkedAt: string; day: string | null; dayCount: number } | null> {
    const rows = await this.q<{ checked_at: unknown; day: unknown; day_count: number }>(tenantId, 'select * from sales_mail_cursors where tenant_id = $1 and user_id = $2', [tenantId, userId]);
    return rows[0] ? { checkedAt: iso(rows[0].checked_at), day: day(rows[0].day), dayCount: rows[0].day_count } : null;
  }

  async setMailCursor(tenantId: string, userId: string, c: { checkedAt: string; day: string | null; dayCount: number }): Promise<void> {
    await this.q(tenantId,
      `insert into sales_mail_cursors (tenant_id, user_id, checked_at, day, day_count) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, user_id) do update set checked_at = excluded.checked_at, day = excluded.day, day_count = excluded.day_count`,
      [tenantId, userId, c.checkedAt, c.day, c.dayCount]);
  }

  async unseenMails(tenantId: string, userId: string, mailIds: string[]): Promise<string[]> {
    if (mailIds.length === 0) return [];
    const rows = await this.q<{ mail_id: string }>(tenantId, 'select mail_id from sales_mail_seen where tenant_id = $1 and user_id = $2 and mail_id = any($3::text[])', [tenantId, userId, mailIds]);
    const seen = new Set(rows.map((r) => r.mail_id));
    return mailIds.filter((id) => !seen.has(id));
  }

  async markMailSeen(tenantId: string, userId: string, mailId: string): Promise<void> {
    await this.q(tenantId, 'insert into sales_mail_seen (tenant_id, user_id, mail_id) values ($1,$2,$3) on conflict do nothing', [tenantId, userId, mailId]);
  }

  async claimWatchRun(tenantId: string, kind: string, d: string): Promise<boolean> {
    const rows = await this.q<{ kind: string }>(tenantId, 'insert into sales_watch_runs (tenant_id, kind, day) values ($1,$2,$3) on conflict do nothing returning kind', [tenantId, kind, d]);
    return rows.length > 0;
  }

  async claimClosing(tenantId: string, key: string, cutoff: string): Promise<boolean> {
    const rows = await this.q<{ party_key: string }>(tenantId, 'insert into sales_closing_runs (tenant_id, party_key, cutoff) values ($1,$2,$3) on conflict do nothing returning party_key', [tenantId, key, cutoff]);
    return rows.length > 0;
  }
}

/** 受注が言葉に合うか（取引先・相手の注文番号・受注番号・品名）。 */
export function orderMatches(o: StoredOrder, search: string): boolean {
  const words = search.normalize('NFKC').split(/[\s　]+/).filter(Boolean);
  const hay = `${o.party.name} ${o.customerRef} ${o.number} ${o.items.map((i) => `${i.name} ${i.code}`).join(' ')}`.normalize('NFKC');
  return words.every((w) => hay.includes(w) || partyKey(o.party.name).includes(partyKey(w)));
}

/** テスト用のメモリの置き場。 */
export class MemorySalesDocStore implements SalesDocStore {
  private readonly docs = new Map<string, StoredDoc & { tenantId: string }>();
  private readonly orders = new Map<string, StoredOrder & { tenantId: string }>();
  private readonly parties = new Map<string, PartyMemo>();
  private readonly cursors = new Map<string, { checkedAt: string; day: string | null; dayCount: number }>();
  private readonly seen = new Set<string>();
  private readonly marks = new Set<string>();

  async listDocs(tenantId: string, q: DocQuery = {}): Promise<StoredDoc[]> {
    return [...this.docs.values()].filter((d) => d.tenantId === tenantId && matchDoc(d, q))
      .sort((a, b) => b.issuedOn.localeCompare(a.issuedOn) || b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit ?? 200).map(({ tenantId: _t, ...d }) => d);
  }

  async getDoc(tenantId: string, id: string): Promise<StoredDoc | null> {
    const d = this.docs.get(id);
    if (!d || d.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = d;
    return structuredClone(rest);
  }

  async createDoc(tenantId: string, d: NewDoc): Promise<string> {
    if (d.number && [...this.docs.values()].some((x) => x.tenantId === tenantId && x.number === d.number && x.version === d.version)) throw new Error('duplicate number');
    const id = `sd-${randomUUID()}`;
    const now = new Date(Date.now() + this.docs.size).toISOString();
    this.docs.set(id, { ...structuredClone(d), id, tenantId, createdAt: now, updatedAt: now });
    return id;
  }

  async updateDoc(tenantId: string, id: string, patch: DocPatch): Promise<void> {
    const d = this.docs.get(id);
    if (d && d.tenantId === tenantId) this.docs.set(id, { ...d, ...structuredClone(patch), updatedAt: new Date().toISOString() });
  }

  async deleteDoc(tenantId: string, id: string): Promise<void> {
    if (this.docs.get(id)?.tenantId === tenantId) this.docs.delete(id);
  }

  async lastSeq(tenantId: string, table: 'docs' | 'orders', prefix: string): Promise<number> {
    const numbers = table === 'docs' ? [...this.docs.values()].filter((d) => d.tenantId === tenantId).map((d) => d.number ?? '')
      : [...this.orders.values()].filter((o) => o.tenantId === tenantId).map((o) => o.number);
    return Math.max(0, ...numbers.filter((x) => x.startsWith(prefix)).map((x) => Number(x.slice(prefix.length)) || 0));
  }

  async listOrders(tenantId: string, q: OrderQuery = {}): Promise<StoredOrder[]> {
    return [...this.orders.values()].filter((o) => o.tenantId === tenantId && (!q.search || orderMatches(o, q.search)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit ?? 200).map(({ tenantId: _t, ...o }) => o);
  }

  async getOrder(tenantId: string, id: string): Promise<StoredOrder | null> {
    const o = this.orders.get(id);
    if (!o || o.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = o;
    return structuredClone(rest);
  }

  async createOrder(tenantId: string, o: NewOrder): Promise<string> {
    const id = `so-${randomUUID()}`;
    const now = new Date(Date.now() + this.orders.size).toISOString();
    this.orders.set(id, { ...structuredClone(o), id, tenantId, createdAt: now, updatedAt: now });
    return id;
  }

  async updateOrder(tenantId: string, id: string, patch: OrderPatch): Promise<void> {
    const o = this.orders.get(id);
    if (o && o.tenantId === tenantId) this.orders.set(id, { ...o, ...structuredClone(patch), updatedAt: new Date().toISOString() });
  }

  async deleteOrder(tenantId: string, id: string): Promise<void> {
    if (this.orders.get(id)?.tenantId === tenantId) this.orders.delete(id);
  }

  async getParty(tenantId: string, key: string): Promise<PartyMemo | null> {
    return this.parties.get(`${tenantId}:${key}`) ?? null;
  }

  async saveParty(tenantId: string, p: Omit<PartyMemo, 'updatedAt'>): Promise<void> {
    this.parties.set(`${tenantId}:${p.key}`, { ...p, updatedAt: new Date().toISOString() });
  }

  async getMailCursor(tenantId: string, userId: string) {
    return this.cursors.get(`${tenantId}:${userId}`) ?? null;
  }

  async setMailCursor(tenantId: string, userId: string, c: { checkedAt: string; day: string | null; dayCount: number }): Promise<void> {
    this.cursors.set(`${tenantId}:${userId}`, { ...c });
  }

  async unseenMails(tenantId: string, userId: string, mailIds: string[]): Promise<string[]> {
    return mailIds.filter((id) => !this.seen.has(`${tenantId}:${userId}:${id}`));
  }

  async markMailSeen(tenantId: string, userId: string, mailId: string): Promise<void> {
    this.seen.add(`${tenantId}:${userId}:${mailId}`);
  }

  async claimWatchRun(tenantId: string, kind: string, d: string): Promise<boolean> {
    const k = `run:${tenantId}:${kind}:${d}`;
    if (this.marks.has(k)) return false;
    this.marks.add(k);
    return true;
  }

  async claimClosing(tenantId: string, key: string, cutoff: string): Promise<boolean> {
    const k = `close:${tenantId}:${key}:${cutoff}`;
    if (this.marks.has(k)) return false;
    this.marks.add(k);
    return true;
  }
}
