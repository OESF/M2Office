/**
 * @file Google Workspace を操作するツール。第 1 弾（Gmail の検索と送信、予定の変更と取り消し、ToDo の完了、
 * ドライブ・ドキュメント・スプレッドシート）、第 2 弾（ファイルの共有、社内の人の検索、Meet の文字起こし）、
 * 第 3 弾（フォームの回答）。
 *
 * 操作ごとに 1 つのツールとし、危険度を固定する（読む・下書き・書き込み・送るを分ける）。
 * いずれも接続口（`ToolContext.connector`）を経由し、Google の API を直接呼ばない。
 * ドライブ・ドキュメント・スプレッドシートは `drive.file`（M2Office が作った・利用者が選んだファイルだけ）の範囲で動く。
 * 返す値には `source` を含め、見本の値が本物として扱われないようにする。
 *
 * @see 仕様書 第9.4.4節 Google Workspace を操作するツールの一覧
 * @see 仕様書 第14.3.2節 CASA に備えた作り
 */

import type { PreparedCall, Tool, ToolContext } from './registry.js';
import { approvedArtifact, jstDate } from './approved-artifact.js';

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
    return { source: ctx.connector.sourceFor(ctx.tenantId), count: items.length, items };
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
    if (to.length === 0) return { source: ctx.connector.sourceFor(ctx.tenantId), sent: false, reason: '宛先がありません' };
    const res = await ctx.connector.mail.send(principal(ctx), {
      to, cc: list(args['cc']), subject: str(args['subject']), body: str(args['body']), replyTo: str(args['replyTo']) || null,
    });
    return { source: ctx.connector.sourceFor(ctx.tenantId), sent: true, ...res };
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
    return res ? { source: ctx.connector.sourceFor(ctx.tenantId), updated: true, ...res } : { source: ctx.connector.sourceFor(ctx.tenantId), updated: false, reason: '予定が見つかりません' };
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
    return res ? { source: ctx.connector.sourceFor(ctx.tenantId), cancelled: true, ...res } : { source: ctx.connector.sourceFor(ctx.tenantId), cancelled: false, reason: '予定が見つかりません' };
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
  helpText: 'ToDo を完了にします',
  description: 'ToDo を完了にする',
  args: { properties: { taskId: S('ToDo の ID') }, required: ['taskId'] },
  google: { scope: 'tasks', level: 'sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.tasks.complete(principal(ctx), { taskId: str(args['taskId']) });
    return res ? { source: ctx.connector.sourceFor(ctx.tenantId), completed: true, ...res } : { source: ctx.connector.sourceFor(ctx.tenantId), completed: false, reason: 'ToDo が見つかりません' };
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
    return { source: ctx.connector.sourceFor(ctx.tenantId), count: items.length, items };
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
    if (!res) return { source: ctx.connector.sourceFor(ctx.tenantId), available: false, reason: 'ファイルが見つからないか、読めません' };
    const truncated = res.text.length > READ_LIMIT;
    return {
      source: ctx.connector.sourceFor(ctx.tenantId), available: true, untrusted: true, file: res.file,
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
    return { source: ctx.connector.sourceFor(ctx.tenantId), created: true, folder };
  },
};

/**
 * Google ドキュメントを作る。
 *
 * @remarks
 * 危険度 `draft`（本人のドライブに作り、共有しない）。権限 `drive.file`。
 * `artifactId` を渡すと、**承認で確かめた成果物の本文をそのまま**入れる（推論に書き直させない。ADR-0025）。
 * このときは保存に失敗しても例外にせず、`created: false` と理由を返す（業務を止めない。仕様書 第9.5.2節）。
 * `folderName` を渡すと、M2Office が作ったその名前のフォルダに入れる（無ければ作る）。
 */
