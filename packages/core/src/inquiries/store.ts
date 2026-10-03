/**
 * @file 問い合わせの記録の置き場（仕様書 第33.13節・第33.17節、移行 065）。PostgreSQL と、自動テスト用のメモリの 2 つ。
 *
 * 問い合わせは利用範囲の中で会社で共有する。会社の境界はデータベースの行単位の制限でも効く。
 * 利用者の名前は置き場では持たず、処理（InquiryService）が埋める。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  Inquiry, InquiryChannel, InquiryEvent, InquiryParty, InquiryStatus, InquiryTask, InquiryTemperature,
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
}

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
         temperature, received_by, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, tenantId, n.from.name, n.from.company, n.from.phone, n.from.email, n.contactId, n.channel, n.category, n.summary, n.source,
        n.temperature, n.receivedBy, n.createdBy]);
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
      `insert into inquiry_events (id, tenant_id, inquiry_id, at, direction, channel, summary, body, created_by)
       values ($1, $2, $3, coalesce($4::timestamptz, now()), $5, $6, $7, $8, $9)`,
      [id, tenantId, inquiryId, e.at ?? null, e.direction, e.channel, e.summary, e.body, e.createdBy]);
    return id;
  }

  async events(tenantId: string, inquiryId: string): Promise<InquiryEvent[]> {
    const rows = await this.q<EventRow>(tenantId,
      `select id, at, direction, channel, summary, body, created_by from inquiry_events where tenant_id = $1 and inquiry_id = $2 order by at asc, created_at asc`,
      [tenantId, inquiryId]);
    return rows.map((r) => ({
      id: r.id, at: iso(r.at), direction: r.direction, channel: r.channel, summary: r.summary, body: r.body, createdBy: r.created_by, createdByName: '',
    }));
  }

  async addTask(tenantId: string, inquiryId: string, t: { assignee: string; what: string; due: string | null; createdBy: string; eventId?: string | null }): Promise<string> {
    const id = `iqt-${randomUUID()}`;
    await this.q(tenantId,
      `insert into inquiry_tasks (id, tenant_id, inquiry_id, assignee, what, due, created_by, event_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, inquiryId, t.assignee, t.what, t.due, t.createdBy, t.eventId ?? null]);
    return id;
  }

  async event(tenantId: string, eventId: string): Promise<(InquiryEvent & { inquiryId: string }) | null> {
    const rows = await this.q<EventRow & { inquiry_id: string }>(tenantId,
      `select id, inquiry_id, at, direction, channel, summary, body, created_by from inquiry_events where tenant_id = $1 and id = $2`, [tenantId, eventId]);
    const r = rows[0];
    return r ? {
      id: r.id, inquiryId: r.inquiry_id, at: iso(r.at), direction: r.direction, channel: r.channel, summary: r.summary, body: r.body,
      createdBy: r.created_by, createdByName: '',
    } : null;
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
}

/** 自動テスト用のメモリの置き場。 */
export class MemoryInquiryStore implements InquiryStore {
  readonly rows = new Map<string, Omit<Inquiry, 'nextTask'> & { tenantId: string; idleNotifiedAt: string | null }>();
  readonly allEvents: (InquiryEvent & { tenantId: string; inquiryId: string; createdAt: string })[] = [];
  readonly allTasks: (DueTask & { tenantId: string; eventId: string | null })[] = [];

  private next(tenantId: string, id: string): InquiryTask | null {
    const open = this.allTasks.filter((t) => t.tenantId === tenantId && t.inquiryId === id && !t.doneAt)
      .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.createdAt.localeCompare(b.createdAt));
    const t = open[0];
    return t ? { id: t.id, assignee: t.assignee, assigneeName: '', what: t.what, due: t.due, doneAt: null, createdAt: t.createdAt } : null;
  }

  private view(r: Omit<Inquiry, 'nextTask'> & { tenantId: string; idleNotifiedAt: string | null }): Inquiry {
    const { tenantId, idleNotifiedAt: _i, ...rest } = r;
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
      createdBy: n.createdBy, createdAt: at, updatedAt: at, idleNotifiedAt: null,
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
      createdBy: e.createdBy, createdByName: '', createdAt: now,
    });
    return id;
  }

  async events(tenantId: string, inquiryId: string): Promise<InquiryEvent[]> {
    return this.allEvents.filter((e) => e.tenantId === tenantId && e.inquiryId === inquiryId).sort((a, b) => a.at.localeCompare(b.at))
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
}
