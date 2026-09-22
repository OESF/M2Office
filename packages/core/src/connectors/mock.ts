/**
 * @file 開発用のダミー接続。メール・予定・タスク・チャットについて決まった値を返す。
 *
 * Google の OAuth クライアントが整う前に骨格を作るためのもので、本番では使わない。
 *
 * @see ADR-0003 外部接続の手前に接続口を設ける
 */

import { randomUUID } from 'node:crypto';
import type { SlidePlan } from '../slides/plan.js';
import type {
  BusySlot, CalendarEvent, ConnectorPrincipal, MailMessage, TaskItem, WorkspaceConnector,
} from './types.js';

/**
 * 開発用のダミー接続。
 *
 * Google の OAuth クライアント（B-2）が用意できる前に、
 * メール・予定・タスクを使うエージェントの骨格を作るためのもの。
 * 返す内容は、実行した日を基準にした決まった値である。
 *
 * @remarks
 * - **本番では使わない。** `CONNECTOR_MODE=mock` のときだけ選ばれる
 * - 書き込み（下書き・予定・タスク・投稿）はプロセスのメモリに残すだけで、外へは出ない。
 *   API とワーカーは別プロセスのため、互いの書き込みは見えない
 * - テナントと利用者ごとに記憶を分け、境界を越えて見えないようにする（不変則 I-2）
 */
export class MockWorkspaceConnector implements WorkspaceConnector {
  readonly source = 'mock' as const;
  private readonly createdTasks = new Map<string, TaskItem[]>();
  private readonly createdEvents = new Map<string, CalendarEvent[]>();

