/**
 * @file サイトの更新の直しの記録の置き場（仕様書 第45.11節。表 `site_edits`）。
 *
 * 1 回の頼みで 1 行。ページごとの直す前と後の本文は `pages` に持ち、90 日を過ぎたら消して、
 * いつ・誰が・どのページを直したかだけを残す（Q-332）。すべての読み書きをテナントで絞る（不変則 I-2）。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { SiteEditChange, SiteEditPageResult, SiteEditStatus } from '@m2office/shared';
import type { PostTermFields, SiteContentKind } from './wordpress.js';
import { purgedTerm } from './terms.js';
import { purgedAction, type StoredSiteAction } from './actions.js';

/** 直し 1 ページ分（置き場の形）。 */
export interface StoredSiteEditPage {
  kind: SiteContentKind;
  wpId: string;
  title: string;
  link: string;
  /** WordPress の公開の状態（`publish`・`draft` など）。公開中だけ、公開のページで確かめる。 */
  wpStatus: string;
  /** 直す前（本文・題名・抜粋）と、直す前の最後に直された時刻。90 日を過ぎたら空にする。 */
  before: { content: string; title: string; excerpt: string };
  beforeModified: string;
  /** 直した後。題名・抜粋は直すときだけ。 */
  after: { content: string; title: string | null; excerpt: string | null };
  /** 入れた後の最後に直された時刻（元に戻すとき、入れた後に人が直していないかを見る）。 */
  afterModified: string;
  /** 人が読む直しの一覧（承認の画面と記録に出す）。 */
  changes: SiteEditChange[];
  /** 公開のページで、出ているかを確かめる文。 */
  expect: string[];
  result: SiteEditPageResult;
  reason: string;
}

/** 直し 1 件（置き場の形）。 */
export interface StoredSiteEdit {
  id: string;
  requestedBy: string;
  request: string;
  status: SiteEditStatus;
  revertOf: string | null;
  runId: string | null;
  pages: StoredSiteEditPage[];
  digest: string;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
  purgedAt: string | null;
  /** 直し案を作ったときに使った接続（会社か本人か。第45.16節）。承認の後も同じ接続で入れる。 */
  authKind: 'company' | 'user';
  /** そのときの WordPress の利用者名。 */
  wpUsername: string;
  /** サイトのカテゴリーとタグの直し（第45.17節）。 */
  terms: StoredTermChange[];
  /** 新しい記事と固定ページ・公開の状態・前の版・アイキャッチ（第45.18.1節）。 */
  actions: StoredSiteAction[];
}

/** 記事のカテゴリーとタグの ID の組。 */
export interface PostTermIds {
  categories: string[];
  tags: string[];
}

/** サイトのカテゴリー・タグの直し 1 つ（置き場の形。第45.17節）。 */
export type StoredTermChange =
  | { op: 'create'; taxonomy: string; name: string; parentId: string | null; parentName: string | null; createdId: string | null; result: SiteEditPageResult; reason: string }
  | { op: 'rename'; taxonomy: string; termId: string; before: string; after: string; result: SiteEditPageResult; reason: string }
  | {
    op: 'assign'; postId: string; postTitle: string; postLink: string; beforeModified: string;
    /** 記事の種類と分類の欄（カスタム投稿タイプの独自の分類。第45.20.3節）。無ければ投稿。 */
    fields?: PostTermFields;
    /** 直し案のときの記事のカテゴリーとタグ。入れる前に、これと同じかを確かめる。 */
    before: PostTermIds;
    add: { taxonomy: string; id: string | null; name: string }[];
    remove: { taxonomy: string; id: string; name: string }[];
    /** 元に戻すときだけ: このとおりにそろえる。 */
    exact: PostTermIds | null;
    /** 入れた後のカテゴリーとタグ（元に戻すとき、入れた後に人が変えていないかを見る）。 */
    after: PostTermIds | null;
    result: SiteEditPageResult; reason: string;
  }
  | { op: 'delete'; taxonomy: string; termId: string; name: string; result: SiteEditPageResult; reason: string };

/** 新しく作る直し。 */
export type NewSiteEdit = Pick<StoredSiteEdit, 'requestedBy' | 'request' | 'revertOf' | 'pages' | 'digest' | 'authKind' | 'wpUsername' | 'terms' | 'actions'>;

