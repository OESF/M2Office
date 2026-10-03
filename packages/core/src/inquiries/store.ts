/**
 * @file 問い合わせの記録の置き場（仕様書 第33.13節・第33.17節・第33.18節・第33.19節、移行 065〜068）。PostgreSQL と、自動テスト用のメモリの 2 つ。
 *
 * 問い合わせは利用範囲の中で会社で共有する。会社の境界はデータベースの行単位の制限でも効く。
 * 利用者の名前は置き場では持たず、処理（InquiryService）が埋める。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  Inquiry, InquiryChannel, InquiryEvent, InquiryMailSkipped, InquiryMonthStats, InquiryParty, InquiryReply, InquiryReplyStatus, InquiryStatus, InquiryTask, InquiryTemperature,
} from '@m2office/shared';

/** 新しい問い合わせ。 */
export interface NewInquiry {
  from: InquiryParty;
  contactId: string | null;
  channel: InquiryChannel;
  category: string;
  summary: string;
  source: string;
  temperature: InquiryTemperature;
  receivedBy: string;
  createdBy: string;
  /** LINE の相手のものなら、その LINE の利用者 ID。 */
  lineUserId?: string | null;
}

/** 直せる項目。 */
export type InquiryPatch = Partial<{
  from: InquiryParty; contactId: string | null; channel: InquiryChannel; category: string; summary: string; source: string;
  temperature: InquiryTemperature; status: InquiryStatus; lastAt: string; idleNotifiedAt: string | null;
}>;

/** 一覧の絞り込み。 */
export interface InquiryQuery {
  /** 既定は `all`。 */
  status?: InquiryStatus | 'all';
  contactId?: string;
  /** 誰から・用件・分類の一部。 */
  search?: string;
  /** この日時より後に動いたもの。 */
  since?: string;
  limit?: number;
}

/** 足す会話の履歴。 */
export interface NewInquiryEvent {
  direction: 'in' | 'out';
  channel: InquiryChannel;
  summary: string;
  body: string | null;
  createdBy: string;
  at?: string;
  /** 窓口のアカウントのメールなら、元のメールの参照と届いた宛先。 */
  mail?: { messageId: string; threadId: string; to: string } | null;
}

/** 窓口のアカウントで見たメールの記録（同じメールを 2 度読まない。問い合わせでないものの一覧）。 */
export interface MailLog {
  messageId: string;
  threadId: string;
  direction: 'in' | 'out';
  status: 'inquiry' | 'skipped';
  inquiryId: string | null;
  from: string;
  subject: string;
  to: string;
  reason: string;
  receivedAt: string;
}

/** 足す返事。 */
export interface NewReply {
  inquiryId: string;
  /** 既定は `mail`。 */
  channel?: 'mail' | 'line';
  to: string;
  from: string;
  subject: string;
  body: string;
  replyToMessage: string | null;
  threadId: string | null;
  createdBy: string;
}

/** 返事と、返す元のメール。 */
export type StoredReply = InquiryReply & { replyToMessage: string | null; threadId: string | null };

/** LINE の相手（友だち）。 */
export interface LineUser {
  lineUserId: string;
  displayName: string;
  /** いま続いている問い合わせ。 */
  inquiryId: string | null;
  following: boolean;
  lastAt: string;
}

/** 月の振り返りに数える 1 件。 */
export interface MonthRow {
  channel: InquiryChannel;
  source: string;
  category: string;
  temperature: InquiryTemperature;
  /** 最初の履歴が窓口のアカウントのメールなら、その宛先。 */
  mailTo: string | null;
}

/** 期限の見張りに使う、次にやること。 */
export interface DueTask extends InquiryTask {
  inquiryId: string;
  notifiedBeforeAt: string | null;
  notifiedOverdueAt: string | null;
}

/** 問い合わせの置き場。 */
export interface InquiryStore {
  list(tenantId: string, q?: InquiryQuery): Promise<Inquiry[]>;
  get(tenantId: string, id: string): Promise<Inquiry | null>;
  create(tenantId: string, n: NewInquiry): Promise<string>;
  update(tenantId: string, id: string, patch: InquiryPatch): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
  addEvent(tenantId: string, inquiryId: string, e: NewInquiryEvent): Promise<string>;
  events(tenantId: string, inquiryId: string): Promise<InquiryEvent[]>;
  addTask(tenantId: string, inquiryId: string, t: { assignee: string; what: string; due: string | null; createdBy: string; eventId?: string | null }): Promise<string>;
  /** 会話の履歴 1 つと、その問い合わせの ID。 */
  event(tenantId: string, eventId: string): Promise<(InquiryEvent & { inquiryId: string }) | null>;
  /** 会話の履歴 1 つと、その履歴から生まれた次にやることを、別の問い合わせに移す（別の問い合わせに分けるとき）。 */
  moveEvent(tenantId: string, eventId: string, toInquiryId: string): Promise<void>;
  tasks(tenantId: string, inquiryId: string): Promise<InquiryTask[]>;
  /** 次にやること 1 つと、その問い合わせの ID。 */
  task(tenantId: string, taskId: string): Promise<(InquiryTask & { inquiryId: string }) | null>;
  updateTask(tenantId: string, taskId: string, patch: Partial<{ assignee: string; what: string; due: string | null; done: boolean }>): Promise<void>;
  /** 済んでいない次にやることのうち、期限がこの日（`YYYY-MM-DD`）以前のもの。 */
  dueTasks(tenantId: string, until: string): Promise<DueTask[]>;
  markNotified(tenantId: string, taskId: string, kind: 'before' | 'overdue'): Promise<void>;
  /** 済んでいない次にやることが無く、この日時より前から動いていない、対応中の問い合わせ（まだ知らせていないもの）。 */
  idle(tenantId: string, before: string): Promise<Inquiry[]>;
  /** この日時より前の会話の履歴の原文を消す（要約は残す）。消した数。 */
  forgetBodies(tenantId: string, before: string): Promise<number>;

