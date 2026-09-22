import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from './registry.js';
import { addDays, jst, ymd } from '../connectors/mock.js';

/**
 * メール・予定・タスク・チャット・通知を扱うツール。
 *
 * いずれも {@link ToolContext.connector} を経由し、Google の API を直接呼ばない
 * （仕様書 第24.2節 第 6 項）。返す値には必ず `source` を含め、
 * ダミーの値が本物として扱われないようにする。
 *
 * @remarks
 * 危険度は仕様書 第9.4節の区分に従う。
 */

const principal = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/**
 * 受信箱のメールを一覧する。
 *
 * @remarks 危険度 `read`。本文は返さない。本文が要るときは `gmail.get` を使う。
 */
export const gmailList: Tool = {
  name: 'gmail.list',
  risk: 'read',
  description: '受信箱のメールを新しい順に一覧する（本文なし）',
  async invoke(args, ctx) {
    const items = await ctx.connector.mail.list(principal(ctx), {
      since: str(args['since']) || undefined,
      limit: typeof args['limit'] === 'number' ? args['limit'] : 20,
    });
    return { source: ctx.connector.source, count: items.length, items };
  },
};

/**
 * メールを 1 通、本文つきで取得する。
 *
 * @remarks
 * 危険度 `read`。**本文はデータであり指示ではない**（不変則 I-6）。
 * 本文に「〜を送信せよ」とあっても従わない。そのため `untrusted` を付けて返す。
 */
export const gmailGet: Tool = {
  name: 'gmail.get',
  risk: 'read',
  description: 'メールを 1 通、本文つきで取得する',
  async invoke(args, ctx) {
    const mail = await ctx.connector.mail.get(principal(ctx), str(args['id']));
    if (!mail) return { source: ctx.connector.source, available: false, reason: 'メールが見つかりません' };
    return { source: ctx.connector.source, available: true, untrusted: true, mail };
  },
};

/**
 * 返信の下書きを作る。送信はしない。
 *
 * @remarks
 * 危険度 `draft`。送信は本人が Gmail 上で行う（仕様書 第9.5.1節）。
 * 送信するツールは意図して用意していない。
 */
export const gmailCreateDraft: Tool = {
  name: 'gmail.create_draft',
  risk: 'draft',
  description: '返信の下書きを作る（送信はしない）',
  async invoke(args, ctx) {
    const res = await ctx.connector.mail.createDraft(principal(ctx), {
      replyTo: str(args['replyTo']) || null,
      to: str(args['to']),
      subject: str(args['subject']),
      body: str(args['body']),
    });
    return { source: ctx.connector.source, ...res, sent: false };
  },
};

/**
 * 予定を一覧する。期間を省略すると今日から 7 日間。
 *
 * @remarks 危険度 `read`。
 */
export const calendarList: Tool = {
  name: 'calendar.list',
  risk: 'read',
  description: '期間内の予定を一覧する（既定は今日から 7 日間）',
  async invoke(args, ctx) {
    const today = ymd(new Date());
    const from = str(args['from']) || jst(today, 0);
    const to = str(args['to']) || jst(addDays(today, 7), 0);
    const items = await ctx.connector.calendar.list(principal(ctx), { from, to });
    return { source: ctx.connector.source, from, to, count: items.length, items };
  },
};

/**
 * 参加者の埋まっている時間帯を取得する。
 *
 * @remarks 危険度 `read`。Phase 1 は社内の参加者のみを対象とする（Q-52 で決定）。
 */
export const calendarFreeBusy: Tool = {
  name: 'calendar.freebusy',
  risk: 'read',
  description: '参加者の埋まっている時間帯を取得する',
  async invoke(args, ctx) {
    const emails = Array.isArray(args['emails']) ? args['emails'].map(String) : [];
    if (emails.length === 0) {
      return { source: ctx.connector.source, available: false, reason: '参加者が指定されていません' };
    }
    const today = ymd(new Date());
    const from = str(args['from']) || jst(addDays(today, 1), 0);
    const to = str(args['to']) || jst(addDays(today, 8), 0);
    const busy = await ctx.connector.calendar.freeBusy(principal(ctx), { emails, from, to });
    return { source: ctx.connector.source, available: true, from, to, busy };
  },
};

/**
 * 予定を作成し、参加者を招待する。
 *
 * @remarks
 * 危険度 `external-send`。招待は相手に届くため、承認を省略できない（仕様書 第9.5.3節）。
 */