/** 直しの記録の置き場。 */
export interface SiteEditStore {
  create(tenantId: string, e: NewSiteEdit): Promise<string>;
  get(tenantId: string, id: string): Promise<StoredSiteEdit | null>;
  /** 新しい順。 */
  list(tenantId: string, limit: number): Promise<StoredSiteEdit[]>;
  update(tenantId: string, id: string, patch: Partial<Pick<StoredSiteEdit, 'status' | 'runId' | 'pages' | 'terms' | 'actions' | 'appliedAt' | 'revertedAt'>>): Promise<void>;
  /**
   * `before` より前に作った直しの、直す前と後の本文を消す（記録は残す）。
   *
   * @returns 消した件数
   */
  purge(tenantId: string, before: string): Promise<number>;
  /** 前に知らせた承認待ちのコメントの番号（まだ見回っていなければ `null`。第45.18.3節）。 */
  commentSeen(tenantId: string): Promise<number | null>;
  /** 知らせたコメントの番号を残す。 */
  markCommentSeen(tenantId: string, lastId: number): Promise<void>;
  /** 前に知らせたプラグインなどの問題の指紋と、見回った時刻（第45.18.5節）。 */
  healthSeen(tenantId: string): Promise<{ digest: string; checkedAt: string | null }>;
  /** 見回った時刻と、知らせた問題の指紋を残す。 */
  markHealth(tenantId: string, digest: string, at: string): Promise<void>;
}

/** 本文を消したページ（記録だけを残す）。 */
export function purgedPage(p: StoredSiteEditPage): StoredSiteEditPage {
  return { ...p, before: { content: '', title: '', excerpt: '' }, after: { content: '', title: null, excerpt: null }, changes: [], expect: [] };
}

interface Row extends pg.QueryResultRow {
  id: string; requested_by: string; request: string; status: SiteEditStatus; revert_of: string | null; run_id: string | null;
  pages: StoredSiteEditPage[]; digest: string; created_at: Date | string; applied_at: Date | string | null; reverted_at: Date | string | null; purged_at: Date | string | null;
  auth_kind: 'company' | 'user'; wp_username: string; terms: StoredTermChange[] | null; actions: StoredSiteAction[] | null;
}

const COLUMNS = 'id, requested_by, request, status, revert_of, run_id, pages, digest, created_at, applied_at, reverted_at, purged_at, auth_kind, wp_username, terms, actions';
/**
 * 日時の列を ISO の文字にする。
 *
 * @remarks 接続の設定によって、日時は `Date` でも文字でも返る（リポジトリが日時を文字のまま受け取る設定を入れている）。どちらでも読む
 */
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

function toEdit(r: Row): StoredSiteEdit {
  return {
    id: r.id, requestedBy: r.requested_by, request: r.request, status: r.status, revertOf: r.revert_of, runId: r.run_id,
    pages: Array.isArray(r.pages) ? r.pages : [], digest: r.digest, createdAt: iso(r.created_at)!,
    appliedAt: iso(r.applied_at), revertedAt: iso(r.reverted_at), purgedAt: iso(r.purged_at),
    authKind: r.auth_kind === 'user' ? 'user' : 'company', wpUsername: r.wp_username ?? '', terms: Array.isArray(r.terms) ? r.terms : [], actions: Array.isArray(r.actions) ? r.actions : [],
  };
}

