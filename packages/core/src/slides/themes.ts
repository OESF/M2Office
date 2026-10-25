/**
 * @file Google スライドのテーマと文書のテンプレートを覚える（本人の「マイテーマ」「マイテンプレート」と、管理者が登録する会社のもの）
 * （仕様書 第9.4.2節「Google スライドのテーマを使う・PowerPoint の取り出し」、第9.5.5.2節「文書のテンプレート」、Q-265・Q-267、ADR-0109・ADR-0110）。
 *
 * 本人が Google のファイルを選ぶ画面で選んだプレゼンテーションの ID・名前・見本の縮小の絵を持つ。会社ごとに分ける（不変則 I-2）。
 * 権限は `drive.file` のままなので、会社のテーマは使う人が初めの 1 回だけ選ぶ画面で選ぶ（`access` で確かめる）。
 */

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { SLIDE_THEME_PREFIX, type SlideDeckKind, type SlideThemeSummary } from '@m2office/shared';
import type { WorkspaceConnector } from '../connectors/types.js';
import { createPool } from '../repository/pool.js';

/** テーマ 1 件（置き場の形）。 */
export interface SlideTheme {
  id: string;
  /** スライドのテーマか、文書のテンプレートか。 */
  kind: SlideDeckKind;
  tenantId: string;
  /** 登録した人。`null` なら会社のテーマ。 */
  userId: string | null;
  presentationId: string;
  name: string;
  thumbnail: Uint8Array | null;
  thumbnailMime: string | null;
  createdAt: string;
}

/** テーマの置き場。 */
export interface SlideThemeStore {
  save(t: SlideTheme): Promise<void>;
  get(tenantId: string, id: string): Promise<SlideTheme | null>;
  /** 本人のものと会社のもの（新しい順。縮小の絵の中身は載せない）。 */
  list(tenantId: string, userId: string, kind?: SlideDeckKind): Promise<SlideTheme[]>;
  remove(tenantId: string, id: string): Promise<void>;
}

/** 1 人（と会社）で持てるテーマの数。 */
export const SLIDE_THEMES_MAX = 20;

type Row = Omit<SlideTheme, 'createdAt' | 'thumbnail'> & { createdAt: Date | string; thumbnail: Buffer | null };
const fromRow = (r: Row): SlideTheme => ({
  ...r, thumbnail: r.thumbnail ? new Uint8Array(r.thumbnail) : null, createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
});
const COLUMNS = `id, kind, tenant_id as "tenantId", user_id as "userId", presentation_id as "presentationId", name, thumbnail_mime as "thumbnailMime", created_at as "createdAt"`;

