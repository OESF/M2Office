/**
 * @file Web の振り返り（内蔵の拡張）の型（仕様書 第34章・第34.18節）。
 *
 * 担当の Google アカウントの許可（アナリティクスと Search Console の読み取りだけ）で、会社の Web サイトの集計の数字を読み、
 * 月に 1 回の便りと、秘書への問いの答えにする。数字はプログラムが API の値から計算し、推論は言葉にするだけ。
 * 段 1 は、担当の許可・サイトの選び方・始める前の手伝い・秘書に聞く・月の便り。直すべき所は段 2。
 */

/** Web の振り返りの拡張の ID（内蔵の拡張。第12.13節）。 */
export const WEB_REVIEW_EXTENSION_ID = 'web-review';

/** 担当が許す Google の権限（読み取りだけ。第34.3節）。 */
export const WEB_REVIEW_SCOPES = ['analytics.readonly', 'webmasters.readonly'];

/** 月の便りを作る日（毎月の日。Search Console の数字が固まるのを待つ。第34.18節）。 */
export const WEB_REVIEW_REPORT_DAY = 3;

/** 月の便りを作る時（日本時間）。 */
export const WEB_REVIEW_REPORT_HOUR = 8;

/** 率の上下を言わない、来た人の数の下限（第34.4節「少ないとき」）。 */
export const WEB_REVIEW_FEW_USERS = 100;

/** 会社の設定 `webReview`。 */
export interface WebReviewSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** 担当の許可。つないでいなければ `null`。 */
  connection: { email: string; connectedBy: string; connectedAt: string } | null;
  /** 選んだアナリティクスのプロパティ（`properties/123`）と名前。 */
  property: { id: string; name: string } | null;
  /** 選んだ Search Console のサイト（`sc-domain:example.jp` か `https://www.example.jp/`）。 */
  siteUrl: string | null;
  /** 直すべき所を最後に探した日時（段 2。週に 1 回）。 */
  checkedAt?: string | null;
  /** 管理者が「今すぐチェック」を頼んだ日時（ワーカーが次の見回りで行う）。 */
  checkRequestedAt?: string | null;
}

export const DEFAULT_WEB_REVIEW_SETTINGS: WebReviewSettings = { enabled: false, connection: null, property: null, siteUrl: null, checkedAt: null, checkRequestedAt: null };

/** 秘書に聞ける指標（第34.18節。M2Office が持つ決まった一覧）。 */
export const WEB_REVIEW_METRICS = {
  users: 'サイトに来た人',
  newUsers: '新しく来た人',
  sessions: 'サイトに来た回数',
  pageViews: 'ページが見られた回数',
  engagementRate: 'じっくり読まれた割合',
  keyEvents: '問い合わせなどのキーイベントの数',
  searchImpressions: '検索で表示された回数',
  searchClicks: '検索で押された回数',
  searchCtr: '検索で表示されて押された割合',
  searchPosition: '検索の平均の順位',
} as const;
export type WebReviewMetric = keyof typeof WEB_REVIEW_METRICS;

/** 秘書に聞ける切り口。 */
export const WEB_REVIEW_BREAKDOWNS = {
  none: 'なし',
  page: 'ページ',
  source: 'どこから来たか',
  device: 'スマホとパソコン',
  region: '都道府県',
  searchQuery: '検索の言葉',
  searchPage: '検索から来たページ',
} as const;
export type WebReviewBreakdown = keyof typeof WEB_REVIEW_BREAKDOWNS;

/** 秘書に聞ける期間。`custom` は日付の指定。 */
export const WEB_REVIEW_PERIODS = {
  lastMonth: '先月',
  thisMonth: '今月',
  lastWeek: '先週',
  last7Days: 'この 7 日',
  last28Days: 'この 28 日',
  custom: '日付の指定',
} as const;
export type WebReviewPeriod = keyof typeof WEB_REVIEW_PERIODS;

/** 便りの数字の 1 つ。今月・前の月・前の年の同じ月。取れなければ `null`。 */
export interface WebReviewNumber {
  value: number | null;
  previous: number | null;
  lastYear: number | null;
}

/** 便りの数字（プログラムが API の値から計算したもの）。 */
export interface WebReviewFigures {
  /** 対象の月（`2026-09`）と期間。 */
  month: string;
  start: string;
  end: string;
  /** 来た人が少ない月（率の上下を言わない）。 */
  few: boolean;
  analytics: {
    users: WebReviewNumber;
    newUsers: WebReviewNumber;
    sessions: WebReviewNumber;
    pageViews: WebReviewNumber;
    engagementRate: WebReviewNumber;
    /** 問い合わせのページへ進んだ数（キーイベントがあればその数）。`basis` は数え方 */
    inquiries: WebReviewNumber & { basis: 'keyEvents' | 'pages' };
    /** どこから来たか（来た回数。多い順） */
    sources: { label: string; sessions: number }[];
    /** よく見られたページ（上位 5） */
    topPages: { path: string; title: string; views: number }[];
    /** スマホの割合（0〜1） */
    mobileShare: number | null;
    /** 都道府県（上位 3。来た人） */
    regions: { label: string; users: number }[];
  } | null;
  search: {
    impressions: WebReviewNumber;
    clicks: WebReviewNumber;
    /** 押された割合（0〜1） */
    ctr: WebReviewNumber;
    position: WebReviewNumber;
    /** 押された言葉（上位 5） */
    topQueries: { query: string; clicks: number; impressions: number }[];
    /** 伸びた言葉（前の月より押された回数が増えた上位 3） */
    risingQueries: { query: string; clicks: number; previous: number }[];
  } | null;
  /** 取れなかったもの（理由つき） */
  missing: string[];
  /** 問い合わせの記録の件数（段 3。第34.9節。プログラムが数えた件数だけ。使っていなければ無い） */
  inquiryRecords?: { value: number; previous: number; bySource: { label: string; count: number }[] } | null;
  /** 競合の分析の、その月の動きの数（第36.21節。競合の名前は入れない。使っていなければ無い） */
  competitors?: { changes: number; kinds: { label: string; count: number }[] } | null;
  /** その月の休業の日数（お知らせで出した休業の期間。第35.7節。無ければ 0） */
  closureDays?: number;
}

