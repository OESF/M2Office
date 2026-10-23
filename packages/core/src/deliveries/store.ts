/**
 * @file 外部のアプリからの配信の依頼（仕様書 第13.4.4節）の置き場。配信と宛先と配信の停止と、窓口のアカウントの受信を読んだ位置。
 *
 * 宛先の名前とアドレスは暗号化したもの（`contactEnc`）だけを持ち、その人に送り終えたら消す。送れなかった知らせと停止の返信を
 * 照らすため、アドレスの SHA-256（`emailHash`）を `hashUntil` まで並べて持つ。結果と停止には通し番号を付け、アプリが取りに来る印にする。
 * PostgreSQL の置き場は、問い合わせごとに `app.tenant_id` を設定する（行単位の制限。移行 157）。
 */

import type pg from 'pg';
import type { DeliveryChannel, DeliveryFailReason, DeliveryResultStatus, DeliveryStatus } from '@m2office/shared';
import { createPool } from '../repository/pool.js';

/** 配信の記録（宛先は持たない）。 */
export interface DeliveryRecord {
  id: string;
  appId: string;
  requestId: string;
  title: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  sendAt: string | null;
  subject: string;
  html: string;
  text: string;
  values: Record<string, string>;
  logo: { contentType: string; base64: string; cid: string } | null;
  runId: string | null;
  total: number;
  /** テスト送信（`test: true`）。結果を持たない。 */
  test: boolean;
  createdAt: string;
  finishedAt: string | null;
  purgeAfter: string | null;
  purged: boolean;
}

/** 宛先 1 人の記録。 */
export interface RecipientRecord {
  deliveryId: string;
  recipientId: string;
  /** 名前とアドレス（JSON を暗号化したもの）。送り終えたら `null`。 */
  contactEnc: string | null;
  /** アドレスの SHA-256（小文字にしてから）。`hashUntil` を過ぎたら `null`。 */
  emailHash: string | null;
  hashUntil: string | null;
  status: 'pending' | DeliveryResultStatus;
  reason: DeliveryFailReason | null;
  stopChannel: 'mail' | 'line' | 'all' | null;
  at: string | null;
  nextSendAt: string | null;
  /** 結果の通し番号（結果が変わるたびに付け直す）。まだ結果が無ければ `null`。 */
  resultSeq: number | null;
}

/** 宛先の結果を決めるときに書くもの。 */
export interface RecipientResult {
  status: DeliveryResultStatus;
  reason?: DeliveryFailReason | null;
  stopChannel?: 'mail' | 'line' | 'all' | null;
  at: string;
  /** 名前とアドレスを消す（送り終えた）。 */
  clearContact?: boolean;
  /** 照合の値を持つ期限（`null` なら今消す。渡さなければ変えない）。 */
  hashUntil?: string | null;
}

/** 配信の停止 1 件。宛先の ID が読めなかったものだけ `emailEnc`（差出人のアドレスを暗号化したもの）。 */
export interface StopRecord {
  seq: number;
  appId: string;
  deliveryId: string | null;
  recipientId: string | null;
  emailEnc: string | null;
  channel: 'mail';
  at: string;
}

/** 宛先の数（状態ごと）。 */
export interface RecipientCounts { pending: number; sent: number; failed: number; stopped: number }

