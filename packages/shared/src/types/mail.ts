/**
 * @file メールを M2Office の中で片付ける画面の型と決まった値（仕様書 第9.5.1.1節、ADR-0131）。
 *
 * ワーカーが 15 分ごとに本人の Gmail を見て、スレッドごとに振り分け、片付くまで並べる。
 * 画面・API・ワーカーが同じ値を使う。
 */

/** 左のメニューの業務の並びでの「メール」の ID（ピン止め・並びに使う。第9.5.1.1節「画面」）。 */
export const MAIL_MENU_ID = 'mail';

/** 決まった値（第9.5.1.1節。Q-319・Q-320 で決定）。 */
export const MAIL_LIMITS = {
  /** 見回りの間隔（分）。 */
  pollMinutes: 15,
  /** 最初の 1 回にさかのぼる日数と、読むスレッドの数。 */
  firstDays: 14,
  firstMax: 200,
  /** 履歴の番号を読めないときに見直す日数。 */
  recheckDays: 2,
  /** 返事待ちに並べるまでの営業日。 */
  waitBusinessDays: 3,
  /** 朝のブリーフで「返事待ちが長い」と伝える営業日。 */
  longWaitBusinessDays: 5,
  /** 片付いたものを残す日数。 */
  doneKeepDays: 7,
  /** 一言の長さ。 */
  summaryChars: 30,
  /** 1 回の見回りで 1 人に作る下書きの数（費用を抑える）。 */
  draftsPerTick: 5,
  /** 1 回の見回りで 1 人に振り分けるスレッドの数。 */
  classifyPerTick: 60,
} as const;

/**
 * 振り分け。秘書のメールの確認（第10.9.6節）と同じ 4 つに、本人が送って返事を待っているもの（`waiting`）を足す。
 */
export type MailGroupId = 'reply' | 'action' | 'read' | 'promo' | 'waiting';

/** 画面の見出し。 */
export const MAIL_GROUP_LABELS: Record<MailGroupId, string> = {
  reply: '返事が要る', action: '対応が要る', waiting: '返事待ち', read: '目を通すだけ', promo: '宣伝・お知らせ',
};

/** 一覧の 1 件（スレッド）。本文は持たない。 */
export interface MailItem {
  threadId: string;
  group: MailGroupId;
  /** 差出人（返事待ちは送った相手）。 */
  from: string;
  subject: string;
  /** 何を求められているかの一言（返事が要る・対応が要るだけ）。 */
  summary: string;
  /** 本文に書かれた期限の言い方と、読み取れた日付（`YYYY-MM-DD`）。 */
  due: string;
  dueDate: string | null;
  /** 最後のメールの時刻。 */
  lastAt: string;
  /** 本人が送った時刻（返事待ち）。 */
  sentAt: string | null;
  /** 下書きを用意してあるか。 */
  draftReady: boolean;
  /** 送っている最中か（本人が確かめて送った後、送り終えるまで）。 */
  sending: boolean;
}

/** 見回りの様子。 */
export interface MailWatchState {
  /** off（Google が未接続か、読む許可が無い）・paused（本人が止めた）・starting（最初の 1 回の前）・ready・error。 */
  state: 'off' | 'paused' | 'starting' | 'ready' | 'error';
  checkedAt: string | null;
  error: string | null;
}

/** メールの画面の中身。 */
export interface MailOverview {
  reply: MailItem[];
  action: MailItem[];
  waiting: MailItem[];
  read: MailItem[];
  /** 宣伝・お知らせの件数（並べない）。 */
  promoCount: number;
  watch: MailWatchState;
  /** 会社の AI の上限に当たり、振り分けを止めているか。 */
  aiLimited: boolean;
}

/** スレッドの 1 通（開いたときに Gmail から読む）。 */
export interface MailThreadMessage {
  id: string;
  from: string;
  at: string;
  body: string;
  mine: boolean;
}

/** 1 件を開いたときの中身。 */
export interface MailThreadDetail {
  item: MailItem;
  /** 片付いたか（送った・済みにした・目を通すだけを開いた）。 */
  done: boolean;
  messages: MailThreadMessage[];
  /** Gmail から読めなかったとき、その理由（本文は出さない）。 */
  readError: string | null;
  draft: string;
  recipients: { to: string[]; cc: string[] };
  /** 返信の件名（`Re: …`）。 */
  replySubject: string;
  /** Gmail でこのスレッドを開く URL。 */
  gmailUrl: string;
  /** 送っている最中の実行（本人が確かめて送った後）。 */
  sending: { runId: string; approvalId: string | null; status: string } | null;
}

/** 本人が秘書に頼んだこと（第9.5.1.1節）。 */
export interface MailPrefs {
  /** 「メールは見なくていい」。 */
  paused?: boolean;
  /** 「〇〇さんからのメールはすぐ知らせて」の相手（名前かメールアドレスの一部）。 */
  urgentFrom?: string[];
  /** 「〇〇さんは 1 週間待って」の相手ごとの営業日。 */
  waitDays?: Record<string, number>;
}
