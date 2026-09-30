/**
 * @file 店頭サイネージの置き場（仕様書 第31.15.1節）。画面・ふだん動いている時間帯・登録を待つ番号・素材・流れ。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。画面の鍵は SHA-256 のハッシュだけを持つ。
 */

import pg from 'pg';
import type { SignageAsset, SignageEntry, SignageOrientation, SignageReport, SignageRotation } from '@m2office/shared';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** 置き場の中の画面（鍵のハッシュと状態を含む）。 */
export interface ScreenRecord {
  id: string;
  name: string;
  orientation: SignageOrientation;
  rotation: SignageRotation;
  volume: number;
  status: 'active' | 'removed';
  flowVersion: number;
  lastSeenAt: string | null;
  lastReport: SignageReport | null;
  offlineNotifiedAt: string | null;
  registeredAt: string;
  removedAt: string | null;
}

/** 登録を待つ番号。 */
export interface PairingRecord {
  id: string;
  code: string;
  secretHash: string;
  viewport: { width: number; height: number };
  expiresAt: string;
  screenId: string | null;
  createdAt: string;
}

/** 素材を足すときの値。 */
export type AssetInput = Omit<SignageAsset, 'hasThumbnail' | 'createdAt'> & { thumbnail: Uint8Array | null };

interface ScreenRow {
  id: string; name: string; orientation: SignageOrientation; rotation: number; volume: number; status: 'active' | 'removed';
  flow_version: number; last_seen_at: unknown; last_report: SignageReport | null; offline_notified_at: unknown; registered_at: unknown; removed_at: unknown;
}
const SCREEN_COLS = 'id, name, orientation, rotation, volume, status, flow_version, last_seen_at, last_report, offline_notified_at, registered_at, removed_at';
const toScreen = (r: ScreenRow): ScreenRecord => ({
  id: r.id, name: r.name, orientation: r.orientation, rotation: r.rotation as SignageRotation, volume: r.volume, status: r.status,
  flowVersion: r.flow_version, lastSeenAt: r.last_seen_at ? iso(r.last_seen_at) : null, lastReport: r.last_report,
  offlineNotifiedAt: r.offline_notified_at ? iso(r.offline_notified_at) : null, registeredAt: iso(r.registered_at), removedAt: r.removed_at ? iso(r.removed_at) : null,
});

interface AssetRow {
  id: string; kind: SignageAsset['kind']; name: string; mime: SignageAsset['mime']; bytes: string | number; sha256: string;
  width: number; height: number; duration_ms: number | null; has_thumbnail: boolean; created_at: unknown;
}
const ASSET_COLS = 'id, kind, name, mime, bytes, sha256, width, height, duration_ms, thumbnail is not null as has_thumbnail, created_at';
const toAsset = (r: AssetRow): SignageAsset => ({
  id: r.id, kind: r.kind, name: r.name, mime: r.mime, bytes: Number(r.bytes), sha256: r.sha256, width: r.width, height: r.height,
  durationMs: r.duration_ms, hasThumbnail: r.has_thumbnail, createdAt: iso(r.created_at),
});

/** 店頭サイネージの置き場。 */
export interface SignageStore {
  listScreens(tenantId: string, includeRemoved?: boolean): Promise<ScreenRecord[]>;
  getScreen(tenantId: string, id: string): Promise<ScreenRecord | null>;
  findScreenByKey(tenantId: string, keyHash: string): Promise<ScreenRecord | null>;
  createScreen(tenantId: string, s: { id: string; name: string; orientation: SignageOrientation }, by: string): Promise<void>;
  /** 外した画面を登録し直す（名前と流れを引き継ぐ。第31.5.1節）。 */
  restoreScreen(tenantId: string, id: string, orientation: SignageOrientation, by: string): Promise<void>;
  updateScreen(tenantId: string, id: string, patch: { name?: string; orientation?: SignageOrientation; rotation?: SignageRotation; volume?: number }, by: string): Promise<ScreenRecord | null>;
  setScreenKey(tenantId: string, id: string, keyHash: string): Promise<void>;
  removeScreen(tenantId: string, id: string, by: string): Promise<ScreenRecord | null>;
  /** 生きている知らせを残す（つながったら、つながらない知らせの印を外す）。 */
  touchScreen(tenantId: string, id: string, report: SignageReport | null): Promise<void>;
  setOfflineNotified(tenantId: string, id: string): Promise<void>;
  /** その日の時間帯（0〜47）に知らせがあったことを残す。 */
  markPresence(tenantId: string, screenId: string, day: string, slot: number): Promise<void>;
  listPresence(tenantId: string, screenId: string, sinceDay: string): Promise<{ day: string; slots: bigint }[]>;
  /** 見回りで消す（切れた番号・14 日より前の時間帯・外して 30 日を過ぎた画面）。 */
  purge(tenantId: string, now: Date): Promise<{ pairings: number; presence: number; screens: number }>;

