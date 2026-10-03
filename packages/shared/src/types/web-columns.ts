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
}

/** 既定の設定。既定は切り（第32.2節）。 */
export const DEFAULT_WEB_COLUMN_SETTINGS: WebColumnSettings = {
  enabled: false, topics: [], audience: '', industry: '9999', rules: [], rulesBy: 'ai', supervisor: null, aiNotice: true, wordpress: null, aiIllustration: false,
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
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
}