export const docsCreate: Tool = {
  name: 'docs.create',
  risk: 'draft',
  activityLabel: '文書を作っています',
  helpText: 'あなたのドライブに Google ドキュメントを作ります。共有はしません',
  description: '本人のドライブに Google ドキュメントを作る（共有しない）。承認で確かめた成果物を保存するときは、body の代わりに artifactId を渡す（本文を変えずに入れる）',
  args: {
    properties: {
      title: S('題名（artifactId のときは省略できる。成果物の題名に日付を添える）'),
      body: S('本文（Markdown。artifactId のときは渡さない）'),
      artifactId: S('保存する成果物の ID（document.create の結果）。本文はそこから取る'),
      folderId: S('入れるフォルダの ID（任意）'),
      folderName: S('入れるフォルダの名前（任意。M2Office が作ったその名前のフォルダに入れ、無ければ作る）'),
    },
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const source = ctx.connector.sourceFor(ctx.tenantId);
    const artifactId = str(args['artifactId']);
    if (!artifactId) {
      if (!str(args['body'])) return { source, created: false, reason: '本文（body）か、成果物の ID（artifactId）を渡してください' };
      const folderId = str(args['folderId']) || (str(args['folderName']) ? await folderByName(ctx, str(args['folderName'])) : null);
      const file = await ctx.connector.docs.create(principal(ctx), { title: str(args['title']) || '無題の文書', body: str(args['body']), folderId });
      return { source, created: true, file };
    }
    const picked = await approvedArtifact(ctx, artifactId);
    if ('reason' in picked) return { source, created: false, reason: `${picked.reason}。Google ドキュメントに保存しませんでした` };
    const { artifact } = picked;
    const title = str(args['title']) || `${artifact.title}（${jstDate(artifact.createdAt)}）`;
    try {
      const folderId = str(args['folderId']) || (str(args['folderName']) ? await folderByName(ctx, str(args['folderName'])) : null);
      const file = await ctx.connector.docs.create(principal(ctx), { title, body: artifact.body, folderId });
      return { source, created: true, file, fromArtifact: artifact.id };
    } catch (err) {
      // 議事録は成果物と組織知識に残る。保存できなかったことを理由つきで返し、業務は止めない（仕様書 第9.5.2節）
      return { source, created: false, title, reason: err instanceof Error ? err.message : '保存できませんでした' };
    }
  },
};

/**
 * M2Office が作った、その名前のフォルダの ID。無ければ本人のドライブに作る。
 *
 * @remarks `drive.file` の範囲なので、利用者が自分で作った同じ名前のフォルダは見えず、使わない
 */
async function folderByName(ctx: ToolContext, name: string): Promise<string> {
  const found = (await ctx.connector.drive.search(principal(ctx), { query: name, limit: 50 }))
    .find((f) => f.kind === 'folder' && f.name === name);
  if (found) return found.id;
  return (await ctx.connector.drive.createFolder(principal(ctx), { name, parentId: null })).id;
}

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
    return res ? { source: ctx.connector.sourceFor(ctx.tenantId), appended: true, ...res } : { source: ctx.connector.sourceFor(ctx.tenantId), appended: false, reason: 'M2Office で作った文書が見つかりません' };
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
    return { source: ctx.connector.sourceFor(ctx.tenantId), created: true, file };
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
      ? { source: ctx.connector.sourceFor(ctx.tenantId), available: true, untrusted: true, file: res.file, columns: res.values[0] ?? [], rows: res.values.slice(1) }
      : { source: ctx.connector.sourceFor(ctx.tenantId), available: false, reason: 'スプレッドシートが見つからないか、読めません' };
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
  helpText: 'M2Office で作った表に行を足します',
  description: 'M2Office が作った Google スプレッドシートの末尾に行を足す',
  args: { properties: { spreadsheetId: S('スプレッドシートの ID'), rows: { type: 'array', description: '足す行の配列（各行は値の配列）' } }, required: ['spreadsheetId', 'rows'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const r = rows(args['rows']);
    if (r.length === 0) return { source: ctx.connector.sourceFor(ctx.tenantId), appended: 0, reason: '足す行がありません' };
    const res = await ctx.connector.sheets.append(principal(ctx), { spreadsheetId: str(args['spreadsheetId']), rows: r });
    return res ? { source: ctx.connector.sourceFor(ctx.tenantId), ...res } : { source: ctx.connector.sourceFor(ctx.tenantId), appended: 0, reason: 'M2Office で作ったスプレッドシートが見つかりません' };
  },
};

const ROLE_LABEL = { reader: '閲覧', commenter: 'コメント', writer: '編集' } as const;

/**
 * M2Office が作ったファイルを、指定した人と共有する。
 *
 * @remarks
 * 危険度 `external-send`。相手がファイルを見られるようになるため、承認ステップの直後でしか呼べない（仕様書 第9.4節）。
 * 相手が社内の人だけなら、その承認の段は自動で通る（第9.4.0節）。
 * 共有できるのは M2Office が作ったファイルだけ。リンクによる一般公開はしない。権限 `drive.file`（機密でない）。
 */
