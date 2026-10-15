/**
 * @file 答えられなかった問い（仕様書 第11.13.6節、ADR-0095。秘書の成長の段 3）。
 *
 * 秘書と社内ナレッジ Q&A が会社の知識に当たる箇所を見つけられなかった問いを、**誰が聞いたかを残さずに**残す（90 日）。
 * 週 1 回、いまの会社の知識で探し直して答えの入ったものに印を付け、直近 7 日に答えられなかった問いがあれば管理者に知らせる。
 * 規程や手順を足すかは管理者が決める（秘書が自分で規程を作ることはしない）。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { Repository } from '../repository/types.js';
import { silentLogger, type Logger } from '../log/logger.js';

/** 問いの長さの上限・残す日数・知らせる日数・知らせに載せる数・知らせる曜日と時（日本時間の月曜 8 時）。 */
export const KNOWLEDGE_GAP_LIMITS = { questionMax: 200, keepDays: 90, noticeDays: 7, noticeTop: 5, weekday: 1, hour: 8 } as const;

/** どこで答えられなかったか。 */
export type KnowledgeGapSource = 'secretary' | 'knowledge-qa';

/** 残した問い 1 件。 */
export interface KnowledgeGapRow {
  id: string;
  question: string;
  source: KnowledgeGapSource;
  createdAt: string;
  answeredAt: string | null;
  knowledgeId: string | null;
}

/** 管理者に見せる、同じ問いをまとめた 1 行。 */
export interface KnowledgeGapSummary {
  question: string;
  count: number;
  lastAt: string;
  /** 答えが入った知識（入っていなければ `null`） */
  answered: { knowledgeId: string; title: string } | null;
}

/** 答えられなかった問いの置き場。 */
export interface KnowledgeGapStore {
  add(tenantId: string, question: string, source: KnowledgeGapSource): Promise<void>;
  /** `since` より後の問い（新しい順） */
  list(tenantId: string, since: string): Promise<KnowledgeGapRow[]>;
  markAnswered(tenantId: string, ids: string[], knowledgeId: string, at: string): Promise<void>;
  remove(tenantId: string, ids: string[]): Promise<void>;
  purge(tenantId: string, before: string): Promise<number>;
}

/** 同じ問いとみなす鍵（全角・半角と空白・句読点の違いを無くす）。 */
export const gapKey = (q: string) => q.normalize('NFKC').replace(/[\s、。，．,.!?！？「」『』（）()・]/g, '').toLowerCase();

/** 答えられなかった秘書の答え（会社の知識が 0 件で、分からない旨を言ったとき）。 */
export const UNKNOWN_ANSWER = /(分かりません|わかりません|見つかりません|見当たりません|記載がありません|登録されていません|確認できません|お答えできません)/;

/**
 * 答えられなかった問い（第11.13.6節）。
 *
 * @remarks テナント境界: すべて会社ごと（不変則 I-2）。誰が聞いたかは持たない
 */
export class KnowledgeGaps {
  private readonly log: Logger;

  constructor(private readonly deps: { store: KnowledgeGapStore; repo: Repository; logger?: Logger }) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 問いを残す（200 字まで。空なら残さない）。 */
  async record(tenantId: string, question: string, source: KnowledgeGapSource, now: Date = new Date()): Promise<void> {
    const q = [...question.replace(/\s+/g, ' ').trim()].slice(0, KNOWLEDGE_GAP_LIMITS.questionMax).join('');
    if (!q) return;
    await this.deps.store.add(tenantId, q, source);
    await this.deps.store.purge(tenantId, new Date(now.getTime() - KNOWLEDGE_GAP_LIMITS.keepDays * 86_400_000).toISOString()).catch(() => 0);
  }

