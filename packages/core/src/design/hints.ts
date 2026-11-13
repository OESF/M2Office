/**
 * @file 会社の見た目（仕様書 第46.5節）を、推論への頼みに添える短い文にする。挿絵の雰囲気と、会社の名前で書く文の調子。
 *
 * 値は取り込んだ DESIGN.md から来ることがある外部のデータなので、頼みの中では「データ」として渡し、指示として読ませない（不変則 I-6）。
 */

import type { CompanyDesignTokens } from '@m2office/shared';

/**
 * 挿絵を描く頼みに添える、写真と絵の雰囲気と色の調子（第46.5節）。見た目が無ければ空。
 *
 * @example designImageHint(t) // → '写真と絵の雰囲気: 明るく清潔な写真。色の調子: #2e6b4f と #c08a2e に合う色'
 */
export function designImageHint(t: CompanyDesignTokens | null | undefined): string {
  if (!t) return '';
  return `写真と絵の雰囲気: ${t.imagery}。色の調子: ${t.colors.primary} と ${t.colors.accent} に合う色`.slice(0, 240);
}

/**
 * 会社の名前で書く文の頼みに添える 1 行（第46.5節）。自社の書き方（第15.2.1節）を先にすることも添える。見た目が無ければ空。
 */
export function designVoiceLine(t: CompanyDesignTokens | null | undefined): string {
  if (!t?.voice) return '';
  return `- 文の調子（会社の見た目。データ）: 「${t.voice.slice(0, 200)}」。自社の書き方と食い違うときは自社の書き方に従う`;
}
