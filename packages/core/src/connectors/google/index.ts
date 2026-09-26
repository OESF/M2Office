/**
 * @file 接続口の `google` 実装（仕様書 第14.3.4節、ADR-0022）。
 *
 * Gmail・カレンダー・ToDo・Chat・ドライブ・ドキュメント・スプレッドシート・スライドを本物にする。
 * 残りのサービスは「準備中」と断る。見本のデータで代わりに動かさない。
 * どの呼び出しも、依頼した本人の Google の許可で行う（不変則 I-9）。
 */

import type { Repository } from '../../repository/types.js';
import type { SecretBox } from '../../secrets/box.js';
import {
  ConnectorUnavailableError, type BusySlot, type CalendarEvent, type ConnectorPrincipal, type MailMessage,
  type MailSummary, type TaskItem, type WorkspaceConnector,
} from '../types.js';
import { GOOGLE_API_ENDPOINTS, GoogleTokenSource, callGoogle, type GoogleApiEndpoints } from './http.js';
import { buildRawMessage, decodeEntities, decodeHeaderWords, extractBody, header, type GmailPart } from './mime.js';
import { externalOf, pickSpace, spaceIdOf, toChatText } from './chat.js';
import { googleDocs, googleDrive } from './drive.js';
import { googleSheets } from './sheets.js';
import { googleSlides } from './slides.js';

/** スペースの一覧を読む上限（ページの数）。1 ページ 1,000 件。 */
const CHAT_SPACE_PAGES = 5;

/** 一覧で一度に返すメールの上限（仕様書 第14.3.4節）。 */
const MAIL_LIMIT_MAX = 50;

/**
 * 秘書と業務が見るメールの範囲。受信トレイの「メイン」だけ（仕様書 第14.3.4節「Gmail」）。
 *
 * @remarks
 * 受信トレイ全体（`INBOX`）には、プロモーション・ソーシャル・新着・フォーラムに振り分けられたものまで入る。
 * 2026-09-26 に oesf で、受信トレイ全体の未読が 5000 通を超え、「メイン」の未読は 13 通だった（三浦さんが画面で見ている数と合う）
 */
const INBOX_MAIN = 'in:inbox category:primary';

/** 未読を数えるときに読む頁の上限（1 頁 500 通）。 */
const UNREAD_COUNT_PAGES = 2;

/** メールの見出しを同時に取りに行く数。多すぎると Google に断られる。 */
const MAIL_FETCH_CONCURRENCY = 8;

/** 日本時間の日付（`YYYY-MM-DD`）の 0 時を ISO にする。終日の予定に使う。 */
const midnightJst = (date: string) => `${date}T00:00:00+09:00`;

/** 日本時間の日付（`YYYY-MM-DD`）の終わりを ISO にする。ToDo の期限に使う（仕様書 第14.3.4節「ToDo」）。 */
const endOfDayJst = (date: string) => `${date}T23:59:59+09:00`;

/** ToDo の件数の上限（1 回の一覧）。 */
const TASKS_LIMIT = 100;

/** Gmail のメッセージ（必要なところだけ）。 */
interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Google の ToDo（必要なところだけ）。 */
interface GTask {
  id: string;
  title?: string;
  status?: 'needsAction' | 'completed';
  due?: string;
}

/** カレンダーの予定（必要なところだけ）。 */
interface GcalEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string }[];
}

/** 並べて処理する。`limit` 個ずつ同時に走らせ、順番は保つ。 */
async function mapLimited<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 準備中のサービスを呼んだときの断り。 */
function notYet(service: string): never {
  // 英字で終わる名前（ToDo・Chat・Meet）の後ろには空白を入れる
  const sep = /[A-Za-z]$/.test(service) ? ' ' : '';
  throw new ConnectorUnavailableError('not-implemented', `${service}${sep}はまだ Google につないでいません（準備中）`);
}

/**
 * 準備中のサービスを、すべての操作で断るものとして作る。
 *
 * @remarks 型の上ではそのサービスの接続口として振る舞い、どの操作を呼んでも {@link notYet} で断る。
 */
function pending<T extends object>(service: string): T {
  return new Proxy({}, { get: () => async () => notYet(service) }) as T;
}

/**
 * 接続口の `google` 実装。
 *
 * @remarks
 * 社内の名簿・Meet・フォームは、まだ `pending` が「準備中」と断る（ADR-0022）。
 * アクセス トークンは {@link GoogleTokenSource} がプロセスのメモリにだけ持つ。
 */
export class GoogleWorkspaceConnector implements WorkspaceConnector {
  private readonly tokens: GoogleTokenSource;

