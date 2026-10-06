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
import { defaultGeminiModels, seedBriefTopics, warnHotSwapModels } from '@m2office/core';
import { buildDeps, companyView } from './context.js';
import { authenticate, resolveTenant, type AppEnv } from './middleware/tenant.js';
import { attachVoiceRelay } from './voice/relay.js';
import { onUnexpectedError, requestLogger } from './middleware/logging.js';
import { agentsRoute } from './routes/agents.js';
import { jobsRoute } from './routes/jobs.js';
import { runsRoute } from './routes/runs.js';
import { approvalsRoute } from './routes/approvals.js';
import { secretaryRoute } from './routes/secretary.js';
import { ensureMorningBrief, ensureWeeklyBrief } from './secretary/morning.js';
import { authRoute } from './routes/auth.js';
import { notificationsRoute } from './routes/notifications.js';
import { schedulesRoute } from './routes/schedules.js';
import { cardsRoute } from './routes/cards.js';
import { inventoryRoute } from './routes/inventory.js';
import { columnsRoute } from './routes/columns.js';
import { inquiriesRoute } from './routes/inquiries.js';
import { competitorsRoute } from './routes/competitors.js';
import { announcementsRoute } from './routes/announcements.js';
import { contractsRoute } from './routes/contracts.js';
import { reservationsRoute } from './routes/reservations.js';
import { subsidiesRoute } from './routes/subsidies.js';
import { membersRoute } from './routes/members.js';
import { memberCardRoute } from './routes/member-card.js';
import { webReviewRoute } from './routes/web-review.js';
import { inventoryHooksRoute } from './routes/inventory-hooks.js';
import { signageRoute } from './routes/signage.js';
import { signagePlayRoute } from './routes/signage-play.js';
import { signageHooksRoute } from './routes/signage-hooks.js';
import { lineHooksRoute } from './routes/line-hooks.js';
import { unsubscribeRoute } from './routes/unsubscribe.js';
import { columnsPublicRoute } from './routes/columns-public.js';
import { inventoryPublicRoute } from './routes/inventory-public.js';
import { noticesRoute } from './routes/notices.js';
import { adminRoute } from './routes/admin.js';
import { mcpConnectionsRoute } from './routes/mcp-connections.js';
import { meRoute } from './routes/me.js';
import { filesRoute } from './routes/files.js';
import { dashboardRoute } from './routes/dashboard.js';
import { helpRoute } from './routes/help.js';
import { onboardingRoute } from './routes/onboarding.js';
import { extensionsRoute } from './routes/extensions.js';
import { accessRoute, compartmentsRoute, groupsRoute } from './routes/access.js';
import { connectionsRoute, myGoogleRoute, oauthCallbackRoute, returnTo } from './routes/connections.js';
import { myConnectionsRoute } from './routes/connection-auth.js';
import { debugRoute } from './routes/debug.js';
import { hrRoute } from './routes/hr.js';
import { hrSelfRoute } from './routes/hr-self.js';
import { hrPhotosRoute } from './routes/hr-photos.js';

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
// 予約の受け口（第29.13.1節）。予約のシステムがログインの無いまま呼ぶ。URL の鍵から会社を引くため、会社の判定より前に置く
app.route('/v1/hooks/inventory', inventoryHooksRoute(deps));
// 在庫の Web への公開（第29.12.1節）。会社の Web サイトに貼られ、ログインの無い人が読む。URL の鍵から会社を引くため、会社の判定より前に置く
app.route('/v1/public/inventory', inventoryPublicRoute(deps));
// コラムの貼るだけのページ（第32.18.4節）。在庫の公開と同じく、会社の判定とログインより前に置く
app.route('/v1/public/columns', columnsPublicRoute(deps));
// 店頭サイネージの呼び出しの受け口（第31.8.2節）。受付のシステムがログインの無いまま呼ぶ。鍵から会社を引くため、会社の判定より前に置く
app.route('/v1/hooks/signage', signageHooksRoute(deps));
// LINE 公式アカウントの受け口（仕様書 第33.19節）。会社の判定とログインより前に置く
app.route('/v1/hooks/line', lineHooksRoute(deps));
// まとめてのメールの配信の停止（第27.9.1節）。受け取った人がログインなしに開く。URL の鍵から会社を決めるため、会社の判定より前に置く
app.route('/v1/unsubscribe', unsubscribeRoute(deps));
app.use('/v1/*', resolveTenant(deps));
app.route('/v1/auth', authRoute(deps));
// 店頭サイネージの再生のページ（第31.9.1節）。ログインを使わず、画面の鍵で名乗る。会社はアドレスで決まるため、会社の判定の後・ログインの確かめより前に置く
app.route('/v1/signage-play', signagePlayRoute(deps, SERVER_VERSION));
// 会員証のページと LINE の入口（第40.5節）。お客様がログインなしに開く。会社はアドレスで決まり、会員は鍵つきの URL で決まる
app.route('/v1/member-card', memberCardRoute(deps));
app.use('/v1/*', async (c, next) =>
  c.req.path.startsWith('/v1/auth/') || c.req.path.startsWith('/v1/signage-play/') || c.req.path.startsWith('/v1/member-card/') ? next() : authenticate(deps)(c, next));