  createPairing(tenantId: string, p: Omit<PairingRecord, 'screenId' | 'createdAt'>): Promise<void>;
  /** 切れていない番号の数。 */
  countPairings(tenantId: string, now: Date): Promise<number>;
  /** 古い番号から消して、`keep` 個にする。 */
  trimPairings(tenantId: string, keep: number): Promise<void>;
  findPairingByCode(tenantId: string, code: string, now: Date): Promise<PairingRecord | null>;
  findPairingBySecret(tenantId: string, secretHash: string): Promise<PairingRecord | null>;
  setPairingScreen(tenantId: string, id: string, screenId: string): Promise<void>;
  deletePairing(tenantId: string, id: string): Promise<void>;

  listAssets(tenantId: string): Promise<SignageAsset[]>;
  getAsset(tenantId: string, id: string): Promise<SignageAsset | null>;
  findAssetBySha(tenantId: string, sha256: string): Promise<SignageAsset | null>;
  insertAsset(tenantId: string, a: AssetInput, by: string): Promise<void>;
  renameAsset(tenantId: string, id: string, name: string, by: string): Promise<SignageAsset | null>;
  getThumbnail(tenantId: string, id: string): Promise<Uint8Array | null>;
  setThumbnail(tenantId: string, id: string, bytes: Uint8Array): Promise<boolean>;
  /** 素材を消し、入っていた流れからも外す（流れの版を上げる）。外した画面の ID を返す。 */
  deleteAsset(tenantId: string, id: string): Promise<{ screens: string[] } | null>;
  totalBytes(tenantId: string): Promise<number>;

  listEntries(tenantId: string, screenId: string): Promise<SignageEntry[]>;
  /** 流れを並びごと置き換える。版が違えば `null`（第31.6.2節）。 */
  replaceEntries(tenantId: string, screenId: string, entries: SignageEntry[], expectedVersion: number, by: string): Promise<number | null>;
  /** 素材が入っている画面。 */
  screensUsing(tenantId: string, assetId: string): Promise<string[]>;
}