  constructor(
    repo: Repository, box: SecretBox,
    private readonly endpoints: GoogleApiEndpoints = GOOGLE_API_ENDPOINTS,
    now: () => number = () => Date.now(),
  ) {
    this.tokens = new GoogleTokenSource(repo, box, endpoints.oauth, now);
  }

  sourceFor(_tenantId: string): 'google' {
    return 'google';
  }

  // ─── Gmail ──────────────────────────────────────────────────────────

  private gmail(p: ConnectorPrincipal, path: string, init?: { method?: string; body?: unknown }) {
    return callGoogle(this.tokens, p, 'Gmail', `${this.endpoints.gmail}/users/me${path}`, init);
  }

  /** メッセージの ID の一覧から、見出しと抜粋を取りに行く。消えていたものは飛ばす。 */
  private async summaries(p: ConnectorPrincipal, ids: string[]): Promise<MailSummary[]> {
    const q = ['From', 'Subject', 'Date'].map((h) => `metadataHeaders=${h}`).join('&');
    const got = await mapLimited(ids, MAIL_FETCH_CONCURRENCY,
      (id) => this.gmail(p, `/messages/${encodeURIComponent(id)}?format=metadata&${q}`) as Promise<GmailMessage | null>);
    return got.filter((m): m is GmailMessage => m !== null).map((m) => toSummary(m));
  }

  private async listIds(p: ConnectorPrincipal, query: URLSearchParams): Promise<string[]> {
    const res = await this.gmail(p, `/messages?${query}`);
    return ((res?.['messages'] ?? []) as { id: string }[]).map((m) => m.id);
  }

  mail = {
    list: async (p: ConnectorPrincipal, opts: { since?: string; limit?: number }) => {
      const since = opts.since ? Date.parse(opts.since) : NaN;
      const q = new URLSearchParams({
        q: [INBOX_MAIN, ...(Number.isFinite(since) ? [`after:${Math.floor(since / 1000)}`] : [])].join(' '),
        maxResults: String(clampLimit(opts.limit)),
      });
      return this.summaries(p, await this.listIds(p, q));
    },
    unread: async (p: ConnectorPrincipal, opts: { limit?: number; since?: string }) => {
      const since = opts.since ? Date.parse(opts.since) : NaN;
      const query = [INBOX_MAIN, 'is:unread', ...(Number.isFinite(since) ? [`after:${Math.floor(since / 1000)}`] : [])].join(' ');
      // ID だけを数える（中身は読まない）。多すぎるときは上限で打ち切り、「以上」と伝える
      let total = 0;
      let token = '';
      const first: string[] = [];
      for (let page = 0; page < UNREAD_COUNT_PAGES; page++) {
        const q = new URLSearchParams({ q: query, maxResults: '500', ...(token ? { pageToken: token } : {}) });
        const res = await this.gmail(p, `/messages?${q}`);
        const ids = ((res?.['messages'] ?? []) as { id: string }[]).map((m) => m.id);
        if (page === 0) first.push(...ids.slice(0, clampLimit(opts.limit ?? 5)));
        total += ids.length;
        token = String(res?.['nextPageToken'] ?? '');
        if (!token) break;
      }
      return { total, more: !!token, items: await this.summaries(p, first) };
    },
    get: async (p: ConnectorPrincipal, id: string): Promise<MailMessage | null> => {
      const m = await this.gmail(p, `/messages/${encodeURIComponent(id)}?format=full`) as GmailMessage | null;
      if (!m) return null;
      return { ...toSummary(m), body: m.payload ? extractBody(m.payload) : '' };
    },
    search: async (p: ConnectorPrincipal, q: { query: string; limit?: number }) => {
      const params = new URLSearchParams({ q: q.query, maxResults: String(clampLimit(q.limit)) });
      return this.summaries(p, await this.listIds(p, params));
    },
    send: async (p: ConnectorPrincipal, mail: { to: string[]; cc: string[]; subject: string; body: string; replyTo: string | null }) => {
      const thread = mail.replyTo ? await this.threadOf(p, mail.replyTo) : null;
      const raw = buildRawMessage({ ...mail, inReplyTo: thread?.messageId, references: thread?.references });
      const res = await this.gmail(p, '/messages/send', { method: 'POST', body: { raw, ...(thread ? { threadId: thread.threadId } : {}) } });
      return { messageId: String(res?.['id'] ?? '') };
    },
    createDraft: async (p: ConnectorPrincipal, draft: { replyTo: string | null; to: string; subject: string; body: string }) => {
      const thread = draft.replyTo ? await this.threadOf(p, draft.replyTo) : null;
      const raw = buildRawMessage({
        to: draft.to ? [draft.to] : [], cc: [], subject: draft.subject, body: draft.body,
        inReplyTo: thread?.messageId, references: thread?.references,
      });
      const res = await this.gmail(p, '/drafts', { method: 'POST', body: { message: { raw, ...(thread ? { threadId: thread.threadId } : {}) } } });
      return { draftId: String(res?.['id'] ?? '') };
    },
  };

