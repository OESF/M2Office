/**
 * @file 通知の控えを、会社の Chat アプリから本人への個別メッセージに送る本物の送信口（仕様書 第6.5.5.2.1節、ADR-0102）。
 *
 * 会社の Google Cloud のサービスアカウントの鍵で、Chat アプリとして認証する（権限 `chat.bot`。Workspace の管理者の承認は要らない）。
 * アプリは自分が入っている場所にしか送れないため、本人とアプリの個別メッセージの場所を覚えておき、無ければ探す。
 * 送るのは種類・題名・画面へのリンクだけで、本文は載せない（第6.5.5.2節）。
 */

import { createSign } from 'node:crypto';
import type { DataSource } from '../connectors/types.js';
import { ConnectorUnavailableError, type WorkspaceConnector } from '../connectors/types.js';
import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import type { NotificationEnvelope, NotificationSender } from './sender.js';

/** 会社の Chat アプリのサービスアカウントの鍵（必要なところだけ）。 */
export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  projectId: string;
}

/** 呼び先。テストでは手元の偽の Google に向ける。 */
export interface ChatAppEndpoints {
  chat: string;
  /** 鍵の `token_uri` の代わりに使う口（テストだけ）。 */
  token?: string;
}

export const CHAT_APP_ENDPOINTS: ChatAppEndpoints = { chat: 'https://chat.googleapis.com/v1' };
/** アプリとして送る権限（管理者の承認は要らない）。 */
export const CHAT_BOT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
/** 本人とアプリの個別メッセージの場所を作るための、本人の許可（短い名前。使う人だけに求める）。 */
export const CHAT_DM_SETUP_SCOPE = 'chat.spaces.create';
/** 1 回の呼び出しの待ち時間の上限（ミリ秒）。 */
const TIMEOUT_MS = 20_000;

/**
 * サービスアカウントの鍵（JSON）を読む。
 *
 * @returns 読めた鍵か、読めない理由（管理者に見せる文）
 */
export function parseServiceAccountKey(text: string): ServiceAccountKey | { error: string } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: '鍵のファイルを読めません（Google Cloud で作ったサービスアカウントの鍵の JSON を、そのまま貼ってください）' };
  }
  if (j['type'] !== 'service_account') return { error: 'サービスアカウントの鍵ではありません（"type": "service_account" の JSON です）' };
  const clientEmail = String(j['client_email'] ?? '');
  const privateKey = String(j['private_key'] ?? '');
  const tokenUri = String(j['token_uri'] ?? 'https://oauth2.googleapis.com/token');
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(clientEmail)) return { error: '鍵に client_email がありません' };
  if (!privateKey.includes('PRIVATE KEY')) return { error: '鍵に private_key がありません' };
  if (!/^https:\/\/oauth2\.googleapis\.com\/token$/.test(tokenUri)) return { error: '鍵の token_uri が Google のものではありません' };
  return { clientEmail, privateKey, tokenUri, projectId: String(j['project_id'] ?? '') };
}

/** 本文を載せない控えの文（第6.5.5.2節）。Chat のリンクの書き方 `<URL|文字>` を使う。 */
export function chatNotificationText(e: Pick<NotificationEnvelope, 'kindLabel' | 'title' | 'link'>): string {
  const title = e.title.replace(/[<>|]/g, ' ').slice(0, 200);
  return `【${e.kindLabel}】${title}\n<${e.link}|画面で開く>`;
}

/**
 * Chat アプリとして Google を呼ぶ口。アクセス トークンはメモリにだけ持つ。
 *
 * @remarks トークンは期限の 1 分前まで使い回す。断りの文に応答の中身を入れない
 */
