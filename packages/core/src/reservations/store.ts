/**
 * @file 予約の置き場（仕様書 第37.12節）。PostgreSQL（行単位の制限つき）と、テスト用のメモリ。
 *
 * 同じものの、時間が重なる予約は、PostgreSQL では期間の重なりを断る制約で断る（画面と秘書が同時に取っても重ならない）。
 * 断ったときは {@link ReservationOverlapError} を投げる。メモリの置き場も同じように断る。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ReservableItem, ReservableKind, Reservation, ReservationSeries } from '@m2office/shared';

/** 置き場に持つ予約（予約した人の名前は持たない。見せるときに引く）。 */
export type StoredReservation = Omit<Reservation, 'userName'>;

/** 新しく入れる予約。 */
export type NewReservation = Pick<StoredReservation, 'itemId' | 'startAt' | 'endAt' | 'purpose' | 'userId' | 'createdBy'> & { seriesId?: string | null };

/** 新しく作る繰り返し。 */
export type NewSeries = Pick<ReservationSeries, 'itemId' | 'userId' | 'purpose' | 'rule' | 'weekday' | 'nth' | 'startTime' | 'endTime' | 'startsOn' | 'endsOn' | 'createdBy'>;

/** 直せる繰り返しの項目。 */
export type SeriesPatch = Partial<Pick<ReservationSeries, 'status' | 'materializedUntil' | 'skipped' | 'endsOn'>>;

/** 直せる予約の項目。 */
export type ReservationPatch = Partial<Pick<StoredReservation, 'itemId' | 'startAt' | 'endAt' | 'purpose' | 'calendarEventId' | 'status'>>;

/** 新しく足す予約できるもの。 */
export type NewItem = Pick<ReservableItem, 'name' | 'kind' | 'capacity' | 'location' | 'sortOrder' | 'createdBy'>;

/** 直せる予約できるものの項目。 */
export type ItemPatch = Partial<Pick<ReservableItem, 'name' | 'kind' | 'capacity' | 'location' | 'sortOrder' | 'status'>>;

/** 同じものの時間が重なる予約を入れようとした。 */
export class ReservationOverlapError extends Error {
  constructor() {
    super('同じものの、時間が重なる予約があります');
    this.name = 'ReservationOverlapError';
  }
}

/** 名前が会社の中で重なる。 */
export class ItemNameTakenError extends Error {
  constructor() {
    super('同じ名前の予約できるものがあります');
    this.name = 'ItemNameTakenError';
  }
}

/** 予約の置き場。 */
export interface ReservationStore {
  listItems(tenantId: string): Promise<ReservableItem[]>;
  getItem(tenantId: string, id: string): Promise<ReservableItem | null>;
  createItem(tenantId: string, item: NewItem): Promise<string>;
  updateItem(tenantId: string, id: string, patch: ItemPatch): Promise<void>;
  /** 期間に重なる、取り消していない予約（始めの順）。`itemId` を渡せばそのものだけ。 */
  list(tenantId: string, range: { from: string; to: string; itemId?: string; userId?: string }): Promise<StoredReservation[]>;
  get(tenantId: string, id: string): Promise<StoredReservation | null>;
  /** @throws {ReservationOverlapError} 同じものの時間が重なる予約があれば */
  create(tenantId: string, r: NewReservation): Promise<string>;
  /** @throws {ReservationOverlapError} 直した結果、同じものの時間が重なれば */
  update(tenantId: string, id: string, patch: ReservationPatch, by: string): Promise<void>;
  /** 終わりが `before` より前の予約を消す（第37.11節）。消した数を返す。 */
  purge(tenantId: string, before: string): Promise<number>;
  /** 繰り返しの、`from` より後に始まる取り消していない予約（始めの順）。 */
  listBySeries(tenantId: string, seriesId: string, from: string): Promise<StoredReservation[]>;
  createSeries(tenantId: string, s: NewSeries): Promise<string>;
  getSeries(tenantId: string, id: string): Promise<ReservationSeries | null>;
  /** 続いている繰り返し（会社ごと）。 */
  activeSeries(tenantId: string): Promise<ReservationSeries[]>;
  updateSeries(tenantId: string, id: string, patch: SeriesPatch): Promise<void>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());