/** テーマの置き場（PostgreSQL。移行 160）。 */
export class PostgresSlideThemeStore implements SlideThemeStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'slide-themes' });
  }

  private async q<T>(tenantId: string, sql: string, params: unknown[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await client.query(sql, params);
      await client.query('commit');
      return out.rows as T[];
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async save(t: SlideTheme): Promise<void> {
    await this.q(t.tenantId,
      `insert into slide_themes (id, tenant_id, user_id, presentation_id, name, thumbnail, thumbnail_mime, created_at, kind) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set name = excluded.name, thumbnail = excluded.thumbnail, thumbnail_mime = excluded.thumbnail_mime
       where slide_themes.tenant_id = excluded.tenant_id`,
      [t.id, t.tenantId, t.userId, t.presentationId, t.name, t.thumbnail ? Buffer.from(t.thumbnail) : null, t.thumbnailMime, t.createdAt, t.kind]);
  }

  async get(tenantId: string, id: string): Promise<SlideTheme | null> {
    const rows = await this.q<Row>(tenantId, `select ${COLUMNS}, thumbnail from slide_themes where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list(tenantId: string, userId: string, kind: SlideDeckKind = 'slides'): Promise<SlideTheme[]> {
    return (await this.q<Row>(tenantId,
      `select ${COLUMNS}, null::bytea as thumbnail, (thumbnail is not null) as "hasThumb" from slide_themes
        where tenant_id = $1 and (user_id = $2 or user_id is null) and kind = $4 order by created_at desc limit $3`,
      [tenantId, userId, SLIDE_THEMES_MAX * 2, kind])).map((r) => ({ ...fromRow(r), thumbnail: (r as Row & { hasThumb: boolean }).hasThumb ? new Uint8Array() : null }));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, 'delete from slide_themes where tenant_id = $1 and id = $2', [tenantId, id]);
  }

  /** 終わるときに呼ぶ。 */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** テーマの置き場（記憶。テストと見本）。 */
export class InMemorySlideThemeStore implements SlideThemeStore {
  readonly themes = new Map<string, SlideTheme>();

  async save(t: SlideTheme): Promise<void> {
    const had = this.themes.get(t.id);
    if (had && had.tenantId !== t.tenantId) return;
    this.themes.set(t.id, { ...t });
  }

  async get(tenantId: string, id: string): Promise<SlideTheme | null> {
    const t = this.themes.get(id);
    return t && t.tenantId === tenantId ? { ...t } : null;
  }

  async list(tenantId: string, userId: string, kind: SlideDeckKind = 'slides'): Promise<SlideTheme[]> {
    return [...this.themes.values()].filter((t) => t.tenantId === tenantId && (t.userId === userId || t.userId === null) && t.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((t) => ({ ...t }));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    if (this.themes.get(id)?.tenantId === tenantId) this.themes.delete(id);
  }
}

/** 見ている人（会社・利用者・管理者か）。 */
export interface SlideThemeViewer {
  tenantId: string;
  userId: string;
  admin?: boolean;
}

/**
 * Google スライドのテーマの一覧・追加・削除・見本の絵・使えるかの確かめ（仕様書 第9.4.2節「Google スライドのテーマを使う」）。
 */
export class SlideThemeService {
  constructor(private readonly deps: { store: SlideThemeStore; connector: WorkspaceConnector }) {}

  private summary(t: SlideTheme, viewer: SlideThemeViewer): SlideThemeSummary {
    return {
      id: t.id, kind: t.kind, name: t.name, company: t.userId === null,
      removable: t.userId === null ? !!viewer.admin : t.userId === viewer.userId, thumbnail: t.thumbnail !== null,
    };
  }

  /** 本人のものと会社のもの（新しい順）。`kind` はスライドのテーマ（既定）か文書のテンプレート。 */
  async list(viewer: SlideThemeViewer, kind: SlideDeckKind = 'slides'): Promise<SlideThemeSummary[]> {
    return (await this.deps.store.list(viewer.tenantId, viewer.userId, kind)).map((t) => this.summary(t, viewer));
  }

  /**
   * 見ている人が使えるテーマを、ID（`theme:<ID>` でもよい）か名前で引く。本人のものと会社のものだけ。
   *
   * @returns 無ければ `null`
   */
  async find(viewer: SlideThemeViewer, idOrName: string, kind: SlideDeckKind = 'slides'): Promise<SlideTheme | null> {
    const key = idOrName.trim();
    if (!key) return null;
    const id = key.startsWith(SLIDE_THEME_PREFIX) ? key.slice(SLIDE_THEME_PREFIX.length) : key;
    const byId = await this.deps.store.get(viewer.tenantId, id);
    if (byId && byId.kind === kind && (byId.userId === null || byId.userId === viewer.userId)) return byId;
    const all = await this.deps.store.list(viewer.tenantId, viewer.userId, kind);
    const named = all.find((t) => t.name === key);
    return named ? this.deps.store.get(viewer.tenantId, named.id) : null;
  }

  /**
   * 本人が選んだプレゼンテーションをテーマにする。会社のテーマは管理者だけ。
   *
   * @returns 加えたもの、またはできない理由
   */
  async add(viewer: SlideThemeViewer, input: { fileId: unknown; company?: unknown; kind?: unknown }): Promise<SlideThemeSummary | { error: string }> {
    const kind: SlideDeckKind = input.kind === 'doc' ? 'doc' : 'slides';
    const what = kind === 'doc' ? 'テンプレート' : 'テーマ';
    const fileId = typeof input.fileId === 'string' ? input.fileId.trim() : '';
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return { error: kind === 'doc' ? 'ドキュメントを選んでください' : 'プレゼンテーションを選んでください' };
    const company = input.company === true;
    if (company && !viewer.admin) return { error: `会社の${what}を登録できるのは管理者だけです` };
    const existing = (await this.deps.store.list(viewer.tenantId, viewer.userId, kind)).filter((t) => (company ? t.userId === null : t.userId === viewer.userId));
    if (existing.length >= SLIDE_THEMES_MAX) return { error: `${what}は ${SLIDE_THEMES_MAX} 個までです。使わないものを削除してください` };
    const same = existing.find((t) => t.presentationId === fileId);
    if (same) return this.summary(same, viewer);
    const got = kind === 'doc'
      ? await this.deps.connector.docs.inspectTemplate(viewer, fileId)
      : await this.deps.connector.slides.inspectTheme(viewer, fileId);
    if (!got) return { error: kind === 'doc' ? '選んだファイルを Google ドキュメントとして開けませんでした' : '選んだファイルを Google スライドとして開けませんでした' };
    const t: SlideTheme = {
      id: randomUUID(), kind, tenantId: viewer.tenantId, userId: company ? null : viewer.userId, presentationId: fileId, name: got.name.slice(0, 60),
      thumbnail: got.thumbnail?.bytes ?? null, thumbnailMime: got.thumbnail?.mimeType ?? null, createdAt: new Date().toISOString(),
    };
    await this.deps.store.save(t);
    return this.summary(t, viewer);
  }

  /** 削除する（自分のテーマ。会社のテーマは管理者）。ファイルそのものには触らない。 */
  async remove(viewer: SlideThemeViewer, id: string): Promise<string | null> {
    const t = await this.deps.store.get(viewer.tenantId, id);
    if (!t || (t.userId !== null && t.userId !== viewer.userId)) return 'テーマが見つかりません';
    if (t.userId === null && !viewer.admin) return `会社の${t.kind === 'doc' ? 'テンプレート' : 'テーマ'}を削除できるのは管理者だけです`;
    await this.deps.store.remove(viewer.tenantId, id);
    return null;
  }

  /** ID で引く（種類を問わない。本人のものと会社のものだけ）。 */
  private async visible(viewer: SlideThemeViewer, id: string): Promise<SlideTheme | null> {
    const t = await this.deps.store.get(viewer.tenantId, id.startsWith(SLIDE_THEME_PREFIX) ? id.slice(SLIDE_THEME_PREFIX.length) : id);
    return t && (t.userId === null || t.userId === viewer.userId) ? t : null;
  }

  /** 見本の縮小の絵。 */
  async thumbnail(viewer: SlideThemeViewer, id: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const t = await this.visible(viewer, id);
    return t?.thumbnail && t.thumbnailMime ? { bytes: t.thumbnail, mimeType: t.thumbnailMime } : null;
  }

  /**
   * 本人がそのテーマのファイルを開けるか（会社のテーマは、使う人が選ぶ画面で一度選ぶまで開けない。`drive.file` の決まり）。
   *
   * @returns 開けるか、選ぶ画面で選んでもらうファイルの ID
   */
  async access(viewer: SlideThemeViewer, id: string): Promise<{ ok: true } | { ok: false; fileId: string } | null> {
    const t = await this.visible(viewer, id);
    if (!t) return null;
    if (this.deps.connector.sourceFor(viewer.tenantId) !== 'google') return { ok: true };
    const state = await this.deps.connector.slides.fileState(viewer, t.presentationId).catch(() => null);
    return state && !state.trashed ? { ok: true } : { ok: false, fileId: t.presentationId };
  }
}
