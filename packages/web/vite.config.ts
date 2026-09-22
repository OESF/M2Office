/**
 * @file 画面の開発サーバーの設定。ポートは 3100 番台、`/v1` は API へ転送する。
 *
 * Host ヘッダーをそのまま渡し、サブドメインでテナントを解決できるようにする。
 *
 * @see 仕様書 第20.4.1節 ローカル開発環境
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 画面の開発サーバー設定。
 *
 * ポートは 3100 番台に統一する。
 * `/v1` への要求は API（3101）へ転送し、**Host ヘッダーをそのまま渡す**。
 * これにより `a.lvh.me:3100` で開いたときに A 社のテナントとして解決される
 * （仕様書 第6.5.1節）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env['WEB_PORT'] ?? 3100),
    host: true,
    // 任意のサブドメインで開けるようにする。テナントはホスト名で解決する
    allowedHosts: ['.lvh.me', '.localhost', `.${process.env['BASE_DOMAIN'] ?? 'lvh.me'}`],
    proxy: {
      '/v1': {
        target: `http://127.0.0.1:${process.env['API_PORT'] ?? 3101}`,
        // テナント解決のため、元のホスト名を保つ
        changeOrigin: false,
      },
    },
  },
  // ビルド結果の確認用。開発サーバーと同じ転送設定を使う
  preview: {
    port: Number(process.env['WEB_PREVIEW_PORT'] ?? 3103),
    host: true,
    allowedHosts: ['.lvh.me', '.localhost', `.${process.env['BASE_DOMAIN'] ?? 'lvh.me'}`],
    proxy: {
      '/v1': {
        target: `http://127.0.0.1:${process.env['API_PORT'] ?? 3101}`,
        changeOrigin: false,
      },
    },
  },
});