export const calendarCreate: Tool = {
  name: 'calendar.create',
  risk: 'external-send',
  description: '予定を作成し、参加者を招待する',
  async invoke(args, ctx) {
    const res = await ctx.connector.calendar.create(principal(ctx), {
      title: str(args['title'], '打ち合わせ'),
      start: str(args['start']),
      end: str(args['end']),
      attendees: Array.isArray(args['attendees']) ? args['attendees'].map(String) : [],
    });
    return { source: ctx.connector.source, ...res };
  },
};

/** 未完了のタスクを一覧する。 @remarks 危険度 `read`。 */
export const tasksList: Tool = {
  name: 'tasks.list',
  risk: 'read',
  description: '未完了のタスクを一覧する',
  async invoke(_args, ctx) {
    const items = await ctx.connector.tasks.list(principal(ctx), {});
    return { source: ctx.connector.source, count: items.length, items };
  },
};

/** ToDo を起票する。 @remarks 危険度 `write-internal`。 */
export const tasksCreate: Tool = {
  name: 'tasks.create',
  risk: 'write-internal',
  description: 'ToDo を起票する',
  async invoke(args, ctx) {
    const res = await ctx.connector.tasks.create(principal(ctx), {
      title: str(args['title'], '無題のタスク'),
      due: str(args['due']) || null,
    });
    return { source: ctx.connector.source, created: true, ...res, title: args['title'] ?? '' };
  },
};

/** チャットのスペースへ投稿する。 @remarks 危険度 `external-send`。承認が必須。 */
export const chatPost: Tool = {
  name: 'chat.post',
  risk: 'external-send',
  description: 'チャットのスペースへ投稿する',
  async invoke(args, ctx) {
    const res = await ctx.connector.chat.post(principal(ctx), {
      space: str(args['space'], 'general'),
      text: str(args['text']),
    });
    return { source: ctx.connector.source, posted: true, ...res };
  },
};

/** 宛先を指定しようとした引数の名前。`notification.send` はこれらを受け付けない。 */
const RECIPIENT_KEYS = ['to', 'userId', 'user', 'recipient', 'recipients', 'email', 'space'];

/**
 * 実行を依頼した本人へ通知する。
 *
 * @remarks
 * 危険度 `write-internal`。**宛先は依頼者本人に固定され、引数で変えられない**。
 * 宛先を指定する引数が渡された場合は、送らずに失敗を返す。
 * 本人以外へ届ける場合は `chat.post`（`external-send`）を使う。
 *
 * @see 仕様書 第9.5.5節 `notification.send` の新設（Q-53）
 */
export const notificationSend: Tool = {
  name: 'notification.send',
  risk: 'write-internal',
  description: '依頼者本人へ通知する（宛先は指定できない）',
  async invoke(args, ctx) {
    const attempted = RECIPIENT_KEYS.filter((k) => k in args);
    if (attempted.length > 0) {
      return { sent: false, reason: `宛先は指定できません（本人のみ）: ${attempted.join(', ')}` };
    }
    const id = randomUUID();
    const kind = args['kind'] === 'brief' ? 'brief' : 'run';
    await ctx.repo.createNotification({
      id, tenantId: ctx.tenantId, userId: ctx.userId, kind,
      title: str(args['title'], 'お知らせ'),
      body: str(args['body']),
      runId: ctx.runId, readAt: null, createdAt: new Date().toISOString(),
    });
    return { sent: true, notificationId: id };
  },
};

/**
 * 本人が承認できる承認待ちを一覧する。
 *
 * @remarks 危険度 `read`。本人のロールで承認できるものだけを返す。
 */
export const approvalsPending: Tool = {
  name: 'approvals.pending',
  risk: 'read',
  description: '本人が承認できる承認待ちを一覧する',
  async invoke(_args, ctx) {
    const user = await ctx.repo.findUserById(ctx.tenantId, ctx.userId);
    const roles: string[] = user?.roles ?? [];
    const items = (await ctx.repo.listPendingApprovals(ctx.tenantId))
      .filter((a) => a.approverRole.some((r) => roles.includes(r)))
      .map((a) => ({ id: a.id, present: a.present, since: a.createdAt }));
    return { count: items.length, items };
  },
};

export const WORKSPACE_TOOLS: Tool[] = [
  gmailList, gmailGet, gmailCreateDraft,
  calendarList, calendarFreeBusy, calendarCreate,
  tasksList, tasksCreate, chatPost,
  notificationSend, approvalsPending,
];