  /**
   * 返信の相手のメールから、スレッドをつなぐための値を引く。見つからなければ `null`（新しいスレッドとして送る）。
   */
  private async threadOf(p: ConnectorPrincipal, id: string): Promise<{ threadId: string; messageId: string; references: string } | null> {
    const q = ['Message-ID', 'References'].map((h) => `metadataHeaders=${h}`).join('&');
    const m = await this.gmail(p, `/messages/${encodeURIComponent(id)}?format=metadata&${q}`) as GmailMessage | null;
    if (!m?.threadId) return null;
    const messageId = header(m.payload ?? {}, 'Message-ID');
    const references = [header(m.payload ?? {}, 'References'), messageId].filter(Boolean).join(' ');
    return { threadId: m.threadId, messageId, references };
  }

  // ─── カレンダー ─────────────────────────────────────────────────────

  private cal(p: ConnectorPrincipal, path: string, init?: { method?: string; body?: unknown }) {
    return callGoogle(this.tokens, p, 'カレンダー', `${this.endpoints.calendar}${path}`, init);
  }

  calendar = {
    list: async (p: ConnectorPrincipal, range: { from: string; to: string }): Promise<CalendarEvent[]> => {
      const q = new URLSearchParams({
        timeMin: new Date(range.from).toISOString(), timeMax: new Date(range.to).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
      });
      const res = await this.cal(p, `/calendars/primary/events?${q}`);
      return ((res?.['items'] ?? []) as GcalEvent[]).map(toEvent);
    },
    freeBusy: async (p: ConnectorPrincipal, q: { emails: string[]; from: string; to: string }) => {
      const res = await this.cal(p, '/freeBusy', {
        method: 'POST',
        body: {
          timeMin: new Date(q.from).toISOString(), timeMax: new Date(q.to).toISOString(), timeZone: 'Asia/Tokyo',
          items: q.emails.map((id) => ({ id })),
        },
      });
      const cals = (res?.['calendars'] ?? {}) as Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
      const busy: BusySlot[] = [];
      const unknown: string[] = [];
      for (const email of q.emails) {
        const c = cals[email];
        // 見られなかった人（社外・非公開・存在しない）を「空き」とみなさない（仕様書 第14.3.4節）
        if (!c || (c.errors?.length ?? 0) > 0) { unknown.push(email); continue; }
        for (const b of c.busy ?? []) busy.push({ email, start: b.start, end: b.end });
      }
      return { busy, unknown };
    },
    create: async (p: ConnectorPrincipal, ev: { title: string; start: string; end: string; attendees: string[] }) => {
      const res = await this.cal(p, '/calendars/primary/events?sendUpdates=all', {
        method: 'POST',
        body: {
          summary: ev.title, start: { dateTime: ev.start, timeZone: 'Asia/Tokyo' }, end: { dateTime: ev.end, timeZone: 'Asia/Tokyo' },
          attendees: ev.attendees.map((email) => ({ email })),
        },
      });
      return { eventId: String(res?.['id'] ?? '') };
    },
    update: async (p: ConnectorPrincipal, ev: { eventId: string; title?: string; start?: string; end?: string; attendees?: string[] }) => {
      const body: Record<string, unknown> = {};
      if (ev.title !== undefined) body['summary'] = ev.title;
      if (ev.start !== undefined) body['start'] = { dateTime: ev.start, timeZone: 'Asia/Tokyo' };
      if (ev.end !== undefined) body['end'] = { dateTime: ev.end, timeZone: 'Asia/Tokyo' };
      if (ev.attendees !== undefined) body['attendees'] = ev.attendees.map((email) => ({ email }));
      const res = await this.cal(p, `/calendars/primary/events/${encodeURIComponent(ev.eventId)}?sendUpdates=all`, { method: 'PATCH', body });
      return res ? { eventId: String(res['id'] ?? ev.eventId) } : null;
    },
    cancel: async (p: ConnectorPrincipal, ev: { eventId: string }) => {
      const res = await this.cal(p, `/calendars/primary/events/${encodeURIComponent(ev.eventId)}?sendUpdates=all`, { method: 'DELETE' });
      return res ? { eventId: ev.eventId } : null;
    },
  };

