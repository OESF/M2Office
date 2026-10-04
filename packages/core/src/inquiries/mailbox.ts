/**
 * @file 問い合わせの窓口のアカウント（info@ など）のメール箱（仕様書 第33.6節・第33.18節）。
 *
 * 窓口のアカウントは人ではなく会社の窓口であり、管理者が会社の接続として預けたリフレッシュ トークンで読む（不変則 I-9 の扱いは第33.6節）。
 * 使うのは問い合わせの記録の処理だけで、秘書がほかの用に読むことはしない。
 * 本物は Gmail API（受信トレイ・送信済み・1 通・送信元として使えるアドレス・送る）。開発の見本の会社では、決まったメールを返す見本の箱を使う。
 * メールの本文はデータであり、指示として読まない（不変則 I-6）。
 */

import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import { GOOGLE_OAUTH_ENDPOINTS, refreshGoogleAccessToken, type GoogleOAuthEndpoints } from '../google/oauth.js';
import { buildRawMessage, decodeHeaderWords, extractBody, header, type GmailPart } from '../connectors/google/mime.js';

/** 窓口のアカウントの秘密の値の種類（会社の接続）。 */
export const MAILBOX_KIND = 'inquiry_mailbox' as const;

/** 窓口のアカウントに求める Google の権限（読む・送る）。 */
export const MAILBOX_SCOPES = ['gmail.readonly', 'gmail.send'];

/** 1 通のメール。 */
export interface MailItem {
  id: string;
  threadId: string;
  /** 差出人の見出し（`名前 <addr>`）。 */
  from: string;
  fromName: string;
  fromAddress: string;
  /** 返事の宛先（`Reply-To` があればそれ、無ければ差出人）。 */
  replyAddress: string;
  /** 宛先（To・Cc・Delivered-To のアドレス。小文字）。 */
  to: string[];
  subject: string;
  /** 届いた・送った日時（ISO）。 */
  date: string;
  /** 見出しの `Message-ID`（返事をスレッドに置くため）。 */
  messageIdHeader: string;
  references: string;
  body: string;
  /** メールマガジンなどの印（`List-Unsubscribe`・`Precedence: bulk`・`Auto-Submitted`）。 */
  bulk: boolean;
}

/** 窓口のアカウントのメール箱。 */
export interface Mailbox {
  /** 窓口のアカウントの本来のアドレス。 */
  readonly address: string;
  /** 受信トレイか送信済みの、この日時より後のメールの ID（新しい順）。 */
  list(folder: 'inbox' | 'sent', since: Date, limit: number): Promise<string[]>;
  get(id: string): Promise<MailItem | null>;
  /** 差出人に使えるアドレス（本来のアドレスと、Gmail に登録した別名。小文字）。 */
  sendAs(): Promise<string[]>;
  send(m: { from: string; to: string; subject: string; body: string; inReplyTo: string | null; references: string | null; threadId: string | null; listUnsubscribe?: string | null }): Promise<{ messageId: string }>;
}

/** 窓口のアカウントを読めない（預けていない・許可が取り消された・Google に届かない）。 */
export class MailboxUnavailableError extends Error {}

/** `名前 <addr>` から名前とアドレスを取り出す。 */
export function parseAddress(v: string): { name: string; address: string } {
  const s = decodeHeaderWords(v).trim();
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1]!.replace(/^"|"$/g, '').trim(), address: m[2]!.trim().toLowerCase() };
  return { name: '', address: s.toLowerCase() };
}

/** 見出しのアドレスの並び（`a, B <b>`）をアドレスだけにする。 */
function addresses(v: string): string[] {
  return v.split(',').map((x) => parseAddress(x).address).filter((x) => x.includes('@'));
}

/** Gmail の 1 通（`format=full`）を読む形にする。 */
function toItem(m: { id: string; threadId: string; internalDate?: string; payload?: GmailPart & { headers?: { name: string; value: string }[] } }): MailItem {
  const p = m.payload ?? {};
  const from = parseAddress(header(p, 'From'));
  const replyTo = header(p, 'Reply-To');
  return {
    id: m.id, threadId: m.threadId,
    from: decodeHeaderWords(header(p, 'From')), fromName: from.name, fromAddress: from.address,
    replyAddress: replyTo ? parseAddress(replyTo).address : from.address,
    to: [...new Set([...addresses(header(p, 'To')), ...addresses(header(p, 'Cc')), ...addresses(header(p, 'Delivered-To'))])],
    subject: decodeHeaderWords(header(p, 'Subject')),
    date: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
    messageIdHeader: header(p, 'Message-ID') || header(p, 'Message-Id'),
    references: header(p, 'References'),
    body: extractBody(p),
    bulk: !!header(p, 'List-Unsubscribe') || /bulk|list|junk/i.test(header(p, 'Precedence')) || /auto-(generated|replied)/i.test(header(p, 'Auto-Submitted')),
  };
}

