/**
 * @file Web のコラムの置き場（仕様書 第32.17節・第32.18.1節、移行 062）。PostgreSQL と、自動テスト用のメモリの 2 つ。
 *
 * コラムは会社で共有する。版は直すたびに足し、前の版を消さない。会社の境界はデータベースの行単位の制限でも効く。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  ColumnPhoto, ColumnReviewItem, ColumnSource, ColumnThemeSource, ColumnThemeStatus, WebColumn, WebColumnCover, WebColumnStatus, WebColumnTheme, WebColumnVersion,
} from '@m2office/shared';

/** 足す版（番号は置き場が決める）。 */
export type NewColumnVersion = Omit<WebColumnVersion, 'version' | 'createdAt' | 'createdByName'>;

/** コラムの置き場。 */
export interface ColumnStore {
  list(tenantId: string, limit?: number): Promise<WebColumn[]>;
  get(tenantId: string, id: string): Promise<WebColumn | null>;
  create(tenantId: string, c: { theme: string; memo: string; createdBy: string }): Promise<string>;
  update(tenantId: string, id: string, patch: Partial<{
    status: WebColumnStatus; submittedVersion: number | null; submittedDigest: string | null; runId: string | null;
    wpPostId: string | null; wpEditUrl: string | null; failure: string | null; webUrl: string | null;
    plannedFor: string | null; publishAt: string | null;
  }>): Promise<void>;
  /** 予約で、公開の日時を過ぎたもの（ワーカーが入れる。第32.18.4節） */
  dueScheduled(tenantId: string, nowIso: string): Promise<string[]>;
  /** テーマ案（新しい順）。状態を渡せばその状態だけ */
  themes(tenantId: string, statuses?: ColumnThemeStatus[], limit?: number): Promise<WebColumnTheme[]>;
  addTheme(tenantId: string, t: { theme: string; why: string; source: ColumnThemeSource; columnId: string | null }): Promise<string>;
  setThemeStatus(tenantId: string, id: string, status: ColumnThemeStatus): Promise<void>;
  /** 貼るだけのページの鍵から会社を引く（ログインの無い人が読む）。無ければ `null` */
  tenantByPageKey(key: string): Promise<string | null>;
  /** WordPress に入れたコラム（記事の ID と、公開された URL。Web の分析が読む。第34.19節） */
  placed(tenantId: string): Promise<{ id: string; title: string; wpPostId: string | null; webUrl: string | null }[]>;
  /** 承認へ進めた版の指紋（承認の後に版が変わっていないかを確かめる）。 */
  submittedDigest(tenantId: string, id: string): Promise<string | null>;
  delete(tenantId: string, id: string): Promise<void>;
  /** 版を足し、今の版にする。足した版の番号を返す。 */
  addVersion(tenantId: string, columnId: string, v: NewColumnVersion): Promise<number>;
  versions(tenantId: string, columnId: string): Promise<WebColumnVersion[]>;
  /** 決まった時間より前から「書いています」のままのもの（書き上げの途中で止まった）。 */
  stuckWriting(tenantId: string, beforeIso: string): Promise<string[]>;
  /** この日時より後に作った版の、AI の挿絵を描いた枚数の合計（月の上限。第32.18.2節）。 */
  aiAttemptsSince(tenantId: string, sinceIso: string): Promise<number>;
  /** 最近の版の型の模様（新しい順。直前と同じ模様を続けないため）。 */
  recentPatterns(tenantId: string, limit: number): Promise<string[]>;
  /** 会社の写真の置き場に足す。 */
  addPhoto(tenantId: string, p: { fileId: string; description: string; hasPeople: boolean; createdBy: string }): Promise<ColumnPhoto>;
  /** 会社の写真（新しい順）。 */
  photos(tenantId: string, limit?: number): Promise<ColumnPhoto[]>;
}

interface ColumnRow {
  id: string; theme: string; memo: string; status: WebColumnStatus; current_version: number; submitted_version: number | null;
  run_id: string | null; wp_edit_url: string | null; failure: string | null; created_by: string; created_at: Date | string; updated_at: Date | string;
  title: string | null; review: ColumnReviewItem[] | null; planned_for: string | null; publish_at: Date | string | null;
}

