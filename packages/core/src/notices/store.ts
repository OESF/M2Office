/**
 * @file 社内のお知らせの置き場（仕様書 第10.15節、ADR-0047）。PostgreSQL と、自動テスト用のメモリの 2 つ。
 *
 * お知らせ本体と、受け取った人ごとの状態（初めて朝のブリーフに載せた日時・済んだ日時）を持つ。
 * 会社の境界はデータベースの行単位の制限でも効く（移行 037）。
 */

import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { Notice } from '@m2office/shared';

/** 受け取った人ごとの状態。 */
export interface NoticeReceipt {
  noticeId: string;
  firstShownAt: string | null;
  doneAt: string | null;
}

/** 新しく出すお知らせ（出した人の表示名と取り下げの項目は置き場が埋める）。 */
export type NewNotice = Omit<Notice, 'authorName' | 'withdrawnAt' | 'withdrawnBy'>;

/**
 * お知らせの置き場。
 *
 * @remarks どの操作も会社（テナント）で絞る（不変則 I-2）
 */
export interface NoticeStore {
  create(n: NewNotice): Promise<void>;
  /** 取り下げていない・載せる最後の日が `today` 以降のもの。新しい順。 */
  listActive(tenantId: string, today: string): Promise<Notice[]>;
  get(tenantId: string, id: string): Promise<Notice | null>;
  /** 取り下げる。すでに取り下げていれば `false`。 */
  withdraw(tenantId: string, id: string, by: string, at: string): Promise<boolean>;
  receipts(tenantId: string, userId: string, noticeIds: string[]): Promise<NoticeReceipt[]>;
  /** 初めて載せた日時を記録する（すでにあれば変えない）。 */
  markShown(tenantId: string, userId: string, noticeIds: string[], at: string): Promise<void>;
  markDone(tenantId: string, userId: string, noticeId: string, at: string): Promise<void>;
  /** お知らせ 1 つの、受け取った人ごとの状態（済んだ人を数える・締切の前の知らせ。第10.15.1節）。 */
  states(tenantId: string, noticeId: string): Promise<NoticeState[]>;
  /** 本人が「もう知らせないで」と言った（締切の前の知らせを止める。済んだとは数えない）。 */
  markMuted(tenantId: string, userId: string, noticeId: string, at: string): Promise<void>;
  /** 締切の前の知らせを送った印を付ける。初めてなら `true`（同じ知らせを 2 度送らない）。 */
  markReminded(tenantId: string, userId: string, noticeId: string, stage: 'before' | 'due', at: string): Promise<boolean>;
  /** Chat に投稿した印を付ける。初めてなら `true`（投稿は 1 回だけ）。 */
  markChatPosted(tenantId: string, noticeId: string, space: string): Promise<boolean>;
}

/** 受け取った人 1 人の状態（第10.15.1節）。 */
export interface NoticeState extends NoticeReceipt {
  userId: string;
  mutedAt: string | null;
}