/** PostgreSQL の店頭サイネージの置き場。 */
export class PostgresSignageStore implements SignageStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async tx<T>(tenantId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
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

  private q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    return this.tx(tenantId, async (c) => (await c.query<T>(text, params as never[])).rows);
  }

  async listScreens(tenantId: string, includeRemoved = false): Promise<ScreenRecord[]> {
    const rows = await this.q<ScreenRow>(tenantId, `select ${SCREEN_COLS} from signage_screens where tenant_id = $1 ${includeRemoved ? '' : `and status = 'active'`} order by registered_at`, [tenantId]);
    return rows.map(toScreen);
  }

  async getScreen(tenantId: string, id: string): Promise<ScreenRecord | null> {
    const rows = await this.q<ScreenRow>(tenantId, `select ${SCREEN_COLS} from signage_screens where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toScreen(rows[0]) : null;
  }

  async findScreenByKey(tenantId: string, keyHash: string): Promise<ScreenRecord | null> {
    const rows = await this.q<ScreenRow>(tenantId, `select ${SCREEN_COLS} from signage_screens where tenant_id = $1 and key_hash = $2 and status = 'active'`, [tenantId, keyHash]);
    return rows[0] ? toScreen(rows[0]) : null;
  }

  async createScreen(tenantId: string, s: { id: string; name: string; orientation: SignageOrientation }, by: string): Promise<void> {
    await this.q(tenantId, `insert into signage_screens (id, tenant_id, name, orientation, registered_by, updated_by) values ($1, $2, $3, $4, $5, $5)`,
      [s.id, tenantId, s.name, s.orientation, by]);
  }

  async restoreScreen(tenantId: string, id: string, orientation: SignageOrientation, by: string): Promise<void> {
    await this.q(tenantId, `update signage_screens set status = 'active', removed_at = null, orientation = $3, registered_by = $4, registered_at = now(),
      updated_by = $4, updated_at = now(), last_seen_at = null, last_report = null, offline_notified_at = null, flow_version = flow_version + 1
      where tenant_id = $1 and id = $2`, [tenantId, id, orientation, by]);
  }

  async updateScreen(tenantId: string, id: string, patch: { name?: string; orientation?: SignageOrientation; rotation?: SignageRotation; volume?: number }, by: string): Promise<ScreenRecord | null> {
    const rows = await this.q<ScreenRow>(tenantId, `update signage_screens set name = coalesce($3, name), orientation = coalesce($4, orientation),
      rotation = coalesce($5, rotation), volume = coalesce($6, volume), updated_by = $7, updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'active' returning ${SCREEN_COLS}`,
    [tenantId, id, patch.name ?? null, patch.orientation ?? null, patch.rotation ?? null, patch.volume ?? null, by]);
    return rows[0] ? toScreen(rows[0]) : null;
  }

  async setScreenKey(tenantId: string, id: string, keyHash: string): Promise<void> {
    await this.q(tenantId, `update signage_screens set key_hash = $3 where tenant_id = $1 and id = $2`, [tenantId, id, keyHash]);
  }

  async removeScreen(tenantId: string, id: string, by: string): Promise<ScreenRecord | null> {
    const rows = await this.q<ScreenRow>(tenantId, `update signage_screens set status = 'removed', key_hash = null, removed_at = now(), updated_by = $3, updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'active' returning ${SCREEN_COLS}`, [tenantId, id, by]);
    return rows[0] ? toScreen(rows[0]) : null;
  }

  async touchScreen(tenantId: string, id: string, report: SignageReport | null): Promise<void> {
    await this.q(tenantId, `update signage_screens set last_seen_at = now(), last_report = coalesce($3::jsonb, last_report), offline_notified_at = null
      where tenant_id = $1 and id = $2`, [tenantId, id, report ? JSON.stringify(report) : null]);
  }

  async setOfflineNotified(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `update signage_screens set offline_notified_at = now() where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async markPresence(tenantId: string, screenId: string, day: string, slot: number): Promise<void> {
    await this.q(tenantId, `insert into signage_screen_presence (tenant_id, screen_id, day, slots) values ($1, $2, $3, $4)
      on conflict (screen_id, day) do update set slots = signage_screen_presence.slots | excluded.slots`,
    [tenantId, screenId, day, (1n << BigInt(slot)).toString()]);
  }

  async listPresence(tenantId: string, screenId: string, sinceDay: string): Promise<{ day: string; slots: bigint }[]> {
    const rows = await this.q<{ day: string; slots: string }>(tenantId, `select day::text, slots::text from signage_screen_presence
      where tenant_id = $1 and screen_id = $2 and day >= $3 order by day`, [tenantId, screenId, sinceDay]);
    return rows.map((r) => ({ day: r.day, slots: BigInt(r.slots) }));
  }

  async purge(tenantId: string, now: Date): Promise<{ pairings: number; presence: number; screens: number }> {
    return this.tx(tenantId, async (c) => {
      const pairings = (await c.query(`delete from signage_pairings where tenant_id = $1 and expires_at < $2 and screen_id is null`, [tenantId, now])).rowCount ?? 0;
      const presence = (await c.query(`delete from signage_screen_presence where tenant_id = $1 and day < ($2::timestamptz at time zone 'Asia/Tokyo')::date - 14`, [tenantId, now])).rowCount ?? 0;
      const screens = (await c.query(`delete from signage_screens where tenant_id = $1 and status = 'removed' and removed_at < $2::timestamptz - interval '30 days'`, [tenantId, now])).rowCount ?? 0;
      return { pairings, presence, screens };
    });
  }

  async createPairing(tenantId: string, p: Omit<PairingRecord, 'screenId' | 'createdAt'>): Promise<void> {
    await this.q(tenantId, `insert into signage_pairings (id, tenant_id, code, secret_hash, viewport, expires_at) values ($1, $2, $3, $4, $5, $6)`,
      [p.id, tenantId, p.code, p.secretHash, JSON.stringify(p.viewport), p.expiresAt]);
  }

  async countPairings(tenantId: string, now: Date): Promise<number> {
    const rows = await this.q<{ n: string }>(tenantId, `select count(*) as n from signage_pairings where tenant_id = $1 and expires_at >= $2 and screen_id is null`, [tenantId, now]);
    return Number(rows[0]?.n ?? 0);
  }

  async trimPairings(tenantId: string, keep: number): Promise<void> {
    await this.q(tenantId, `delete from signage_pairings where tenant_id = $1 and screen_id is null and id not in
      (select id from signage_pairings where tenant_id = $1 and screen_id is null order by created_at desc limit $2)`, [tenantId, keep]);
  }

  private readonly pairingCols = 'id, code, secret_hash, viewport, expires_at, screen_id, created_at';
  private toPairing = (r: { id: string; code: string; secret_hash: string; viewport: { width: number; height: number }; expires_at: unknown; screen_id: string | null; created_at: unknown }): PairingRecord => ({
    id: r.id, code: r.code, secretHash: r.secret_hash, viewport: r.viewport, expiresAt: iso(r.expires_at), screenId: r.screen_id, createdAt: iso(r.created_at),
  });

  async findPairingByCode(tenantId: string, code: string, now: Date): Promise<PairingRecord | null> {
    const rows = await this.q<Parameters<PostgresSignageStore['toPairing']>[0]>(tenantId,
      `select ${this.pairingCols} from signage_pairings where tenant_id = $1 and code = $2 and expires_at >= $3 and screen_id is null order by created_at desc limit 1`, [tenantId, code, now]);
    return rows[0] ? this.toPairing(rows[0]) : null;
  }

  async findPairingBySecret(tenantId: string, secretHash: string): Promise<PairingRecord | null> {
    const rows = await this.q<Parameters<PostgresSignageStore['toPairing']>[0]>(tenantId,
      `select ${this.pairingCols} from signage_pairings where tenant_id = $1 and secret_hash = $2`, [tenantId, secretHash]);
    return rows[0] ? this.toPairing(rows[0]) : null;
  }

  async setPairingScreen(tenantId: string, id: string, screenId: string): Promise<void> {
    await this.q(tenantId, `update signage_pairings set screen_id = $3 where tenant_id = $1 and id = $2`, [tenantId, id, screenId]);
  }

  async deletePairing(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from signage_pairings where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async listAssets(tenantId: string): Promise<SignageAsset[]> {
    return (await this.q<AssetRow>(tenantId, `select ${ASSET_COLS} from signage_assets where tenant_id = $1 order by created_at desc`, [tenantId])).map(toAsset);
  }

  async getAsset(tenantId: string, id: string): Promise<SignageAsset | null> {
    const rows = await this.q<AssetRow>(tenantId, `select ${ASSET_COLS} from signage_assets where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async findAssetBySha(tenantId: string, sha256: string): Promise<SignageAsset | null> {
    const rows = await this.q<AssetRow>(tenantId, `select ${ASSET_COLS} from signage_assets where tenant_id = $1 and sha256 = $2`, [tenantId, sha256]);
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async insertAsset(tenantId: string, a: AssetInput, by: string): Promise<void> {
    await this.q(tenantId, `insert into signage_assets (id, tenant_id, kind, name, mime, bytes, sha256, width, height, duration_ms, thumbnail, created_by, updated_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [a.id, tenantId, a.kind, a.name, a.mime, a.bytes, a.sha256, a.width, a.height, a.durationMs, a.thumbnail ? Buffer.from(a.thumbnail) : null, by]);
  }

  async renameAsset(tenantId: string, id: string, name: string, by: string): Promise<SignageAsset | null> {
    const rows = await this.q<AssetRow>(tenantId, `update signage_assets set name = $3, updated_by = $4, updated_at = now() where tenant_id = $1 and id = $2 returning ${ASSET_COLS}`,
      [tenantId, id, name, by]);
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async getThumbnail(tenantId: string, id: string): Promise<Uint8Array | null> {
    const rows = await this.q<{ thumbnail: Buffer | null }>(tenantId, `select thumbnail from signage_assets where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0]?.thumbnail ? new Uint8Array(rows[0].thumbnail) : null;
  }

  async setThumbnail(tenantId: string, id: string, bytes: Uint8Array): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, `update signage_assets set thumbnail = $3 where tenant_id = $1 and id = $2 returning id`, [tenantId, id, Buffer.from(bytes)]);
    return rows.length > 0;
  }

  async deleteAsset(tenantId: string, id: string): Promise<{ screens: string[] } | null> {
    return this.tx(tenantId, async (c) => {
      const screens = (await c.query<{ screen_id: string }>(`select distinct screen_id from signage_entries where tenant_id = $1 and asset_id = $2`, [tenantId, id])).rows.map((r) => r.screen_id);
      const gone = (await c.query(`delete from signage_assets where tenant_id = $1 and id = $2`, [tenantId, id])).rowCount ?? 0;
      if (!gone) return null;
      for (const s of screens) {
        // 外した行の後ろを詰め、流れの版を上げる（画面が読み直す）
        const rest = (await c.query<{ id: string }>(`select id from signage_entries where tenant_id = $1 and screen_id = $2 order by position`, [tenantId, s])).rows;
        for (let i = 0; i < rest.length; i++) await c.query(`update signage_entries set position = $3 where tenant_id = $1 and id = $2`, [tenantId, rest[i]!.id, i]);
        await c.query(`update signage_screens set flow_version = flow_version + 1 where tenant_id = $1 and id = $2`, [tenantId, s]);
      }
      return { screens };
    });
  }

  async totalBytes(tenantId: string): Promise<number> {
    const rows = await this.q<{ n: string | null }>(tenantId, `select coalesce(sum(bytes), 0) as n from signage_assets where tenant_id = $1`, [tenantId]);
    return Number(rows[0]?.n ?? 0);
  }

  async listEntries(tenantId: string, screenId: string): Promise<SignageEntry[]> {
    const rows = await this.q<{ asset_id: string; seconds: number | null }>(tenantId,
      `select asset_id, seconds from signage_entries where tenant_id = $1 and screen_id = $2 order by position`, [tenantId, screenId]);
    return rows.map((r) => ({ assetId: r.asset_id, seconds: r.seconds }));
  }

  async replaceEntries(tenantId: string, screenId: string, entries: SignageEntry[], expectedVersion: number, by: string): Promise<number | null> {
    return this.tx(tenantId, async (c) => {
      // 版を上げることと置き換えを同じトランザクションで行う。読んだ版と違えば、別の人が直していた
      const up = await c.query<{ flow_version: number }>(`update signage_screens set flow_version = flow_version + 1, updated_by = $4, updated_at = now()
        where tenant_id = $1 and id = $2 and status = 'active' and flow_version = $3 returning flow_version`, [tenantId, screenId, expectedVersion, by]);
      if (!up.rows[0]) return null;
      await c.query(`delete from signage_entries where tenant_id = $1 and screen_id = $2`, [tenantId, screenId]);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        await c.query(`insert into signage_entries (id, tenant_id, screen_id, asset_id, position, seconds) values (gen_random_uuid()::text, $1, $2, $3, $4, $5)`,
          [tenantId, screenId, e.assetId, i, e.seconds]);
      }
      return up.rows[0].flow_version;
    });
  }

  async screensUsing(tenantId: string, assetId: string): Promise<string[]> {
    const rows = await this.q<{ screen_id: string }>(tenantId, `select distinct screen_id from signage_entries where tenant_id = $1 and asset_id = $2`, [tenantId, assetId]);
    return rows.map((r) => r.screen_id);
  }
}
