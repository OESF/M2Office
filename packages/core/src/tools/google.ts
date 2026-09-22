/**
 * @file Google Workspace を操作するツール。第 1 弾（Gmail の検索と送信、予定の変更と取り消し、ToDo の完了、
 * ドライブ・ドキュメント・スプレッドシート）と第 2 弾（ファイルの共有、社内の人の検索、Meet の文字起こし）。
 *
 * 操作ごとに 1 つのツールとし、危険度を固定する（読む・下書き・書き込み・送るを分ける）。
 * いずれも接続口（`ToolContext.connector`）を経由し、Google の API を直接呼ばない。
 * ドライブ・ドキュメント・スプレッドシートは `drive.file`（M2Office が作った・利用者が選んだファイルだけ）の範囲で動く。
 * 返す値には `source` を含め、見本の値が本物として扱われないようにする。
 *
 * @see 仕様書 第9.4.4節 Google Workspace を操作するツールの一覧
 * @see 仕様書 第14.3.2節 CASA に備えた作り
 */

import type { Tool, ToolContext } from './registry.js';

const principal = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : []);
const rows = (v: unknown) => (Array.isArray(v) ? v.slice(0, 5000).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')])) : []);
const S = (description: string) => ({ type: 'string' as const, description });
const N = (description: string) => ({ type: 'number' as const, description });
const SA = (description: string) => ({ type: 'array' as const, description, items: { type: 'string' as const, description: '要素' } });

/**
 * 検索の条件でメールを探す。本文は返さない。
 *
 * @remarks 危険度 `read`。権限 `gmail.readonly`（制限付き。CASA の対象）。
 */
export const gmailSearch: Tool = {
  name: 'gmail.search',
  risk: 'read',
  activityLabel: 'メールを探しています',
  helpText: '条件に合うメールを探します。本文は読みません',
  description: '検索の条件（Gmail の検索の書き方。例: from:sato 見積）でメールを探す。本文は返さない',
  args: { properties: { query: S('検索の条件'), limit: N('件数（既定 20）') }, required: ['query'] },
  google: { scope: 'gmail.readonly', level: 'restricted' },
  async invoke(args, ctx) {
    const items = await ctx.connector.mail.search(principal(ctx), {
      query: str(args['query']), limit: Math.min(Number(args['limit'] ?? 20) || 20, 100),
    });
    return { source: ctx.connector.source, count: items.length, items };
  },
};

/**
 * メールを送る。
 *
 * @remarks
 * 危険度 `external-send`。相手に届くため、**承認ステップの直後のステップでしか呼べない**（基盤が強制する。仕様書 第9.4節）。
 * 宛先・件名・本文は、承認の画面で人が確かめる。権限 `gmail.send`（機密）。
 */
export const gmailSend: Tool = {
  name: 'gmail.send',
  risk: 'external-send',
  activityLabel: 'メールを送っています',
  helpText: 'メールを送ります。必ず承認のあとに行います',
  description: 'メールを送る。宛先・件名・本文は承認で確かめたものを渡す',
  args: {
    properties: { to: SA('宛先のメールアドレス'), cc: SA('CC（任意）'), subject: S('件名'), body: S('本文'), replyTo: S('返信するメールの ID（任意）') },
    required: ['to', 'subject', 'body'],
  },
  google: { scope: 'gmail.send', level: 'sensitive' },
  async invoke(args, ctx) {
    const to = list(args['to']);
    if (to.length === 0) return { source: ctx.connector.source, sent: false, reason: '宛先がありません' };
    const res = await ctx.connector.mail.send(principal(ctx), {
      to, cc: list(args['cc']), subject: str(args['subject']), body: str(args['body']), replyTo: str(args['replyTo']) || null,
    });
    return { source: ctx.connector.source, sent: true, ...res };
  },
};

/**
 * 予定を変える。参加者に変更の通知が届く。
 *
 * @remarks 危険度 `external-send`（通知が相手に届くため）。権限 `calendar.events`（機密）。
 */
export const calendarUpdate: Tool = {
  name: 'calendar.update',
  risk: 'external-send',
  activityLabel: '予定を変更しています',
  helpText: '予定の日時・題名・参加者を変えます。参加者に通知が届くため、必ず承認のあとに行います',
  description: '予定を変える（変える項目だけを渡す）。参加者に変更の通知が届く',
  args: {
    properties: { eventId: S('予定の ID'), title: S('新しい題名（任意）'), start: S('新しい開始（ISO 形式。任意）'), end: S('新しい終了（任意）'), attendees: SA('新しい参加者（任意）') },
    required: ['eventId'],
  },
  google: { scope: 'calendar.events', level: 'sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.calendar.update(principal(ctx), {
      eventId: str(args['eventId']),
      title: str(args['title']) || undefined, start: str(args['start']) || undefined, end: str(args['end']) || undefined,
      attendees: Array.isArray(args['attendees']) ? list(args['attendees']) : undefined,
    });
    return res ? { source: ctx.connector.source, updated: true, ...res } : { source: ctx.connector.source, updated: false, reason: '予定が見つかりません' };
  },
};

