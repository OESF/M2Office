/**
 * @file ヘルプを育てる（仕様書 第6.10.10節）。秘書がヘルプに見当たらなかった使い方の質問と、記事が役に立ったかを置き、管理者に件数で示す。
 *
 * 見つからなかった質問には、質問した人を持たない（管理者に名前を出さないため）。質問の文は 200 字で切り、90 日で消す。
 * 役に立ったかは 1 人が 1 つの記事・出どころ（ヘルプセンターの記事か、秘書の答えか）に 1 つで、押し直せば置き換える。管理者には件数だけを示す。
 * テナントの外へは出さない（運営が改善に使うかは Q-69）。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';

/** 役に立ったかを付けた所。 */
export type HelpRatingSource = 'article' | 'secretary';

/** 見つからなかった質問（同じ質問はまとめる）。 */
export interface HelpMissSummary {
  question: string;
  count: number;
  lastAt: string;
}

/** 記事ごとの、役に立った・立たなかったの件数。 */
export interface HelpRatingSummary {
  articleId: string;
  helpful: number;
  notHelpful: number;
}

/** 決まり。 */
export const HELP_FEEDBACK_LIMITS = {
  /** 質問の文の長さ */
  questionMax: 200,
  /** 見つからなかった質問を残す日数 */
  missDays: 90,
  /** 管理者に示す質問の数 */
  missesShown: 50,
} as const;

/** 置き場。 */
export interface HelpFeedbackStore {
  addMiss(tenantId: string, question: string): Promise<void>;
  /** 日時より前の見つからなかった質問を消す。 */
  purgeMisses(tenantId: string, before: string): Promise<number>;
  misses(tenantId: string, since: string): Promise<{ id: string; question: string; createdAt: string }[]>;
  /** 見つからなかった質問を消す（補足を書いて片付いたもの）。 */
  removeMisses(tenantId: string, ids: string[]): Promise<void>;
  rate(tenantId: string, userId: string, articleId: string, source: HelpRatingSource, helpful: boolean): Promise<void>;
  ratings(tenantId: string): Promise<{ articleId: string; helpful: boolean }[]>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v ?? '')).toISOString());

/** 同じ質問とみなす形（全角と半角・空白・句読点と疑問符の違いを無くす）。 */
export const missKey = (q: string) => q.normalize('NFKC').replace(/[\s。、.,!！?？]+/g, '').toLowerCase();

/**
 * 見つからなかった質問を、同じものをまとめて多い順に（同じ数なら新しい順に）並べる（純粋な関数）。
 *
 * @param rows 質問と日時
 */
