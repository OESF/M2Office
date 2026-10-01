/**
 * @file 在庫管理の置き場（仕様書 第29.19節、ADR-0045）。PostgreSQL と、自動テスト用のメモリの 2 つ。
 *
 * 入出庫の記録は追記のみで、いまの数は記録と同じトランザクションで直す（第29.9節）。
 * 会社の境界はデータベースの行単位の制限でも効く（移行 038）。在庫は会社で共有する。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  InventoryBooking, InventoryBookingMapping, InventoryBookingSource, InventoryBookingStatus, InventoryCount, InventoryItem,
  InventoryLocation, InventoryMove, InventoryMoveKind, InventoryPublicationScope, InventoryPublicSnapshot, InventoryReservationLine,
  InventorySupplier,
} from '@m2office/shared';

/** 置き場に渡す品目（バーコードは別に持つ）。 */
export type ItemRecord = Omit<InventoryItem, 'codes' | 'updatedAt'> & { updatedAt?: string };

/** 足す入出庫の記録。`delta` は使う単位の増減（移動は正の量）。 */
export interface NewMove {
  id: string;
  kind: InventoryMoveKind;
  itemId: string;
  lotId: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  delta: number;
  reason: string;
  source: InventoryMove['source'];
  sourceId: string | null;
  reversalOf: string | null;
  /** 同じ操作で一緒に足した記録の組。取り消しはこの組の単位で行う。 */
  batchId: string;
  createdBy: string;
  createdAt: string;
}

/** いまの数の行（場所とロットごと）。 */
export interface StockRecord {
  itemId: string;
  locationId: string;
  lotId: string | null;
  lot: string | null;
  expiresOn: string | null;
  qty: number;
}

/** ロット。 */
export interface LotRecord {
  id: string;
  itemId: string;
  lot: string;
  expiresOn: string | null;
}

/** 棚卸しの行（品目・場所・ロットごと）。 */
export interface CountLineRecord {
  itemId: string;
  locationId: string;
  lotId: string | null;
  lot: string | null;
  expiresOn: string | null;
  counted: number;
  /** 数えた時点（最初に数えたとき）の帳簿の数。 */
  bookAtCount: number;
  countedBy: string;
  updatedAt: string;
}

/** 棚卸しの行に数を足す（置き換える）ときの値。 */
export interface CountEntry {
  id: string;
  countId: string;
  itemId: string;
  locationId: string;
  lotId: string | null;
  qty: number;
  /** `add` は足す、`set` は置き換える（数え直し）。 */
  mode: 'add' | 'set';
  /** 行を初めて作るときの帳簿の数。すでに行があれば使わない。 */
  bookAtCount: number;
  countedBy: string;
  at: string;
}

/** 予約を足す・直すときの値（出どころ＋予約番号で 1 件）。 */
export interface BookingRecord {
  id: string;
  sourceKey: string;
  externalId: string;
  startsAt: string | null;
  menu: string;
  status: InventoryBookingStatus;
  mapped: boolean;
  at: string;
}

/** 引き当てを足すときの値。 */
export interface ReservationRecord {
  id: string;
  bookingId: string;
  itemId: string;
  qty: number;
  bookingRef: string;
  bookedAt: string | null;
  source: 'screen' | 'secretary' | 'service';
  createdBy: string;
  at: string;
}

/** メニューと品目の対応の 1 行。`itemId` が `null` なら「在庫を使わないメニュー」。 */
export interface MenuItemRecord {
  itemId: string | null;
  qty: number;
  learnedBy: 'ai' | 'user';
}

/** 予約の探し方。 */
export interface BookingQuery {
  /** この時刻以降に始まる（ISO 8601）。 */
  from?: string;
  /** この時刻より前に始まる。 */
  to?: string;
  status?: InventoryBookingStatus;
  /** 品目に結び付いていないものだけ。 */
  unmappedOnly?: boolean;
  menuKey?: string;
  limit?: number;
}

/** 入出庫の記録の探し方。 */
export interface MoveQuery {
  itemId?: string;
  /** この時刻以降（ISO 8601）。 */
  since?: string;
  /** この時刻より前（ISO 8601）。 */
  until?: string;
  limit?: number;
}

/**
 * 在庫管理の置き場。
 *
 * @remarks どの操作も会社（テナント）で絞る（不変則 I-2）
 */
/** 公開の行（第29.12節）。 */
export interface PublicationRecord {
  key: string;
  scope: InventoryPublicationScope;
  approvedBy: string;
  approvedAt: string;
  status: 'live' | 'stopped';
  snapshot: InventoryPublicSnapshot | null;
  snapshotAt: string | null;
}

export interface InventoryStore {
  listItems(tenantId: string, opts?: { includeStopped?: boolean }): Promise<InventoryItem[]>;
  getItem(tenantId: string, id: string): Promise<InventoryItem | null>;
  saveItem(tenantId: string, item: ItemRecord, userId: string, at: string): Promise<void>;
  /** バーコードを足す。すでに別の品目のものなら `false`。 */
  addCode(tenantId: string, itemId: string, value: string, kind: string): Promise<boolean>;
  removeCode(tenantId: string, itemId: string, value: string): Promise<void>;
  findItemByCode(tenantId: string, value: string): Promise<InventoryItem | null>;

  listSuppliers(tenantId: string): Promise<InventorySupplier[]>;
  saveSupplier(tenantId: string, s: InventorySupplier, at: string): Promise<void>;

  listLocations(tenantId: string): Promise<InventoryLocation[]>;
  saveLocation(tenantId: string, loc: InventoryLocation): Promise<void>;
  /** 場所を外す（いまの数が残っていれば `false`）。 */
  removeLocation(tenantId: string, id: string): Promise<boolean>;

  findLot(tenantId: string, itemId: string, lot: string): Promise<LotRecord | null>;
  saveLot(tenantId: string, lot: LotRecord): Promise<void>;

  /** 品目ごとのいまの数（ロットと場所ごと）。`itemIds` を省けば全品目。 */
  listStock(tenantId: string, itemIds?: string[]): Promise<StockRecord[]>;
  /** 品目ごとの引き当て（取り置き中）の合計。 */
  heldByItem(tenantId: string): Promise<Map<string, number>>;

  /** 入出庫の記録を足し、同じトランザクションでいまの数を直す。 */
  applyMoves(tenantId: string, moves: NewMove[]): Promise<void>;
  getMove(tenantId: string, id: string): Promise<InventoryMove | null>;
  listMoves(tenantId: string, q: MoveQuery): Promise<InventoryMove[]>;
  /** その記録がすでに取り消されているか。 */
  isReversed(tenantId: string, moveId: string): Promise<boolean>;
  /**
   * 同じ操作で一緒に足した記録（使用期限の近いロットから分けて減らしたときなど）。
   *
   * @remarks 取り消しは操作の単位で行う（第29.9節）
   */
  siblings(tenantId: string, moveId: string): Promise<InventoryMove[]>;

