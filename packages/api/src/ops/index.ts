/**
 * @file マスター管理画面の API の起動口（仕様書 第23.8.15節、Q-212）。顧客向けの API（`../index.ts`）とは別のプロセスで動かす。
 *
 * データベースには運営の専用のロール（`OPS_DATABASE_URL`。`m2office_ops`）で接続する。顧客の表には届かない。
 * 開発は 3102 番（`OPS_PORT`）。画面の開発サーバーが `/v1/ops` をここへ転送する。
 */

import { serve } from '@hono/node-server';
import { createLoggerFromEnv, createPool, installPoolLogger, OpsStore } from '@m2office/core';
import { loadAuthConfig } from '../auth/config.js';
import { opsApp, type OpsConfig } from './app.js';

const log = createLoggerFromEnv('ops');
installPoolLogger(log.child({ component: 'db' }));

const env = process.env;
const port = Number(env['OPS_PORT'] ?? 3102);
const auth = loadAuthConfig(env);
const dbUrl = env['OPS_DATABASE_URL'] ?? (env['NODE_ENV'] === 'production' ? null : 'postgres://m2office_ops:m2office_ops@localhost:3105/m2office');
if (!dbUrl) throw new Error('OPS_DATABASE_URL がありません。起動を中止します。');
if (decodeURIComponent(new URL(dbUrl).username) !== 'm2office_ops') {
  // 所有者やアプリのロールで接続すると、顧客の表に届いてしまう
  throw new Error('OPS_DATABASE_URL の利用者は m2office_ops にしてください。起動を中止します。');
}
const redirectUri = env['OPS_GOOGLE_REDIRECT_URI'] ?? `http://localhost:${port}/v1/ops/auth/callback`;
if (env['NODE_ENV'] === 'production' && auth.login && !redirectUri.startsWith('https://')) {
  throw new Error('本番環境で OPS_GOOGLE_REDIRECT_URI が HTTPS ではありません。起動を中止します。');
}
const config: OpsConfig = {
  login: auth.login ? { clientId: auth.login.clientId, clientSecret: auth.login.clientSecret, redirectUri } : null,
  googleDomain: env['OPS_GOOGLE_DOMAIN']?.trim().toLowerCase() || null,
  devLogin: auth.devLogin,
  cookieSecure: auth.cookieSecure,
  // 全社に効く権限のため、顧客より短くする
  sessionTtlHours: Number(env['OPS_SESSION_TTL_HOURS'] ?? 12),
};

const store = new OpsStore(createPool(dbUrl, { max: 5, name: 'ops' }));
const app = opsApp({ store, config, log });

serve({ fetch: app.fetch, port }, (info) => {
  log.info('運営の API の待ち受けを開始しました', { port: info.port, google: !!config.login, googleDomain: config.googleDomain, devLogin: config.devLogin });
  if (config.devLogin) log.warn('開発用ログインが有効です（本番では起動を拒否します）');
});