  // ---- 段 2: 窓口のアカウント・返事・月の振り返り（第33.18節） ----
  /** すでに見たメール（渡した ID のうち）。 */
  seenMail(tenantId: string, messageIds: string[]): Promise<Set<string>>;
  /** 見たメールを記録する（同じ ID なら置き換える）。 */
  logMail(tenantId: string, m: MailLog): Promise<void>;
  mailLog(tenantId: string, messageId: string): Promise<MailLog | null>;
  /** そのスレッドを問い合わせにしたなら、その問い合わせ。 */
  inquiryOfThread(tenantId: string, threadId: string): Promise<string | null>;
  /** 問い合わせでないと見分けたメール（新しい順）。 */
  skippedMails(tenantId: string, limit?: number): Promise<InquiryMailSkipped[]>;
  mailCursor(tenantId: string): Promise<string | null>;
  setMailCursor(tenantId: string, at: string): Promise<void>;
  addReply(tenantId: string, r: NewReply): Promise<string>;
  /** 問い合わせの返事（新しい順）。 */
  replies(tenantId: string, inquiryId: string): Promise<InquiryReply[]>;
  reply(tenantId: string, id: string): Promise<StoredReply | null>;
  updateReply(tenantId: string, id: string, patch: Partial<{ to: string; subject: string; body: string; status: InquiryReplyStatus; runId: string | null; sentMessageId: string; sentAt: string }>): Promise<void>;
  deleteReply(tenantId: string, id: string): Promise<void>;
  /** 対応中で、最後の履歴がお客様から届いたメール・フォーム・LINE のもの（返事を待たせている）。 */
  waitingReplies(tenantId: string, limit?: number): Promise<Inquiry[]>;
  /** この期間（ISO の日時。始まりを含み終わりを含まない）に最初に届いた問い合わせ。 */
  monthRows(tenantId: string, from: string, to: string): Promise<MonthRow[]>;
  /** 月の振り返りを記録する。すでにあれば何もせず `false`。 */
  saveReview(tenantId: string, stats: InquiryMonthStats): Promise<boolean>;

  // ---- 段 3: LINE 公式アカウント（第33.6.2節・第33.19節） ----
  /** 受け口の鍵のハッシュから会社を引く（会社の境界の外から呼ぶ。鍵を知る相手だけが会社に届く）。 */
  lineTenantOf(hash: string): Promise<string | null>;
  setLineHook(tenantId: string, hash: string): Promise<void>;
  deleteLineHook(tenantId: string): Promise<void>;
  lineUser(tenantId: string, lineUserId: string): Promise<LineUser | null>;
  saveLineUser(tenantId: string, u: LineUser): Promise<void>;
  /** 出来事を記録する。すでに受け取っていれば `false`（送り直し）。 */
  takeLineEvent(tenantId: string, eventId: string): Promise<boolean>;
  /** 問い合わせの LINE の相手（LINE のものでなければ `null`）。 */
  lineUserIdOf(tenantId: string, inquiryId: string): Promise<string | null>;
}

interface InquiryRow {
  id: string; from_name: string; from_company: string; from_phone: string; from_email: string; contact_id: string | null;
  channel: InquiryChannel; category: string; summary: string; source: string; temperature: InquiryTemperature; status: InquiryStatus;
  received_by: string; first_at: Date | string; last_at: Date | string; created_by: string; created_at: Date | string; updated_at: Date | string;
  t_id: string | null; t_assignee: string | null; t_what: string | null; t_due: Date | string | null; t_created_at: Date | string | null;
}

interface TaskRow {
  id: string; inquiry_id: string; assignee: string; what: string; due: Date | string | null; done_at: Date | string | null; created_at: Date | string;
  notified_before_at: Date | string | null; notified_overdue_at: Date | string | null;
}

interface EventRow {
  id: string; at: Date | string; direction: 'in' | 'out'; channel: InquiryChannel; summary: string; body: string | null; created_by: string;
  mail_message_id: string | null; mail_thread_id: string | null; mail_to: string | null;
}

interface ReplyRow {
  id: string; inquiry_id: string; channel: 'mail' | 'line'; to_address: string; from_address: string; subject: string; body: string; reply_to_message: string | null;
  thread_id: string | null; status: InquiryReplyStatus; run_id: string | null; created_by: string; created_at: Date | string; sent_at: Date | string | null;
}

const toEvent = (r: EventRow): InquiryEvent => ({
  id: r.id, at: iso(r.at), direction: r.direction, channel: r.channel, summary: r.summary, body: r.body, createdBy: r.created_by, createdByName: '',
  mail: r.mail_message_id ? { messageId: r.mail_message_id, threadId: r.mail_thread_id ?? '', to: r.mail_to ?? '' } : null,
});

const toReply = (r: ReplyRow): StoredReply => ({
  id: r.id, inquiryId: r.inquiry_id, channel: r.channel ?? 'mail', to: r.to_address, from: r.from_address, subject: r.subject, body: r.body, status: r.status, runId: r.run_id,
  createdBy: r.created_by, createdByName: '', createdAt: iso(r.created_at), sentAt: r.sent_at == null ? null : iso(r.sent_at),
  replyToMessage: r.reply_to_message, threadId: r.thread_id,
});

/** 日時を ISO の文字にする（つなぎの設定で Date でも文字でも返るため）。 */
const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v == null ? null : iso(v));

/** 日付の列を `YYYY-MM-DD` にする（Date で返るときは、サーバーの地域の時刻のその日の 0 時として読む）。 */
function day(v: Date | string | null): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}

