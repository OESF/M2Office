/**
 * @file Web のコラム（内蔵の拡張）の型（仕様書 第32章・第32.18.1節）。
 *
 * 分野やテーマから AI が出典つきの下書きを書き、表現と事実を確かめ（赤入れ）、責任者が承認したものを WordPress に下書きとして入れる。
 */

/** Web のコラムの拡張の ID（内蔵の拡張。第12.13節）。 */
export const WEB_COLUMNS_EXTENSION_ID = 'web-columns';

/**
 * 業種（東証の 33 業種と「その他」。第32.18.3節、ADR-0066）。コードで持ち、画面には名称を出す。
 *
 * @remarks 赤入れで照らす表現の決まりは、業種だけでは決まらない（クリニックも法律事務所もサービス業）ため、AI が別に選ぶ（{@link ColumnRuleSet}）
 */
export const COLUMN_INDUSTRIES: readonly { code: string; name: string }[] = [
  { code: '0050', name: '水産・農林業' },
  { code: '1050', name: '鉱業' },
  { code: '2050', name: '建設業' },
  { code: '3050', name: '食料品' },
  { code: '3100', name: '繊維製品' },
  { code: '3150', name: 'パルプ・紙' },
  { code: '3200', name: '化学' },
  { code: '3250', name: '医薬品' },
  { code: '3300', name: '石油・石炭製品' },
  { code: '3350', name: 'ゴム製品' },
  { code: '3400', name: 'ガラス・土石製品' },
  { code: '3450', name: '鉄鋼' },
  { code: '3500', name: '非鉄金属' },
  { code: '3550', name: '金属製品' },
  { code: '3600', name: '機械' },
  { code: '3650', name: '電気機器' },
  { code: '3700', name: '輸送用機器' },
  { code: '3750', name: '精密機器' },
  { code: '3800', name: 'その他製品' },
  { code: '4050', name: '電気・ガス業' },
  { code: '5050', name: '陸運業' },
  { code: '5100', name: '海運業' },
  { code: '5150', name: '空運業' },
  { code: '5200', name: '倉庫・運輸関連業' },
  { code: '5250', name: '情報・通信業' },
  { code: '6050', name: '卸売業' },
  { code: '6100', name: '小売業' },
  { code: '7050', name: '銀行業' },
  { code: '7100', name: '証券・商品先物取引業' },
  { code: '7150', name: '保険業' },
  { code: '7200', name: 'その他金融業' },
  { code: '8050', name: '不動産業' },
  { code: '9050', name: 'サービス業' },
  { code: '9999', name: 'その他' },
];

/** 業種のコードから名称を引く。知らないコードは「その他」。 */
export function columnIndustryName(code: string): string {
  return COLUMN_INDUSTRIES.find((i) => i.code === code)?.name ?? 'その他';
}

/** 全般（景品表示法）のほかに当てうる表現の決まり（第32.8節）。 */
export type ColumnRuleSet = 'medical' | 'health-products' | 'legal';

/** 表現の決まりの呼び方。 */
export const COLUMN_RULE_SET_LABELS: Record<ColumnRuleSet, string> = {
  medical: '医療広告ガイドライン', 'health-products': '薬機法・健康増進法', legal: '士業の広告の規程',
};

/** WordPress の入れ先（パスワードは会社の接続の秘密の値として別に預ける）。 */
export interface ColumnWordPress {
  /** サイトの URL（例: `https://www.example.jp`）。 */
  siteUrl: string;
  username: string;
}

/** 会社の Web のコラムの設定（第32.4節）。 */
export interface WebColumnSettings {
  /** 使うか（既定は切り）。 */
  enabled: boolean;
  /** 書きたい分野。 */
  topics: string[];
  /** 読み手（例: 「市内の子育て世帯」）。 */
  audience: string;
  /** 業種のコード（{@link COLUMN_INDUSTRIES}）。 */
  industry: string;
  /** 全般のほかに当てる表現の決まり（AI が選ぶ。秘書で直せる）。 */
  rules: ColumnRuleSet[];
  /** 表現の決まりを選んだのは AI か、人（秘書で直した）か。人なら AI は選び直さない。 */
  rulesBy: 'ai' | 'person';
  /** 記事の末尾に出す監修者。 */
  supervisor: { name: string; title: string } | null;
  /** AI が書いたことを記事の末尾に入れるか（Q-164）。 */
  aiNotice: boolean;
  /** WordPress の入れ先。無ければ承認で「承認済み」にするだけ。 */
  wordpress: ColumnWordPress | null;
  /** カバー画像の背景を生成 AI で描くか（第32.7.1節。既定は切り）。 */
  aiIllustration: boolean;
  /** 予定表（月の本数と曜日。第32.11節・第32.18.4節）。無ければ予定を作らない。 */
  plan?: ColumnPlan | null;
  /** 貼るだけのページ（第32.10節・第32.18.4節）。使っていなければ `null`。 */
  pastePage?: { key: string; enabledAt: string } | null;
  /** テーマ案を最後に作った日時（週に 1 回）。 */
  themesAt?: string | null;
}

