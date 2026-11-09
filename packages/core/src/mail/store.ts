/**
 * @file メールの片付けの置き場（仕様書 第9.5.1.1節、ADR-0131）。PostgreSQL と、テストのための記憶の中の置き場。
 *
 * 1 人ずつの見回りの様子（`mail_watch`）と、スレッドごとの振り分けと状態（`mail_threads`）を持つ。
 * 本文は持たない。片付いてから 7 日で消し、Google の連携の解除・データの削除の求めではすぐ消す（第14.3.2節）。
 */

import type pg from 'pg';
import type { MailGroupId, MailPrefs } from '@m2office/shared';
import { createPool } from '../repository/pool.js';

/** 1 人の見回りの様子。 */
export interface MailWatchRow {
  historyId: string | null;
  startedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  prefs: MailPrefs;
}

/** スレッドの状態。 */
export interface MailThreadRow {
  threadId: string;
  group: MailGroupId;
  state: 'open' | 'done';
  doneReason: string | null;
  doneAt: string | null;
  lastMessageId: string;
  /** 返信するときに相手にするメール（最後に届いたもの）。 */
  replyToId: string;
  from: string;
  subject: string;
  summary: string;
  dueText: string;
  dueDate: string | null;
  lastAt: string;
  sentAt: string | null;
  sentTo: string;
  recipients: { to: string[]; cc: string[] };
  draftState: 'none' | 'pending' | 'ready';
  draft: string;
  /** 本人が確かめて送ると決めた控え。 */
  outgoing: MailOutgoing | null;
  sendRunId: string | null;
  notifiedAt: string | null;
  updatedAt: string;
}

/** 送る控え（本人が確かめた宛先・CC・件名・本文）。 */
export interface MailOutgoing {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  replyTo: string;
}

/** 誰の分か。 */
export interface MailOwner {
  tenantId: string;
  userId: string;
}

/** 置き場。 */
export interface MailStore {
  watch(o: MailOwner): Promise<MailWatchRow | null>;
  saveWatch(o: MailOwner, w: MailWatchRow): Promise<void>;
  thread(o: MailOwner, threadId: string): Promise<MailThreadRow | null>;
  /** 片付いていないもの（`state = open`）をすべて。 */
  openThreads(o: MailOwner): Promise<MailThreadRow[]>;
  saveThread(o: MailOwner, t: MailThreadRow): Promise<void>;
  /** 片付いてから `cutoff` より前のものを消す。 */
  deleteDoneBefore(tenantId: string, cutoff: string): Promise<number>;
  /** 本人の分をすべて消す（Google の連携の解除・データの削除の求め）。 */
  purgeUser(o: MailOwner): Promise<void>;
}

type Ts = Date | string;
type WatchDb = { history_id: string | null; started_at: Ts | null; checked_at: Ts | null; error: string | null; prefs: MailPrefs | null };
type ThreadDb = {
  thread_id: string; grp: MailGroupId; state: 'open' | 'done'; done_reason: string | null; done_at: Ts | null;
  last_message_id: string; reply_to_id: string; from_text: string; subject: string; summary: string; due_text: string; due_date: string | Date | null;
  last_at: Ts; sent_at: Ts | null; sent_to: string; recipients: { to?: string[]; cc?: string[] } | null;
  draft_state: 'none' | 'pending' | 'ready'; draft: string; outgoing: MailOutgoing | null; send_run_id: string | null; notified_at: Ts | null; updated_at: Ts;
};

/** 時刻を ISO の文字にする（接続の設定で、文字か Date のどちらでも返る）。 */
const iso = (d: Ts | null) => (d ? new Date(d).toISOString() : null);
const dateOnly = (d: string | Date | null) => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10));

function threadOf(r: ThreadDb): MailThreadRow {
  return {
    threadId: r.thread_id, group: r.grp, state: r.state, doneReason: r.done_reason, doneAt: iso(r.done_at),
    lastMessageId: r.last_message_id, replyToId: r.reply_to_id, from: r.from_text, subject: r.subject, summary: r.summary,
    dueText: r.due_text, dueDate: dateOnly(r.due_date), lastAt: iso(r.last_at) ?? new Date(0).toISOString(), sentAt: iso(r.sent_at), sentTo: r.sent_to,
    recipients: { to: r.recipients?.to ?? [], cc: r.recipients?.cc ?? [] },
    draftState: r.draft_state, draft: r.draft, outgoing: r.outgoing, sendRunId: r.send_run_id, notifiedAt: iso(r.notified_at), updatedAt: iso(r.updated_at) ?? new Date(0).toISOString(),
  };
}

const THREAD_COLS = `thread_id, grp, state, done_reason, done_at, last_message_id, reply_to_id, from_text, subject, summary, due_text, due_date,
  last_at, sent_at, sent_to, recipients, draft_state, draft, outgoing, send_run_id, notified_at, updated_at`;

/**
 * PostgreSQL の置き場。
 *
 * @remarks テナント境界: 行レベルセキュリティと、すべての SQL の `tenant_id` の両方で絞る（不変則 I-2）。本人の分は `user_id` でも絞る
 */
