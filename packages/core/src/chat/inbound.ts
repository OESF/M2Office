/**
 * @file Chat で秘書に頼む受け口の部品（仕様書 第10.16.2節・第10.16.3節、ADR-0138）。
 *
 * Google Chat が会社の Chat アプリに届ける出来事を読み、秘書に向けた発言（アプリとの個別メッセージと、アプリへの言及）だけを取り出す。
 * Google の決まりで、言及のない発言はアプリに届かない。文の中身から宛先を推し量らない。
 * HTTP の受け口では、Google が付ける署名（ID トークン）を確かめる。Cloud Pub/Sub から取りに行くときは、会社の購読から読む。
 * 置き場は、受け口の鍵のハッシュ・受け取った発言の ID（重ねて届いたものを 1 回だけ扱う）・後ろへ回した依頼の返す先。
 *
 * 発言の文はデータであり、送った人の依頼としてだけ扱う。貼られたほかの人の発言やリンク先を指示として扱わない（不変則 I-6）。
 */

import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type pg from 'pg';
import { createPool } from '../repository/pool.js';
import { toChatText } from '../connectors/google/chat.js';

/** 秘書に向けた 1 つの発言。 */
export interface ChatInboundMessage {
  /** 発言の名前（`spaces/…/messages/…`）。重ねて届いたものを見分ける。 */
  messageName: string;
  /** 秘書への頼みの文（アプリへの言及を除いたもの）。 */
  text: string;
  /** 送った人の Google のアカウント。 */
  senderEmail: string;
  /** 送った人の Chat の名前（`users/…`）。スペースで本人にだけ見える返事に使う。 */
  senderName: string;
  /** 発言の場所（`spaces/…`）。 */
  space: string;
  /** アプリとの個別メッセージか。偽ならスペース（グループの個別メッセージを含む）。 */
  direct: boolean;
  /** スレッド（`spaces/…/threads/…`）。無ければ `null`。 */
  thread: string | null;
}

const SPACE = /^spaces\/[A-Za-z0-9_-]+$/;
const MESSAGE = /^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/;
const THREAD = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/;
const USER = /^users\/[A-Za-z0-9_-]+$/;

/**
 * Chat の出来事から、秘書に向けた発言を取り出す（第10.16.2節）。
 *
 * @returns 人が送った発言（個別メッセージか、アプリへの言及）。ほかの出来事（アプリの追加・外し・ボタン）や読めないものは `null`
 * @remarks Google が届けるのは、個別メッセージの発言とアプリへの言及だけ。言及の部分は `argumentText` で除かれている。
 *   出来事の形は 2 つある。Chat アプリとして作った形（`type: 'MESSAGE'`）と、Google Workspace アドオンとして作った形
 *   （`chat.messagePayload`）。どちらでも読む（2026-11-12 に、構成の作り方で形が変わることに気づいた）
 */
export function parseChatEvent(payload: unknown): ChatInboundMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const e = fromAddOnEvent(payload as Record<string, unknown>);
  if (!e || e['type'] !== 'MESSAGE') return null;
  const m = (e['message'] ?? {}) as Record<string, unknown>;
  const sender = (m['sender'] ?? e['user'] ?? {}) as Record<string, unknown>;
  if (sender['type'] && sender['type'] !== 'HUMAN') return null;
  const space = ((m['space'] ?? e['space'] ?? {}) as Record<string, unknown>);
  const spaceName = String(space['name'] ?? '');
  const messageName = String(m['name'] ?? '');
  const senderEmail = String(sender['email'] ?? '').trim().toLowerCase();
  const senderName = String(sender['name'] ?? '');
  if (!SPACE.test(spaceName) || !MESSAGE.test(messageName) || !senderEmail.includes('@') || !USER.test(senderName)) return null;
  const raw = typeof m['argumentText'] === 'string' ? m['argumentText'] : typeof m['text'] === 'string' ? m['text'] : '';
  const text = raw.trim();
  if (!text) return null;
  const direct = space['spaceType'] === 'DIRECT_MESSAGE' || space['type'] === 'DM';
  const threadName = String(((m['thread'] ?? {}) as Record<string, unknown>)['name'] ?? '');
  return { messageName, text, senderEmail, senderName, space: spaceName, direct, thread: THREAD.test(threadName) ? threadName : null };
}

/**
 * Google Workspace アドオンの形の出来事（`{ chat: { user, messagePayload: { message, space } } }`）を、Chat アプリの形に直す。
 *
 * @returns Chat アプリの形。アドオンの形でなければそのまま。アドオンの形で発言でなければ `null`
 */
