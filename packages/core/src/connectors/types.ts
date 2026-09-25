/**
 * @file 業務システムへの接続口（コネクタ）の型。メール・予定・タスク・チャット・ドライブ・ドキュメント・スプレッドシート・スライドの操作を定める。
 *
 * ツール層はこのインターフェースだけを見て、Google の API を直接呼ばない。
 * 実装は `mock`（ダミー）と `google`（仕様書 第14.3.4節。Gmail とカレンダーから）の 2 つ。
 * どちらも返す値に出どころ（`DataSource`）を含め、ダミーを本物と取り違えないようにする。
 *
 * @see 仕様書 第14.5節 Google 以外のグループウェアへの対応
 * @see 仕様書 第24.2節 第 6 項
 */

import type { SlidePlan } from '../slides/plan.js';

/** 値の出どころ。画面と監査ログで区別して表示する。 */
export type DataSource = 'mock' | 'google';

/**
 * 接続口が呼べないときの理由（仕様書 第14.3.4節「断るときの言葉」）。
 *
 * - `not-connected`: 本人が Google と接続していない
 * - `revoked`: 許可が取り消されたか、期限が切れた
 * - `insufficient-scope`: その操作に要る許可が無い
 * - `api-disabled`: 会社の Google Cloud で、その API が有効になっていない
 * - `no-client` / `client-error`: 会社の OAuth クライアントが無い・誤っている
 * - `not-implemented`: その会社の接続口で、まだ本物につないでいないサービス（準備中）
 * - `unreachable`: Google に届かない・混み合っている
 */
export type ConnectorUnavailableKind =
  | 'not-connected' | 'revoked' | 'insufficient-scope' | 'api-disabled'
  | 'no-client' | 'client-error' | 'not-implemented' | 'unreachable';

/**
 * 接続口が呼べないことを伝える例外（ADR-0022）。
 *
 * @remarks
 * **文にはメールや予定の中身を入れない。** 実行の失敗の理由として、管理者の一覧にも出るためである。
 * エンジンは、読むだけのツール（危険度 `read`）でこれを受けたら実行を止めず、
 * 「取得できませんでした」と理由つきで推論に返す。書くツールならステップを失敗にする。
 */
export class ConnectorUnavailableError extends Error {
  constructor(readonly kind: ConnectorUnavailableKind, message: string) {
    super(message);
    this.name = 'ConnectorUnavailableError';
  }
}

/** 誰の権限で接続するか。利用者本人の認可で動く（仕様書 第14.3節）。 */
export interface ConnectorPrincipal {
  tenantId: string;
  userId: string;
}

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  labels: string[];
}

export interface MailMessage extends MailSummary {
  body: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
  /** 終日の予定。`start`・`end` はその日の 0 時と翌日の 0 時（日本時間。仕様書 第14.3.4節）。 */
  allDay?: boolean;
}

/** 参加者ごとの予定が埋まっている時間帯。 */
export interface BusySlot {
  email: string;
  start: string;
  end: string;
}

export interface TaskItem {
  id: string;
  title: string;
  due: string | null;
  completed: boolean;
}

/** ドライブのファイル。M2Office が作ったか、利用者が選んだものだけが見える（`drive.file`。仕様書 第14.3.2節）。 */
export interface DriveFile {
  id: string;
  name: string;
  kind: 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'form' | 'folder' | 'other';
  modifiedAt: string;
  /** 開くリンク。見本の接続口では `null`。 */
  url: string | null;
}

export interface MailConnector {
  /** 受信箱のメールを新しい順に返す。 */
  list(p: ConnectorPrincipal, opts: { since?: string; limit?: number }): Promise<MailSummary[]>;
  /** 1 通を本文つきで返す。見つからなければ `null`。 */
  get(p: ConnectorPrincipal, id: string): Promise<MailMessage | null>;
  /** 検索の条件（Gmail の検索の書き方）で探す。本文は返さない。 */
  search(p: ConnectorPrincipal, q: { query: string; limit?: number }): Promise<MailSummary[]>;
  /** メールを送る。承認ステップの直後でしか呼ばれない（危険度 external-send。仕様書 第9.4節）。 */
  send(
    p: ConnectorPrincipal,
    mail: { to: string[]; cc: string[]; subject: string; body: string; replyTo: string | null },
  ): Promise<{ messageId: string }>;
  /** 返信の下書きを作る。**送信はしない**（仕様書 第9.5.1節）。 */
  createDraft(
    p: ConnectorPrincipal,
    draft: { replyTo: string | null; to: string; subject: string; body: string },
  ): Promise<{ draftId: string }>;
}