/** 予定表の本数（月に 1 本・2 本・毎週）。 */
export type ColumnPlanFrequency = 1 | 2 | 4;

/** 予定表の本数の呼び方。 */
export const COLUMN_PLAN_FREQUENCY_LABELS: Record<ColumnPlanFrequency, string> = { 1: '月に 1 本', 2: '月に 2 本', 4: '毎週' };

/** 予定表（第32.18.4節）。`weekday` は 0（日）〜6（土）。 */
export interface ColumnPlan {
  perMonth: ColumnPlanFrequency;
  weekday: number;
}

/** 予定表の回 1 つ。 */
export interface ColumnPlanSlot {
  /** 公開の日（YYYY-MM-DD。公開は 9 時） */
  date: string;
  /** この回に入れたコラム（無ければ空いている回） */
  columnId: string | null;
  title: string;
  status: WebColumnStatus | null;
}

/** テーマ案の材料（第32.6節）。 */
export type ColumnThemeSource = 'topic' | 'season' | 'search' | 'competitor' | 'question' | 'rewrite' | 'news';

/** 材料の呼び方（画面の印）。 */
export const COLUMN_THEME_SOURCE_LABELS: Record<ColumnThemeSource, string> = {
  topic: '分野', season: '季節', search: '検索', competitor: '競合', question: '質問', rewrite: '書き直し', news: 'ニュース',
};

/** テーマ案の状態。 */
export type ColumnThemeStatus = 'new' | 'used' | 'dismissed';

/** テーマ案 1 つ（第32.6節）。 */
export interface WebColumnTheme {
  id: string;
  /** テーマ（問い） */
  theme: string;
  /** なぜ今か（一言） */
  why: string;
  source: ColumnThemeSource;
  /** 書き直しの案なら、そのコラム */
  columnId: string | null;
  /** ニュースの案なら、もとにした出典の題名と URL（無ければ空。第32.18.7節） */
  sourceTitle: string;
  sourceUrl: string;
  status: ColumnThemeStatus;
  createdAt: string;
}

/** 1 回に作るテーマ案の数（第32.6節「5 つ前後」）。 */
export const COLUMN_THEMES_PER_WEEK = 5;

/** 予定表の回の何日前に下書きを用意するか（第32.11節）。 */
export const COLUMN_PREPARE_DAYS = 7;

/** 既定の設定。既定は切り（第32.2節）。 */
export const DEFAULT_WEB_COLUMN_SETTINGS: WebColumnSettings = {
  enabled: false, topics: [], audience: '', industry: '9999', rules: [], rulesBy: 'ai', supervisor: null, aiNotice: true, wordpress: null, aiIllustration: false,
};

/** コラムの状態。 */
export type WebColumnStatus = 'writing' | 'draft' | 'awaiting' | 'approved' | 'scheduled' | 'placed' | 'withdrawn' | 'failed';

/** 状態の呼び方。 */
export const WEB_COLUMN_STATUS_LABELS: Record<WebColumnStatus, string> = {
  writing: '書いています', draft: '下書き', awaiting: '承認待ち', approved: '承認済み', scheduled: '予約', placed: 'WordPress に入れた', withdrawn: '取り下げ', failed: '書けませんでした',
};

/** 赤入れの指摘 1 つ（第32.8節）。 */
export interface ColumnReviewItem {
  /** 本文の該当の箇所（そのまま抜き出した文字）。本文全体への指摘なら空。 */
  quote: string;
  reason: string;
  /** 直し案（置き換える文字）。無ければ空。 */
  suggestion: string;
  /** rule（決まったプログラム）・ai（推論）。 */
  by: 'rule' | 'ai';
  /** 種類（表現の決まり・出典・個人の情報・読みやすさ）。 */
  kind: 'expression' | 'source' | 'privacy' | 'readability';
}

/** カバー画像の背景の種類（第32.7.1節）。template（型）・ai（AI の挿絵）・photo（会社の写真）。 */
export type ColumnCoverKind = 'template' | 'ai' | 'photo';

/** カバー画像の背景の呼び方。 */
export const COLUMN_COVER_KIND_LABELS: Record<ColumnCoverKind, string> = {
  template: '型', ai: 'AI 作成の画像', photo: '会社の写真',
};

/** 版のカバー画像（第32.18.2節）。 */
export interface WebColumnCover {
  /** 組み立てた PNG（1,200×630）のファイル。 */
  fileId: string;
  kind: ColumnCoverKind;
  /** 型の模様（型のときだけ）。 */
  pattern: string | null;
  /** 会社の写真（写真のときだけ）。 */
  photoId: string | null;
  /** 代わりの文。 */
  alt: string;
  /** このカバーを作るときに AI の挿絵を描いた枚数（確かめを通らなかった分も数える）。 */
  aiAttempts: number;
  /** 確かめの結果や、型にした理由（無ければ空）。 */
  note: string;
}