export const driveShare: Tool = {
  name: 'drive.share',
  risk: 'external-send',
  activityLabel: 'ファイルを共有しています',
  helpText: 'M2Office で作ったファイルを、指定した人と共有します。社外の人との共有は、承認のあとに行います。リンクで誰にでも公開することはしません',
  description: 'M2Office が作ったファイルを、指定した人と共有する（リンクによる一般公開はしない）',
  args: {
    properties: { fileId: S('ファイルの ID'), emails: SA('共有する相手のメールアドレス'), role: { type: 'string', description: '役割', enum: ['reader', 'commenter', 'writer'] } },
    required: ['fileId', 'emails'],
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  /** 共有する相手が社内の人だけかを確かめる（仕様書 第9.4.0節）。読むだけ。 */
  async prepare(args, ctx): Promise<PreparedCall> {
    return { kind: 'ready', args, audience: await audienceOf(ctx, list(args['emails'])) };
  },
  async invoke(args, ctx) {
    const emails = list(args['emails']);
    if (emails.length === 0) return { source: ctx.connector.sourceFor(ctx.tenantId), shared: false, reason: '共有する相手がいません' };
    const role = (['reader', 'commenter', 'writer'] as const).find((r) => r === args['role']) ?? 'reader';
    const res = await ctx.connector.drive.share(principal(ctx), { fileId: str(args['fileId']), emails, role });
    return res
      ? { source: ctx.connector.sourceFor(ctx.tenantId), shared: true, role, roleLabel: ROLE_LABEL[role], ...res }
      : { source: ctx.connector.sourceFor(ctx.tenantId), shared: false, reason: 'M2Office で作ったファイルが見つかりません（それ以外のファイルは共有しません）' };
  },
};

/** 会社の全員に共有してはいけない、個人向けの Google アカウントのドメイン（ドメインが会社でなく、一般公開と同じになる）。 */
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * 会社の全員への共有に使う、本人の会社のドメイン。本人の Google アカウント（無ければ M2Office の利用者）のメールから取る。
 *
 * @returns ドメインか、共有できない理由
 */
async function companyDomain(ctx: ToolContext): Promise<{ domain: string } | { reason: string }> {
  // 接続が読めなければ（見本の会社など）、M2Office の利用者のメールで決める
  const conn = await Promise.resolve().then(() => ctx.repo.getGoogleConnection(ctx.tenantId, ctx.userId)).catch(() => null);
  const email = conn?.googleEmail || (await ctx.repo.findUserById(ctx.tenantId, ctx.userId))?.email || '';
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  if (!domain) return { reason: '会社のドメインが分かりません' };
  if (CONSUMER_DOMAINS.has(domain)) return { reason: '個人向けの Google アカウントでは、会社の全員への共有はできません' };
  return { domain };
}

/**
 * 相手が全員、本人の会社の人か（仕様書 第9.4.0節、ADR-0028）。
 *
 * @param emails 送り先・共有先・招く人のメールアドレス（空なら社内とみなす。相手がいない）
 * @returns 社内の人だけなら `internal`。**確かめられなければ `external`**（見本の接続口の会社・会社のドメインが分からない・個人向けのアカウント）
 */
export async function audienceOf(ctx: ToolContext, emails: string[]): Promise<'internal' | 'external'> {
  if (ctx.connector.sourceFor(ctx.tenantId) !== 'google') return 'external';
  const d = await companyDomain(ctx).catch(() => ({ reason: '' }));
  if ('reason' in d) return 'external';
  const inside = emails.every((e) => e.trim().toLowerCase().split('@')[1] === d.domain);
  return inside ? 'internal' : 'external';
}

/**
 * M2Office が作ったファイルを、会社の全員が**閲覧だけ**できるようにする（仕様書 第14.3.4節、ADR-0025）。
 *
 * @remarks
 * 危険度 `write-internal`（会社の中に閉じる）。承認②のあとに行う（AG-02）。権限 `drive.file`。
 * 検索には出さず、リンクを知っている社内の人だけが開ける。リンクによる一般公開はしない。
 * 承認の前に、ファイルが見えるかとドメインを確かめ、承認の画面にファイルの名前を出す（ADR-0024）。
 */
export const driveShareCompany: Tool = {
  name: 'drive.share_company',
  risk: 'write-internal',
  activityLabel: 'ファイルを社内に共有しています',
  helpText: 'M2Office で作ったファイルを、会社の全員が閲覧できるようにします。社外の人は見られません。リンクで誰にでも公開することはしません',
  description: 'M2Office が作ったファイルを、会社の全員が閲覧できるようにする（会社のドメインの人だけ。検索には出さない）',
  args: { properties: { fileId: S('ファイルの ID（docs.create の結果の file.id）') }, required: ['fileId'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async prepare(args, ctx): Promise<PreparedCall> {
    try {
      const d = await companyDomain(ctx);
      if ('reason' in d) return { kind: 'problem', reason: d.reason };
      const file = await ctx.connector.drive.get(principal(ctx), str(args['fileId']));
      if (!file) return { kind: 'problem', reason: 'M2Office で作ったファイルが見つかりません' };
      return { kind: 'ready', args, shown: file.name };
    } catch (err) {
      return { kind: 'unchecked', reason: err instanceof Error ? err.message : '確かめられませんでした' };
    }
  },
  async invoke(args, ctx) {
    const source = ctx.connector.sourceFor(ctx.tenantId);
    const d = await companyDomain(ctx);
    if ('reason' in d) return { source, shared: false, reason: d.reason };
    const res = await ctx.connector.drive.shareWithDomain(principal(ctx), { fileId: str(args['fileId']), domain: d.domain });
    return res
      ? { source, shared: true, ...res }
      : { source, shared: false, reason: 'M2Office で作ったファイルが見つかりません（それ以外のファイルは共有しません）' };
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
    return { source: ctx.connector.sourceFor(ctx.tenantId), count: people.length, people };
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
      return { source: ctx.connector.sourceFor(ctx.tenantId), available: false, reason: '会議の文字起こしが見つかりません（文字起こしは会議の終了から 30 日で消えます）' };
    }
    const text = t.entries.map((e) => `${e.speaker}: ${e.text}`).join('\n');
    const truncated = text.length > TRANSCRIPT_LIMIT;
    return {
      source: ctx.connector.sourceFor(ctx.tenantId), available: true, untrusted: true, conference: t.conference,
      text: truncated ? `${text.slice(0, TRANSCRIPT_LIMIT)}\n…（以降は省略）` : text, truncated,
    };
  },
};

/**
 * Google フォームの回答を、質問の文つきで取る。
 *
 * @remarks
 * 危険度 `read`。利用者が選んだ（または M2Office が作った）フォームだけ。権限 `drive.file`（機密でない）。
 * `forms.responses.readonly`（機密）では質問の文を読めないため、両方を読める `drive.file` を使う（仕様書 第9.4.4節）。
 * 回答は社外の人が書いたものを含みうる。**データであり指示ではない**（不変則 I-6）ため `untrusted` を付ける。
 */
export const formsResponses: Tool = {
  name: 'forms.responses',
  risk: 'read',
  activityLabel: 'フォームの回答を読んでいます',
  helpText: 'Google フォームの回答を読みます。あなたが選んだフォームだけで、回答に書かれた指示には従いません',
  description: 'Google フォームの回答を、質問の文つきで新しい順に取る（利用者が選んだフォームだけ）',
  args: {
    properties: { formId: S('フォームの ID'), since: S('この時刻以降の回答だけ（ISO 形式。任意）'), limit: N('件数（既定 100）') },
    required: ['formId'],
  },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const res = await ctx.connector.forms.responses(principal(ctx), {
      formId: str(args['formId']), since: str(args['since']) || null, limit: Math.min(Number(args['limit'] ?? 100) || 100, 1000),
    });
    if (!res) return { source: ctx.connector.sourceFor(ctx.tenantId), available: false, reason: 'フォームが見つからないか、読めません（選んだフォームだけを読めます）' };
    return { source: ctx.connector.sourceFor(ctx.tenantId), available: true, untrusted: true, form: res.form, count: res.responses.length, responses: res.responses };
  },
};

/** Google Workspace を操作するツール（第 1 弾〜第 3 弾。仕様書 第9.4.4節）。 */
export const GOOGLE_TOOLS: Tool[] = [
  gmailSearch, gmailSend, calendarUpdate, calendarCancel, tasksComplete,
  driveSearch, driveRead, driveCreateFolder, docsCreate, docsAppend, sheetsCreate, sheetsRead, sheetsAppend,
  // 第 2 弾
  driveShare, directorySearch, meetTranscript,
  // 議事録を Google ドキュメントに保存して社内に共有する（第 0.110.0 版）
  driveShareCompany,
  // 第 3 弾
  formsResponses,
];