export interface CalendarConnector {
  /** 期間内の予定を開始時刻の順に返す。 */
  list(p: ConnectorPrincipal, range: { from: string; to: string }): Promise<CalendarEvent[]>;
  /**
   * 参加者の埋まっている時間帯を返す。
   *
   * @returns `busy` は埋まっている時間帯。`unknown` は予定を見られなかった人（社外・非公開など）。
   *   **見られなかった人を「空き」とみなさない**（仕様書 第14.3.4節）
   */
  freeBusy(
    p: ConnectorPrincipal,
    q: { emails: string[]; from: string; to: string },
  ): Promise<{ busy: BusySlot[]; unknown: string[] }>;
  /** 予定を作成し、参加者を招待する。 */
  create(
    p: ConnectorPrincipal,
    ev: { title: string; start: string; end: string; attendees: string[] },
  ): Promise<{ eventId: string }>;
  /** 予定を変える。参加者に変更の通知が届く。見つからなければ `null`。 */
  update(
    p: ConnectorPrincipal,
    ev: { eventId: string; title?: string; start?: string; end?: string; attendees?: string[] },
  ): Promise<{ eventId: string } | null>;
  /** 予定を取り消す。参加者に取り消しの通知が届く。見つからなければ `null`。 */
  cancel(p: ConnectorPrincipal, ev: { eventId: string }): Promise<{ eventId: string } | null>;
}

export interface TaskConnector {
  list(p: ConnectorPrincipal, opts: { includeCompleted?: boolean }): Promise<TaskItem[]>;
  create(p: ConnectorPrincipal, t: { title: string; due: string | null }): Promise<{ taskId: string }>;
  /** 完了にする。見つからなければ `null`。 */
  complete(p: ConnectorPrincipal, t: { taskId: string }): Promise<{ taskId: string } | null>;
}

/** ドライブ（`drive.file` の範囲。仕様書 第9.4.4節）。 */
export interface DriveConnector {
  /** 名前で探す。見えるのは M2Office が作ったか、利用者が選んだファイルだけ。 */
  search(p: ConnectorPrincipal, q: { query: string; limit?: number }): Promise<DriveFile[]>;
  /** 中身を文字で読む（ドキュメント・スプレッドシート・スライド・PDF）。見つからなければ `null`。 */
  read(p: ConnectorPrincipal, fileId: string): Promise<{ file: DriveFile; text: string } | null>;
  createFolder(p: ConnectorPrincipal, f: { name: string; parentId: string | null }): Promise<DriveFile>;
  /**
   * M2Office が作ったファイルを、指定した人と共有する。リンクによる一般公開はしない（仕様書 第9.4.4節）。
   * M2Office が作ったファイルでなければ `null`。
   */
  share(
    p: ConnectorPrincipal, s: { fileId: string; emails: string[]; role: 'reader' | 'commenter' | 'writer' },
  ): Promise<{ fileId: string; sharedWith: string[] } | null>;
  /** 1 つのファイルの情報。見えない・ごみ箱なら `null`（承認の画面に名前を出すのに使う）。 */
  get(p: ConnectorPrincipal, fileId: string): Promise<DriveFile | null>;
  /**
   * M2Office が作ったファイルを、会社のドメインの全員が**閲覧だけ**できるようにする（仕様書 第14.3.4節、ADR-0025）。
   * 検索には出さず、リンクを知っている社内の人だけが開ける。見えないファイルなら `null`。
   *
   * @param s.domain 会社のドメイン（例: `oesf.jp`）。個人向けのドメインを渡さないことは呼ぶ側が守る
   */
  shareWithDomain(p: ConnectorPrincipal, s: { fileId: string; domain: string }): Promise<{ fileId: string; domain: string } | null>;
}

/** 会社の中の人（Google Workspace のディレクトリ）。 */
export interface DirectoryPerson {
  name: string;
  email: string;
  department: string | null;
  title: string | null;
}

export interface DirectoryConnector {
  /** 名前・メール・部署で社内の人を探す。社外の連絡先は探さない。 */
  search(p: ConnectorPrincipal, q: { query: string; limit?: number }): Promise<DirectoryPerson[]>;
}

/** Meet の会議の文字起こし。 */
export interface MeetTranscript {
  conference: { id: string; title: string; startedAt: string; endedAt: string };
  entries: { speaker: string; text: string; at: string }[];
}