/** 配信の置き場。 */
export interface DeliveryStore {
  /** 配信と宛先を入れる。同じアプリの同じ依頼の番号がすでにあれば入れずに `false`。 */
  create(tenantId: string, d: DeliveryRecord, recipients: RecipientRecord[]): Promise<boolean>;
  get(tenantId: string, id: string): Promise<DeliveryRecord | null>;
  /** アプリの依頼の番号から引く。 */
  byRequest(tenantId: string, appId: string, requestId: string): Promise<DeliveryRecord | null>;
  update(tenantId: string, id: string, patch: Partial<Omit<DeliveryRecord, 'id' | 'appId' | 'requestId'>>): Promise<void>;
  /** 新しい順。 */
  list(tenantId: string, opts?: { appId?: string; limit?: number }): Promise<DeliveryRecord[]>;
  /** 結果を消していない配信（古い順）。 */
  active(tenantId: string): Promise<DeliveryRecord[]>;
  /** 送る時が来た、まだ送っていない宛先を 1 人。 */
  nextRecipient(tenantId: string, deliveryId: string, now: string): Promise<RecipientRecord | null>;
  /** 送り直しの時刻を決める（結果は変えない）。 */
  retryLater(tenantId: string, deliveryId: string, recipientId: string, nextSendAt: string): Promise<void>;
  /** 結果を決め、新しい通し番号を付ける。 */
  setResult(tenantId: string, deliveryId: string, recipientId: string, r: RecipientResult): Promise<void>;
  counts(tenantId: string, deliveryId: string): Promise<RecipientCounts>;
  /** 通し番号が `after` より後の結果（番号の順。送っていない宛先は除く）。 */
  results(tenantId: string, deliveryId: string, after: number, limit: number): Promise<RecipientRecord[]>;
  /** まだ送っていない宛先をすべて、この理由で送れなかったにする（名前とアドレスと照合の値も消す）。 */
  failPending(tenantId: string, deliveryId: string, reason: DeliveryFailReason, at: string): Promise<number>;
  /** 照合の値に当たる宛先（期限の内のもの）。 */
  findByHash(tenantId: string, emailHash: string, now: string): Promise<(RecipientRecord & { appId: string })[]>;
  /** 宛先の ID に当たる宛先（結果を消していない配信のもの）。 */
  findRecipient(tenantId: string, recipientId: string): Promise<(RecipientRecord & { appId: string })[]>;
  /** 停止を入れる。同じアプリの同じ出どころ（`source`）がすでにあれば入れずに `false`。 */
  addStop(tenantId: string, s: Omit<StopRecord, 'seq'> & { source: string }): Promise<boolean>;
  /** 通し番号が `after` より後のそのアプリの停止（番号の順）。 */
  stops(tenantId: string, appId: string, after: number, limit: number): Promise<StopRecord[]>;
  /** この時刻より後に配信を頼んだアプリ。 */
  recentApps(tenantId: string, since: string): Promise<string[]>;
  /** 窓口のアカウントの受信を読んだ位置。 */
  mailCursor(tenantId: string): Promise<string | null>;
  setMailCursor(tenantId: string, at: string): Promise<void>;
  /** 期限を過ぎた照合の値を消し、結果を消す時刻を過ぎた配信の宛先と、`stopsBefore` より前の停止を消す。消した配信の数。 */
  purge(tenantId: string, now: string, stopsBefore: string): Promise<number>;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

interface DeliveryRow {
  id: string; app_id: string; request_id: string; title: string; channel: DeliveryChannel; status: DeliveryStatus; send_at: unknown; subject: string; html: string;
  body_text: string; values: Record<string, string> | null; logo: DeliveryRecord['logo']; run_id: string | null; total: number; test: boolean | null;
  created_at: unknown; finished_at: unknown; purge_after: unknown; purged: boolean;
}
const toDelivery = (r: DeliveryRow): DeliveryRecord => ({
  id: r.id, appId: r.app_id, requestId: r.request_id, title: r.title, channel: r.channel, status: r.status, sendAt: isoOrNull(r.send_at), subject: r.subject,
  html: r.html, text: r.body_text, values: r.values ?? {}, logo: r.logo, runId: r.run_id, total: r.total, test: !!r.test, createdAt: iso(r.created_at),
  finishedAt: isoOrNull(r.finished_at), purgeAfter: isoOrNull(r.purge_after), purged: r.purged,
});

interface RecipientRow {
  delivery_id: string; recipient_id: string; contact_enc: string | null; email_hash: string | null; hash_until: unknown; status: RecipientRecord['status'];
  reason: DeliveryFailReason | null; stop_channel: RecipientRecord['stopChannel']; at: unknown; next_send_at: unknown; result_seq: string | number | null; app_id?: string;
}
const toRecipient = (r: RecipientRow): RecipientRecord => ({
  deliveryId: r.delivery_id, recipientId: r.recipient_id, contactEnc: r.contact_enc, emailHash: r.email_hash, hashUntil: isoOrNull(r.hash_until), status: r.status,
  reason: r.reason, stopChannel: r.stop_channel, at: isoOrNull(r.at), nextSendAt: isoOrNull(r.next_send_at), resultSeq: r.result_seq === null ? null : Number(r.result_seq),
});

interface StopRow { seq: string | number; app_id: string; delivery_id: string | null; recipient_id: string | null; email_enc: string | null; at: unknown }
const toStop = (r: StopRow): StopRecord => ({
  seq: Number(r.seq), appId: r.app_id, deliveryId: r.delivery_id, recipientId: r.recipient_id, emailEnc: r.email_enc, channel: 'mail', at: iso(r.at),
});

const DELIVERY_COLS: Record<string, string> = {
  title: 'title', channel: 'channel', status: 'status', sendAt: 'send_at', subject: 'subject', html: 'html', text: 'body_text', values: 'values', logo: 'logo',
  runId: 'run_id', total: 'total', test: 'test', finishedAt: 'finished_at', purgeAfter: 'purge_after', purged: 'purged',
};

/** PostgreSQL の配信の置き場。 */
export class PostgresDeliveryStore implements DeliveryStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'deliveries' });
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

  async create(tenantId: string, d: DeliveryRecord, recipients: RecipientRecord[]): Promise<boolean> {
    return this.tx(tenantId, async (c) => {
      const r = await c.query(
        `insert into deliveries (id, tenant_id, app_id, request_id, title, channel, status, send_at, subject, html, body_text, "values", logo, run_id, total, test, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         on conflict (tenant_id, app_id, request_id) do nothing returning id`,
        [d.id, tenantId, d.appId, d.requestId, d.title, d.channel, d.status, d.sendAt, d.subject, d.html, d.text, JSON.stringify(d.values),
          d.logo ? JSON.stringify(d.logo) : null, d.runId, d.total, d.test, d.createdAt]);
      if (r.rowCount !== 1) return false;
      for (const x of recipients) {
        await c.query(
          `insert into delivery_recipients (tenant_id, delivery_id, recipient_id, contact_enc, email_hash, hash_until, status, reason, at, result_seq)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $7 = 'pending' then null else nextval('delivery_result_seq') end)`,
          [tenantId, d.id, x.recipientId, x.contactEnc, x.emailHash, x.hashUntil, x.status, x.reason, x.at]);
      }
      return true;
    });
  }

  async get(tenantId: string, id: string): Promise<DeliveryRecord | null> {
    const [r] = await this.q<DeliveryRow>(tenantId, 'select * from deliveries where tenant_id = $1 and id = $2', [tenantId, id]);
    return r ? toDelivery(r) : null;
  }

  async byRequest(tenantId: string, appId: string, requestId: string): Promise<DeliveryRecord | null> {
    const [r] = await this.q<DeliveryRow>(tenantId, 'select * from deliveries where tenant_id = $1 and app_id = $2 and request_id = $3', [tenantId, appId, requestId]);
    return r ? toDelivery(r) : null;
  }

  async update(tenantId: string, id: string, patch: Partial<Omit<DeliveryRecord, 'id' | 'appId' | 'requestId'>>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId, id];
    for (const [k, v] of Object.entries(patch)) {
      const col = DELIVERY_COLS[k];
      if (!col || v === undefined) continue;
      params.push(k === 'values' || k === 'logo' ? (v === null ? null : JSON.stringify(v)) : v);
      sets.push(`"${col}" = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.q(tenantId, `update deliveries set ${sets.join(', ')} where tenant_id = $1 and id = $2`, params);
  }

  async list(tenantId: string, opts: { appId?: string; limit?: number } = {}): Promise<DeliveryRecord[]> {
    const rows = await this.q<DeliveryRow>(tenantId,
      `select * from deliveries where tenant_id = $1 and ($2::text is null or app_id = $2) order by created_at desc limit $3`, [tenantId, opts.appId ?? null, opts.limit ?? 50]);
    return rows.map(toDelivery);
  }

  async active(tenantId: string): Promise<DeliveryRecord[]> {
    const rows = await this.q<DeliveryRow>(tenantId, `select * from deliveries where tenant_id = $1 and purged = false order by created_at`, [tenantId]);
    return rows.map(toDelivery);
  }

  async nextRecipient(tenantId: string, deliveryId: string, now: string): Promise<RecipientRecord | null> {
    const [r] = await this.q<RecipientRow>(tenantId,
      `select * from delivery_recipients where tenant_id = $1 and delivery_id = $2 and status = 'pending' and (next_send_at is null or next_send_at <= $3)
        order by recipient_id limit 1`, [tenantId, deliveryId, now]);
    return r ? toRecipient(r) : null;
  }

  async retryLater(tenantId: string, deliveryId: string, recipientId: string, nextSendAt: string): Promise<void> {
    await this.q(tenantId, `update delivery_recipients set next_send_at = $4 where tenant_id = $1 and delivery_id = $2 and recipient_id = $3`,
      [tenantId, deliveryId, recipientId, nextSendAt]);
  }

  async setResult(tenantId: string, deliveryId: string, recipientId: string, r: RecipientResult): Promise<void> {
    const params: unknown[] = [tenantId, deliveryId, recipientId, r.status, r.reason ?? null, r.stopChannel ?? null, r.at];
    const sets = [`status = $4`, `reason = $5`, `stop_channel = $6`, `at = $7`, `result_seq = nextval('delivery_result_seq')`];
    if (r.clearContact) sets.push('contact_enc = null');
    if (r.hashUntil === null) sets.push('email_hash = null', 'hash_until = null');
    else if (r.hashUntil !== undefined) { params.push(r.hashUntil); sets.push(`hash_until = $${params.length}`); }
    await this.q(tenantId, `update delivery_recipients set ${sets.join(', ')} where tenant_id = $1 and delivery_id = $2 and recipient_id = $3`, params);
  }

  async counts(tenantId: string, deliveryId: string): Promise<RecipientCounts> {
    const [r] = await this.q<RecipientCounts>(tenantId,
      `select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'sent')::int as sent,
              count(*) filter (where status = 'failed')::int as failed, count(*) filter (where status = 'stopped')::int as stopped
         from delivery_recipients where tenant_id = $1 and delivery_id = $2`, [tenantId, deliveryId]);
    return r ?? { pending: 0, sent: 0, failed: 0, stopped: 0 };
  }

  async results(tenantId: string, deliveryId: string, after: number, limit: number): Promise<RecipientRecord[]> {
    const rows = await this.q<RecipientRow>(tenantId,
      `select * from delivery_recipients where tenant_id = $1 and delivery_id = $2 and result_seq is not null and result_seq > $3 order by result_seq limit $4`,
      [tenantId, deliveryId, after, limit]);
    return rows.map(toRecipient);
  }

  async failPending(tenantId: string, deliveryId: string, reason: DeliveryFailReason, at: string): Promise<number> {
    const rows = await this.q<{ recipient_id: string }>(tenantId,
      `update delivery_recipients set status = 'failed', reason = $3, at = $4, result_seq = nextval('delivery_result_seq'),
              contact_enc = null, email_hash = null, hash_until = null
        where tenant_id = $1 and delivery_id = $2 and status = 'pending' returning recipient_id`, [tenantId, deliveryId, reason, at]);
    return rows.length;
  }

  async findByHash(tenantId: string, emailHash: string, now: string): Promise<(RecipientRecord & { appId: string })[]> {
    const rows = await this.q<RecipientRow>(tenantId,
      `select r.*, d.app_id from delivery_recipients r join deliveries d on d.tenant_id = r.tenant_id and d.id = r.delivery_id
        where r.tenant_id = $1 and r.email_hash = $2 and r.hash_until > $3 and d.purged = false`, [tenantId, emailHash, now]);
    return rows.map((r) => ({ ...toRecipient(r), appId: r.app_id! }));
  }

  async findRecipient(tenantId: string, recipientId: string): Promise<(RecipientRecord & { appId: string })[]> {
    const rows = await this.q<RecipientRow>(tenantId,
      `select r.*, d.app_id from delivery_recipients r join deliveries d on d.tenant_id = r.tenant_id and d.id = r.delivery_id
        where r.tenant_id = $1 and r.recipient_id = $2 and d.purged = false`, [tenantId, recipientId]);
    return rows.map((r) => ({ ...toRecipient(r), appId: r.app_id! }));
  }

  async addStop(tenantId: string, s: Omit<StopRecord, 'seq'> & { source: string }): Promise<boolean> {
    const rows = await this.q(tenantId,
      `insert into delivery_stops (tenant_id, app_id, delivery_id, recipient_id, email_enc, channel, at, source) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, app_id, source) do nothing returning seq`,
      [tenantId, s.appId, s.deliveryId, s.recipientId, s.emailEnc, s.channel, s.at, s.source]);
    return rows.length === 1;
  }

  async stops(tenantId: string, appId: string, after: number, limit: number): Promise<StopRecord[]> {
    const rows = await this.q<StopRow>(tenantId,
      `select * from delivery_stops where tenant_id = $1 and app_id = $2 and seq > $3 order by seq limit $4`, [tenantId, appId, after, limit]);
    return rows.map(toStop);
  }

  async recentApps(tenantId: string, since: string): Promise<string[]> {
    const rows = await this.q<{ app_id: string }>(tenantId,
      `select distinct app_id from deliveries where tenant_id = $1 and created_at > $2 and test = false`, [tenantId, since]);
    return rows.map((r) => r.app_id);
  }

  async mailCursor(tenantId: string): Promise<string | null> {
    const [r] = await this.q<{ mail_cursor: unknown }>(tenantId, 'select mail_cursor from delivery_state where tenant_id = $1', [tenantId]);
    return isoOrNull(r?.mail_cursor);
  }

  async setMailCursor(tenantId: string, at: string): Promise<void> {
    await this.q(tenantId, `insert into delivery_state (tenant_id, mail_cursor) values ($1, $2) on conflict (tenant_id) do update set mail_cursor = excluded.mail_cursor`, [tenantId, at]);
  }

  async purge(tenantId: string, now: string, stopsBefore: string): Promise<number> {
    return this.tx(tenantId, async (c) => {
      await c.query(`update delivery_recipients set email_hash = null, hash_until = null where tenant_id = $1 and hash_until is not null and hash_until <= $2`, [tenantId, now]);
      await c.query('delete from delivery_stops where tenant_id = $1 and created_at < $2', [tenantId, stopsBefore]);
      const due = await c.query<{ id: string }>(`select id from deliveries where tenant_id = $1 and purged = false and purge_after is not null and purge_after <= $2`, [tenantId, now]);
      const ids = due.rows.map((r) => r.id);
      if (ids.length === 0) return 0;
      await c.query('delete from delivery_recipients where tenant_id = $1 and delivery_id = any($2::text[])', [tenantId, ids]);
      await c.query(`update deliveries set purged = true where tenant_id = $1 and id = any($2::text[])`, [tenantId, ids]);
      return ids.length;
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 記憶の上の置き場（試験用）。 */
export class MemoryDeliveryStore implements DeliveryStore {
  readonly deliveries = new Map<string, DeliveryRecord & { tenantId: string }>();
  readonly recipients: (RecipientRecord & { tenantId: string })[] = [];
  readonly stopRows: (StopRecord & { tenantId: string; source: string; createdAt: string })[] = [];
  private readonly cursors = new Map<string, string>();
  private seq = 0;

  async create(tenantId: string, d: DeliveryRecord, recipients: RecipientRecord[]): Promise<boolean> {
    if ([...this.deliveries.values()].some((x) => x.tenantId === tenantId && x.appId === d.appId && x.requestId === d.requestId)) return false;
    this.deliveries.set(d.id, { ...structuredClone(d), tenantId });
    for (const r of recipients) this.recipients.push({ ...structuredClone(r), tenantId, resultSeq: r.status === 'pending' ? null : ++this.seq });
    return true;
  }

  private strip<T extends { tenantId: string }>(x: T): Omit<T, 'tenantId'> {
    const { tenantId: _t, ...rest } = x;
    return structuredClone(rest);
  }

  async get(tenantId: string, id: string): Promise<DeliveryRecord | null> {
    const d = this.deliveries.get(id);
    return d && d.tenantId === tenantId ? this.strip(d) : null;
  }

  async byRequest(tenantId: string, appId: string, requestId: string): Promise<DeliveryRecord | null> {
    const d = [...this.deliveries.values()].find((x) => x.tenantId === tenantId && x.appId === appId && x.requestId === requestId);
    return d ? this.strip(d) : null;
  }

  async update(tenantId: string, id: string, patch: Partial<Omit<DeliveryRecord, 'id' | 'appId' | 'requestId'>>): Promise<void> {
    const d = this.deliveries.get(id);
    if (!d || d.tenantId !== tenantId) return;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (d as unknown as Record<string, unknown>)[k] = structuredClone(v);
  }

  async list(tenantId: string, opts: { appId?: string; limit?: number } = {}): Promise<DeliveryRecord[]> {
    const all = [...this.deliveries.values()].filter((d) => d.tenantId === tenantId && (!opts.appId || d.appId === opts.appId));
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, opts.limit ?? 50).map((d) => this.strip(d));
  }

  async active(tenantId: string): Promise<DeliveryRecord[]> {
    return [...this.deliveries.values()].filter((d) => d.tenantId === tenantId && !d.purged).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((d) => this.strip(d));
  }

  private mine(tenantId: string, deliveryId: string) {
    return this.recipients.filter((r) => r.tenantId === tenantId && r.deliveryId === deliveryId);
  }

  async nextRecipient(tenantId: string, deliveryId: string, now: string): Promise<RecipientRecord | null> {
    const r = this.mine(tenantId, deliveryId).filter((x) => x.status === 'pending' && (!x.nextSendAt || x.nextSendAt <= now))
      .sort((a, b) => a.recipientId.localeCompare(b.recipientId))[0];
    return r ? this.strip(r) : null;
  }

  async retryLater(tenantId: string, deliveryId: string, recipientId: string, nextSendAt: string): Promise<void> {
    const r = this.mine(tenantId, deliveryId).find((x) => x.recipientId === recipientId);
    if (r) r.nextSendAt = nextSendAt;
  }

  async setResult(tenantId: string, deliveryId: string, recipientId: string, x: RecipientResult): Promise<void> {
    const r = this.mine(tenantId, deliveryId).find((y) => y.recipientId === recipientId);
    if (!r) return;
    Object.assign(r, { status: x.status, reason: x.reason ?? null, stopChannel: x.stopChannel ?? null, at: x.at, resultSeq: ++this.seq });
    if (x.clearContact) r.contactEnc = null;
    if (x.hashUntil === null) Object.assign(r, { emailHash: null, hashUntil: null });
    else if (x.hashUntil !== undefined) r.hashUntil = x.hashUntil;
  }

  async counts(tenantId: string, deliveryId: string): Promise<RecipientCounts> {
    const list = this.mine(tenantId, deliveryId);
    const n = (s: string) => list.filter((r) => r.status === s).length;
    return { pending: n('pending'), sent: n('sent'), failed: n('failed'), stopped: n('stopped') };
  }

  async results(tenantId: string, deliveryId: string, after: number, limit: number): Promise<RecipientRecord[]> {
    return this.mine(tenantId, deliveryId).filter((r) => r.resultSeq !== null && r.resultSeq > after).sort((a, b) => a.resultSeq! - b.resultSeq!)
      .slice(0, limit).map((r) => this.strip(r));
  }

  async failPending(tenantId: string, deliveryId: string, reason: DeliveryFailReason, at: string): Promise<number> {
    let n = 0;
    for (const r of this.mine(tenantId, deliveryId)) {
      if (r.status !== 'pending') continue;
      Object.assign(r, { status: 'failed', reason, at, resultSeq: ++this.seq, contactEnc: null, emailHash: null, hashUntil: null });
      n++;
    }
    return n;
  }

  private withApp(rows: (RecipientRecord & { tenantId: string })[]): (RecipientRecord & { appId: string })[] {
    return rows.filter((r) => !this.deliveries.get(r.deliveryId)?.purged).map((r) => ({ ...this.strip(r), appId: this.deliveries.get(r.deliveryId)!.appId }));
  }

  async findByHash(tenantId: string, emailHash: string, now: string): Promise<(RecipientRecord & { appId: string })[]> {
    return this.withApp(this.recipients.filter((r) => r.tenantId === tenantId && r.emailHash === emailHash && !!r.hashUntil && r.hashUntil > now));
  }

  async findRecipient(tenantId: string, recipientId: string): Promise<(RecipientRecord & { appId: string })[]> {
    return this.withApp(this.recipients.filter((r) => r.tenantId === tenantId && r.recipientId === recipientId));
  }

  async addStop(tenantId: string, s: Omit<StopRecord, 'seq'> & { source: string }): Promise<boolean> {
    if (this.stopRows.some((x) => x.tenantId === tenantId && x.appId === s.appId && x.source === s.source)) return false;
    this.stopRows.push({ ...s, tenantId, seq: ++this.seq, createdAt: new Date().toISOString() });
    return true;
  }

  async stops(tenantId: string, appId: string, after: number, limit: number): Promise<StopRecord[]> {
    return this.stopRows.filter((x) => x.tenantId === tenantId && x.appId === appId && x.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit)
      .map(({ tenantId: _t, source: _s, createdAt: _c, ...x }) => structuredClone(x));
  }

  async recentApps(tenantId: string, since: string): Promise<string[]> {
    return [...new Set([...this.deliveries.values()].filter((d) => d.tenantId === tenantId && d.createdAt > since && !d.test).map((d) => d.appId))];
  }

  async mailCursor(tenantId: string): Promise<string | null> {
    return this.cursors.get(tenantId) ?? null;
  }

  async setMailCursor(tenantId: string, at: string): Promise<void> {
    this.cursors.set(tenantId, at);
  }

  async purge(tenantId: string, now: string, stopsBefore: string): Promise<number> {
    for (const r of this.recipients) if (r.tenantId === tenantId && r.hashUntil && r.hashUntil <= now) Object.assign(r, { emailHash: null, hashUntil: null });
    for (let i = this.stopRows.length - 1; i >= 0; i--) if (this.stopRows[i]!.tenantId === tenantId && this.stopRows[i]!.createdAt < stopsBefore) this.stopRows.splice(i, 1);
    let n = 0;
    for (const d of this.deliveries.values()) {
      if (d.tenantId !== tenantId || d.purged || !d.purgeAfter || d.purgeAfter > now) continue;
      for (let i = this.recipients.length - 1; i >= 0; i--) if (this.recipients[i]!.tenantId === tenantId && this.recipients[i]!.deliveryId === d.id) this.recipients.splice(i, 1);
      d.purged = true;
      n++;
    }
    return n;
  }
}
