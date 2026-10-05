/**
 * @file 店頭サイネージの置き場（仕様書 第31.15.1節）。画面・ふだん動いている時間帯・登録を待つ番号・素材・流れ。
 *
 * すべての問い合わせを会社（テナント）を設定したトランザクションで行う（不変則 I-2）。画面の鍵は SHA-256 のハッシュだけを持つ。
 */

import pg from 'pg';
import type {
  SignageAsset, SignageEntry, SignageOrientation, SignageReport, SignageRotation, SignageOrigin, SignageTargetState, SignageInterruptView,
  SignagePhrase, SignageSource, SignageSourceMapping, SignageSound,
} from '@m2office/shared';

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
export type AssetInput = Omit<SignageAsset, 'hasThumbnail' | 'createdAt' | 'isInterrupt' | 'jingle'> & { thumbnail: Uint8Array | null };

/** 置き場の中の割り込み（画面ごとの出す先の 1 行と、割り込みの中身）。 */
export interface TargetRecord {
  interruptId: string;
  screenId: string;
  state: SignageTargetState;
  seconds: number;
  startedAt: string | null;
  kind: 'text' | 'asset';
  text: string | null;
  number: string | null;
  assetId: string | null;
  chime: boolean;
  jingle: string | null;
  createdAt: string;
}

/** 割り込みを作るときの値。 */
export interface InterruptRecord {
  id: string;
  kind: 'text' | 'asset';
  text: string | null;
  number: string | null;
  assetId: string | null;
  seconds: number;
  chime: boolean;
  jingle: string | null;
  origin: SignageOrigin;
  createdBy: string | null;
  sourceId: string | null;
  requestId: string | null;
}

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
  width: number; height: number; duration_ms: number | null; has_thumbnail: boolean; is_interrupt: boolean; jingle: string | null; caption: string | null; created_at: unknown;
}
const ASSET_COLS = 'id, kind, name, mime, bytes, sha256, width, height, duration_ms, thumbnail is not null as has_thumbnail, is_interrupt, jingle, caption, created_at';
const toAsset = (r: AssetRow): SignageAsset => ({
  id: r.id, kind: r.kind, name: r.name, mime: r.mime, bytes: Number(r.bytes), sha256: r.sha256, width: r.width, height: r.height,
  durationMs: r.duration_ms, hasThumbnail: r.has_thumbnail, isInterrupt: r.is_interrupt, jingle: r.jingle, caption: r.caption ?? null, createdAt: iso(r.created_at),
});

interface TargetRow {
  interrupt_id: string; screen_id: string; state: SignageTargetState; seconds: number; started_at: unknown;
  kind: 'text' | 'asset'; text: string | null; number: string | null; asset_id: string | null; chime: boolean; jingle: string | null; created_at: unknown;
}
const TARGET_SELECT = `select t.interrupt_id, t.screen_id, t.state, t.seconds, t.started_at, i.kind, i.text, i.number, i.asset_id, i.chime, i.jingle, i.created_at
  from signage_interrupt_targets t join signage_interrupts i on i.id = t.interrupt_id`;
const toTarget = (r: TargetRow): TargetRecord => ({
  interruptId: r.interrupt_id, screenId: r.screen_id, state: r.state, seconds: r.seconds, startedAt: r.started_at ? iso(r.started_at) : null,
  kind: r.kind, text: r.text, number: r.number, assetId: r.asset_id, chime: r.chime, jingle: r.jingle, createdAt: iso(r.created_at),
});

