/**
 * @file 申し込みの口の起動口（仕様書 第23.3.1節）。顧客向けの API・運営の API とは別のプロセス。
 *
 * データベースには専用のロール（`SIGNUP_DATABASE_URL`。`m2office_signup`）で接続する。業務の表にも運営の表にも届かない。
 * 開発は 3103 番（`SIGNUP_PORT`）。画面の開発サーバーが `/v1/signup` をここへ転送する。
 * Stripe の鍵を持つのはこのプロセスだけで、毎月のカードの課金もここで行う（第23.4.5節）。
 */

import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { createLoggerFromEnv, createPool, installPoolLogger, keepAliveOnTransientErrors, MockPaymentProvider, paymentProviderName, SignupStore, type PaymentProvider } from '@m2office/core';
import { loadAuthConfig } from '../auth/config.js';
import { listenHost } from '../listen.js';
import { chargeDueInvoices, signupApp } from './app.js';

const log = createLoggerFromEnv('signup');
installPoolLogger(log.child({ component: 'db' }));
keepAliveOnTransientErrors(log.child({ component: 'process' }));

const env = process.env;
const production = env['NODE_ENV'] === 'production';
const port = Number(env['SIGNUP_PORT'] ?? 3103);
const auth = loadAuthConfig(env);
const dbUrl = env['SIGNUP_DATABASE_URL'] ?? (production ? null : 'postgres://m2office_signup:m2office_signup@localhost:3105/m2office');
if (!dbUrl) throw new Error('SIGNUP_DATABASE_URL がありません。起動を中止します。');
if (decodeURIComponent(new URL(dbUrl).username) !== 'm2office_signup') {
  throw new Error('SIGNUP_DATABASE_URL の利用者は m2office_signup にしてください。起動を中止します。');
}
const secret = env['SIGNUP_SECRET']?.trim() || (production ? null : randomBytes(32).toString('base64url'));
if (!secret) throw new Error('SIGNUP_SECRET がありません。起動を中止します。');
const redirectUri = env['SIGNUP_GOOGLE_REDIRECT_URI'] ?? `http://localhost:${port}/v1/signup/auth/callback`;
if (production && auth.login && !redirectUri.startsWith('https://')) {
  throw new Error('本番環境で SIGNUP_GOOGLE_REDIRECT_URI が HTTPS ではありません。起動を中止します。');
}

// 支払いの口（第23.4.5節「ダミーの支払いの口」）。本番では mock で起動しない（paymentProviderName が止める）
const providerName = paymentProviderName(env);
if (providerName === 'stripe') {
  // 本物の口は、Stripe のアカウントができてから作る（Q-305）
  throw new Error('M2O_PAYMENT_PROVIDER=stripe はまだ作っていません（Stripe のアカウント待ち）。起動を中止します。');
}
const provider: PaymentProvider | null = providerName === 'mock' ? new MockPaymentProvider(secret, '/billing/mock-card') : null;

const store = new SignupStore(createPool(dbUrl, { max: 3, name: 'signup' }));
const app = signupApp({
  store, provider, log,
  config: {
    login: auth.login ? { clientId: auth.login.clientId, clientSecret: auth.login.clientSecret, redirectUri } : null,
    devLogin: auth.devLogin, cookieSecure: auth.cookieSecure, secret,
  },
});

// 毎月のカードの課金（ワーカーが作った請求を 1 分ごとに見る）
if (provider) {
  setInterval(() => {
    void chargeDueInvoices(store, provider, log)
      .then((n) => { if (n > 0) log.info('カードの課金を行いました', { count: n }); })
      .catch((err: unknown) => log.warn('課金する請求を読めませんでした', { err: err instanceof Error ? err.message : String(err) }));
  }, Number(env['SIGNUP_CHARGE_INTERVAL_MS'] ?? 60_000)).unref();
}

const hostname = listenHost();
serve({ fetch: app.fetch, port, hostname }, (info) => {
  log.info('申し込みの口の待ち受けを開始しました', { host: hostname, port: info.port, provider: provider?.name ?? null, google: !!auth.login });
  if (auth.devLogin) log.warn('開発用ログインが有効です（本番では起動を拒否します）');
});