export class ChatAppClient {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly endpoints: ChatAppEndpoints = CHAT_APP_ENDPOINTS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** アプリとしてのアクセス トークン（JWT で取る）。 */
  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    const iat = Math.floor(this.now() / 1000);
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.key.clientEmail, scope: CHAT_BOT_SCOPE, aud: this.key.tokenUri, iat, exp: iat + 3600 })}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(body).sign(this.key.privateKey, 'base64url');
    } catch {
      throw new ConnectorUnavailableError('client-error', '会社の Chat アプリの鍵で署名できません（鍵が壊れています。作り直して登録してください）');
    }
    const res = await fetch(this.endpoints.token ?? this.key.tokenUri, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${body}.${signature}` }),
    }).catch(() => null);
    if (!res) throw new ConnectorUnavailableError('unreachable', 'Google に届きませんでした');
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof j['access_token'] !== 'string') {
      const code = String(j['error'] ?? res.status);
      throw new ConnectorUnavailableError('client-error', code === 'invalid_grant'
        ? '会社の Chat アプリの鍵が Google に認められません（消された鍵か、サービスアカウントが止まっています）'
        : `会社の Chat アプリの鍵で認証できません（${code}）`);
    }
    this.cached = { token: j['access_token'], expiresAt: this.now() + Number(j['expires_in'] ?? 3600) * 1000 };
    return this.cached.token;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.endpoints.chat}${path}`, {
      method: init.method ?? 'GET', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${await this.token()}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }).catch(() => null);
    if (!res) throw new ConnectorUnavailableError('unreachable', 'Google Chat に届きませんでした');
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * 本人とアプリの個別メッセージの場所を探す（本人がアプリを追加していれば見つかる）。
   *
   * @returns 場所。無ければ `null`
   */
  async findDirectMessage(email: string): Promise<string | null> {
    const r = await this.call(`/spaces:findDirectMessage?name=${encodeURIComponent(`users/${email}`)}`);
    if (r.status === 404) return null;
    if (r.status === 403) throw new ConnectorUnavailableError('client-error', 'Google Chat がアプリの呼び出しを断りました（Chat アプリの設定と、鍵のプロジェクトが同じか確かめてください）');
    if (r.status >= 400) throw new ConnectorUnavailableError('unreachable', `Google Chat が答えませんでした（${r.status}）`);
    const name = String(r.json['name'] ?? '');
    return /^spaces\/[A-Za-z0-9_-]+$/.test(name) ? name : null;
  }

  /**
   * 場所にアプリとして投稿する。
   *
   * @returns 送れたら `true`。場所が無い・アプリが入っていない（消された・外された）なら `false`
   */
  async post(space: string, text: string): Promise<boolean> {
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space)) return false;
    const r = await this.call(`/${space}/messages`, { method: 'POST', body: { text } });
    if (r.status === 404 || r.status === 403) return false;
    if (r.status >= 400) throw new ConnectorUnavailableError('unreachable', `Google Chat に送れませんでした（${r.status}）`);
    return true;
  }
}

/** 会社の Chat アプリの鍵を読む。無い・読めなければ `null`。 */
async function keyOf(repo: Repository, box: SecretBox, tenantId: string): Promise<ServiceAccountKey | null> {
  const cred = await repo.getTenantCredential(tenantId, 'google_chat_app');
  if (!cred?.secretEnc) return null;
  const k = parseServiceAccountKey(box.decrypt(cred.secretEnc));
  return 'error' in k ? null : k;
}

export interface ChatAppDeps {
  repo: Repository;
  box: SecretBox;
  endpoints?: ChatAppEndpoints;
}

/**
 * 会社の Chat アプリの口（会社ごとに鍵が違うため、会社ごとに持つ）。
 *
 * @remarks 鍵を登録し直したら、次に呼んだときに新しい鍵で作り直す
 */
export class ChatAppClients {
  private readonly clients = new Map<string, { secretEnc: string; client: ChatAppClient }>();

  constructor(private readonly deps: ChatAppDeps) {}

  /** その会社の口。鍵が無ければ `null`。 */
  async for(tenantId: string): Promise<ChatAppClient | null> {
    const cred = await this.deps.repo.getTenantCredential(tenantId, 'google_chat_app');
    if (!cred?.secretEnc) return null;
    const hit = this.clients.get(tenantId);
    if (hit && hit.secretEnc === cred.secretEnc) return hit.client;
    const key = await keyOf(this.deps.repo, this.deps.box, tenantId);
    if (!key) return null;
    const client = new ChatAppClient(key, this.deps.endpoints);
    this.clients.set(tenantId, { secretEnc: cred.secretEnc, client });
    return client;
  }
}

/**
 * 会社の Chat アプリから送る本物の送信口（第6.5.5.2.1節）。
 *
 * @remarks
 * 覚えている個別メッセージの場所に送る。場所が無い・送れなければ、アプリの権限で探し直す。
 * それでも無ければ送らずに例外にする（届ける見回りが理由を残し、24 時間は試し直す）
 */
export class GoogleChatAppSender implements NotificationSender {
  readonly source: DataSource = 'google';
  private readonly clients: ChatAppClients;

