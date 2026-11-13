/**
 * @file 資料の目録の置き場（仕様書 第44.14節）。
 *
 * 本人の境界（第44.10節）: 目録を読む・直す関数は、すべて会社と持ち主で絞る。画面の作りに頼らない。
 * 会社をまたぐのはワーカーの読み取りの受け持ちだけで、それも会社を指定して呼ぶ（不変則 I-2）。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { LIBRARY_LIMITS, type LibraryEntry, type LibraryFacets, type LibraryFilter, type LibraryFormat, type LibraryItem, type LibraryItemDetail, type LibraryOrigin, type LibraryReadState, type LibraryShareScope } from '@m2office/shared';
import { createPool } from '../repository/pool.js';
import { normalizeForSearch } from '../knowledge/search.js';
import type { LibraryLinkInput } from './links.js';

/** 目録を見る人。 */
export interface LibraryViewer {
  tenantId: string;
  userId: string;
  /**
   * 見る人のグループ。渡したときだけ、一覧・選択肢・{@link LibraryStore.view} に共有された資料を含める（第44.8節）。
   * 直す・削除・共有などの持ち主の操作には渡さない（本人の資料だけに絞る）。
   */
  groups?: string[];
}

/** 共有の相手の 1 行（第44.14節 `library_shares`）。 */
export interface LibraryShareRow {
  scope: 'group' | 'company';
  groupId: string | null;
  /** M2Office が足したドライブの権限（外すときに使う）。 */
  emails: string[];
  domain: string | null;
}

/** 持ち主ごとの様子（第44.14節 `library_owner_state`）。 */
export interface LibraryOwnerStateRow {
  /** 第 0.532.0 版から読まない（目録は常に書き出す。第44.16節）。 */
  okfEnabled: boolean;
  okfWrittenAt: string | null;
  /** 最後に書き出したときの目録の変わり目（{@link LibraryStore.ownerStamp}）。 */
  okfStamp: string;
  okfError: string;
  /** もう知らせた版の組（題名・取引先・種類の鍵）。 */
  versionsNotified: string[];
  versionsNoticedAt: string | null;
  /** 本人が開いた時刻を最後にドライブから読んだ時刻（第44.16.1節）。 */
  viewsCheckedAt: string | null;
}

/** OKF で書き出したファイル（第44.14節 `library_okf_files`）。 */
export interface LibraryOkfFileRow {
  key: string;
  driveId: string;
  digest: string;
}

/** 版の組の鍵（題名・取引先・種類が同じものを同じ資料の版とみなす。第44.8節）。題名が無ければ `null`。 */
export const libraryVersionKey = (i: Pick<LibraryItem, 'title' | 'counterparty' | 'docType'>): string | null =>
  i.title.trim() ? [i.title, i.counterparty, i.docType].map(libraryNormal).join('|') : null;

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

/** 見たやり取り（スレッド）と決めたこと（第44.18節 `library_mail_threads`）。 */
export interface LibraryThreadRow {
  threadId: string;
  /** 資料にした・載せない・AI の答えを読めなかった。 */
  decision: 'kept' | 'skipped' | 'failed';
  /** 載せない理由（決まりの名前か `ai`・`tombstone`）。中身は持たない。 */
  reason: string;
  itemId: string | null;
  /** 最後に読んだメールの ID（変わったときだけ読み直す）。 */
  lastMessageId: string;
  messageCount: number;
  firstAt: string | null;
  lastAt: string | null;
  people: string[];
  checkedAt: string;
}

/** やり取りの取り込みの進み具合（持ち主ごと。第44.18.3節 `library_thread_watch`）。 */
export interface LibraryThreadWatchRow {
  checkedAt: string | null;
  backFrom: string | null;
  backUntil: string | null;
  backToken: string | null;
  backDone: boolean;
  /** 過去の分の件数が多く、本人が費用の目安を確かめるのを待っている。 */
  backWaiting: boolean;
  backDay: string | null;
  backCount: number;
  scanned: number;
  kept: number;
  /** 前から添付を集めていた人に、やり取りも集め始めたことを知らせたか（Q-359）。 */
  noticed: boolean;
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
  /** タグ（第44.17.3節）。渡したら、付け終えた印も付ける。 */
  tags?: string[];
  /** ドライブに置けた・読んで分かったこと。 */
  driveFileId?: string;
  driveUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number;
  /** 受け取った日時を変える（やり取りに新しいメールが届いたとき。第44.18.2節）。 */
  receivedAt?: string;
}

/** ワーカーが受け持つ 1 件（サーバーの中のファイルの ID を含む）。 */
export interface LibraryWork extends LibraryItem {
  fileId: string | null;
  sha256: string | null;
  attempts: number;
}

/** 人が直す項目。 */
export type LibraryPatch = Partial<Pick<LibraryItem, 'title' | 'docType' | 'counterparty' | 'docDate' | 'tags'>>;