/** 月の便り（第34.4節）。 */
export interface WebReviewReport {
  id: string;
  month: string;
  figures: WebReviewFigures;
  /** ①要約（3 行まで） */
  summary: string;
  /** ②よかったこと */
  good: string;
  /** ③気になること */
  concern: string;
  /** ④次にやること（1〜3 つ） */
  next: string[];
  createdAt: string;
}

/** 便りの一覧の 1 行。 */
export interface WebReviewReportBrief {
  id: string;
  month: string;
  summary: string;
  createdAt: string;
}

/** 始める前の手伝い（第34.7節）の状態。 */
export type WebReviewSetupState =
  | 'off' // 拡張を切っている
  | 'notConnected' // 担当がつないでいない
  | 'noWebsite' // 会社情報に Web サイトが無い
  | 'apiDisabled' // Google Cloud の側で API が有効でない
  | 'nothingVisible' // プロパティもサイトも見えない（制作会社が持っている）
  | 'choose' // 候補が複数あり、選ぶのを待つ
  | 'ready';

/** Web の振り返りの状態（画面と秘書に返す）。 */
export interface WebReviewStatus {
  state: WebReviewSetupState;
  /** 担当のアカウントと、つないだ人の名前 */
  connection: { email: string; connectedByName: string; connectedAt: string } | null;
  property: { id: string; name: string } | null;
  siteUrl: string | null;
  /** 次にすることを 1 文で（状態が ready でないとき） */
  advice: string;
  /** 制作会社に閲覧の権限をもらう依頼文の下書き（nothingVisible のとき） */
  requestDraft: { subject: string; body: string } | null;
}

/** サイトの候補（設定の画面で選ぶ）。 */
export interface WebReviewCandidates {
  properties: { id: string; name: string; account: string; uris: string[] }[];
  sites: { siteUrl: string; permission: string }[];
}

// ---- 段 2: 直すべき所（第34.6節・第34.19節） ----------------------------------------------------

/** 直すべき所の種類。 */
export type WebReviewFindingKind = 'lowCtr' | 'nearFirstPage' | 'missingContent' | 'notIndexed' | 'slowMobile' | 'fading';

/** 種類の呼び方（画面と秘書）。 */
export const WEB_REVIEW_FINDING_LABELS: Record<WebReviewFindingKind, string> = {
  lowCtr: '検索に出るのに押されないページ',
  nearFirstPage: 'あと少しで検索の 1 ページ目に入るページ',
  missingContent: '検索されているのに合う記事が無い言葉',
  notIndexed: 'Google に登録されていないページ',
  slowMobile: 'スマホで遅いページ',
  fading: '読まれなくなった記事',
};

/** 直すべき所の状態。 */
export type WebReviewFindingStatus = 'new' | 'seen' | 'done' | 'dismissed';

export const WEB_REVIEW_FINDING_STATUS_LABELS: Record<WebReviewFindingStatus, string> = { new: '新しい', seen: '見た', done: '済んだ', dismissed: '見送り' };

/** 1 回の見回りで、種類ごとに出す数の上限。 */
export const WEB_REVIEW_FINDINGS_PER_KIND = 5;

/** 表示の速さと登録の状態を確かめるページの数の上限。 */
export const WEB_REVIEW_PAGES_TO_CHECK = 10;

/** 直すべき所 1 つ。 */
export interface WebReviewFinding {
  id: string;
  kind: WebReviewFindingKind;
  /** 対象（ページの URL かパス、または検索の言葉） */
  target: string;
  /** 画面に出す名前（ページの題名か検索の言葉） */
  title: string;
  /** 見つけた根拠の数字（プログラムが計算したもの。種類ごとに違う） */
  figures: Record<string, number | string | null>;
  /** 何が起きているか・どう直すとよいか（ふつうの言葉） */
  advice: string;
  /** 制作会社への依頼文の下書き（コラムと検索の言葉には無い） */
  requestDraft: { subject: string; body: string } | null;
  /** コラムのページならそのコラム */
  columnId: string | null;
  status: WebReviewFindingStatus;
  foundAt: string;
  updatedAt: string;
}

/** ページごとの数字（この 28 日。コラムの画面に出す）。 */
export interface WebPageMetrics {
  path: string;
  start: string;
  end: string;
  views: number | null;
  /** 読まれた時間の平均（秒） */
  readSeconds: number | null;
  searchClicks: number | null;
  searchImpressions: number | null;
  /** 主な検索の言葉（押された回数の多い順に 3 つまで） */
  queries: string[];
  updatedAt: string;
}
