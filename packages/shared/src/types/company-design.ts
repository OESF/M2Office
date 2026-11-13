/**
 * @file 会社の見た目（仕様書 第46章、ADR-0145）の型。色・文字・形・写真と絵の雰囲気・文の調子を 1 つの決まりとして持つ。
 *
 * 中の形は M2Office のもので、DESIGN.md（Google Labs の形式。アルファ版）は書き出しと取り込みの口にする。
 */

/** 会社の見た目の値。色は `#rrggbb`。 */
export interface CompanyDesignTokens {
  colors: {
    /** 主の色（ボタン・見出しの差し・ロゴに近い色）。 */
    primary: string;
    /** 主の色の上の文字。 */
    onPrimary: string;
    secondary: string;
    /** 差し色。 */
    accent: string;
    background: string;
    /** 面（カード）。 */
    surface: string;
    /** 本文。 */
    text: string;
    /** 薄い文字（日付・注）。 */
    muted: string;
    border: string;
    link: string;
  };
  typography: {
    /** 見出しの和文の書体。 */
    headingJa: string;
    /** 本文の和文の書体。 */
    bodyJa: string;
    /** 欧文の書体。 */
    latin: string;
    /** 本文の大きさ（px）。 */
    baseSize: number;
    /** 見出しの大きさの比（本文に対して。1.1〜1.6）。 */
    scale: number;
    headingWeight: number;
    bodyWeight: number;
  };
  shape: {
    radiusSmall: number;
    radiusMedium: number;
    radiusLarge: number;
    /** 余白の基準（px）。 */
    spacing: number;
    shadow: boolean;
    button: 'square' | 'rounded' | 'pill';
  };
  /** 写真と絵の雰囲気（AI の挿絵の頼みに添える）。 */
  imagery: string;
  /** 文の調子（会社の名前で書く文に添える）。 */
  voice: string;
}

/** 見た目の出どころ。 */
export type CompanyDesignSource = 'ai' | 'import' | 'chat' | 'restore';

/** 会社の見た目の 1 つの版（画面と秘書に見せる）。 */
export interface CompanyDesignView {
  version: number;
  tokens: CompanyDesignTokens;
  /** AI が書いた説明（全体の印象・使い方）。 */
  summary: string;
  source: CompanyDesignSource;
  /** 取り込んだ元の名前・頼み。 */
  sourceName: string;
  createdBy: string;
  createdAt: string;
}

/** 出どころの言葉（画面）。 */
export const COMPANY_DESIGN_SOURCE_LABELS: Record<CompanyDesignSource, string> = {
  ai: 'AI がロゴとサイトから作った', import: '取り込んだ', chat: '会話で直した', restore: '前の版に戻した',
};

/** 上限。 */
export const COMPANY_DESIGN_LIMITS = { versions: 20, importChars: 60_000, requestChars: 1000 } as const;
