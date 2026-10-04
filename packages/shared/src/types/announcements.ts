/**
 * @file お知らせの作成（内蔵の拡張）の型（仕様書 第35章・第35.17節）。
 *
 * 休業・営業時間の変更・新しいサービスなどのお知らせを 1 つ作り、AI が出し先ごとの文（Web サイトの記事・LINE の短い文・
 * 店頭の画面の 1 枚）を作る。**1 回の承認**でまとめて出し、期間が終わったら店頭の画面から外し、Web の記事の題名に「（終了しました）」を付ける。
 * 段 1 の出し先は Web サイト・LINE・店頭の画面。メールは段 2。
 */

/** お知らせの作成の拡張の ID（内蔵の拡張。第12.13節）。 */
export const ANNOUNCEMENTS_EXTENSION_ID = 'announcements';

/** 出し先（段 1 は Web・LINE・店頭の画面。段 2 でメール）。 */
export type AnnouncementChannel = 'web' | 'line' | 'signage' | 'mail';

/** 出し先の並びと呼び方。 */
export const ANNOUNCEMENT_CHANNELS: AnnouncementChannel[] = ['web', 'line', 'mail', 'signage'];
export const ANNOUNCEMENT_CHANNEL_LABELS: Record<AnnouncementChannel, string> = { web: 'Web サイト', line: 'LINE', mail: 'メール', signage: '店頭の画面' };

/** お知らせの状態。 */
export type AnnouncementStatus = 'draft' | 'awaiting' | 'scheduled' | 'published' | 'ended' | 'cancelled';

/** 状態の呼び方。 */
export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  draft: '下書き', awaiting: '承認待ち', scheduled: '予約', published: '出した', ended: '終わった', cancelled: '取り消し',
};

/** 出し先ごとの文（AI が作り、人が直せる）。 */
export interface AnnouncementTexts {
  /** Web サイトの記事（題名と本文。本文は Markdown） */
  web: { title: string; body: string };
  /** LINE の短い文（200 字まで） */
  line: string;
  /** 店頭の画面の 1 枚（見出し・期間の書き方・一言） */
  signage: { headline: string; period: string; note: string };
  /** メール（件名と本文。宛名は名刺管理のまとめてのメールで差し込む。第35.6.3節） */
  mail: { subject: string; body: string };
}

/** お知らせ 1 つ。 */
export interface Announcement {
  id: string;
  title: string;
  body: string;
  /** 期間（YYYY-MM-DD。無ければ `null`） */
  startDate: string | null;
  endDate: string | null;
  /** 予約の日時（ISO。無ければ承認したときに出す） */
  publishAt: string | null;
  status: AnnouncementStatus;
  channels: AnnouncementChannel[];
  texts: AnnouncementTexts;
  /** メールの宛先（名刺管理の連絡先の ID。AI が案を出し、画面で外せる） */
  mailContactIds: string[];
  /** 承認へ進めたときの実行 */
  runId: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** 出し先ごとの結果。 */
export interface AnnouncementOutput {
  channel: AnnouncementChannel;
  status: 'waiting' | 'done' | 'failed' | 'ended';
  /** 結果（Web は記事の URL・LINE は送った数・店頭の画面は流した画面） */
  result: { link?: string; editUrl?: string; postId?: string; sent?: number; assetId?: string; screens?: string[]; draft?: boolean; bulkMailId?: string; queued?: number };
  reason: string;
  doneAt: string | null;
}

/** 1 つのお知らせと、出し先ごとの結果・使える出し先。 */
export interface AnnouncementDetail {
  announcement: Announcement;
  outputs: AnnouncementOutput[];
  /** いまつながっていて使える出し先（Web は WordPress が無くても、文を写して使える） */
  available: Record<AnnouncementChannel, boolean>;
  /** WordPress につないでいるか（無ければ Web の文を写して使う） */
  wordpress: boolean;
}

/** 承認の前に見せるもの。 */
export interface AnnouncementPreview {
  id: string;
  /** 承認した中身の指紋（題名・本文・期間・予約・出し先・出し先ごとの文） */
  digest: string;
  problems: string[];
  /** LINE の送る数と今月の残り（LINE を出し先にしているときだけ） */
  line: { followers: number | null; limit: number | null; used: number } | null;
  /** 流す画面の名前（店頭の画面を出し先にしているときだけ） */
  screens: string[];
  /** Web の出し方（「WordPress（https://…）に公開」「予約公開」「下書き」「文を写して使う」） */
  web: string;
  /** メールの宛先の数と差出人（メールを出し先にしているときだけ） */
  mail: { count: number; from: string } | null;
}

/** メールの宛先の候補 1 人（名刺管理の連絡先）。 */
export interface AnnouncementRecipient {
  contactId: string;
  name: string;
  company: string;
  email: string;
}

/** 会社の設定 `announcements`（第35.4節）。 */
export interface AnnouncementSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** Web サイト（WordPress）に、承認の後に公開まで行うか、下書きまでにするか（既定は公開まで） */
  webPublish: 'publish' | 'draft';
  /** お知らせを入れる WordPress のカテゴリー（無ければ初めて出すときに作る） */
  webCategory: string;
  /** お知らせを流す画面の ID（`null` ならすべての画面） */
  screens: string[] | null;
}

/** 既定（切り）。 */
export const DEFAULT_ANNOUNCEMENT_SETTINGS: AnnouncementSettings = { enabled: false, webPublish: 'publish', webCategory: 'お知らせ', screens: null };

/** 期間の無いお知らせを店頭の画面に流す日数（第35.6.4節）。 */
export const ANNOUNCEMENT_SIGNAGE_DAYS = 14;

/** LINE の文の長さの目安（第35.6.2節）。 */
export const ANNOUNCEMENT_LINE_MAX = 200;
