/**
 * @file 定時実行・通知・ログイン状態の型。
 *
 * @see 仕様書 第9.5.5節 AG-05 週次ブリーフ
 * @see 仕様書 第6.5.5節 通知
 * @see 仕様書 第20.7節 認証の実装方針
 */

/**
 * 定時実行の規則。
 *
 * @remarks
 * 利用者が画面で選べる粒度にとどめる（毎日／毎平日／毎週）。
 * cron 式は利用者に見せない（原則 u1）。月次は Phase 2 で追加する。
 * 毎平日（月〜金）は朝のブリーフのために足した（仕様書 第9.5.5.1節）。祝日は考えない。
 * 会社の営業日（`business`）は、会社情報の営業日（曜日と祝日）と、お知らせで出した休業の期間に合わせる（第 0.243.0 版。朝のブリーフの既定）。
 */
export type ScheduleRule =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'business'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

export interface Schedule {
  id: string;
  tenantId: string;
  /** 対象者。実行はこの利用者の権限で行う。 */
  userId: string;
  agentId: string;
  agentVersion: number;
  input: Record<string, unknown>;
  rule: ScheduleRule;
  /** 規則を解釈する基準。既定は Asia/Tokyo（仕様書 第6.5.1節）。 */
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** 通知の種類（仕様書 第6.5.5節「受け取る種類」）。 */
/**
 * 通知の種類。`security`（権限区画への出入りなど）は、本人の設定にかかわらず届ける（仕様書 第16.7.5節）。
 * `inventory` は在庫の見張り（残りわずか・無くなる見込み・使用期限と発注の案。仕様書 第29.14節）。
 */
export type NotificationKind = 'brief' | 'run' | 'approval' | 'failure' | 'security' | 'inventory' | 'attendance' | 'signage' | 'inquiry' | 'competitor' | 'announcement' | 'webReview';

/**
 * 本人宛の通知。
 *
 * @remarks
 * 宛先は常に 1 人であり、ツール `notification.send` からは
 * 実行を依頼した本人にしか届かない（仕様書 第9.5.5節）。
 */
export interface Notification {
  id: string;
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  runId: string | null;
  readAt: string | null;
  createdAt: string;
  /** Chat へ届け終えた時刻。まだ届けていなければ `null`（仕様書 第6.5.5.2節）。 */
  deliveredAt?: string | null;
  /** 届け先と、送れなかったときの理由。画面には出さない。 */
  deliveryNote?: string | null;
}

/** ログインの状態。Cookie の値は保存せず、ハッシュを `id` とする。 */
export interface Session {
  id: string;
  tenantId: string;
  userId: string;
  csrfToken: string;
  provider: 'google' | 'dev';
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