  createCount(tenantId: string, count: InventoryCount): Promise<void>;
  getCount(tenantId: string, id: string): Promise<InventoryCount | null>;
  /** 開いている棚卸し（会社で 1 つ）。 */
  openCount(tenantId: string): Promise<InventoryCount | null>;
  listCounts(tenantId: string, limit?: number): Promise<InventoryCount[]>;
  /** 棚卸しの行に数を足す（置き換える）。何人が同時に数えても足し合わせる。 */
  addCountLine(tenantId: string, entry: CountEntry): Promise<CountLineRecord>;
  listCountLines(tenantId: string, countId: string): Promise<CountLineRecord[]>;
  setCountStatus(tenantId: string, id: string, status: 'closed' | 'cancelled', userId: string, at: string): Promise<void>;

  // ---- 予約との引き当て（第29.13節） ----
  listBookingSources(tenantId: string): Promise<InventoryBookingSource[]>;
  createBookingSource(tenantId: string, s: { id: string; name: string; hookHash: string; createdBy: string; at: string }): Promise<void>;
  updateBookingSource(tenantId: string, id: string, patch: { mapping?: InventoryBookingMapping | null; status?: 'active' | 'stopped'; lastReceivedAt?: string }): Promise<void>;
  /** 鍵のハッシュから受け口を引く（会社の判定より前。会社をまたいで 1 行だけ）。 */
  findBookingSourceByHash(hookHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null>;
  /** 予約を足すか直す（出どころ＋予約番号で 1 件）。直したときは元の ID を返す。 */
  upsertBooking(tenantId: string, b: BookingRecord): Promise<string>;
  getBooking(tenantId: string, id: string): Promise<InventoryBooking | null>;
  listBookings(tenantId: string, q: BookingQuery): Promise<InventoryBooking[]>;
  updateBooking(tenantId: string, id: string, patch: { status?: InventoryBookingStatus; mapped?: boolean; startsAt?: string | null; at: string }): Promise<void>;
  addReservation(tenantId: string, r: ReservationRecord): Promise<void>;
  setReservationStatus(tenantId: string, id: string, status: 'used' | 'cancelled', at: string): Promise<void>;
  /** 予約の引き当ての日時をそろえる（予約の日時が変わったとき）。 */
  setReservationTime(tenantId: string, bookingId: string, bookedAt: string | null): Promise<void>;
  listMenuItems(tenantId: string, menuKey: string): Promise<MenuItemRecord[]>;
  /** メニューの対応を置き換える。 */
  setMenuItems(tenantId: string, menuKey: string, rows: MenuItemRecord[], at: string): Promise<void>;

  /** 会社の公開（第29.12節）。まだ一度も承認していなければ `null`。 */
  getPublication(tenantId: string): Promise<PublicationRecord | null>;
  /** 公開の中身を承認して保存する（公開中にする）。鍵は最初の承認のときに作ったものを使い続ける。 */
  approvePublication(tenantId: string, p: { key: string; scope: InventoryPublicationScope; approvedBy: string; approvedAt: string }): Promise<void>;
  setPublicationStatus(tenantId: string, status: 'live' | 'stopped'): Promise<void>;
  savePublicationSnapshot(tenantId: string, snapshot: InventoryPublicSnapshot, at: string): Promise<void>;
  /** 鍵から公開を引く（会社の判定より前に呼ぶ）。 */
  findPublicationByKey(key: string): Promise<{ tenantId: string; status: 'live' | 'stopped'; snapshot: InventoryPublicSnapshot | null } | null>;
}

// ---- PostgreSQL ----------------------------------------------------------

/** 数値の列（numeric は文字列で返る）を数にする。 */
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
function day(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

interface ItemRow {
  id: string; name: string; public_name: string; sku: string; category: string; unit: string; pack_unit: string;
  pack_size: unknown; price: unknown; price_tax_included: boolean; photo_file_id: string | null; low_threshold: unknown;
  supplier_id: string | null; lead_days: number | null; note: string; status: 'active' | 'stopped'; updated_at: unknown;
  codes: string[] | null;
}

function toItem(r: ItemRow): InventoryItem {
  return {
    id: r.id, name: r.name, publicName: r.public_name, sku: r.sku, category: r.category, unit: r.unit, packUnit: r.pack_unit,
    packSize: numOrNull(r.pack_size), price: numOrNull(r.price), priceTaxIncluded: r.price_tax_included,
    photoFileId: r.photo_file_id, lowThreshold: numOrNull(r.low_threshold), supplierId: r.supplier_id, leadDays: r.lead_days,
    note: r.note, status: r.status, codes: r.codes ?? [], updatedAt: iso(r.updated_at),
  };
}

const ITEM_SELECT = `select i.*, coalesce((select array_agg(c.value order by c.created_at) from inventory_codes c
  where c.tenant_id = i.tenant_id and c.item_id = i.id), '{}') as codes from inventory_items i`;

interface MoveRow {
  id: string; kind: InventoryMoveKind; item_id: string; item_name: string | null; lot_id: string | null; lot: string | null;
  from_location_id: string | null; to_location_id: string | null; delta: unknown; reason: string; source: InventoryMove['source'];
  reversal_of: string | null; created_by: string; created_by_name: string | null; created_at: unknown;
}

function toMove(r: MoveRow): InventoryMove {
  return {
    id: r.id, kind: r.kind, itemId: r.item_id, itemName: r.item_name ?? undefined, lotId: r.lot_id, lot: r.lot,
    fromLocationId: r.from_location_id, toLocationId: r.to_location_id, delta: num(r.delta), reason: r.reason,
    source: r.source, reversalOf: r.reversal_of, createdBy: r.created_by, createdByName: r.created_by_name ?? undefined,
    createdAt: iso(r.created_at),
  };
}

interface CountRow {
  id: string; scope: InventoryCount['scope']; scope_value: string; status: InventoryCount['status']; started_by: string;
  started_by_name: string | null; started_at: unknown; closed_by: string | null; closed_at: unknown;
}

function toCount(r: CountRow): InventoryCount {
  return {
    id: r.id, scope: r.scope, scopeValue: r.scope_value, status: r.status, startedBy: r.started_by,
    startedByName: r.started_by_name ?? undefined, startedAt: iso(r.started_at), closedBy: r.closed_by,
    closedAt: r.closed_at ? iso(r.closed_at) : null,
  };
}

interface CountLineRow {
  item_id: string; location_id: string; lot_id: string | null; lot: string | null; expires_on: unknown;
  counted: unknown; book_at_count: unknown; counted_by: string; updated_at: unknown;
}

const COUNT_LINE_SELECT = `select l.item_id, l.location_id, l.lot_id, lt.lot, lt.expires_on, l.counted, l.book_at_count, l.counted_by, l.updated_at
  from inventory_count_lines l left join inventory_lots lt on lt.id = l.lot_id`;

function toCountLine(r: CountLineRow): CountLineRecord {
  return {
    itemId: r.item_id, locationId: r.location_id, lotId: r.lot_id, lot: r.lot, expiresOn: day(r.expires_on),
    counted: num(r.counted), bookAtCount: num(r.book_at_count), countedBy: r.counted_by, updatedAt: iso(r.updated_at),
  };
}

/**
 * PostgreSQL の在庫の置き場。
 *
 * @remarks 問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する（行単位の制限。移行 038）
 */
export class PostgresInventoryStore implements InventoryStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 会社を設定したトランザクションの中で、まとめて問い合わせる。 */
  private async tx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(tenantId, async (c) => (await c.query<T>(text, params as never[])).rows);
  }