/** 会社の写真の置き場の 1 枚（第32.18.2節）。 */
export interface ColumnPhoto {
  id: string;
  fileId: string;
  description: string;
  hasPeople: boolean;
  createdAt: string;
}

/** 出典 1 つ。 */
export interface ColumnSource {
  title: string;
  url: string;
}

/** コラムの版 1 つ。 */
export interface WebColumnVersion {
  version: number;
  title: string;
  /** 題名の候補（AI が出した 3 つ）。 */
  titles: string[];
  /** 本文（Markdown）。 */
  body: string;
  /** 説明文（検索の結果に出る 120 字前後）。 */
  description: string;
  /** SNS の告知文。 */
  sns: { short: string; long: string };
  sources: ColumnSource[];
  review: ColumnReviewItem[];
  /** カバー画像。まだ作っていなければ `null`。 */
  cover: WebColumnCover | null;
  origin: 'writer' | 'rewrite' | 'edit' | 'suggestion' | 'restore' | 'cover';
  createdBy: string;
  createdByName?: string;
  createdAt: string;
}

/** コラム（一覧に出す形）。 */
export interface WebColumn {
  id: string;
  theme: string;
  memo: string;
  status: WebColumnStatus;
  currentVersion: number;
  /** 今の版の題名（書いている間は空）。 */
  title: string;
  /** 今の版の赤入れの数。 */
  reviewCount: number;
  submittedVersion: number | null;
  runId: string | null;
  wpEditUrl: string | null;
  failure: string | null;
  /** 予定表の回（YYYY-MM-DD。第32.18.4節） */
  plannedFor?: string | null;
  /** 公開の日時（予約。ISO） */
  publishAt?: string | null;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- 店頭サイネージ用の画像と動画（仕様書 第32.18.6節） -----------------------------------------

/** 店頭サイネージ用の組の種類。`slides` は画像（1 枚か紙芝居）、`video` は動画（段 2）。 */
export type ColumnSignageKind = 'slides' | 'video';

/** 店頭サイネージ用の組の状態。 */
export type ColumnSignageStatus = 'making' | 'ready' | 'submitted' | 'published' | 'withdrawn' | 'failed';

/** 状態の呼び方。 */
export const COLUMN_SIGNAGE_STATUS_LABELS: Record<ColumnSignageStatus, string> = {
  making: '作っています', ready: 'できました', submitted: '承認待ち', published: '流しています', withdrawn: '外しました', failed: '作れませんでした',
};

/** 紙芝居の 1 場面。`caption` は画面に出す一言、`picture` は絵の内容（画面には出さない）。 */
export interface ColumnSignageScene {
  caption: string;
  picture: string;
}

/** できた画像か動画 1 つ。 */
export interface ColumnSignageOutput {
  orientation: 'landscape' | 'portrait';
  /** 何枚目か（0 から）。動画は 0。 */
  index: number;
  fileId: string;
  kind: 'image' | 'video';
}

/** 店頭サイネージ用の 1 組（1 回の「サイネージ用を作る」）。 */
export interface ColumnSignageSet {
  id: string;
  columnId: string;
  kind: ColumnSignageKind;
  status: ColumnSignageStatus;
  scenes: ColumnSignageScene[];
  outputs: ColumnSignageOutput[];
  /** 描き直しや型にしたことなど、頼んだ人に伝えること。 */
  note: string;
  /** 作れなかった・流せなかった理由。 */
  error: string | null;
  runId: string | null;
  screenIds: string[];
  /** 流す最後の日時（流しているときだけ）。 */
  publishUntil: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 紙芝居の枚数の上限。 */
export const COLUMN_SIGNAGE_SLIDES_MAX = 5;
/** 画面に出す一言の長さ（字）。 */
export const COLUMN_SIGNAGE_CAPTION_MAX = 30;
/** 承認の後に流す日数（案）。 */
export const COLUMN_SIGNAGE_DAYS = 30;
/** 紙芝居の 1 枚を出す秒数。 */
export const COLUMN_SIGNAGE_SECONDS = 8;
/** 店頭サイネージ用の動画を会社で月に作れる本数（作り直しも数える。仕様書 第32.18.6節 段 2）。 */
export const COLUMN_SIGNAGE_VIDEO_MONTHLY_LIMIT = 10;
/** 店頭サイネージ用の動画の既定のモデル（Veo 3.1 Lite。`MODEL_VIDEO` で変えられる）。 */
export const COLUMN_SIGNAGE_VIDEO_MODEL = 'veo-3.1-lite-generate-preview';