/** Google フォームの回答。答えは質問の文をキーにする。 */
export interface FormResponses {
  form: { id: string; title: string; questions: string[] };
  responses: { id: string; submittedAt: string; respondent: string | null; answers: Record<string, string> }[];
}

export interface FormsConnector {
  /**
   * 利用者が選んだ（または M2Office が作った）フォームの回答を、新しい順に返す。見つからなければ `null`。
   *
   * @param since この時刻以降に送られた回答だけ（任意）
   */
  responses(p: ConnectorPrincipal, q: { formId: string; since: string | null; limit: number }): Promise<FormResponses | null>;
}

export interface MeetConnector {
  /**
   * 題名に言葉を含む、いちばん新しい会議の文字起こし。本人が主催者か参加者だった会議だけ。
   * 見つからなければ `null`（Google は会議の終了から 30 日で文字起こしを消す）。
   */
  transcript(p: ConnectorPrincipal, q: { query: string }): Promise<MeetTranscript | null>;
}

/** Google ドキュメント。 */
export interface DocsConnector {
  create(p: ConnectorPrincipal, d: { title: string; body: string; folderId: string | null }): Promise<DriveFile>;
  /** 末尾に追記する。M2Office が作った文書だけ（見つからなければ `null`）。 */
  append(p: ConnectorPrincipal, d: { documentId: string; text: string }): Promise<{ documentId: string } | null>;
}

/** Google スプレッドシート。 */
export interface SheetsConnector {
  create(
    p: ConnectorPrincipal, s: { title: string; columns: string[]; rows: string[][]; folderId: string | null },
  ): Promise<DriveFile>;
  /** 値を読む。1 行目は見出し。見つからなければ `null`。 */
  read(p: ConnectorPrincipal, s: { spreadsheetId: string; maxRows: number }): Promise<{ file: DriveFile; values: string[][] } | null>;
  /** 末尾に行を足す。見つからなければ `null`。 */
  append(p: ConnectorPrincipal, s: { spreadsheetId: string; rows: string[][] }): Promise<{ appended: number } | null>;
}

export interface ChatConnector {
  /** スペースへ投稿する。 */
  post(p: ConnectorPrincipal, msg: { space: string; text: string }): Promise<{ messageId: string }>;
  /**
   * 投稿先を探す。**読むだけで、投稿はしない**（承認の前の確かめに使う。仕様書 第9.3.3節、ADR-0024）。
   *
   * @param input スペースの名前か、リンク・ID
   * @returns 見つかったスペース（`spaces/…` と、表示名。無ければ `null`）と、社外の人が入れるか
   *   （`external`。分からなければ `null`。仕様書 第9.4.0節）か、投稿できない理由（利用者に見せる文）
   * @throws {ConnectorUnavailableError} 接続・許可・会社の準備の問題、Google に届かないとき
   */
  findSpace(p: ConnectorPrincipal, input: string): Promise<{ space: string; displayName: string | null; external: boolean | null } | { reason: string }>;
}

/** Google スライドへの接続口（仕様書 第9.4.2節）。 */
export interface SlidesConnector {
  /**
   * スライドの構成から、本人のドライブにプレゼンテーションを作る。**共有はしない。**
   *
   * @returns 作ったものの ID と、開くリンク・PowerPoint 形式の取り出しリンク。見本の接続口では `null`
   */
  createPresentation(
    p: ConnectorPrincipal,
    input: {
      title: string; plan: SlidePlan;
      /** 会社が登録したテンプレート（第9.4.2節）。`null` なら標準のテンプレート。 */
      template: { presentationId: string; name: string } | null;
    },
  ): Promise<{ presentationId: string; url: string | null; pptxUrl: string | null }>;
}

/**
 * 業務システムへの接続口の全体。
 *
 * @remarks
 * テナント境界: すべての操作は {@link ConnectorPrincipal} を受け取り、
 * そのテナントと利用者の範囲でのみ動く（不変則 I-2）。
 */
export interface WorkspaceConnector {
  /**
   * その会社の値の出どころ（ADR-0022）。開発では会社ごとに見本と本物を分けられるため、
   * 接続口全体ではなく会社ごとに引く。
   */
  sourceFor(tenantId: string): DataSource;
  mail: MailConnector;
  calendar: CalendarConnector;
  tasks: TaskConnector;
  chat: ChatConnector;
  slides: SlidesConnector;
  drive: DriveConnector;
  docs: DocsConnector;
  sheets: SheetsConnector;
  directory: DirectoryConnector;
  meet: MeetConnector;
  forms: FormsConnector;
}