interface PhotoRow { id: string; file_id: string; description: string; has_people: boolean; created_at: Date | string }

const COLUMN_SELECT = `select c.id, c.theme, c.memo, c.status, c.current_version, c.submitted_version, c.run_id, c.wp_edit_url, c.failure,
    c.created_by, c.created_at, c.updated_at, v.title, v.review, c.planned_for::text as planned_for, c.publish_at
  from web_columns c left join web_column_versions v on v.tenant_id = c.tenant_id and v.column_id = c.id and v.version = c.current_version`;

/** 日時を ISO の文字にする（つなぎの設定で Date でも文字でも返るため）。 */
const iso = (v: Date | string) => new Date(v).toISOString();

function toColumn(r: ColumnRow): WebColumn {
  return {
    id: r.id, theme: r.theme, memo: r.memo, status: r.status, currentVersion: r.current_version, title: r.title ?? '',
    reviewCount: (r.review ?? []).length, submittedVersion: r.submitted_version, runId: r.run_id, wpEditUrl: r.wp_edit_url,
    failure: r.failure, plannedFor: r.planned_for, publishAt: r.publish_at ? iso(r.publish_at) : null,
    createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

interface ThemeRow { id: string; theme: string; why: string; source: ColumnThemeSource; column_id: string | null; status: ColumnThemeStatus; created_at: Date | string }

const toTheme = (r: ThemeRow): WebColumnTheme => ({ id: r.id, theme: r.theme, why: r.why, source: r.source, columnId: r.column_id, status: r.status, createdAt: iso(r.created_at) });

interface VersionRow {
  version: number; title: string; titles: string[]; body: string; description: string; sns: { short?: string; long?: string };
  sources: ColumnSource[]; review: ColumnReviewItem[]; cover: WebColumnCover | null; origin: WebColumnVersion['origin']; created_by: string; created_at: Date | string;
}

function toVersion(r: VersionRow): WebColumnVersion {
  return {
    version: r.version, title: r.title, titles: r.titles ?? [], body: r.body, description: r.description,
    sns: { short: r.sns?.short ?? '', long: r.sns?.long ?? '' }, sources: r.sources ?? [], review: r.review ?? [], cover: r.cover ?? null,
    origin: r.origin, createdBy: r.created_by, createdAt: iso(r.created_at),
  };
}

/** PostgreSQL のコラムの置き場。問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する。 */
export class PostgresColumnStore implements ColumnStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

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

  async list(tenantId: string, limit = 200): Promise<WebColumn[]> {
    return (await this.q<ColumnRow>(tenantId, `${COLUMN_SELECT} where c.tenant_id = $1 order by c.updated_at desc limit $2`, [tenantId, limit])).map(toColumn);
  }

  async get(tenantId: string, id: string): Promise<WebColumn | null> {
    const rows = await this.q<ColumnRow>(tenantId, `${COLUMN_SELECT} where c.tenant_id = $1 and c.id = $2`, [tenantId, id]);
    return rows[0] ? toColumn(rows[0]) : null;
  }

  async create(tenantId: string, c: { theme: string; memo: string; createdBy: string }): Promise<string> {
    const id = `col-${randomUUID()}`;
    await this.q(tenantId, `insert into web_columns (id, tenant_id, theme, memo, created_by) values ($1, $2, $3, $4, $5)`,
      [id, tenantId, c.theme, c.memo, c.createdBy]);
    return id;
  }

  async update(tenantId: string, id: string, patch: Parameters<ColumnStore['update']>[2]): Promise<void> {
    const cols: Record<string, string> = {
      status: 'status', submittedVersion: 'submitted_version', submittedDigest: 'submitted_digest', runId: 'run_id',
      wpPostId: 'wp_post_id', wpEditUrl: 'wp_edit_url', failure: 'failure', webUrl: 'web_url', plannedFor: 'planned_for', publishAt: 'publish_at',
    };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.q(tenantId, `update web_columns set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async dueScheduled(tenantId: string, nowIso: string): Promise<string[]> {
    return (await this.q<{ id: string }>(tenantId, `select id from web_columns where tenant_id = $1 and status = 'scheduled' and publish_at <= $2 order by publish_at`, [tenantId, nowIso])).map((r) => r.id);
  }

  async themes(tenantId: string, statuses?: ColumnThemeStatus[], limit = 50): Promise<WebColumnTheme[]> {
    return (await this.q<ThemeRow>(tenantId, `select id, theme, why, source, column_id, status, created_at from web_column_themes
      where tenant_id = $1 and ($2::text[] is null or status = any($2)) order by created_at desc limit $3`, [tenantId, statuses ?? null, limit])).map(toTheme);
  }

  async addTheme(tenantId: string, t: { theme: string; why: string; source: ColumnThemeSource; columnId: string | null }): Promise<string> {
    const id = `cth-${randomUUID()}`;
    await this.q(tenantId, `insert into web_column_themes (id, tenant_id, theme, why, source, column_id) values ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, t.theme, t.why, t.source, t.columnId]);
    return id;
  }

  async setThemeStatus(tenantId: string, id: string, status: ColumnThemeStatus): Promise<void> {
    await this.q(tenantId, `update web_column_themes set status = $3, updated_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, status]);
  }

  async tenantByPageKey(key: string): Promise<string | null> {
    const rows = await this.q<{ t: string | null }>('', 'select m2o_column_page($1) as t', [key]);
    return rows[0]?.t ?? null;
  }

  async placed(tenantId: string): Promise<{ id: string; title: string; wpPostId: string | null; webUrl: string | null }[]> {
    const rows = await this.q<{ id: string; title: string | null; wp_post_id: string | null; web_url: string | null }>(tenantId,
      `select c.id, v.title, c.wp_post_id, c.web_url from web_columns c
         left join web_column_versions v on v.tenant_id = c.tenant_id and v.column_id = c.id and v.version = coalesce(c.submitted_version, c.current_version)
        where c.tenant_id = $1 and c.wp_post_id is not null order by c.updated_at desc limit 200`, [tenantId]);
    return rows.map((r) => ({ id: r.id, title: r.title ?? '', wpPostId: r.wp_post_id, webUrl: r.web_url }));
  }

  async submittedDigest(tenantId: string, id: string): Promise<string | null> {
    const rows = await this.q<{ submitted_digest: string | null }>(tenantId, 'select submitted_digest from web_columns where tenant_id = $1 and id = $2', [tenantId, id]);
    return rows[0]?.submitted_digest ?? null;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from web_columns where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  async addVersion(tenantId: string, columnId: string, v: NewColumnVersion): Promise<number> {
    return this.tx(tenantId, async (c) => {
      const { rows } = await c.query<{ n: number }>(
        'update web_columns set current_version = current_version + 1, updated_at = now() where tenant_id = $1 and id = $2 returning current_version as n',
        [tenantId, columnId]);
      const n = rows[0]?.n;
      if (!n) throw new Error('コラムが見つかりません');
      await c.query(`insert into web_column_versions (tenant_id, column_id, version, title, titles, body, description, sns, sources, review, cover, origin, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [tenantId, columnId, n, v.title, JSON.stringify(v.titles), v.body, v.description, JSON.stringify(v.sns), JSON.stringify(v.sources),
        JSON.stringify(v.review), v.cover ? JSON.stringify(v.cover) : null, v.origin, v.createdBy]);
      return n;
    });
  }

  async versions(tenantId: string, columnId: string): Promise<WebColumnVersion[]> {
    return (await this.q<VersionRow>(tenantId, `select version, title, titles, body, description, sns, sources, review, cover, origin, created_by, created_at
      from web_column_versions where tenant_id = $1 and column_id = $2 order by version desc`, [tenantId, columnId])).map(toVersion);
  }

  async stuckWriting(tenantId: string, beforeIso: string): Promise<string[]> {
    return (await this.q<{ id: string }>(tenantId, `select id from web_columns where tenant_id = $1 and status = 'writing' and updated_at < $2`, [tenantId, beforeIso])).map((r) => r.id);
  }

  async aiAttemptsSince(tenantId: string, sinceIso: string): Promise<number> {
    const rows = await this.q<{ n: string | null }>(tenantId,
      `select sum(coalesce((cover->>'aiAttempts')::int, 0)) as n from web_column_versions where tenant_id = $1 and created_at >= $2 and cover is not null`, [tenantId, sinceIso]);
    return Number(rows[0]?.n ?? 0);
  }

  async recentPatterns(tenantId: string, limit: number): Promise<string[]> {
    return (await this.q<{ p: string }>(tenantId,
      `select cover->>'pattern' as p from web_column_versions where tenant_id = $1 and cover->>'pattern' is not null order by created_at desc limit $2`, [tenantId, limit])).map((r) => r.p);
  }

  async addPhoto(tenantId: string, p: { fileId: string; description: string; hasPeople: boolean; createdBy: string }): Promise<ColumnPhoto> {
    const id = `cp-${randomUUID()}`;
    const rows = await this.q<PhotoRow>(tenantId, `insert into web_column_photos (id, tenant_id, file_id, description, has_people, created_by)
      values ($1, $2, $3, $4, $5, $6) returning id, file_id, description, has_people, created_at`, [id, tenantId, p.fileId, p.description, p.hasPeople, p.createdBy]);
    return toPhoto(rows[0]!);
  }

  async photos(tenantId: string, limit = 200): Promise<ColumnPhoto[]> {
    return (await this.q<PhotoRow>(tenantId,
      'select id, file_id, description, has_people, created_at from web_column_photos where tenant_id = $1 order by created_at desc limit $2', [tenantId, limit])).map(toPhoto);
  }
}