// デバッグモード（仕様書 第20.4.1節「デバッグモード」）: 本人の呼び出しが失敗したら、パス・番号・理由を記録に残す
if (deps.debug) {
  app.use('/v1/*', async (c, next) => {
    await next();
    const ctx = c.get('ctx');
    if (c.res.status < 400 || !ctx?.user || c.req.path.startsWith('/v1/debug')) return;
    const body = await c.res.clone().text().catch(() => '');
    deps.debug?.add(ctx.tenant.id, ctx.user.id, 'error', `${c.req.method} ${c.req.path} → ${c.res.status}`, { status: c.res.status, body: body.slice(0, 2000) });
  });
}

app.get('/v1/me', async (c) => {
  const ctx = c.get('ctx');
  const auth = c.get('auth');
  // 本人のアバター（第6.5.1.1節）。取り込み直すと URL が変わり、画面が新しい写真を読む
  const photo = await deps.repo.getUserPhoto(ctx.tenant.id, ctx.user.id);
  // Google の写真が無ければ、人事の台帳の顔写真を使う（第30.5.4節）
  const hrPhoto = photo ? null : await deps.hr.service.photoOfUser(ctx.tenant.id, ctx.user.id);
  // 朝のブリーフの定時実行を、まだなら秘書が用意する（仕様書 第9.5.5.1節）。応答は待たせない
  // 週次ブリーフの定時実行も、まだなら秘書が用意する（仕様書 第9.5.5節、ADR-0048）。朝のブリーフの後に（同じ設定を書き換えるため）
  void ensureMorningBrief(deps, ctx.tenant.id, ctx.user.id)
    .catch((err) => deps.log.warn('朝のブリーフを用意できませんでした', { err }))
    .then(() => ensureWeeklyBrief(deps, ctx.tenant.id, ctx.user.id))
    .catch((err) => deps.log.warn('週次ブリーフを用意できませんでした', { err }));
  // 朝のブリーフの関心の分野を、まだなら秘書が役職などから選ぶ（第9.5.5.1.1節、ADR-0047）。応答は待たせない
  void deps.ai.llmFor(ctx.tenant.id)
    .then((llm) => seedBriefTopics(deps.repo, llm, ctx.tenant.id, ctx.user.id))
    .catch((err) => deps.log.warn('朝のブリーフの関心の分野を選べませんでした', { err }));
  return c.json({
    // 画面に出す会社名は、会社情報の正式な会社名（仕様書 第6.6.1節）。入っていなければ申し込みのときの名前
    tenant: { ...ctx.tenant, ...(await companyView(deps, ctx.tenant)) },
    user: ctx.user,
    photo: photo ? `/v1/me/photo?v=${encodeURIComponent(photo.fetchedAt)}`
      : hrPhoto ? `/v1/hr-photos/${encodeURIComponent(hrPhoto.employeeId)}?v=${encodeURIComponent(hrPhoto.photoAt)}` : null,
    // サーバーの版。画面の版と違えば、画面が再読み込みを促す（第6.1.1.1節）
    serverVersion: SERVER_VERSION,
    auth: { method: auth.method },
    csrfToken: auth.method === 'session' ? auth.csrfToken : null,
    // 値の出どころは会社ごと（ADR-0022）
    workspaceSource: deps.connector.sourceFor(ctx.tenant.id),
    // 名刺管理を使えるか（会社の入り切りと利用範囲。仕様書 第27.2節）。使えなければ左ペインに「名刺」を出さない
    cards: !!(await deps.cards.access(ctx.tenant.id, ctx.user.id)),
    // 在庫管理を使えるか（会社の入り切りと利用範囲。仕様書 第29.2節）。使えなければ左ペインに「在庫管理」を出さない
    inventory: !!(await deps.inventory.access(ctx.tenant.id, ctx.user.id)),
    // 店頭サイネージを使えるか（会社の入り切りと利用範囲。仕様書 第31.2節）。使えなければ左ペインに「サイネージ」を出さない
    signage: !!(await deps.signage.access(ctx.tenant.id, ctx.user.id)),
    // Web のコラムを使えるか（会社の入り切りと利用範囲。仕様書 第32.18.1節）。使えなければ左ペインに「コラムの作成」を出さない
    webColumns: !!(await deps.columns.access(ctx.tenant.id, ctx.user.id)),
    // 問い合わせの記録を使えるか（会社の入り切りと利用範囲。仕様書 第33.17節）。使えなければ左ペインに「問い合わせの記録」を出さない
    inquiries: !!(await deps.inquiries.access(ctx.tenant.id, ctx.user.id)),
    // 競合の分析を使えるか（会社の入り切りと利用範囲。仕様書 第36.18節）。使えなければ左ペインに「競合の分析」を出さない
    competitors: !!(await deps.competitors.access(ctx.tenant.id, ctx.user.id)),
    // お知らせの作成を使えるか（会社の入り切りと利用範囲。仕様書 第35.17節）
    announcements: !!(await deps.announcements.access(ctx.tenant.id, ctx.user.id)),
    // Webの分析を使えるか（会社の入り切りと利用範囲。仕様書 第34.18節）
    webReview: !!(await deps.webReview.access(ctx.tenant.id, ctx.user.id)),
    // 契約の管理を使えるか（会社の入り切りと利用範囲。仕様書 第38章）
    contracts: !!(await deps.contracts.access(ctx.tenant.id, ctx.user.id)),
    // 予約を使えるか（会社の入り切りと利用範囲。仕様書 第37章）
    reservations: !!(await deps.reservations.access(ctx.tenant.id, ctx.user.id)),
    // 補助金・助成金の案内を使えるか（会社の入り切りと利用範囲。仕様書 第39章）
    subsidies: !!(await deps.subsidies.access(ctx.tenant.id, ctx.user.id)),
    // 会員とポイントを使えるか（会社の入り切りと利用範囲。仕様書 第40章）
    members: !!(await deps.members.access(ctx.tenant.id, ctx.user.id)),
    // 人事・給与の担当者の画面を使えるか（会社の入り切りと人事区画。仕様書 第30.2節）
    hr: !!(await deps.hr.access(ctx.tenant.id, ctx.user.id)),
    // 本人の「給与・勤怠」を使えるか（台帳に結び付いているか。同じメールアドレスなら自動で結び付く。第30.25節）
    hrSelf: !!(await deps.hr.attendance.selfEmployee(ctx.tenant.id, ctx.user.id)),
    // デバッグモードか（仕様書 第20.4.1節「デバッグモード」）。画面の上の帯に「Debug mode」を出し、記録を見る入口を出す
    debug: !!deps.debug,
  });
});
app.route('/v1/me/google', myGoogleRoute(deps));
// 本人の「給与・勤怠」（人事・給与の段 2。仕様書 第30.25節）。/v1/me より先に置く
app.route('/v1/me/hr', hrSelfRoute(deps));
// 認証の要る会社の接続（Slack など）の、本人の接続と取り消し（仕様書 第6.5.9節・第12.11.6.3節）
app.route('/v1/me/connections', myConnectionsRoute(deps, returnTo));
app.route('/v1/me', meRoute(deps));
app.route('/v1/agents', agentsRoute(deps));
app.route('/v1/jobs', jobsRoute(deps));
app.route('/v1/runs', runsRoute(deps));
app.route('/v1/approvals', approvalsRoute(deps));
app.route('/v1/secretary', secretaryRoute(deps));
app.route('/v1/notifications', notificationsRoute(deps));
app.route('/v1/schedules', schedulesRoute(deps));
app.route('/v1/cards', cardsRoute(deps));
app.route('/v1/inventory', inventoryRoute(deps));
app.route('/v1/columns', columnsRoute(deps));
app.route('/v1/inquiries', inquiriesRoute(deps));
app.route('/v1/competitors', competitorsRoute(deps));
app.route('/v1/announcements', announcementsRoute(deps));
app.route('/v1/contracts', contractsRoute(deps));
app.route('/v1/reservations', reservationsRoute(deps));
app.route('/v1/subsidies', subsidiesRoute(deps));
app.route('/v1/members', membersRoute(deps));
app.route('/v1/web-review', webReviewRoute(deps));
app.route('/v1/signage', signageRoute(deps));
app.route('/v1/hr', hrRoute(deps));
// 従業員の顔写真（社内の全員が見られる。第30.5.4節）
app.route('/v1/hr-photos', hrPhotosRoute(deps));
app.route('/v1/notices', noticesRoute(deps));
app.route('/v1/admin/dashboard', dashboardRoute(deps));
app.route('/v1/admin/extensions', extensionsRoute(deps));
app.route('/v1/admin/groups', groupsRoute(deps));
app.route('/v1/admin/access', accessRoute(deps));
app.route('/v1/admin/compartments', compartmentsRoute(deps));
app.route('/v1/admin/connections/mcp', mcpConnectionsRoute(deps));
app.route('/v1/admin/connections', connectionsRoute(deps));
app.route('/v1/admin', adminRoute(deps));
app.route('/v1/files', filesRoute(deps));
app.route('/v1/help', helpRoute(deps));
app.route('/v1/debug', debugRoute(deps));
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
