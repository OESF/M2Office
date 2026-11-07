/**
 * @file 資料の目録の置き場（仕様書 第44.14節）。
 *
 * 本人の境界（第44.10節）: 目録を読む・直す関数は、すべて会社と持ち主で絞る。画面の作りに頼らない。
 * 会社をまたぐのはワーカーの読み取りの受け持ちだけで、それも会社を指定して呼ぶ（不変則 I-2）。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { LIBRARY_LIMITS, type LibraryEntry, type LibraryFacets, type LibraryFilter, type LibraryFormat, type LibraryItem, type LibraryItemDetail, type LibraryOrigin, type LibraryReadState } from '@m2office/shared';
import { createPool } from '../repository/pool.js';
import { normalizeForSearch } from '../knowledge/search.js';

/** 目録を見る人。 */
export interface LibraryViewer {
  tenantId: string;
  userId: string;
}

/** 新しい資料。 */
export interface NewLibraryItem {
  driveFileId: string | null;
  driveUrl: string | null;
  placed: boolean;
  fileId: string | null;
  originalName: string;
  format: LibraryFormat;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
  entry: LibraryEntry;
  /** 目録の題名の初め（M2Office で作った資料は成果物の題名）。 */
  title?: string;
  /** 読まないと分かっているものは、最初から読み取りの様子を決める。 */
  readState?: LibraryReadState;
  readNote?: string;
  /** 受け取った日時（メールから来たものはメールの日時）。無ければ今。 */
  receivedAt?: string;
}

/** 入口の記録。 */
export interface NewLibraryOrigin {
  entry: LibraryEntry;
  folder?: string;
  artifactId?: string;
  runId?: string;
  /** メールから来たとき（第44.4節）。Gmail の ID・送り主・件名。 */
  messageId?: string;
  sender?: string;
  subject?: string;
}

/** メールの添付の取り込みの様子（持ち主ごと。第44.14節 `library_mail_watch`）。 */
export interface LibraryMailWatchRow {
  enabled: boolean;
  checkedAt: string | null;
  backFrom: string | null;
  backUntil: string | null;
  backToken: string | null;
  backDone: boolean;
  /** 過去のメールを見た日（日本時間の `YYYY-MM-DD`）と、その日に見た通数。 */
  backDay: string | null;
  backCount: number;
  scanned: number;
  imported: number;
  error: string;
}

/** 読み取りの結果。 */
export interface LibraryReadResult {
  readState: LibraryReadState;
  readNote: string;
  readScope: string;
  title?: string;
  docType?: string;
  counterparty?: string;
  contactId?: string | null;
  docDate?: string | null;
  summary?: string;
  keywords?: string[];
  /** ドライブに置けた・読んで分かったこと。 */
  driveFileId?: string;
  driveUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number;
}

/** ワーカーが受け持つ 1 件（サーバーの中のファイルの ID を含む）。 */
export interface LibraryWork extends LibraryItem {
  fileId: string | null;
  sha256: string | null;
  attempts: number;
}

/** 人が直す項目。 */
export type LibraryPatch = Partial<Pick<LibraryItem, 'title' | 'docType' | 'counterparty' | 'docDate'>>;

