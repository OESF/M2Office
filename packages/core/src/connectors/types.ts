/**
 * @file 業務システムへの接続口（コネクタ）の型。メール・予定・タスク・チャットの操作を定める。
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

export interface MailConnector {
  /** 受信箱のメールを新しい順に返す。 */
  list(p: ConnectorPrincipal, opts: { since?: string; limit?: number }): Promise<MailSummary[]>;
  /** 1 通を本文つきで返す。見つからなければ `null`。 */
  get(p: ConnectorPrincipal, id: string): Promise<MailMessage | null>;
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
}

export interface TaskConnector {
  list(p: ConnectorPrincipal, opts: { includeCompleted?: boolean }): Promise<TaskItem[]>;
  create(p: ConnectorPrincipal, t: { title: string; due: string | null }): Promise<{ taskId: string }>;
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
}
