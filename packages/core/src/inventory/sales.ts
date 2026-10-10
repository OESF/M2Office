/**
 * @file 外部のアプリの在庫の機能（仕様書 第29.20.1節・第13.4.1節、ADR-0087・ADR-0090）。販売管理（レジ・POS・EC）などが、
 * 機能「商品の一覧を読む」（`GET /v1/inventory/catalog`）と「販売を知らせる」（`POST /v1/inventory/sales-events`）で呼ぶ。
 *
 * - 一覧は、アプリに承認した範囲だけを返す。`updatedSince` で変わった品目だけ、`categories` で分類を絞れる。外れた品目は `active: false`
 * - 販売の通知は、注文で取り置き・販売で使用・取り消しで戻し・返品で入庫する。`eventId` で二重に数えない（外部のアプリの仕組み）
 * - 品目は ID → 自社のコード → バーコードの順に決まった規則で照らす。照らせない行は残し、人が品目を選べばその時点で記録する
 *
 * 鍵・承認・止める・回数の上限は外部のアプリ（`../apps/`）が受け持つ。金額・支払い・お客様の情報は受け取らず、持たない（第29.17節・第29.18節）。
 * 通知の中身はデータとして扱い、指示として読まない（不変則 I-6）。
 */

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { InventoryCatalogScope, InventoryItemView, InventorySaleUnmatched } from '@m2office/shared';
import { createPool } from '../repository/pool.js';
import type { Repository } from '../repository/types.js';
import { dateIn } from '../cards/service.js';
import { ExternalApps } from '../apps/service.js';
import { parseCode } from './gs1.js';
import type { InventoryService } from './service.js';
import type { MemoryInventoryStore } from './store.js';

/** 本文の大きさの上限（バイト）。 */
export const SALES_PAYLOAD_MAX_BYTES = 64 * 1024;
/** 通知 1 つの行の上限。 */
export const SALES_LINES_MAX = 200;
/** 一覧の 1 回の数の既定と上限。 */
const LIST_DEFAULT = 200;
const LIST_MAX = 500;
/** 絞り込みの数の上限。 */
const FILTER_MAX = { categories: 20, ids: 100, codes: 100, barcodes: 100 } as const;
/** 販売の通知の、二重に数えないための番号の種類（外部のアプリの通知の番号を、機能ごとに分ける）。 */
const SALES_EVENT_KIND = 'inventory.sales';

// ---- 置き場 ----

