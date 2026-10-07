/**
 * @file 同梱の書体に無い字を、同じ形の字に置き換える（字が四角や〓にならないように）。
 *
 * 同梱の Noto Sans JP は、JIS X 0208 の範囲を Windows 流の対応（cp932）で集めて絞っている（`scripts/build-font-subset.mjs`）。
 * そのため、JIS の正式な対応の字（マイナス記号 U+2212 など）が入っていない。会社情報の住所の「１９−１３」のように、
 * Mac などで打つとこの字になることがある。描くときに、書体にある同じ形の字へ置き換える。
 */

/** JIS の正式な対応の字と、Windows 流の対応の字（同じ見た目）。 */
const SAME_SHAPE: Record<string, string> = {
  '−': '－', // − マイナス記号 → － 全角のハイフンマイナス
  '‖': '∥', // ‖ 二重の縦線 → ∥ 平行
  '¢': '￠', // ¢ → ￠
  '£': '￡', // £ → ￡
  '¬': '￢', // ¬ → ￢
};

const PATTERN = new RegExp(`[${Object.keys(SAME_SHAPE).join('')}]`, 'g');

/**
 * 同梱の書体に無い字を、書体にある同じ形の字に置き換える。
 *
 * @remarks 描く前（画像にする SVG・PDF に書く字）にだけ使う。保存している値は変えない
 */
export function toBundledFontChars(text: string): string {
  return text.replace(PATTERN, (c) => SAME_SHAPE[c] ?? c);
}
