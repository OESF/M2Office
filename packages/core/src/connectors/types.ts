/**
 * @file 業務システムへの接続口（コネクタ）の型。メール・予定・タスク・チャット・ドライブ・ドキュメント・スプレッドシート・スライドの操作を定める。
 *
 * ツール層はこのインターフェースだけを見て、Google の API を直接呼ばない。
 * 実装は `mock`（ダミー）と `google`（B-2 の完了後）の 2 つ。
 * どちらも返す値に出どころ（`DataSource`）を含め、ダミーを本物と取り違えないようにする。
 *
 * @see 仕様書 第14.5節 Google 以外のグループウェアへの対応
 * @see 仕様書 第24.2節 第 6 項
 */

import type { SlidePlan } from '../slides/plan.js';

/** 値の出どころ。画面と監査ログで区別して表示する。 */
export type DataSource = 'mock' | 'google';

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
  kind: 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'folder' | 'other';
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
  /** 参加者の埋まっている時間帯を返す。 */
  freeBusy(
    p: ConnectorPrincipal,
    q: { emails: string[]; from: string; to: string },
  ): Promise<BusySlot[]>;
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
  readonly source: DataSource;
  mail: MailConnector;
  calendar: CalendarConnector;
  tasks: TaskConnector;
  chat: ChatConnector;
  slides: SlidesConnector;
  drive: DriveConnector;
  docs: DocsConnector;
  sheets: SheetsConnector;
}
