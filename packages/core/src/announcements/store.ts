/**
 * @file お知らせの作成の置き場（仕様書 第35.13節・第35.17節）。お知らせと、出し先ごとの結果。
 *
 * PostgreSQL では行ごとのセキュリティで会社を分ける（不変則 I-2）。自動テスト用にメモリの置き場も持つ。
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { AnnouncementChannel, AnnouncementOutput, AnnouncementStatus, AnnouncementTexts } from '@m2office/shared';

/** 置き場のお知らせ（承認した指紋を含む）。 */
export interface StoredAnnouncement {
  id: string;
  title: string;
  body: string;
  startDate: string | null;
  endDate: string | null;
  publishAt: string | null;
  status: AnnouncementStatus;
  channels: AnnouncementChannel[];
  texts: AnnouncementTexts;
  mailContactIds: string[];
  approvedDigest: string | null;
  runId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  endedAt: string | null;
}

/** 新しいお知らせ。 */
export type NewAnnouncement = Pick<StoredAnnouncement, 'title' | 'body' | 'startDate' | 'endDate' | 'publishAt' | 'channels' | 'texts' | 'mailContactIds' | 'createdBy'>;

/** 直せる項目。 */
export type AnnouncementPatch = Partial<Pick<StoredAnnouncement, 'title' | 'body' | 'startDate' | 'endDate' | 'publishAt' | 'status' | 'channels' | 'texts' | 'mailContactIds' | 'approvedDigest' | 'runId' | 'publishedAt' | 'endedAt'>>;

/** お知らせの置き場。 */
export interface AnnouncementStore {
  list(tenantId: string, limit: number): Promise<StoredAnnouncement[]>;
  get(tenantId: string, id: string): Promise<StoredAnnouncement | null>;
  create(tenantId: string, a: NewAnnouncement): Promise<string>;
  update(tenantId: string, id: string, patch: AnnouncementPatch): Promise<void>;
  remove(tenantId: string, id: string): Promise<boolean>;
  outputs(tenantId: string, id: string): Promise<AnnouncementOutput[]>;
  setOutput(tenantId: string, id: string, channel: AnnouncementChannel, o: Omit<AnnouncementOutput, 'channel'>): Promise<void>;
  /** 予約の日時が来たもの */
  due(tenantId: string, now: string): Promise<StoredAnnouncement[]>;
  /** 出したもの（期間の後の扱いを確かめる） */
  published(tenantId: string): Promise<StoredAnnouncement[]>;
  /** 休業の期間を覚える（休業のお知らせを出したとき。第35.7節）。同じお知らせの期間は置き換える */
  addClosure(tenantId: string, announcementId: string, startDate: string, endDate: string): Promise<void>;
  /** その日（YYYY-MM-DD）が休業の期間に入るか */
  closedOn(tenantId: string, day: string): Promise<boolean>;
  /** その日（YYYY-MM-DD）を含む休業の期間。無ければ `null` */
  closureOn(tenantId: string, day: string): Promise<{ startDate: string; endDate: string } | null>;
  /** その日より後に終わる休業の期間（近い順） */
  closuresFrom(tenantId: string, day: string): Promise<{ startDate: string; endDate: string }[]>;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** 段 1 で作ったお知らせ（メールの文が無い）にも、メールの文を足して返す。 */
/** 前の版で作ったお知らせの文をそろえる（メールの文・サイネージの説明と帯の色が無いもの）。 */
const withMail = (t: AnnouncementTexts, title: string, body: string): AnnouncementTexts => ({
  ...t,
  mail: t.mail ?? { subject: title, body },
  signage: { ...t.signage, detail: t.signage?.detail ?? '', color: t.signage?.color ?? '' },
});
const day = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) : null);

interface Row {
  id: string; title: string; body: string; start_date: Date | string | null; end_date: Date | string | null; publish_at: Date | string | null;
  status: AnnouncementStatus; channels: AnnouncementChannel[]; texts: AnnouncementTexts; mail_contact_ids: string[] | null; approved_digest: string | null; run_id: string | null;
  created_by: string; created_at: Date | string; updated_at: Date | string; published_at: Date | string | null; ended_at: Date | string | null;
}

function toAnnouncement(r: Row): StoredAnnouncement {
  return {
    id: r.id, title: r.title, body: r.body, startDate: day(r.start_date), endDate: day(r.end_date), publishAt: iso(r.publish_at), status: r.status,
    channels: r.channels ?? [], texts: withMail(r.texts, r.title, r.body), mailContactIds: r.mail_contact_ids ?? [], approvedDigest: r.approved_digest, runId: r.run_id, createdBy: r.created_by,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, publishedAt: iso(r.published_at), endedAt: iso(r.ended_at),
  };
}