/** 日付の列を `YYYY-MM-DD` にする（pg は date を Date で返すことがある）。 */
function day(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

/** 時刻の列を ISO 8601 にする。 */
function time(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

interface NoticeRow {
  id: string; tenant_id: string; author_id: string; author_name: string | null; title: string; body: string; link: string;
  audience_all: boolean; group_ids: string[]; due_on: unknown; until_on: unknown; created_at: unknown;
  withdrawn_at: unknown; withdrawn_by: string | null;
}

function toNotice(r: NoticeRow): Notice {
  return {
    id: r.id, tenantId: r.tenant_id, authorId: r.author_id, authorName: r.author_name ?? '', title: r.title, body: r.body,
    link: r.link, audience: { all: r.audience_all, groupIds: r.group_ids ?? [] }, dueOn: day(r.due_on), until: day(r.until_on) ?? '',
    createdAt: time(r.created_at) ?? '', withdrawnAt: time(r.withdrawn_at), withdrawnBy: r.withdrawn_by,
  };
}

const SELECT = `select n.*, u.display_name as author_name from notices n left join users u on u.id = n.author_id`;

/**
 * PostgreSQL のお知らせの置き場。
 *
 * @remarks 問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する（行単位の制限。移行 037）
 */
export class PostgresNoticeStore implements NoticeStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'notices' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const res = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return res.rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async create(n: NewNotice): Promise<void> {
    await this.q(n.tenantId,
      `insert into notices (id, tenant_id, author_id, title, body, link, audience_all, group_ids, due_on, until_on, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [n.id, n.tenantId, n.authorId, n.title, n.body, n.link, n.audience.all, n.audience.groupIds, n.dueOn, n.until, n.createdAt]);
  }

  async listActive(tenantId: string, today: string): Promise<Notice[]> {
    const rows = await this.q<NoticeRow>(tenantId,
      `${SELECT} where n.tenant_id = $1 and n.withdrawn_at is null and n.until_on >= $2::date order by n.created_at desc`,
      [tenantId, today]);
    return rows.map(toNotice);
  }

  async get(tenantId: string, id: string): Promise<Notice | null> {
    const rows = await this.q<NoticeRow>(tenantId, `${SELECT} where n.tenant_id = $1 and n.id = $2`, [tenantId, id]);
    return rows[0] ? toNotice(rows[0]) : null;
  }

  async withdraw(tenantId: string, id: string, by: string, at: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update notices set withdrawn_at = $4, withdrawn_by = $3
        where tenant_id = $1 and id = $2 and withdrawn_at is null returning id`, [tenantId, id, by, at]);
    return rows.length > 0;
  }

  async receipts(tenantId: string, userId: string, noticeIds: string[]): Promise<NoticeReceipt[]> {
    if (noticeIds.length === 0) return [];
    const rows = await this.q<{ notice_id: string; first_shown_at: unknown; done_at: unknown }>(tenantId,
      `select notice_id, first_shown_at, done_at from notice_receipts
        where tenant_id = $1 and user_id = $2 and notice_id = any($3::text[])`, [tenantId, userId, noticeIds]);
    return rows.map((r) => ({ noticeId: r.notice_id, firstShownAt: time(r.first_shown_at), doneAt: time(r.done_at) }));
  }

  async markShown(tenantId: string, userId: string, noticeIds: string[], at: string): Promise<void> {
    if (noticeIds.length === 0) return;
    await this.q(tenantId,
      `insert into notice_receipts (tenant_id, notice_id, user_id, first_shown_at)
       select $1, x, $2, $4 from unnest($3::text[]) as x
       on conflict (tenant_id, notice_id, user_id)
       do update set first_shown_at = coalesce(notice_receipts.first_shown_at, excluded.first_shown_at)`,
      [tenantId, userId, noticeIds, at]);
  }

  async markDone(tenantId: string, userId: string, noticeId: string, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into notice_receipts (tenant_id, notice_id, user_id, done_at) values ($1, $2, $3, $4)
       on conflict (tenant_id, notice_id, user_id) do update set done_at = excluded.done_at`,
      [tenantId, noticeId, userId, at]);
  }

  async states(tenantId: string, noticeId: string): Promise<NoticeState[]> {
    const rows = await this.q<{ user_id: string; first_shown_at: unknown; done_at: unknown; muted_at: unknown }>(tenantId,
      `select user_id, first_shown_at, done_at, muted_at from notice_receipts where tenant_id = $1 and notice_id = $2`, [tenantId, noticeId]);
    return rows.map((r) => ({ noticeId, userId: r.user_id, firstShownAt: time(r.first_shown_at), doneAt: time(r.done_at), mutedAt: time(r.muted_at) }));
  }

  async markMuted(tenantId: string, userId: string, noticeId: string, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into notice_receipts (tenant_id, notice_id, user_id, muted_at) values ($1, $2, $3, $4)
       on conflict (tenant_id, notice_id, user_id) do update set muted_at = coalesce(notice_receipts.muted_at, excluded.muted_at)`,
      [tenantId, noticeId, userId, at]);
  }

  async markReminded(tenantId: string, userId: string, noticeId: string, stage: 'before' | 'due', at: string): Promise<boolean> {
    const col = stage === 'before' ? 'reminded_before_at' : 'reminded_due_at';
    const rows = await this.q<{ n: number }>(tenantId,
      `with prev as (select ${col} as v from notice_receipts where tenant_id = $1 and notice_id = $2 and user_id = $3)
       insert into notice_receipts (tenant_id, notice_id, user_id, ${col}) values ($1, $2, $3, $4)
       on conflict (tenant_id, notice_id, user_id) do update set ${col} = coalesce(notice_receipts.${col}, excluded.${col})
       returning (select count(*) from prev where v is not null)::int as n`,
      [tenantId, noticeId, userId, at]);
    return (rows[0]?.n ?? 0) === 0;
  }

  async markChatPosted(tenantId: string, noticeId: string, space: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update notices set chat_space = $3 where tenant_id = $1 and id = $2 and chat_space is null returning id`, [tenantId, noticeId, space]);
    return rows.length > 0;
  }
}

/**
 * メモリのお知らせの置き場。自動テストに使う。
 *
 * @remarks 出した人の表示名は `names` から引く
 */
export class MemoryNoticeStore implements NoticeStore {
  readonly notices: Notice[] = [];
  private readonly rows = new Map<string, NoticeReceipt & { tenantId: string; userId: string; mutedAt?: string | null; before?: string | null; due?: string | null }>();
  /** Chat に投稿したスペース（お知らせの ID → 名前）。 */
  readonly posted = new Map<string, string>();

  constructor(private readonly names: Record<string, string> = {}) {}

  async create(n: NewNotice): Promise<void> {
    this.notices.push({ ...n, authorName: this.names[n.authorId] ?? '', withdrawnAt: null, withdrawnBy: null });
  }

  async listActive(tenantId: string, today: string): Promise<Notice[]> {
    return this.notices
      .filter((n) => n.tenantId === tenantId && !n.withdrawnAt && n.until >= today)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(tenantId: string, id: string): Promise<Notice | null> {
    return this.notices.find((n) => n.tenantId === tenantId && n.id === id) ?? null;
  }

  async withdraw(tenantId: string, id: string, by: string, at: string): Promise<boolean> {
    const n = this.notices.find((x) => x.tenantId === tenantId && x.id === id && !x.withdrawnAt);
    if (!n) return false;
    n.withdrawnAt = at;
    n.withdrawnBy = by;
    return true;
  }

  private key(tenantId: string, userId: string, noticeId: string): string {
    return `${tenantId}:${userId}:${noticeId}`;
  }

  async receipts(tenantId: string, userId: string, noticeIds: string[]): Promise<NoticeReceipt[]> {
    return noticeIds.flatMap((id) => {
      const r = this.rows.get(this.key(tenantId, userId, id));
      return r ? [{ noticeId: r.noticeId, firstShownAt: r.firstShownAt, doneAt: r.doneAt }] : [];
    });
  }

  async markShown(tenantId: string, userId: string, noticeIds: string[], at: string): Promise<void> {
    for (const id of noticeIds) {
      const k = this.key(tenantId, userId, id);
      const r = this.rows.get(k) ?? { tenantId, userId, noticeId: id, firstShownAt: null, doneAt: null };
      r.firstShownAt ??= at;
      this.rows.set(k, r);
    }
  }

  async markDone(tenantId: string, userId: string, noticeId: string, at: string): Promise<void> {
    const k = this.key(tenantId, userId, noticeId);
    const r = this.rows.get(k) ?? { tenantId, userId, noticeId, firstShownAt: null, doneAt: null };
    r.doneAt = at;
    this.rows.set(k, r);
  }

  async states(tenantId: string, noticeId: string): Promise<NoticeState[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.noticeId === noticeId)
      .map((r) => ({ noticeId, userId: r.userId, firstShownAt: r.firstShownAt, doneAt: r.doneAt, mutedAt: r.mutedAt ?? null }));
  }

  async markMuted(tenantId: string, userId: string, noticeId: string, at: string): Promise<void> {
    const k = this.key(tenantId, userId, noticeId);
    const r = this.rows.get(k) ?? { tenantId, userId, noticeId, firstShownAt: null, doneAt: null };
    r.mutedAt ??= at;
    this.rows.set(k, r);
  }

  async markReminded(tenantId: string, userId: string, noticeId: string, stage: 'before' | 'due', at: string): Promise<boolean> {
    const k = this.key(tenantId, userId, noticeId);
    const r = this.rows.get(k) ?? { tenantId, userId, noticeId, firstShownAt: null, doneAt: null };
    this.rows.set(k, r);
    if (r[stage]) return false;
    r[stage] = at;
    return true;
  }

  async markChatPosted(_tenantId: string, noticeId: string, space: string): Promise<boolean> {
    if (this.posted.has(noticeId)) return false;
    this.posted.set(noticeId, space);
    return true;
  }
}