  constructor(private readonly deps: ChatAppDeps) {
    this.clients = new ChatAppClients(deps);
  }

  async chat(e: NotificationEnvelope): Promise<void> {
    const client = await this.clients.for(e.tenantId);
    if (!client) throw new Error('会社の Chat アプリの鍵が登録されていません');
    const text = chatNotificationText(e);
    const known = await this.deps.repo.getChatDmSpace(e.tenantId, e.userId);
    if (known && (await client.post(known, text))) return;
    // 覚えた場所が無くなった（本人が消した・アプリを外した）か、まだ覚えていない。アプリの権限で探し直す
    const found = await client.findDirectMessage(e.email);
    if (found && found !== known && (await client.post(found, text))) {
      await this.deps.repo.setChatDmSpace(e.tenantId, e.userId, found);
      return;
    }
    if (known) await this.deps.repo.setChatDmSpace(e.tenantId, e.userId, null);
    throw new Error('Chat の個別メッセージの場所がありません（個人設定で Chat の受け取りを入れ直してください）');
  }
}

/**
 * 会社ごとに、見本の送信口と本物の送信口を振り分ける（見本の接続口を使う会社は見本。開発だけ）。
 */
export class RoutingNotificationSender implements NotificationSender {
  readonly source: DataSource = 'google';

  constructor(
    private readonly isMock: (tenantId: string) => boolean,
    private readonly mock: NotificationSender,
    private readonly real: NotificationSender,
  ) {}

  /** その会社の送り先の出どころ（監査ログに残す）。 */
  sourceFor(tenantId: string): DataSource {
    return this.isMock(tenantId) ? this.mock.source : this.real.source;
  }

  chat(e: NotificationEnvelope): Promise<void> {
    return (this.isMock(e.tenantId) ? this.mock : this.real).chat(e);
  }
}

/** Chat の控えを届けられるかの様子（個人設定に出す）。 */
export interface ChatCopyStatus {
  /** 会社の Chat アプリの鍵が登録されているか。 */
  appReady: boolean;
  /** 本人の個別メッセージの場所を覚えているか。 */
  dmReady: boolean;
}

/**
 * 本人の個別メッセージの場所を用意する（本人が「Chat」を入れたとき。第6.5.5.2.1節）。
 *
 * @returns 用意できた場所か、本人の許可が足りないこと（`needsScope`）か、用意できない理由（本人に見せる文）
 * @remarks ① アプリの権限で既存の場所を探す → ② 無ければ本人の許可で作る（`chat.spaces.create`）。見本の会社は見本の場所
 */
export async function ensureChatDm(
  deps: ChatAppDeps & { connector: WorkspaceConnector },
  who: { tenantId: string; userId: string; email: string },
): Promise<{ space: string } | { needsScope: true } | { error: string }> {
  const mock = deps.connector.sourceFor(who.tenantId) === 'mock';
  if (!mock) {
    const client = await new ChatAppClients(deps).for(who.tenantId);
    if (!client) return { error: '会社の Chat アプリの鍵が登録されていません。管理者に登録を頼んでください' };
    try {
      const found = await client.findDirectMessage(who.email);
      if (found) {
        await deps.repo.setChatDmSpace(who.tenantId, who.userId, found);
        return { space: found };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Google Chat に届きませんでした' };
    }
  }
  if (!deps.connector.chat.setupAppDm) return { error: 'この会社では Chat の個別メッセージを用意できません' };
  try {
    const space = await deps.connector.chat.setupAppDm({ tenantId: who.tenantId, userId: who.userId });
    await deps.repo.setChatDmSpace(who.tenantId, who.userId, space);
    return { space };
  } catch (err) {
    if (err instanceof ConnectorUnavailableError && (err.kind === 'insufficient-scope' || err.kind === 'not-connected' || err.kind === 'revoked')) return { needsScope: true };
    return { error: err instanceof Error ? err.message : 'Chat の個別メッセージを用意できませんでした' };
  }
}

/**
 * 鍵で Chat アプリとして認証できるかを確かめる（管理者が登録するとき）。
 *
 * @returns 認証できたら `null`、できなければ理由（管理者に見せる文）
 */
export async function checkChatAppKey(key: ServiceAccountKey, endpoints: ChatAppEndpoints = CHAT_APP_ENDPOINTS): Promise<string | null> {
  try {
    await new ChatAppClient(key, endpoints).token();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : '確かめられませんでした';
  }
}