/** PostgreSQL の置き場。 */
export class PostgresAnnouncementStore implements AnnouncementStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 4, name: 'announcements' });
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

  async list(tenantId: string, limit: number): Promise<StoredAnnouncement[]> {
    return (await this.q<Row>(tenantId, `select id, title, body, start_date::text, end_date::text, publish_at, status, channels, texts, mail_contact_ids, approved_digest, run_id,
      created_by, created_at, updated_at, published_at, ended_at from announcements where tenant_id = $1 order by created_at desc limit $2`, [tenantId, limit])).map(toAnnouncement);
  }

  async get(tenantId: string, id: string): Promise<StoredAnnouncement | null> {
    const rows = await this.q<Row>(tenantId, `select id, title, body, start_date::text, end_date::text, publish_at, status, channels, texts, mail_contact_ids, approved_digest, run_id,
      created_by, created_at, updated_at, published_at, ended_at from announcements where tenant_id = $1 and id = $2`, [tenantId, id]);
    return rows[0] ? toAnnouncement(rows[0]) : null;
  }

  async create(tenantId: string, a: NewAnnouncement): Promise<string> {
    const id = `ann-${randomUUID()}`;
    await this.q(tenantId, `insert into announcements (id, tenant_id, title, body, start_date, end_date, publish_at, channels, texts, mail_contact_ids, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, tenantId, a.title, a.body, a.startDate, a.endDate, a.publishAt, a.channels, JSON.stringify(a.texts), a.mailContactIds, a.createdBy]);
    return id;
  }

  async update(tenantId: string, id: string, patch: AnnouncementPatch): Promise<void> {
    const cols: Record<string, string> = {
      title: 'title', body: 'body', startDate: 'start_date', endDate: 'end_date', publishAt: 'publish_at', status: 'status', channels: 'channels',
      texts: 'texts', mailContactIds: 'mail_contact_ids', approvedDigest: 'approved_digest', runId: 'run_id', publishedAt: 'published_at', endedAt: 'ended_at',
    };
    const sets = ['updated_at = now()'];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      params.push(k === 'texts' ? JSON.stringify(v) : v);
      // 列名は上の固定の対応表からのみ取る
      sets.push(`${cols[k]} = $${params.length}`);
    }
    await this.q(tenantId, `update announcements set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    return (await this.q<{ id: string }>(tenantId, 'delete from announcements where tenant_id = $1 and id = $2 returning id', [tenantId, id])).length > 0;
  }

  async outputs(tenantId: string, id: string): Promise<AnnouncementOutput[]> {
    const rows = await this.q<{ channel: AnnouncementChannel; status: AnnouncementOutput['status']; result: AnnouncementOutput['result']; reason: string; done_at: Date | string | null }>(tenantId,
      'select channel, status, result, reason, done_at from announcement_outputs where tenant_id = $1 and announcement_id = $2 order by channel', [tenantId, id]);
    return rows.map((r) => ({ channel: r.channel, status: r.status, result: r.result ?? {}, reason: r.reason, doneAt: iso(r.done_at) }));
  }

  async setOutput(tenantId: string, id: string, channel: AnnouncementChannel, o: Omit<AnnouncementOutput, 'channel'>): Promise<void> {
    await this.q(tenantId, `insert into announcement_outputs (tenant_id, announcement_id, channel, status, result, reason, done_at) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (announcement_id, channel) do update set status = excluded.status, result = excluded.result, reason = excluded.reason, done_at = excluded.done_at`,
    [tenantId, id, channel, o.status, JSON.stringify(o.result), o.reason, o.doneAt]);
  }

  async due(tenantId: string, now: string): Promise<StoredAnnouncement[]> {
    return (await this.q<Row>(tenantId, `select id, title, body, start_date::text, end_date::text, publish_at, status, channels, texts, mail_contact_ids, approved_digest, run_id,
      created_by, created_at, updated_at, published_at, ended_at from announcements where tenant_id = $1 and status = 'scheduled' and publish_at <= $2`, [tenantId, now])).map(toAnnouncement);
  }

  async published(tenantId: string): Promise<StoredAnnouncement[]> {
    return (await this.q<Row>(tenantId, `select id, title, body, start_date::text, end_date::text, publish_at, status, channels, texts, mail_contact_ids, approved_digest, run_id,
      created_by, created_at, updated_at, published_at, ended_at from announcements where tenant_id = $1 and status = 'published'`, [tenantId])).map(toAnnouncement);
  }

  async addClosure(tenantId: string, announcementId: string, startDate: string, endDate: string): Promise<void> {
    await this.q(tenantId, 'delete from business_closures where tenant_id = $1 and announcement_id = $2', [tenantId, announcementId]);
    await this.q(tenantId, 'insert into business_closures (id, tenant_id, start_date, end_date, announcement_id) values ($1, $2, $3, $4, $5)',
      [`clo-${randomUUID()}`, tenantId, startDate, endDate, announcementId]);
  }

  async closedOn(tenantId: string, day: string): Promise<boolean> {
    return (await this.closureOn(tenantId, day)) !== null;
  }

  async closureOn(tenantId: string, day: string): Promise<{ startDate: string; endDate: string } | null> {
    const rows = await this.q<{ start_date: string; end_date: string }>(tenantId,
      'select start_date::text, end_date::text from business_closures where tenant_id = $1 and start_date <= $2 and end_date >= $2 order by end_date desc limit 1', [tenantId, day]);
    return rows[0] ? { startDate: rows[0].start_date, endDate: rows[0].end_date } : null;
  }

  async closuresFrom(tenantId: string, day: string): Promise<{ startDate: string; endDate: string }[]> {
    const rows = await this.q<{ start_date: string; end_date: string }>(tenantId,
      'select start_date::text, end_date::text from business_closures where tenant_id = $1 and end_date >= $2 order by start_date limit 20', [tenantId, day]);
    return rows.map((r) => ({ startDate: r.start_date, endDate: r.end_date }));
  }
}

