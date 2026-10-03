/**
 * @file 問い合わせの記録（内蔵の拡張）の型（仕様書 第33章・第33.17節）。
 *
 * 電話・来店などの問い合わせを、秘書に話すか画面の 1 行の欄に書くだけで残す。AI が誰から・用件・分類・どこで知ったか・
 * 次にやること・温度感に分ける。問い合わせは利用範囲の中で会社で共有する。
 * 段 2（第33.18節）で、会社の窓口のアカウント（info@ など）のメールを読み、返事を承認の後に送り、月の振り返りを出す。
 */

/** 問い合わせの記録の拡張の ID（内蔵の拡張。第12.13節）。 */
export const INQUIRIES_EXTENSION_ID = 'inquiries';

/** 届いた入口（第33.3節）。 */
export type InquiryChannel = 'phone' | 'mail' | 'form' | 'line' | 'visit' | 'other';

/** 入口の呼び方。 */
export const INQUIRY_CHANNEL_LABELS: Record<InquiryChannel, string> = {
  phone: '電話', mail: 'メール', form: 'Web のフォーム', line: 'LINE', visit: '来店', other: 'そのほか',
};

/** 問い合わせの状態。 */
export type InquiryStatus = 'open' | 'done' | 'dropped';

/** 状態の呼び方。 */
export const INQUIRY_STATUS_LABELS: Record<InquiryStatus, string> = { open: '対応中', done: '済み', dropped: '見送り' };

/** 見込みの強さ（AI が付け、人が直せる）。 */
export type InquiryTemperature = 'high' | 'normal' | 'low';

/** 温度感の呼び方。 */
export const INQUIRY_TEMPERATURE_LABELS: Record<InquiryTemperature, string> = { high: '高い', normal: 'ふつう', low: '低い' };

/** 「どこで知ったか」が分からないときの値。推し量って埋めない（第33.3節）。 */
export const INQUIRY_SOURCE_UNKNOWN = '不明';

/** 誰から（分かるものだけ。分からない項目は空）。 */
export interface InquiryParty {
  name: string;
  company: string;
  phone: string;
  email: string;
}

/** 次にやること（第33.7節）。 */
export interface InquiryTask {
  id: string;
  /** 担当の利用者の ID（既定は受けた人）。 */
  assignee: string;
  assigneeName: string;
  /** 中身（例: 「見積もりを送る」）。 */
  what: string;
  /** 期限（`YYYY-MM-DD`）。無ければ `null`。 */
  due: string | null;
  doneAt: string | null;
  createdAt: string;
}

/** 会話の履歴の 1 つ（届いたもの・こちらからのもの）。 */
export interface InquiryEvent {
  id: string;
  at: string;
  /** `in` は届いた、`out` はこちらから。 */
  direction: 'in' | 'out';
  channel: InquiryChannel;
  /** 1〜2 文の要約。 */
  summary: string;
  /** 秘書に話した文・書いた文の原文（90 日で消す。要配慮個人情報を含んでいたら残さない）。 */
  body: string | null;
  createdBy: string;
  createdByName: string;
  /** 窓口のアカウントのメールなら、元のメールの参照と、どの宛先（別名）に届いたか。本文は持たない（開いたときに読む）。 */
  mail: { messageId: string; threadId: string; to: string } | null;
}

/** 問い合わせ 1 件。 */
export interface Inquiry {
  id: string;
  from: InquiryParty;
  /** 名刺管理の連絡先（会社で共有のもの）。つながっていなければ `null`。 */
  contactId: string | null;
  channel: InquiryChannel;
  /** 分類（見積もり・予約・質問・苦情・採用・営業の売り込みなど。AI が付ける）。 */
  category: string;
  /** 用件の要約。 */
  summary: string;
  /** どこで知ったか。分からなければ {@link INQUIRY_SOURCE_UNKNOWN}。 */
  source: string;
  temperature: InquiryTemperature;
  status: InquiryStatus;
  /** 受けた人の利用者の ID。 */
  receivedBy: string;
  receivedByName: string;
  firstAt: string;
  lastAt: string;
  /** まだ済んでいない次にやることのうち、期限のいちばん早いもの。 */
  nextTask: InquiryTask | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 返事の状態。 */
export type InquiryReplyStatus = 'draft' | 'awaiting' | 'sent';

/** 返事の状態の呼び方。 */
export const INQUIRY_REPLY_STATUS_LABELS: Record<InquiryReplyStatus, string> = { draft: '下書き', awaiting: '承認待ち', sent: '送った' };

/** 窓口のアカウントから送る返事（第33.6節）。承認の後に送る。 */
export interface InquiryReply {
  id: string;
  inquiryId: string;
  to: string;
  /** 差出人（お客様が送った宛先。別名から送れなければ窓口のアカウントの本来のアドレス）。 */
  from: string;
  subject: string;
  body: string;
  status: InquiryReplyStatus;
  runId: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  sentAt: string | null;
}

/** 1 件の画面に出すもの。 */
export interface InquiryDetail {
  inquiry: Inquiry;
  events: InquiryEvent[];
  tasks: InquiryTask[];
  /** 返事（新しい順）。 */
  replies: InquiryReply[];
}

/** 窓口のアカウントのメールのうち、問い合わせでないと見分けたもの（第33.6節「問い合わせにしないもの」）。 */
export interface InquiryMailSkipped {
  messageId: string;
  from: string;
  subject: string;
  /** 見分けた理由（営業の売り込み・メールマガジン・自動の知らせなど）。 */
  reason: string;
  receivedAt: string;
}

/** 窓口のアカウント（会社の接続。秘密の値は別に預け、ここにはアドレスだけを持つ）。 */
export interface InquiryMailbox {
  email: string;
  /** つないだ管理者。メールから生まれた次にやることの担当と、手つかずの知らせの相手（窓口の担当）。 */
  connectedBy: string;
  connectedAt: string;
}

/** 月の振り返りの数（第33.9節。数はプログラムが数える）。 */
export interface InquiryMonthStats {
  /** `YYYY-MM`。 */
  month: string;
  total: number;
  /** 前の月の件数。 */
  previousTotal: number;
  byChannel: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
  byTemperature: Record<string, number>;
  /** 窓口のアカウントの宛先（別名）ごと。 */
  byMailTo: Record<string, number>;
}

/** 会社の問い合わせの記録の設定（第33.4節）。 */
export interface InquirySettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** 窓口のアカウント（第33.6節）。つないでいなければ `null`。 */
  mailbox: InquiryMailbox | null;
}

/** 既定の設定。既定は切り（第33.2節）。 */
export const DEFAULT_INQUIRY_SETTINGS: InquirySettings = { enabled: false, mailbox: null };