/** `library_mail_threads` の列。 */
const THREAD_COLS = 'thread_id, decision, reason, item_id, last_message_id, message_count, first_at, last_at, people, checked_at';
type ThreadDbRow = {
  thread_id: string; decision: LibraryThreadRow['decision']; reason: string; item_id: string | null; last_message_id: string; message_count: number;
  first_at: Date | string | null; last_at: Date | string | null; people: unknown; checked_at: Date | string;
};
const toThread = (r: ThreadDbRow): LibraryThreadRow => ({
  threadId: r.thread_id, decision: r.decision, reason: r.reason, itemId: r.item_id, lastMessageId: r.last_message_id, messageCount: r.message_count,
  firstAt: r.first_at === null ? null : new Date(r.first_at).toISOString(), lastAt: r.last_at === null ? null : new Date(r.last_at).toISOString(),
  people: Array.isArray(r.people) ? (r.people as unknown[]).filter((x): x is string => typeof x === 'string') : [], checkedAt: new Date(r.checked_at).toISOString(),
});

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
  /** 見る人に見える 1 件（本人の資料と、本人に共有された資料。`who.groups` を渡す）。 */
  view(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null>;
  /** 共有の相手（持ち主だけ）。 */
  shares(who: LibraryViewer, itemId: string): Promise<LibraryShareRow[]>;
  /** 共有の範囲と相手を置き換える（持ち主だけ。`self` なら相手を消す）。 */
  setShares(who: LibraryViewer, itemId: string, scope: 'self' | 'group' | 'company', rows: LibraryShareRow[]): Promise<LibraryItem | null>;
  /** 会社の知識にした記録を残す（持ち主だけ）。 */
  setKnowledge(who: LibraryViewer, itemId: string, knowledgeId: string, at: string): Promise<void>;
  /** 本人の資料のうち、版の鍵が同じもの（新しい順）。 */
  versionsOf(who: LibraryViewer, item: LibraryItem): Promise<LibraryItem[]>;
  /** 本人の資料のすべて（OKF の書き出しと版の知らせ。新しい順）。 */
  allOf(tenantId: string, ownerId: string): Promise<LibraryItem[]>;
  /** 本人の資料と、入口の記録のメールの ID・元のフォルダ（つながりの材料。第44.17.1節）。新しい順。 */
  linkInputs(tenantId: string, ownerId: string): Promise<LibraryLinkInput[]>;
  /** 本人の目録の変わり目（件数・最後に変わった時刻・入口の記録の数）。変わっていなければ同じ文字を返す（目録の書き出し。第44.16節）。 */
  ownerStamp(tenantId: string, ownerId: string): Promise<string>;
  /** 資料を持っている人。 */
  owners(tenantId: string): Promise<string[]>;
  ownerState(tenantId: string, ownerId: string): Promise<LibraryOwnerStateRow | null>;
  saveOwnerState(tenantId: string, ownerId: string, row: LibraryOwnerStateRow): Promise<void>;
  okfFiles(tenantId: string, ownerId: string): Promise<LibraryOkfFileRow[]>;
  saveOkfFile(tenantId: string, ownerId: string, row: LibraryOkfFileRow): Promise<void>;
  deleteOkfFile(tenantId: string, ownerId: string, key: string): Promise<void>;
  /** メールの添付の取り込みの様子（第44.4節）。一度もオンにしていなければ `null`。 */
  mailWatch(who: LibraryViewer): Promise<LibraryMailWatchRow | null>;
  saveMailWatch(who: LibraryViewer, row: LibraryMailWatchRow): Promise<void>;
  /** 取り込みをオンにしている持ち主。 */
  mailWatchers(tenantId: string): Promise<string[]>;
  /** そのメールの添付を、もう資料に入れたか（一度見たメールを読み直さない）。やり取りの資料（形式 `mail`）の入口の記録は数えない。 */
  seenMessage(who: LibraryViewer, messageId: string): Promise<boolean>;
  /** 見たやり取り（第44.18節）。見ていなければ `null`。 */
  mailThread(who: LibraryViewer, threadId: string): Promise<LibraryThreadRow | null>;
  saveMailThread(who: LibraryViewer, row: LibraryThreadRow): Promise<void>;
  /** やり取りの資料のスレッドの様子（1 件の画面）。 */
  threadOfItem(who: LibraryViewer, itemId: string): Promise<LibraryThreadRow | null>;
  /** やり取りの取り込みの進み具合。一度も始めていなければ `null`。 */
  threadWatch(who: LibraryViewer): Promise<LibraryThreadWatchRow | null>;
  saveThreadWatch(who: LibraryViewer, row: LibraryThreadWatchRow): Promise<void>;

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
  /**
   * まだタグを付けていない資料（読み取りを待っているものを除く。第44.17.3節）。1 人の分だけを新しい順に返す（その人の名前に合わせて付けるため）。
   */
  untagged(tenantId: string, limit: number): Promise<LibraryItem[]>;
  /** タグを付け、付け終えた印を付ける。`null` なら印だけを付ける（付けられなかった）。人が直したタグは書き換えない。 */
  setTags(tenantId: string, id: string, tags: string[] | null): Promise<void>;
  /** 本人がもう使っているタグ（多い順に 100。名前のゆれをそろえる。第44.17.3節）。 */
  tagNames(tenantId: string, ownerId: string): Promise<string[]>;
  /**
   * 本人が実際の資料を開いた時刻を記録する（確かめた記録。第44.16.1節）。前より新しい時刻だけを入れる。
   *
   * @param views ドライブのファイルの ID と開いた時刻（本人の資料のドライブのファイルだけに当てる）
   * @returns 記録した資料の数
   */
  setViewed(tenantId: string, ownerId: string, views: { driveFileId: string; at: string }[]): Promise<number>;
  /** 待っているものを上限で止める（第44.11節）。 */
  pauseTenant(tenantId: string): Promise<number>;
  /** 止めていたものを待ちに戻す。 */
  resumeTenant(tenantId: string): Promise<number>;
}

/**
 * 探すときの正規化。全角と半角、大文字と小文字に加えて空白も除く（「A 社」を「A社」でも探せるように。第44.7節）。
 */
export const libraryNormal = (s: string): string => normalizeForSearch(s).replace(/\s+/g, '');

/** 会社の形を表す語（タグの見分けでは無視する。「サンプル商事株式会社」と「サンプル商事」を同じタグにする）。 */
const CORPORATE_FORM = /株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|\(株\)|\(有\)|㈱|㈲/g;

/**
 * タグの見分けの鍵（第44.17.3節）。正規化（{@link libraryNormal}）に加えて、会社の形を表す語を除く。
 *
 * @remarks 鍵が同じタグは同じタグとして扱う（書き方をそろえる・つながり・グラフの点・一覧）。会社の形の語だけのタグは、そのまま鍵にする
 */
export const libraryTagKey = (s: string): string => {
  const n = libraryNormal(s);
  return n.replace(CORPORATE_FORM, '') || n;
};

/** 多く付いたタグから並べる（同じ数なら名前の順）。 */
export function libraryTopTags(list: string[], limit: number): string[] {
  const n = new Map<string, number>();
  for (const v of list) if (v) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([v]) => v);
}

/** 検索の語を入れる文（題名・要約・語・タグ・送り主・元の名前。第44.7節）。 */
export function librarySearchText(
  i: { originalName: string; title: string; docType: string; counterparty: string; summary: string; keywords: string[]; tags?: string[] },
  origins: { folder: string; sender: string; subject: string }[],
): string {
  return [
    i.title, i.originalName, i.docType, i.counterparty, i.summary, ...i.keywords, ...(i.tags ?? []),
    ...origins.flatMap((o) => [o.folder, o.sender, o.subject]),
  ].filter(Boolean).map(libraryNormal).join('\n');
}

const COLS = `id, owner_id, drive_file_id, drive_url, placed, file_id, original_name, format, mime, size_bytes, sha256, entry, title, doc_type, counterparty, contact_id, tags,
  doc_date::text as doc_date, received_at, summary, keywords, read_state, read_note, read_scope, edited, attempts, share_scope, knowledge_id, verified_at, viewed_at, created_at, updated_at`;