/** PostgreSQL の置き場。 */
export class PostgresSiteEditStore implements SiteEditStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'site-updates' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const rows = (await client.query<T>(text, params as never[])).rows;
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async create(tenantId: string, e: NewSiteEdit): Promise<string> {
    const id = `sed-${randomUUID()}`;
    await this.q(tenantId, `insert into site_edits (id, tenant_id, requested_by, request, status, revert_of, pages, digest, auth_kind, wp_username, terms, actions)
      values ($1, $2, $3, $4, 'awaiting', $5, $6, $7, $8, $9, $10, $11)`,
    [id, tenantId, e.requestedBy, e.request, e.revertOf, JSON.stringify(e.pages), e.digest, e.authKind, e.wpUsername, JSON.stringify(e.terms), JSON.stringify(e.actions)]);
    return id;
  }

  async get(tenantId: string, id: string): Promise<StoredSiteEdit | null> {
    const rows = await this.q<Row>(tenantId, `select ${COLUMNS} from site_edits where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toEdit(rows[0]) : null;
  }

  async list(tenantId: string, limit: number): Promise<StoredSiteEdit[]> {
    return (await this.q<Row>(tenantId, `select ${COLUMNS} from site_edits where tenant_id = $1 order by created_at desc limit $2`, [tenantId, limit])).map(toEdit);
  }

  async update(tenantId: string, id: string, patch: Partial<Pick<StoredSiteEdit, 'status' | 'runId' | 'pages' | 'terms' | 'actions' | 'appliedAt' | 'revertedAt'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.runId !== undefined) add('run_id', patch.runId);
    if (patch.pages !== undefined) add('pages', JSON.stringify(patch.pages));
    if (patch.terms !== undefined) add('terms', JSON.stringify(patch.terms));
    if (patch.actions !== undefined) add('actions', JSON.stringify(patch.actions));
    if (patch.appliedAt !== undefined) add('applied_at', patch.appliedAt);
    if (patch.revertedAt !== undefined) add('reverted_at', patch.revertedAt);
    if (!sets.length) return;
    await this.q(tenantId, `update site_edits set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async purge(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<Row>(tenantId, `select ${COLUMNS} from site_edits where tenant_id = $1 and purged_at is null and created_at < $2`, [tenantId, before]);
    for (const r of rows) {
      const e = toEdit(r);
      await this.q(tenantId, `update site_edits set pages = $3, terms = $4, actions = $5, purged_at = now() where tenant_id = $1 and id = $2`,
        [tenantId, e.id, JSON.stringify(e.pages.map(purgedPage)), JSON.stringify(e.terms.map(purgedTerm)), JSON.stringify(e.actions.map(purgedAction))]);
    }
    return rows.length;
  }

  async commentSeen(tenantId: string): Promise<number | null> {
    const [r] = await this.q<{ last_comment_id: string | number }>(tenantId, 'select last_comment_id from site_comment_watch where tenant_id = $1', [tenantId]);
    return r ? Number(r.last_comment_id) : null;
  }

  async markCommentSeen(tenantId: string, lastId: number): Promise<void> {
    await this.q(tenantId,
      `insert into site_comment_watch (tenant_id, last_comment_id, checked_at) values ($1, $2, now())
       on conflict (tenant_id) do update set last_comment_id = greatest(site_comment_watch.last_comment_id, excluded.last_comment_id), checked_at = now()`, [tenantId, lastId]);
  }

  async healthSeen(tenantId: string): Promise<{ digest: string; checkedAt: string | null }> {
    const [r] = await this.q<{ health_digest: string; health_checked_at: unknown }>(tenantId, 'select health_digest, health_checked_at from site_comment_watch where tenant_id = $1', [tenantId]);
    return { digest: r?.health_digest ?? '', checkedAt: r?.health_checked_at ? iso(r.health_checked_at as Date | string) : null };
  }

  async markHealth(tenantId: string, digest: string, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into site_comment_watch (tenant_id, health_digest, health_checked_at) values ($1, $2, $3)
       on conflict (tenant_id) do update set health_digest = excluded.health_digest, health_checked_at = excluded.health_checked_at`, [tenantId, digest, at]);
  }
}

/** 手元の置き場（テストと見本の会社）。 */
export class MemorySiteEditStore implements SiteEditStore {
  private readonly rows = new Map<string, { tenantId: string; e: StoredSiteEdit }>();
  private seq = 0;

  async create(tenantId: string, e: NewSiteEdit): Promise<string> {
    const id = `sed-${randomUUID()}`;
    // 同じ時刻でも並びが決まるように、作った順に 1 ミリ秒ずらす
    const createdAt = new Date(Date.now() + this.seq++).toISOString();
    this.rows.set(id, { tenantId, e: { ...structuredClone(e), id, status: 'awaiting', runId: null, createdAt, appliedAt: null, revertedAt: null, purgedAt: null } });
    return id;
  }

  async get(tenantId: string, id: string): Promise<StoredSiteEdit | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? structuredClone(r.e) : null;
  }

  async list(tenantId: string, limit: number): Promise<StoredSiteEdit[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).map((r) => structuredClone(r.e))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async update(tenantId: string, id: string, patch: Partial<Pick<StoredSiteEdit, 'status' | 'runId' | 'pages' | 'terms' | 'actions' | 'appliedAt' | 'revertedAt'>>): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    r.e = { ...r.e, ...structuredClone(patch) };
  }

  async purge(tenantId: string, before: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.tenantId !== tenantId || r.e.purgedAt || r.e.createdAt >= before) continue;
      r.e = { ...r.e, pages: r.e.pages.map(purgedPage), terms: r.e.terms.map(purgedTerm), actions: r.e.actions.map(purgedAction), purgedAt: new Date().toISOString() };
      n++;
    }
    return n;
  }

  private readonly seen = new Map<string, number>();

  async commentSeen(tenantId: string): Promise<number | null> {
    return this.seen.get(tenantId) ?? null;
  }

  async markCommentSeen(tenantId: string, lastId: number): Promise<void> {
    this.seen.set(tenantId, Math.max(this.seen.get(tenantId) ?? 0, lastId));
  }

  private readonly health = new Map<string, { digest: string; checkedAt: string | null }>();

  async healthSeen(tenantId: string): Promise<{ digest: string; checkedAt: string | null }> {
    return this.health.get(tenantId) ?? { digest: '', checkedAt: null };
  }

  async markHealth(tenantId: string, digest: string, at: string): Promise<void> {
    this.health.set(tenantId, { digest, checkedAt: at });
  }

  /** テスト用: 作った時刻を変える。 */
  setCreatedAt(id: string, at: string): void {
    const r = this.rows.get(id);
    if (r) r.e.createdAt = at;
  }
}

/** 本人の WordPress の接続（第45.16節）。 */
export interface StoredWordPressUser {
  userId: string;
  /** つないだときの会社のサイトの URL（会社のサイトが変われば使わない）。 */
  siteUrl: string;
  username: string;
  secretEnc: string;
  displayName: string;
  roles: string[];
  connectedAt: string;
}

/** 本人の WordPress の接続の置き場。 */
export interface WordPressUserStore {
  get(tenantId: string, userId: string): Promise<StoredWordPressUser | null>;
  save(tenantId: string, v: StoredWordPressUser): Promise<void>;
  /** @returns 消したか */
  remove(tenantId: string, userId: string): Promise<boolean>;
  /** 会社の全員の分（管理者が見る一覧と、会社の接続を外したときに消すため）。 */
  list(tenantId: string): Promise<StoredWordPressUser[]>;
  /** @returns 消した件数 */
  removeAll(tenantId: string): Promise<number>;
}

interface UserRow extends pg.QueryResultRow {
  user_id: string; site_url: string; username: string; secret_enc: string; display_name: string; roles: string[] | string; connected_at: Date | string;
}

/** 文字で返った text[]（`{a,b}`）を配列にする。 */
function pgTextArray(v: string): string[] {
  const inner = v.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
}

const toUser = (r: UserRow): StoredWordPressUser => ({
  userId: r.user_id, siteUrl: r.site_url, username: r.username, secretEnc: r.secret_enc, displayName: r.display_name,
  roles: Array.isArray(r.roles) ? r.roles : pgTextArray(r.roles), connectedAt: iso(r.connected_at)!,
});

/** PostgreSQL の本人の WordPress の接続の置き場。 */
export class PostgresWordPressUserStore implements WordPressUserStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'wordpress-users' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const rows = (await client.query<T>(text, params as never[])).rows;
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async get(tenantId: string, userId: string): Promise<StoredWordPressUser | null> {
    const rows = await this.q<UserRow>(tenantId, `select user_id, site_url, username, secret_enc, display_name, roles, connected_at from user_wordpress_connections where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async save(tenantId: string, v: StoredWordPressUser): Promise<void> {
    await this.q(tenantId, `insert into user_wordpress_connections (tenant_id, user_id, site_url, username, secret_enc, display_name, roles, connected_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (tenant_id, user_id) do update set site_url = excluded.site_url, username = excluded.username, secret_enc = excluded.secret_enc,
        display_name = excluded.display_name, roles = excluded.roles, connected_at = excluded.connected_at`,
    [tenantId, v.userId, v.siteUrl, v.username, v.secretEnc, v.displayName, v.roles, v.connectedAt]);
  }

  async remove(tenantId: string, userId: string): Promise<boolean> {
    return (await this.q(tenantId, `delete from user_wordpress_connections where tenant_id = $1 and user_id = $2 returning user_id`, [tenantId, userId])).length > 0;
  }

  async list(tenantId: string): Promise<StoredWordPressUser[]> {
    return (await this.q<UserRow>(tenantId, `select user_id, site_url, username, secret_enc, display_name, roles, connected_at from user_wordpress_connections where tenant_id = $1 order by connected_at`, [tenantId])).map(toUser);
  }

  async removeAll(tenantId: string): Promise<number> {
    return (await this.q(tenantId, `delete from user_wordpress_connections where tenant_id = $1 returning user_id`, [tenantId])).length;
  }
}

/** 手元の本人の WordPress の接続の置き場（テストと見本の会社）。 */
export class MemoryWordPressUserStore implements WordPressUserStore {
  private readonly rows = new Map<string, StoredWordPressUser>();
  private k = (t: string, u: string) => `${t}\u0000${u}`;

  async get(tenantId: string, userId: string): Promise<StoredWordPressUser | null> {
    const v = this.rows.get(this.k(tenantId, userId));
    return v ? { ...v, roles: [...v.roles] } : null;
  }

  async save(tenantId: string, v: StoredWordPressUser): Promise<void> {
    this.rows.set(this.k(tenantId, v.userId), { ...v, roles: [...v.roles] });
  }

  async remove(tenantId: string, userId: string): Promise<boolean> {
    return this.rows.delete(this.k(tenantId, userId));
  }

  async list(tenantId: string): Promise<StoredWordPressUser[]> {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${tenantId}\u0000`)).map(([, v]) => ({ ...v, roles: [...v.roles] }));
  }

  async removeAll(tenantId: string): Promise<number> {
    let n = 0;
    for (const key of [...this.rows.keys()]) if (key.startsWith(`${tenantId}\u0000`)) { this.rows.delete(key); n++; }
    return n;
  }
}