  // ─── ToDo（仕様書 第14.3.4節「ToDo」） ───────────────────────────────

  private todo(p: ConnectorPrincipal, path: string, init?: { method?: string; body?: unknown; missingOn400?: boolean }) {
    // 本人の既定のリストだけを扱う
    return callGoogle(this.tokens, p, 'ToDo', `${this.endpoints.tasks}/lists/@default${path}`, init);
  }

  tasks = {
    list: async (p: ConnectorPrincipal, opts: { includeCompleted?: boolean }): Promise<TaskItem[]> => {
      const all = opts.includeCompleted ? 'true' : 'false';
      const q = new URLSearchParams({ maxResults: String(TASKS_LIMIT), showCompleted: all, showHidden: all });
      const res = await this.todo(p, `/tasks?${q}`);
      return ((res?.['items'] ?? []) as GTask[]).map(toTask);
    },
    create: async (p: ConnectorPrincipal, t: { title: string; due: string | null }) => {
      const date = t.due ? jstDate(t.due) : null;
      const res = await this.todo(p, '/tasks', {
        method: 'POST',
        // 期限は日付だけが残る。時刻は Google が捨てるので、その日の 0 時（UTC）で渡す
        body: { title: t.title, ...(date ? { due: `${date}T00:00:00.000Z` } : {}) },
      });
      return { taskId: String(res?.['id'] ?? '') };
    },
    complete: async (p: ConnectorPrincipal, t: { taskId: string }) => {
      // 送る中身は決まっている。400 になるのは ID の形が違うときだけで、それは「見つからない」（2026-09-25 に本物で確認）
      const res = await this.todo(p, `/tasks/${encodeURIComponent(t.taskId)}`, { method: 'PATCH', body: { status: 'completed' }, missingOn400: true });
      return res ? { taskId: t.taskId } : null;
    },
  };

  // ─── Chat（仕様書 第14.3.4節「Chat」） ──────────────────────────────

  private chatApi(p: ConnectorPrincipal, path: string, init?: { method?: string; body?: unknown }) {
    return callGoogle(this.tokens, p, 'Chat', `${this.endpoints.chat}${path}`, init);
  }

  /**
   * 投稿先を `spaces/…` にする。リンク・ID ならそのまま、名前なら本人が入っているスペースから探す。
   *
   * @throws {Error} 見つからない・複数ある（利用者に見せる理由の文）
   */
  private async resolveSpace(p: ConnectorPrincipal, input: string): Promise<string> {
    const direct = spaceIdOf(input);
    if (direct) return direct;
    if (!input.trim()) throw new Error('投稿先のチャットのスペースが指定されていません');
    const picked = pickSpace(input, await this.namedSpaces(p));
    if ('reason' in picked) throw new Error(picked.reason);
    return picked.space;
  }

  /** 本人が入っている、名前のあるスペース。1 対 1 とグループの会話は名前で探さないため含めない。 */
  private async namedSpaces(p: ConnectorPrincipal): Promise<{ name: string; displayName?: string; externalUserAllowed?: boolean }[]> {
    const spaces: { name: string; displayName?: string; externalUserAllowed?: boolean }[] = [];
    let pageToken = '';
    for (let page = 0; page < CHAT_SPACE_PAGES; page++) {
      const q = new URLSearchParams({ pageSize: '1000', filter: 'spaceType = "SPACE"', ...(pageToken ? { pageToken } : {}) });
      const res = await this.chatApi(p, `/spaces?${q}`);
      spaces.push(...((res?.['spaces'] ?? []) as { name: string; displayName?: string; externalUserAllowed?: boolean }[]));
      pageToken = String(res?.['nextPageToken'] ?? '');
      if (!pageToken) break;
    }
    return spaces;
  }

