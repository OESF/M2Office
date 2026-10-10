/**
 * @file 在庫管理と販売管理のつなぎ（仕様書 第29.20.1節、ADR-0087）。販売管理（レジ・POS・EC）が鍵で商品の一覧を読み、販売を知らせる。
 *
 * - つなぎごとに鍵（一度だけ見せ、ハッシュだけを持つ）と、管理者が承認した渡す範囲（品目・数か状態か・販売価格・社員価格）を持つ
 * - 一覧は承認した範囲だけを返す。`updatedSince` で変わった品目だけ、`categories` で分類を絞れる。外れた品目は `active: false`
 * - 販売の通知は、注文で取り置き・販売で使用・取り消しで戻し・返品で入庫する。`eventId` で二重に数えない
 * - 品目は ID → 自社のコード → バーコードの順に決まった規則で照らす。照らせない行は残し、人が品目を選べばその時点で記録する
 *
 * 金額・支払い・お客様の情報は受け取らず、持たない（第29.17節・第29.18節）。通知の本文は持たず、中身のハッシュだけを持つ。
 * 通知の中身はデータとして扱い、指示として読まない（不変則 I-6）。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  INVENTORY_SALES_LINK_MAX, type AuditEvent, type InventoryItemView, type InventorySaleUnmatched, type InventorySalesLink, type InventorySalesScope,
} from '@m2office/shared';
import { createPool } from '../repository/pool.js';
import type { Repository } from '../repository/types.js';
import { dateIn } from '../cards/service.js';
import { parseCode } from './gs1.js';
import type { InventoryService } from './service.js';
import type { MemoryInventoryStore } from './store.js';

/** 本文の大きさの上限（バイト）。 */
export const SALES_PAYLOAD_MAX_BYTES = 64 * 1024;
/** 通知 1 つの行の上限。 */
export const SALES_LINES_MAX = 200;
/** つなぎごとの、1 分あたりの呼び出しの上限。 */
export const SALES_RATE_PER_MINUTE = 120;
/** 一覧の 1 回の数の既定と上限。 */
const LIST_DEFAULT = 200;
const LIST_MAX = 500;
/** 絞り込みの数の上限。 */
const FILTER_MAX = { categories: 20, ids: 100, codes: 100, barcodes: 100 } as const;
/** 処理の途中の通知を、やり直してよいとみなすまでの時間（ミリ秒）。 */
const STALE_EVENT_MS = 5 * 60_000;
/** 範囲から外した品目を覚えておく数。 */
const REMOVED_KEEP = 500;

/** 鍵のハッシュ（SHA-256）。 */
export function salesKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// ---- 置き場 ----

/** つなぎの記録（鍵のハッシュを含む）。 */
export interface SalesLinkRecord {
  id: string;
  name: string;
  keyHash: string;
  status: 'active' | 'stopped';
  scope: InventorySalesScope | null;
  approvedBy: string | null;
  approvedAt: string | null;
  removed: { itemId: string; at: string }[];
  createdBy: string;
  createdAt: string;
  lastReadAt: string | null;
  lastEventAt: string | null;
}

/** 販売の記録。 */
export interface SaleRecord {
  id: string;
  linkId: string;
  saleRef: string;
  status: 'ordered' | 'sold' | 'cancelled';
  holdIds: string[];
  /** 使用の記録の組ごとに、その中の記録 1 つの ID（取り消しで組ごと戻す）。 */
  soldMoves: string[];
  createdAt: string;
  updatedAt: string;
}

/** 照らせなかった行の記録。 */
export interface UnmatchedRecord {
  id: string;
  linkId: string;
  saleId: string;
  action: 'hold' | 'use' | 'return';
  itemRef: string;
  code: string;
  barcode: string;
  qty: number;
  reason: string;
  status: 'open' | 'resolved' | 'dropped';
  createdAt: string;
}

/** 届いた通知の記録。 */
export interface SaleEventRecord {
  bodyHash: string;
  response: SaleEventResult | null;
  createdAt: string;
}