  /** 下書き・投稿の記録。動作確認で参照する。 */
  readonly outbox: { kind: 'draft' | 'chat' | 'slides'; principal: ConnectorPrincipal; body: unknown }[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  mail = {
    list: async (p: ConnectorPrincipal, opts: { since?: string; limit?: number }) => {
      const since = opts.since ? Date.parse(opts.since) : 0;
      return this.mails(p)
        .filter((m) => Date.parse(m.receivedAt) >= since)
        .slice(0, opts.limit ?? 20)
        .map(({ body: _body, ...summary }) => summary);
    },
    get: async (p: ConnectorPrincipal, id: string) =>
      this.mails(p).find((m) => m.id === id) ?? null,
    createDraft: async (
      p: ConnectorPrincipal,
      draft: { replyTo: string | null; to: string; subject: string; body: string },
    ) => {
      this.outbox.push({ kind: 'draft', principal: p, body: draft });
      return { draftId: `mock-draft-${randomUUID().slice(0, 8)}` };
    },
  };

  /** Google スライドは作らない。構成を記録し、リンクの無い ID を返す（仕様書 第9.4.2節「鍵・接続が無い環境」）。 */
  slides = {
    createPresentation: async (
      p: ConnectorPrincipal,
      input: { title: string; plan: SlidePlan; template: { presentationId: string; name: string } | null },
    ) => {
      this.outbox.push({ kind: 'slides', principal: p, body: input });
      return { presentationId: `mock-deck-${randomUUID().slice(0, 8)}`, url: null, pptxUrl: null };
    },
  };

  calendar = {
    list: async (p: ConnectorPrincipal, range: { from: string; to: string }) => {
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      return [...this.events(p), ...(this.createdEvents.get(key(p)) ?? [])]
        .filter((e) => Date.parse(e.start) < to && Date.parse(e.end) > from)
        .sort((a, b) => a.start.localeCompare(b.start));
    },
    freeBusy: async (
      _p: ConnectorPrincipal,
      q: { emails: string[]; from: string; to: string },
    ): Promise<BusySlot[]> => {
      // 参加者ごとに、平日の午前 10 時台と午後 3 時台を埋まっているものとする
      const slots: BusySlot[] = [];
      for (const day of businessDays(q.from, q.to)) {
        for (const email of q.emails) {
          slots.push({ email, start: jst(day, 10), end: jst(day, 11) });
          slots.push({ email, start: jst(day, 15), end: jst(day, 16) });
        }
      }
      return slots;
    },
    create: async (
      p: ConnectorPrincipal,
      ev: { title: string; start: string; end: string; attendees: string[] },
    ) => {
      const id = `mock-event-${randomUUID().slice(0, 8)}`;
      const list = this.createdEvents.get(key(p)) ?? [];
      list.push({ id, ...ev, location: null });
      this.createdEvents.set(key(p), list);
      return { eventId: id };
    },
  };

  tasks = {
    list: async (p: ConnectorPrincipal, opts: { includeCompleted?: boolean }) =>
      [...this.baseTasks(p), ...(this.createdTasks.get(key(p)) ?? [])].filter(
        (t) => opts.includeCompleted || !t.completed,
      ),
    create: async (p: ConnectorPrincipal, t: { title: string; due: string | null }) => {
      const id = `mock-task-${randomUUID().slice(0, 8)}`;
      const list = this.createdTasks.get(key(p)) ?? [];
      list.push({ id, title: t.title, due: t.due, completed: false });
      this.createdTasks.set(key(p), list);
      return { taskId: id };
    },
  };

  chat = {
    post: async (p: ConnectorPrincipal, msg: { space: string; text: string }) => {
      this.outbox.push({ kind: 'chat', principal: p, body: msg });
      return { messageId: `mock-msg-${randomUUID().slice(0, 8)}` };
    },
  };

  /** 受信箱の中身。今日を基準に、要返信・要対応・共有のみ・不要を混ぜる。 */
  private mails(p: ConnectorPrincipal): MailMessage[] {
    const today = ymd(this.now());
    const id = (n: number) => `mock-mail-${p.tenantId}-${n}`;
    return [
      {
        id: id(1), from: '佐藤 一郎 <sato@customer.example.jp>',
        subject: '【ご確認】来月分の発注数量について',
        snippet: '来月分の発注数量を 120 個に変更したく、納期への影響をご教示ください。',
        body: 'いつもお世話になっております。来月分の発注数量を 100 個から 120 個に変更したく、' +
          '納期への影響をご教示いただけますでしょうか。今週中にご回答いただけますと幸いです。',
        receivedAt: jst(today, 8, 42), unread: true, labels: ['INBOX'],
      },
      {
        id: id(2), from: '経理部 <keiri@internal.example.jp>',
        subject: '経費精算の締め切り（今月 25 日）',
        snippet: '今月分の経費精算は 25 日までに申請してください。',
        body: '今月分の経費精算は 25 日までに申請してください。領収書の原本は経理部へ提出してください。',
        receivedAt: jst(today, 8, 5), unread: true, labels: ['INBOX'],
      },
      {
        id: id(3), from: '田中 美咲 <tanaka@partner.example.jp>',
        subject: 'お打ち合わせの候補日について',
        snippet: '来週のお打ち合わせですが、火曜か水曜の午後はいかがでしょうか。',
        body: '来週のお打ち合わせですが、火曜か水曜の午後はいかがでしょうか。ご都合をお知らせください。',
        receivedAt: jst(addDays(today, -1), 17, 20), unread: true, labels: ['INBOX'],
      },
      {
        id: id(4), from: 'ニュースレター <news@saas.example.com>',
        subject: '今月の新機能のお知らせ',
        snippet: '今月リリースした新機能をご紹介します。',
        body: '今月リリースした新機能をご紹介します。',
        receivedAt: jst(addDays(today, -1), 12, 0), unread: false, labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
      },
    ];
  }

  private events(p: ConnectorPrincipal): CalendarEvent[] {
    const today = ymd(this.now());
    const id = (n: number) => `mock-event-${p.tenantId}-${n}`;
    return [
      { id: id(1), title: '朝会', start: jst(today, 9, 30), end: jst(today, 9, 45),
        attendees: [], location: 'Google Meet' },
      { id: id(2), title: '佐藤様 定例打ち合わせ', start: jst(today, 14), end: jst(today, 15),
        attendees: ['sato@customer.example.jp'], location: '先方オフィス' },
      { id: id(3), title: '月次の数字の確認', start: jst(addDays(today, 1), 10), end: jst(addDays(today, 1), 11),
        attendees: [], location: '会議室 A' },
      { id: id(4), title: '採用面接', start: jst(addDays(today, 2), 16), end: jst(addDays(today, 2), 17),
        attendees: [], location: '会議室 B' },
    ];
  }

  private baseTasks(p: ConnectorPrincipal): TaskItem[] {
    const today = ymd(this.now());
    const id = (n: number) => `mock-task-${p.tenantId}-${n}`;
    return [
      { id: id(1), title: '見積書の送付（佐藤様）', due: jst(today, 18), completed: false },
      { id: id(2), title: '経費精算の申請', due: jst(addDays(today, 3), 18), completed: false },
      { id: id(3), title: '先週の議事録の確認', due: jst(addDays(today, -2), 18), completed: false },
      { id: id(4), title: '請求書の発行', due: jst(addDays(today, -5), 18), completed: true },
    ];
  }
}

function key(p: ConnectorPrincipal): string {
  return `${p.tenantId}:${p.userId}`;
}

/** 日本時間での日付（YYYY-MM-DD）。 */
export function ymd(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(d);
}

/** 日本時間の日時を ISO 形式で返す。 */
export function jst(day: string, hour: number, minute = 0): string {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${day}T${hh}:${mm}:00+09:00`).toISOString();
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** 期間に含まれる平日（日本時間）を返す。祝日は考慮しない。 */
function businessDays(from: string, to: string): string[] {
  const days: string[] = [];
  let day = ymd(new Date(from));
  const last = ymd(new Date(to));
  while (day <= last && days.length < 31) {
    const dow = new Date(`${day}T12:00:00+09:00`).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(day);
    day = addDays(day, 1);
  }
  return days;
}