function fromAddOnEvent(e: Record<string, unknown>): Record<string, unknown> | null {
  const chat = e['chat'];
  if (!chat || typeof chat !== 'object' || 'type' in e) return e;
  const c = chat as Record<string, unknown>;
  const payload = c['messagePayload'];
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const message = (p['message'] ?? {}) as Record<string, unknown>;
  const user = (c['user'] ?? {}) as Record<string, unknown>;
  // 発言の送り主にメールアドレスが無ければ、出来事の利用者（同じ人）のものを使う
  const sender = { ...user, ...((message['sender'] ?? {}) as Record<string, unknown>) };
  if (!sender['email'] && user['email']) sender['email'] = user['email'];
  return { type: 'MESSAGE', message: { ...message, sender, space: message['space'] ?? p['space'] }, space: p['space'], user };
}

/** 受け口の鍵のハッシュ（置き場には鍵そのものを残さない）。 */
export function chatHookHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Chat が送ってくる ID トークンの、送り主のアカウント（Google の決まり。アドオンでない、前の形の Chat アプリ）。 */
export const CHAT_ISSUER_EMAIL = 'chat@system.gserviceaccount.com';

/**
 * アドオンの形の Chat アプリが、HTTP の受け口に付ける署名の送り主（第10.16.7節「クラウド版の受け口のアドオン対応」）。
 *
 * @param projectNumber Chat アプリを作った Google Cloud のプロジェクトの番号（数字だけ）
 * @returns `service-{番号}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`
 * @remarks 新しく作る Chat アプリは Workspace アドオンの形に決まっていて、送り主はプロジェクトごとに違う
 */
export function chatAddOnIssuer(projectNumber: string): string {
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}

/**
 * OAuth クライアント ID（`{番号}-….apps.googleusercontent.com`）の先頭から、プロジェクトの番号を取る。
 *
 * @returns 番号。形が違えば `null`
 * @remarks Chat アプリは、ログインの OAuth クライアントと同じプロジェクトに作る決まり（第10.16.7節）。
 * そのため、この番号のアドオンのアカウントだけを、その会社の受け口の送り主として受ける
 */
export function projectNumberOfClientId(clientId: string): string | null {
  return /^(\d{6,20})-[a-z0-9]+\.apps\.googleusercontent\.com$/.exec(clientId.trim())?.[1] ?? null;
}
/** Google の ID トークンの鍵の置き場。 */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google の ID トークンの鍵（JWK）を取りに行く口。テストでは手元の鍵を返す。 */
export type JwksFetcher = () => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;