/** Gmail API で読む窓口のアカウント。 */
export class GoogleMailbox implements Mailbox {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    readonly address: string,
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly endpoints = { gmail: 'https://gmail.googleapis.com/gmail/v1', oauth: GOOGLE_OAUTH_ENDPOINTS as GoogleOAuthEndpoints },
  ) {}

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    try {
      const t = await refreshGoogleAccessToken(this.creds, this.endpoints.oauth);
      this.token = { value: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 };
      return t.accessToken;
    } catch (err) {
      throw new MailboxUnavailableError(`窓口のアカウントの許可が取り消されたか、期限が切れています。管理者がつなぎ直してください（${err instanceof Error ? err.message : String(err)}）`);
    }
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.endpoints.gmail}/users/me${path}`, {
        ...init, headers: { authorization: `Bearer ${await this.accessToken(attempt > 0)}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      }).catch((err: unknown) => { throw new MailboxUnavailableError(`Gmail に届きませんでした（${err instanceof Error ? err.message : String(err)}）`); });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw new MailboxUnavailableError(`Gmail が断りました（${res.status}）`);
      return (await res.json()) as T;
    }
    throw new MailboxUnavailableError('Gmail に断られました（401）');
  }

  async list(folder: 'inbox' | 'sent', since: Date, limit: number): Promise<string[]> {
    const q = `in:${folder} after:${Math.floor(since.getTime() / 1000)}`;
    const r = await this.call<{ messages?: { id: string }[] }>(`/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(limit, 100)}`);
    return (r.messages ?? []).map((m) => m.id);
  }

  async get(id: string): Promise<MailItem | null> {
    try {
      return toItem(await this.call(`/messages/${encodeURIComponent(id)}?format=full`));
    } catch (err) {
      if (err instanceof MailboxUnavailableError && /404|410/.test(err.message)) return null;
      throw err;
    }
  }

  async sendAs(): Promise<string[]> {
    const r = await this.call<{ sendAs?: { sendAsEmail: string; verificationStatus?: string }[] }>('/settings/sendAs');
    return [...new Set([this.address, ...(r.sendAs ?? []).filter((x) => !x.verificationStatus || x.verificationStatus === 'accepted').map((x) => x.sendAsEmail.toLowerCase())])];
  }

  async send(m: Parameters<Mailbox['send']>[0]): Promise<{ messageId: string }> {
    const raw = buildRawMessage({ from: m.from, to: [m.to], cc: [], subject: m.subject, body: m.body, inReplyTo: m.inReplyTo, references: m.references, ...(m.listUnsubscribe ? { listUnsubscribe: m.listUnsubscribe } : {}) });
    const r = await this.call<{ id: string }>('/messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(m.threadId ? { threadId: m.threadId } : {}) }) });
    return { messageId: r.id };
  }
}

/** 見本の箱の基準の時刻（同じプロセスの中では同じ日時を返す）。 */
const MOCK_BASE = Date.now();

/** 見本の箱が送ったメール（会社ごと。プロセスの記憶だけ。外には何も送らない）。 */
const mockSent = new Map<string, MailItem[]>();

/**
 * 開発の見本の会社の窓口のアカウント。問い合わせ 2 通（Web のフォームの通知・別名に届いた直接のメール）と、
 * 問い合わせでないもの 2 通（メールマガジン・営業の売り込み）を返す。送ったメールは記憶に置くだけ。
 */
export class MockMailbox implements Mailbox {
  constructor(readonly address: string) {}

  /** 見本の箱が送ったメールを消す（自動テストで、前のテストの送信を持ち越さないため）。 */
  static clear(): void {
    mockSent.clear();
  }

  private get domain(): string {
    return this.address.split('@')[1] ?? 'example.jp';
  }