export class PostgresMailStore implements MailStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 4, name: 'mail' });
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

  async watch(o: MailOwner): Promise<MailWatchRow | null> {
    const [r] = await this.q<WatchDb>(o.tenantId,
      `select history_id, started_at, checked_at, error, prefs from mail_watch where tenant_id = $1 and user_id = $2`, [o.tenantId, o.userId]);
    return r ? { historyId: r.history_id, startedAt: iso(r.started_at), checkedAt: iso(r.checked_at), error: r.error, prefs: r.prefs ?? {} } : null;
  }

  async saveWatch(o: MailOwner, w: MailWatchRow): Promise<void> {
    await this.q(o.tenantId,
      `insert into mail_watch (tenant_id, user_id, history_id, started_at, checked_at, error, prefs) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (tenant_id, user_id) do update set history_id = excluded.history_id, started_at = excluded.started_at,
         checked_at = excluded.checked_at, error = excluded.error, prefs = excluded.prefs`,
      [o.tenantId, o.userId, w.historyId, w.startedAt, w.checkedAt, w.error, JSON.stringify(w.prefs ?? {})]);
  }

  async thread(o: MailOwner, threadId: string): Promise<MailThreadRow | null> {
    const [r] = await this.q<ThreadDb>(o.tenantId,
      `select ${THREAD_COLS} from mail_threads where tenant_id = $1 and user_id = $2 and thread_id = $3`, [o.tenantId, o.userId, threadId]);
    return r ? threadOf(r) : null;
  }

  async openThreads(o: MailOwner): Promise<MailThreadRow[]> {
    const rows = await this.q<ThreadDb>(o.tenantId,
      `select ${THREAD_COLS} from mail_threads where tenant_id = $1 and user_id = $2 and state = 'open' order by last_at desc`, [o.tenantId, o.userId]);
    return rows.map(threadOf);
  }

  async saveThread(o: MailOwner, t: MailThreadRow): Promise<void> {
    await this.q(o.tenantId,
      `insert into mail_threads (tenant_id, user_id, thread_id, grp, state, done_reason, done_at, last_message_id, reply_to_id, from_text, subject, summary,
         due_text, due_date, last_at, sent_at, sent_to, recipients, draft_state, draft, outgoing, send_run_id, notified_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21::jsonb, $22, $23, now())
       on conflict (tenant_id, user_id, thread_id) do update set grp = excluded.grp, state = excluded.state, done_reason = excluded.done_reason,
         done_at = excluded.done_at, last_message_id = excluded.last_message_id, reply_to_id = excluded.reply_to_id, from_text = excluded.from_text,
         subject = excluded.subject, summary = excluded.summary, due_text = excluded.due_text, due_date = excluded.due_date, last_at = excluded.last_at,
         sent_at = excluded.sent_at, sent_to = excluded.sent_to, recipients = excluded.recipients, draft_state = excluded.draft_state, draft = excluded.draft,
         outgoing = excluded.outgoing, send_run_id = excluded.send_run_id, notified_at = excluded.notified_at, updated_at = now()`,
      [o.tenantId, o.userId, t.threadId, t.group, t.state, t.doneReason, t.doneAt, t.lastMessageId, t.replyToId, t.from, t.subject, t.summary,
        t.dueText, t.dueDate, t.lastAt, t.sentAt, t.sentTo, JSON.stringify(t.recipients), t.draftState, t.draft,
        t.outgoing ? JSON.stringify(t.outgoing) : null, t.sendRunId, t.notifiedAt]);
  }

  async deleteDoneBefore(tenantId: string, cutoff: string): Promise<number> {
    const rows = await this.q<{ thread_id: string }>(tenantId,
      `delete from mail_threads where tenant_id = $1 and state = 'done' and done_at < $2 returning thread_id`, [tenantId, cutoff]);
    return rows.length;
  }

  async purgeUser(o: MailOwner): Promise<void> {
    await this.q(o.tenantId, `delete from mail_threads where tenant_id = $1 and user_id = $2`, [o.tenantId, o.userId]);
    await this.q(o.tenantId, `delete from mail_watch where tenant_id = $1 and user_id = $2`, [o.tenantId, o.userId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 記憶の中の置き場（テスト用）。 */
export class MemoryMailStore implements MailStore {
  readonly watches = new Map<string, MailWatchRow>();
  readonly threads = new Map<string, MailThreadRow>();

  private key(o: MailOwner, rest = '') {
    return `${o.tenantId}\u0000${o.userId}\u0000${rest}`;
  }

  async watch(o: MailOwner) { const w = this.watches.get(this.key(o)); return w ? structuredClone(w) : null; }
  async saveWatch(o: MailOwner, w: MailWatchRow) { this.watches.set(this.key(o), structuredClone(w)); }
  async thread(o: MailOwner, threadId: string) { const t = this.threads.get(this.key(o, threadId)); return t ? structuredClone(t) : null; }
  async openThreads(o: MailOwner) {
    const prefix = this.key(o);
    return [...this.threads.entries()].filter(([k, t]) => k.startsWith(prefix) && t.state === 'open')
      .map(([, t]) => structuredClone(t)).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }
  async saveThread(o: MailOwner, t: MailThreadRow) { this.threads.set(this.key(o, t.threadId), { ...structuredClone(t), updatedAt: new Date().toISOString() }); }
  async deleteDoneBefore(tenantId: string, cutoff: string) {
    let n = 0;
    for (const [k, t] of this.threads) {
      if (k.startsWith(`${tenantId}\u0000`) && t.state === 'done' && t.doneAt !== null && t.doneAt < cutoff) { this.threads.delete(k); n += 1; }
    }
    return n;
  }
  async purgeUser(o: MailOwner) {
    const prefix = this.key(o);
    for (const k of [...this.threads.keys()]) if (k.startsWith(prefix)) this.threads.delete(k);
    this.watches.delete(prefix);
  }
}