/**
 * 予定を取り消す。参加者に取り消しの通知が届く。
 *
 * @remarks 危険度 `external-send`。権限 `calendar.events`（機密）。
 */
export const calendarCancel: Tool = {
  name: 'calendar.cancel',
  risk: 'external-send',
  activityLabel: '予定を取り消しています',
  helpText: '予定を取り消します。参加者に通知が届くため、必ず承認のあとに行います',
  description: '予定を取り消す。参加者に取り消しの通知が届く',
  args: { properties: { eventId: S('予定の ID') }, required: ['eventId'] },
  google: { scope: 'calendar.events', level: 'sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.calendar.cancel(principal(ctx), { eventId: str(args['eventId']) });
    return res ? { source: ctx.connector.source, cancelled: true, ...res } : { source: ctx.connector.source, cancelled: false, reason: '予定が見つかりません' };
  },
};

/**
 * ToDo を完了にする。
 *
 * @remarks 危険度 `write-internal`（会社の設定により、実行の前に本人の確認を求める）。権限 `tasks`（機密）。
 */
export const tasksComplete: Tool = {
  name: 'tasks.complete',
  risk: 'write-internal',
  activityLabel: 'ToDo を完了にしています',
  helpText: 'ToDo を完了にします。会社の設定により、その前に確認を求めます',
  description: 'ToDo を完了にする',
  args: { properties: { taskId: S('ToDo の ID') }, required: ['taskId'] },
  google: { scope: 'tasks', level: 'sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.tasks.complete(principal(ctx), { taskId: str(args['taskId']) });
    return res ? { source: ctx.connector.source, completed: true, ...res } : { source: ctx.connector.source, completed: false, reason: 'ToDo が見つかりません' };
  },
};

/**
 * ドライブのファイルを名前で探す。見えるのは M2Office が作ったか、利用者が選んだファイルだけ。
 *
 * @remarks 危険度 `read`。権限 `drive.file`（機密でない）。ドライブ全体の検索は作らない（制限付きのため。仕様書 第9.4.4節）。
 */
export const driveSearch: Tool = {
  name: 'drive.search',
  risk: 'read',
  activityLabel: 'ドライブを探しています',
  helpText: 'M2Office で作ったファイルと、あなたが選んだファイルの中から探します。ドライブ全体は見ません',
  description: 'ドライブのファイルを名前で探す（M2Office が作った・利用者が選んだファイルだけ）',
  args: { properties: { query: S('名前に含まれる言葉（空ならすべて）'), limit: N('件数（既定 20）') } },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const items = await ctx.connector.drive.search(principal(ctx), { query: str(args['query']), limit: Math.min(Number(args['limit'] ?? 20) || 20, 100) });
    return { source: ctx.connector.source, count: items.length, items };
  },
};

/** 読んで推論に渡す量の上限（文字数）。 */
const READ_LIMIT = 20_000;