/** 済んでいない次にやることのうち、期限のいちばん早いもの（期限の無いものは後ろ）を横に付ける。 */
const INQUIRY_SELECT = `select i.*, t.id as t_id, t.assignee as t_assignee, t.what as t_what, t.due as t_due, t.created_at as t_created_at
  from inquiries i
  left join lateral (
    select id, assignee, what, due, created_at from inquiry_tasks x
     where x.tenant_id = i.tenant_id and x.inquiry_id = i.id and x.done_at is null
     order by x.due asc nulls last, x.created_at asc limit 1
  ) t on true`;

function toInquiry(r: InquiryRow): Inquiry {
  return {
    id: r.id, from: { name: r.from_name, company: r.from_company, phone: r.from_phone, email: r.from_email }, contactId: r.contact_id,
    channel: r.channel, category: r.category, summary: r.summary, source: r.source, temperature: r.temperature, status: r.status,
    receivedBy: r.received_by, receivedByName: '', firstAt: iso(r.first_at), lastAt: iso(r.last_at),
    nextTask: r.t_id ? {
      id: r.t_id, assignee: r.t_assignee ?? '', assigneeName: '', what: r.t_what ?? '', due: day(r.t_due), doneAt: null, createdAt: iso(r.t_created_at!),
    } : null,
    createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

function toTask(r: TaskRow): InquiryTask {
  return { id: r.id, assignee: r.assignee, assigneeName: '', what: r.what, due: day(r.due), doneAt: isoOrNull(r.done_at), createdAt: iso(r.created_at) };
}

/** PostgreSQL の問い合わせの置き場。問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する。 */
export class PostgresInquiryStore implements InquiryStore {
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

  async list(tenantId: string, q: InquiryQuery = {}): Promise<Inquiry[]> {
    const where = ['i.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q.status && q.status !== 'all') { params.push(q.status); where.push(`i.status = $${params.length}`); }
    if (q.contactId) { params.push(q.contactId); where.push(`i.contact_id = $${params.length}`); }
    if (q.since) { params.push(q.since); where.push(`i.last_at > $${params.length}`); }
    if (q.search?.trim()) {
      // 検索の言葉は値として渡す（SQL に埋め込まない）。% と _ は文字として扱う
      params.push(`%${q.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const p = `$${params.length}`;
      where.push(`(i.from_name ilike ${p} or i.from_company ilike ${p} or i.summary ilike ${p} or i.category ilike ${p} or i.from_phone ilike ${p} or i.from_email ilike ${p})`);
    }
    params.push(Math.min(Math.max(q.limit ?? 200, 1), 500));
    const rows = await this.q<InquiryRow>(tenantId,
      `${INQUIRY_SELECT} where ${where.join(' and ')}
        order by (i.status = 'open') desc, (t.due is null), t.due asc, i.last_at desc limit $${params.length}`, params);
    return rows.map(toInquiry);
  }

  async get(tenantId: string, id: string): Promise<Inquiry | null> {
    const rows = await this.q<InquiryRow>(tenantId, `${INQUIRY_SELECT} where i.tenant_id = $1 and i.id = $2`, [tenantId, id]);
    return rows[0] ? toInquiry(rows[0]) : null;
  }

  async create(tenantId: string, n: NewInquiry): Promise<string> {
    const id = `inq-${randomUUID()}`;
    await this.q(tenantId,
      `insert into inquiries (id, tenant_id, from_name, from_company, from_phone, from_email, contact_id, channel, category, summary, source,
         temperature, received_by, created_by, line_user_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, tenantId, n.from.name, n.from.company, n.from.phone, n.from.email, n.contactId, n.channel, n.category, n.summary, n.source,
        n.temperature, n.receivedBy, n.createdBy, n.lineUserId ?? null]);
    return id;
  }

  async update(tenantId: string, id: string, patch: InquiryPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.from) {
      put('from_name', patch.from.name); put('from_company', patch.from.company); put('from_phone', patch.from.phone); put('from_email', patch.from.email);
    }
    // 列名は下の固定の対応表からのみ取る。利用者の入力を SQL に埋め込まない
    const cols: Record<string, string> = {
      contactId: 'contact_id', channel: 'channel', category: 'category', summary: 'summary', source: 'source', temperature: 'temperature',
      status: 'status', lastAt: 'last_at', idleNotifiedAt: 'idle_notified_at',
    };
    for (const [k, v] of Object.entries(patch)) if (k !== 'from' && v !== undefined && cols[k]) put(cols[k], v);
    if (sets.length === 0) return;
    await this.q(tenantId, `update inquiries set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from inquiries where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async addEvent(tenantId: string, inquiryId: string, e: NewInquiryEvent): Promise<string> {
    const id = `iqe-${randomUUID()}`;
    await this.q(tenantId,
      `insert into inquiry_events (id, tenant_id, inquiry_id, at, direction, channel, summary, body, created_by, mail_message_id, mail_thread_id, mail_to)
       values ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, tenantId, inquiryId, e.at ?? null, e.direction, e.channel, e.summary, e.body, e.createdBy, e.mail?.messageId ?? null, e.mail?.threadId ?? null, e.mail?.to ?? null]);
    return id;
  }

  async events(tenantId: string, inquiryId: string): Promise<InquiryEvent[]> {
    const rows = await this.q<EventRow>(tenantId,
      `select * from inquiry_events where tenant_id = $1 and inquiry_id = $2 order by at asc, created_at asc`, [tenantId, inquiryId]);
    return rows.map(toEvent);
  }

  async addTask(tenantId: string, inquiryId: string, t: { assignee: string; what: string; due: string | null; createdBy: string; eventId?: string | null }): Promise<string> {
    const id = `iqt-${randomUUID()}`;
    await this.q(tenantId,
      `insert into inquiry_tasks (id, tenant_id, inquiry_id, assignee, what, due, created_by, event_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, inquiryId, t.assignee, t.what, t.due, t.createdBy, t.eventId ?? null]);
    return id;
  }

  async event(tenantId: string, eventId: string): Promise<(InquiryEvent & { inquiryId: string }) | null> {
    const rows = await this.q<EventRow & { inquiry_id: string }>(tenantId, `select * from inquiry_events where tenant_id = $1 and id = $2`, [tenantId, eventId]);
    return rows[0] ? { ...toEvent(rows[0]), inquiryId: rows[0].inquiry_id } : null;
  }

  async moveEvent(tenantId: string, eventId: string, toInquiryId: string): Promise<void> {
    await this.tx(tenantId, async (c) => {
      await c.query(`update inquiry_events set inquiry_id = $3 where tenant_id = $1 and id = $2`, [tenantId, eventId, toInquiryId]);
      await c.query(`update inquiry_tasks set inquiry_id = $3 where tenant_id = $1 and event_id = $2`, [tenantId, eventId, toInquiryId]);
    });
  }

  async tasks(tenantId: string, inquiryId: string): Promise<InquiryTask[]> {
    const rows = await this.q<TaskRow>(tenantId,
      `select * from inquiry_tasks where tenant_id = $1 and inquiry_id = $2 order by (done_at is not null), due asc nulls last, created_at asc`,
      [tenantId, inquiryId]);
    return rows.map(toTask);
  }

  async task(tenantId: string, taskId: string): Promise<(InquiryTask & { inquiryId: string }) | null> {
    const rows = await this.q<TaskRow>(tenantId, `select * from inquiry_tasks where tenant_id = $1 and id = $2`, [tenantId, taskId]);
    return rows[0] ? { ...toTask(rows[0]), inquiryId: rows[0].inquiry_id } : null;
  }

  async updateTask(tenantId: string, taskId: string, patch: Partial<{ assignee: string; what: string; due: string | null; done: boolean }>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, taskId];
    const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.assignee !== undefined) put('assignee', patch.assignee);
    if (patch.what !== undefined) put('what', patch.what);
    // 期限を変えたら、もう一度知らせる
    if (patch.due !== undefined) { put('due', patch.due); sets.push('notified_before_at = null', 'notified_overdue_at = null'); }
    if (patch.done !== undefined) sets.push(patch.done ? 'done_at = coalesce(done_at, now())' : 'done_at = null');
    if (sets.length === 0) return;
    await this.q(tenantId, `update inquiry_tasks set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async dueTasks(tenantId: string, until: string): Promise<DueTask[]> {
    const rows = await this.q<TaskRow>(tenantId,
      `select t.* from inquiry_tasks t join inquiries i on i.tenant_id = t.tenant_id and i.id = t.inquiry_id
        where t.tenant_id = $1 and t.done_at is null and t.due is not null and t.due <= $2::date and i.status = 'open'
        order by t.due asc`, [tenantId, until]);
    return rows.map((r) => ({ ...toTask(r), inquiryId: r.inquiry_id, notifiedBeforeAt: isoOrNull(r.notified_before_at), notifiedOverdueAt: isoOrNull(r.notified_overdue_at) }));
  }

  async markNotified(tenantId: string, taskId: string, kind: 'before' | 'overdue'): Promise<void> {
    await this.q(tenantId,
      `update inquiry_tasks set ${kind === 'before' ? 'notified_before_at' : 'notified_overdue_at'} = now() where tenant_id = $1 and id = $2`,
      [tenantId, taskId]);
  }

  async idle(tenantId: string, before: string): Promise<Inquiry[]> {
    const rows = await this.q<InquiryRow>(tenantId,
      `${INQUIRY_SELECT} where i.tenant_id = $1 and i.status = 'open' and i.last_at < $2 and i.idle_notified_at is null and t.id is null
        order by i.last_at asc limit 100`, [tenantId, before]);
    return rows.map(toInquiry);
  }

  async forgetBodies(tenantId: string, before: string): Promise<number> {
    const rows = await this.q<{ id: string }>(tenantId,
      `update inquiry_events set body = null where tenant_id = $1 and body is not null and created_at < $2 returning id`, [tenantId, before]);
    return rows.length;
  }

  async seenMail(tenantId: string, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const rows = await this.q<{ message_id: string }>(tenantId,
      `select message_id from inquiry_mail_messages where tenant_id = $1 and message_id = any($2::text[])`, [tenantId, messageIds]);
    return new Set(rows.map((r) => r.message_id));
  }

  async logMail(tenantId: string, m: MailLog): Promise<void> {
    await this.q(tenantId,
      `insert into inquiry_mail_messages (tenant_id, message_id, thread_id, direction, status, inquiry_id, from_text, subject, mail_to, reason, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (tenant_id, message_id) do update set status = excluded.status, inquiry_id = excluded.inquiry_id, reason = excluded.reason`,
      [tenantId, m.messageId, m.threadId, m.direction, m.status, m.inquiryId, m.from.slice(0, 300), m.subject.slice(0, 300), m.to, m.reason, m.receivedAt]);
  }

  async mailLog(tenantId: string, messageId: string): Promise<MailLog | null> {
    const rows = await this.q<{ message_id: string; thread_id: string; direction: 'in' | 'out'; status: 'inquiry' | 'skipped'; inquiry_id: string | null; from_text: string; subject: string; mail_to: string; reason: string; received_at: Date | string }>(tenantId,
      `select * from inquiry_mail_messages where tenant_id = $1 and message_id = $2`, [tenantId, messageId]);
    const r = rows[0];
    return r ? {
      messageId: r.message_id, threadId: r.thread_id, direction: r.direction, status: r.status, inquiryId: r.inquiry_id, from: r.from_text,
      subject: r.subject, to: r.mail_to, reason: r.reason, receivedAt: iso(r.received_at),
    } : null;
  }

  async inquiryOfThread(tenantId: string, threadId: string): Promise<string | null> {
    const rows = await this.q<{ inquiry_id: string }>(tenantId,
      `select m.inquiry_id from inquiry_mail_messages m join inquiries i on i.tenant_id = m.tenant_id and i.id = m.inquiry_id
        where m.tenant_id = $1 and m.thread_id = $2 and m.status = 'inquiry' order by m.received_at desc limit 1`, [tenantId, threadId]);
    return rows[0]?.inquiry_id ?? null;
  }

  async skippedMails(tenantId: string, limit = 100): Promise<InquiryMailSkipped[]> {
    const rows = await this.q<{ message_id: string; from_text: string; subject: string; reason: string; received_at: Date | string }>(tenantId,
      `select message_id, from_text, subject, reason, received_at from inquiry_mail_messages
        where tenant_id = $1 and status = 'skipped' and direction = 'in' order by received_at desc limit $2`, [tenantId, limit]);
    return rows.map((r) => ({ messageId: r.message_id, from: r.from_text, subject: r.subject, reason: r.reason, receivedAt: iso(r.received_at) }));
  }

  async mailCursor(tenantId: string): Promise<string | null> {
    const rows = await this.q<{ checked_until: Date | string }>(tenantId, `select checked_until from inquiry_mail_cursors where tenant_id = $1`, [tenantId]);
    return rows[0] ? iso(rows[0].checked_until) : null;
  }

  async setMailCursor(tenantId: string, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into inquiry_mail_cursors (tenant_id, checked_until) values ($1, $2) on conflict (tenant_id) do update set checked_until = excluded.checked_until`,
      [tenantId, at]);
  }

  async addReply(tenantId: string, r: NewReply): Promise<string> {
    const id = `iqr-${randomUUID()}`;
    await this.q(tenantId,
      `insert into inquiry_replies (id, tenant_id, inquiry_id, to_address, from_address, subject, body, reply_to_message, thread_id, created_by, channel)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, r.inquiryId, r.to, r.from, r.subject, r.body, r.replyToMessage, r.threadId, r.createdBy, r.channel ?? 'mail']);
    return id;
  }

  async replies(tenantId: string, inquiryId: string): Promise<InquiryReply[]> {
    const rows = await this.q<ReplyRow>(tenantId, `select * from inquiry_replies where tenant_id = $1 and inquiry_id = $2 order by created_at desc`, [tenantId, inquiryId]);
    return rows.map((r) => { const { replyToMessage: _m, threadId: _t, ...rest } = toReply(r); return rest; });
  }

  async reply(tenantId: string, id: string): Promise<StoredReply | null> {
    const rows = await this.q<ReplyRow>(tenantId, `select * from inquiry_replies where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toReply(rows[0]) : null;
  }

  async updateReply(tenantId: string, id: string, patch: Parameters<InquiryStore['updateReply']>[2]): Promise<void> {
    // 列名は下の固定の対応表からのみ取る。利用者の入力を SQL に埋め込まない
    const cols: Record<string, string> = { to: 'to_address', subject: 'subject', body: 'body', status: 'status', runId: 'run_id', sentMessageId: 'sent_message_id', sentAt: 'sent_at' };
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(v);
      sets.push(`${cols[k]} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.q(tenantId, `update inquiry_replies set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, params);
  }

  async deleteReply(tenantId: string, id: string): Promise<void> {
    await this.q(tenantId, `delete from inquiry_replies where tenant_id = $1 and id = $2`, [tenantId, id]);
  }

  async waitingReplies(tenantId: string, limit = 50): Promise<Inquiry[]> {
    const rows = await this.q<InquiryRow>(tenantId,
      `${INQUIRY_SELECT}
        join lateral (
          select direction, channel from inquiry_events e where e.tenant_id = i.tenant_id and e.inquiry_id = i.id order by e.at desc, e.created_at desc limit 1
        ) last on true
        where i.tenant_id = $1 and i.status = 'open' and last.direction = 'in' and last.channel in ('mail', 'form', 'line')
        order by i.last_at asc limit $2`, [tenantId, limit]);
    return rows.map(toInquiry);
  }

  async monthRows(tenantId: string, from: string, to: string): Promise<MonthRow[]> {
    const rows = await this.q<{ channel: InquiryChannel; source: string; category: string; temperature: InquiryTemperature; mail_to: string | null }>(tenantId,
      `select i.channel, i.source, i.category, i.temperature,
              (select e.mail_to from inquiry_events e where e.tenant_id = i.tenant_id and e.inquiry_id = i.id order by e.at asc limit 1) as mail_to
         from inquiries i where i.tenant_id = $1 and i.first_at >= $2 and i.first_at < $3`, [tenantId, from, to]);
    return rows.map((r) => ({ channel: r.channel, source: r.source, category: r.category, temperature: r.temperature, mailTo: r.mail_to }));
  }

  async saveReview(tenantId: string, stats: InquiryMonthStats): Promise<boolean> {
    const rows = await this.q<{ month: string }>(tenantId,
      `insert into inquiry_reviews (tenant_id, month, stats) values ($1, $2, $3) on conflict (tenant_id, month) do nothing returning month`,
      [tenantId, stats.month, JSON.stringify(stats)]);
    return rows.length > 0;
  }

  async lineTenantOf(hash: string): Promise<string | null> {
    // 会社が決まる前に引く。行単位の制限を越えるのは、鍵のハッシュから会社だけを返す関数に限る（移行 068）
    const r = await this.pool.query<{ t: string | null }>(`select m2o_inquiry_line_tenant($1) as t`, [hash]);
    return r.rows[0]?.t ?? null;
  }

  async setLineHook(tenantId: string, hash: string): Promise<void> {
    await this.q(tenantId,
      `insert into inquiry_line_hooks (tenant_id, hook_hash) values ($1, $2) on conflict (tenant_id) do update set hook_hash = excluded.hook_hash, created_at = now()`,
      [tenantId, hash]);
  }

  async deleteLineHook(tenantId: string): Promise<void> {
    await this.q(tenantId, `delete from inquiry_line_hooks where tenant_id = $1`, [tenantId]);
  }

  async lineUser(tenantId: string, lineUserId: string): Promise<LineUser | null> {
    const rows = await this.q<{ line_user_id: string; display_name: string; inquiry_id: string | null; following: boolean; last_at: Date | string }>(tenantId,
      `select * from inquiry_line_users where tenant_id = $1 and line_user_id = $2`, [tenantId, lineUserId]);
    const r = rows[0];
    return r ? { lineUserId: r.line_user_id, displayName: r.display_name, inquiryId: r.inquiry_id, following: r.following, lastAt: iso(r.last_at) } : null;
  }

  async saveLineUser(tenantId: string, u: LineUser): Promise<void> {
    await this.q(tenantId,
      `insert into inquiry_line_users (tenant_id, line_user_id, display_name, inquiry_id, following, last_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, line_user_id) do update set display_name = excluded.display_name, inquiry_id = excluded.inquiry_id,
         following = excluded.following, last_at = excluded.last_at`,
      [tenantId, u.lineUserId, u.displayName.slice(0, 100), u.inquiryId, u.following, u.lastAt]);
  }

  async lineUserIdOf(tenantId: string, inquiryId: string): Promise<string | null> {
    const rows = await this.q<{ line_user_id: string | null }>(tenantId, `select line_user_id from inquiries where tenant_id = $1 and id = $2`, [tenantId, inquiryId]);
    return rows[0]?.line_user_id ?? null;
  }

  async takeLineEvent(tenantId: string, eventId: string): Promise<boolean> {
    const rows = await this.q<{ event_id: string }>(tenantId,
      `insert into inquiry_line_events (tenant_id, event_id) values ($1, $2) on conflict do nothing returning event_id`, [tenantId, eventId]);
    return rows.length > 0;
  }
}

/** 自動テスト用のメモリの置き場。 */
export class MemoryInquiryStore implements InquiryStore {
  readonly rows = new Map<string, Omit<Inquiry, 'nextTask'> & { tenantId: string; idleNotifiedAt: string | null; lineUserId?: string | null }>();
  readonly allEvents: (InquiryEvent & { tenantId: string; inquiryId: string; createdAt: string })[] = [];
  readonly mails: (MailLog & { tenantId: string })[] = [];
  readonly cursors = new Map<string, string>();
  readonly allReplies: (StoredReply & { tenantId: string })[] = [];
  readonly reviews = new Map<string, InquiryMonthStats>();
  readonly lineHooks = new Map<string, string>();
  readonly lineUsers = new Map<string, LineUser>();
  readonly lineEvents = new Set<string>();
  readonly allTasks: (DueTask & { tenantId: string; eventId: string | null })[] = [];

  private next(tenantId: string, id: string): InquiryTask | null {
    const open = this.allTasks.filter((t) => t.tenantId === tenantId && t.inquiryId === id && !t.doneAt)
      .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.createdAt.localeCompare(b.createdAt));
    const t = open[0];
    return t ? { id: t.id, assignee: t.assignee, assigneeName: '', what: t.what, due: t.due, doneAt: null, createdAt: t.createdAt } : null;
  }

  private view(r: Omit<Inquiry, 'nextTask'> & { tenantId: string; idleNotifiedAt: string | null; lineUserId?: string | null }): Inquiry {
    const { tenantId, idleNotifiedAt: _i, lineUserId: _l, ...rest } = r;
    return { ...rest, nextTask: this.next(tenantId, r.id) };
  }

  async list(tenantId: string, q: InquiryQuery = {}): Promise<Inquiry[]> {
    const words = q.search?.trim().toLowerCase() ?? '';
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => !q.status || q.status === 'all' || r.status === q.status)
      .filter((r) => !q.contactId || r.contactId === q.contactId)
      .filter((r) => !q.since || r.lastAt > q.since)
      .filter((r) => !words || [r.from.name, r.from.company, r.summary, r.category, r.from.phone, r.from.email].some((x) => x.toLowerCase().includes(words)))
      .map((r) => this.view(r))
      .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
        || (a.nextTask?.due ?? '9999').localeCompare(b.nextTask?.due ?? '9999') || b.lastAt.localeCompare(a.lastAt))
      .slice(0, q.limit ?? 200);
  }

  async get(tenantId: string, id: string): Promise<Inquiry | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? this.view(r) : null;
  }

  async create(tenantId: string, n: NewInquiry): Promise<string> {
    const id = `inq-${randomUUID()}`;
    const at = new Date().toISOString();
    this.rows.set(id, {
      id, tenantId, from: { ...n.from }, contactId: n.contactId, channel: n.channel, category: n.category, summary: n.summary, source: n.source,
      temperature: n.temperature, status: 'open', receivedBy: n.receivedBy, receivedByName: '', firstAt: at, lastAt: at,
      createdBy: n.createdBy, createdAt: at, updatedAt: at, idleNotifiedAt: null, lineUserId: n.lineUserId ?? null,
    });
    return id;
  }

  async update(tenantId: string, id: string, patch: InquiryPatch): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as Record<string, unknown>)[k] = k === 'from' ? { ...(v as InquiryParty) } : v;
    r.updatedAt = new Date().toISOString();
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId) return;
    this.rows.delete(id);
    for (let i = this.allEvents.length - 1; i >= 0; i--) if (this.allEvents[i]!.inquiryId === id) this.allEvents.splice(i, 1);
    for (let i = this.allTasks.length - 1; i >= 0; i--) if (this.allTasks[i]!.inquiryId === id) this.allTasks.splice(i, 1);
  }

  async addEvent(tenantId: string, inquiryId: string, e: NewInquiryEvent): Promise<string> {
    const id = `iqe-${randomUUID()}`;
    const now = new Date().toISOString();
    this.allEvents.push({
      id, tenantId, inquiryId, at: e.at ?? now, direction: e.direction, channel: e.channel, summary: e.summary, body: e.body,
      createdBy: e.createdBy, createdByName: '', createdAt: now, mail: e.mail ?? null,
    });
    return id;
  }

  async events(tenantId: string, inquiryId: string): Promise<InquiryEvent[]> {
    return this.allEvents.filter((e) => e.tenantId === tenantId && e.inquiryId === inquiryId).sort((a, b) => a.at.localeCompare(b.at) || a.createdAt.localeCompare(b.createdAt))
      .map(({ tenantId: _t, inquiryId: _i, createdAt: _c, ...e }) => e);
  }

  async addTask(tenantId: string, inquiryId: string, t: { assignee: string; what: string; due: string | null; createdBy: string; eventId?: string | null }): Promise<string> {
    const id = `iqt-${randomUUID()}`;
    this.allTasks.push({
      id, tenantId, inquiryId, assignee: t.assignee, assigneeName: '', what: t.what, due: t.due, doneAt: null, createdAt: new Date().toISOString(),
      notifiedBeforeAt: null, notifiedOverdueAt: null, eventId: t.eventId ?? null,
    });
    return id;
  }

  async event(tenantId: string, eventId: string): Promise<(InquiryEvent & { inquiryId: string }) | null> {
    const e = this.allEvents.find((x) => x.tenantId === tenantId && x.id === eventId);
    if (!e) return null;
    const { tenantId: _t, createdAt: _c, ...rest } = e;
    return rest;
  }

  async moveEvent(tenantId: string, eventId: string, toInquiryId: string): Promise<void> {
    for (const e of this.allEvents) if (e.tenantId === tenantId && e.id === eventId) e.inquiryId = toInquiryId;
    for (const t of this.allTasks) if (t.tenantId === tenantId && t.eventId === eventId) t.inquiryId = toInquiryId;
  }

  async tasks(tenantId: string, inquiryId: string): Promise<InquiryTask[]> {
    return this.allTasks.filter((t) => t.tenantId === tenantId && t.inquiryId === inquiryId)
      .map(({ tenantId: _t, inquiryId: _i, notifiedBeforeAt: _b, notifiedOverdueAt: _o, eventId: _e, ...t }) => t);
  }

  async task(tenantId: string, taskId: string): Promise<(InquiryTask & { inquiryId: string }) | null> {
    const t = this.allTasks.find((x) => x.tenantId === tenantId && x.id === taskId);
    if (!t) return null;
    const { tenantId: _t, notifiedBeforeAt: _b, notifiedOverdueAt: _o, eventId: _e, ...rest } = t;
    return rest;
  }

  async updateTask(tenantId: string, taskId: string, patch: Partial<{ assignee: string; what: string; due: string | null; done: boolean }>): Promise<void> {
    const t = this.allTasks.find((x) => x.tenantId === tenantId && x.id === taskId);
    if (!t) return;
    if (patch.assignee !== undefined) t.assignee = patch.assignee;
    if (patch.what !== undefined) t.what = patch.what;
    if (patch.due !== undefined) { t.due = patch.due; t.notifiedBeforeAt = null; t.notifiedOverdueAt = null; }
    if (patch.done !== undefined) t.doneAt = patch.done ? (t.doneAt ?? new Date().toISOString()) : null;
  }

  async dueTasks(tenantId: string, until: string): Promise<DueTask[]> {
    return this.allTasks.filter((t) => t.tenantId === tenantId && !t.doneAt && t.due && t.due <= until && this.rows.get(t.inquiryId)?.status === 'open')
      .map(({ tenantId: _t, eventId: _e, ...t }) => t);
  }

  async markNotified(tenantId: string, taskId: string, kind: 'before' | 'overdue'): Promise<void> {
    const t = this.allTasks.find((x) => x.tenantId === tenantId && x.id === taskId);
    if (t) t[kind === 'before' ? 'notifiedBeforeAt' : 'notifiedOverdueAt'] = new Date().toISOString();
  }

  async idle(tenantId: string, before: string): Promise<Inquiry[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.status === 'open' && r.lastAt < before && !r.idleNotifiedAt)
      .map((r) => this.view(r)).filter((r) => !r.nextTask);
  }

  async forgetBodies(tenantId: string, before: string): Promise<number> {
    let n = 0;
    for (const e of this.allEvents) if (e.tenantId === tenantId && e.body !== null && e.createdAt < before) { e.body = null; n += 1; }
    return n;
  }

  async seenMail(tenantId: string, messageIds: string[]): Promise<Set<string>> {
    return new Set(this.mails.filter((m) => m.tenantId === tenantId && messageIds.includes(m.messageId)).map((m) => m.messageId));
  }

  async logMail(tenantId: string, m: MailLog): Promise<void> {
    const i = this.mails.findIndex((x) => x.tenantId === tenantId && x.messageId === m.messageId);
    if (i >= 0) this.mails[i] = { ...this.mails[i]!, status: m.status, inquiryId: m.inquiryId, reason: m.reason };
    else this.mails.push({ ...m, tenantId });
  }

  async mailLog(tenantId: string, messageId: string): Promise<MailLog | null> {
    const m = this.mails.find((x) => x.tenantId === tenantId && x.messageId === messageId);
    if (!m) return null;
    const { tenantId: _t, ...rest } = m;
    return rest;
  }

  async inquiryOfThread(tenantId: string, threadId: string): Promise<string | null> {
    const hit = this.mails.filter((m) => m.tenantId === tenantId && m.threadId === threadId && m.status === 'inquiry' && m.inquiryId && this.rows.has(m.inquiryId))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
    return hit?.inquiryId ?? null;
  }

  async skippedMails(tenantId: string, limit = 100): Promise<InquiryMailSkipped[]> {
    return this.mails.filter((m) => m.tenantId === tenantId && m.status === 'skipped' && m.direction === 'in')
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit)
      .map((m) => ({ messageId: m.messageId, from: m.from, subject: m.subject, reason: m.reason, receivedAt: m.receivedAt }));
  }

  async mailCursor(tenantId: string): Promise<string | null> {
    return this.cursors.get(tenantId) ?? null;
  }

  async setMailCursor(tenantId: string, at: string): Promise<void> {
    this.cursors.set(tenantId, at);
  }

  async addReply(tenantId: string, r: NewReply): Promise<string> {
    const id = `iqr-${randomUUID()}`;
    this.allReplies.push({
      id, tenantId, inquiryId: r.inquiryId, channel: r.channel ?? 'mail', to: r.to, from: r.from, subject: r.subject, body: r.body, status: 'draft', runId: null,
      createdBy: r.createdBy, createdByName: '', createdAt: new Date().toISOString(), sentAt: null, replyToMessage: r.replyToMessage, threadId: r.threadId,
    });
    return id;
  }

  async replies(tenantId: string, inquiryId: string): Promise<InquiryReply[]> {
    return this.allReplies.filter((r) => r.tenantId === tenantId && r.inquiryId === inquiryId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ tenantId: _t, replyToMessage: _m, threadId: _h, ...r }) => r);
  }

  async reply(tenantId: string, id: string): Promise<StoredReply | null> {
    const r = this.allReplies.find((x) => x.tenantId === tenantId && x.id === id);
    if (!r) return null;
    const { tenantId: _t, ...rest } = r;
    return rest;
  }

  async updateReply(tenantId: string, id: string, patch: Parameters<InquiryStore['updateReply']>[2]): Promise<void> {
    const r = this.allReplies.find((x) => x.tenantId === tenantId && x.id === id);
    if (!r) return;
    const { sentMessageId: _s, ...rest } = patch;
    Object.assign(r, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
  }

  async deleteReply(tenantId: string, id: string): Promise<void> {
    const i = this.allReplies.findIndex((x) => x.tenantId === tenantId && x.id === id);
    if (i >= 0) this.allReplies.splice(i, 1);
  }

  async waitingReplies(tenantId: string, limit = 50): Promise<Inquiry[]> {
    const out: Inquiry[] = [];
    for (const r of this.rows.values()) {
      if (r.tenantId !== tenantId || r.status !== 'open') continue;
      const last = this.allEvents.filter((e) => e.tenantId === tenantId && e.inquiryId === r.id).sort((a, b) => b.at.localeCompare(a.at) || b.createdAt.localeCompare(a.createdAt))[0];
      if (last && last.direction === 'in' && ['mail', 'form', 'line'].includes(last.channel)) out.push(this.view(r));
    }
    return out.sort((a, b) => a.lastAt.localeCompare(b.lastAt)).slice(0, limit);
  }

  async monthRows(tenantId: string, from: string, to: string): Promise<MonthRow[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.firstAt >= from && r.firstAt < to).map((r) => {
      const first = this.allEvents.filter((e) => e.inquiryId === r.id).sort((a, b) => a.at.localeCompare(b.at))[0];
      return { channel: r.channel, source: r.source, category: r.category, temperature: r.temperature, mailTo: first?.mail?.to ?? null };
    });
  }

  async saveReview(tenantId: string, stats: InquiryMonthStats): Promise<boolean> {
    const key = `${tenantId}:${stats.month}`;
    if (this.reviews.has(key)) return false;
    this.reviews.set(key, stats);
    return true;
  }

  async lineTenantOf(hash: string): Promise<string | null> {
    for (const [tenantId, h] of this.lineHooks) if (h === hash) return tenantId;
    return null;
  }

  async setLineHook(tenantId: string, hash: string): Promise<void> {
    this.lineHooks.set(tenantId, hash);
  }

  async deleteLineHook(tenantId: string): Promise<void> {
    this.lineHooks.delete(tenantId);
  }

  async lineUser(tenantId: string, lineUserId: string): Promise<LineUser | null> {
    const u = this.lineUsers.get(`${tenantId}:${lineUserId}`);
    return u ? { ...u } : null;
  }

  async saveLineUser(tenantId: string, u: LineUser): Promise<void> {
    this.lineUsers.set(`${tenantId}:${u.lineUserId}`, { ...u });
  }

  async lineUserIdOf(tenantId: string, inquiryId: string): Promise<string | null> {
    const r = this.rows.get(inquiryId);
    return r && r.tenantId === tenantId ? r.lineUserId ?? null : null;
  }

  async takeLineEvent(tenantId: string, eventId: string): Promise<boolean> {
    const key = `${tenantId}:${eventId}`;
    if (this.lineEvents.has(key)) return false;
    this.lineEvents.add(key);
    return true;
  }
}