interface ItemRow {
  id: string; name: string; kind: ReservableKind; capacity: number | null; location: string; sort_order: number;
  status: 'active' | 'stopped'; created_by: string; created_at: unknown;
}
interface Row {
  id: string; item_id: string; start_at: unknown; end_at: unknown; purpose: string; user_id: string; calendar_event_id: string | null;
  status: 'booked' | 'cancelled'; series_id: string | null; created_by: string; created_at: unknown; updated_by: string; updated_at: unknown;
}
interface SeriesRow {
  id: string; item_id: string; user_id: string; purpose: string; rule: ReservationSeries['rule']; weekday: number; nth: number | null;
  start_time: string; end_time: string; starts_on: unknown; ends_on: unknown; status: 'active' | 'stopped'; materialized_until: unknown;
  skipped: unknown[] | null; created_by: string; created_at: unknown;
}
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const toSeries = (r: SeriesRow): ReservationSeries => ({
  id: r.id, itemId: r.item_id, userId: r.user_id, purpose: r.purpose, rule: r.rule, weekday: r.weekday, nth: r.nth, startTime: r.start_time, endTime: r.end_time,
  startsOn: day(r.starts_on)!, endsOn: day(r.ends_on), status: r.status, materializedUntil: day(r.materialized_until),
  skipped: (r.skipped ?? []).map((x) => day(x)!).filter(Boolean), createdBy: r.created_by, createdAt: iso(r.created_at),
});

const toItem = (r: ItemRow): ReservableItem => ({
  id: r.id, name: r.name, kind: r.kind, capacity: r.capacity, location: r.location, sortOrder: r.sort_order, status: r.status,
  createdBy: r.created_by, createdAt: iso(r.created_at),
});
const toReservation = (r: Row): StoredReservation => ({
  id: r.id, itemId: r.item_id, startAt: iso(r.start_at), endAt: iso(r.end_at), purpose: r.purpose, userId: r.user_id,
  calendarEventId: r.calendar_event_id, status: r.status, seriesId: r.series_id ?? null, createdBy: r.created_by, createdAt: iso(r.created_at),
  updatedBy: r.updated_by, updatedAt: iso(r.updated_at),
});
const byItemOrder = (a: ReservableItem, b: ReservableItem) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt);