export function summarizeMisses(rows: { question: string; createdAt: string }[], limit: number = HELP_FEEDBACK_LIMITS.missesShown): HelpMissSummary[] {
  const by = new Map<string, HelpMissSummary>();
  for (const r of rows) {
    const k = missKey(r.question);
    if (!k) continue;
    const cur = by.get(k);
    if (!cur) by.set(k, { question: r.question, count: 1, lastAt: r.createdAt });
    else {
      cur.count += 1;
      if (r.createdAt > cur.lastAt) { cur.lastAt = r.createdAt; cur.question = r.question; }
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, limit);
}

/** 記事ごとの件数（純粋な関数）。役に立たなかったが多い順。 */
export function summarizeRatings(rows: { articleId: string; helpful: boolean }[]): HelpRatingSummary[] {
  const by = new Map<string, HelpRatingSummary>();
  for (const r of rows) {
    const cur = by.get(r.articleId) ?? { articleId: r.articleId, helpful: 0, notHelpful: 0 };
    if (r.helpful) cur.helpful += 1; else cur.notHelpful += 1;
    by.set(r.articleId, cur);
  }
  return [...by.values()].sort((a, b) => b.notHelpful - a.notHelpful || b.helpful - a.helpful || a.articleId.localeCompare(b.articleId));
}

/**
 * ヘルプを育てる操作。
 *
 * @remarks 危険度: 低（会社の中に件数と質問の文を残すだけ。質問した人は持たない）
 */
export class HelpFeedback {
  constructor(private readonly store: HelpFeedbackStore, private readonly now: () => Date = () => new Date()) {}

  /** 秘書がヘルプに見当たらなかった使い方の質問を残す（質問した人は持たない）。古いものは消す。 */
  async miss(tenantId: string, question: string): Promise<void> {
    const q = question.trim().replace(/\s+/g, ' ').slice(0, HELP_FEEDBACK_LIMITS.questionMax);
    if (!q) return;
    await this.store.addMiss(tenantId, q);
    await this.store.purgeMisses(tenantId, this.cutoff());
  }

  /** 役に立った・立たなかった（押し直せば置き換える）。 */
  async rate(tenantId: string, userId: string, articleId: string, source: HelpRatingSource, helpful: boolean): Promise<void> {
    await this.store.rate(tenantId, userId, articleId.slice(0, 120), source, helpful);
  }

  /**
   * 片付いた質問を消す（管理者が補足を書いたとき。言い方の小さな違いもまとめて消す）。
   *
   * @returns 消した数
   */
  async dismiss(tenantId: string, question: string): Promise<number> {
    const key = missKey(question);
    if (!key) return 0;
    const ids = (await this.store.misses(tenantId, this.cutoff())).filter((r) => missKey(r.question) === key).map((r) => r.id);
    if (ids.length) await this.store.removeMisses(tenantId, ids);
    return ids.length;
  }

  /** 管理者に示すもの（見つからなかった質問と、記事ごとの件数）。 */
  async summary(tenantId: string): Promise<{ misses: HelpMissSummary[]; ratings: HelpRatingSummary[]; missDays: number }> {
    await this.store.purgeMisses(tenantId, this.cutoff());
    return {
      misses: summarizeMisses(await this.store.misses(tenantId, this.cutoff())),
      ratings: summarizeRatings(await this.store.ratings(tenantId)),
      missDays: HELP_FEEDBACK_LIMITS.missDays,
    };
  }

  private cutoff(): string {
    return new Date(this.now().getTime() - HELP_FEEDBACK_LIMITS.missDays * 86_400_000).toISOString();
  }
}

/** PostgreSQL の置き場。会社ごとに `app.tenant_id` を入れて行単位の制限を効かせる。 */
export class PostgresHelpFeedbackStore implements HelpFeedbackStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'help/feedback' });
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

  async addMiss(tenantId: string, question: string): Promise<void> {
    await this.q(tenantId, `insert into help_misses (id, tenant_id, question) values ($1, $2, $3)`, [`hm-${randomUUID()}`, tenantId, question]);
  }

  async purgeMisses(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId, `delete from help_misses where tenant_id = $1 and created_at < $2 returning id`, [tenantId, before]);
    return rows.length;
  }

  async misses(tenantId: string, since: string): Promise<{ id: string; question: string; createdAt: string }[]> {
    const rows = await this.q<{ id: string; question: string; created_at: unknown }>(tenantId,
      `select id, question, created_at from help_misses where tenant_id = $1 and created_at >= $2 order by created_at desc limit 2000`, [tenantId, since]);
    return rows.map((r) => ({ id: r.id, question: r.question, createdAt: iso(r.created_at) }));
  }

  async removeMisses(tenantId: string, ids: string[]): Promise<void> {
    await this.q(tenantId, `delete from help_misses where tenant_id = $1 and id = any($2::text[])`, [tenantId, ids]);
  }

  async rate(tenantId: string, userId: string, articleId: string, source: HelpRatingSource, helpful: boolean): Promise<void> {
    await this.q(tenantId,
      `insert into help_ratings (tenant_id, user_id, article_id, source, helpful) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, user_id, article_id, source) do update set helpful = excluded.helpful, updated_at = now()`,
      [tenantId, userId, articleId, source, helpful]);
  }

  async ratings(tenantId: string): Promise<{ articleId: string; helpful: boolean }[]> {
    const rows = await this.q<{ article_id: string; helpful: boolean }>(tenantId, `select article_id, helpful from help_ratings where tenant_id = $1`, [tenantId]);
    return rows.map((r) => ({ articleId: r.article_id, helpful: r.helpful }));
  }
}

/** テスト用のメモリの置き場。 */
export class MemoryHelpFeedbackStore implements HelpFeedbackStore {
  readonly missRows: { id: string; tenantId: string; question: string; createdAt: string }[] = [];
  readonly ratingRows = new Map<string, { tenantId: string; articleId: string; helpful: boolean }>();
  now: () => Date = () => new Date();

  async addMiss(tenantId: string, question: string): Promise<void> {
    this.missRows.push({ id: `hm-${randomUUID()}`, tenantId, question, createdAt: this.now().toISOString() });
  }

  async purgeMisses(tenantId: string, before: string): Promise<number> {
    const keep = this.missRows.filter((r) => r.tenantId !== tenantId || r.createdAt >= before);
    const n = this.missRows.length - keep.length;
    this.missRows.splice(0, this.missRows.length, ...keep);
    return n;
  }

  async misses(tenantId: string, since: string): Promise<{ id: string; question: string; createdAt: string }[]> {
    return this.missRows.filter((r) => r.tenantId === tenantId && r.createdAt >= since).map(({ id, question, createdAt }) => ({ id, question, createdAt }));
  }

  async removeMisses(tenantId: string, ids: string[]): Promise<void> {
    const drop = new Set(ids);
    const keep = this.missRows.filter((r) => r.tenantId !== tenantId || !drop.has(r.id));
    this.missRows.splice(0, this.missRows.length, ...keep);
  }

  async rate(tenantId: string, userId: string, articleId: string, source: HelpRatingSource, helpful: boolean): Promise<void> {
    this.ratingRows.set(`${tenantId}|${userId}|${articleId}|${source}`, { tenantId, articleId, helpful });
  }

  async ratings(tenantId: string): Promise<{ articleId: string; helpful: boolean }[]> {
    return [...this.ratingRows.values()].filter((r) => r.tenantId === tenantId).map(({ articleId, helpful }) => ({ articleId, helpful }));
  }
}