  /** 管理者に見せる一覧（同じ問いをまとめ、回数の多い順。90 日分）。 */
  async summary(tenantId: string, now: Date = new Date()): Promise<{ items: KnowledgeGapSummary[]; keepDays: number }> {
    const rows = await this.deps.store.list(tenantId, new Date(now.getTime() - KNOWLEDGE_GAP_LIMITS.keepDays * 86_400_000).toISOString());
    const titles = new Map((await this.deps.repo.listKnowledge(tenantId, { all: true }).catch(() => [])).map((k) => [k.id, k.title]));
    const by = new Map<string, KnowledgeGapSummary>();
    for (const r of rows) {
      const key = gapKey(r.question);
      const x = by.get(key) ?? { question: r.question, count: 0, lastAt: r.createdAt, answered: null };
      x.count++;
      if (r.createdAt > x.lastAt) x.lastAt = r.createdAt;
      if (r.knowledgeId && !x.answered) x.answered = { knowledgeId: r.knowledgeId, title: titles.get(r.knowledgeId) ?? '' };
      by.set(key, x);
    }
    const items = [...by.values()].sort((a, b) => Number(!!a.answered) - Number(!!b.answered) || b.count - a.count || b.lastAt.localeCompare(a.lastAt));
    return { items, keepDays: KNOWLEDGE_GAP_LIMITS.keepDays };
  }

  /** 同じ問いをまとめて外す（管理者が要らないとした）。 */
  async dismiss(tenantId: string, question: string): Promise<void> {
    const key = gapKey(question);
    const rows = await this.deps.store.list(tenantId, new Date(0).toISOString());
    await this.deps.store.remove(tenantId, rows.filter((r) => gapKey(r.question) === key).map((r) => r.id));
  }

  /** 週 1 回の時か（月曜の 8 時を過ぎていて、今週まだ行っていない）。 */
  async due(tenantId: string, now: Date): Promise<boolean> {
    const jst = new Date(now.getTime() + 9 * 3_600_000);
    const daysSinceMonday = (jst.getUTCDay() + 6) % 7;
    const mondayStart = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - daysSinceMonday, KNOWLEDGE_GAP_LIMITS.hour) - 9 * 3_600_000;
    if (now.getTime() < mondayStart) return false;
    const last = (await this.deps.repo.listAuditSince(tenantId, ['knowledge.gaps'], 1))[0];
    return !last || Date.parse(last.occurredAt) < mondayStart;
  }

  /**
   * 週 1 回の見回り: いまの会社の知識で探し直して答えの入った問いに印を付け、直近 7 日の答えられなかった問いを管理者に知らせる。
   *
   * @returns 印を付けた問いの数と、知らせた問いの数
   */
  async weekly(tenantId: string, now: Date = new Date()): Promise<{ answered: number; open: number }> {
    const { store, repo } = this.deps;
    const at = now.toISOString();
    const rows = await store.list(tenantId, new Date(now.getTime() - KNOWLEDGE_GAP_LIMITS.keepDays * 86_400_000).toISOString());
    const open = rows.filter((r) => !r.answeredAt);
    const groups = new Map<string, KnowledgeGapRow[]>();
    for (const r of open) groups.set(gapKey(r.question), [...(groups.get(gapKey(r.question)) ?? []), r]);
    let answered = 0;
    for (const list of [...groups.values()].slice(0, 50)) {
      // 区画の外の会社の知識で探し直す（言葉の検索。誰の権限でもなく、全社の知識だけ）
      const found = await repo.searchKnowledge(tenantId, list[0]!.question, null, [], {}).catch(() => ({ hits: [] }));
      const hit = found.hits[0];
      if (!hit) continue;
      await store.markAnswered(tenantId, list.map((r) => r.id), hit.id, at);
      answered += list.length;
    }
    const since = new Date(now.getTime() - KNOWLEDGE_GAP_LIMITS.noticeDays * 86_400_000).toISOString();
    const stillOpen = (await store.list(tenantId, since)).filter((r) => !r.answeredAt);
    if (stillOpen.length > 0) {
      const top = [...new Map(stillOpen.map((r) => [gapKey(r.question), r.question])).values()].slice(0, KNOWLEDGE_GAP_LIMITS.noticeTop);
      const admins = (await repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin'));
      for (const u of admins) {
        await repo.createNotification({
          id: randomUUID(), tenantId, userId: u.id, kind: 'knowledgeGap',
          title: `秘書が答えられなかった問いが ${stillOpen.length} 件ありました`, body: top.map((q) => `・${q}`).join('\n').slice(0, 300),
          runId: null, readAt: null, createdAt: at,
        }).catch((err: unknown) => this.log.warn('答えられなかった問いの知らせを作れませんでした', { error: String(err) }));
      }
    }
    // 数だけを残す。問いの文は監査ログに入れない
    await repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'system', actorId: 'secretary', action: 'knowledge.gaps',
      targetType: 'knowledge', targetId: 'gaps', detail: { answered, open: stillOpen.length }, occurredAt: at,
    });
    return { answered, open: stillOpen.length };
  }
}