  async listItems(tenantId: string, opts: { includeStopped?: boolean } = {}): Promise<InventoryItem[]> {
    const rows = await this.q<ItemRow>(tenantId,
      `${ITEM_SELECT} where i.tenant_id = $1 ${opts.includeStopped ? '' : `and i.status = 'active'`} order by i.category, i.name`, [tenantId]);
    return rows.map(toItem);
  }

  async getItem(tenantId: string, id: string): Promise<InventoryItem | null> {
    const rows = await this.q<ItemRow>(tenantId, `${ITEM_SELECT} where i.tenant_id = $1 and i.id = $2`, [tenantId, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async saveItem(tenantId: string, i: ItemRecord, userId: string, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_items (id, tenant_id, name, public_name, sku, category, unit, pack_unit, pack_size, price,
         price_tax_included, photo_file_id, low_threshold, supplier_id, lead_days, note, status, created_by, created_at, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$18,$19)
       on conflict (id) do update set name = excluded.name, public_name = excluded.public_name, sku = excluded.sku,
         category = excluded.category, unit = excluded.unit, pack_unit = excluded.pack_unit, pack_size = excluded.pack_size,
         price = excluded.price, price_tax_included = excluded.price_tax_included, photo_file_id = excluded.photo_file_id,
         low_threshold = excluded.low_threshold, supplier_id = excluded.supplier_id, lead_days = excluded.lead_days,
         note = excluded.note, status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at
       where inventory_items.tenant_id = excluded.tenant_id`,
      [i.id, tenantId, i.name, i.publicName, i.sku, i.category, i.unit, i.packUnit, i.packSize, i.price, i.priceTaxIncluded,
        i.photoFileId, i.lowThreshold, i.supplierId, i.leadDays, i.note, i.status, userId, at]);
  }

  async addCode(tenantId: string, itemId: string, value: string, kind: string): Promise<boolean> {
    const rows = await this.q<{ item_id: string }>(tenantId,
      `insert into inventory_codes (tenant_id, item_id, value, kind) values ($1, $2, $3, $4)
       on conflict (tenant_id, value) do update set kind = inventory_codes.kind
       returning item_id`, [tenantId, itemId, value, kind]);
    return rows[0]?.item_id === itemId;
  }

  async removeCode(tenantId: string, itemId: string, value: string): Promise<void> {
    await this.q(tenantId, `delete from inventory_codes where tenant_id = $1 and item_id = $2 and value = $3`, [tenantId, itemId, value]);
  }

  async findItemByCode(tenantId: string, value: string): Promise<InventoryItem | null> {
    const rows = await this.q<ItemRow>(tenantId,
      `${ITEM_SELECT} where i.tenant_id = $1 and (i.id in (select item_id from inventory_codes where tenant_id = $1 and value = $2)
         or (i.sku <> '' and i.sku = $2)) order by i.status limit 1`, [tenantId, value]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async listSuppliers(tenantId: string): Promise<InventorySupplier[]> {
    const rows = await this.q<{ id: string; name: string; method: InventorySupplier['method']; contact: string; lead_days: number | null; note: string; status: InventorySupplier['status'] }>(
      tenantId, `select * from inventory_suppliers where tenant_id = $1 order by name`, [tenantId]);
    return rows.map((r) => ({ id: r.id, name: r.name, method: r.method, contact: r.contact, leadDays: r.lead_days, note: r.note, status: r.status }));
  }

  async saveSupplier(tenantId: string, s: InventorySupplier, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_suppliers (id, tenant_id, name, method, contact, lead_days, note, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       on conflict (id) do update set name = excluded.name, method = excluded.method, contact = excluded.contact,
         lead_days = excluded.lead_days, note = excluded.note, status = excluded.status, updated_at = excluded.updated_at
       where inventory_suppliers.tenant_id = excluded.tenant_id`,
      [s.id, tenantId, s.name, s.method, s.contact, s.leadDays, s.note, s.status, at]);
  }

  async listLocations(tenantId: string): Promise<InventoryLocation[]> {
    const rows = await this.q<{ id: string; warehouse: string; shelf: string; label_key: string }>(tenantId,
      `select id, warehouse, shelf, label_key from inventory_locations where tenant_id = $1 and status = 'active' order by warehouse, shelf`, [tenantId]);
    return rows.map((r) => ({ id: r.id, warehouse: r.warehouse, shelf: r.shelf, labelKey: r.label_key }));
  }

  async saveLocation(tenantId: string, l: InventoryLocation): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_locations (id, tenant_id, warehouse, shelf, label_key) values ($1,$2,$3,$4,$5)
       on conflict (id) do update set warehouse = excluded.warehouse, shelf = excluded.shelf
       where inventory_locations.tenant_id = excluded.tenant_id`, [l.id, tenantId, l.warehouse, l.shelf, l.labelKey]);
  }

  async removeLocation(tenantId: string, id: string): Promise<boolean> {
    return this.tx(tenantId, async (c) => {
      const left = await c.query(`select 1 from inventory_stock where tenant_id = $1 and location_id = $2 and qty <> 0 limit 1`, [tenantId, id]);
      if (left.rowCount) return false;
      await c.query(`update inventory_locations set status = 'removed' where tenant_id = $1 and id = $2`, [tenantId, id]);
      return true;
    });
  }

  async findLot(tenantId: string, itemId: string, lot: string): Promise<LotRecord | null> {
    const rows = await this.q<{ id: string; item_id: string; lot: string; expires_on: unknown }>(tenantId,
      `select id, item_id, lot, expires_on from inventory_lots where tenant_id = $1 and item_id = $2 and lot = $3`, [tenantId, itemId, lot]);
    const r = rows[0];
    return r ? { id: r.id, itemId: r.item_id, lot: r.lot, expiresOn: day(r.expires_on) } : null;
  }

  async saveLot(tenantId: string, l: LotRecord): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_lots (id, tenant_id, item_id, lot, expires_on) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, item_id, lot) do update set expires_on = coalesce(excluded.expires_on, inventory_lots.expires_on)`,
      [l.id, tenantId, l.itemId, l.lot, l.expiresOn]);
  }

  async listStock(tenantId: string, itemIds?: string[]): Promise<StockRecord[]> {
    const rows = await this.q<{ item_id: string; location_id: string; lot_id: string | null; lot: string | null; expires_on: unknown; qty: unknown }>(tenantId,
      `select s.item_id, s.location_id, s.lot_id, l.lot, l.expires_on, s.qty from inventory_stock s
         left join inventory_lots l on l.id = s.lot_id
        where s.tenant_id = $1 ${itemIds ? 'and s.item_id = any($2::text[])' : ''} and s.qty <> 0
        order by l.expires_on nulls last`, itemIds ? [tenantId, itemIds] : [tenantId]);
    return rows.map((r) => ({ itemId: r.item_id, locationId: r.location_id, lotId: r.lot_id, lot: r.lot, expiresOn: day(r.expires_on), qty: num(r.qty) }));
  }