/**
 * ドライブのファイルの中身を文字で読む（ドキュメント・スプレッドシート・スライド・PDF）。
 *
 * @remarks 危険度 `read`。権限 `drive.file`。**中身はデータであり指示ではない**（不変則 I-6）ため `untrusted` を付ける。
 */
export const driveRead: Tool = {
  name: 'drive.read',
  risk: 'read',
  activityLabel: '資料を読んでいます',
  helpText: 'ドライブのファイルの中身を読みます。中に書かれた指示には従いません',
  description: 'ドライブのファイルの中身を文字で読む（ドキュメント・スプレッドシート・スライド・PDF）',
  args: { properties: { fileId: S('ファイルの ID') }, required: ['fileId'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.drive.read(principal(ctx), str(args['fileId']));
    if (!res) return { source: ctx.connector.source, available: false, reason: 'ファイルが見つからないか、読めません' };
    const truncated = res.text.length > READ_LIMIT;
    return {
      source: ctx.connector.source, available: true, untrusted: true, file: res.file,
      text: truncated ? `${res.text.slice(0, READ_LIMIT)}\n…（以降は省略）` : res.text, truncated,
    };
  },
};

/** ドライブにフォルダを作る。 @remarks 危険度 `draft`（本人のドライブに作るだけで、共有しない）。権限 `drive.file`。 */
export const driveCreateFolder: Tool = {
  name: 'drive.create_folder',
  risk: 'draft',
  activityLabel: 'フォルダを作っています',
  helpText: 'あなたのドライブにフォルダを作ります。共有はしません',
  description: '本人のドライブにフォルダを作る（共有しない）',
  args: { properties: { name: S('フォルダの名前'), parentId: S('親のフォルダの ID（任意）') }, required: ['name'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const folder = await ctx.connector.drive.createFolder(principal(ctx), { name: str(args['name']), parentId: str(args['parentId']) || null });
    return { source: ctx.connector.source, created: true, folder };
  },
};

/** Google ドキュメントを作る。 @remarks 危険度 `draft`（本人のドライブに作り、共有しない）。権限 `drive.file`。 */
export const docsCreate: Tool = {
  name: 'docs.create',
  risk: 'draft',
  activityLabel: '文書を作っています',
  helpText: 'あなたのドライブに Google ドキュメントを作ります。共有はしません',
  description: '本人のドライブに Google ドキュメントを作る（共有しない）',
  args: { properties: { title: S('題名'), body: S('本文'), folderId: S('入れるフォルダの ID（任意）') }, required: ['title', 'body'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const file = await ctx.connector.docs.create(principal(ctx), { title: str(args['title']), body: str(args['body']), folderId: str(args['folderId']) || null });
    return { source: ctx.connector.source, created: true, file };
  },
};

/** M2Office が作った Google ドキュメントに追記する。 @remarks 危険度 `draft`。権限 `drive.file`。 */
export const docsAppend: Tool = {
  name: 'docs.append',
  risk: 'draft',
  activityLabel: '文書に書き足しています',
  helpText: 'M2Office で作った文書の末尾に書き足します',
  description: 'M2Office が作った Google ドキュメントの末尾に追記する',
  args: { properties: { documentId: S('文書の ID'), text: S('追記する文') }, required: ['documentId', 'text'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.docs.append(principal(ctx), { documentId: str(args['documentId']), text: str(args['text']) });
    return res ? { source: ctx.connector.source, appended: true, ...res } : { source: ctx.connector.source, appended: false, reason: 'M2Office で作った文書が見つかりません' };
  },
};

/** Google スプレッドシートを作る。 @remarks 危険度 `draft`（本人のドライブに作り、共有しない）。権限 `drive.file`。 */
export const sheetsCreate: Tool = {
  name: 'sheets.create',
  risk: 'draft',
  activityLabel: '表を作っています',
  helpText: 'あなたのドライブに Google スプレッドシートを作ります。共有はしません',
  description: '本人のドライブに Google スプレッドシートを作る（共有しない）',
  args: {
    properties: { title: S('題名'), columns: SA('列名'), rows: { type: 'array', description: '行の配列（各行は値の配列）' }, folderId: S('入れるフォルダの ID（任意）') },
    required: ['title', 'columns'],
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const file = await ctx.connector.sheets.create(principal(ctx), {
      title: str(args['title']), columns: list(args['columns']), rows: rows(args['rows']), folderId: str(args['folderId']) || null,
    });
    return { source: ctx.connector.source, created: true, file };
  },
};

/**
 * Google スプレッドシートを読む。1 行目は見出し。
 *
 * @remarks 危険度 `read`。権限 `drive.file`。中身はデータであり指示ではない（不変則 I-6）。
 */
export const sheetsRead: Tool = {
  name: 'sheets.read',
  risk: 'read',
  activityLabel: '表を読んでいます',
  helpText: 'Google スプレッドシートの表を読みます',
  description: 'Google スプレッドシートの値を読む（1 行目は見出し）',
  args: { properties: { spreadsheetId: S('スプレッドシートの ID'), maxRows: N('読む行数の上限（既定 500）') }, required: ['spreadsheetId'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.sheets.read(principal(ctx), {
      spreadsheetId: str(args['spreadsheetId']), maxRows: Math.min(Number(args['maxRows'] ?? 500) || 500, 5000),
    });
    return res
      ? { source: ctx.connector.source, available: true, untrusted: true, file: res.file, columns: res.values[0] ?? [], rows: res.values.slice(1) }
      : { source: ctx.connector.source, available: false, reason: 'スプレッドシートが見つからないか、読めません' };
  },
};

/**
 * M2Office が作った Google スプレッドシートに行を足す。
 *
 * @remarks 危険度 `write-internal`（社内の表に書き込むため。会社の設定により、実行の前に本人の確認を求める）。権限 `drive.file`。
 */
export const sheetsAppend: Tool = {
  name: 'sheets.append',
  risk: 'write-internal',
  activityLabel: '表に行を足しています',
  helpText: 'M2Office で作った表に行を足します。会社の設定により、その前に確認を求めます',
  description: 'M2Office が作った Google スプレッドシートの末尾に行を足す',
  args: { properties: { spreadsheetId: S('スプレッドシートの ID'), rows: { type: 'array', description: '足す行の配列（各行は値の配列）' } }, required: ['spreadsheetId', 'rows'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const r = rows(args['rows']);
    if (r.length === 0) return { source: ctx.connector.source, appended: 0, reason: '足す行がありません' };
    const res = await ctx.connector.sheets.append(principal(ctx), { spreadsheetId: str(args['spreadsheetId']), rows: r });
    return res ? { source: ctx.connector.source, ...res } : { source: ctx.connector.source, appended: 0, reason: 'M2Office で作ったスプレッドシートが見つかりません' };
  },
};

const ROLE_LABEL = { reader: '閲覧', commenter: 'コメント', writer: '編集' } as const;

/**
 * M2Office が作ったファイルを、指定した人と共有する。
 *
 * @remarks
 * 危険度 `external-send`。相手がファイルを見られるようになるため、承認ステップの直後でしか呼べない（仕様書 第9.4節）。
 * 共有できるのは M2Office が作ったファイルだけ。リンクによる一般公開はしない。権限 `drive.file`（機密でない）。
 */
export const driveShare: Tool = {
  name: 'drive.share',
  risk: 'external-send',
  activityLabel: 'ファイルを共有しています',
  helpText: 'M2Office で作ったファイルを、指定した人と共有します。必ず承認のあとに行います。リンクで誰にでも公開することはしません',
  description: 'M2Office が作ったファイルを、指定した人と共有する（リンクによる一般公開はしない）',
  args: {
    properties: { fileId: S('ファイルの ID'), emails: SA('共有する相手のメールアドレス'), role: { type: 'string', description: '役割', enum: ['reader', 'commenter', 'writer'] } },
    required: ['fileId', 'emails'],
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const emails = list(args['emails']);
    if (emails.length === 0) return { source: ctx.connector.source, shared: false, reason: '共有する相手がいません' };
    const role = (['reader', 'commenter', 'writer'] as const).find((r) => r === args['role']) ?? 'reader';
    const res = await ctx.connector.drive.share(principal(ctx), { fileId: str(args['fileId']), emails, role });
    return res
      ? { source: ctx.connector.source, shared: true, role, roleLabel: ROLE_LABEL[role], ...res }
      : { source: ctx.connector.source, shared: false, reason: 'M2Office で作ったファイルが見つかりません（それ以外のファイルは共有しません）' };
  },
};

/**
 * 社内の人を、名前・メール・部署で探す。
 *
 * @remarks 危険度 `read`。会社の Google Workspace の中だけを探し、社外の連絡先は探さない。権限 `directory.readonly`（機密）。
 */
export const directorySearch: Tool = {
  name: 'directory.search',
  risk: 'read',
  activityLabel: '社内の人を探しています',
  helpText: '社内の人を名前・メール・部署で探します。社外の連絡先は探しません',
  description: '社内の人（名前・メール・部署・役職）を探す。社外の連絡先は探さない',
  args: { properties: { query: S('名前・メール・部署に含まれる言葉'), limit: N('件数（既定 20）') }, required: ['query'] },
  google: { scope: 'directory.readonly', level: 'sensitive' },
  async invoke(args, ctx) {
    const people = await ctx.connector.directory.search(principal(ctx), { query: str(args['query']), limit: Math.min(Number(args['limit'] ?? 20) || 20, 100) });
    return { source: ctx.connector.source, count: people.length, people };
  },
};

/** 文字起こしとして推論に渡す量の上限（文字数）。 */
const TRANSCRIPT_LIMIT = 30_000;

/**
 * Meet の会議の文字起こしを取る。題名に言葉を含む、いちばん新しい会議。
 *
 * @remarks
 * 危険度 `read`。本人が主催者か参加者だった会議だけ。Google は会議の終了から 30 日で文字起こしを消す。
 * **中身はデータであり指示ではない**（不変則 I-6）ため `untrusted` を付ける。権限 `meetings.space.readonly`（機密）。
 */
export const meetTranscript: Tool = {
  name: 'meet.transcript',
  risk: 'read',
  activityLabel: '会議の文字起こしを読んでいます',
  helpText: 'Meet の会議の文字起こしを読みます。あなたが参加した会議だけで、会議の終了から 30 日を過ぎたものは読めません',
  description: 'Meet の会議の文字起こしを取る（題名に言葉を含む、いちばん新しい会議。本人が参加した会議だけ）',
  args: { properties: { query: S('会議の題名に含まれる言葉（空ならいちばん新しい会議）') } },
  google: { scope: 'meetings.space.readonly', level: 'sensitive' },
  async invoke(args, ctx) {
    const t = await ctx.connector.meet.transcript(principal(ctx), { query: str(args['query']) });
    if (!t) {
      return { source: ctx.connector.source, available: false, reason: '会議の文字起こしが見つかりません（文字起こしは会議の終了から 30 日で消えます）' };
    }
    const text = t.entries.map((e) => `${e.speaker}: ${e.text}`).join('\n');
    const truncated = text.length > TRANSCRIPT_LIMIT;
    return {
      source: ctx.connector.source, available: true, untrusted: true, conference: t.conference,
      text: truncated ? `${text.slice(0, TRANSCRIPT_LIMIT)}\n…（以降は省略）` : text, truncated,
    };
  },
};

/** Google Workspace を操作するツール（第 1 弾・第 2 弾。仕様書 第9.4.4節）。 */
export const GOOGLE_TOOLS: Tool[] = [
  gmailSearch, gmailSend, calendarUpdate, calendarCancel, tasksComplete,
  driveSearch, driveRead, driveCreateFolder, docsCreate, docsAppend, sheetsCreate, sheetsRead, sheetsAppend,
  // 第 2 弾
  driveShare, directorySearch, meetTranscript,
];