  private inbox(): MailItem[] {
    const at = (h: number) => new Date(MOCK_BASE - h * 3_600_000).toISOString();
    const d = this.domain;
    const base = (x: Partial<MailItem> & Pick<MailItem, 'id' | 'from' | 'subject' | 'body'>): MailItem => {
      const f = parseAddress(x.from);
      return {
        threadId: `thread-${x.id}`, fromName: f.name, fromAddress: f.address, replyAddress: f.address, to: [this.address], date: at(1),
        messageIdHeader: `<${x.id}@mock.${d}>`, references: '', bulk: false, ...x,
      };
    };
    return [
      base({
        id: `mock-inq-${d}-form`, from: `Web サイト <wordpress@${d}>`, subject: '【お問い合わせ】資料のご請求', date: at(5),
        body: 'Web サイトのお問い合わせフォームから送信がありました。\n\nお名前: 山本 太郎\nメールアドレス: yamamoto@example.com\n電話番号: 03-5555-0101\nお問い合わせ内容: 法人向けプランの資料がほしいです。来週中に社内で検討したいので、急ぎでお願いします。\nどこで知りましたか: 検索',
      }),
      base({
        id: `mock-inq-${d}-direct`, from: '佐々木 花子 <sasaki@example.net>', subject: '見積もりのお願い', to: [`sales@${d}`], date: at(3),
        body: 'はじめまして。佐々木と申します。\n知人の紹介でご連絡しました。10 名で使う場合の見積もりをお願いできますでしょうか。\nよろしくお願いいたします。',
      }),
      base({
        id: `mock-inq-${d}-news`, from: 'ニュース便 <news@example.org>', subject: '今週のニュース（第 42 号）', date: at(4), bulk: true,
        body: '今週の話題をお届けします。配信の停止はこちらから。',
      }),
      base({
        id: `mock-inq-${d}-sales`, from: '営業部 <hello@vendor.example>', subject: 'Web 集客のご提案', date: at(2),
        body: '突然のご連絡失礼いたします。弊社サービスのご案内です。貴社の Web 集客を支援いたします。ぜひ一度オンラインでご説明させてください。',
      }),
    ];
  }

  async list(folder: 'inbox' | 'sent', since: Date, limit: number): Promise<string[]> {
    const items = folder === 'inbox' ? this.inbox() : (mockSent.get(this.address) ?? []);
    return items.filter((m) => m.date > since.toISOString()).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit).map((m) => m.id);
  }

  async get(id: string): Promise<MailItem | null> {
    return [...this.inbox(), ...(mockSent.get(this.address) ?? [])].find((m) => m.id === id) ?? null;
  }

  async sendAs(): Promise<string[]> {
    return [this.address, `sales@${this.domain}`];
  }

  async send(m: Parameters<Mailbox['send']>[0]): Promise<{ messageId: string }> {
    const id = `mock-sent-${Math.random().toString(36).slice(2, 10)}`;
    const list = mockSent.get(this.address) ?? [];
    list.push({
      id, threadId: m.threadId ?? `thread-${id}`, from: m.from, fromName: '', fromAddress: m.from, replyAddress: m.from, to: [m.to.toLowerCase()],
      subject: m.subject, date: new Date().toISOString(), messageIdHeader: `<${id}@mock>`, references: m.references ?? '', body: m.body, bulk: false,
    });
    mockSent.set(this.address, list);
    return { messageId: id };
  }
}

/** 窓口のアカウントを開くのに使うもの。 */
export interface MailboxDeps {
  repo: Repository;
  box: SecretBox;
  /** その会社の Google の出どころ（`mock` なら見本の箱）。 */
  sourceFor(tenantId: string): string;
}

/** 会社ごとの開いた箱（アクセス トークンを使い回す）。預け直したら作り直す。 */
const opened = new Map<string, { key: string; box: Mailbox }>();

/**
 * 会社の窓口のアカウントを開く。預けていなければ `null`。
 *
 * @throws {MailboxUnavailableError} 会社の Google のクライアントが無いとき
 */
export async function openMailbox(deps: MailboxDeps, tenantId: string): Promise<Mailbox | null> {
  const cred = await deps.repo.getTenantCredential(tenantId, MAILBOX_KIND);
  const address = typeof cred?.meta['email'] === 'string' ? cred.meta['email'] : '';
  if (!cred || !address) return null;
  const key = `${cred.updatedAt}:${address}`;
  const hit = opened.get(tenantId);
  if (hit?.key === key) return hit.box;
  let box: Mailbox;
  if (cred.meta['mock'] === true || deps.sourceFor(tenantId) === 'mock') {
    box = new MockMailbox(address);
  } else {
    const client = await deps.repo.getTenantCredential(tenantId, 'google_oauth');
    const clientId = typeof client?.meta['clientId'] === 'string' ? client.meta['clientId'] : '';
    if (!client?.secretEnc || !clientId || !cred.secretEnc) throw new MailboxUnavailableError('会社の Google 接続の設定がありません。管理者に伝えてください');
    box = new GoogleMailbox(address, { clientId, clientSecret: deps.box.decrypt(client.secretEnc), refreshToken: deps.box.decrypt(cred.secretEnc) });
  }
  opened.set(tenantId, { key, box });
  return box;
}