  async heldByItem(tenantId: string): Promise<Map<string, number>> {
    const rows = await this.q<{ item_id: string; qty: unknown }>(tenantId,
      `select item_id, sum(qty) as qty from inventory_reservations where tenant_id = $1 and status = 'held' group by item_id`, [tenantId]);
    return new Map(rows.map((r) => [r.item_id, num(r.qty)]));
  }

  async applyMoves(tenantId: string, moves: NewMove[]): Promise<void> {
    await this.tx(tenantId, async (c) => {
      for (const m of moves) {
        await c.query(
          `insert into inventory_moves (id, tenant_id, kind, item_id, lot_id, from_location_id, to_location_id, delta, reason,
             source, source_id, reversal_of, batch_id, created_by, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [m.id, tenantId, m.kind, m.itemId, m.lotId, m.fromLocationId, m.toLocationId, m.delta, m.reason, m.source,
            m.sourceId, m.reversalOf, m.batchId, m.createdBy, m.createdAt]);
        // いまの数を直す。移動は元から引いて先に足す。それ以外は delta の符号で先（入）か元（出）を直す
        const bump = async (loc: string, d: number) => {
          await c.query(
            `insert into inventory_stock (tenant_id, item_id, location_id, lot_key, lot_id, qty, updated_at)
             values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (tenant_id, item_id, location_id, lot_key) do update set qty = inventory_stock.qty + excluded.qty, updated_at = excluded.updated_at`,
            [tenantId, m.itemId, loc, m.lotId ?? '', m.lotId, d, m.createdAt]);
        };
        if (m.kind === 'transfer') {
          if (m.fromLocationId) await bump(m.fromLocationId, -Math.abs(m.delta));
          if (m.toLocationId) await bump(m.toLocationId, Math.abs(m.delta));
        } else {
          const loc = m.delta >= 0 ? (m.toLocationId ?? m.fromLocationId) : (m.fromLocationId ?? m.toLocationId);
          if (loc) await bump(loc, m.delta);
        }
      }
    });
  }

  private readonly MOVE_SELECT = `select m.*, i.name as item_name, l.lot, u.display_name as created_by_name from inventory_moves m
    join inventory_items i on i.id = m.item_id left join inventory_lots l on l.id = m.lot_id left join users u on u.id = m.created_by`;

  async getMove(tenantId: string, id: string): Promise<InventoryMove | null> {
    const rows = await this.q<MoveRow>(tenantId, `${this.MOVE_SELECT} where m.tenant_id = $1 and m.id = $2`, [tenantId, id]);
    return rows[0] ? toMove(rows[0]) : null;
  }

  async listMoves(tenantId: string, q: MoveQuery): Promise<InventoryMove[]> {
    const params: unknown[] = [tenantId];
    const where = ['m.tenant_id = $1'];
    if (q.itemId) { params.push(q.itemId); where.push(`m.item_id = $${params.length}`); }
    if (q.since) { params.push(q.since); where.push(`m.created_at >= $${params.length}`); }
    if (q.until) { params.push(q.until); where.push(`m.created_at < $${params.length}`); }
    params.push(Math.min(q.limit ?? 200, 2000));
    const rows = await this.q<MoveRow>(tenantId,
      `${this.MOVE_SELECT} where ${where.join(' and ')} order by m.created_at desc limit $${params.length}`, params);
    return rows.map(toMove);
  }

  async isReversed(tenantId: string, moveId: string): Promise<boolean> {
    const rows = await this.q(tenantId, `select 1 from inventory_moves where tenant_id = $1 and reversal_of = $2 limit 1`, [tenantId, moveId]);
    return rows.length > 0;
  }

  async siblings(tenantId: string, moveId: string): Promise<InventoryMove[]> {
    const rows = await this.q<MoveRow>(tenantId,
      `${this.MOVE_SELECT} join inventory_moves o on o.tenant_id = m.tenant_id and o.id = $2
        where m.tenant_id = $1 and (m.id = o.id or (o.batch_id is not null and m.batch_id = o.batch_id)) order by m.id`, [tenantId, moveId]);
    return rows.map(toMove);
  }

  private readonly COUNT_SELECT = `select c.*, u.display_name as started_by_name from inventory_counts c left join users u on u.id = c.started_by`;

  async createCount(tenantId: string, c: InventoryCount): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_counts (id, tenant_id, scope, scope_value, status, started_by, started_at) values ($1,$2,$3,$4,'open',$5,$6)`,
      [c.id, tenantId, c.scope, c.scopeValue, c.startedBy, c.startedAt]);
  }

  async getCount(tenantId: string, id: string): Promise<InventoryCount | null> {
    const rows = await this.q<CountRow>(tenantId, `${this.COUNT_SELECT} where c.tenant_id = $1 and c.id = $2`, [tenantId, id]);
    return rows[0] ? toCount(rows[0]) : null;
  }

  async openCount(tenantId: string): Promise<InventoryCount | null> {
    const rows = await this.q<CountRow>(tenantId,
      `${this.COUNT_SELECT} where c.tenant_id = $1 and c.status = 'open' order by c.started_at desc limit 1`, [tenantId]);
    return rows[0] ? toCount(rows[0]) : null;
  }

  async listCounts(tenantId: string, limit = 20): Promise<InventoryCount[]> {
    const rows = await this.q<CountRow>(tenantId,
      `${this.COUNT_SELECT} where c.tenant_id = $1 order by c.started_at desc limit $2`, [tenantId, limit]);
    return rows.map(toCount);
  }

  async addCountLine(tenantId: string, e: CountEntry): Promise<CountLineRecord> {
    return this.tx(tenantId, async (c) => {
      await c.query(
        `insert into inventory_count_lines (id, tenant_id, count_id, item_id, location_id, lot_key, lot_id, counted, book_at_count, counted_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (count_id, item_id, location_id, lot_key) do update set
           counted = case when $12 = 'set' then excluded.counted else inventory_count_lines.counted + excluded.counted end,
           counted_by = excluded.counted_by, updated_at = excluded.updated_at`,
        [e.id, tenantId, e.countId, e.itemId, e.locationId, e.lotId ?? '', e.lotId, e.qty, e.bookAtCount, e.countedBy, e.at, e.mode]);
      const { rows } = await c.query<CountLineRow>(
        `${COUNT_LINE_SELECT} where l.tenant_id = $1 and l.count_id = $2 and l.item_id = $3 and l.location_id = $4 and l.lot_key = $5`,
        [tenantId, e.countId, e.itemId, e.locationId, e.lotId ?? '']);
      return toCountLine(rows[0]!);
    });
  }

  async listCountLines(tenantId: string, countId: string): Promise<CountLineRecord[]> {
    const rows = await this.q<CountLineRow>(tenantId, `${COUNT_LINE_SELECT} where l.tenant_id = $1 and l.count_id = $2`, [tenantId, countId]);
    return rows.map(toCountLine);
  }

  async setCountStatus(tenantId: string, id: string, status: 'closed' | 'cancelled', userId: string, at: string): Promise<void> {
    await this.q(tenantId,
      `update inventory_counts set status = $3, closed_by = $4, closed_at = $5 where tenant_id = $1 and id = $2 and status = 'open'`,
      [tenantId, id, status, userId, at]);
  }
  async listBookingSources(tenantId: string): Promise<InventoryBookingSource[]> {
    const rows = await this.q<{ id: string; name: string; mapping: InventoryBookingMapping | null; status: 'active' | 'stopped'; created_at: unknown; last_received_at: unknown }>(
      tenantId, `select id, name, mapping, status, created_at, last_received_at from inventory_booking_sources where tenant_id = $1 order by created_at`, [tenantId]);
    return rows.map((r) => ({ id: r.id, name: r.name, mapping: r.mapping, status: r.status, createdAt: iso(r.created_at), lastReceivedAt: r.last_received_at ? iso(r.last_received_at) : null }));
  }

  async createBookingSource(tenantId: string, s: { id: string; name: string; hookHash: string; createdBy: string; at: string }): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_booking_sources (id, tenant_id, name, hook_hash, created_by, created_at) values ($1,$2,$3,$4,$5,$6)`,
      [s.id, tenantId, s.name, s.hookHash, s.createdBy, s.at]);
  }

  async updateBookingSource(tenantId: string, id: string, patch: { mapping?: InventoryBookingMapping | null; status?: 'active' | 'stopped'; lastReceivedAt?: string }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    if (patch.mapping !== undefined) { params.push(patch.mapping === null ? null : JSON.stringify(patch.mapping)); sets.push(`mapping = $${params.length}`); }
    if (patch.status) { params.push(patch.status); sets.push(`status = $${params.length}`); }
    if (patch.lastReceivedAt) { params.push(patch.lastReceivedAt); sets.push(`last_received_at = $${params.length}`); }
    if (sets.length === 0) return;
    await this.q(tenantId, `update inventory_booking_sources set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async findBookingSourceByHash(hookHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null> {
    // 会社の判定より前に呼ぶ。鍵のハッシュで 1 行だけ返す関数を使う（移行 040）
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ id: string; tenant_id: string; status: 'active' | 'stopped' }>(
        'select id, tenant_id, status from m2o_inventory_booking_source($1)', [hookHash]);
      const r = rows[0];
      return r ? { id: r.id, tenantId: r.tenant_id, status: r.status } : null;
    } finally {
      client.release();
    }
  }

  async upsertBooking(tenantId: string, b: BookingRecord): Promise<string> {
    const rows = await this.q<{ id: string }>(tenantId,
      `insert into inventory_bookings (id, tenant_id, source_key, external_id, starts_at, menu, status, mapped, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       on conflict (tenant_id, source_key, external_id) do update set starts_at = excluded.starts_at, menu = excluded.menu,
         status = excluded.status, updated_at = excluded.updated_at
       returning id`, [b.id, tenantId, b.sourceKey, b.externalId, b.startsAt, b.menu, b.status, b.mapped, b.at]);
    return rows[0]!.id;
  }

  private async bookingsWhere(tenantId: string, where: string, params: unknown[], limit: number): Promise<InventoryBooking[]> {
    const rows = await this.q<{ id: string; source_key: string; source_name: string | null; external_id: string; starts_at: unknown; menu: string; status: InventoryBookingStatus; mapped: boolean; updated_at: unknown }>(tenantId,
      `select b.*, s.name as source_name from inventory_bookings b left join inventory_booking_sources s on s.id = b.source_key
        where b.tenant_id = $1 ${where} order by b.starts_at nulls last, b.created_at limit ${Math.min(limit, 1000)}`, [tenantId, ...params]);
    if (rows.length === 0) return [];
    const lines = await this.q<{ id: string; booking_id: string; item_id: string; item_name: string; unit: string; qty: unknown; status: InventoryReservationLine['status'] }>(tenantId,
      `select r.id, r.booking_id, r.item_id, i.name as item_name, i.unit, r.qty, r.status from inventory_reservations r
         join inventory_items i on i.id = r.item_id where r.tenant_id = $1 and r.booking_id = any($2::text[]) order by r.created_at`,
      [tenantId, rows.map((r) => r.id)]);
    return rows.map((r) => ({
      id: r.id, sourceKey: r.source_key, sourceName: r.source_name ?? undefined, externalId: r.external_id,
      startsAt: r.starts_at ? iso(r.starts_at) : null, menu: r.menu, status: r.status, mapped: r.mapped, updatedAt: iso(r.updated_at),
      lines: lines.filter((l) => l.booking_id === r.id).map((l) => ({ id: l.id, itemId: l.item_id, itemName: l.item_name, unit: l.unit, qty: num(l.qty), status: l.status })),
    }));
  }

  async getBooking(tenantId: string, id: string): Promise<InventoryBooking | null> {
    return (await this.bookingsWhere(tenantId, 'and b.id = $2', [id], 1))[0] ?? null;
  }

  async listBookings(tenantId: string, q: BookingQuery): Promise<InventoryBooking[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length + 1}`)); };
    if (q.from) add('and b.starts_at >= ?', q.from);
    if (q.to) add('and b.starts_at < ?', q.to);
    if (q.status) add('and b.status = ?', q.status);
    if (q.menuKey !== undefined) add('and lower(b.menu) = ?', q.menuKey);
    if (q.unmappedOnly) where.push('and b.mapped = false');
    return this.bookingsWhere(tenantId, where.join(' '), params, q.limit ?? 200);
  }

  async updateBooking(tenantId: string, id: string, patch: { status?: InventoryBookingStatus; mapped?: boolean; startsAt?: string | null; at: string }): Promise<void> {
    const sets = ['updated_at = $3'];
    const params: unknown[] = [tenantId, id, patch.at];
    if (patch.status) { params.push(patch.status); sets.push(`status = $${params.length}`); }
    if (patch.mapped !== undefined) { params.push(patch.mapped); sets.push(`mapped = $${params.length}`); }
    if (patch.startsAt !== undefined) { params.push(patch.startsAt); sets.push(`starts_at = $${params.length}`); }
    await this.q(tenantId, `update inventory_bookings set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async addReservation(tenantId: string, r: ReservationRecord): Promise<void> {
    await this.q(tenantId,
      `insert into inventory_reservations (id, tenant_id, item_id, qty, booking_ref, booked_at, status, source, created_by, created_at, booking_id)
       values ($1,$2,$3,$4,$5,$6,'held',$7,$8,$9,$10)`,
      [r.id, tenantId, r.itemId, r.qty, r.bookingRef, r.bookedAt, r.source, r.createdBy, r.at, r.bookingId]);
  }

  async setReservationStatus(tenantId: string, id: string, status: 'used' | 'cancelled', at: string): Promise<void> {
    await this.q(tenantId, `update inventory_reservations set status = $3, closed_at = $4 where tenant_id = $1 and id = $2 and status = 'held'`, [tenantId, id, status, at]);
  }

  async setReservationTime(tenantId: string, bookingId: string, bookedAt: string | null): Promise<void> {
    await this.q(tenantId, `update inventory_reservations set booked_at = $3 where tenant_id = $1 and booking_id = $2 and status = 'held'`, [tenantId, bookingId, bookedAt]);
  }

  async listMenuItems(tenantId: string, menuKey: string): Promise<MenuItemRecord[]> {
    const rows = await this.q<{ item_id: string | null; qty: unknown; learned_by: 'ai' | 'user' }>(tenantId,
      `select item_id, qty, learned_by from inventory_menu_items where tenant_id = $1 and menu_key = $2`, [tenantId, menuKey]);
    return rows.map((r) => ({ itemId: r.item_id, qty: num(r.qty), learnedBy: r.learned_by }));
  }

  async setMenuItems(tenantId: string, menuKey: string, rows: MenuItemRecord[], at: string): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query(`delete from inventory_menu_items where tenant_id = $1 and menu_key = $2`, [tenantId, menuKey]);
      for (const r of rows) {
        await c.query(`insert into inventory_menu_items (id, tenant_id, menu_key, item_id, qty, learned_by, updated_at) values ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), tenantId, menuKey, r.itemId, r.qty, r.learnedBy, at]);
      }
    });
  }

  async getPublication(tenantId: string): Promise<PublicationRecord | null> {
    const rows = await this.q<{ public_key: string; approved: InventoryPublicationScope; approved_by: string; approved_at: unknown; status: 'live' | 'stopped'; snapshot: InventoryPublicSnapshot | null; snapshot_at: unknown }>(
      tenantId, 'select public_key, approved, approved_by, approved_at, status, snapshot, snapshot_at from inventory_publications where tenant_id = $1', [tenantId]);
    const r = rows[0];
    return r ? {
      key: r.public_key, scope: r.approved, approvedBy: r.approved_by, approvedAt: iso(r.approved_at), status: r.status,
      snapshot: r.snapshot, snapshotAt: r.snapshot_at ? iso(r.snapshot_at) : null,
    } : null;
  }

  async approvePublication(tenantId: string, p: { key: string; scope: InventoryPublicationScope; approvedBy: string; approvedAt: string }): Promise<void> {
    await this.q(tenantId, `insert into inventory_publications (tenant_id, public_key, approved, approved_by, approved_at, status)
      values ($1, $2, $3, $4, $5, 'live')
      on conflict (tenant_id) do update set approved = excluded.approved, approved_by = excluded.approved_by,
        approved_at = excluded.approved_at, status = 'live'`, [tenantId, p.key, JSON.stringify(p.scope), p.approvedBy, p.approvedAt]);
  }

  async setPublicationStatus(tenantId: string, status: 'live' | 'stopped'): Promise<void> {
    await this.q(tenantId, 'update inventory_publications set status = $2 where tenant_id = $1', [tenantId, status]);
  }

  async savePublicationSnapshot(tenantId: string, snapshot: InventoryPublicSnapshot, at: string): Promise<void> {
    await this.q(tenantId, 'update inventory_publications set snapshot = $2, snapshot_at = $3 where tenant_id = $1', [tenantId, JSON.stringify(snapshot), at]);
  }

  async findPublicationByKey(key: string): Promise<{ tenantId: string; status: 'live' | 'stopped'; snapshot: InventoryPublicSnapshot | null } | null> {
    // 会社の判定より前に呼ぶ。鍵で 1 行だけ返す関数を使う（移行 038）
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ tenant_id: string; status: 'live' | 'stopped'; snapshot: InventoryPublicSnapshot | null }>(
        'select tenant_id, status, snapshot from m2o_inventory_publication($1)', [key]);
      const r = rows[0];
      return r ? { tenantId: r.tenant_id, status: r.status, snapshot: r.snapshot } : null;
    } finally {
      client.release();
    }
  }
}

// ---- メモリ（自動テスト用） ----------------------------------------------

/**
 * メモリの在庫の置き場。自動テストに使う。
 *
 * @remarks PostgreSQL 版と同じ決まり（いまの数を記録と同時に直す・会社で絞る）で動く
 */
export class MemoryInventoryStore implements InventoryStore {
  readonly items = new Map<string, InventoryItem & { tenantId: string }>();
  readonly codes = new Map<string, { tenantId: string; itemId: string }>();
  readonly suppliers = new Map<string, InventorySupplier & { tenantId: string }>();
  readonly locations = new Map<string, InventoryLocation & { tenantId: string; removed: boolean }>();
  readonly lots = new Map<string, LotRecord & { tenantId: string }>();
  readonly moves: (NewMove & { tenantId: string })[] = [];
  readonly stock = new Map<string, { tenantId: string; itemId: string; locationId: string; lotId: string | null; qty: number }>();
  readonly held = new Map<string, number>();

  private withCodes(i: InventoryItem & { tenantId: string }): InventoryItem {
    const { tenantId, ...rest } = i;
    return { ...rest, codes: [...this.codes].filter(([, v]) => v.tenantId === tenantId && v.itemId === i.id).map(([k]) => k.split('\u0000')[1]!) };
  }

  async listItems(tenantId: string, opts: { includeStopped?: boolean } = {}): Promise<InventoryItem[]> {
    return [...this.items.values()].filter((i) => i.tenantId === tenantId && (opts.includeStopped || i.status === 'active'))
      .map((i) => this.withCodes(i)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  async getItem(tenantId: string, id: string): Promise<InventoryItem | null> {
    const i = this.items.get(id);
    return i && i.tenantId === tenantId ? this.withCodes(i) : null;
  }

  async saveItem(tenantId: string, item: ItemRecord, _userId: string, at: string): Promise<void> {
    const prev = this.items.get(item.id);
    if (prev && prev.tenantId !== tenantId) return;
    this.items.set(item.id, { ...item, codes: [], updatedAt: at, tenantId });
  }

  async addCode(tenantId: string, itemId: string, value: string): Promise<boolean> {
    const k = `${tenantId}\u0000${value}`;
    const cur = this.codes.get(k);
    if (cur) return cur.itemId === itemId;
    this.codes.set(k, { tenantId, itemId });
    return true;
  }

  async removeCode(tenantId: string, itemId: string, value: string): Promise<void> {
    const k = `${tenantId}\u0000${value}`;
    if (this.codes.get(k)?.itemId === itemId) this.codes.delete(k);
  }

  async findItemByCode(tenantId: string, value: string): Promise<InventoryItem | null> {
    const hit = this.codes.get(`${tenantId}\u0000${value}`);
    if (hit) return this.getItem(tenantId, hit.itemId);
    const bySku = [...this.items.values()].find((i) => i.tenantId === tenantId && i.sku && i.sku === value);
    return bySku ? this.withCodes(bySku) : null;
  }

  async listSuppliers(tenantId: string): Promise<InventorySupplier[]> {
    return [...this.suppliers.values()].filter((s) => s.tenantId === tenantId).map(({ tenantId: _t, ...s }) => s);
  }

  async saveSupplier(tenantId: string, s: InventorySupplier): Promise<void> {
    this.suppliers.set(s.id, { ...s, tenantId });
  }

  async listLocations(tenantId: string): Promise<InventoryLocation[]> {
    return [...this.locations.values()].filter((l) => l.tenantId === tenantId && !l.removed)
      .map(({ tenantId: _t, removed: _r, ...l }) => l);
  }

  async saveLocation(tenantId: string, loc: InventoryLocation): Promise<void> {
    this.locations.set(loc.id, { ...loc, tenantId, removed: false });
  }

  async removeLocation(tenantId: string, id: string): Promise<boolean> {
    const left = [...this.stock.values()].some((s) => s.tenantId === tenantId && s.locationId === id && s.qty !== 0);
    if (left) return false;
    const l = this.locations.get(id);
    if (l && l.tenantId === tenantId) l.removed = true;
    return true;
  }

  async findLot(tenantId: string, itemId: string, lot: string): Promise<LotRecord | null> {
    const l = [...this.lots.values()].find((x) => x.tenantId === tenantId && x.itemId === itemId && x.lot === lot);
    return l ? { id: l.id, itemId: l.itemId, lot: l.lot, expiresOn: l.expiresOn } : null;
  }

  async saveLot(tenantId: string, lot: LotRecord): Promise<void> {
    const cur = [...this.lots.values()].find((x) => x.tenantId === tenantId && x.itemId === lot.itemId && x.lot === lot.lot);
    if (cur) { cur.expiresOn = lot.expiresOn ?? cur.expiresOn; return; }
    this.lots.set(lot.id, { ...lot, tenantId });
  }

  async listStock(tenantId: string, itemIds?: string[]): Promise<StockRecord[]> {
    return [...this.stock.values()]
      .filter((s) => s.tenantId === tenantId && s.qty !== 0 && (!itemIds || itemIds.includes(s.itemId)))
      .map((s) => {
        const lot = s.lotId ? this.lots.get(s.lotId) : undefined;
        return { itemId: s.itemId, locationId: s.locationId, lotId: s.lotId, lot: lot?.lot ?? null, expiresOn: lot?.expiresOn ?? null, qty: s.qty };
      })
      .sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999'));
  }

  async heldByItem(tenantId: string): Promise<Map<string, number>> {
    const out = new Map([...this.held].filter(([k]) => k.startsWith(`${tenantId}\u0000`)).map(([k, v]) => [k.split('\u0000')[1]!, v]));
    for (const r of this.reservations.values()) if (r.tenantId === tenantId && r.status === 'held') out.set(r.itemId, (out.get(r.itemId) ?? 0) + r.qty);
    return out;
  }

  async applyMoves(tenantId: string, moves: NewMove[]): Promise<void> {
    const bump = (m: NewMove, loc: string, d: number) => {
      const k = `${tenantId}\u0000${m.itemId}\u0000${loc}\u0000${m.lotId ?? ''}`;
      const cur = this.stock.get(k) ?? { tenantId, itemId: m.itemId, locationId: loc, lotId: m.lotId, qty: 0 };
      cur.qty += d;
      this.stock.set(k, cur);
    };
    for (const m of moves) {
      this.moves.push({ ...m, tenantId });
      if (m.kind === 'transfer') {
        if (m.fromLocationId) bump(m, m.fromLocationId, -Math.abs(m.delta));
        if (m.toLocationId) bump(m, m.toLocationId, Math.abs(m.delta));
      } else {
        const loc = m.delta >= 0 ? (m.toLocationId ?? m.fromLocationId) : (m.fromLocationId ?? m.toLocationId);
        if (loc) bump(m, loc, m.delta);
      }
    }
  }

  private toView(m: NewMove & { tenantId: string }): InventoryMove {
    return {
      id: m.id, kind: m.kind, itemId: m.itemId, itemName: this.items.get(m.itemId)?.name, lotId: m.lotId,
      lot: m.lotId ? this.lots.get(m.lotId)?.lot ?? null : null, fromLocationId: m.fromLocationId, toLocationId: m.toLocationId,
      delta: m.delta, reason: m.reason, source: m.source, reversalOf: m.reversalOf, createdBy: m.createdBy, createdAt: m.createdAt,
    };
  }

  async getMove(tenantId: string, id: string): Promise<InventoryMove | null> {
    const m = this.moves.find((x) => x.tenantId === tenantId && x.id === id);
    return m ? this.toView(m) : null;
  }

  async listMoves(tenantId: string, q: MoveQuery): Promise<InventoryMove[]> {
    return this.moves
      .filter((m) => m.tenantId === tenantId && (!q.itemId || m.itemId === q.itemId)
        && (!q.since || m.createdAt >= q.since) && (!q.until || m.createdAt < q.until))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit ?? 200).map((m) => this.toView(m));
  }

  async isReversed(tenantId: string, moveId: string): Promise<boolean> {
    return this.moves.some((m) => m.tenantId === tenantId && m.reversalOf === moveId);
  }

  async siblings(tenantId: string, moveId: string): Promise<InventoryMove[]> {
    const o = this.moves.find((m) => m.tenantId === tenantId && m.id === moveId);
    if (!o) return [];
    return this.moves.filter((m) => m.tenantId === tenantId && m.batchId === o.batchId).map((m) => this.toView(m));
  }

  readonly counts = new Map<string, InventoryCount & { tenantId: string }>();
  readonly countLines = new Map<string, CountLineRecord & { tenantId: string; countId: string }>();

  async createCount(tenantId: string, c: InventoryCount): Promise<void> {
    this.counts.set(c.id, { ...c, status: 'open', tenantId });
  }

  async getCount(tenantId: string, id: string): Promise<InventoryCount | null> {
    const c = this.counts.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = c;
    return rest;
  }

  async openCount(tenantId: string): Promise<InventoryCount | null> {
    const c = [...this.counts.values()].filter((x) => x.tenantId === tenantId && x.status === 'open').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return c ? this.getCount(tenantId, c.id) : null;
  }

  async listCounts(tenantId: string, limit = 20): Promise<InventoryCount[]> {
    const all = [...this.counts.values()].filter((x) => x.tenantId === tenantId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
    return Promise.all(all.map((c) => this.getCount(tenantId, c.id) as Promise<InventoryCount>));
  }

  async addCountLine(tenantId: string, e: CountEntry): Promise<CountLineRecord> {
    const k = `${e.countId}\u0000${e.itemId}\u0000${e.locationId}\u0000${e.lotId ?? ''}`;
    const cur = this.countLines.get(k);
    const lot = e.lotId ? this.lots.get(e.lotId) : undefined;
    const next = {
      tenantId, countId: e.countId, itemId: e.itemId, locationId: e.locationId, lotId: e.lotId, lot: lot?.lot ?? null,
      expiresOn: lot?.expiresOn ?? null, counted: e.mode === 'set' || !cur ? e.qty : cur.counted + e.qty,
      bookAtCount: cur ? cur.bookAtCount : e.bookAtCount, countedBy: e.countedBy, updatedAt: e.at,
    };
    this.countLines.set(k, next);
    const { tenantId: _t, countId: _c, ...rest } = next;
    return rest;
  }

  async listCountLines(tenantId: string, countId: string): Promise<CountLineRecord[]> {
    return [...this.countLines.values()].filter((l) => l.tenantId === tenantId && l.countId === countId)
      .map(({ tenantId: _t, countId: _c, ...rest }) => rest);
  }

  async setCountStatus(tenantId: string, id: string, status: 'closed' | 'cancelled', userId: string, at: string): Promise<void> {
    const c = this.counts.get(id);
    if (c && c.tenantId === tenantId && c.status === 'open') Object.assign(c, { status, closedBy: userId, closedAt: at });
  }
  readonly bookingSources = new Map<string, InventoryBookingSource & { tenantId: string; hookHash: string }>();
  readonly bookings = new Map<string, Omit<BookingRecord, 'at'> & { tenantId: string; updatedAt: string }>();
  readonly reservations = new Map<string, ReservationRecord & { tenantId: string; status: InventoryReservationLine['status'] }>();
  readonly menuItems = new Map<string, MenuItemRecord[]>();

  async listBookingSources(tenantId: string): Promise<InventoryBookingSource[]> {
    return [...this.bookingSources.values()].filter((s) => s.tenantId === tenantId).map(({ tenantId: _t, hookHash: _h, ...s }) => s);
  }

  async createBookingSource(tenantId: string, s: { id: string; name: string; hookHash: string; createdBy: string; at: string }): Promise<void> {
    this.bookingSources.set(s.id, { id: s.id, name: s.name, mapping: null, status: 'active', createdAt: s.at, lastReceivedAt: null, tenantId, hookHash: s.hookHash });
  }

  async updateBookingSource(tenantId: string, id: string, patch: { mapping?: InventoryBookingMapping | null; status?: 'active' | 'stopped'; lastReceivedAt?: string }): Promise<void> {
    const s = this.bookingSources.get(id);
    if (!s || s.tenantId !== tenantId) return;
    if (patch.mapping !== undefined) s.mapping = patch.mapping;
    if (patch.status) s.status = patch.status;
    if (patch.lastReceivedAt) s.lastReceivedAt = patch.lastReceivedAt;
  }

  async findBookingSourceByHash(hookHash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null> {
    const s = [...this.bookingSources.values()].find((x) => x.hookHash === hookHash);
    return s ? { id: s.id, tenantId: s.tenantId, status: s.status } : null;
  }

  async upsertBooking(tenantId: string, b: BookingRecord): Promise<string> {
    const cur = [...this.bookings.values()].find((x) => x.tenantId === tenantId && x.sourceKey === b.sourceKey && x.externalId === b.externalId);
    if (cur) {
      Object.assign(cur, { startsAt: b.startsAt, menu: b.menu, status: b.status, updatedAt: b.at });
      return cur.id;
    }
    const { at, ...rest } = b;
    this.bookings.set(b.id, { ...rest, tenantId, updatedAt: at });
    return b.id;
  }

  private viewBooking(b: Omit<BookingRecord, 'at'> & { tenantId: string; updatedAt: string }): InventoryBooking {
    const src = this.bookingSources.get(b.sourceKey);
    return {
      id: b.id, sourceKey: b.sourceKey, sourceName: src?.name, externalId: b.externalId, startsAt: b.startsAt, menu: b.menu,
      status: b.status, mapped: b.mapped, updatedAt: b.updatedAt,
      lines: [...this.reservations.values()].filter((r) => r.tenantId === b.tenantId && r.bookingId === b.id)
        .map((r) => ({ id: r.id, itemId: r.itemId, itemName: this.items.get(r.itemId)?.name, unit: this.items.get(r.itemId)?.unit, qty: r.qty, status: r.status })),
    };
  }

  async getBooking(tenantId: string, id: string): Promise<InventoryBooking | null> {
    const b = this.bookings.get(id);
    return b && b.tenantId === tenantId ? this.viewBooking(b) : null;
  }

  async listBookings(tenantId: string, q: BookingQuery): Promise<InventoryBooking[]> {
    return [...this.bookings.values()]
      .filter((b) => b.tenantId === tenantId && (!q.from || (b.startsAt ?? '') >= q.from) && (!q.to || (b.startsAt !== null && b.startsAt < q.to))
        && (!q.status || b.status === q.status) && (!q.unmappedOnly || !b.mapped) && (q.menuKey === undefined || b.menu.toLowerCase() === q.menuKey))
      .sort((a, b) => (a.startsAt ?? '9999').localeCompare(b.startsAt ?? '9999'))
      .slice(0, q.limit ?? 200).map((b) => this.viewBooking(b));
  }

  async updateBooking(tenantId: string, id: string, patch: { status?: InventoryBookingStatus; mapped?: boolean; startsAt?: string | null; at: string }): Promise<void> {
    const b = this.bookings.get(id);
    if (!b || b.tenantId !== tenantId) return;
    if (patch.status) b.status = patch.status;
    if (patch.mapped !== undefined) b.mapped = patch.mapped;
    if (patch.startsAt !== undefined) b.startsAt = patch.startsAt;
    b.updatedAt = patch.at;
  }

  async addReservation(tenantId: string, r: ReservationRecord): Promise<void> {
    this.reservations.set(r.id, { ...r, tenantId, status: 'held' });
  }

  async setReservationStatus(tenantId: string, id: string, status: 'used' | 'cancelled'): Promise<void> {
    const r = this.reservations.get(id);
    if (r && r.tenantId === tenantId && r.status === 'held') r.status = status;
  }

  async setReservationTime(tenantId: string, bookingId: string, bookedAt: string | null): Promise<void> {
    for (const r of this.reservations.values()) if (r.tenantId === tenantId && r.bookingId === bookingId && r.status === 'held') r.bookedAt = bookedAt;
  }

  async listMenuItems(tenantId: string, menuKey: string): Promise<MenuItemRecord[]> {
    return [...(this.menuItems.get(`${tenantId}\u0000${menuKey}`) ?? [])];
  }

  async setMenuItems(tenantId: string, menuKey: string, rows: MenuItemRecord[]): Promise<void> {
    this.menuItems.set(`${tenantId}\u0000${menuKey}`, [...rows]);
  }

  readonly publications = new Map<string, PublicationRecord>();

  async getPublication(tenantId: string): Promise<PublicationRecord | null> {
    const p = this.publications.get(tenantId);
    return p ? { ...p } : null;
  }

  async approvePublication(tenantId: string, p: { key: string; scope: InventoryPublicationScope; approvedBy: string; approvedAt: string }): Promise<void> {
    const prev = this.publications.get(tenantId);
    this.publications.set(tenantId, { snapshot: null, snapshotAt: null, ...prev, ...p, key: prev?.key ?? p.key, status: 'live' });
  }

  async setPublicationStatus(tenantId: string, status: 'live' | 'stopped'): Promise<void> {
    const p = this.publications.get(tenantId);
    if (p) p.status = status;
  }

  async savePublicationSnapshot(tenantId: string, snapshot: InventoryPublicSnapshot, at: string): Promise<void> {
    const p = this.publications.get(tenantId);
    if (p) { p.snapshot = snapshot; p.snapshotAt = at; }
  }

  async findPublicationByKey(key: string): Promise<{ tenantId: string; status: 'live' | 'stopped'; snapshot: InventoryPublicSnapshot | null } | null> {
    for (const [tenantId, p] of this.publications) if (p.key === key) return { tenantId, status: p.status, snapshot: p.snapshot };
    return null;
  }
}