function toPhoto(r: PhotoRow): ColumnPhoto {
  return { id: r.id, fileId: r.file_id, description: r.description, hasPeople: r.has_people, createdAt: iso(r.created_at) };
}

// ---- メモリ（自動テスト用） ----------------------------------------------

/** メモリのコラムの置き場。自動テストに使う。 */
export class MemoryColumnStore implements ColumnStore {
  readonly columns = new Map<string, WebColumn & { tenantId: string; submittedDigest: string | null; wpPostId: string | null }>();
  readonly allVersions = new Map<string, WebColumnVersion[]>();
  readonly allPhotos: (ColumnPhoto & { tenantId: string })[] = [];

  private col(tenantId: string, id: string) {
    const c = this.columns.get(id);
    return c && c.tenantId === tenantId ? c : null;
  }

  private view(c: WebColumn & { tenantId: string }): WebColumn {
    const v = (this.allVersions.get(c.id) ?? []).find((x) => x.version === c.currentVersion);
    const { tenantId: _t, submittedDigest: _d, wpPostId: _w, ...rest } = c as WebColumn & { tenantId: string; submittedDigest: string | null; wpPostId: string | null };
    return { ...rest, title: v?.title ?? '', reviewCount: v?.review.length ?? 0 };
  }

  async list(tenantId: string): Promise<WebColumn[]> {
    return [...this.columns.values()].filter((c) => c.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => this.view(c));
  }