/** つなぎの置き場。 */
export interface SalesStore {
  listLinks(tenantId: string): Promise<SalesLinkRecord[]>;
  getLink(tenantId: string, id: string): Promise<SalesLinkRecord | null>;
  createLink(tenantId: string, link: SalesLinkRecord): Promise<void>;
  updateLink(tenantId: string, id: string, patch: Partial<Omit<SalesLinkRecord, 'id' | 'createdBy' | 'createdAt'>>): Promise<void>;
  deleteLink(tenantId: string, id: string): Promise<void>;
  /** 会社の判定より前に、鍵のハッシュから会社とつなぎを 1 行だけ引く。 */
  findLinkByHash(keyHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null>;
  getSale(tenantId: string, linkId: string, saleRef: string): Promise<SaleRecord | null>;
  getSaleById(tenantId: string, id: string): Promise<SaleRecord | null>;
  saveSale(tenantId: string, sale: SaleRecord): Promise<void>;
  addUnmatched(tenantId: string, rows: UnmatchedRecord[]): Promise<void>;
  listUnmatched(tenantId: string, opts: { status?: UnmatchedRecord['status']; linkId?: string; limit?: number }): Promise<(UnmatchedRecord & { saleRef: string })[]>;
  getUnmatched(tenantId: string, id: string): Promise<UnmatchedRecord | null>;
  setUnmatched(tenantId: string, id: string, status: 'resolved' | 'dropped', userId: string | null, at: string): Promise<void>;
  /** 販売の、選ぶのを待っている行を「要らなくなった」にする（取り消し・送り直しのとき）。`action` を渡せばその種類だけ。 */
  dropUnmatched(tenantId: string, saleId: string, at: string, action?: UnmatchedRecord['action']): Promise<void>;
  countOpenUnmatched(tenantId: string): Promise<Map<string, number>>;
  getEvent(tenantId: string, linkId: string, eventRef: string): Promise<SaleEventRecord | null>;
  /** 通知を記録し始める。すでにあれば `false`。 */
  claimEvent(tenantId: string, linkId: string, eventRef: string, bodyHash: string, at: string): Promise<boolean>;
  /** 処理の途中のまま古くなった通知を、やり直すために取り直す。取り直せたら `true`。 */
  reclaimEvent(tenantId: string, linkId: string, eventRef: string, staleBefore: string, at: string): Promise<boolean>;
  finishEvent(tenantId: string, linkId: string, eventRef: string, response: SaleEventResult): Promise<void>;
  countEvents(tenantId: string, since: string): Promise<Map<string, number>>;
  /**
   * 品目ごとの、使える数や中身が最後に変わった時刻（品目の変更・入出庫の記録・取り置きの出し入れのうち最も新しいもの）。
   */
  changedAt(tenantId: string, itemIds: string[]): Promise<Map<string, string>>;
}

interface LinkRow {
  id: string; name: string; key_hash: string; status: 'active' | 'stopped'; scope: InventorySalesScope | null; approved_by: string | null;
  approved_at: unknown; removed: { itemId: string; at: string }[] | null; created_by: string; created_at: unknown; last_read_at: unknown; last_event_at: unknown;
}
interface SaleRow { id: string; link_id: string; sale_ref: string; status: SaleRecord['status']; hold_ids: string[]; sold_batches: string[]; created_at: unknown; updated_at: unknown }
interface UnmatchedRow {
  id: string; link_id: string; sale_id: string; action: UnmatchedRecord['action']; item_ref: string; code: string; barcode: string; qty: unknown;
  reason: string; status: UnmatchedRecord['status']; created_at: unknown; sale_ref?: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toLink = (r: LinkRow): SalesLinkRecord => ({
  id: r.id, name: r.name, keyHash: r.key_hash, status: r.status, scope: r.scope, approvedBy: r.approved_by, approvedAt: isoOrNull(r.approved_at),
  removed: r.removed ?? [], createdBy: r.created_by, createdAt: iso(r.created_at), lastReadAt: isoOrNull(r.last_read_at), lastEventAt: isoOrNull(r.last_event_at),
});
const toSale = (r: SaleRow): SaleRecord => ({
  id: r.id, linkId: r.link_id, saleRef: r.sale_ref, status: r.status, holdIds: r.hold_ids ?? [], soldMoves: r.sold_batches ?? [],
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const toUnmatched = (r: UnmatchedRow): UnmatchedRecord & { saleRef: string } => ({
  id: r.id, linkId: r.link_id, saleId: r.sale_id, action: r.action, itemRef: r.item_ref, code: r.code, barcode: r.barcode, qty: Number(r.qty),
  reason: r.reason, status: r.status, createdAt: iso(r.created_at), saleRef: r.sale_ref ?? '',
});

/**
 * PostgreSQL のつなぎの置き場。
 *
 * @remarks 問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する（行単位の制限。移行 119）
 */
export class PostgresSalesStore implements SalesStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 3, name: 'inventory-sales' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const { rows } = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listLinks(tenantId: string): Promise<SalesLinkRecord[]> {
    return (await this.q<LinkRow>(tenantId, 'select * from inventory_sales_links where tenant_id = $1 order by created_at', [tenantId])).map(toLink);
  }

  async getLink(tenantId: string, id: string): Promise<SalesLinkRecord | null> {
    const [r] = await this.q<LinkRow>(tenantId, 'select * from inventory_sales_links where tenant_id = $1 and id = $2', [tenantId, id]);
    return r ? toLink(r) : null;
  }

  async createLink(tenantId: string, l: SalesLinkRecord): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_sales_links (id, tenant_id, name, key_hash, status, scope, approved_by, approved_at, removed, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [l.id, tenantId, l.name, l.keyHash, l.status, l.scope ? JSON.stringify(l.scope) : null, l.approvedBy, l.approvedAt, JSON.stringify(l.removed), l.createdBy, l.createdAt]);
  }

  async updateLink(tenantId: string, id: string, patch: Partial<Omit<SalesLinkRecord, 'id' | 'createdBy' | 'createdAt'>>): Promise<void> {
    const cols: Record<string, string> = {
      name: 'name', keyHash: 'key_hash', status: 'status', scope: 'scope', approvedBy: 'approved_by', approvedAt: 'approved_at',
      removed: 'removed', lastReadAt: 'last_read_at', lastEventAt: 'last_event_at',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      params.push(k === 'scope' || k === 'removed' ? (v === null ? null : JSON.stringify(v)) : v);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.q(tenantId, `update inventory_sales_links set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async deleteLink(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from inventory_sales_links where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  async findLinkByHash(keyHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null> {
    // 会社の判定より前に呼ぶ。鍵のハッシュで 1 行だけ返す関数を使う（移行 119）
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ id: string; tenant_id: string; status: 'active' | 'stopped' }>('select id, tenant_id, status from m2o_inventory_sales_link($1)', [keyHash]);
      const r = rows[0];
      return r ? { id: r.id, tenantId: r.tenant_id, status: r.status } : null;
    } finally {
      client.release();
    }
  }

  async getSale(tenantId: string, linkId: string, saleRef: string): Promise<SaleRecord | null> {
    const [r] = await this.q<SaleRow>(tenantId, 'select * from inventory_sales where tenant_id = $1 and link_id = $2 and sale_ref = $3', [tenantId, linkId, saleRef]);
    return r ? toSale(r) : null;
  }

  async getSaleById(tenantId: string, id: string): Promise<SaleRecord | null> {
    const [r] = await this.q<SaleRow>(tenantId, 'select * from inventory_sales where tenant_id = $1 and id = $2', [tenantId, id]);
    return r ? toSale(r) : null;
  }

  async saveSale(tenantId: string, s: SaleRecord): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_sales (id, tenant_id, link_id, sale_ref, status, hold_ids, sold_batches, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set status = excluded.status, hold_ids = excluded.hold_ids, sold_batches = excluded.sold_batches, updated_at = excluded.updated_at
       where inventory_sales.tenant_id = excluded.tenant_id`,
      [s.id, tenantId, s.linkId, s.saleRef, s.status, JSON.stringify(s.holdIds), JSON.stringify(s.soldMoves), s.createdAt, s.updatedAt]);
  }

  async addUnmatched(tenantId: string, rows: UnmatchedRecord[]): Promise<void> {
    for (const u of rows) {
      await this.q(tenantId,
        `insert into inventory_sale_unmatched (id, tenant_id, link_id, sale_id, action, item_ref, code, barcode, qty, reason, status, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [u.id, tenantId, u.linkId, u.saleId, u.action, u.itemRef, u.code, u.barcode, u.qty, u.reason, u.status, u.createdAt]);
    }
  }

  async listUnmatched(tenantId: string, opts: { status?: UnmatchedRecord['status']; linkId?: string; limit?: number }): Promise<(UnmatchedRecord & { saleRef: string })[]> {
    const params: unknown[] = [tenantId];
    let where = 'u.tenant_id = $1';
    if (opts.status) { params.push(opts.status); where += ` and u.status = $${params.length}`; }
    if (opts.linkId) { params.push(opts.linkId); where += ` and u.link_id = $${params.length}`; }
    params.push(Math.min(500, opts.limit ?? 200));
    return (await this.q<UnmatchedRow>(tenantId,
      `select u.*, s.sale_ref from inventory_sale_unmatched u join inventory_sales s on s.tenant_id = u.tenant_id and s.id = u.sale_id
        where ${where} order by u.created_at desc limit $${params.length}`, params)).map(toUnmatched);
  }

  async getUnmatched(tenantId: string, id: string): Promise<UnmatchedRecord | null> {
    const [r] = await this.q<UnmatchedRow>(tenantId, 'select * from inventory_sale_unmatched where tenant_id = $1 and id = $2', [tenantId, id]);
    return r ? toUnmatched(r) : null;
  }

  async setUnmatched(tenantId: string, id: string, status: 'resolved' | 'dropped', userId: string | null, at: string): Promise<void> {
    await this.q(tenantId, `update inventory_sale_unmatched set status = $3, resolved_by = $4, resolved_at = $5 where tenant_id = $1 and id = $2 and status = 'open'`,
      [tenantId, id, status, userId, at]);
  }

  async dropUnmatched(tenantId: string, saleId: string, at: string, action?: UnmatchedRecord['action']): Promise<void> {
    await this.q(tenantId,
      `update inventory_sale_unmatched set status = 'dropped', resolved_at = $3 where tenant_id = $1 and sale_id = $2 and status = 'open'${action ? ' and action = $4' : ''}`,
      action ? [tenantId, saleId, at, action] : [tenantId, saleId, at]);
  }

  async countOpenUnmatched(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.q<{ link_id: string; n: string }>(tenantId,
      `select link_id, count(*) as n from inventory_sale_unmatched where tenant_id = $1 and status = 'open' group by link_id`, [tenantId]);
    return new Map(rows.map((r) => [r.link_id, Number(r.n)]));
  }

  async getEvent(tenantId: string, linkId: string, eventRef: string): Promise<SaleEventRecord | null> {
    const [r] = await this.q<{ body_hash: string; response: SaleEventResult | null; created_at: unknown }>(tenantId,
      'select body_hash, response, created_at from inventory_sale_events where tenant_id = $1 and link_id = $2 and event_ref = $3', [tenantId, linkId, eventRef]);
    return r ? { bodyHash: r.body_hash, response: r.response, createdAt: iso(r.created_at) } : null;
  }

  async claimEvent(tenantId: string, linkId: string, eventRef: string, bodyHash: string, at: string): Promise<boolean> {
    const rows = await this.q(tenantId,
      `insert into inventory_sale_events (tenant_id, link_id, event_ref, body_hash, created_at) values ($1,$2,$3,$4,$5)
       on conflict do nothing returning event_ref`, [tenantId, linkId, eventRef, bodyHash, at]);
    return rows.length === 1;
  }

  async reclaimEvent(tenantId: string, linkId: string, eventRef: string, staleBefore: string, at: string): Promise<boolean> {
    const rows = await this.q(tenantId,
      `update inventory_sale_events set created_at = $5 where tenant_id = $1 and link_id = $2 and event_ref = $3 and response is null and created_at < $4
       returning event_ref`, [tenantId, linkId, eventRef, staleBefore, at]);
    return rows.length === 1;
  }

  async finishEvent(tenantId: string, linkId: string, eventRef: string, response: SaleEventResult): Promise<void> {
    await this.q(tenantId, 'update inventory_sale_events set response = $4 where tenant_id = $1 and link_id = $2 and event_ref = $3',
      [tenantId, linkId, eventRef, JSON.stringify(response)]);
  }

  async countEvents(tenantId: string, since: string): Promise<Map<string, number>> {
    const rows = await this.q<{ link_id: string; n: string }>(tenantId,
      'select link_id, count(*) as n from inventory_sale_events where tenant_id = $1 and created_at >= $2 group by link_id', [tenantId, since]);
    return new Map(rows.map((r) => [r.link_id, Number(r.n)]));
  }

  async changedAt(tenantId: string, itemIds: string[]): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();
    const rows = await this.q<{ id: string; at: unknown }>(tenantId,
      `select i.id, greatest(i.updated_at,
          (select max(m.created_at) from inventory_moves m where m.tenant_id = i.tenant_id and m.item_id = i.id),
          (select max(greatest(r.created_at, coalesce(r.closed_at, r.created_at))) from inventory_reservations r where r.tenant_id = i.tenant_id and r.item_id = i.id)) as at
         from inventory_items i where i.tenant_id = $1 and i.id = any($2::text[])`, [tenantId, itemIds]);
    return new Map(rows.map((r) => [r.id, iso(r.at)]));
  }
}

/** メモリの置き場（試験用）。在庫のメモリの置き場を渡すと、`changedAt` をそこから求める。 */
export class MemorySalesStore implements SalesStore {
  readonly links = new Map<string, SalesLinkRecord & { tenantId: string }>();
  readonly sales = new Map<string, SaleRecord & { tenantId: string }>();
  readonly unmatched = new Map<string, UnmatchedRecord & { tenantId: string }>();
  readonly events = new Map<string, SaleEventRecord & { tenantId: string; linkId: string }>();

  constructor(private readonly inventory?: MemoryInventoryStore) {}

  async listLinks(tenantId: string): Promise<SalesLinkRecord[]> {
    return [...this.links.values()].filter((l) => l.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ tenantId: _t, ...l }) => ({ ...l }));
  }

  async getLink(tenantId: string, id: string): Promise<SalesLinkRecord | null> {
    const l = this.links.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = l;
    return { ...rest, removed: [...rest.removed] };
  }

  async createLink(tenantId: string, link: SalesLinkRecord): Promise<void> {
    this.links.set(link.id, { ...link, tenantId });
  }

  async updateLink(tenantId: string, id: string, patch: Partial<Omit<SalesLinkRecord, 'id' | 'createdBy' | 'createdAt'>>): Promise<void> {
    const l = this.links.get(id);
    if (!l || l.tenantId !== tenantId) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (l as unknown as Record<string, unknown>)[k] = v;
  }

  async deleteLink(tenantId: string, id: string): Promise<void> {
    if (this.links.get(id)?.tenantId === tenantId) this.links.delete(id);
  }

  async findLinkByHash(keyHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null> {
    const l = [...this.links.values()].find((x) => x.keyHash === keyHash);
    return l ? { id: l.id, tenantId: l.tenantId, status: l.status } : null;
  }

  async getSale(tenantId: string, linkId: string, saleRef: string): Promise<SaleRecord | null> {
    const s = [...this.sales.values()].find((x) => x.tenantId === tenantId && x.linkId === linkId && x.saleRef === saleRef);
    return s ? { ...s, holdIds: [...s.holdIds], soldMoves: [...s.soldMoves] } : null;
  }

  async getSaleById(tenantId: string, id: string): Promise<SaleRecord | null> {
    const s = this.sales.get(id);
    return s && s.tenantId === tenantId ? { ...s, holdIds: [...s.holdIds], soldMoves: [...s.soldMoves] } : null;
  }

  async saveSale(tenantId: string, sale: SaleRecord): Promise<void> {
    this.sales.set(sale.id, { ...sale, tenantId });
  }

  async addUnmatched(tenantId: string, rows: UnmatchedRecord[]): Promise<void> {
    for (const r of rows) this.unmatched.set(r.id, { ...r, tenantId });
  }

  async listUnmatched(tenantId: string, opts: { status?: UnmatchedRecord['status']; linkId?: string; limit?: number }): Promise<(UnmatchedRecord & { saleRef: string })[]> {
    return [...this.unmatched.values()]
      .filter((u) => u.tenantId === tenantId && (!opts.status || u.status === opts.status) && (!opts.linkId || u.linkId === opts.linkId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts.limit ?? 200)
      .map(({ tenantId: _t, ...u }) => ({ ...u, saleRef: this.sales.get(u.saleId)?.saleRef ?? '' }));
  }

  async getUnmatched(tenantId: string, id: string): Promise<UnmatchedRecord | null> {
    const u = this.unmatched.get(id);
    if (!u || u.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = u;
    return rest;
  }

  async setUnmatched(tenantId: string, id: string, status: 'resolved' | 'dropped'): Promise<void> {
    const u = this.unmatched.get(id);
    if (u && u.tenantId === tenantId && u.status === 'open') u.status = status;
  }

  async dropUnmatched(tenantId: string, saleId: string, _at: string, action?: UnmatchedRecord['action']): Promise<void> {
    for (const u of this.unmatched.values()) if (u.tenantId === tenantId && u.saleId === saleId && u.status === 'open' && (!action || u.action === action)) u.status = 'dropped';
  }

  async countOpenUnmatched(tenantId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const u of this.unmatched.values()) if (u.tenantId === tenantId && u.status === 'open') out.set(u.linkId, (out.get(u.linkId) ?? 0) + 1);
    return out;
  }

  private eventKey = (tenantId: string, linkId: string, ref: string) => `${tenantId}\u0000${linkId}\u0000${ref}`;

  async getEvent(tenantId: string, linkId: string, eventRef: string): Promise<SaleEventRecord | null> {
    const e = this.events.get(this.eventKey(tenantId, linkId, eventRef));
    return e ? { bodyHash: e.bodyHash, response: e.response, createdAt: e.createdAt } : null;
  }

  async claimEvent(tenantId: string, linkId: string, eventRef: string, bodyHash: string, at: string): Promise<boolean> {
    const k = this.eventKey(tenantId, linkId, eventRef);
    if (this.events.has(k)) return false;
    this.events.set(k, { tenantId, linkId, bodyHash, response: null, createdAt: at });
    return true;
  }

  async reclaimEvent(tenantId: string, linkId: string, eventRef: string, staleBefore: string, at: string): Promise<boolean> {
    const e = this.events.get(this.eventKey(tenantId, linkId, eventRef));
    if (!e || e.response || e.createdAt >= staleBefore) return false;
    e.createdAt = at;
    return true;
  }

  async finishEvent(tenantId: string, linkId: string, eventRef: string, response: SaleEventResult): Promise<void> {
    const e = this.events.get(this.eventKey(tenantId, linkId, eventRef));
    if (e) e.response = response;
  }

  async countEvents(tenantId: string, since: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const e of this.events.values()) if (e.tenantId === tenantId && e.createdAt >= since) out.set(e.linkId, (out.get(e.linkId) ?? 0) + 1);
    return out;
  }

  async changedAt(tenantId: string, itemIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const inv = this.inventory;
    for (const id of itemIds) {
      const times: string[] = [];
      const item = inv?.items.get(id);
      if (item && item.tenantId === tenantId) times.push(item.updatedAt);
      for (const m of inv?.moves ?? []) if (m.tenantId === tenantId && m.itemId === id) times.push(m.createdAt);
      for (const r of inv?.reservations.values() ?? []) if (r.tenantId === tenantId && r.itemId === id) times.push(r.at);
      if (times.length) out.set(id, times.sort().at(-1)!);
    }
    return out;
  }
}

// ---- 口の形 ----

/** 一覧の 1 品目（渡す範囲にあるもの）。 */
export interface SalesItem {
  id: string;
  name: string;
  publicName: string | null;
  code: string | null;
  barcodes: string[];
  category: string | null;
  unit: string;
  status: 'in_stock' | 'low' | 'out';
  available?: number;
  price?: { amount: number; taxIncluded: boolean } | null;
  employeePrice?: number | null;
  active: true;
  updatedAt: string;
}

/** 一覧の答え。 */
export interface SalesItemList {
  items: (SalesItem | { id: string; active: false })[];
  nextCursor: string | null;
  asOf: string;
}

/** 一覧の絞り込み。 */
export interface SalesItemQuery {
  updatedSince?: string;
  categories?: string[];
  ids?: string[];
  codes?: string[];
  barcodes?: string[];
  limit?: number;
  cursor?: string;
}

/** 販売の通知の 1 行。 */
export interface SaleLineInput {
  itemId?: string;
  code?: string;
  barcode?: string;
  quantity: number;
}

/** 販売の通知（形を確かめたもの）。 */
export interface SaleEventInput {
  eventId: string;
  saleId: string;
  status: 'ordered' | 'sold' | 'cancelled' | 'returned';
  occurredAt: string;
  lines: SaleLineInput[];
}

/** 行ごとの結果。 */
export interface SaleLineResult {
  index: number;
  itemId: string | null;
  result: 'held' | 'used' | 'released' | 'returned' | 'unmatched' | 'ignored';
  available: number | null;
  reason?: string;
}

/** 販売の通知の答え。 */
export interface SaleEventResult {
  eventId: string;
  saleId: string;
  applied: true;
  lines: SaleLineResult[];
}

/** 口の答え（状態の番号と本文）。 */
export type HookResponse<T> = { status: 200; body: T } | { status: 400 | 404 | 409 | 429; body: { error: string; field?: string }; retryAfter?: number };

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);

/**
 * 販売の通知の形を確かめる。ここに無い項目（金額・お客様の情報など）は読まずに捨てる。
 *
 * @returns 確かめた通知か、どの項目が違うか
 */
export function parseSaleEvent(body: unknown): SaleEventInput | { error: string; field: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '本文は JSON のオブジェクトにしてください', field: '' };
  const b = body as Record<string, unknown>;
  const eventId = str(b['eventId'], 100);
  if (!eventId) return { error: 'eventId は 1〜100 字の文字にしてください', field: 'eventId' };
  const saleId = str(b['saleId'], 100);
  if (!saleId) return { error: 'saleId は 1〜100 字の文字にしてください', field: 'saleId' };
  const status = b['status'];
  if (status !== 'ordered' && status !== 'sold' && status !== 'cancelled' && status !== 'returned') return { error: 'status は ordered・sold・cancelled・returned のどれかにしてください', field: 'status' };
  const occurredAt = typeof b['occurredAt'] === 'string' && !Number.isNaN(Date.parse(b['occurredAt'])) ? new Date(b['occurredAt']).toISOString() : null;
  if (!occurredAt) return { error: 'occurredAt は日時（ISO 8601）にしてください', field: 'occurredAt' };
  const raw = b['lines'];
  if (status === 'cancelled' && raw === undefined) return { eventId, saleId, status, occurredAt, lines: [] };
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'lines に 1 行以上を入れてください', field: 'lines' };
  if (raw.length > SALES_LINES_MAX) return { error: `lines は ${SALES_LINES_MAX} 行までです`, field: 'lines' };
  const lines: SaleLineInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i] as Record<string, unknown> | null;
    if (!l || typeof l !== 'object') return { error: '行はオブジェクトにしてください', field: `lines[${i}]` };
    const q = l['quantity'];
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 1_000_000) return { error: 'quantity は 1 以上の整数にしてください', field: `lines[${i}].quantity` };
    const itemId = str(l['itemId'], 100) ?? undefined;
    const code = str(l['code'], 100) ?? undefined;
    const barcode = str(l['barcode'], 100) ?? undefined;
    if (!itemId && !code && !barcode) return { error: 'itemId・code・barcode のどれかを入れてください', field: `lines[${i}]` };
    lines.push({ ...(itemId ? { itemId } : {}), ...(code ? { code } : {}), ...(barcode ? { barcode } : {}), quantity: q });
  }
  return { eventId, saleId, status, occurredAt, lines };
}

/** 中身のハッシュ（形を確かめたあとの中身から。空白や項目の順の違いを同じとみなす）。 */
function eventHash(e: SaleEventInput): string {
  return createHash('sha256').update(JSON.stringify([e.saleId, e.status, e.occurredAt, e.lines.map((l) => [l.itemId ?? '', l.code ?? '', l.barcode ?? '', l.quantity])])).digest('hex');
}

/** 渡す範囲を整える（知らない項目は捨てる）。 */
export function salesScopeOf(body: unknown): InventorySalesScope {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const ids = Array.isArray(b['itemIds']) ? b['itemIds'].filter((x): x is string => typeof x === 'string').slice(0, 5000) : [];
  return { itemIds: [...new Set(ids)], showCount: b['showCount'] === true, price: b['price'] === true, employeePrice: b['employeePrice'] === true };
}

// ---- 処理 ----

/** つなぎの処理に要るもの。 */
export interface InventorySalesDeps {
  store: SalesStore;
  service: InventoryService;
  repo: Repository;
}

/** 照らした結果。 */
type Match = { item: InventoryItemView } | { reason: string };

/**
 * 販売管理とのつなぎ。管理者のつなぎの扱い（作成・承認・鍵の出し直し・停止・削除）と、販売管理が呼ぶ口（一覧・販売の通知）を受け持つ。
 *
 * @remarks つなぎの扱いは管理者だけが呼べる（呼ぶ側の API で確かめる）。どれも監査ログに残す。
 * 販売管理が呼ぶ口は、会社の状態と在庫管理の入り切りを呼ぶ側で確かめてから呼ぶ
 */
export class InventorySales {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly deps: InventorySalesDeps) {}

  /** 販売管理が記録した人として残す名前（入出庫の記録の「記録した人」）。 */
  static actorOf(linkId: string): string {
    return `sales:${linkId}`;
  }

  // ---- 管理者 ----

  /** すべてのつなぎ（作った順）。承認した人の名前・この 7 日の通知の数・照らせなかった行の数を添える。 */
  async list(tenantId: string, now: Date = new Date()): Promise<InventorySalesLink[]> {
    const [rows, users, events, open] = await Promise.all([
      this.deps.store.listLinks(tenantId), this.deps.repo.listUsers(tenantId),
      this.deps.store.countEvents(tenantId, new Date(now.getTime() - 7 * 86_400_000).toISOString()), this.deps.store.countOpenUnmatched(tenantId),
    ]);
    return rows.map((l) => this.toView(l, users, events, open));
  }

  private toView(l: SalesLinkRecord, users: { id: string; displayName: string }[], events: Map<string, number>, open: Map<string, number>): InventorySalesLink {
    const approver = l.approvedBy ? users.find((u) => u.id === l.approvedBy)?.displayName : undefined;
    return {
      id: l.id, name: l.name, status: l.status, scope: l.scope, approvedBy: l.approvedBy, ...(approver ? { approvedByName: approver } : {}),
      approvedAt: l.approvedAt, createdAt: l.createdAt, lastReadAt: l.lastReadAt, lastEventAt: l.lastEventAt,
      eventsLast7Days: events.get(l.id) ?? 0, unmatchedOpen: open.get(l.id) ?? 0,
    };
  }

  /** つなぎ 1 つ（管理者に見せる形）。 */
  async view(tenantId: string, id: string): Promise<InventorySalesLink | null> {
    return (await this.list(tenantId)).find((l) => l.id === id) ?? null;
  }

  /**
   * つなぎを作る。鍵はこの答えでだけ見せる（M2Office はハッシュだけを持つ）。承認するまでは一覧に何も渡さない。
   */
  async create(tenantId: string, userId: string, name: string): Promise<{ link: InventorySalesLink; key: string } | { error: string }> {
    const n = name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    if (!n) return { error: 'つなぎの名前（レジ・ネットショップなど）を入れてください' };
    if ((await this.deps.store.listLinks(tenantId)).length >= INVENTORY_SALES_LINK_MAX) return { error: `つなぎは ${INVENTORY_SALES_LINK_MAX} つまでです` };
    const key = randomBytes(24).toString('base64url');
    const at = new Date().toISOString();
    const rec: SalesLinkRecord = {
      id: randomUUID(), name: n, keyHash: salesKeyHash(key), status: 'active', scope: null, approvedBy: null, approvedAt: null, removed: [],
      createdBy: userId, createdAt: at, lastReadAt: null, lastEventAt: null,
    };
    await this.deps.store.createLink(tenantId, rec);
    await this.audit(tenantId, userId, 'inventory.sales_link.create', rec.id, { name: n });
    return { link: (await this.view(tenantId, rec.id))!, key };
  }

  /** 名前を変える（承認し直さない）。 */
  async rename(tenantId: string, userId: string, id: string, name: string): Promise<InventorySalesLink | { error: string }> {
    const n = name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    if (!n) return { error: '名前を入れてください' };
    if (!(await this.deps.store.getLink(tenantId, id))) return { error: 'つなぎが見つかりません' };
    await this.deps.store.updateLink(tenantId, id, { name: n });
    await this.audit(tenantId, userId, 'inventory.sales_link.rename', id, { name: n });
    return (await this.view(tenantId, id))!;
  }

  /**
   * この内容で渡す（押した管理者が承認者。第9.4.0節の社外への送信を、渡す範囲で一度承認する）。
   *
   * @remarks 範囲から外した品目は覚えておき、`updatedSince` の答えに `active: false` として 1 度入れる
   */
  async approve(tenantId: string, userId: string, id: string, scope: InventorySalesScope): Promise<InventorySalesLink | { error: string }> {
    const link = await this.deps.store.getLink(tenantId, id);
    if (!link) return { error: 'つなぎが見つかりません' };
    const active = new Set((await this.deps.service.store.listItems(tenantId)).map((i) => i.id));
    const itemIds = scope.itemIds.filter((x) => active.has(x));
    const at = new Date().toISOString();
    const before = new Set(link.scope?.itemIds ?? []);
    const after = new Set(itemIds);
    const removed = [
      ...link.removed.filter((r) => !after.has(r.itemId)),
      ...[...before].filter((x) => !after.has(x)).map((itemId) => ({ itemId, at })),
    ].slice(-REMOVED_KEEP);
    const next: InventorySalesScope = { itemIds, showCount: scope.showCount, price: scope.price, employeePrice: scope.employeePrice };
    await this.deps.store.updateLink(tenantId, id, { scope: next, approvedBy: userId, approvedAt: at, removed });
    await this.audit(tenantId, userId, 'inventory.sales_link.approve', id, {
      items: itemIds.length, showCount: next.showCount, price: next.price, employeePrice: next.employeePrice,
    });
    return (await this.view(tenantId, id))!;
  }

  /** 鍵を出し直す。前の鍵はすぐ使えなくなる。新しい鍵はこの答えでだけ見せる。 */
  async rekey(tenantId: string, userId: string, id: string): Promise<{ link: InventorySalesLink; key: string } | { error: string }> {
    if (!(await this.deps.store.getLink(tenantId, id))) return { error: 'つなぎが見つかりません' };
    const key = randomBytes(24).toString('base64url');
    await this.deps.store.updateLink(tenantId, id, { keyHash: salesKeyHash(key) });
    await this.audit(tenantId, userId, 'inventory.sales_link.rekey', id, {});
    return { link: (await this.view(tenantId, id))!, key };
  }

  /** 止める・動かす。止めたつなぎの鍵では、どの口も 404 になる。 */
  async setStatus(tenantId: string, userId: string, id: string, status: 'active' | 'stopped'): Promise<InventorySalesLink | { error: string }> {
    if (!(await this.deps.store.getLink(tenantId, id))) return { error: 'つなぎが見つかりません' };
    await this.deps.store.updateLink(tenantId, id, { status });
    await this.audit(tenantId, userId, status === 'stopped' ? 'inventory.sales_link.stop' : 'inventory.sales_link.resume', id, {});
    return (await this.view(tenantId, id))!;
  }

  /** 削除する（止めてあるつなぎだけ）。販売の記録と照らせなかった行も消える。入出庫の記録は残る。 */
  async remove(tenantId: string, userId: string, id: string): Promise<{ ok: true } | { error: string }> {
    const link = await this.deps.store.getLink(tenantId, id);
    if (!link) return { error: 'つなぎが見つかりません' };
    if (link.status !== 'stopped') return { error: '削除できるのは止めてあるつなぎだけです。先に止めてください' };
    await this.deps.store.deleteLink(tenantId, id);
    await this.audit(tenantId, userId, 'inventory.sales_link.delete', id, { name: link.name });
    return { ok: true };
  }

  /** 承認する前の見本。販売管理に渡るとおりの一覧を返す。 */
  async preview(tenantId: string, scope: InventorySalesScope): Promise<SalesItem[]> {
    const views = await this.deps.service.list(tenantId, { includeStopped: false });
    const ids = new Set(scope.itemIds);
    const changed = await this.deps.store.changedAt(tenantId, [...ids]);
    return views.filter((v) => ids.has(v.id)).map((v) => this.toItem(v, scope, changed.get(v.id) ?? v.updatedAt));
  }

  /** 照らせなかった行（選ぶのを待っているもの。新しい順）。 */
  async unmatched(tenantId: string): Promise<InventorySaleUnmatched[]> {
    const [rows, links] = await Promise.all([this.deps.store.listUnmatched(tenantId, { status: 'open' }), this.deps.store.listLinks(tenantId)]);
    const names = new Map(links.map((l) => [l.id, l.name]));
    return rows.map((u) => ({
      id: u.id, linkId: u.linkId, linkName: names.get(u.linkId) ?? '', saleRef: u.saleRef, action: u.action, itemRef: u.itemRef, code: u.code,
      barcode: u.barcode, qty: u.qty, reason: u.reason, createdAt: u.createdAt,
    }));
  }

  /**
   * 照らせなかった行に品目を選び、その時点で記録する（取り置き・使用・入庫）。
   *
   * @remarks 販売がそのあと取り消された行などは、選ぶ前に「要らなくなった」にしてある
   */
  async resolve(tenantId: string, userId: string, unmatchedId: string, itemId: string): Promise<{ ok: true } | { error: string }> {
    const u = await this.deps.store.getUnmatched(tenantId, unmatchedId);
    if (!u || u.status !== 'open') return { error: '照らせなかった行が見つかりません（もう記録したか、要らなくなりました）' };
    const sale = await this.deps.store.getSaleById(tenantId, u.saleId);
    if (!sale) return { error: '販売が見つかりません' };
    const item = await this.deps.service.store.getItem(tenantId, itemId);
    if (!item || item.status !== 'active') return { error: '使っている品目を選んでください' };
    const link = await this.deps.store.getLink(tenantId, u.linkId);
    const at = new Date().toISOString();
    if (u.action === 'hold') {
      if (sale.status !== 'ordered') return { error: 'この注文は、もう販売か取り消しになっています' };
      const holdId = await this.hold(tenantId, sale, item.id, u.qty, sale.updatedAt, link?.id ?? u.linkId);
      sale.holdIds.push(holdId);
    } else {
      const res = await this.deps.service.recordMove(tenantId, userId, {
        kind: u.action === 'use' ? 'out' : 'in', itemId: item.id, qty: u.qty, reason: u.action === 'use' ? '販売' : '返品', source: 'sales', sourceId: sale.id,
      });
      if (!res.ok) return { error: res.error };
      if (u.action === 'use') sale.soldMoves.push(res.moves[0]!.id);
    }
    sale.updatedAt = at;
    await this.deps.store.saveSale(tenantId, sale);
    await this.deps.store.setUnmatched(tenantId, u.id, 'resolved', userId, at);
    return { ok: true };
  }

  // ---- 販売管理が呼ぶ口 ----

  /**
   * 鍵から会社とつなぎを引く。知らない鍵・止めたつなぎは `null`（呼ぶ側はどちらも同じ 404 にする）。
   */
  async authenticate(key: string): Promise<{ tenantId: string; linkId: string } | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(key)) return null;
    const hit = await this.deps.store.findLinkByHash(salesKeyHash(key));
    if (!hit || hit.status !== 'active') return null;
    return { tenantId: hit.tenantId, linkId: hit.id };
  }

  /** つなぎごとの呼び出しの上限（1 分に {@link SALES_RATE_PER_MINUTE} 回）。超えたら `false`。 */
  allowHit(linkId: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(linkId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= SALES_RATE_PER_MINUTE) {
      this.hits.set(linkId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(linkId, recent);
    return true;
  }

  /** 品目 1 つを、渡す範囲の項目だけの形にする。 */
  private toItem(v: InventoryItemView, scope: InventorySalesScope, updatedAt: string): SalesItem {
    return {
      id: v.id, name: v.name, publicName: v.publicName.trim() || null, code: v.sku.trim() || null, barcodes: [...v.codes], category: v.category.trim() || null,
      unit: v.unit, status: v.available <= 0 ? 'out' : v.low ? 'low' : 'in_stock',
      ...(scope.showCount ? { available: Math.max(0, v.available) } : {}),
      ...(scope.price ? { price: v.price === null ? null : { amount: Math.round(v.price), taxIncluded: v.priceTaxIncluded } } : {}),
      ...(scope.employeePrice ? { employeePrice: v.employeePrice === null ? null : Math.round(v.employeePrice) } : {}),
      active: true, updatedAt,
    };
  }

  /**
   * 商品の一覧（承認した範囲だけ）。
   *
   * @returns 答えか、絞り込みの誤り
   */
  async listItems(tenantId: string, linkId: string, q: SalesItemQuery, now: Date = new Date()): Promise<HookResponse<SalesItemList>> {
    const link = await this.deps.store.getLink(tenantId, linkId);
    if (!link) return { status: 404, body: { error: 'not found' } };
    for (const k of Object.keys(FILTER_MAX) as (keyof typeof FILTER_MAX)[]) {
      if ((q[k]?.length ?? 0) > FILTER_MAX[k]) return { status: 400, body: { error: `${k} は ${FILTER_MAX[k]} 件までです`, field: k } };
    }
    if (q.updatedSince !== undefined && Number.isNaN(Date.parse(q.updatedSince))) return { status: 400, body: { error: 'updatedSince は日時（ISO 8601）にしてください', field: 'updatedSince' } };
    const limit = q.limit === undefined ? LIST_DEFAULT : q.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) return { status: 400, body: { error: `limit は 1〜${LIST_MAX} にしてください`, field: 'limit' } };
    const offset = q.cursor === undefined ? 0 : Number(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(offset) || offset < 0) return { status: 400, body: { error: 'cursor が違います', field: 'cursor' } };
    // 読み始めた時刻を asOf にする（作っている間に変わったものを、次の読み込みで取りこぼさないため）
    const asOf = now.toISOString();
    await this.deps.store.updateLink(tenantId, linkId, { lastReadAt: asOf });
    const scope = link.scope;
    if (!scope) return { status: 200, body: { items: [], nextCursor: null, asOf } };

    const inScope = new Set(scope.itemIds);
    const views = (await this.deps.service.list(tenantId, { includeStopped: true })).filter((v) => inScope.has(v.id));
    const since = q.updatedSince ? new Date(q.updatedSince).toISOString() : null;
    const changed = await this.deps.store.changedAt(tenantId, views.map((v) => v.id));
    // 日が変わると使用期限を過ぎたロットが使える数から外れる。前回から今日までに期限を迎えたロットのある品目も変わったものとする
    const expired = new Set<string>();
    if (since) {
      const from = dateIn('Asia/Tokyo', new Date(since));
      const today = dateIn('Asia/Tokyo', now);
      if (from < today) {
        for (const s of await this.deps.service.store.listStock(tenantId, views.map((v) => v.id))) {
          if (s.expiresOn && s.expiresOn > from && s.expiresOn <= today) expired.add(s.itemId);
        }
      }
    }
    const norm = (x: string) => x.trim();
    const cats = q.categories?.map(norm).filter(Boolean);
    const ids = q.ids ? new Set(q.ids.map(norm)) : null;
    const codes = q.codes ? new Set(q.codes.map(norm)) : null;
    const barcodes = q.barcodes ? new Set(q.barcodes.map((b) => parseCode(b).code || norm(b))) : null;
    const pick = (v: InventoryItemView) => (!ids || ids.has(v.id)) && (!codes || codes.has(v.sku)) && (!barcodes || v.codes.some((c) => barcodes.has(c)));

    const out: SalesItemList['items'] = [];
    for (const v of views) {
      if (!pick(v)) continue;
      const at = [changed.get(v.id), v.updatedAt].filter((x): x is string => !!x).sort().at(-1) ?? v.updatedAt;
      const live = v.status === 'active' && (!cats || cats.includes(norm(v.category)));
      if (since) {
        if (at <= since && !expired.has(v.id)) continue;
        // 止めた品目・絞った分類から外れた品目は、外れたことだけを 1 度伝える
        out.push(live ? this.toItem(v, scope, at) : { id: v.id, active: false });
      } else if (live) {
        out.push(this.toItem(v, scope, at));
      }
    }
    if (since) {
      for (const r of link.removed) if (r.at > since && !inScope.has(r.itemId) && (!ids || ids.has(r.itemId))) out.push({ id: r.itemId, active: false });
    }
    const page = out.slice(offset, offset + limit);
    const nextCursor = offset + limit < out.length ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null;
    return { status: 200, body: { items: page, nextCursor, asOf } };
  }

  /**
   * 販売の通知を受け取る。同じ `eventId` は 1 度だけ処理し、送り直しには前と同じ答えを返す。
   */
  async postEvent(tenantId: string, linkId: string, body: unknown, now: Date = new Date()): Promise<HookResponse<SaleEventResult>> {
    const link = await this.deps.store.getLink(tenantId, linkId);
    if (!link) return { status: 404, body: { error: 'not found' } };
    const parsed = parseSaleEvent(body);
    if ('error' in parsed) return { status: 400, body: parsed };
    const hash = eventHash(parsed);
    const at = now.toISOString();
    if (!(await this.deps.store.claimEvent(tenantId, linkId, parsed.eventId, hash, at))) {
      const prev = await this.deps.store.getEvent(tenantId, linkId, parsed.eventId);
      if (prev && prev.bodyHash !== hash) return { status: 409, body: { error: 'この eventId は別の中身で受け付け済みです' } };
      if (prev?.response) return { status: 200, body: prev.response };
      // 処理の途中のまま古くなったもの（途中で止まった）だけをやり直す
      const stale = new Date(now.getTime() - STALE_EVENT_MS).toISOString();
      if (!(await this.deps.store.reclaimEvent(tenantId, linkId, parsed.eventId, stale, at))) {
        return { status: 409, body: { error: 'この eventId は処理の途中です。少し待って同じ中身で送り直してください' }, retryAfter: 10 };
      }
    }
    const result = await this.apply(tenantId, link, parsed, now);
    await this.deps.store.finishEvent(tenantId, linkId, parsed.eventId, result);
    await this.deps.store.updateLink(tenantId, linkId, { lastEventAt: at });
    return { status: 200, body: result };
  }

  /** 行の品目を照らす（ID → 自社のコード → バーコード。推論を使わない）。照らすのは止めていない品目すべて。 */
  private match(line: SaleLineInput, views: InventoryItemView[]): Match {
    const live = views.filter((v) => v.status === 'active');
    if (line.itemId) {
      const v = live.find((x) => x.id === line.itemId);
      if (v) return { item: v };
    }
    if (line.code) {
      const hits = live.filter((x) => x.sku === line.code);
      if (hits.length === 1) return { item: hits[0]! };
      if (hits.length > 1) return { reason: `自社のコード ${line.code} の品目が ${hits.length} つあります` };
    }
    if (line.barcode) {
      const code = parseCode(line.barcode).code || line.barcode;
      const v = live.find((x) => x.codes.includes(code));
      if (v) return { item: v };
    }
    return { reason: '当たる品目が見つかりません（止めた品目には照らしません）' };
  }

  /** 取り置く（使える数だけを減らす）。 */
  private async hold(tenantId: string, sale: SaleRecord, itemId: string, qty: number, occurredAt: string, linkId: string): Promise<string> {
    const id = randomUUID();
    await this.deps.service.store.addReservation(tenantId, {
      id, bookingId: null, itemId, qty, bookingRef: `販売 ${sale.saleRef}`.slice(0, 120), bookedAt: occurredAt, source: 'sales',
      createdBy: InventorySales.actorOf(linkId), at: new Date().toISOString(),
    });
    this.deps.service.touch(tenantId);
    return id;
  }

  /** 取り置きを閉じる（使った・取り消し）。 */
  private async closeHolds(tenantId: string, sale: SaleRecord, status: 'used' | 'cancelled', at: string): Promise<void> {
    for (const id of sale.holdIds) await this.deps.service.store.setReservationStatus(tenantId, id, status, at);
    if (sale.holdIds.length) this.deps.service.touch(tenantId);
    sale.holdIds = [];
  }

  /** 状態ごとに在庫を動かす。 */
  private async apply(tenantId: string, link: SalesLinkRecord, e: SaleEventInput, now: Date): Promise<SaleEventResult> {
    const at = now.toISOString();
    const actor = InventorySales.actorOf(link.id);
    const views = await this.deps.service.list(tenantId, { includeStopped: true });
    let sale = await this.deps.store.getSale(tenantId, link.id, e.saleId);
    const fresh = !sale;
    if (!sale) sale = { id: randomUUID(), linkId: link.id, saleRef: e.saleId, status: e.status === 'cancelled' ? 'cancelled' : 'ordered', holdIds: [], soldMoves: [], createdAt: at, updatedAt: at };
    const lines: SaleLineResult[] = [];
    const unmatched: UnmatchedRecord[] = [];
    const touched = new Set<string>();
    const miss = (i: number, line: SaleLineInput, action: UnmatchedRecord['action'], reason: string) => {
      lines.push({ index: i, itemId: null, result: 'unmatched', available: null, reason });
      unmatched.push({
        id: randomUUID(), linkId: link.id, saleId: sale!.id, action, itemRef: line.itemId ?? '', code: line.code ?? '', barcode: line.barcode ?? '',
        qty: line.quantity, reason, status: 'open', createdAt: at,
      });
    };
    const ignoreAll = () => e.lines.forEach((_l, i) => lines.push({ index: i, itemId: null, result: 'ignored', available: null }));
    // 状態は ordered → sold → cancelled の順にだけ進む。遅れて届いた前の状態は在庫を動かさない
    const rank = { ordered: 0, sold: 1, cancelled: 2 } as const;

    if (e.status === 'returned') {
      // 返品は販売の状態を変えない。何度でも受ける
      for (const [i, line] of e.lines.entries()) {
        const m = this.match(line, views);
        if ('reason' in m) { miss(i, line, 'return', m.reason); continue; }
        const res = await this.deps.service.recordMove(tenantId, actor, { kind: 'in', itemId: m.item.id, qty: line.quantity, reason: '返品', source: 'sales', sourceId: sale.id });
        if (!res.ok) { miss(i, line, 'return', res.error); continue; }
        lines.push({ index: i, itemId: m.item.id, result: 'returned', available: null });
        touched.add(m.item.id);
      }
    } else if (!fresh && rank[e.status] <= rank[sale.status] && !(e.status === 'ordered' && sale.status === 'ordered')) {
      ignoreAll();
    } else if (e.status === 'ordered') {
      // 同じ注文の送り直しは、取り置きを直す（前の取り置きと、選ぶのを待っている行を外してから取り置き直す）
      await this.closeHolds(tenantId, sale, 'cancelled', at);
      if (!fresh) await this.deps.store.dropUnmatched(tenantId, sale.id, at, 'hold');
      for (const [i, line] of e.lines.entries()) {
        const m = this.match(line, views);
        if ('reason' in m) { miss(i, line, 'hold', m.reason); continue; }
        sale.holdIds.push(await this.hold(tenantId, sale, m.item.id, line.quantity, e.occurredAt, link.id));
        lines.push({ index: i, itemId: m.item.id, result: 'held', available: null });
        touched.add(m.item.id);
      }
      sale.status = 'ordered';
    } else if (e.status === 'sold') {
      // 取り置きがあれば使ったことにし、行のとおりに使用を記録する
      await this.closeHolds(tenantId, sale, 'used', at);
      if (!fresh) await this.deps.store.dropUnmatched(tenantId, sale.id, at, 'hold');
      for (const [i, line] of e.lines.entries()) {
        const m = this.match(line, views);
        if ('reason' in m) { miss(i, line, 'use', m.reason); continue; }
        const res = await this.deps.service.recordMove(tenantId, actor, { kind: 'out', itemId: m.item.id, qty: line.quantity, reason: '販売', source: 'sales', sourceId: sale.id });
        if (!res.ok) { miss(i, line, 'use', res.error); continue; }
        sale.soldMoves.push(res.moves[0]!.id);
        lines.push({ index: i, itemId: m.item.id, result: 'used', available: null });
        touched.add(m.item.id);
      }
      sale.status = 'sold';
    } else {
      // 取り消し: 取り置きを戻し、販売のあとなら使用の記録を戻す。選ぶのを待っている行は要らなくなる
      await this.closeHolds(tenantId, sale, 'cancelled', at);
      for (const moveId of sale.soldMoves) {
        const res = await this.deps.service.reverse(tenantId, actor, moveId, { reason: '販売の取り消し', source: 'sales', sourceId: sale.id });
        if (res.ok) touched.add(res.item.id);
      }
      if (!fresh) await this.deps.store.dropUnmatched(tenantId, sale.id, at);
      sale.status = 'cancelled';
    }
    sale.updatedAt = at;
    await this.deps.store.saveSale(tenantId, sale);
    if (unmatched.length) await this.deps.store.addUnmatched(tenantId, unmatched);
    // 数を渡すと承認した品目だけ、動かしたあとの使える数を添える
    if (link.scope?.showCount && touched.size) {
      const inScope = new Set(link.scope.itemIds);
      const after = new Map((await this.deps.service.list(tenantId, { includeStopped: true })).map((v) => [v.id, v]));
      for (const l of lines) if (l.itemId && inScope.has(l.itemId)) l.available = Math.max(0, after.get(l.itemId)?.available ?? 0);
    }
    if (e.status === 'cancelled') return { eventId: e.eventId, saleId: e.saleId, applied: true, lines: [] };
    return { eventId: e.eventId, saleId: e.saleId, applied: true, lines };
  }

  /** 毎朝の見張りに出す、照らせなかった行の数と例（第29.14節）。 */
  async attention(tenantId: string): Promise<{ count: number; samples: string[] }> {
    const rows = await this.deps.store.listUnmatched(tenantId, { status: 'open', limit: 50 });
    const label = { hold: '注文', use: '販売', return: '返品' } as const;
    return {
      count: rows.length,
      samples: rows.slice(0, 10).map((u) => `${label[u.action]} ${u.saleRef}: ${[u.itemRef, u.code, u.barcode].filter(Boolean).join(' / ')} ${u.qty}`),
    };
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = {
      id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'inventory_sales_link', targetId, detail, occurredAt: new Date().toISOString(),
    };
    await this.deps.repo.appendAudit(ev);
  }
}