interface Row extends pg.QueryResultRow {
  id: string; owner_id: string; drive_file_id: string | null; drive_url: string | null; placed: boolean; file_id: string | null; original_name: string; format: LibraryFormat; mime: string;
  size_bytes: string | number; sha256: string | null; entry: LibraryEntry; title: string; doc_type: string; counterparty: string; contact_id: string | null; tags: string[]; doc_date: string | null;
  received_at: Date | string; summary: string; keywords: string[]; read_state: LibraryReadState; read_note: string; read_scope: string; edited: string[]; attempts: number;
  share_scope: LibraryShareScope; knowledge_id: string | null; verified_at: Date | string | null; viewed_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
}

/** 日時を ISO の形にする（接続の設定により、文字か Date で返る）。 */
const iso = (v: Date | string) => new Date(v).toISOString();

const toItem = (r: Row): LibraryItem => ({
  id: r.id, ownerId: r.owner_id, driveFileId: r.drive_file_id, driveUrl: r.drive_url, placed: r.placed, originalName: r.original_name, format: r.format, mime: r.mime,
  sizeBytes: Number(r.size_bytes), entry: r.entry, title: r.title, docType: r.doc_type, counterparty: r.counterparty, contactId: r.contact_id,
  tags: r.tags ?? [], docDate: r.doc_date,
  receivedAt: iso(r.received_at), summary: r.summary, keywords: r.keywords, readState: r.read_state, readNote: r.read_note, readScope: r.read_scope, edited: r.edited,
  shareScope: r.share_scope, knowledgeId: r.knowledge_id, verifiedAt: r.verified_at === null ? null : iso(r.verified_at), viewedAt: r.viewed_at === null ? null : iso(r.viewed_at),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

/** 見る人に見える資料の条件（`$1` は会社、`$2` は本人、`g` はグループの引数の番号）。グループを渡さなければ本人の資料だけ。 */
const visibleSql = (who: LibraryViewer, g: number) => (who.groups
  ? `(owner_id = $2 or share_scope = 'company' or (share_scope = 'group' and exists (select 1 from library_shares s where s.tenant_id = library_items.tenant_id and s.item_id = library_items.id and s.group_id = any($${g}))))`
  : 'owner_id = $2');
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

  async view(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null> {
    const rows = await this.q<Row>(who.tenantId, `select ${COLS} from library_items where tenant_id = $1 and ${visibleSql({ ...who, groups: who.groups ?? [] }, 4)} and id = $3`, [who.tenantId, who.userId, id, who.groups ?? []]);
    return rows[0] ? this.withOrigins(who.tenantId, rows[0]) : null;
  }

  private async withOrigins(tenantId: string, row: Row): Promise<LibraryItemDetail> {
    const id = row.id;
    const origins = await this.q<{ entry: LibraryEntry; folder: string; sender: string; subject: string; created_at: Date | string }>(tenantId,
      `select entry, folder, sender, subject, created_at from library_item_origins where tenant_id = $1 and item_id = $2 order by created_at`, [tenantId, id]);
    return { ...toItem(row), origins: origins.map((o): LibraryOrigin => ({ entry: o.entry, folder: o.folder, sender: o.sender, subject: o.subject, at: iso(o.created_at) })) };
  }

  async get(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null> {
    const rows = await this.q<Row>(who.tenantId, `select ${COLS} from library_items where tenant_id = $1 and owner_id = $2 and id = $3`, [who.tenantId, who.userId, id]);
    if (!rows[0]) return null;
    const origins = await this.q<{ entry: LibraryEntry; folder: string; sender: string; subject: string; created_at: Date | string }>(who.tenantId,
      `select entry, folder, sender, subject, created_at from library_item_origins where tenant_id = $1 and item_id = $2 order by created_at`, [who.tenantId, id]);
    return { ...toItem(rows[0]), origins: origins.map((o): LibraryOrigin => ({ entry: o.entry, folder: o.folder, sender: o.sender, subject: o.subject, at: iso(o.created_at) })) };
  }

  async list(who: LibraryViewer, f: LibraryFilter, terms: string[], limit: number, offset: number): Promise<{ items: LibraryItem[]; total: number }> {
    const where = ['tenant_id = $1'];
    const params: unknown[] = [who.tenantId, who.userId];
    const add = (sql: (n: string) => string, v: unknown) => { params.push(v); where.push(sql(`$${params.length}`)); };
    if (who.groups) { params.push(who.groups); where.push(visibleSql(who, params.length)); } else where.push('owner_id = $2');
    if (f.docType) add((n) => `doc_type = ${n}`, f.docType);
    if (f.counterparty) add((n) => `counterparty = ${n}`, f.counterparty);
    if (f.tags?.length) add((n) => `tags @> ${n}::text[]`, f.tags);
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
    const p = [who.tenantId, who.userId, who.groups ?? []];
    const mine = visibleSql(who, 3);
    const [tags, years] = await Promise.all([
      this.q<{ v: string }>(who.tenantId, `select v from library_items, unnest(tags) as v where tenant_id = $1 and ${mine} and v <> '' and $3::text[] is not null group by v order by count(*) desc, v limit 300`, p),
      this.q<{ v: number }>(who.tenantId, `select distinct extract(year from coalesce(doc_date, (received_at at time zone 'Asia/Tokyo')::date))::int as v from library_items where tenant_id = $1 and ${mine} and $3::text[] is not null order by v desc limit 40`, p),
    ]);
    return { tags: tags.map((r) => r.v), years: years.map((r) => r.v) };
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
      `update library_items set title = $4, doc_type = $5, counterparty = $6, doc_date = $7::date, edited = $8, search_text = $9, tags = $10, updated_at = now()
       where tenant_id = $1 and owner_id = $2 and id = $3 returning ${COLS}`,
      [who.tenantId, who.userId, id, next.title, next.docType, next.counterparty, next.docDate, edited, librarySearchText(next, cur.origins), next.tags]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async requeue(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const rows = await this.q<Row>(who.tenantId,
      `update library_items set read_state = 'pending', read_note = '', read_scope = '', attempts = 0, tagged = false, next_try_at = now(), updated_at = now()
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
    await this.q(tenantId, `delete from library_mail_threads where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    await this.q(tenantId, `delete from library_thread_watch where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    await this.q(tenantId, `delete from library_owner_state where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    await this.q(tenantId, `delete from library_okf_files where tenant_id = $1 and owner_id = $2`, [tenantId, userId]);
    return rows.length;
  }

  async shares(who: LibraryViewer, itemId: string): Promise<LibraryShareRow[]> {
    const rows = await this.q<{ scope: 'group' | 'company'; group_id: string | null; emails: string[]; domain: string | null }>(who.tenantId,
      `select s.scope, s.group_id, s.emails, s.domain from library_shares s join library_items i on i.tenant_id = s.tenant_id and i.id = s.item_id
       where s.tenant_id = $1 and s.item_id = $2 and i.owner_id = $3 order by s.created_at`, [who.tenantId, itemId, who.userId]);
    return rows.map((r) => ({ scope: r.scope, groupId: r.group_id, emails: r.emails, domain: r.domain }));
  }

  async setShares(who: LibraryViewer, itemId: string, scope: 'self' | 'group' | 'company', rows: LibraryShareRow[]): Promise<LibraryItem | null> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [who.tenantId]);
      const upd = await c.query<Row>(`update library_items set share_scope = $4, updated_at = now() where tenant_id = $1 and owner_id = $2 and id = $3 returning ${COLS}`,
        [who.tenantId, who.userId, itemId, scope]);
      if (!upd.rows[0]) { await c.query('rollback'); return null; }
      await c.query('delete from library_shares where tenant_id = $1 and item_id = $2', [who.tenantId, itemId]);
      for (const r of rows) {
        await c.query(`insert into library_shares (id, tenant_id, item_id, scope, group_id, emails, domain, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [`lsh-${randomUUID()}`, who.tenantId, itemId, r.scope, r.groupId, r.emails, r.domain, who.userId]);
      }
      await c.query('commit');
      return toItem(upd.rows[0]);
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async setKnowledge(who: LibraryViewer, itemId: string, knowledgeId: string, at: string): Promise<void> {
    await this.q(who.tenantId, `update library_items set knowledge_id = $4, verified_at = $5, updated_at = now() where tenant_id = $1 and owner_id = $2 and id = $3`,
      [who.tenantId, who.userId, itemId, knowledgeId, at]);
  }

  async versionsOf(who: LibraryViewer, item: LibraryItem): Promise<LibraryItem[]> {
    if (!libraryVersionKey(item)) return [];
    const rows = await this.q<Row>(who.tenantId,
      `select ${COLS} from library_items where tenant_id = $1 and owner_id = $2 and id <> $3 and title = $4 and counterparty = $5 and doc_type = $6
       order by coalesce(doc_date, (received_at at time zone 'Asia/Tokyo')::date) desc, received_at desc limit 20`,
      [who.tenantId, who.userId, item.id, item.title, item.counterparty, item.docType]);
    return rows.map(toItem);
  }

  async allOf(tenantId: string, ownerId: string): Promise<LibraryItem[]> {
    const rows = await this.q<Row>(tenantId, `select ${COLS} from library_items where tenant_id = $1 and owner_id = $2 order by received_at desc limit 20000`, [tenantId, ownerId]);
    return rows.map(toItem);
  }

  async linkInputs(tenantId: string, ownerId: string): Promise<LibraryLinkInput[]> {
    const items = await this.allOf(tenantId, ownerId);
    const rows = await this.q<{ item_id: string; messages: string[] | null; folders: string[] | null }>(tenantId,
      `select o.item_id, array_agg(distinct o.message_id) filter (where o.message_id is not null) as messages, array_agg(distinct o.folder) filter (where o.folder <> '') as folders
       from library_item_origins o join library_items i on i.tenant_id = o.tenant_id and i.id = o.item_id
       where o.tenant_id = $1 and i.owner_id = $2 group by o.item_id`, [tenantId, ownerId]);
    const by = new Map(rows.map((r) => [r.item_id, r]));
    return items.map((i) => ({ ...i, messageIds: by.get(i.id)?.messages ?? [], folders: by.get(i.id)?.folders ?? [] }));
  }

  async ownerStamp(tenantId: string, ownerId: string): Promise<string> {
    const rows = await this.q<{ n: string; at: Date | string | null; o: string }>(tenantId,
      `select count(*) as n, max(updated_at) as at,
         (select count(*) from library_item_origins o join library_items i on i.tenant_id = o.tenant_id and i.id = o.item_id where o.tenant_id = $1 and i.owner_id = $2) as o
       from library_items where tenant_id = $1 and owner_id = $2`, [tenantId, ownerId]);
    const r = rows[0];
    return r ? `${r.n}:${r.at === null ? '' : iso(r.at)}:${r.o}` : '0::0';
  }

  async owners(tenantId: string): Promise<string[]> {
    const rows = await this.q<{ owner_id: string }>(tenantId, `select distinct owner_id from library_items where tenant_id = $1`, [tenantId]);
    return rows.map((r) => r.owner_id);
  }

  async ownerState(tenantId: string, ownerId: string): Promise<LibraryOwnerStateRow | null> {
    const rows = await this.q<{
      okf_enabled: boolean; okf_written_at: Date | string | null; okf_stamp: string; okf_error: string; versions_notified: string[]; versions_noticed_at: Date | string | null; views_checked_at: Date | string | null;
    }>(tenantId,
      `select okf_enabled, okf_written_at, okf_stamp, okf_error, versions_notified, versions_noticed_at, views_checked_at from library_owner_state where tenant_id = $1 and owner_id = $2`, [tenantId, ownerId]);
    const r = rows[0];
    if (!r) return null;
    return {
      okfEnabled: r.okf_enabled, okfWrittenAt: r.okf_written_at === null ? null : iso(r.okf_written_at), okfStamp: r.okf_stamp, okfError: r.okf_error,
      versionsNotified: r.versions_notified, versionsNoticedAt: r.versions_noticed_at === null ? null : iso(r.versions_noticed_at),
      viewsCheckedAt: r.views_checked_at === null ? null : iso(r.views_checked_at),
    };
  }

  async saveOwnerState(tenantId: string, ownerId: string, w: LibraryOwnerStateRow): Promise<void> {
    await this.q(tenantId,
      `insert into library_owner_state (tenant_id, owner_id, okf_enabled, okf_written_at, okf_stamp, okf_error, versions_notified, versions_noticed_at, views_checked_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (tenant_id, owner_id) do update set okf_enabled = excluded.okf_enabled, okf_written_at = excluded.okf_written_at, okf_stamp = excluded.okf_stamp, okf_error = excluded.okf_error,
         versions_notified = excluded.versions_notified, versions_noticed_at = excluded.versions_noticed_at, views_checked_at = excluded.views_checked_at, updated_at = now()`,
      [tenantId, ownerId, w.okfEnabled, w.okfWrittenAt, w.okfStamp, w.okfError.slice(0, 300), w.versionsNotified.slice(-2000), w.versionsNoticedAt, w.viewsCheckedAt]);
  }

  async okfFiles(tenantId: string, ownerId: string): Promise<LibraryOkfFileRow[]> {
    const rows = await this.q<{ key: string; drive_id: string; digest: string }>(tenantId, `select key, drive_id, digest from library_okf_files where tenant_id = $1 and owner_id = $2`, [tenantId, ownerId]);
    return rows.map((r) => ({ key: r.key, driveId: r.drive_id, digest: r.digest }));
  }

  async saveOkfFile(tenantId: string, ownerId: string, f: LibraryOkfFileRow): Promise<void> {
    await this.q(tenantId,
      `insert into library_okf_files (tenant_id, owner_id, key, drive_id, digest, updated_at) values ($1, $2, $3, $4, $5, now())
       on conflict (tenant_id, owner_id, key) do update set drive_id = excluded.drive_id, digest = excluded.digest, updated_at = now()`,
      [tenantId, ownerId, f.key, f.driveId, f.digest]);
  }

  async deleteOkfFile(tenantId: string, ownerId: string, key: string): Promise<void> {
    await this.q(tenantId, `delete from library_okf_files where tenant_id = $1 and owner_id = $2 and key = $3`, [tenantId, ownerId, key]);
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
       where o.tenant_id = $1 and o.message_id = $2 and i.owner_id = $3 and i.format <> 'mail' limit 1`, [who.tenantId, messageId, who.userId]);
    return rows.length > 0;
  }

  async mailThread(who: LibraryViewer, threadId: string): Promise<LibraryThreadRow | null> {
    const rows = await this.q<ThreadDbRow>(who.tenantId,
      `select ${THREAD_COLS} from library_mail_threads where tenant_id = $1 and owner_id = $2 and thread_id = $3`, [who.tenantId, who.userId, threadId]);
    return rows[0] ? toThread(rows[0]) : null;
  }

  async saveMailThread(who: LibraryViewer, t: LibraryThreadRow): Promise<void> {
    await this.q(who.tenantId,
      `insert into library_mail_threads (tenant_id, owner_id, thread_id, decision, reason, item_id, last_message_id, message_count, first_at, last_at, people, checked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
       on conflict (tenant_id, owner_id, thread_id) do update set decision = excluded.decision, reason = excluded.reason, item_id = excluded.item_id,
         last_message_id = excluded.last_message_id, message_count = excluded.message_count, first_at = excluded.first_at, last_at = excluded.last_at,
         people = excluded.people, checked_at = excluded.checked_at`,
      [who.tenantId, who.userId, t.threadId, t.decision, t.reason.slice(0, 40), t.itemId, t.lastMessageId, t.messageCount, t.firstAt, t.lastAt, JSON.stringify(t.people), t.checkedAt]);
  }

  async threadOfItem(who: LibraryViewer, itemId: string): Promise<LibraryThreadRow | null> {
    const rows = await this.q<ThreadDbRow>(who.tenantId,
      `select ${THREAD_COLS} from library_mail_threads where tenant_id = $1 and owner_id = $2 and item_id = $3 limit 1`, [who.tenantId, who.userId, itemId]);
    return rows[0] ? toThread(rows[0]) : null;
  }

  async threadWatch(who: LibraryViewer): Promise<LibraryThreadWatchRow | null> {
    const rows = await this.q<{
      checked_at: Date | string | null; back_from: Date | string | null; back_until: Date | string | null; back_token: string | null; back_done: boolean; back_waiting: boolean;
      back_day: string | null; back_count: number; scanned: number; kept: number; noticed: boolean;
    }>(who.tenantId,
      `select checked_at, back_from, back_until, back_token, back_done, back_waiting, back_day::text as back_day, back_count, scanned, kept, noticed
       from library_thread_watch where tenant_id = $1 and owner_id = $2`, [who.tenantId, who.userId]);
    const r = rows[0];
    if (!r) return null;
    const at = (v: Date | string | null) => (v === null ? null : iso(v));
    return {
      checkedAt: at(r.checked_at), backFrom: at(r.back_from), backUntil: at(r.back_until), backToken: r.back_token, backDone: r.back_done, backWaiting: r.back_waiting,
      backDay: r.back_day, backCount: r.back_count, scanned: r.scanned, kept: r.kept, noticed: r.noticed,
    };
  }

  async saveThreadWatch(who: LibraryViewer, w: LibraryThreadWatchRow): Promise<void> {
    await this.q(who.tenantId,
      `insert into library_thread_watch (tenant_id, owner_id, checked_at, back_from, back_until, back_token, back_done, back_waiting, back_day, back_count, scanned, kept, noticed, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, now())
       on conflict (tenant_id, owner_id) do update set checked_at = excluded.checked_at, back_from = excluded.back_from, back_until = excluded.back_until, back_token = excluded.back_token,
         back_done = excluded.back_done, back_waiting = excluded.back_waiting, back_day = excluded.back_day, back_count = excluded.back_count, scanned = excluded.scanned,
         kept = excluded.kept, noticed = excluded.noticed, updated_at = now()`,
      [who.tenantId, who.userId, w.checkedAt, w.backFrom, w.backUntil, w.backToken, w.backDone, w.backWaiting, w.backDay, w.backCount, w.scanned, w.kept, w.noticed]);
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
    const keep = <T>(k: string, ai: T | undefined, old: T) => (item.edited.includes(k) || ai === undefined ? old : ai);
    const next = {
      title: keep('title', r.title, item.title), docType: keep('docType', r.docType, item.docType), counterparty: keep('counterparty', r.counterparty, item.counterparty),
      summary: r.summary ?? item.summary, keywords: r.keywords ?? item.keywords, originalName: item.originalName,
      tags: keep('tags', r.tags, item.tags),
    };
    const docDate = item.edited.includes('docDate') || r.docDate === undefined ? item.docDate : r.docDate;
    const origins = await this.q<{ folder: string; sender: string; subject: string }>(tenantId, `select folder, sender, subject from library_item_origins where tenant_id = $1 and item_id = $2`, [tenantId, id]);
    await this.q(tenantId,
      `update library_items set read_state = $3, read_note = $4, read_scope = $5, title = $6, doc_type = $7, counterparty = $8, contact_id = $9, doc_date = $10::date,
         summary = $11, keywords = $12, search_text = $13, drive_file_id = coalesce($14, drive_file_id), drive_url = coalesce($15, drive_url), sha256 = coalesce(sha256, $16), size_bytes = coalesce($17, size_bytes),
         tags = $18, tagged = tagged or $19, attempts = 0, received_at = coalesce($20::timestamptz, received_at), updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, id, r.readState, r.readNote, r.readScope, next.title, next.docType, next.counterparty, r.contactId === undefined ? item.contactId : r.contactId, docDate,
        next.summary, next.keywords, librarySearchText(next, origins), r.driveFileId ?? null, r.driveUrl ?? null, r.sha256 ?? null, r.sizeBytes ?? null,
        next.tags, r.tags !== undefined, r.receivedAt ?? null]);
  }

  async retryLater(tenantId: string, id: string, delayMs: number): Promise<void> {
    await this.q(tenantId, `update library_items set attempts = attempts + 1, next_try_at = now() + ($3::bigint * interval '1 millisecond') where tenant_id = $1 and id = $2`, [tenantId, id, delayMs]);
  }

  async setPlaced(tenantId: string, id: string, driveFileId: string, driveUrl: string | null): Promise<void> {
    await this.q(tenantId, `update library_items set drive_file_id = $3, drive_url = $4, placed = true, file_id = null, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, driveFileId, driveUrl]);
  }

  async setViewed(tenantId: string, ownerId: string, views: { driveFileId: string; at: string }[]): Promise<number> {
    if (views.length === 0) return 0;
    const rows = await this.q<{ id: string }>(tenantId,
      `update library_items i set viewed_at = v.at, updated_at = now()
         from (select unnest($3::text[]) as drive_file_id, unnest($4::timestamptz[]) as at) v
       where i.tenant_id = $1 and i.owner_id = $2 and i.drive_file_id = v.drive_file_id and (i.viewed_at is null or i.viewed_at < v.at)
       returning i.id`,
      [tenantId, ownerId, views.map((v) => v.driveFileId), views.map((v) => v.at)]);
    return rows.length;
  }

  async untagged(tenantId: string, limit: number): Promise<LibraryItem[]> {
    const rows = await this.q<Row>(tenantId,
      `select ${COLS} from library_items where tenant_id = $1 and not tagged and read_state not in ('pending', 'paused')
         and owner_id = (select owner_id from library_items where tenant_id = $1 and not tagged and read_state not in ('pending', 'paused') limit 1)
       order by received_at desc limit $2`, [tenantId, limit]);
    return rows.map(toItem);
  }

  async setTags(tenantId: string, id: string, tags: string[] | null): Promise<void> {
    if (!tags) {
      await this.q(tenantId, `update library_items set tagged = true where tenant_id = $1 and id = $2`, [tenantId, id]);
      return;
    }
    const cur = await this.q<Row>(tenantId, `select ${COLS} from library_items where tenant_id = $1 and id = $2`, [tenantId, id]);
    const row = cur[0];
    if (!row) return;
    const item = toItem(row);
    const next = { ...item, tags: item.edited.includes('tags') ? item.tags : tags };
    const origins = await this.q<{ folder: string; sender: string; subject: string }>(tenantId, `select folder, sender, subject from library_item_origins where tenant_id = $1 and item_id = $2`, [tenantId, id]);
    await this.q(tenantId,
      `update library_items set tags = $3, search_text = $4, tagged = true, updated_at = now() where tenant_id = $1 and id = $2`,
      [tenantId, id, next.tags, librarySearchText(next, origins)]);
  }

  async tagNames(tenantId: string, ownerId: string): Promise<string[]> {
    return (await this.q<{ v: string }>(tenantId,
      `select v from library_items, unnest(tags) as v where tenant_id = $1 and owner_id = $2 and v <> '' group by v order by count(*) desc, v limit 100`, [tenantId, ownerId])).map((r) => r.v);
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
  readonly rows = new Map<string, LibraryWork & { tenantId: string; nextTryAt: number; searchText: string; tagged: boolean; origins: (LibraryOrigin & { artifactId?: string; messageId?: string })[] }>();
  readonly mailWatches = new Map<string, LibraryMailWatchRow>();
  readonly threadRows = new Map<string, LibraryThreadRow>();
  readonly threadWatches = new Map<string, LibraryThreadWatchRow>();
  readonly tombstones = new Set<string>();
  readonly folders = new Map<string, string>();
  private mine = (who: LibraryViewer) => [...this.rows.values()].filter((r) => r.tenantId === who.tenantId && r.ownerId === who.userId);
  readonly shareRows = new Map<string, LibraryShareRow[]>();
  readonly ownerStates = new Map<string, LibraryOwnerStateRow>();
  readonly okf = new Map<string, LibraryOkfFileRow>();
  /** 見る人に見えるか（本人の資料と、本人に共有された資料）。 */
  private visible = (who: LibraryViewer, r: { tenantId: string; ownerId: string; id: string; shareScope: string }) => r.tenantId === who.tenantId && (r.ownerId === who.userId
    || (!!who.groups && (r.shareScope === 'company' || (r.shareScope === 'group' && (this.shareRows.get(r.id) ?? []).some((x) => !!x.groupId && who.groups!.includes(x.groupId))))));
  private seen = (who: LibraryViewer) => [...this.rows.values()].filter((r) => this.visible(who, r));
  private toView = (r: LibraryWork): LibraryItem => {
    const { fileId: _f, sha256: _s, attempts: _a, tenantId: _t, nextTryAt: _n, searchText: _x, origins: _o, tagged: _g, ...item } = r as LibraryWork & { tenantId: string; nextTryAt: number; searchText: string; origins: unknown; tagged: boolean };
    return item;
  };

  async insert(who: LibraryViewer, i: NewLibraryItem): Promise<{ item: LibraryItem; created: boolean }> {
    const same = this.mine(who).find((r) => (i.sha256 && r.sha256 === i.sha256) || (i.driveFileId && r.driveFileId === i.driveFileId));
    if (same) return { item: this.toView(same), created: false };
    const now = new Date().toISOString();
    const row = {
      id: `lib-${randomUUID()}`, tenantId: who.tenantId, ownerId: who.userId, driveFileId: i.driveFileId, driveUrl: i.driveUrl, placed: i.placed, fileId: i.fileId, originalName: i.originalName,
      format: i.format, mime: i.mime, sizeBytes: i.sizeBytes, sha256: i.sha256, entry: i.entry, title: i.title ?? '', docType: '', counterparty: '', contactId: null, tags: [] as string[], docDate: null, receivedAt: i.receivedAt ?? now,
      summary: '', keywords: [], readState: i.readState ?? 'pending' as LibraryReadState, readNote: i.readNote ?? '', readScope: '', edited: [], attempts: 0,
      shareScope: 'self' as LibraryShareScope, knowledgeId: null as string | null, verifiedAt: null as string | null, viewedAt: null as string | null, createdAt: now, updatedAt: now,
      nextTryAt: 0, searchText: '', tagged: false, origins: [],
    };
    row.searchText = librarySearchText(row, []);
    this.rows.set(row.id, row);
    return { item: this.toView(row), created: true };
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
    return { ...this.toView(r), origins: r.origins.map(({ artifactId: _a, messageId: _m, ...o }) => o) };
  }

  async view(who: LibraryViewer, id: string): Promise<LibraryItemDetail | null> {
    const r = this.rows.get(id);
    if (!r || !this.visible({ ...who, groups: who.groups ?? [] }, r)) return null;
    return { ...this.toView(r), origins: r.origins.map(({ artifactId: _a, messageId: _m, ...o }) => o) };
  }

  async list(who: LibraryViewer, f: LibraryFilter, terms: string[], limit: number, offset: number): Promise<{ items: LibraryItem[]; total: number }> {
    const hits = this.seen(who).filter((r) =>
      (!f.docType || r.docType === f.docType) && (!f.counterparty || r.counterparty === f.counterparty) && (!f.tags?.length || f.tags.every((t) => r.tags.includes(t))) && (!f.entry || r.entry === f.entry)
      && (!f.year || Number((r.docDate ?? r.receivedAt).slice(0, 4)) === f.year)
      && (terms.length === 0 || terms.some((t) => r.searchText.includes(t))));
    hits.sort((a, b) => (b.docDate ?? b.receivedAt.slice(0, 10)).localeCompare(a.docDate ?? a.receivedAt.slice(0, 10)) || b.receivedAt.localeCompare(a.receivedAt));
    return { items: hits.slice(offset, offset + limit).map(this.toView), total: hits.length };
  }

  async facets(who: LibraryViewer): Promise<LibraryFacets> {
    const rows = this.seen(who);
    return {
      tags: libraryTopTags(rows.flatMap((r) => r.tags), 300),
      years: [...new Set(rows.map((r) => Number((r.docDate ?? r.receivedAt).slice(0, 4))))].sort((a, b) => b - a),
    };
  }

  async progress(who: LibraryViewer): Promise<{ pending: number; paused: number }> {
    const rows = this.mine(who);
    return { pending: rows.filter((r) => r.readState === 'pending').length, paused: rows.filter((r) => r.readState === 'paused').length };
  }

  async byHash(who: LibraryViewer, sha256: string): Promise<LibraryItem | null> {
    const r = this.mine(who).find((x) => x.sha256 === sha256);
    return r ? this.toView(r) : null;
  }

  async byDriveFile(who: LibraryViewer, driveFileId: string): Promise<LibraryItem | null> {
    const r = this.mine(who).find((x) => x.driveFileId === driveFileId);
    return r ? this.toView(r) : null;
  }

  async existingHashes(who: LibraryViewer, hashes: string[]): Promise<string[]> {
    return this.mine(who).map((r) => r.sha256).filter((h): h is string => !!h && hashes.includes(h));
  }

  async update(who: LibraryViewer, id: string, patch: LibraryPatch): Promise<LibraryItem | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    Object.assign(r, patch, { edited: [...new Set([...r.edited, ...Object.keys(patch)])] });
    r.updatedAt = new Date(Math.max(Date.now(), Date.parse(r.updatedAt) + 1)).toISOString();
    r.searchText = librarySearchText(r, r.origins);
    return this.toView(r);
  }

  async requeue(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    Object.assign(r, { readState: 'pending', readNote: '', readScope: '', attempts: 0, nextTryAt: 0, tagged: false });
    return this.toView(r);
  }

  async remove(who: LibraryViewer, id: string): Promise<LibraryItem | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    this.rows.delete(id);
    if (r.sha256) this.tombstones.add(`${who.tenantId}:${who.userId}:${r.sha256}`);
    return this.toView(r);
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
    this.threadWatches.delete(`${tenantId}:${userId}`);
    for (const k of [...this.threadRows.keys()]) if (k.startsWith(`${tenantId}:${userId}:`)) this.threadRows.delete(k);
    this.ownerStates.delete(`${tenantId}:${userId}`);
    for (const k of [...this.okf.keys()]) if (k.startsWith(`${tenantId}:${userId}:`)) this.okf.delete(k);
    return rows.length;
  }

  async shares(who: LibraryViewer, itemId: string): Promise<LibraryShareRow[]> {
    const r = this.rows.get(itemId);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return [];
    return (this.shareRows.get(itemId) ?? []).map((x) => ({ ...x, emails: [...x.emails] }));
  }

  async setShares(who: LibraryViewer, itemId: string, scope: LibraryShareScope, rows: LibraryShareRow[]): Promise<LibraryItem | null> {
    const r = this.rows.get(itemId);
    if (!r || r.tenantId !== who.tenantId || r.ownerId !== who.userId) return null;
    r.shareScope = scope;
    r.updatedAt = new Date().toISOString();
    if (scope === 'self' || rows.length === 0) this.shareRows.delete(itemId);
    else this.shareRows.set(itemId, rows.map((x) => ({ ...x, emails: [...x.emails] })));
    return this.toView(r);
  }

  async setKnowledge(who: LibraryViewer, itemId: string, knowledgeId: string, at: string): Promise<void> {
    const r = this.rows.get(itemId);
    if (r && r.tenantId === who.tenantId && r.ownerId === who.userId) Object.assign(r, { knowledgeId, verifiedAt: at });
  }

  async versionsOf(who: LibraryViewer, item: LibraryItem): Promise<LibraryItem[]> {
    if (!libraryVersionKey(item)) return [];
    return this.mine(who).filter((r) => r.id !== item.id && r.title === item.title && r.counterparty === item.counterparty && r.docType === item.docType)
      .sort((a, b) => (b.docDate ?? b.receivedAt).localeCompare(a.docDate ?? a.receivedAt)).map(this.toView);
  }

  async allOf(tenantId: string, ownerId: string): Promise<LibraryItem[]> {
    return this.mine({ tenantId, userId: ownerId }).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).map(this.toView);
  }

  async linkInputs(tenantId: string, ownerId: string): Promise<LibraryLinkInput[]> {
    return this.mine({ tenantId, userId: ownerId }).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).map((r) => ({
      ...this.toView(r), messageIds: [...new Set(r.origins.map((o) => o.messageId).filter((x): x is string => !!x))], folders: [...new Set(r.origins.map((o) => o.folder).filter(Boolean))],
    }));
  }

  async ownerStamp(tenantId: string, ownerId: string): Promise<string> {
    const rows = this.mine({ tenantId, userId: ownerId });
    const at = rows.map((r) => r.updatedAt).sort().at(-1) ?? '';
    return `${rows.length}:${at}:${rows.reduce((n, r) => n + r.origins.length, 0)}`;
  }

  async owners(tenantId: string): Promise<string[]> {
    return [...new Set([...this.rows.values()].filter((r) => r.tenantId === tenantId).map((r) => r.ownerId))];
  }

  async ownerState(tenantId: string, ownerId: string): Promise<LibraryOwnerStateRow | null> {
    const w = this.ownerStates.get(`${tenantId}:${ownerId}`);
    return w ? { ...w, versionsNotified: [...w.versionsNotified] } : null;
  }

  async saveOwnerState(tenantId: string, ownerId: string, row: LibraryOwnerStateRow): Promise<void> {
    this.ownerStates.set(`${tenantId}:${ownerId}`, { ...row, versionsNotified: [...row.versionsNotified] });
  }

  async okfFiles(tenantId: string, ownerId: string): Promise<LibraryOkfFileRow[]> {
    return [...this.okf.entries()].filter(([k]) => k.startsWith(`${tenantId}:${ownerId}:`)).map(([, v]) => ({ ...v }));
  }

  async saveOkfFile(tenantId: string, ownerId: string, row: LibraryOkfFileRow): Promise<void> {
    this.okf.set(`${tenantId}:${ownerId}:${row.key}`, { ...row });
  }

  async deleteOkfFile(tenantId: string, ownerId: string, key: string): Promise<void> {
    this.okf.delete(`${tenantId}:${ownerId}:${key}`);
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
    return this.mine(who).some((r) => r.format !== 'mail' && r.origins.some((o) => o.messageId === messageId));
  }

  async mailThread(who: LibraryViewer, threadId: string): Promise<LibraryThreadRow | null> {
    const t = this.threadRows.get(`${who.tenantId}:${who.userId}:${threadId}`);
    return t ? { ...t, people: [...t.people] } : null;
  }

  async saveMailThread(who: LibraryViewer, row: LibraryThreadRow): Promise<void> {
    this.threadRows.set(`${who.tenantId}:${who.userId}:${row.threadId}`, { ...row, people: [...row.people] });
  }

  async threadOfItem(who: LibraryViewer, itemId: string): Promise<LibraryThreadRow | null> {
    const t = [...this.threadRows.entries()].find(([k, v]) => k.startsWith(`${who.tenantId}:${who.userId}:`) && v.itemId === itemId)?.[1];
    return t ? { ...t, people: [...t.people] } : null;
  }

  async threadWatch(who: LibraryViewer): Promise<LibraryThreadWatchRow | null> {
    const w = this.threadWatches.get(`${who.tenantId}:${who.userId}`);
    return w ? { ...w } : null;
  }

  async saveThreadWatch(who: LibraryViewer, row: LibraryThreadWatchRow): Promise<void> {
    this.threadWatches.set(`${who.tenantId}:${who.userId}`, { ...row });
  }

  async claim(tenantId: string, limit: number, leaseMs: number, placeOnly: boolean): Promise<LibraryWork[]> {
    const now = Date.now();
    const rows = [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.readState === 'pending' && r.nextTryAt <= now && (!placeOnly || !r.driveFileId))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    for (const r of rows) r.nextTryAt = now + leaseMs;
    return rows.map((r) => ({ ...this.toView(r), fileId: r.fileId, sha256: r.sha256, attempts: r.attempts }));
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
    if (x.tags !== undefined && !r.edited.includes('tags')) r.tags = x.tags;
    if (x.tags !== undefined) r.tagged = true;
    r.readState = x.readState; r.readNote = x.readNote; r.readScope = x.readScope; r.attempts = 0;
    r.updatedAt = new Date(Math.max(Date.now(), Date.parse(r.updatedAt) + 1)).toISOString();
    if (x.driveUrl) r.driveUrl = x.driveUrl;
    if (x.sha256 && !r.sha256) r.sha256 = x.sha256;
    if (x.sizeBytes !== undefined) r.sizeBytes = x.sizeBytes;
    if (x.receivedAt) r.receivedAt = x.receivedAt;
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

  async setViewed(tenantId: string, ownerId: string, views: { driveFileId: string; at: string }[]): Promise<number> {
    let n = 0;
    for (const r of this.mine({ tenantId, userId: ownerId })) {
      const at = views.filter((v) => v.driveFileId === r.driveFileId).map((v) => v.at).sort().at(-1);
      if (!at || (r.viewedAt && r.viewedAt >= at)) continue;
      r.viewedAt = at;
      r.updatedAt = new Date(Math.max(Date.now(), Date.parse(r.updatedAt) + 1)).toISOString();
      n += 1;
    }
    return n;
  }

  async untagged(tenantId: string, limit: number): Promise<LibraryItem[]> {
    const waiting = [...this.rows.values()].filter((r) => r.tenantId === tenantId && !r.tagged && r.readState !== 'pending' && r.readState !== 'paused');
    const owner = waiting[0]?.ownerId;
    return waiting.filter((r) => r.ownerId === owner).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit).map(this.toView);
  }

  async setTags(tenantId: string, id: string, tags: string[] | null): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    r.tagged = true;
    if (!tags) return;
    if (!r.edited.includes('tags')) r.tags = tags;
    r.updatedAt = new Date(Math.max(Date.now(), Date.parse(r.updatedAt) + 1)).toISOString();
    r.searchText = librarySearchText(r, r.origins);
  }

  async tagNames(tenantId: string, ownerId: string): Promise<string[]> {
    return libraryTopTags(this.mine({ tenantId, userId: ownerId }).flatMap((r) => r.tags), 100);
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