/** 直せる項目と列の対応（利用者の入力を列名に使わない）。 */
const ITEM_COLUMNS: Record<keyof ItemPatch, string> = {
  name: 'name', kind: 'kind', capacity: 'capacity', location: 'location', sortOrder: 'sort_order', status: 'status',
};
const COLUMNS: Record<keyof ReservationPatch, string> = {
  itemId: 'item_id', startAt: 'start_at', endAt: 'end_at', purpose: 'purpose', calendarEventId: 'calendar_event_id', status: 'status',
};

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresReservationStore implements ReservationStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
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
      // 期間の重なりを断る制約（23P01）と、名前の重なり（23505）
      const code = (err as { code?: string }).code;
      if (code === '23P01') throw new ReservationOverlapError();
      if (code === '23505') throw new ItemNameTakenError();
      throw err;
    } finally {
      c.release();
    }
  }

  async listItems(tenantId: string): Promise<ReservableItem[]> {
    const rows = await this.q<ItemRow>(tenantId, `select * from reservable_items where tenant_id = $1 order by sort_order, created_at`, [tenantId]);
    return rows.map(toItem);
  }

  async getItem(tenantId: string, id: string): Promise<ReservableItem | null> {
    const rows = await this.q<ItemRow>(tenantId, `select * from reservable_items where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async createItem(tenantId: string, item: NewItem): Promise<string> {
    const id = `rsi-${randomUUID()}`;
    await this.q(tenantId,
      `insert into reservable_items (id, tenant_id, name, kind, capacity, location, sort_order, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, item.name, item.kind, item.capacity, item.location, item.sortOrder, item.createdBy]);
    return id;
  }

  async updateItem(tenantId: string, id: string, patch: ItemPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch) as [keyof ItemPatch, unknown][]) {
      if (v === undefined || !ITEM_COLUMNS[k]) continue;
      params.push(v);
      sets.push(`${ITEM_COLUMNS[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    await this.q(tenantId, `update reservable_items set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async list(tenantId: string, range: { from: string; to: string; itemId?: string; userId?: string }): Promise<StoredReservation[]> {
    const where = [`tenant_id = $1`, `status = 'booked'`, `start_at < $3`, `end_at > $2`];
    const params: unknown[] = [tenantId, range.from, range.to];
    if (range.itemId) { params.push(range.itemId); where.push(`item_id = $${params.length}`); }
    if (range.userId) { params.push(range.userId); where.push(`user_id = $${params.length}`); }
    const rows = await this.q<Row>(tenantId, `select * from reservations where ${where.join(' and ')} order by start_at limit 2000`, params);
    return rows.map(toReservation);
  }

  async get(tenantId: string, id: string): Promise<StoredReservation | null> {
    const rows = await this.q<Row>(tenantId, `select * from reservations where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toReservation(rows[0]) : null;
  }

  async create(tenantId: string, r: NewReservation): Promise<string> {
    const id = `rsv-${randomUUID()}`;
    await this.q(tenantId,
      `insert into reservations (id, tenant_id, item_id, start_at, end_at, purpose, user_id, series_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [id, tenantId, r.itemId, r.startAt, r.endAt, r.purpose, r.userId, r.seriesId ?? null, r.createdBy]);
    return id;
  }

  async update(tenantId: string, id: string, patch: ReservationPatch, by: string): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch) as [keyof ReservationPatch, unknown][]) {
      if (v === undefined || !COLUMNS[k]) continue;
      params.push(v);
      sets.push(`${COLUMNS[k]} = $${params.length}`);
    }
    if (!sets.length) return;
    params.push(by);
    await this.q(tenantId, `update reservations set ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async purge(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from reservations where tenant_id = $1 and end_at < $2 returning id`, [tenantId, before]);
    return rows.length;
  }

  async listBySeries(tenantId: string, seriesId: string, from: string): Promise<StoredReservation[]> {
    const rows = await this.q<Row>(tenantId,
      `select * from reservations where tenant_id = $1 and series_id = $2 and status = 'booked' and start_at >= $3 order by start_at limit 500`, [tenantId, seriesId, from]);
    return rows.map(toReservation);
  }

  async createSeries(tenantId: string, s: NewSeries): Promise<string> {
    const id = `rss-${randomUUID()}`;
    await this.q(tenantId,
      `insert into reservation_series (id, tenant_id, item_id, user_id, purpose, rule, weekday, nth, start_time, end_time, starts_on, ends_on, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, tenantId, s.itemId, s.userId, s.purpose, s.rule, s.weekday, s.nth, s.startTime, s.endTime, s.startsOn, s.endsOn, s.createdBy]);
    return id;
  }

  async getSeries(tenantId: string, id: string): Promise<ReservationSeries | null> {
    const rows = await this.q<SeriesRow>(tenantId, `select * from reservation_series where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toSeries(rows[0]) : null;
  }

  async activeSeries(tenantId: string): Promise<ReservationSeries[]> {
    return (await this.q<SeriesRow>(tenantId, `select * from reservation_series where tenant_id = $1 and status = 'active' order by created_at`, [tenantId])).map(toSeries);
  }

  async updateSeries(tenantId: string, id: string, patch: SeriesPatch): Promise<void> {
    const cols: Record<string, string> = { status: 'status', materializedUntil: 'materialized_until', skipped: 'skipped', endsOn: 'ends_on' };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if (sets.length) await this.q(tenantId, `update reservation_series set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }
}

/** テスト用のメモリの置き場（重なりも PostgreSQL と同じように断る）。 */
export class MemoryReservationStore implements ReservationStore {
  readonly items = new Map<string, ReservableItem & { tenantId: string }>();
  readonly rows = new Map<string, StoredReservation & { tenantId: string }>();
  readonly series = new Map<string, ReservationSeries & { tenantId: string }>();

  async listItems(tenantId: string): Promise<ReservableItem[]> {
    return [...this.items.values()].filter((i) => i.tenantId === tenantId).map(({ tenantId: _t, ...i }) => ({ ...i })).sort(byItemOrder);
  }

  async getItem(tenantId: string, id: string): Promise<ReservableItem | null> {
    const i = this.items.get(id);
    if (!i || i.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = i;
    return { ...rest };
  }

  async createItem(tenantId: string, item: NewItem): Promise<string> {
    if ([...this.items.values()].some((i) => i.tenantId === tenantId && i.name === item.name)) throw new ItemNameTakenError();
    const id = `rsi-${randomUUID()}`;
    this.items.set(id, { ...item, id, tenantId, status: 'active', createdAt: new Date(Date.now() + this.items.size).toISOString() });
    return id;
  }

  async updateItem(tenantId: string, id: string, patch: ItemPatch): Promise<void> {
    const i = this.items.get(id);
    if (!i || i.tenantId !== tenantId) return;
    if (patch.name && [...this.items.values()].some((x) => x.tenantId === tenantId && x.id !== id && x.name === patch.name)) throw new ItemNameTakenError();
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (i as unknown as Record<string, unknown>)[k] = v;
  }

  private overlaps(tenantId: string, itemId: string, startAt: string, endAt: string, exceptId: string | null): boolean {
    return [...this.rows.values()].some((r) => r.tenantId === tenantId && r.id !== exceptId && r.status === 'booked' && r.itemId === itemId
      && Date.parse(r.startAt) < Date.parse(endAt) && Date.parse(r.endAt) > Date.parse(startAt));
  }

  async list(tenantId: string, range: { from: string; to: string; itemId?: string; userId?: string }): Promise<StoredReservation[]> {
    const from = Date.parse(range.from);
    const to = Date.parse(range.to);
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId && r.status === 'booked' && Date.parse(r.startAt) < to && Date.parse(r.endAt) > from)
      .filter((r) => !range.itemId || r.itemId === range.itemId)
      .filter((r) => !range.userId || r.userId === range.userId)
      .map(({ tenantId: _t, ...r }) => ({ ...r }))
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  async get(tenantId: string, id: string): Promise<StoredReservation | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = r;
    return { ...rest };
  }

  async create(tenantId: string, r: NewReservation): Promise<string> {
    const startAt = new Date(r.startAt).toISOString();
    const endAt = new Date(r.endAt).toISOString();
    if (this.overlaps(tenantId, r.itemId, startAt, endAt, null)) throw new ReservationOverlapError();
    const id = `rsv-${randomUUID()}`;
    const at = new Date().toISOString();
    this.rows.set(id, {
      ...r, startAt, endAt, id, tenantId, calendarEventId: null, status: 'booked', seriesId: r.seriesId ?? null, updatedBy: r.createdBy, createdAt: at, updatedAt: at,
    });
    return id;
  }

  async update(tenantId: string, id: string, patch: ReservationPatch, by: string): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    const next = {
      ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    } as StoredReservation & { tenantId: string };
    next.startAt = new Date(next.startAt).toISOString();
    next.endAt = new Date(next.endAt).toISOString();
    if (next.status === 'booked' && this.overlaps(tenantId, next.itemId, next.startAt, next.endAt, id)) throw new ReservationOverlapError();
    this.rows.set(id, { ...next, updatedBy: by, updatedAt: new Date().toISOString() });
  }

  async purge(tenantId: string, before: string): Promise<number> {
    let n = 0;
    for (const [id, r] of this.rows) {
      if (r.tenantId === tenantId && Date.parse(r.endAt) < Date.parse(before)) { this.rows.delete(id); n += 1; }
    }
    return n;
  }

  async listBySeries(tenantId: string, seriesId: string, from: string): Promise<StoredReservation[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.seriesId === seriesId && r.status === 'booked' && Date.parse(r.startAt) >= Date.parse(from))
      .map(({ tenantId: _t, ...r }) => ({ ...r })).sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  async createSeries(tenantId: string, s: NewSeries): Promise<string> {
    const id = `rss-${randomUUID()}`;
    this.series.set(id, { ...s, id, tenantId, status: 'active', materializedUntil: null, skipped: [], createdAt: new Date().toISOString() });
    return id;
  }

  async getSeries(tenantId: string, id: string): Promise<ReservationSeries | null> {
    const r = this.series.get(id);
    if (!r || r.tenantId !== tenantId) return null;
    const { tenantId: _t, ...rest } = r;
    return { ...rest, skipped: [...rest.skipped] };
  }

  async activeSeries(tenantId: string): Promise<ReservationSeries[]> {
    return [...this.series.values()].filter((x) => x.tenantId === tenantId && x.status === 'active').map(({ tenantId: _t, ...x }) => ({ ...x, skipped: [...x.skipped] }));
  }

  async updateSeries(tenantId: string, id: string, patch: SeriesPatch): Promise<void> {
    const r = this.series.get(id);
    if (r && r.tenantId === tenantId) this.series.set(id, { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
  }
}