/** 目録の置き場。 */
export interface LibraryStore {
  /** 入れる。同じ中身か同じドライブのファイルがあれば、作らずにそれを返す（`created: false`）。 */
  insert(who: LibraryViewer, item: NewLibraryItem): Promise<{ item: LibraryItem; created: boolean }>;
  addOrigin(who: LibraryViewer, itemId: string, origin: NewLibraryOrigin): Promise<void>;
  get(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null>;
  /** 絞り込み（新しい順）。`terms` があれば、どれかの語を含むものだけ。 */
  list(who: LibraryViewer, filter: LibraryFilter, terms: string[], limit: number, offset: number): Promise<{ items: LibraryItem[]; total: number }>;
  facets(who: LibraryViewer): Promise<LibraryFacets>;
  progress(who: LibraryViewer): Promise<{ pending: number; paused: number }>;
  byHash(who: LibraryViewer, sha256: string): Promise<LibraryItem | null>;
  byDriveFile(who: LibraryViewer, driveFileId: string): Promise<LibraryItem | null>;
  /** 渡したハッシュのうち、もう資料にあるもの（途切れた取り込みの続きのため）。 */
  existingHashes(who: LibraryViewer, hashes: string[]): Promise<string[]>;
  update(who: LibraryViewer, id: string, patch: LibraryPatch): Promise<LibraryItem | null>;
  /** 読み直しの順番に戻す（人が直した項目は残す）。 */
  requeue(who: LibraryViewer, id: string): Promise<LibraryItem | null>;
  /** 目録から消し、ハッシュを残す（第44.5節）。 */
  remove(who: LibraryViewer, id: string): Promise<LibraryItem | null>;
  isTombstoned(who: LibraryViewer, sha256: string): Promise<boolean>;
  folder(who: LibraryViewer, key: string): Promise<string | null>;
  setFolder(who: LibraryViewer, key: string, driveId: string): Promise<void>;
  /** 本人の目録を消す（連携の解除・削除の求め・退職。第44.9節）。ドライブのファイルは本人のものなので消さない。メールの取り込みも止める。 */
  purgeOwner(tenantId: string, userId: string): Promise<number>;
  /** メールの添付の取り込みの様子（第44.4節）。一度もオンにしていなければ `null`。 */
  mailWatch(who: LibraryViewer): Promise<LibraryMailWatchRow | null>;
  saveMailWatch(who: LibraryViewer, row: LibraryMailWatchRow): Promise<void>;
  /** 取り込みをオンにしている持ち主。 */
  mailWatchers(tenantId: string): Promise<string[]>;
  /** そのメールから、もう資料に入れたか（一度見たメールを読み直さない）。 */
  seenMessage(who: LibraryViewer, messageId: string): Promise<boolean>;

  /**
   * 読み取りの順番が来たものを受け持つ（新しい順。第44.11節）。受け持つ間は、ほかのワーカーに渡さない。
   *
   * @param placeOnly ドライブに置くだけのもの（読めない会社でも置きはする）に絞る
   */
  claim(tenantId: string, limit: number, leaseMs: number, placeOnly: boolean): Promise<LibraryWork[]>;
  finishRead(tenantId: string, id: string, r: LibraryReadResult): Promise<void>;
  /** 読み取りの失敗を記録し、後でやり直す。 */
  retryLater(tenantId: string, id: string, delayMs: number): Promise<void>;
  /** ドライブに置いた分だけを記録する（読み取りは続きで行う）。 */
  setPlaced(tenantId: string, id: string, driveFileId: string, driveUrl: string | null): Promise<void>;
  /** 待っているものを上限で止める（第44.11節）。 */
  pauseTenant(tenantId: string): Promise<number>;
  /** 止めていたものを待ちに戻す。 */
  resumeTenant(tenantId: string): Promise<number>;
}

/**
 * 探すときの正規化。全角と半角、大文字と小文字に加えて空白も除く（「A 社」を「A社」でも探せるように。第44.7節）。
 */
export const libraryNormal = (s: string): string => normalizeForSearch(s).replace(/\s+/g, '');

/** 検索の語を入れる文（題名・要約・語・送り主・元の名前。第44.7節）。 */
export function librarySearchText(i: { originalName: string; title: string; docType: string; counterparty: string; summary: string; keywords: string[] }, origins: { folder: string; sender: string; subject: string }[]): string {
  return [
    i.title, i.originalName, i.docType, i.counterparty, i.summary, ...i.keywords,
    ...origins.flatMap((o) => [o.folder, o.sender, o.subject]),
  ].filter(Boolean).map(libraryNormal).join('\n');
}

const COLS = `id, owner_id, drive_file_id, drive_url, placed, file_id, original_name, format, mime, size_bytes, sha256, entry, title, doc_type, counterparty, contact_id,
  doc_date::text as doc_date, received_at, summary, keywords, read_state, read_note, read_scope, edited, attempts, created_at, updated_at`;

interface Row extends pg.QueryResultRow {
  id: string; owner_id: string; drive_file_id: string | null; drive_url: string | null; placed: boolean; file_id: string | null; original_name: string; format: LibraryFormat; mime: string;
  size_bytes: string | number; sha256: string | null; entry: LibraryEntry; title: string; doc_type: string; counterparty: string; contact_id: string | null; doc_date: string | null;
  received_at: Date | string; summary: string; keywords: string[]; read_state: LibraryReadState; read_note: string; read_scope: string; edited: string[]; attempts: number; created_at: Date | string; updated_at: Date | string;
}

/** 日時を ISO の形にする（接続の設定により、文字か Date で返る）。 */
const iso = (v: Date | string) => new Date(v).toISOString();

const toItem = (r: Row): LibraryItem => ({
  id: r.id, ownerId: r.owner_id, driveFileId: r.drive_file_id, driveUrl: r.drive_url, placed: r.placed, originalName: r.original_name, format: r.format, mime: r.mime,
  sizeBytes: Number(r.size_bytes), entry: r.entry, title: r.title, docType: r.doc_type, counterparty: r.counterparty, contactId: r.contact_id, docDate: r.doc_date,
  receivedAt: iso(r.received_at), summary: r.summary, keywords: r.keywords, readState: r.read_state, readNote: r.read_note, readScope: r.read_scope, edited: r.edited,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const toWork = (r: Row): LibraryWork => ({ ...toItem(r), fileId: r.file_id, sha256: r.sha256, attempts: r.attempts });

/** LIKE の語の中の記号を逃がす。 */
const likeOf = (term: string) => `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/**
 * 目録の置き場（PostgreSQL）。
 *
 * @remarks テナント境界: 行レベルセキュリティと、すべての SQL の `tenant_id` の両方で絞る（不変則 I-2）
 */
export class PostgresLibraryStore implements LibraryStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 6, name: 'library' });
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

  async insert(who: LibraryViewer, i: NewLibraryItem): Promise<{ item: LibraryItem; created: boolean }> {
    const id = `lib-${randomUUID()}`;
    const search = librarySearchText({ originalName: i.originalName, title: i.title ?? '', docType: '', counterparty: '', summary: '', keywords: [] }, []);
    const rows = await this.q<Row>(who.tenantId,
      `insert into library_items (id, tenant_id, owner_id, drive_file_id, drive_url, placed, file_id, original_name, format, mime, size_bytes, sha256, entry, title, search_text, read_state, read_note, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, coalesce($18::timestamptz, now()))
       on conflict do nothing returning ${COLS}`,
      [id, who.tenantId, who.userId, i.driveFileId, i.driveUrl, i.placed, i.fileId, i.originalName, i.format, i.mime, i.sizeBytes, i.sha256, i.entry, i.title ?? '', search, i.readState ?? 'pending', i.readNote ?? '', i.receivedAt ?? null]);
    if (rows[0]) return { item: toItem(rows[0]), created: true };
    const same = (i.sha256 ? await this.byHash(who, i.sha256) : null) ?? (i.driveFileId ? await this.byDriveFile(who, i.driveFileId) : null);
    if (!same) throw new Error('資料を入れられませんでした');
    return { item: same, created: false };
  }

  async addOrigin(who: LibraryViewer, itemId: string, o: NewLibraryOrigin): Promise<void> {
    const folder = (o.folder ?? '').slice(0, LIBRARY_LIMITS.folderChars);
    const sender = (o.sender ?? '').slice(0, LIBRARY_LIMITS.senderChars);
    const subject = (o.subject ?? '').slice(0, LIBRARY_LIMITS.subjectChars);
    await this.q(who.tenantId,
      `insert into library_item_origins (id, tenant_id, item_id, entry, folder, artifact_id, run_id, message_id, sender, subject)
       select $1, $2, i.id, $4, $5, $6, $7, $9, $10, $11 from library_items i where i.tenant_id = $2 and i.owner_id = $8 and i.id = $3
       on conflict do nothing`,
      [`lor-${randomUUID()}`, who.tenantId, itemId, o.entry, folder, o.artifactId ?? null, o.runId ?? null, who.userId, o.messageId ?? null, sender, subject]);
    // 元のフォルダの名前・送り主・件名も探す手がかりにする（第44.7節）
    for (const hint of [folder, sender, subject].filter(Boolean).map(libraryNormal)) {
      await this.q(who.tenantId,
        `update library_items set search_text = search_text || E'\\n' || $4 where tenant_id = $1 and owner_id = $2 and id = $3 and position($4 in search_text) = 0`,
        [who.tenantId, who.userId, itemId, hint]);
    }
  }

  async get(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null> {
    const rows = await this.q<Row>(who.tenantId, `select ${COLS} from library_items where tenant_id = $1 and owner_id = $2 and id = $3`, [who.tenantId, who.userId, id]);
    if (!rows[0]) return null;
    const origins = await this.q<{ entry: LibraryEntry; folder: string; sender: string; subject: string; created_at: Date | string }>(who.tenantId,
      `select entry, folder, sender, subject, created_at from library_item_origins where tenant_id = $1 and item_id = $2 order by created_at`, [who.tenantId, id]);
    return { ...toItem(rows[0]), origins: origins.map((o): LibraryOrigin => ({ entry: o.entry, folder: o.folder, sender: o.sender, subject: o.subject, at: iso(o.created_at) })) };
  }

  async list(who: LibraryViewer, f: LibraryFilter, terms: string[], limit: number, offset: number): Promise<{ items: LibraryItem[]; total: number }> {
    const where = ['tenant_id = $1', 'owner_id = $2'];
    const params: unknown[] = [who.tenantId, who.userId];
    const add = (sql: (n: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (f.docType) add((n) => `doc_type = ${n}`, f.docType);
    if (f.counterparty) add((n) => `counterparty = ${n}`, f.counterparty);
    if (f.entry) add((n) => `entry = ${n}`, f.entry);
    if (f.year) add((n) => `extract(year from coalesce(doc_date, (received_at at time zone 'Asia/Tokyo')::date)) = ${n}`, f.year);
    if (terms.length > 0) add((n) => `search_text ilike any(${n})`, terms.map(likeOf));
    const cond = where.join(' and ');
    const count = await this.q<{ n: string }>(who.tenantId, `select count(*) as n from library_items where ${cond}`, params);
    const rows = await this.q<Row>(who.tenantId,
      `select ${COLS} from library_items where ${cond} order by coalesce(doc_date, (received_at at time zone 'Asia/Tokyo')::date) desc, received_at desc limit ${Math.floor(limit)} offset ${Math.floor(offset)}`, params);
    return { items: rows.map(toItem), total: Number(count[0]?.n ?? 0) };
  }

  async facets(who: LibraryViewer): Promise<LibraryFacets> {
    const p = [who.tenantId, who.userId];
    const [types, parties, years] = await Promise.all([
      this.q<{ v: string }>(who.tenantId, `select doc_type as v from library_items where tenant_id = $1 and owner_id = $2 and doc_type <> '' group by doc_type order by count(*) desc limit 40`, p),
      this.q<{ v: string }>(who.tenantId, `select counterparty as v from library_items where tenant_id = $1 and owner_id = $2 and counterparty <> '' group by counterparty order by count(*) desc limit 100`, p),
      this.q<{ v: number }>(who.tenantId, `select distinct extract(year from coalesce(doc_date, (received_at at time zone 'Asia/Tokyo')::date))::int as v from library_items where tenant_id = $1 and owner_id = $2 order by v desc limit 40`, p),
    ]);
    return { docTypes: types.map((r) => r.v), counterparties: parties.map((r) => r.v), years: years.map((r) => r.v) };
  }

  async progress(who: LibraryViewer): Promise<{ pending: number; paused: number }> {
    const rows = await this.q<{ read_state: string; n: string }>(who.tenantId,
      `select read_state, count(*) as n from library_items where tenant_id = $1 and owner_id = $2 and read_state in ('pending', 'paused') group by read_state`, [who.tenantId, who.userId]);
    const of = (s: string) => Number(rows.find((r) => r.read_state === s)?.n ?? 0);
    return { pending: of('pending'), paused: of('paused') };
  }

  async byHash(who: LibraryViewer, sha256: string): Promise<LibraryItem | null> {
    const rows = await this.q<Row>(who.tenantId, `select ${COLS} from library_items where tenant_id = $1 and owner_id = $2 and sha256 = $3`, [who.tenantId, who.userId, sha256]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async byDriveFile(who: LibraryViewer, driveFileId: string): Promise<LibraryItem | null> {
    const rows = await this.q<Row>(who.tenantId, `select ${COLS} from library_items where tenant_id = $1 and owner_id = $2 and drive_file_id = $3`, [who.tenantId, who.userId, driveFileId]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async existingHashes(who: LibraryViewer, hashes: string[]): Promise<string[]> {
    if (hashes.length === 0) return [];
    const rows = await this.q<{ sha256: string }>(who.tenantId, `select sha256 from library_items where tenant_id = $1 and owner_id = $2 and sha256 = any($3)`, [who.tenantId, who.userId, hashes]);
    return rows.map((r) => r.sha256);
  }

  async update(who: LibraryViewer, id: string, patch: LibraryPatch): Promise<LibraryItem | null> {
    const cur = await this.get(who, id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    const edited = [...new Set([...cur.edited, ...Object.keys(patch)])];
    const rows = await this.q<Row>(who.tenantId,
      `update library_items set title = $4, doc_type = $5, counterparty = $6, doc_date = $7::date, edited = $8, search_text = $9, updated_at = now()
       where tenant_id = $1 and owner_id = $2 and id = $3 returning ${COLS}`,
      [who.tenantId, who.userId, id, next.title, next.docType, next.counterparty, next.docDate, edited, librarySearchText(next, cur.origins)]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async requeue(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const rows = await this.q<Row>(who.tenantId,
      `update library_items set read_state = 'pending', read_note = '', read_scope = '', attempts = 0, next_try_at = now(), updated_at = now()
       where tenant_id = $1 and owner_id = $2 and id = $3 returning ${COLS}`, [who.tenantId, who.userId, id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async remove(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const rows = await this.q<Row>(who.tenantId, `delete from library_items where tenant_id = $1 and owner_id = $2 and id = $3 returning ${COLS}`, [who.tenantId, who.userId, id]);
    const row = rows[0];
    if (!row) return null;
    if (row.sha256) {
      await this.q(who.tenantId, `insert into library_tombstones (tenant_id, owner_id, sha256) values ($1, $2, $3) on conflict do nothing`, [who.tenantId, who.userId, row.sha256]);
    }
    return toItem(row);
  }

  async isTombstoned(who: LibraryViewer, sha256: string): Promise<boolean> {
    const rows = await this.q(who.tenantId, `select 1 from library_tombstones where tenant_id = $1 and owner_id = $2 and sha256 = $3`, [who.tenantId, who.userId, sha256]);
    return rows.length > 0;
  }

  async folder(who: LibraryViewer, key: string): Promise<string | null> {
    const rows = await this.q<{ drive_id: string }>(who.tenantId, `select drive_id from library_folders where tenant_id = $1 and owner_id = $2 and key = $3`, [who.tenantId, who.userId, key]);
    return rows[0]?.drive_id ?? null;
  }

  async setFolder(who: LibraryViewer, key: string, driveId: string): Promise<void> {
    await this.q(who.tenantId,
      `insert into library_folders (tenant_id, owner_id, key, drive_id) values ($1, $2, $3, $4) on conflict (tenant_id, owner_id, key) do update set drive_id = excluded.drive_id`,
      [who.tenantId, who.userId, key, driveId]);
  }

  async purgeOwner(tenantId: string, userId: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from library_items where tenant_id = $1 and owner_id = $2 returning id`, [tenantId, userId]);
    await this.q(tenantId, `delete from library_tombstones where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    await this.q(tenantId, `delete from library_folders where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    await this.q(tenantId, `delete from library_mail_watch where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    return rows.length;
  }

  async mailWatch(who: LibraryViewer): Promise<LibraryMailWatchRow | null> {
    const rows = await this.q<{
      enabled: boolean; checked_at: Date | string | null; back_from: Date | string | null; back_until: Date | string | null; back_token: string | null; back_done: boolean;
      back_day: string | null; back_count: number; scanned: number; imported: number; error: string;
    }>(who.tenantId,
      `select enabled, checked_at, back_from, back_until, back_token, back_done, back_day::text as back_day, back_count, scanned, imported, error
       from library_mail_watch where tenant_id = $1 and owner_id = $2`, [who.tenantId, who.userId]);
    const r = rows[0];
    if (!r) return null;
    const at = (v: Date | string | null) => (v === null ? null : iso(v));
    return {
      enabled: r.enabled, checkedAt: at(r.checked_at), backFrom: at(r.back_from), backUntil: at(r.back_until), backToken: r.back_token, backDone: r.back_done,
      backDay: r.back_day, backCount: r.back_count, scanned: r.scanned, imported: r.imported, error: r.error,
    };
  }

  async saveMailWatch(who: LibraryViewer, w: LibraryMailWatchRow): Promise<void> {
    await this.q(who.tenantId,
      `insert into library_mail_watch (tenant_id, owner_id, enabled, checked_at, back_from, back_until, back_token, back_done, back_day, back_count, scanned, imported, error, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, now())
       on conflict (tenant_id, owner_id) do update set enabled = excluded.enabled, checked_at = excluded.checked_at, back_from = excluded.back_from, back_until = excluded.back_until,
         back_token = excluded.back_token, back_done = excluded.back_done, back_day = excluded.back_day, back_count = excluded.back_count, scanned = excluded.scanned,
         imported = excluded.imported, error = excluded.error, updated_at = now()`,
      [who.tenantId, who.userId, w.enabled, w.checkedAt, w.backFrom, w.backUntil, w.backToken, w.backDone, w.backDay, w.backCount, w.scanned, w.imported, w.error.slice(0, 300)]);
  }

  async mailWatchers(tenantId: string): Promise<string[]> {
    const rows = await this.q<{ owner_id: string }>(tenantId, `select owner_id from library_mail_watch where tenant_id = $1 and enabled order by updated_at`, [tenantId]);
    return rows.map((r) => r.owner_id);
  }

  async seenMessage(who: LibraryViewer, messageId: string): Promise<boolean> {
    const rows = await this.q(who.tenantId,
      `select 1 from library_item_origins o join library_items i on i.tenant_id = o.tenant_id and i.id = o.item_id
       where o.tenant_id = $1 and o.message_id = $2 and i.owner_id = $3 limit 1`, [who.tenantId, messageId, who.userId]);
    return rows.length > 0;
  }

  async claim(tenantId: string, limit: number, leaseMs: number, placeOnly: boolean): Promise<LibraryWork[]> {
    const rows = await this.q<Row>(tenantId,
      `update library_items set next_try_at = now() + ($3::bigint * interval '1 millisecond')
       where id in (
         select id from library_items where tenant_id = $1 and read_state = 'pending' and next_try_at <= now() ${placeOnly ? 'and drive_file_id is null' : ''}
         order by received_at desc limit $2 for update skip locked
       ) returning ${COLS}`, [tenantId, limit, leaseMs]);
    return rows.map(toWork);
  }

  async finishRead(tenantId: string, id: string, r: LibraryReadResult): Promise<void> {
    const cur = await this.q<Row>(tenantId, `select ${COLS} from library_items where tenant_id = $1 and id = $2`, [tenantId, id]);
    const row = cur[0];
    if (!row) return;
    const item = toItem(row);
    // 人が直した項目は、AI が読み直しても書き換えない
    const keep = (k: string, ai: string | undefined, old: string) => (item.edited.includes(k) || ai === undefined ? old : ai);
    const next = {
      title: keep('title', r.title, item.title), docType: keep('docType', r.docType, item.docType), counterparty: keep('counterparty', r.counterparty, item.counterparty),
      summary: r.summary ?? item.summary, keywords: r.keywords ?? item.keywords, originalName: item.originalName,
    };
    const docDate = item.edited.includes('docDate') || r.docDate === undefined ? item.docDate : r.docDate;
    const origins = await this.q<{ folder: string; sender: string; subject: string }>(tenantId, `select folder, sender, subject from library_item_origins where tenant_id = $1 and item_id = $2`, [tenantId, id]);
    await this.q(tenantId,
      `update library_items set read_state = $3, read_note = $4, read_scope = $5, title = $6, doc_type = $7, counterparty = $8, contact_id = $9, doc_date = $10::date,
         summary = $11, keywords = $12, search_text = $13, drive_file_id = coalesce($14, drive_file_id), drive_url = coalesce($15, drive_url), sha256 = coalesce(sha256, $16), size_bytes = coalesce($17, size_bytes), attempts = 0, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, id, r.readState, r.readNote, r.readScope, next.title, next.docType, next.counterparty, r.contactId === undefined ? item.contactId : r.contactId, docDate,
        next.summary, next.keywords, librarySearchText(next, origins), r.driveFileId ?? null, r.driveUrl ?? null, r.sha256 ?? null, r.sizeBytes ?? null]);
  }