/** PostgreSQL の置き場（行単位のセキュリティで会社を絞る）。 */
export class PostgresKnowledgeGapStore implements KnowledgeGapStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'knowledge/gaps' });
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

  async add(tenantId: string, question: string, source: KnowledgeGapSource): Promise<void> {
    await this.q(tenantId, `insert into knowledge_gaps (id, tenant_id, question, source) values ($1,$2,$3,$4)`, [`gap-${randomUUID()}`, tenantId, question, source]);
  }

  async list(tenantId: string, since: string): Promise<KnowledgeGapRow[]> {
    const rows = await this.q<{ id: string; question: string; source: KnowledgeGapSource; created_at: Date | string; answered_at: Date | string | null; knowledge_id: string | null }>(tenantId,
      `select id, question, source, created_at, answered_at, knowledge_id from knowledge_gaps where tenant_id = $1 and created_at > $2 order by created_at desc limit 2000`,
      [tenantId, since]);
    return rows.map((r) => ({
      id: r.id, question: r.question, source: r.source, createdAt: new Date(r.created_at).toISOString(),
      answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : null, knowledgeId: r.knowledge_id,
    }));
  }

  async markAnswered(tenantId: string, ids: string[], knowledgeId: string, at: string): Promise<void> {
    if (ids.length === 0) return;
    await this.q(tenantId, `update knowledge_gaps set answered_at = $3, knowledge_id = $4 where tenant_id = $1 and id = any($2::text[])`, [tenantId, ids, at, knowledgeId]);
  }

  async remove(tenantId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.q(tenantId, `delete from knowledge_gaps where tenant_id = $1 and id = any($2::text[])`, [tenantId, ids]);
  }

  async purge(tenantId: string, before: string): Promise<number> {
    return (await this.q<{ id: string }>(tenantId, `delete from knowledge_gaps where tenant_id = $1 and created_at < $2 returning id`, [tenantId, before])).length;
  }
}

/** 試験用の置き場。 */
export class MemoryKnowledgeGapStore implements KnowledgeGapStore {
  readonly rows: (KnowledgeGapRow & { tenantId: string })[] = [];
  async add(tenantId: string, question: string, source: KnowledgeGapSource): Promise<void> {
    this.rows.push({ id: `gap-${randomUUID()}`, tenantId, question, source, createdAt: new Date().toISOString(), answeredAt: null, knowledgeId: null });
  }
  async list(tenantId: string, since: string): Promise<KnowledgeGapRow[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && r.createdAt > since).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ tenantId: _t, ...r }) => r);
  }
  async markAnswered(tenantId: string, ids: string[], knowledgeId: string, at: string): Promise<void> {
    for (const r of this.rows) if (r.tenantId === tenantId && ids.includes(r.id)) { r.answeredAt = at; r.knowledgeId = knowledgeId; }
  }
  async remove(tenantId: string, ids: string[]): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.tenantId === tenantId && ids.includes(this.rows[i]!.id)) this.rows.splice(i, 1);
  }
  async purge(tenantId: string, before: string): Promise<number> {
    const n = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.tenantId === tenantId && this.rows[i]!.createdAt < before) this.rows.splice(i, 1);
    return n - this.rows.length;
  }
}