interface SourceRow { id: string; name: string; status: 'active' | 'stopped'; mapping: SignageSourceMapping | null; last_received_at: unknown; stats: SignageSource['stats'] | Record<string, never>; created_at: unknown }
const SOURCE_COLS = 'id, name, status, mapping, last_received_at, stats, created_at';
const toSource = (r: SourceRow): SignageSource => ({
  id: r.id, name: r.name, status: r.status, mapping: r.mapping, lastReceivedAt: r.last_received_at ? iso(r.last_received_at) : null,
  stats: 'day' in r.stats ? r.stats as SignageSource['stats'] : { day: '', accepted: 0, rejected: {} }, createdAt: iso(r.created_at),
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

  /** 割り込みの素材にする・外す（音も変えられる）。 */
  setAssetInterrupt(tenantId: string, id: string, patch: { isInterrupt?: boolean; jingle?: string | null }, by: string): Promise<SignageAsset | null>;
  /** 割り込みを作り、出す先を足す（同じトランザクション）。 */
  createInterrupt(tenantId: string, i: InterruptRecord, targets: { screenId: string; seconds: number }[]): Promise<void>;
  /** 画面の、待っているか出している割り込み（受け取った順）。 */
  activeTargets(tenantId: string, screenId: string): Promise<TargetRecord[]>;
  /** 出し始めた（待ち → 出している）。 */
  startTarget(tenantId: string, interruptId: string, screenId: string): Promise<boolean>;
  /** 出し終えた（秒数が過ぎた・消された）。 */
  endTarget(tenantId: string, interruptId: string, screenId: string, state: 'done' | 'cleared', by: string | null): Promise<boolean>;
  /** 割り込みを消す（`interruptId` が無ければ、選んだ画面のすべて）。消した出す先を返す。 */
  clearTargets(tenantId: string, q: { interruptId?: string; screenIds?: string[] }, by: string): Promise<{ interruptId: string; screenId: string }[]>;
  /** 古い割り込みを片付ける（作って 2 分を過ぎた待ちは出せなかった、出し始めから秒数 ＋ 30 秒は済み）。変えた画面を返す。 */
  settleTargets(tenantId: string, now: Date): Promise<string[]>;
  /** 最近の割り込み（出す先つき）。 */
  listInterrupts(tenantId: string, since: Date): Promise<SignageInterruptView[]>;
  /** 同じ受け口の同じ `requestId` が、`since` より後にあるか。 */
  hasRequest(tenantId: string, sourceId: string, requestId: string, since: Date): Promise<boolean>;
  /** 文を消す（出し終えて 24 時間）・行を消す（90 日）。 */
  purgeInterrupts(tenantId: string, now: Date): Promise<{ texts: number; rows: number }>;
  /** 最近 14 日の、割り込みの素材ごとの回数。 */
  assetUse(tenantId: string, since: Date): Promise<Map<string, number>>;

  /** よく出す案内の回数を足す。14 日のうちに 3 回以上なら形を持つ。 */
  bumpPhrase(tenantId: string, p: { hash: string; template: string; hasNumber: boolean; day: string; since: string }): Promise<void>;
  listPhrases(tenantId: string, since: string): Promise<SignagePhrase[]>;
  hidePhrase(tenantId: string, id: string): Promise<boolean>;
  purgePhrases(tenantId: string, now: Date): Promise<number>;

  listSources(tenantId: string): Promise<SignageSource[]>;
  getSource(tenantId: string, id: string): Promise<SignageSource | null>;
  createSource(tenantId: string, s: { id: string; name: string; hookHash: string }, by: string): Promise<void>;
  setSourceStatus(tenantId: string, id: string, status: 'active' | 'stopped'): Promise<boolean>;
  setSourceMapping(tenantId: string, id: string, mapping: SignageSourceMapping | null): Promise<boolean>;
  /** 受け口の今日の数を足す（受け付けた・断った理由）。 */
  recordSource(tenantId: string, id: string, day: string, outcome: string): Promise<void>;
  /** 鍵のハッシュから受け口を引く（会社をまたいで引くため、会社を決める前に呼ぶ）。 */
  findSourceByHash(hash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null>;

  listSounds(tenantId: string): Promise<SignageSound[]>;
  getSound(tenantId: string, id: string): Promise<(SignageSound & { data: Uint8Array }) | null>;
  addSound(tenantId: string, s: { id: string; name: string; mime: SignageSound['mime']; data: Uint8Array; sha256: string; durationMs: number }, by: string): Promise<void>;
  deleteSound(tenantId: string, id: string): Promise<SignageSound | null>;
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
    await this.q(tenantId, `insert into signage_assets (id, tenant_id, kind, name, mime, bytes, sha256, width, height, duration_ms, thumbnail, created_by, updated_by, caption)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
    [a.id, tenantId, a.kind, a.name, a.mime, a.bytes, a.sha256, a.width, a.height, a.durationMs, a.thumbnail ? Buffer.from(a.thumbnail) : null, by, a.caption]);
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

  async setAssetInterrupt(tenantId: string, id: string, patch: { isInterrupt?: boolean; jingle?: string | null }, by: string): Promise<SignageAsset | null> {
    const rows = await this.q<AssetRow>(tenantId, `update signage_assets set is_interrupt = coalesce($3, is_interrupt),
      jingle = case when $4 then $5 else jingle end, updated_by = $6, updated_at = now()
      where tenant_id = $1 and id = $2 returning ${ASSET_COLS}`,
    [tenantId, id, patch.isInterrupt ?? null, patch.jingle !== undefined, patch.jingle ?? null, by]);
    return rows[0] ? toAsset(rows[0]) : null;
  }

  async createInterrupt(tenantId: string, i: InterruptRecord, targets: { screenId: string; seconds: number }[]): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query(`insert into signage_interrupts (id, tenant_id, kind, text, number, asset_id, seconds, chime, jingle, origin, created_by, source_id, request_id)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [i.id, tenantId, i.kind, i.text, i.number, i.assetId, i.seconds, i.chime, i.jingle, i.origin, i.createdBy, i.sourceId, i.requestId]);
      for (const t of targets) {
        await c.query(`insert into signage_interrupt_targets (tenant_id, interrupt_id, screen_id, seconds) values ($1, $2, $3, $4)`, [tenantId, i.id, t.screenId, t.seconds]);
      }
    });
  }

  async activeTargets(tenantId: string, screenId: string): Promise<TargetRecord[]> {
    const rows = await this.q<TargetRow>(tenantId, `${TARGET_SELECT} where t.tenant_id = $1 and t.screen_id = $2 and t.state in ('waiting', 'showing')
      order by i.created_at, i.id`, [tenantId, screenId]);
    return rows.map(toTarget);
  }

  async startTarget(tenantId: string, interruptId: string, screenId: string): Promise<boolean> {
    const rows = await this.q<{ interrupt_id: string }>(tenantId, `update signage_interrupt_targets set state = 'showing', started_at = now()
      where tenant_id = $1 and interrupt_id = $2 and screen_id = $3 and state = 'waiting' returning interrupt_id`, [tenantId, interruptId, screenId]);
    return rows.length > 0;
  }

  async endTarget(tenantId: string, interruptId: string, screenId: string, state: 'done' | 'cleared', by: string | null): Promise<boolean> {
    const rows = await this.q<{ interrupt_id: string }>(tenantId, `update signage_interrupt_targets set state = $4, ended_at = now(), cleared_by = $5
      where tenant_id = $1 and interrupt_id = $2 and screen_id = $3 and state in ('waiting', 'showing') returning interrupt_id`, [tenantId, interruptId, screenId, state, by]);
    return rows.length > 0;
  }

  async clearTargets(tenantId: string, q: { interruptId?: string; screenIds?: string[] }, by: string): Promise<{ interruptId: string; screenId: string }[]> {
    const params: unknown[] = [tenantId, by];
    let where = `tenant_id = $1 and state in ('waiting', 'showing')`;
    if (q.interruptId) { params.push(q.interruptId); where += ` and interrupt_id = $${params.length}`; }
    if (q.screenIds) { params.push(q.screenIds); where += ` and screen_id = any($${params.length})`; }
    const rows = await this.q<{ interrupt_id: string; screen_id: string }>(tenantId, `update signage_interrupt_targets set state = 'cleared', ended_at = now(), cleared_by = $2
      where ${where} returning interrupt_id, screen_id`, params);
    return rows.map((r) => ({ interruptId: r.interrupt_id, screenId: r.screen_id }));
  }

  async settleTargets(tenantId: string, now: Date): Promise<string[]> {
    return this.tx(tenantId, async (c) => {
      const expired = await c.query<{ screen_id: string }>(`update signage_interrupt_targets t set state = 'expired', ended_at = $2
        from signage_interrupts i where i.id = t.interrupt_id and t.tenant_id = $1 and t.state = 'waiting' and i.created_at < $2::timestamptz - interval '2 minutes'
        returning t.screen_id`, [tenantId, now]);
      const done = await c.query<{ screen_id: string }>(`update signage_interrupt_targets set state = 'done', ended_at = $2
        where tenant_id = $1 and state = 'showing' and started_at + make_interval(secs => seconds + 30) < $2 returning screen_id`, [tenantId, now]);
      return [...new Set([...expired.rows, ...done.rows].map((r) => r.screen_id))];
    });
  }

  async listInterrupts(tenantId: string, since: Date): Promise<SignageInterruptView[]> {
    const rows = await this.q<{ id: string; kind: 'text' | 'asset'; text: string | null; asset_id: string | null; origin: SignageOrigin; seconds: number; created_at: unknown; targets: { screenId: string; state: SignageTargetState; startedAt: string | null; endedAt: string | null }[] }>(tenantId,
      `select i.id, i.kind, i.text, i.asset_id, i.origin, i.seconds, i.created_at,
        coalesce(json_agg(json_build_object('screenId', t.screen_id, 'state', t.state, 'startedAt', t.started_at, 'endedAt', t.ended_at) order by t.screen_id)
          filter (where t.screen_id is not null), '[]') as targets
       from signage_interrupts i left join signage_interrupt_targets t on t.interrupt_id = i.id
       where i.tenant_id = $1 and i.created_at >= $2 group by i.id order by i.created_at desc limit 200`, [tenantId, since]);
    return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, assetId: r.asset_id, origin: r.origin, seconds: r.seconds, createdAt: iso(r.created_at), targets: r.targets }));
  }

  async hasRequest(tenantId: string, sourceId: string, requestId: string, since: Date): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId, `select id from signage_interrupts where tenant_id = $1 and source_id = $2 and request_id = $3 and created_at >= $4 limit 1`,
      [tenantId, sourceId, requestId, since]);
    return rows.length > 0;
  }

  async purgeInterrupts(tenantId: string, now: Date): Promise<{ texts: number; rows: number }> {
    return this.tx(tenantId, async (c) => {
      // 文と番号は、どの画面でも出し終えて（済み・消した・出せなかった）から 24 時間で消す（第31.13節）
      const texts = (await c.query(`update signage_interrupts i set text = null, number = null, text_purged_at = $2
        where i.tenant_id = $1 and i.text_purged_at is null and (i.text is not null or i.number is not null)
          and not exists (select 1 from signage_interrupt_targets t where t.interrupt_id = i.id and (t.state in ('waiting', 'showing') or t.ended_at >= $2::timestamptz - interval '24 hours'))
          and i.created_at < $2::timestamptz - interval '24 hours'`, [tenantId, now])).rowCount ?? 0;
      const rows = (await c.query(`delete from signage_interrupts where tenant_id = $1 and created_at < $2::timestamptz - interval '90 days'`, [tenantId, now])).rowCount ?? 0;
      return { texts, rows };
    });
  }

  async assetUse(tenantId: string, since: Date): Promise<Map<string, number>> {
    const rows = await this.q<{ asset_id: string; n: string }>(tenantId, `select asset_id, count(*) as n from signage_interrupts
      where tenant_id = $1 and kind = 'asset' and asset_id is not null and created_at >= $2 group by asset_id`, [tenantId, since]);
    return new Map(rows.map((r) => [r.asset_id, Number(r.n)]));
  }

  async bumpPhrase(tenantId: string, p: { hash: string; template: string; hasNumber: boolean; day: string; since: string }): Promise<void> {
    await this.tx(tenantId, async (c) => {
      const cur = await c.query<{ id: string; daily_counts: Record<string, number> }>(`select id, daily_counts from signage_phrases where tenant_id = $1 and phrase_hash = $2 for update`, [tenantId, p.hash]);
      const counts: Record<string, number> = {};
      for (const [d, n] of Object.entries(cur.rows[0]?.daily_counts ?? {})) if (d >= p.since) counts[d] = n;
      counts[p.day] = (counts[p.day] ?? 0) + 1;
      const total = Object.values(counts).reduce((a, n) => a + n, 0);
      // 14 日のうちに 3 回以上使った形だけを文として持つ（一度しか出さない名前入りの文を残さない。第31.9.3節）
      const template = total >= 3 ? p.template : null;
      if (cur.rows[0]) {
        await c.query(`update signage_phrases set daily_counts = $3, last_used_at = now(), template = coalesce($4, template) where tenant_id = $1 and id = $2`,
          [tenantId, cur.rows[0].id, JSON.stringify(counts), template]);
      } else {
        await c.query(`insert into signage_phrases (id, tenant_id, phrase_hash, template, has_number, daily_counts) values (gen_random_uuid()::text, $1, $2, $3, $4, $5)`,
          [tenantId, p.hash, template, p.hasNumber, JSON.stringify(counts)]);
      }
    });
  }

  async listPhrases(tenantId: string, since: string): Promise<SignagePhrase[]> {
    const rows = await this.q<{ id: string; template: string; has_number: boolean; daily_counts: Record<string, number> }>(tenantId,
      `select id, template, has_number, daily_counts from signage_phrases where tenant_id = $1 and template is not null and not hidden`, [tenantId]);
    return rows.map((r) => ({ id: r.id, template: r.template, hasNumber: r.has_number, count: Object.entries(r.daily_counts).filter(([d]) => d >= since).reduce((a, [, n]) => a + n, 0) }))
      .filter((p) => p.count > 0).sort((a, b) => b.count - a.count);
  }

  async hidePhrase(tenantId: string, id: string): Promise<boolean> {
    // 外した形は回数を 0 に戻す（また 3 回使うまで出さない）
    const rows = await this.q<{ id: string }>(tenantId, `update signage_phrases set hidden = false, template = null, daily_counts = '{}'::jsonb where tenant_id = $1 and id = $2 returning id`, [tenantId, id]);
    return rows.length > 0;
  }

  async purgePhrases(tenantId: string, now: Date): Promise<number> {
    return (await this.tx(tenantId, (c) => c.query(`delete from signage_phrases where tenant_id = $1 and last_used_at < $2::timestamptz - interval '90 days'`, [tenantId, now]))).rowCount ?? 0;
  }

  async listSources(tenantId: string): Promise<SignageSource[]> {
    return (await this.q<SourceRow>(tenantId, `select ${SOURCE_COLS} from signage_sources where tenant_id = $1 order by created_at`, [tenantId])).map(toSource);
  }

  async getSource(tenantId: string, id: string): Promise<SignageSource | null> {
    const rows = await this.q<SourceRow>(tenantId, `select ${SOURCE_COLS} from signage_sources where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toSource(rows[0]) : null;
  }

  async createSource(tenantId: string, s: { id: string; name: string; hookHash: string }, by: string): Promise<void> {
    await this.q(tenantId, `insert into signage_sources (id, tenant_id, name, hook_hash, created_by) values ($1, $2, $3, $4, $5)`, [s.id, tenantId, s.name, s.hookHash, by]);
  }

  async setSourceStatus(tenantId: string, id: string, status: 'active' | 'stopped'): Promise<boolean> {
    return (await this.q<{ id: string }>(tenantId, `update signage_sources set status = $3 where tenant_id = $1 and id = $2 returning id`, [tenantId, id, status])).length > 0;
  }

  async setSourceMapping(tenantId: string, id: string, mapping: SignageSourceMapping | null): Promise<boolean> {
    return (await this.q<{ id: string }>(tenantId, `update signage_sources set mapping = $3 where tenant_id = $1 and id = $2 returning id`, [tenantId, id, mapping ? JSON.stringify(mapping) : null])).length > 0;
  }

  async recordSource(tenantId: string, id: string, day: string, outcome: string): Promise<void> {
    await this.tx(tenantId, async (c) => {
      const cur = (await c.query<{ stats: SignageSource['stats'] | Record<string, never> }>(`select stats from signage_sources where tenant_id = $1 and id = $2 for update`, [tenantId, id])).rows[0];
      if (!cur) return;
      const prev = 'day' in cur.stats && cur.stats.day === day ? cur.stats as SignageSource['stats'] : { day, accepted: 0, rejected: {} };
      const next = outcome === 'accepted' ? { ...prev, accepted: prev.accepted + 1 } : { ...prev, rejected: { ...prev.rejected, [outcome]: (prev.rejected[outcome] ?? 0) + 1 } };
      await c.query(`update signage_sources set stats = $3, last_received_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, JSON.stringify(next)]);
    });
  }

  async findSourceByHash(hash: string): Promise<{ id: string; tenantId: string; status: 'active' | 'stopped' } | null> {
    const r = await this.pool.query<{ id: string; tenant_id: string; status: 'active' | 'stopped' }>('select * from m2o_signage_source($1)', [hash]);
    return r.rows[0] ? { id: r.rows[0].id, tenantId: r.rows[0].tenant_id, status: r.rows[0].status } : null;
  }

  async listSounds(tenantId: string): Promise<SignageSound[]> {
    const rows = await this.q<{ id: string; name: string; mime: SignageSound['mime']; n: number; duration_ms: number; created_at: unknown }>(tenantId,
      `select id, name, mime, octet_length(bytes) as n, duration_ms, created_at from signage_sounds where tenant_id = $1 order by created_at`, [tenantId]);
    return rows.map((r) => ({ id: r.id, name: r.name, mime: r.mime, bytes: Number(r.n), durationMs: r.duration_ms, createdAt: iso(r.created_at) }));
  }

  async getSound(tenantId: string, id: string): Promise<(SignageSound & { data: Uint8Array }) | null> {
    const rows = await this.q<{ id: string; name: string; mime: SignageSound['mime']; bytes: Buffer; duration_ms: number; created_at: unknown }>(tenantId,
      `select id, name, mime, bytes, duration_ms, created_at from signage_sounds where tenant_id = $1 and id = $2`, [tenantId, id]);
    const r = rows[0];
    return r ? { id: r.id, name: r.name, mime: r.mime, bytes: r.bytes.length, durationMs: r.duration_ms, createdAt: iso(r.created_at), data: new Uint8Array(r.bytes) } : null;
  }

  async addSound(tenantId: string, s: { id: string; name: string; mime: SignageSound['mime']; data: Uint8Array; sha256: string; durationMs: number }, by: string): Promise<void> {
    await this.q(tenantId, `insert into signage_sounds (id, tenant_id, name, mime, bytes, sha256, duration_ms, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [s.id, tenantId, s.name, s.mime, Buffer.from(s.data), s.sha256, s.durationMs, by]);
  }

  async deleteSound(tenantId: string, id: string): Promise<SignageSound | null> {
    const rows = await this.q<{ id: string; name: string; mime: SignageSound['mime']; n: number; duration_ms: number; created_at: unknown }>(tenantId,
      `delete from signage_sounds where tenant_id = $1 and id = $2 returning id, name, mime, octet_length(bytes) as n, duration_ms, created_at`, [tenantId, id]);
    const r = rows[0];
    return r ? { id: r.id, name: r.name, mime: r.mime, bytes: Number(r.n), durationMs: r.duration_ms, createdAt: iso(r.created_at) } : null;
  }
}
