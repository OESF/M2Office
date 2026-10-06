/**
 * @file 画面の開発サーバーの設定。ポートは 3100 番台、`/v1` は API へ転送する。
 *
 * Host ヘッダーをそのまま渡し、サブドメインでテナントを解決できるようにする。
 * 設定の値（`WEB_HTTPS`・`WEB_PORT`・`API_PORT`・`BASE_DOMAIN`）は、起動したシェルの環境変数を先に、無ければリポジトリ直下の `.env` から読む
 * （API とワーカーと同じ `.env` に書けば効くように）。
 *
 * @see 仕様書 第20.4.1節 ローカル開発環境
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** リポジトリ直下の `.env`（シェルの環境変数が先）。 */
const rootEnv = loadEnv('development', fileURLToPath(new URL('../..', import.meta.url)), '');
const env = (key: string): string | undefined => process.env[key] ?? rootEnv[key];

/**
 * 開発を HTTPS で動かすための証明書（`npm run dev:cert` で作る）。
 *
 * @remarks
 * ブラウザは**安全な文脈（HTTPS か `localhost`）でしかマイクを使わせない**ため、
 * 音声を `<サブドメイン>.lvh.me` で試すには HTTPS が要る（仕様書 第20.4.1節）。
 * `WEB_HTTPS=true` のときだけ使う。証明書が無ければ HTTP のまま動かし、作り方を示す。
 */
function devHttps(): { key: Buffer; cert: Buffer } | undefined {
  if (env('WEB_HTTPS') !== 'true') return undefined;
  const dir = fileURLToPath(new URL('../../.data/certs', import.meta.url));
  const key = `${dir}/dev-key.pem`;
  const cert = `${dir}/dev-cert.pem`;
  if (!existsSync(key) || !existsSync(cert)) {
    console.warn('[web] WEB_HTTPS=true ですが証明書がありません。npm run dev:cert で作ってください。HTTP で起動します。');
    return undefined;
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * 画面に埋め込む版（ルートの `package.json`。仕様書 第6.1.1.1節）。
 *
 * @remarks **ビルドのときに決まる。** リリースで版を上げたら、画面を作り直さないと古い版が出たままになる（リリース規定）。
 */
const appVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8')) as { version: string }).version;

/** API への転送。**WebSocket も通す**（音声の中継。仕様書 第10.5.5節）。 */
const apiProxy = {
  '/v1': {
    target: `http://127.0.0.1:${env('API_PORT') ?? 3101}`,
    // テナント解決のため、元のホスト名を保つ
    changeOrigin: false,
    // 音声の中継は WebSocket である。これが無いと接続が張れない
    ws: true,
  },
};

/**
 * 画面の開発サーバー設定。
 *
 * ポートは 3100 番台に統一する。
 * `/v1` への要求は API（3101）へ転送し、**Host ヘッダーをそのまま渡す**。
 * これにより `a.lvh.me:3100` で開いたときに A 社のテナントとして解決される
 * （仕様書 第20.4.1節）。
 */
export default defineConfig({
  plugins: [react()],
  // 画面の版を埋め込む（仕様書 第6.1.1.1節）
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    port: Number(env('WEB_PORT') ?? 3100),
    host: true,
    https: devHttps(),
    // 任意のサブドメインで開けるようにする。テナントはホスト名で解決する
    allowedHosts: ['.lvh.me', '.localhost', `.${env('BASE_DOMAIN') ?? 'lvh.me'}`],
    proxy: apiProxy,
  },
  // ビルド結果の確認用。開発サーバーと同じ転送設定を使う
  preview: {
    port: Number(env('WEB_PREVIEW_PORT') ?? 3103),
    host: true,
    https: devHttps(),
    allowedHosts: ['.lvh.me', '.localhost', `.${env('BASE_DOMAIN') ?? 'lvh.me'}`],
    proxy: apiProxy,
  },
});
