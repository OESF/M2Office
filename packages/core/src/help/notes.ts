/**
 * @file ヘルプの会社の補足（仕様書 第6.10.7節）。管理者が、ヘルプの記事（業務の説明 `agent-<業務の ID>` を含む）ごとに社内向けの補足を書く。
 *
 * 業務の説明・ヘルプセンターの記事・秘書の使い方の答えに添えて出す。**人が読む説明にとどめる**（業務の文面には入れない。自社の書き方（第15.2.1節）とは別物）。
 * 補足の文は会社の管理者が書いたものであり、秘書はそのまま添えるだけで、指示としては扱わない。
 */

import pg from 'pg';

/** 1 つの補足。 */
export interface HelpNote {
  articleId: string;
  text: string;
  updatedBy: string;
  updatedAt: string;
}

/** 補足の長さ。 */
export const HELP_NOTE_MAX = 1000;

/** 置き場。 */
export interface HelpNoteStore {
  get(tenantId: string, articleId: string): Promise<HelpNote | null>;
  list(tenantId: string): Promise<HelpNote[]>;
  /** 書く・直す。文が空なら消す。 */
  set(tenantId: string, articleId: string, text: string, by: string): Promise<void>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());

/** 補足の文を整える（前後の空白を除き、長さを切る）。 */
export const noteText = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\r\n/g, '\n').slice(0, HELP_NOTE_MAX) : '');

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresHelpNoteStore implements HelpNoteStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
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

  private static row(r: { article_id: string; text: string; updated_by: string; updated_at: unknown }): HelpNote {
    return { articleId: r.article_id, text: r.text, updatedBy: r.updated_by, updatedAt: iso(r.updated_at) };
  }

  async get(tenantId: string, articleId: string): Promise<HelpNote | null> {
    const rows = await this.q<{ article_id: string; text: string; updated_by: string; updated_at: unknown }>(tenantId,
      `select * from help_notes where tenant_id = $1 and article_id = $2`, [tenantId, articleId]);
    return rows[0] ? PostgresHelpNoteStore.row(rows[0]) : null;
  }

  async list(tenantId: string): Promise<HelpNote[]> {
    const rows = await this.q<{ article_id: string; text: string; updated_by: string; updated_at: unknown }>(tenantId,
      `select * from help_notes where tenant_id = $1 order by updated_at desc`, [tenantId]);
    return rows.map(PostgresHelpNoteStore.row);
  }

  async set(tenantId: string, articleId: string, text: string, by: string): Promise<void> {
    if (!text) {
      await this.q(tenantId, `delete from help_notes where tenant_id = $1 and article_id = $2`, [tenantId, articleId]);
      return;
    }
    await this.q(tenantId,
      `insert into help_notes (tenant_id, article_id, text, updated_by) values ($1, $2, $3, $4)
       on conflict (tenant_id, article_id) do update set text = excluded.text, updated_by = excluded.updated_by, updated_at = now()`,
      [tenantId, articleId, text, by]);
  }
}

/** テスト用のメモリの置き場。 */
export class MemoryHelpNoteStore implements HelpNoteStore {
  readonly rows = new Map<string, HelpNote & { tenantId: string }>();

  async get(tenantId: string, articleId: string): Promise<HelpNote | null> {
    const r = this.rows.get(`${tenantId}|${articleId}`);
    if (!r) return null;
    const { tenantId: _t, ...rest } = r;
    return rest;
  }

  async list(tenantId: string): Promise<HelpNote[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).map(({ tenantId: _t, ...r }) => r);
  }

  async set(tenantId: string, articleId: string, text: string, by: string): Promise<void> {
    if (!text) { this.rows.delete(`${tenantId}|${articleId}`); return; }
    this.rows.set(`${tenantId}|${articleId}`, { tenantId, articleId, text, updatedBy: by, updatedAt: new Date().toISOString() });
  }
}