  async get(tenantId: string, id: string): Promise<WebColumn | null> {
    const c = this.col(tenantId, id);
    return c ? this.view(c) : null;
  }

  async create(tenantId: string, c: { theme: string; memo: string; createdBy: string }): Promise<string> {
    const id = `col-${randomUUID()}`;
    const at = new Date().toISOString();
    this.columns.set(id, {
      id, tenantId, theme: c.theme, memo: c.memo, status: 'writing', currentVersion: 0, title: '', reviewCount: 0, submittedVersion: null,
      runId: null, wpEditUrl: null, failure: null, createdBy: c.createdBy, createdAt: at, updatedAt: at, submittedDigest: null, wpPostId: null,
    });
    return id;
  }

  async update(tenantId: string, id: string, patch: Parameters<ColumnStore['update']>[2]): Promise<void> {
    const c = this.col(tenantId, id);
    if (!c) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (c as unknown as Record<string, unknown>)[k] = v;
    c.updatedAt = new Date().toISOString();
  }

  readonly allThemes: (WebColumnTheme & { tenantId: string })[] = [];
  /** 貼るだけのページの鍵と会社（自動テスト用） */
  readonly pageKeys = new Map<string, string>();

  async dueScheduled(tenantId: string, nowIso: string): Promise<string[]> {
    return [...this.columns.values()].filter((c) => c.tenantId === tenantId && c.status === 'scheduled' && c.publishAt && c.publishAt <= nowIso).map((c) => c.id);
  }