  async retryLater(tenantId: string, id: string, delayMs: number): Promise<void> {
    await this.q(tenantId, `update library_items set attempts = attempts + 1, next_try_at = now() + ($3::bigint * interval '1 millisecond') where tenant_id = $1 and id = $2`, [tenantId, id, delayMs]);
  }

  async setPlaced(tenantId: string, id: string, driveFileId: string, driveUrl: string | null): Promise<void> {
    await this.q(tenantId, `update library_items set drive_file_id = $3, drive_url = $4, placed = true, file_id = null, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, driveFileId, driveUrl]);
  }

  async pauseTenant(tenantId: string): Promise<number> {
    return (await this.q(tenantId, `update library_items set read_state = 'paused' where tenant_id = $1 and read_state = 'pending' and drive_file_id is not null returning id`, [tenantId])).length;
  }

  async resumeTenant(tenantId: string): Promise<number> {
    return (await this.q(tenantId, `update library_items set read_state = 'pending', next_try_at = now() where tenant_id = $1 and read_state = 'paused' returning id`, [tenantId])).length;
  }
}

/**
 * 目録の置き場（メモリ。テスト用）。
 */
export class MemoryLibraryStore implements LibraryStore {
  readonly rows = new Map<string, LibraryWork & { tenantId: string; nextTryAt: number; searchText: string; origins: (LibraryOrigin & { artifactId?: string; messageId?: string })[] }>();
  readonly mailWatches = new Map<string, LibraryMailWatchRow>();
  readonly tombstones = new Set<string>();
  readonly folders = new Map<string, string>();
  private mine = (who: LibraryViewer) => [...this.rows.values()].filter((r) => r.tenantId === who.tenantId && r.ownerId === who.userId);
  private view = (r: LibraryWork): LibraryItem => {
    const { fileId: _f, sha256: _s, attempts: _a, tenantId: _t, nextTryAt: _n, searchText: _x, origins: _o, ...item } = r as LibraryWork & { tenantId: string; nextTryAt: number; searchText: string; origins: unknown };
    return item;
  };

  async insert(who: LibraryViewer, i: NewLibraryItem): Promise<{ item: LibraryItem; created: boolean }> {
    const same = this.mine(who).find((r) => (i.sha256 && r.sha256 === i.sha256) || (i.driveFileId && r.driveFileId === i.driveFileId));
    if (same) return { item: this.view(same), created: false };
    const now = new Date().toISOString();
    const row = {
      id: `lib-${randomUUID()}`, tenantId: who.tenantId, ownerId: who.userId, driveFileId: i.driveFileId, driveUrl: i.driveUrl, placed: i.placed, fileId: i.fileId, originalName: i.originalName,
      format: i.format, mime: i.mime, sizeBytes: i.sizeBytes, sha256: i.sha256, entry: i.entry, title: i.title ?? '', docType: '', counterparty: '', contactId: null, docDate: null, receivedAt: i.receivedAt ?? now,
      summary: '', keywords: [], readState: i.readState ?? 'pending' as LibraryReadState, readNote: i.readNote ?? '', readScope: '', edited: [], attempts: 0, createdAt: now, updatedAt: now,
      nextTryAt: 0, searchText: '', origins: [],
    };
    row.searchText = librarySearchText(row, []);
    this.rows.set(row.id, row);
    return { item: this.view(row), created: true };
  }

  async addOrigin(who: LibraryViewer, itemId: string, o: NewLibraryOrigin): Promise<void> {
    const r = this.rows.get(itemId);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return;
    if (o.artifactId && r.origins.some((x) => x.artifactId === o.artifactId)) return;
    if (o.messageId && r.origins.some((x) => x.messageId === o.messageId)) return;
    r.origins.push({
      entry: o.entry, folder: o.folder ?? '', sender: o.sender ?? '', subject: o.subject ?? '', at: new Date().toISOString(),
      ...(o.artifactId ? { artifactId: o.artifactId } : {}), ...(o.messageId ? { messageId: o.messageId } : {}),
    });
    for (const hint of [o.folder, o.sender, o.subject].filter((x): x is string => !!x)) r.searchText += `\n${libraryNormal(hint)}`;
  }

  async get(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    return { ...this.view(r), origins: r.origins.map(({ artifactId: _a, messageId: _m, ...o }) => o) };
  }

  async list(who: LibraryViewer, f: LibraryFilter, terms: string[], limit: number, offset: number): Promise<{ items: LibraryItem[]; total: number }> {
    const hits = this.mine(who).filter((r) =>
      (!f.docType || r.docType === f.docType) && (!f.counterparty || r.counterparty === f.counterparty) && (!f.entry || r.entry === f.entry)
      && (!f.year || Number((r.docDate ?? r.receivedAt).slice(0, 4)) === f.year)
      && (terms.length === 0 || terms.some((t) => r.searchText.includes(t))));
    hits.sort((a, b) => (b.docDate ?? b.receivedAt.slice(0, 10)).localeCompare(a.docDate ?? a.receivedAt.slice(0, 10)) || b.receivedAt.localeCompare(a.receivedAt));
    return { items: hits.slice(offset, offset + limit).map(this.view), total: hits.length };
  }

  async facets(who: LibraryViewer): Promise<LibraryFacets> {
    const rows = this.mine(who);
    return {
      docTypes: [...new Set(rows.map((r) => r.docType).filter(Boolean))],
      counterparties: [...new Set(rows.map((r) => r.counterparty).filter(Boolean))],
      years: [...new Set(rows.map((r) => Number((r.docDate ?? r.receivedAt).slice(0, 4))))].sort((a, b) => b - a),
    };
  }

  async progress(who: LibraryViewer): Promise<{ pending: number; paused: number }> {
    const rows = this.mine(who);
    return { pending: rows.filter((r) => r.readState === 'pending').length, paused: rows.filter((r) => r.readState === 'paused').length };
  }

  async byHash(who: LibraryViewer, sha256: string): Promise<LibraryItem | null> {
    const r = this.mine(who).find((x) => x.sha256 === sha256);
    return r ? this.view(r) : null;
  }

  async byDriveFile(who: LibraryViewer, driveFileId: string): Promise<LibraryItem | null> {
    const r = this.mine(who).find((x) => x.driveFileId === driveFileId);
    return r ? this.view(r) : null;
  }

  async existingHashes(who: LibraryViewer, hashes: string[]): Promise<string[]> {
    return this.mine(who).map((r) => r.sha256).filter((h): h is string => !!h && hashes.includes(h));
  }

  async update(who: LibraryViewer, id: string, patch: LibraryPatch): Promise<LibraryItem | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    Object.assign(r, patch, { edited: [...new Set([...r.edited, ...Object.keys(patch)])] });
    r.searchText = librarySearchText(r, r.origins);
    return this.view(r);
  }

  async requeue(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    Object.assign(r, { readState: 'pending', readNote: '', readScope: '', attempts: 0, nextTryAt: 0 });
    return this.view(r);
  }

  async remove(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    this.rows.delete(id);
    if (r.sha256) this.tombstones.add(`${who.tenantId}:${who.userId}:${r.sha256}`);
    return this.view(r);
  }

  async isTombstoned(who: LibraryViewer, sha256: string): Promise<boolean> {
    return this.tombstones.has(`${who.tenantId}:${who.userId}:${sha256}`);
  }

  async folder(who: LibraryViewer, key: string): Promise<string | null> {
    return this.folders.get(`${who.tenantId}:${who.userId}:${key}`) ?? null;
  }

  async setFolder(who: LibraryViewer, key: string, driveId: string): Promise<void> {
    this.folders.set(`${who.tenantId}:${who.userId}:${key}`, driveId);
  }

  async purgeOwner(tenantId: string, userId: string): Promise<number> {
    const rows = this.mine({ tenantId, userId });
    for (const r of rows) this.rows.delete(r.id);
    this.mailWatches.delete(`${tenantId}:${userId}`);
    return rows.length;
  }

  async mailWatch(who: LibraryViewer): Promise<LibraryMailWatchRow | null> {
    const w = this.mailWatches.get(`${who.tenantId}:${who.userId}`);
    return w ? { ...w } : null;
  }

  async saveMailWatch(who: LibraryViewer, row: LibraryMailWatchRow): Promise<void> {
    this.mailWatches.set(`${who.tenantId}:${who.userId}`, { ...row });
  }

  async mailWatchers(tenantId: string): Promise<string[]> {
    return [...this.mailWatches.entries()].filter(([k, w]) => k.startsWith(`${tenantId}:`) && w.enabled).map(([k]) => k.slice(tenantId.length + 1));
  }

  async seenMessage(who: LibraryViewer, messageId: string): Promise<boolean> {
    return this.mine(who).some((r) => r.origins.some((o) => o.messageId === messageId));
  }

  async claim(tenantId: string, limit: number, leaseMs: number, placeOnly: boolean): Promise<LibraryWork[]> {
    const now = Date.now();
    const rows = [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.readState === 'pending' && r.nextTryAt <= now && (!placeOnly || !r.driveFileId))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    for (const r of rows) r.nextTryAt = now + leaseMs;
    return rows.map((r) => ({ ...this.view(r), fileId: r.fileId, sha256: r.sha256, attempts: r.attempts }));
  }

  async finishRead(tenantId: string, id: string, x: LibraryReadResult): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    const keep = (k: string, ai: string | undefined, old: string) => (r.edited.includes(k) || ai === undefined ? old : ai);
    r.title = keep('title', x.title, r.title);
    r.docType = keep('docType', x.docType, r.docType);
    r.counterparty = keep('counterparty', x.counterparty, r.counterparty);
    if (!r.edited.includes('docDate') && x.docDate !== undefined) r.docDate = x.docDate;
    if (x.contactId !== undefined) r.contactId = x.contactId;
    r.summary = x.summary ?? r.summary;
    r.keywords = x.keywords ?? r.keywords;
    r.readState = x.readState; r.readNote = x.readNote; r.readScope = x.readScope; r.attempts = 0;
    if (x.driveUrl) r.driveUrl = x.driveUrl;
    if (x.sha256 && !r.sha256) r.sha256 = x.sha256;
    if (x.sizeBytes !== undefined) r.sizeBytes = x.sizeBytes;
    r.searchText = librarySearchText(r, r.origins);
  }

  async retryLater(tenantId: string, id: string, delayMs: number): Promise<void> {
    const r = this.rows.get(id);
    if (r && r.tenantId === tenantId) { r.attempts += 1; r.nextTryAt = Date.now() + delayMs; }
  }

  async setPlaced(tenantId: string, id: string, driveFileId: string, driveUrl: string | null): Promise<void> {
    const r = this.rows.get(id);
    if (r && r.tenantId === tenantId) Object.assign(r, { driveFileId, driveUrl, placed: true, fileId: null });
  }

  async pauseTenant(tenantId: string): Promise<number> {
    const rows = [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.readState === 'pending' && r.driveFileId);
    for (const r of rows) r.readState = 'paused';
    return rows.length;
  }

  async resumeTenant(tenantId: string): Promise<number> {
    const rows = [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.readState === 'paused');
    for (const r of rows) { r.readState = 'pending'; r.nextTryAt = 0; }
    return rows.length;
  }
}