/** メモリの置き場（自動テスト用）。 */
export class MemoryAnnouncementStore implements AnnouncementStore {
  private rows: (StoredAnnouncement & { tenantId: string })[] = [];
  private outs: (AnnouncementOutput & { tenantId: string; id: string })[] = [];

  private strip(r: StoredAnnouncement & { tenantId: string }): StoredAnnouncement {
    const { tenantId: _t, ...rest } = r;
    return { ...rest, channels: [...rest.channels], texts: structuredClone(rest.texts), mailContactIds: [...rest.mailContactIds] };
  }

  async list(tenantId: string, limit: number) {
    return this.rows.filter((r) => r.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((r) => this.strip(r));
  }

  async get(tenantId: string, id: string) {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id);
    return r ? this.strip(r) : null;
  }

  async create(tenantId: string, a: NewAnnouncement) {
    const id = `ann-${randomUUID()}`;
    const now = new Date(Date.now() + this.rows.length).toISOString();
    this.rows.push({ ...a, texts: structuredClone(a.texts), mailContactIds: [...(a.mailContactIds ?? [])], id, tenantId, status: 'draft', approvedDigest: null, runId: null, createdAt: now, updatedAt: now, publishedAt: null, endedAt: null });
    return id;
  }

  async update(tenantId: string, id: string, patch: AnnouncementPatch) {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id);
    if (!r) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = k === 'texts' ? structuredClone(v) : v;
    r.updatedAt = new Date().toISOString();
  }

  async remove(tenantId: string, id: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((x) => !(x.tenantId === tenantId && x.id === id));
    return before !== this.rows.length;
  }

  async outputs(tenantId: string, id: string) {
    return this.outs.filter((o) => o.tenantId === tenantId && o.id === id).map(({ tenantId: _t, id: _i, ...o }) => ({ ...o, result: { ...o.result } }));
  }

  async setOutput(tenantId: string, id: string, channel: AnnouncementChannel, o: Omit<AnnouncementOutput, 'channel'>) {
    this.outs = this.outs.filter((x) => !(x.tenantId === tenantId && x.id === id && x.channel === channel));
    this.outs.push({ ...o, channel, tenantId, id });
  }

  async due(tenantId: string, now: string) {
    return this.rows.filter((r) => r.tenantId === tenantId && r.status === 'scheduled' && r.publishAt !== null && r.publishAt <= now).map((r) => this.strip(r));
  }

  async published(tenantId: string) {
    return this.rows.filter((r) => r.tenantId === tenantId && r.status === 'published').map((r) => this.strip(r));
  }

  private closures: { tenantId: string; announcementId: string; startDate: string; endDate: string }[] = [];

  async addClosure(tenantId: string, announcementId: string, startDate: string, endDate: string) {
    this.closures = this.closures.filter((c) => !(c.tenantId === tenantId && c.announcementId === announcementId));
    this.closures.push({ tenantId, announcementId, startDate, endDate });
  }

  async closedOn(tenantId: string, day: string) {
    return (await this.closureOn(tenantId, day)) !== null;
  }

  async closureOn(tenantId: string, day: string) {
    const c = this.closures.find((x) => x.tenantId === tenantId && x.startDate <= day && x.endDate >= day);
    return c ? { startDate: c.startDate, endDate: c.endDate } : null;
  }

  async closuresFrom(tenantId: string, day: string) {
    return this.closures.filter((c) => c.tenantId === tenantId && c.endDate >= day).sort((a, b) => a.startDate.localeCompare(b.startDate))
      .map((c) => ({ startDate: c.startDate, endDate: c.endDate }));
  }
}
