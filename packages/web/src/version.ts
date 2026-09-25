/**
 * @file 画面の版（仕様書 第6.1.1.1節）。ビルドのときに埋め込んだ値を読む。
 */

declare const __APP_VERSION__: string | undefined;

/**
 * 画面の版（例: `0.5.0`）。
 *
 * @remarks
 * ビルドのときに Vite が埋め込む（`vite.config.ts` の `define`）。
 * 埋め込まれていない場合（単体テストなど）では `null` を返す。推測の値で埋めない。
 */
export const APP_VERSION: string | null = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;

/**
 * 画面とサーバーの版が食い違っているか。
 *
 * @returns どちらかが分からないときは `false`（分からないのに「新しい版があります」と言わない）
 */
export function versionMismatch(web: string | null, server: string | null | undefined): boolean {
  return !!web && !!server && web !== server;
}