  async themes(tenantId: string, statuses?: ColumnThemeStatus[], limit = 50): Promise<WebColumnTheme[]> {
    return this.allThemes.filter((t) => t.tenantId === tenantId && (!statuses || statuses.includes(t.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(({ tenantId: _t, ...t }) => ({ ...t }));
  }

  async addTheme(tenantId: string, t: { theme: string; why: string; source: ColumnThemeSource; columnId: string | null }): Promise<string> {
    const id = `cth-${randomUUID()}`;
    this.allThemes.push({ ...t, id, tenantId, status: 'new', createdAt: new Date(Date.now() + this.allThemes.length).toISOString() });
    return id;
  }

  async setThemeStatus(tenantId: string, id: string, status: ColumnThemeStatus): Promise<void> {
    const t = this.allThemes.find((x) => x.id === id && x.tenantId === tenantId);
    if (t) t.status = status;
  }

  async tenantByPageKey(key: string): Promise<string | null> {
    return this.pageKeys.get(key) ?? null;
  }

  async placed(tenantId: string): Promise<{ id: string; title: string; wpPostId: string | null; webUrl: string | null }[]> {
    return [...this.columns.values()].filter((c) => c.tenantId === tenantId && c.wpPostId)
      .map((c) => ({ id: c.id, title: c.title, wpPostId: c.wpPostId, webUrl: (c as { webUrl?: string | null }).webUrl ?? null }));
  }

  async submittedDigest(tenantId: string, id: string): Promise<string | null> {
    return this.col(tenantId, id)?.submittedDigest ?? null;
  }

  async delete(tenantId: string, id: string): Promise<void> {
    if (this.col(tenantId, id)) { this.columns.delete(id); this.allVersions.delete(id); }
  }

  async addVersion(tenantId: string, columnId: string, v: NewColumnVersion): Promise<number> {
    const c = this.col(tenantId, columnId);
    if (!c) throw new Error('コラムが見つかりません');
    c.currentVersion += 1;
    c.updatedAt = new Date().toISOString();
    this.allVersions.set(columnId, [{ ...v, version: c.currentVersion, createdAt: c.updatedAt }, ...(this.allVersions.get(columnId) ?? [])]);
    return c.currentVersion;
  }

  async versions(tenantId: string, columnId: string): Promise<WebColumnVersion[]> {
    return this.col(tenantId, columnId) ? [...(this.allVersions.get(columnId) ?? [])] : [];
  }

  async stuckWriting(tenantId: string, beforeIso: string): Promise<string[]> {
    return [...this.columns.values()].filter((c) => c.tenantId === tenantId && c.status === 'writing' && c.updatedAt < beforeIso).map((c) => c.id);
  }

  private tenantVersions(tenantId: string): WebColumnVersion[] {
    return [...this.columns.values()].filter((c) => c.tenantId === tenantId).flatMap((c) => this.allVersions.get(c.id) ?? [])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async aiAttemptsSince(tenantId: string, sinceIso: string): Promise<number> {
    return this.tenantVersions(tenantId).filter((v) => v.createdAt >= sinceIso).reduce((n, v) => n + (v.cover?.aiAttempts ?? 0), 0);
  }

  async recentPatterns(tenantId: string, limit: number): Promise<string[]> {
    return this.tenantVersions(tenantId).flatMap((v) => (v.cover?.pattern ? [v.cover.pattern] : [])).slice(0, limit);
  }

  async addPhoto(tenantId: string, p: { fileId: string; description: string; hasPeople: boolean; createdBy: string }): Promise<ColumnPhoto> {
    const photo = { id: `cp-${randomUUID()}`, fileId: p.fileId, description: p.description, hasPeople: p.hasPeople, createdAt: new Date().toISOString() };
    this.allPhotos.unshift({ ...photo, tenantId });
    return photo;
  }

  async photos(tenantId: string): Promise<ColumnPhoto[]> {
    return this.allPhotos.filter((x) => x.tenantId === tenantId).map(({ tenantId: _t, ...rest }) => rest);
  }
}
