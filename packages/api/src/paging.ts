/**
 * @file 一覧の口のページ（仕様書 第6.8節 原則 u14「増え続ける一覧は、件数で切らずにページで送る」）。
 *
 * 一覧の口は `offset` で受け、そのページの `items` とすべての数 `total` を返す。1 ページの件数と、`offset` の読み方をそろえる。
 */

/** 1 ページの件数（画面の `web/src/Pager.tsx` の `PAGE_SIZE` と同じ）。 */
export const PAGE = 50;

/**
 * 問い合わせの `offset` を読む。数でない・負の数・空なら 0。
 *
 * @param raw 問い合わせの文字
 */
export function offsetOf(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
