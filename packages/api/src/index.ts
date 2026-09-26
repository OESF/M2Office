/**
 * @file API サーバーの起動口。ルートと認証・テナント解決の順序を組み立てる。
 *
 * 画面が使う API と外部公開 API は同じものであり、画面専用の抜け道を作らない。
 * テナントの解決はすべての要求に、利用者の確認はログイン以外のすべてに掛ける。
 *
 * @see 仕様書 第13.1節 公開の方針（A-1・A-2）
 */

import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { defaultGeminiModels, warnHotSwapModels } from '@m2office/core';
import { buildDeps, companyName } from './context.js';
import { authenticate, resolveTenant, type AppEnv } from './middleware/tenant.js';
import { attachVoiceRelay } from './voice/relay.js';
import { onUnexpectedError, requestLogger } from './middleware/logging.js';
import { agentsRoute } from './routes/agents.js';
import { jobsRoute } from './routes/jobs.js';
import { runsRoute } from './routes/runs.js';
import { approvalsRoute } from './routes/approvals.js';
import { secretaryRoute } from './routes/secretary.js';
import { authRoute } from './routes/auth.js';
import { notificationsRoute } from './routes/notifications.js';
import { schedulesRoute } from './routes/schedules.js';
import { adminRoute } from './routes/admin.js';
import { meRoute } from './routes/me.js';
import { filesRoute } from './routes/files.js';
import { dashboardRoute } from './routes/dashboard.js';
import { helpRoute } from './routes/help.js';
import { onboardingRoute } from './routes/onboarding.js';
import { extensionsRoute } from './routes/extensions.js';
import { accessRoute, compartmentsRoute, groupsRoute } from './routes/access.js';
import { connectionsRoute, myGoogleRoute, oauthCallbackRoute } from './routes/connections.js';

/**
 * API サーバー。
 *
 * @remarks
 * 画面が使う API と外部公開 API は同じものである（仕様書 第13.1節 A-1・A-2）。
 * 画面専用の抜け道を作らない。SPA 構成により、これは構造として保たれる。
 */
const deps = buildDeps();

/**
 * サーバーの版（ルートの `package.json`。仕様書 第6.1.1.1節）。起動のときに 1 度だけ読む。
 *
 * @remarks 画面は自分の版と比べ、違えば再読み込みを促す（開いたままのタブが古い版のまま残るため）。
 */
const SERVER_VERSION: string | null = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')) as { version: string }).version;
  } catch {
    return null;
  }
})();
const app = new Hono<AppEnv>();

/**
 * 別オリジンからの呼び出しを許す相手。
 *
 * @remarks
 * 画面は開発サーバーの転送を通すため、通常は同一オリジンであり CORS は使わない。
 * ここで許すのはテナントのサブドメインだけである。
 * 任意のオリジンを許すと、Cookie を伴う要求を他のサイトから送られてしまう。
 */
const baseDomain = (process.env['BASE_DOMAIN'] ?? 'lvh.me').replace(/\./g, '\\.');
const allowedOrigin = new RegExp(`^https?://[a-z0-9-]+\\.(${baseDomain}|localhost)(:\\d+)?$`);
app.use('*', requestLogger(deps.log));
app.onError(onUnexpectedError(deps.log));
app.use('*', cors({
  origin: (origin) => (allowedOrigin.test(origin) ? origin : null),
  credentials: true,
  allowHeaders: ['content-type', 'x-csrf-token', 'x-tenant', 'x-user', 'x-request-id'],
  exposeHeaders: ['x-request-id'],
}));

app.get('/health', (c) => c.json({ ok: true, service: 'api' }));

// テナントの解決はすべてに、利用者の確認はログイン以外のすべてに掛ける
// Google からの戻りは、テナントの判定とログインより前に受ける（state で照合する。仕様書 第14.3.3節）
app.route('/v1/oauth', oauthCallbackRoute(deps));
app.use('/v1/*', resolveTenant(deps));
app.route('/v1/auth', authRoute(deps));
app.use('/v1/*', async (c, next) =>
  c.req.path.startsWith('/v1/auth/') ? next() : authenticate(deps)(c, next));

app.get('/v1/me', async (c) => {
  const ctx = c.get('ctx');
  const auth = c.get('auth');
  // 本人のアバター（第6.5.1.1節）。取り込み直すと URL が変わり、画面が新しい写真を読む
  const photo = await deps.repo.getUserPhoto(ctx.tenant.id, ctx.user.id);
  return c.json({
    // 画面に出す会社名は、会社情報の正式な会社名（仕様書 第6.6.1節）。入っていなければ申し込みのときの名前
    tenant: { ...ctx.tenant, name: await companyName(deps, ctx.tenant) },
    user: ctx.user,
    photo: photo ? `/v1/me/photo?v=${encodeURIComponent(photo.fetchedAt)}` : null,
    // サーバーの版。画面の版と違えば、画面が再読み込みを促す（第6.1.1.1節）
    serverVersion: SERVER_VERSION,
    auth: { method: auth.method },
    csrfToken: auth.method === 'session' ? auth.csrfToken : null,
    // 値の出どころは会社ごと（ADR-0022）
    workspaceSource: deps.connector.sourceFor(ctx.tenant.id),
  });
});
app.route('/v1/me/google', myGoogleRoute(deps));
app.route('/v1/me', meRoute(deps));
app.route('/v1/agents', agentsRoute(deps));
app.route('/v1/jobs', jobsRoute(deps));
app.route('/v1/runs', runsRoute(deps));
app.route('/v1/approvals', approvalsRoute(deps));
app.route('/v1/secretary', secretaryRoute(deps));
app.route('/v1/notifications', notificationsRoute(deps));
app.route('/v1/schedules', schedulesRoute(deps));
app.route('/v1/admin/dashboard', dashboardRoute(deps));
app.route('/v1/admin/extensions', extensionsRoute(deps));
app.route('/v1/admin/groups', groupsRoute(deps));
app.route('/v1/admin/access', accessRoute(deps));
app.route('/v1/admin/compartments', compartmentsRoute(deps));
app.route('/v1/admin/connections', connectionsRoute(deps));
app.route('/v1/admin', adminRoute(deps));
app.route('/v1/files', filesRoute(deps));
app.route('/v1/help', helpRoute(deps));
app.route('/v1/onboarding', onboardingRoute(deps));

const port = Number(process.env['API_PORT'] ?? 3101);
const server = serve({ fetch: app.fetch, port }, (info) => {
  const models = defaultGeminiModels();
  deps.log.info('待ち受けを開始しました', {
    port: info.port,
    connector: process.env['CONNECTOR_MODE'] ?? 'mock',
    mockTenants: process.env['CONNECTOR_MOCK_TENANTS'] || undefined,
    llm: deps.llm.name,
    // どのモデルで動いているかを、起動のときに残す（費用の追跡に要る。仕様書 第20.2.2節）
    models: `fast=${models.fast} standard=${models.standard} advanced=${models.advanced}`,
    devLogin: deps.auth.devLogin,
    devHeaders: deps.auth.devHeaders,
  });
  warnHotSwapModels(models, deps.log);
  if (deps.auth.devLogin || deps.auth.devHeaders) {
    deps.log.warn('開発用ログインが有効です（本番では起動を拒否します）');
  }
});

// 音声の対話の中継（仕様書 第10.5.5節）。WebSocket は Hono の外側で受ける
attachVoiceRelay(deps, server as unknown as HttpServer);
