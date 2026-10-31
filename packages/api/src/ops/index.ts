/**
 * @file マスター管理画面の API の起動口（仕様書 第23.8.15節、Q-212）。顧客向けの API（`../index.ts`）とは別のプロセスで動かす。
 *
 * データベースには運営の専用のロール（`OPS_DATABASE_URL`。`m2office_ops`）で接続する。顧客の表には届かない。
 * 開発は 3102 番（`OPS_PORT`）。画面の開発サーバーが `/v1/ops` をここへ転送する。
 */

import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { attachLogSink, createLoggerFromEnv, createPool, envTenantCapJpy, installPoolLogger, machineDir, OpsStore, parseOpsDomains, secretBoxFromEnv, SystemLogSink } from '@m2office/core';
import { loadAuthConfig } from '../auth/config.js';
import { opsApp, type OpsConfig } from './app.js';
import { listenHost } from '../listen.js';

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
  googleDomains: parseOpsDomains(env['OPS_GOOGLE_DOMAIN']),
  devLogin: auth.devLogin,
  cookieSecure: auth.cookieSecure,
  // 全社に効く権限のため、顧客より短くする
  sessionTtlHours: Number(env['OPS_SESSION_TTL_HOURS'] ?? 12),
};

const store = new OpsStore(createPool(dbUrl, { max: 5, name: 'ops' }));
// 運営のプロセスのシステムログも、データベースに書く（仕様書 第16.10.1節）
attachLogSink(new SystemLogSink(store.query).start().accept);
// 運営の AI の設定（第23.8.14節）。鍵はアプリと同じ暗号の鍵で暗号化する。本番で暗号の鍵が無ければ起動しない（secretBoxFromEnv）
const { box } = secretBoxFromEnv(env);
// 社外の控えの結果（第20.4.6節「控え」）。毎晩の控えが機械の置き場に書く
const cloudBackupFile = join(machineDir(env), 'cloud-backup.json');
const app = opsApp({ store, config, log, cloudBackupFile, platformAi: { box, env: { key: env['GEMINI_API_KEY']?.trim() || null, tenantCapJpy: envTenantCapJpy(env) } } });

const hostname = listenHost();
serve({ fetch: app.fetch, port, hostname }, (info) => {
  log.info('運営の API の待ち受けを開始しました', { host: hostname, port: info.port, google: !!config.login, googleDomains: config.googleDomains, devLogin: config.devLogin });
  if (config.devLogin) log.warn('開発用ログインが有効です（本番では起動を拒否します）');
});