  chat = {
    /**
     * 投稿先を探す（承認の前の確かめ。ADR-0024）。名前なら本人が入っているスペースから探し、
     * リンク・ID なら本人がそのスペースを見られるかを確かめる。
     */
    findSpace: async (p: ConnectorPrincipal, input: string) => {
      const direct = spaceIdOf(input);
      if (!direct) {
        if (!input.trim()) return { reason: '投稿先のチャットのスペースが指定されていません' };
        return pickSpace(input, await this.namedSpaces(p));
      }
      try {
        const res = await this.chatApi(p, `/${direct}`);
        if (!res) return { reason: 'リンクのチャットのスペースが見つかりません。リンクを確かめてください' };
        const name = String(res['displayName'] ?? '').trim();
        return { space: direct, displayName: name || null, external: externalOf(res as { externalUserAllowed?: boolean }) };
      } catch (err) {
        if (err instanceof ConnectorUnavailableError) throw err;
        // 入っていないスペースは 403 が返る。存在しない ID には、形が正しくても 400 が返る（2026-09-25 に本物で確認）。
        // どちらも投稿できない
        const msg = err instanceof Error ? err.message : '';
        if (/HTTP 403/.test(msg)) return { reason: 'リンクのチャットのスペースを見られません。あなたがそのスペースに入っているかを確かめてください' };
        if (/HTTP 400/.test(msg)) return { reason: 'リンクのチャットのスペースが見つかりません。リンクを確かめてください' };
        throw err;
      }
    },
    post: async (p: ConnectorPrincipal, msg: { space: string; text: string }) => {
      const space = await this.resolveSpace(p, msg.space);
      const res = await this.chatApi(p, `/${space}/messages`, { method: 'POST', body: { text: toChatText(msg.text) } });
      if (!res) throw new Error('投稿先のチャットのスペースが見つかりません。リンクを確かめるか、そのスペースに入っているかを確かめてください');
      return { messageId: String(res['name'] ?? '') };
    },
  };

  // ─── ドライブ・ドキュメント（仕様書 第14.3.4節「ドライブ」「ドキュメント」） ─────
  // トークンは組み立てのあとに決まるため、呼ぶたびに引く
  drive = googleDrive(() => ({ tokens: this.tokens, endpoints: this.endpoints }));
  docs = googleDocs(() => ({ tokens: this.tokens, endpoints: this.endpoints }));
  // スプレッドシート（仕様書 第14.3.4節「スプレッドシート」）。値は式として読ませない
  sheets = googleSheets(() => ({ tokens: this.tokens, endpoints: this.endpoints }));
  // スライド（仕様書 第9.4.2節「標準の見た目」）。テンプレートのファイルを使わずに組み立てる
  slides = googleSlides(() => ({ tokens: this.tokens, endpoints: this.endpoints }));

  // ─── 準備中（ADR-0022） ──────────────────────────────────────────────


  directory = pending<WorkspaceConnector['directory']>('社内の名簿（ディレクトリ）');
  meet = pending<WorkspaceConnector['meet']>('Meet');
  forms = pending<WorkspaceConnector['forms']>('フォーム');
}

/** 一覧の件数を 1〜50 に収める。 */
function clampLimit(limit: number | undefined): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 20;
  return Math.min(Math.max(n, 1), MAIL_LIMIT_MAX);
}

/** Gmail のメッセージを、接続口のメールの形にする。 */
function toSummary(m: GmailMessage): MailSummary {
  const payload = m.payload ?? {};
  const labels = m.labelIds ?? [];
  const received = m.internalDate ? new Date(Number(m.internalDate)) : new Date(header(payload, 'Date'));
  return {
    id: m.id,
    from: decodeHeaderWords(header(payload, 'From')),
    subject: decodeHeaderWords(header(payload, 'Subject')) || '（件名なし）',
    snippet: decodeEntities(m.snippet ?? ''),
    receivedAt: Number.isFinite(received.getTime()) ? received.toISOString() : '',
    unread: labels.includes('UNREAD'),
    labels,
  };
}

/**
 * 期限の値を、日本時間の日付（`YYYY-MM-DD`）にする。
 *
 * @returns 日付だけならそのまま。時刻つきなら日本時間の日付。読めなければ `null`（期限なしで登録する）
 */
function jstDate(v: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(t));
}

/** Google の ToDo を、接続口の ToDo の形にする。期限は日付の終わり（日本時間）で表す。 */
function toTask(t: GTask): TaskItem {
  const date = t.due ? t.due.slice(0, 10) : null;
  return {
    id: t.id,
    title: t.title || '（無題）',
    due: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? endOfDayJst(date) : null,
    completed: t.status === 'completed',
  };
}

/** カレンダーの予定を、接続口の予定の形にする。終日の予定は日本時間の 0 時で表す。 */
function toEvent(e: GcalEvent): CalendarEvent {
  const allDay = !e.start?.dateTime && !!e.start?.date;
  return {
    id: e.id,
    title: e.summary || '（件名なし）',
    start: e.start?.dateTime ?? (e.start?.date ? midnightJst(e.start.date) : ''),
    end: e.end?.dateTime ?? (e.end?.date ? midnightJst(e.end.date) : ''),
    attendees: (e.attendees ?? []).map((a) => a.email).filter((x): x is string => !!x),
    location: e.location ?? null,
    ...(allDay ? { allDay: true } : {}),
  };
}
