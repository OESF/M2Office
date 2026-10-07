/**
 * @file 開発用のダミー接続。メール・予定・タスク・チャットについて決まった値を返す。
 *
 * Google の OAuth クライアントが整う前に骨格を作るためのもので、本番では使わない。
 *
 * @see ADR-0003 外部接続の手前に接続口を設ける
 */

import { randomUUID } from 'node:crypto';
import type { SlidePlan } from '../slides/plan.js';
import { renderSvgPng } from '../columns/cover.js';
import type {
  BusySlot, CalendarEvent, ConnectorPrincipal, DriveFile, MailMessage, TaskItem, WorkspaceConnector,
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
/** 見本の Chat のスペース（仕様書 第16.7.12.1節）。名前で探すときは、これまでどおりどの名前でも見つかる。 */
const MOCK_SPACES = [
  { space: 'spaces/mock-sales', displayName: '営業部（見本）', external: false },
  { space: 'spaces/mock-tech-team', displayName: '技術チーム（見本）', external: false },
  { space: 'spaces/mock-all', displayName: '全社（見本）', external: false },
];

/** 見本の写真（名前と色）。 */
const MOCK_PHOTOS = [{ name: '店内の写真（見本）.png', color: '#c9a27e' }, { name: '商品の写真（見本）.png', color: '#7ea8c9' }];
const mockPhotoCache = new Map<string, Uint8Array>();
/** 見本の写真の中身（色の地に丸を描いた PNG。一度だけ作る）。 */
function mockPhoto(color: string): Uint8Array {
  let png = mockPhotoCache.get(color);
  if (!png) {
    png = renderSvgPng(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${color}"/><circle cx="200" cy="150" r="90" fill="#ffffff" opacity="0.55"/></svg>`, 400);
    mockPhotoCache.set(color, png);
  }
  return png;
}

export class MockWorkspaceConnector implements WorkspaceConnector {
  /** 見本の接続口は、どの会社でも見本である。 */
  sourceFor(_tenantId: string): 'mock' {
    return 'mock';
  }
  private readonly createdTasks = new Map<string, TaskItem[]>();
  private readonly createdEvents = new Map<string, CalendarEvent[]>();

  /** 下書き・投稿の記録。動作確認で参照する。 */
  readonly outbox: {
    kind: 'draft' | 'chat' | 'slides' | 'mail' | 'event.update' | 'event.cancel' | 'drive.share' | 'drive.share_company';
    principal: ConnectorPrincipal; body: unknown;
  }[] = [];
  /** 完了にした ToDo（見本の ToDo にも効かせる）。 */
  private readonly completedTasks = new Set<string>();
  /** 取り消した予定。 */
  private readonly cancelledEvents = new Set<string>();
  /** 変更して、作った予定の側に置き換えた見本の予定。 */
  private readonly replacedEvents = new Set<string>();
  /** M2Office が作ったドライブのファイル（文書は本文、表は値を持つ）。 */
  private readonly driveFiles = new Map<string, { file: DriveFile; owner: string; text?: string; values?: string[][]; bytes?: Uint8Array; mimeType?: string }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  mail = {
    list: async (p: ConnectorPrincipal, opts: { since?: string; limit?: number }) => {
      const since = opts.since ? Date.parse(opts.since) : 0;
      return this.mails(p)
        .filter((m) => Date.parse(m.receivedAt) >= since)
        .slice(0, opts.limit ?? 20)
        .map(({ body: _body, ...summary }) => summary);
    },
    unread: async (p: ConnectorPrincipal, opts: { limit?: number; since?: string }) => {
      const since = opts.since ? Date.parse(opts.since) : 0;
      const unread = this.mails(p).filter((m) => m.unread && Date.parse(m.receivedAt) >= since)
        .map(({ body: _body, ...summary }) => summary);
      return { total: unread.length, more: false, items: unread.slice(0, opts.limit ?? 5) };
    },
    get: async (p: ConnectorPrincipal, id: string) =>
      this.mails(p).find((m) => m.id === id) ?? null,
    search: async (p: ConnectorPrincipal, q: { query: string; limit?: number }) => {
      // 見本では、件名・差出人・本文の部分一致で探す（Gmail の検索の書き方のうち、言葉だけを見る）
      const words = q.query.replace(/\b(from|subject|is|in|label):\S+/g, ' ').split(/\s+/).filter(Boolean);
      return this.mails(p)
        .filter((m) => words.every((w) => `${m.from} ${m.subject} ${m.body}`.includes(w)))
        .slice(0, q.limit ?? 20)
        .map(({ body: _body, ...summary }) => summary);
    },
    send: async (
      p: ConnectorPrincipal,
      mail: { to: string[]; cc: string[]; subject: string; body: string; replyTo: string | null; listUnsubscribe?: string },
    ) => {
      this.outbox.push({ kind: 'mail', principal: p, body: mail });
      return { messageId: `mock-sent-${randomUUID().slice(0, 8)}` };
    },
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
    // 見本の接続口にはテンプレートのファイルが無い。読めないことを返し、標準のレイアウトで構成させる
    readTemplate: async () => null,
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
      return [...this.events(p).filter((e) => !this.replacedEvents.has(e.id)), ...(this.createdEvents.get(key(p)) ?? [])]
        .filter((e) => !this.cancelledEvents.has(e.id))
        .filter((e) => Date.parse(e.start) < to && Date.parse(e.end) > from)
        .sort((a, b) => a.start.localeCompare(b.start));
    },
    freeBusy: async (
      _p: ConnectorPrincipal,
      q: { emails: string[]; from: string; to: string },
    ): Promise<{ busy: BusySlot[]; unknown: string[] }> => {
      // 参加者ごとに、平日の午前 10 時台と午後 3 時台を埋まっているものとする
      const slots: BusySlot[] = [];
      for (const day of businessDays(q.from, q.to)) {
        for (const email of q.emails) {
          slots.push({ email, start: jst(day, 10), end: jst(day, 11) });
          slots.push({ email, start: jst(day, 15), end: jst(day, 16) });
        }
      }
      // 見本では、全員の予定が見えるものとする
      return { busy: slots, unknown: [] };
    },
    create: async (
      p: ConnectorPrincipal,
      ev: { title: string; start: string; end: string; attendees: string[]; location?: string; description?: string },
    ) => {
      const id = `mock-event-${randomUUID().slice(0, 8)}`;
      const list = this.createdEvents.get(key(p)) ?? [];
      list.push({ id, title: ev.title, start: ev.start, end: ev.end, attendees: ev.attendees, location: ev.location ?? null });
      this.createdEvents.set(key(p), list);
      return { eventId: id };
    },
    update: async (
      p: ConnectorPrincipal,
      ev: { eventId: string; title?: string; start?: string; end?: string; attendees?: string[]; location?: string; description?: string },
    ) => {
      const created = this.createdEvents.get(key(p)) ?? [];
      const target = created.find((e) => e.id === ev.eventId) ?? this.events(p).find((e) => e.id === ev.eventId);
      if (!target || this.cancelledEvents.has(ev.eventId)) return null;
      const next: CalendarEvent = {
        ...target,
        ...(ev.title !== undefined ? { title: ev.title } : {}),
        ...(ev.start !== undefined ? { start: ev.start } : {}),
        ...(ev.end !== undefined ? { end: ev.end } : {}),
        ...(ev.attendees !== undefined ? { attendees: ev.attendees } : {}),
        ...(ev.location !== undefined ? { location: ev.location } : {}),
      };
      this.createdEvents.set(key(p), [...created.filter((e) => e.id !== ev.eventId), next]);
      this.replacedEvents.add(ev.eventId);
      this.outbox.push({ kind: 'event.update', principal: p, body: ev });
      return { eventId: ev.eventId };
    },
    cancel: async (p: ConnectorPrincipal, ev: { eventId: string }) => {
      const exists = [...this.events(p), ...(this.createdEvents.get(key(p)) ?? [])].some((e) => e.id === ev.eventId);
      if (!exists || this.cancelledEvents.has(ev.eventId)) return null;
      this.cancelledEvents.add(ev.eventId);
      this.outbox.push({ kind: 'event.cancel', principal: p, body: ev });
      return { eventId: ev.eventId };
    },
  };

  tasks = {
    list: async (p: ConnectorPrincipal, opts: { includeCompleted?: boolean }) =>
      [...this.baseTasks(p), ...(this.createdTasks.get(key(p)) ?? [])]
        .map((t) => (this.completedTasks.has(t.id) ? { ...t, completed: true } : t))
        .filter((t) => opts.includeCompleted || !t.completed),
    create: async (p: ConnectorPrincipal, t: { title: string; due: string | null }) => {
      const id = `mock-task-${randomUUID().slice(0, 8)}`;
      const list = this.createdTasks.get(key(p)) ?? [];
      list.push({ id, title: t.title, due: t.due, completed: false });
      this.createdTasks.set(key(p), list);
      return { taskId: id };
    },
    complete: async (p: ConnectorPrincipal, t: { taskId: string }) => {
      const exists = [...this.baseTasks(p), ...(this.createdTasks.get(key(p)) ?? [])].some((x) => x.id === t.taskId);
      if (!exists) return null;
      this.completedTasks.add(t.taskId);
      return { taskId: t.taskId };
    },
  };

  /** ドライブ。見本のファイルと、この接続口で作ったファイルが見える（`drive.file` の範囲を模す）。 */
  drive = {
    search: async (p: ConnectorPrincipal, q: { query: string; limit?: number }) =>
      this.visibleFiles(p).filter((f) => q.query.trim() === '' || f.file.name.includes(q.query.trim()))
        .slice(0, q.limit ?? 20).map((f) => f.file),
    read: async (p: ConnectorPrincipal, fileId: string) => {
      const f = this.visibleFiles(p).find((x) => x.file.id === fileId);
      if (!f || f.file.kind === 'folder') return null;
      const text = f.values ? f.values.map((r) => r.join('\t')).join('\n') : f.text ?? '';
      return { file: f.file, text };
    },
    createFolder: async (p: ConnectorPrincipal, input: { name: string; parentId: string | null }) =>
      this.addFile(p, input.name, 'folder', {}),
    upload: async (p: ConnectorPrincipal, input: { name: string; mimeType: string; bytes: Uint8Array; parentId: string | null }) => {
      if (input.parentId && !this.visibleFiles(p).some((x) => x.file.id === input.parentId)) throw new Error('入れるフォルダが見つかりません');
      return this.addFile(p, input.name, input.mimeType === 'application/pdf' ? 'pdf' : 'other', { bytes: input.bytes.slice(), mimeType: input.mimeType });
    },
    download: async (p: ConnectorPrincipal, fileId: string) => {
      const f = this.visibleFiles(p).find((x) => x.file.id === fileId) as { file: DriveFile; bytes?: Uint8Array; mimeType?: string; text?: string } | undefined;
      if (!f || f.file.kind === 'folder') return null;
      return { file: f.file, mimeType: f.mimeType ?? 'text/plain', bytes: f.bytes ?? new TextEncoder().encode(f.text ?? '') };
    },
    get: async (p: ConnectorPrincipal, fileId: string) => this.visibleFiles(p).find((x) => x.file.id === fileId)?.file ?? null,
    shareWithDomain: async (p: ConnectorPrincipal, s: { fileId: string; domain: string }) => {
      const f = this.driveFiles.get(s.fileId);
      // 共有できるのは本人が M2Office で作ったファイルだけ（drive.file の範囲を模す）
      if (!f || f.owner !== key(p)) return null;
      this.outbox.push({ kind: 'drive.share_company', principal: p, body: s });
      return { fileId: s.fileId, domain: s.domain };
    },
    share: async (p: ConnectorPrincipal, s: { fileId: string; emails: string[]; role: 'reader' | 'commenter' | 'writer' }) => {
      const f = this.driveFiles.get(s.fileId);
      // 共有できるのは本人が M2Office で作ったファイルだけ（drive.file の範囲を模す）
      if (!f || f.owner !== key(p)) return null;
      this.outbox.push({ kind: 'drive.share', principal: p, body: s });
      return { fileId: s.fileId, sharedWith: s.emails };
    },
  };

  /** 社内の人。見本の人はテナントのドメインではなく example.jp を使い、名前に（見本）を付ける。 */
  directory = {
    search: async (p: ConnectorPrincipal, q: { query: string; limit?: number }) => {
      const people = [
        { name: '山田 花子（見本）', email: `yamada@${p.tenantId}.example.jp`, department: '営業部', title: '課長' },
        { name: '鈴木 次郎（見本）', email: `suzuki@${p.tenantId}.example.jp`, department: '開発部', title: null },
        { name: '高橋 三郎（見本）', email: `takahashi@${p.tenantId}.example.jp`, department: '人事部', title: '部長' },
      ];
      const w = q.query.trim();
      return people.filter((x) => !w || `${x.name} ${x.email} ${x.department ?? ''}`.includes(w)).slice(0, q.limit ?? 20);
    },
  };

  /** フォームの回答。見本のフォームを 1 つ持つ（題名に（見本））。 */
  forms = {
    responses: async (p: ConnectorPrincipal, q: { formId: string; since: string | null; limit: number }) => {
      if (q.formId !== `mock-file-${p.tenantId}-3`) return null;
      const today = ymd(this.now());
      const all = [
        { id: 'r3', submittedAt: jst(today, 11), respondent: null, answers: { '満足度': '4', 'よかった点': '見本の回答: 説明が分かりやすかった', '改善してほしい点': '見本の回答: 資料を事前にほしい' } },
        { id: 'r2', submittedAt: jst(addDays(today, -1), 16), respondent: null, answers: { '満足度': '5', 'よかった点': '見本の回答: 質問に丁寧に答えてもらえた', '改善してほしい点': '' } },
        { id: 'r1', submittedAt: jst(addDays(today, -3), 10), respondent: null, answers: { '満足度': '3', 'よかった点': '見本の回答: 時間どおりに終わった', '改善してほしい点': '見本の回答: 会場が狭かった' } },
      ];
      const since = q.since ? Date.parse(q.since) : 0;
      return {
        form: { id: q.formId, title: '研修のアンケート（見本）', questions: ['満足度', 'よかった点', '改善してほしい点'] },
        responses: all.filter((r) => Date.parse(r.submittedAt) >= since).slice(0, q.limit),
      };
    },
  };

  /** Meet の文字起こし。見本の会議を 1 つ持つ（題名に（見本））。 */
  meet = {
    transcript: async (_p: ConnectorPrincipal, q: { query: string }) => {
      const today = ymd(this.now());
      const conference = {
        id: 'mock-conf-1', title: '営業定例（見本）', startedAt: jst(addDays(today, -1), 14), endedAt: jst(addDays(today, -1), 15),
      };
      if (q.query.trim() && !conference.title.includes(q.query.trim())) return null;
      return {
        conference,
        entries: [
          { speaker: '山田 花子（見本）', text: 'これは見本の文字起こしです。来月の重点顧客を確認します。', at: jst(addDays(today, -1), 14, 1) },
          { speaker: '鈴木 次郎（見本）', text: '佐藤様への提案は来週までに準備します。', at: jst(addDays(today, -1), 14, 5) },
        ],
      };
    },
  };

  docs = {
    create: async (p: ConnectorPrincipal, d: { title: string; body: string; folderId: string | null }) =>
      this.addFile(p, d.title, 'document', { text: d.body }),
    append: async (p: ConnectorPrincipal, d: { documentId: string; text: string }) => {
      const f = this.driveFiles.get(d.documentId);
      // 追記できるのは M2Office が作った文書だけ（見本のファイルには追記しない）
      if (!f || f.owner !== key(p) || f.file.kind !== 'document') return null;
      f.text = `${f.text ?? ''}\n${d.text}`;
      f.file = { ...f.file, modifiedAt: this.now().toISOString() };
      return { documentId: d.documentId };
    },
  };

  sheets = {
    create: async (p: ConnectorPrincipal, s: { title: string; columns: string[]; rows: string[][]; folderId: string | null }) =>
      this.addFile(p, s.title, 'spreadsheet', { values: [s.columns, ...s.rows] }),
    read: async (p: ConnectorPrincipal, s: { spreadsheetId: string; maxRows: number }) => {
      const f = this.visibleFiles(p).find((x) => x.file.id === s.spreadsheetId && x.file.kind === 'spreadsheet');
      return f ? { file: f.file, values: (f.values ?? []).slice(0, s.maxRows + 1) } : null;
    },
    append: async (p: ConnectorPrincipal, s: { spreadsheetId: string; rows: string[][] }) => {
      const f = this.driveFiles.get(s.spreadsheetId);
      if (!f || f.owner !== key(p) || f.file.kind !== 'spreadsheet') return null;
      f.values = [...(f.values ?? []), ...s.rows];
      return { appended: s.rows.length };
    },
  };

  private addFile(
    p: ConnectorPrincipal, name: string, kind: DriveFile['kind'], content: { text?: string; values?: string[][]; bytes?: Uint8Array; mimeType?: string },
  ): DriveFile {
    const file: DriveFile = { id: `mock-file-${randomUUID().slice(0, 8)}`, name, kind, modifiedAt: this.now().toISOString(), url: null };
    this.driveFiles.set(file.id, { file, owner: key(p), ...content });
    return file;
  }

  /** 見えるファイル。見本のファイル（テナントごと）と、本人が作ったファイル。 */
  private visibleFiles(p: ConnectorPrincipal) {
    const today = ymd(this.now());
    const id = (n: number) => `mock-file-${p.tenantId}-${n}`;
    const samples: { file: DriveFile; text?: string; values?: string[][]; mimeType?: string; bytes?: Uint8Array }[] = [
      { file: { id: id(1), name: '営業会議メモ（見本）', kind: 'document' as const, modifiedAt: jst(today, 9), url: null },
        text: '見本の文書です。\n議題: 来月の重点顧客\n決定: 佐藤様への提案を来週までに準備する' },
      { file: { id: id(2), name: '顧客一覧（見本）', kind: 'spreadsheet' as const, modifiedAt: jst(addDays(today, -1), 17), url: null },
        values: [['会社名', '担当', '状況'], ['見本商事', '佐藤', '提案中'], ['見本工業', '田中', '契約済み']] },
      { file: { id: id(3), name: '研修のアンケート（見本）', kind: 'form' as const, modifiedAt: jst(addDays(today, -3), 9), url: null },
        text: '見本のフォームです。質問: 満足度、よかった点、改善してほしい点' },
      // 見本の写真（販促物の作成の「ドライブから」。第41.19.2節）
      ...MOCK_PHOTOS.map((m, i) => ({
        file: { id: id(4 + i), name: m.name, kind: 'other' as const, modifiedAt: jst(addDays(today, -7), 10), url: null } as DriveFile,
        mimeType: 'image/png', get bytes() { return mockPhoto(m.color); },
      })),
    ];
    return [...samples, ...[...this.driveFiles.values()].filter((f) => f.owner === key(p))];
  }

  chat = {
    /**
     * 見本では、指定があればどのスペースも見つかる。指定をそのまま投稿先とする
     * （見本の投稿はスペースを区別しないため。通しの確認が見る投稿先を変えない）。
     */
    findSpace: async (_p: ConnectorPrincipal, input: string) => {
      const name = input.trim();
      if (!name) return { reason: '投稿先のチャットのスペースが指定されていません' };
      // 見本のスペースは、社外の人が入れるか分からない。分からないものは社外とみなす（仕様書 第9.4.0節）
      return { space: name, displayName: /^spaces\//.test(name) ? null : name, external: null };
    },
    /** 見本のスペース（グループの名前で共有するときの候補。仕様書 第16.7.12.1節）。 */
    listSpaces: async (_p: ConnectorPrincipal) => MOCK_SPACES.map((s) => ({ ...s })),
    /**
     * 見本のメンバー。「技術チーム」には確かめた人が全員と、もう 1 人入っている。ほかのスペースには誰も入っていない。
     * 会社の外の人と Google のグループは入っていない。
     */
    members: async (_p: ConnectorPrincipal, space: string, emails: string[]) => {
      const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
      if (!MOCK_SPACES.some((s) => s.space === space)) return null;
      const all = space === 'spaces/mock-tech-team';
      return { humans: all ? list.length + 1 : 3, googleGroups: 0, external: 0, present: all ? list : [], absent: all ? [] : list, unknown: [] };
    },
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