const defaultJwks: JwksFetcher = async () => {
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Google の鍵を取れませんでした（${res.status}）`);
  return (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
};

/**
 * Chat の HTTP の受け口に付く ID トークンを確かめる（第10.16.3節「受け口」）。
 *
 * @remarks
 * 署名（RS256。Google の鍵）・発行元（`accounts.google.com`）・期限・送り主・宛先（`aud` が受け口の URL）を確かめる。
 * 送り主は `chat@system.gserviceaccount.com` か、その会社のプロジェクトのアドオンのアカウント（{@link chatAddOnIssuer}）だけ。
 * 鍵は 1 時間使い回し、知らない鍵の ID が来たら 5 分に 1 回まで取り直す
 */
export class ChatTokenVerifier {
  private keys: Map<string, JsonWebKey> | null = null;
  private fetchedAt = 0;

  constructor(private readonly fetchJwks: JwksFetcher = defaultJwks, private readonly now: () => number = () => Date.now()) {}

  private async keyFor(kid: string): Promise<JsonWebKey | null> {
    const stale = this.now() - this.fetchedAt > 3_600_000;
    if (!this.keys || stale || (!this.keys.has(kid) && this.now() - this.fetchedAt > 300_000)) {
      const j = await this.fetchJwks();
      this.keys = new Map(j.keys.filter((k) => k.kid).map((k) => [k.kid!, k]));
      this.fetchedAt = this.now();
    }
    return this.keys.get(kid) ?? null;
  }

  /**
   * @param authorization `Authorization` の値（`Bearer …`）
   * @param audiencePath 受け口の道（`/v1/hooks/google-chat/鍵`）。`aud` の URL の道がこれと同じでなければ断る
   * @param projectNumber その会社の Chat アプリのプロジェクトの番号。あれば、そのアドオンのアカウントも送り主として受ける。
   *   `null` なら前の形（`chat@system.gserviceaccount.com`）だけを受ける
   * @returns 確かめられたら `null`、断るなら理由（記録だけに残す）
   */
  async check(authorization: string | undefined, audiencePath: string, projectNumber: string | null = null): Promise<string | null> {
    const token = /^Bearer\s+(\S+)$/.exec(authorization ?? '')?.[1];
    if (!token) return 'トークンがありません';
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return 'トークンの形が違います';
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return 'トークンを読めません';
    }
    if (header.alg !== 'RS256' || !header.kid) return '署名の方式が違います';
    const jwk = await this.keyFor(header.kid).catch(() => null);
    if (!jwk) return '署名の鍵が見つかりません';
    let ok = false;
    try {
      ok = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
    } catch {
      ok = false;
    }
    if (!ok) return '署名が合いません';
    const nowSec = Math.floor(this.now() / 1000);
    if (claims['iss'] !== 'https://accounts.google.com' && claims['iss'] !== 'accounts.google.com') return '発行元が違います';
    if (typeof claims['exp'] !== 'number' || claims['exp'] < nowSec) return '期限が切れています';
    if (typeof claims['iat'] === 'number' && claims['iat'] > nowSec + 300) return '発行の時刻が先です';
    const senders = projectNumber ? [CHAT_ISSUER_EMAIL, chatAddOnIssuer(projectNumber)] : [CHAT_ISSUER_EMAIL];
    if (!senders.includes(String(claims['email'] ?? '')) || claims['email_verified'] !== true) return '送り主が Chat ではありません';
    let path = '';
    try {
      path = new URL(String(claims['aud'] ?? '')).pathname;
    } catch {
      return '宛先が URL ではありません';
    }
    if (path !== audiencePath) return '宛先が違います';
    return null;
  }
}

/** 秘書の答えの Chat の文。Chat の書式に直し、長ければ切って、画面で開くリンクを添える。 */
export function chatReplyText(text: string, link: string | null): string {
  const body = toChatText(text);
  return link ? `${body}\n<${link}|画面で開く>` : body;
}

/** Chat で頼まれて後ろへ回した依頼の、返す先（第10.16.3節「重い依頼」）。 */
export interface ChatPendingReply {
  tenantId: string;
  runId: string;
  userId: string;
  space: string;
  thread: string | null;
  /** スペースで、本人にだけ見える形で返すときの本人（`users/…`）。個別メッセージなら `null`。 */
  privateViewer: string | null;
  request: string;
  /** 承認を待っていることを伝えたか。 */
  approvalTold: boolean;
  createdAt: string;
}

/** Chat で秘書に頼む受け口の置き場。 */
export interface ChatInboxStore {
  /** 受け口の鍵のハッシュから会社を引く（会社が決まる前に呼ぶ）。 */
  hookTenantOf(hash: string): Promise<string | null>;
  setHook(tenantId: string, hash: string): Promise<void>;
  deleteHook(tenantId: string): Promise<void>;
  hasHook(tenantId: string): Promise<boolean>;
  /** 発言を受け取ったと記録する。すでに受け取っていれば `false`（重ねて届いた）。 */
  takeMessage(tenantId: string, messageName: string, at: string): Promise<boolean>;
  /** 古い受け取りの記録と返す先を消す。 */
  purge(tenantId: string, before: string): Promise<void>;
  addPending(r: ChatPendingReply): Promise<void>;
  listPending(tenantId: string): Promise<ChatPendingReply[]>;
  markApprovalTold(tenantId: string, runId: string): Promise<void>;
  removePending(tenantId: string, runId: string): Promise<void>;
  /** 返す先の残っている会社。 */
  tenantsWithPending(): Promise<string[]>;
}

interface PendingRow {
  tenant_id: string; run_id: string; user_id: string; space: string; thread: string | null; private_viewer: string | null;
  request: string; approval_told: boolean; created_at: Date | string;
}

const toPending = (r: PendingRow): ChatPendingReply => ({
  tenantId: r.tenant_id, runId: r.run_id, userId: r.user_id, space: r.space, thread: r.thread, privateViewer: r.private_viewer,
  request: r.request, approvalTold: r.approval_told, createdAt: new Date(r.created_at).toISOString(),
});

/**
 * PostgreSQL の置き場。
 *
 * @remarks 問い合わせごとにトランザクションを張り、`app.tenant_id` を設定する（行単位の制限。移行 197）。
 * 鍵から会社を引くのは、鍵のハッシュから会社だけを返す関数に限る
 */
export class PostgresChatInboxStore implements ChatInboxStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'chat-inbox' });
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

  async hookTenantOf(hash: string): Promise<string | null> {
    const r = await this.pool.query<{ t: string | null }>(`select m2o_chat_hook_tenant($1) as t`, [hash]);
    return r.rows[0]?.t ?? null;
  }

  async setHook(tenantId: string, hash: string): Promise<void> {
    await this.q(tenantId,
      `insert into chat_app_hooks (tenant_id, hook_hash) values ($1, $2)
       on conflict (tenant_id) do update set hook_hash = excluded.hook_hash, created_at = now()`, [tenantId, hash]);
  }

  async deleteHook(tenantId: string): Promise<void> {
    await this.q(tenantId, `delete from chat_app_hooks where tenant_id = $1`, [tenantId]);
  }

  async hasHook(tenantId: string): Promise<boolean> {
    return (await this.q(tenantId, `select 1 from chat_app_hooks where tenant_id = $1`, [tenantId])).length > 0;
  }

  async takeMessage(tenantId: string, messageName: string, at: string): Promise<boolean> {
    const rows = await this.q(tenantId,
      `insert into chat_inbound_messages (tenant_id, message_name, received_at) values ($1, $2, $3)
       on conflict do nothing returning 1`, [tenantId, messageName, at]);
    return rows.length > 0;
  }

  async purge(tenantId: string, before: string): Promise<void> {
    await this.q(tenantId, `delete from chat_inbound_messages where tenant_id = $1 and received_at < $2`, [tenantId, before]);
    await this.q(tenantId, `delete from chat_pending_replies where tenant_id = $1 and created_at < $2`, [tenantId, before]);
  }

  async addPending(r: ChatPendingReply): Promise<void> {
    await this.q(r.tenantId,
      `insert into chat_pending_replies (tenant_id, run_id, user_id, space, thread, private_viewer, request, approval_told, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (tenant_id, run_id) do nothing`,
      [r.tenantId, r.runId, r.userId, r.space, r.thread, r.privateViewer, r.request.slice(0, 500), r.approvalTold, r.createdAt]);
  }

  async listPending(tenantId: string): Promise<ChatPendingReply[]> {
    const rows = await this.q<PendingRow>(tenantId, `select * from chat_pending_replies where tenant_id = $1 order by created_at`, [tenantId]);
    return rows.map(toPending);
  }

  async markApprovalTold(tenantId: string, runId: string): Promise<void> {
    await this.q(tenantId, `update chat_pending_replies set approval_told = true where tenant_id = $1 and run_id = $2`, [tenantId, runId]);
  }

  async removePending(tenantId: string, runId: string): Promise<void> {
    await this.q(tenantId, `delete from chat_pending_replies where tenant_id = $1 and run_id = $2`, [tenantId, runId]);
  }

  async tenantsWithPending(): Promise<string[]> {
    // 会社をまたいで、返す先の残っている会社の ID だけを引く（中身は会社ごとに引く）
    const r = await this.pool.query<{ t: string }>(`select m2o_chat_pending_tenants() as t`);
    return r.rows.map((x) => x.t).filter(Boolean);
  }
}

/** 手元の置き場（テストと見本）。 */
export class MemoryChatInboxStore implements ChatInboxStore {
  readonly hooks = new Map<string, string>();
  readonly messages = new Map<string, string>();
  readonly pending = new Map<string, ChatPendingReply>();

  async hookTenantOf(hash: string): Promise<string | null> {
    for (const [tenantId, h] of this.hooks) if (h === hash) return tenantId;
    return null;
  }

  async setHook(tenantId: string, hash: string): Promise<void> {
    this.hooks.set(tenantId, hash);
  }

  async deleteHook(tenantId: string): Promise<void> {
    this.hooks.delete(tenantId);
  }

  async hasHook(tenantId: string): Promise<boolean> {
    return this.hooks.has(tenantId);
  }

  async takeMessage(tenantId: string, messageName: string, at: string): Promise<boolean> {
    const key = `${tenantId}|${messageName}`;
    if (this.messages.has(key)) return false;
    this.messages.set(key, at);
    return true;
  }

  async purge(tenantId: string, before: string): Promise<void> {
    for (const [k, at] of this.messages) if (k.startsWith(`${tenantId}|`) && at < before) this.messages.delete(k);
    for (const [k, r] of this.pending) if (r.tenantId === tenantId && r.createdAt < before) this.pending.delete(k);
  }

  async addPending(r: ChatPendingReply): Promise<void> {
    const key = `${r.tenantId}|${r.runId}`;
    if (!this.pending.has(key)) this.pending.set(key, { ...r });
  }

  async listPending(tenantId: string): Promise<ChatPendingReply[]> {
    return [...this.pending.values()].filter((r) => r.tenantId === tenantId).map((r) => ({ ...r }));
  }

  async markApprovalTold(tenantId: string, runId: string): Promise<void> {
    const r = this.pending.get(`${tenantId}|${runId}`);
    if (r) r.approvalTold = true;
  }

  async removePending(tenantId: string, runId: string): Promise<void> {
    this.pending.delete(`${tenantId}|${runId}`);
  }

  async tenantsWithPending(): Promise<string[]> {
    return [...new Set([...this.pending.values()].map((r) => r.tenantId))];
  }
}