/** 販売の記録。 */
export interface SaleRecord {
  id: string;
  appId: string;
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
  appId: string;
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

/** 販売の置き場。 */
export interface SalesStore {
  getSale(tenantId: string, appId: string, saleRef: string): Promise<SaleRecord | null>;
  getSaleById(tenantId: string, id: string): Promise<SaleRecord | null>;
  saveSale(tenantId: string, sale: SaleRecord): Promise<void>;
  addUnmatched(tenantId: string, rows: UnmatchedRecord[]): Promise<void>;
  listUnmatched(tenantId: string, opts: { status?: UnmatchedRecord['status']; appId?: string; limit?: number }): Promise<(UnmatchedRecord & { saleRef: string })[]>;
  getUnmatched(tenantId: string, id: string): Promise<UnmatchedRecord | null>;
  setUnmatched(tenantId: string, id: string, status: 'resolved' | 'dropped', userId: string | null, at: string): Promise<void>;
  /** 販売の、選ぶのを待っている行を「要らなくなった」にする（取り消し・送り直しのとき）。`action` を渡せばその種類だけ。 */
  dropUnmatched(tenantId: string, saleId: string, at: string, action?: UnmatchedRecord['action']): Promise<void>;
  countOpenUnmatched(tenantId: string): Promise<Map<string, number>>;
  /** 品目ごとの、使える数や中身が最後に変わった時刻（品目の変更・入出庫の記録・取り置きの出し入れのうち最も新しいもの）。 */
  changedAt(tenantId: string, itemIds: string[]): Promise<Map<string, string>>;
}

interface SaleRow { id: string; app_id: string; sale_ref: string; status: SaleRecord['status']; hold_ids: string[]; sold_moves: string[]; created_at: unknown; updated_at: unknown }
interface UnmatchedRow {
  id: string; app_id: string; sale_id: string; action: UnmatchedRecord['action']; item_ref: string; code: string; barcode: string; qty: unknown;
  reason: string; status: UnmatchedRecord['status']; created_at: unknown; sale_ref?: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const toSale = (r: SaleRow): SaleRecord => ({
  id: r.id, appId: r.app_id, saleRef: r.sale_ref, status: r.status, holdIds: r.hold_ids ?? [], soldMoves: r.sold_moves ?? [],
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const toUnmatched = (r: UnmatchedRow): UnmatchedRecord & { saleRef: string } => ({
  id: r.id, appId: r.app_id, saleId: r.sale_id, action: r.action, itemRef: r.item_ref, code: r.code, barcode: r.barcode, qty: Number(r.qty),
  reason: r.reason, status: r.status, createdAt: iso(r.created_at), saleRef: r.sale_ref ?? '',
});

/**
 * PostgreSQL の販売の置き場。
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

  async getSale(tenantId: string, appId: string, saleRef: string): Promise<SaleRecord | null> {
    const [r] = await this.q<SaleRow>(tenantId, 'select * from inventory_sales where tenant_id = $1 and app_id = $2 and sale_ref = $3', [tenantId, appId, saleRef]);
    return r ? toSale(r) : null;
  }

  async getSaleById(tenantId: string, id: string): Promise<SaleRecord | null> {
    const [r] = await this.q<SaleRow>(tenantId, 'select * from inventory_sales where tenant_id = $1 and id = $2', [tenantId, id]);
    return r ? toSale(r) : null;
  }

  async saveSale(tenantId: string, s: SaleRecord): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_sales (id, tenant_id, app_id, sale_ref, status, hold_ids, sold_moves, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set status = excluded.status, hold_ids = excluded.hold_ids, sold_moves = excluded.sold_moves, updated_at = excluded.updated_at
       where inventory_sales.tenant_id = excluded.tenant_id`,
      [s.id, tenantId, s.appId, s.saleRef, s.status, JSON.stringify(s.holdIds), JSON.stringify(s.soldMoves), s.createdAt, s.updatedAt]);
  }

  async addUnmatched(tenantId: string, rows: UnmatchedRecord[]): Promise<void> {
    for (const u of rows) {
      await this.q(tenantId,
        `insert into inventory_sale_unmatched (id, tenant_id, app_id, sale_id, action, item_ref, code, barcode, qty, reason, status, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [u.id, tenantId, u.appId, u.saleId, u.action, u.itemRef, u.code, u.barcode, u.qty, u.reason, u.status, u.createdAt]);
    }
  }

  async listUnmatched(tenantId: string, opts: { status?: UnmatchedRecord['status']; appId?: string; limit?: number }): Promise<(UnmatchedRecord & { saleRef: string })[]> {
    const params: unknown[] = [tenantId];
    let where = 'u.tenant_id = $1';
    if (opts.status) { params.push(opts.status); where += ` and u.status = $${params.length}`; }
    if (opts.appId) { params.push(opts.appId); where += ` and u.app_id = $${params.length}`; }
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
    const rows = await this.q<{ app_id: string; n: string }>(tenantId,
      `select app_id, count(*) as n from inventory_sale_unmatched where tenant_id = $1 and status = 'open' group by app_id`, [tenantId]);
    return new Map(rows.map((r) => [r.app_id, Number(r.n)]));
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

/** メモリの販売の置き場（試験用）。在庫のメモリの置き場を渡すと、`changedAt` をそこから求める。 */
export class MemorySalesStore implements SalesStore {
  readonly sales = new Map<string, SaleRecord & { tenantId: string }>();
  readonly unmatched = new Map<string, UnmatchedRecord & { tenantId: string }>();

  constructor(private readonly inventory?: MemoryInventoryStore) {}

  async getSale(tenantId: string, appId: string, saleRef: string): Promise<SaleRecord | null> {
    const s = [...this.sales.values()].find((x) => x.tenantId === tenantId && x.appId === appId && x.saleRef === saleRef);
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

  async listUnmatched(tenantId: string, opts: { status?: UnmatchedRecord['status']; appId?: string; limit?: number }): Promise<(UnmatchedRecord & { saleRef: string })[]> {
    return [...this.unmatched.values()]
      .filter((u) => u.tenantId === tenantId && (!opts.status || u.status === opts.status) && (!opts.appId || u.appId === opts.appId))
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
    for (const u of this.unmatched.values()) if (u.tenantId === tenantId && u.status === 'open') out.set(u.appId, (out.get(u.appId) ?? 0) + 1);
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

/** 「商品の一覧を読む」で渡す範囲を整える（知らない項目は捨てる）。 */
export function catalogScopeOf(body: unknown): InventoryCatalogScope {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const ids = Array.isArray(b['itemIds']) ? b['itemIds'].filter((x): x is string => typeof x === 'string').slice(0, 5000) : [];
  return { itemIds: [...new Set(ids)], showCount: b['showCount'] === true, price: b['price'] === true, employeePrice: b['employeePrice'] === true };
}

// ---- 処理 ----

/** 在庫の機能に要るもの。 */
export interface InventorySalesDeps {
  store: SalesStore;
  service: InventoryService;
  repo: Repository;
  /** 外部のアプリ（承認した範囲・二重に数えない番号）。 */
  apps: ExternalApps;
}

/** 照らした結果。 */
type Match = { item: InventoryItemView } | { reason: string };

/**
 * 外部のアプリの在庫の機能（商品の一覧・販売の通知）と、照らせなかった行。
 *
 * @remarks 呼ぶ側の API が、鍵・機能・会社の状態・在庫管理の入り切りを確かめてから呼ぶ
 */
export class InventorySales {
  constructor(private readonly deps: InventorySalesDeps) {}

  /** 品目 1 つを、渡す範囲の項目だけの形にする。 */
  private toItem(v: InventoryItemView, scope: InventoryCatalogScope, updatedAt: string): SalesItem {
    return {
      id: v.id, name: v.name, publicName: v.publicName.trim() || null, code: v.sku.trim() || null, barcodes: [...v.codes], category: v.category.trim() || null,
      unit: v.unit, status: v.available <= 0 ? 'out' : v.low ? 'low' : 'in_stock',
      ...(scope.showCount ? { available: Math.max(0, v.available) } : {}),
      ...(scope.price ? { price: v.price === null ? null : { amount: Math.round(v.price), taxIncluded: v.priceTaxIncluded } } : {}),
      ...(scope.employeePrice ? { employeePrice: v.employeePrice === null ? null : Math.round(v.employeePrice) } : {}),
      active: true, updatedAt,
    };
  }

  /** 承認する前の見本。販売管理に渡るとおりの一覧を返す。 */
  async preview(tenantId: string, scope: InventoryCatalogScope): Promise<SalesItem[]> {
    const views = await this.deps.service.list(tenantId, { includeStopped: false });
    const ids = new Set(scope.itemIds);
    const changed = await this.deps.store.changedAt(tenantId, [...ids]);
    return views.filter((v) => ids.has(v.id)).map((v) => this.toItem(v, scope, changed.get(v.id) ?? v.updatedAt));
  }

  /** 照らせなかった行（選ぶのを待っているもの。新しい順）。 */
  async unmatched(tenantId: string): Promise<InventorySaleUnmatched[]> {
    const [rows, apps] = await Promise.all([this.deps.store.listUnmatched(tenantId, { status: 'open' }), this.deps.apps.store.listApps(tenantId)]);
    const names = new Map(apps.map((a) => [a.id, a.name]));
    return rows.map((u) => ({
      id: u.id, appId: u.appId, appName: names.get(u.appId) ?? '', saleRef: u.saleRef, action: u.action, itemRef: u.itemRef, code: u.code,
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
    const at = new Date().toISOString();
    if (u.action === 'hold') {
      if (sale.status !== 'ordered') return { error: 'この注文は、もう販売か取り消しになっています' };
      const holdId = await this.hold(tenantId, sale, item.id, u.qty, sale.updatedAt, u.appId);
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

  /**
   * 商品の一覧（承認した範囲だけ）。
   *
   * @returns 答えか、絞り込みの誤り
   */
  async listItems(tenantId: string, appId: string, q: SalesItemQuery, now: Date = new Date()): Promise<HookResponse<SalesItemList>> {
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
    const granted = await this.deps.apps.catalogScope(tenantId, appId);
    if (!granted) return { status: 200, body: { items: [], nextCursor: null, asOf } };
    const { scope, removed } = granted;

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
      for (const r of removed) if (r.at > since && !inScope.has(r.itemId) && (!ids || ids.has(r.itemId))) out.push({ id: r.itemId, active: false });
    }
    const page = out.slice(offset, offset + limit);
    const nextCursor = offset + limit < out.length ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null;
    return { status: 200, body: { items: page, nextCursor, asOf } };
  }

  /**
   * 販売の通知を受け取る。同じ `eventId` は 1 度だけ処理し、送り直しには前と同じ答えを返す。
   */
  async postEvent(tenantId: string, appId: string, body: unknown, now: Date = new Date()): Promise<HookResponse<SaleEventResult>> {
    const parsed = parseSaleEvent(body);
    if ('error' in parsed) return { status: 400, body: parsed };
    const claim = await this.deps.apps.claimEvent(tenantId, appId, SALES_EVENT_KIND, parsed.eventId, eventHash(parsed), now);
    if (claim.kind === 'conflict') return { status: 409, body: { error: 'この eventId は別の中身で受け付け済みです' } };
    if (claim.kind === 'replay') return { status: 200, body: claim.response as SaleEventResult };
    if (claim.kind === 'busy') return { status: 409, body: { error: 'この eventId は処理の途中です。少し待って同じ中身で送り直してください' }, retryAfter: 10 };
    const result = await this.apply(tenantId, appId, parsed, now);
    await this.deps.apps.finishEvent(tenantId, appId, SALES_EVENT_KIND, parsed.eventId, result);
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
  private async hold(tenantId: string, sale: SaleRecord, itemId: string, qty: number, occurredAt: string, appId: string): Promise<string> {
    const id = randomUUID();
    await this.deps.service.store.addReservation(tenantId, {
      id, bookingId: null, itemId, qty, bookingRef: `販売 ${sale.saleRef}`.slice(0, 120), bookedAt: occurredAt, source: 'sales',
      createdBy: ExternalApps.actorOf(appId), at: new Date().toISOString(),
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
  private async apply(tenantId: string, appId: string, e: SaleEventInput, now: Date): Promise<SaleEventResult> {
    const at = now.toISOString();
    const actor = ExternalApps.actorOf(appId);
    const granted = await this.deps.apps.catalogScope(tenantId, appId);
    const views = await this.deps.service.list(tenantId, { includeStopped: true });
    let sale = await this.deps.store.getSale(tenantId, appId, e.saleId);
    const fresh = !sale;
    if (!sale) sale = { id: randomUUID(), appId: appId, saleRef: e.saleId, status: e.status === 'cancelled' ? 'cancelled' : 'ordered', holdIds: [], soldMoves: [], createdAt: at, updatedAt: at };
    const lines: SaleLineResult[] = [];
    const unmatched: UnmatchedRecord[] = [];
    const touched = new Set<string>();
    const miss = (i: number, line: SaleLineInput, action: UnmatchedRecord['action'], reason: string) => {
      lines.push({ index: i, itemId: null, result: 'unmatched', available: null, reason });
      unmatched.push({
        id: randomUUID(), appId: appId, saleId: sale!.id, action, itemRef: line.itemId ?? '', code: line.code ?? '', barcode: line.barcode ?? '',
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
        sale.holdIds.push(await this.hold(tenantId, sale, m.item.id, line.quantity, e.occurredAt, appId));
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
    if (granted?.scope.showCount && touched.size) {
      const inScope = new Set(granted.scope.itemIds);
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
}
