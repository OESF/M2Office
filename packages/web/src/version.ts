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

/**
 * 版が食い違っているときの知らせ（仕様書 第6.1.1.1節）。
 *
 * @param dev 開発サーバー（Vite）で動いているか
 * @returns 出す文と、再読み込みのボタンを置くか
 *
 * @remarks
 * 開発サーバーは起動したときにだけ版を読む。版を上げても起動し直すまで古い版の画面を配るため、
 * 再読み込みしても直らない。開発では、押しても効かないボタンを出さず、起動し直すよう知らせる（第 0.293.1 版）
 */
export function staleNotice(dev: boolean): { text: string; reload: boolean } {
  return dev
    ? { text: '開発サーバーが前の版の画面を配っています。開発サーバーを起動し直してください（再読み込みでは変わりません）。', reload: false }
    : { text: '新しい版があります。再読み込みしてください。', reload: true };
}
