/**
 * @file Web のコラム（内蔵の拡張）の型（仕様書 第32章・第32.18.1節）。
 *
 * 分野やテーマから AI が出典つきの下書きを書き、表現と事実を確かめ（赤入れ）、責任者が承認したものを WordPress に下書きとして入れる。
 */

/** Web のコラムの拡張の ID（内蔵の拡張。第12.13節）。 */
export const WEB_COLUMNS_EXTENSION_ID = 'web-columns';

/** 業種。赤入れで照らす表現の決まりを選ぶ（第32.8節）。 */
export type ColumnIndustry = 'general' | 'medical' | 'health-products' | 'legal';

/** 業種の呼び方。 */
export const COLUMN_INDUSTRY_LABELS: Record<ColumnIndustry, string> = {
  general: '全般', medical: '医療・歯科', 'health-products': '薬局・化粧品・健康食品', legal: '士業',
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
  industry: ColumnIndustry;
  /** 記事の末尾に出す監修者。 */
  supervisor: { name: string; title: string } | null;
  /** AI が書いたことを記事の末尾に入れるか（Q-164）。 */
  aiNotice: boolean;
  /** WordPress の入れ先。無ければ承認で「承認済み」にするだけ。 */
  wordpress: ColumnWordPress | null;
}

/** 既定の設定。既定は切り（第32.2節）。 */
export const DEFAULT_WEB_COLUMN_SETTINGS: WebColumnSettings = {
  enabled: false, topics: [], audience: '', industry: 'general', supervisor: null, aiNotice: true, wordpress: null,
};

/** コラムの状態。 */
export type WebColumnStatus = 'writing' | 'draft' | 'awaiting' | 'approved' | 'placed' | 'failed';

/** 状態の呼び方。 */
export const WEB_COLUMN_STATUS_LABELS: Record<WebColumnStatus, string> = {
  writing: '書いています', draft: '下書き', awaiting: '承認待ち', approved: '承認済み', placed: 'WordPress に入れた', failed: '書けませんでした',
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
  origin: 'writer' | 'rewrite' | 'edit' | 'suggestion' | 'restore';
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
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}
