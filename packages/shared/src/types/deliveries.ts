/**
 * @file 外部のアプリからの配信の依頼（仕様書 第13.4.4節、Q-254）の型と数の上限。
 *
 * 外部のアプリ（最初は M2Medical の「声掛け」）が、件名・HTML・文字だけの本文・宛先を渡し、M2Office は承認のあと会社の
 * 窓口のアカウントから 1 人に 1 通ずつ送る。結果と配信の停止は、アプリが取りに来る（M2Office からアプリへは送らない）。
 * 案内文の作成・送る相手・配信の記録はアプリが持つ。宛先の名前とアドレスは、その人に送り終えたら消す。秘書・推論・会社の接続には渡さない。
 */

/** 1 回の依頼の宛先の上限。 */
export const DELIVERY_MAX_RECIPIENTS = 500;
/** 窓口のアカウントから 1 日（過ぎた 24 時間）に送る上限（Gmail の 1 日の上限の半分。ほかの送信と合わせて数える）。 */
export const DELIVERY_DAILY_LIMIT = 1000;
/** 同じ依頼の中で 1 通ごとに空ける秒数。 */
export const DELIVERY_GAP_SECONDS = 3;
/** 結果と停止を持つ日数（送り終えてから。アプリが取りに来た後も、この日数で消す）。 */
export const DELIVERY_KEEP_DAYS = 30;
/** 送れなかった知らせと停止の照合のため、アドレスの SHA-256 を持つ日数（その人に送ってから）。 */
export const DELIVERY_HASH_KEEP_DAYS = 3;
/** 送り終えてから、結果の `done` を `true` にするまでの時間（あとから届く送れなかった知らせを結果に入れるため）。 */
export const DELIVERY_DONE_AFTER_HOURS = 24;
/** 結果と停止を 1 回に渡す数。 */
export const DELIVERY_PAGE_SIZE = 500;
/** ロゴの大きさの上限（バイト）。 */
export const DELIVERY_LOGO_MAX_BYTES = 300_000;

/** 配信の道。初めはメールだけ（LINE は受け付けない）。 */
export type DeliveryChannel = 'mail' | 'line';

/** 配信の状態。承認待ち・送る時を待つ・送っている・送り終えた・却下された。 */
export type DeliveryStatus = 'awaiting_approval' | 'scheduled' | 'sending' | 'done' | 'rejected';

/** 宛先ごとの結果。 */
export type DeliveryResultStatus = 'sent' | 'failed' | 'stopped';

/** 送れなかった理由。 */
export type DeliveryFailReason = 'invalid-address' | 'bounced' | 'quota' | 'rejected';

/** 受け付けなかった理由の符号（アプリの画面に出す文 `reason` と一緒に返す）。 */
export type DeliveryRejectCode =
  | 'invalid' | 'channel-unsupported' | 'too-many' | 'no-mailbox' | 'unknown-placeholder' | 'ai-unavailable';

/** 依頼の本文（`POST /v1/deliveries`）。 */
export interface DeliveryRequest {
  requestId: string;
  title: string;
  channel: DeliveryChannel;
  /** 送る日時（ISO 8601）。無ければ承認の後すぐ。 */
  sendAt: string | null;
  template: { subject: string; html: string; text: string; line: string | null };
  /** 差し込む値（`{{clinic_name}}` など）。 */
  values: Record<string, string>;
  /** 本文に埋め込むロゴ（HTML から `cid:` で指す）。 */
  logo: { contentType: string; base64: string; cid: string } | null;
  /** 宛先。`recipientId` は依頼ごとに作り直した、元に戻せない番号（英数字と `-`・`_` の 64 文字まで）。 */
  recipients: { recipientId: string; name: string; email?: string; line?: string }[];
  /** テスト送信（宛先 1 人。結果を持たない）。 */
  test?: boolean;
}

/** 結果の 1 件（`GET /v1/deliveries/{requestId}/results`）。 */
export interface DeliveryResult {
  recipientId: string;
  status: DeliveryResultStatus;
  at: string;
  reason?: DeliveryFailReason;
  channel?: 'mail' | 'line' | 'all';
}

/** 結果を渡す答え。`next` を次の `after` に渡す。`done` が `true` になったら取りに来なくてよい。 */
export interface DeliveryResultsPage {
  results: DeliveryResult[];
  next: string | null;
  done: boolean;
}

/** 配信の停止の 1 件（`GET /v1/deliveries/stops`）。宛先の ID が読めなかったときだけ `email`。 */
export type DeliveryStop =
  | { recipientId: string; channel: 'mail'; at: string }
  | { email: string; channel: 'mail'; at: string };

/** 配信の停止を渡す答え。 */
export interface DeliveryStopsPage {
  stops: DeliveryStop[];
  next: string | null;
}

/** 配信の 1 件（管理者に見せる。宛先は持たない）。 */
export interface DeliveryView {
  id: string;
  appId: string;
  requestId: string;
  title: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  total: number;
  sent: number;
  failed: number;
  stopped: number;
  sendAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** テスト送信か。 */
  test: boolean;
}
