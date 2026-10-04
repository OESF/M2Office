/**
 * @file お知らせの作成（内蔵の拡張）の API。一覧・下書き（1 行の欄）・1 件・直す・削除・承認の前の確かめ・承認へ進む・予約の取り消し・
 * 写して使う文・店頭の画面の 1 枚の見本・LINE の友だちの数と残り。
 *
 * 会社がお知らせの作成を切っているときと、利用範囲の外の人には、どの口も使わせない。**出すのは承認の後だけ**（付属の業務「お知らせを出す」）。
 *
 * @see 仕様書 第35.17節 段 1 の実装の決まり
 */

import { Hono, type Context } from 'hono';
import { AI_NOT_CONFIGURED_MESSAGE, aiAvailable, periodText, renderScreenCard, type AnnouncementViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * お知らせの作成の API（仕様書 第35章）。
 *
 * @remarks 監査ログは処理（AnnouncementService）が残す
 */
export function announcementsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.announcements;
  const who = (c: Context<AppEnv>): AnnouncementViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // お知らせの作成を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.announcements.access(tenant.id, user.id))) {
      return c.json({ error: 'お知らせの作成は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 一覧（新しい順）。 */
  app.get('/', async (c) => c.json({ items: await service.list(who(c)) }));

  /** LINE の友だちの数と今月の残り（つないでいなければ `null`）。 */
  app.get('/line/status', async (c) => c.json({ line: await service.lineStatus(c.get('ctx').tenant.id) }));

  /** 1 行の欄に書いた頼みから下書きを作る（`text`）。 */
  app.post('/', async (c) => {
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({} as { text?: unknown }));
    const r = await service.draft(who(c), typeof body.text === 'string' ? body.text : '');
    if ('error' in r) return c.json({ error: r.error }, 400);
    return c.json(r, 201);
  });

  /** 1 件と、出し先ごとの結果・使える出し先。 */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const d = ID.test(id) ? await service.detail(who(c), id) : null;
    return d ? c.json(d) : c.json({ error: 'お知らせが見つかりません' }, 404);
  });

  /** 下書きを直す（題名・本文・期間・予約・出し先・出し先ごとの文）。 */
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'お知らせが見つかりません' }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const problem = await service.update(who(c), id, body as Parameters<typeof service.update>[2]);
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 400);
    return c.json({ ok: true });
  });

  /** 下書き・取り消し・終わったお知らせを削除する。 */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const problem = ID.test(id) ? await service.remove(who(c), id) : 'お知らせが見つかりません';
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 409);
    return c.json({ ok: true });
  });

  /** 承認の前の確かめ（出せない理由・LINE の送る数と残り・流す画面・Web の出し方）。 */
  app.get('/:id/preview', async (c) => {
    const id = c.req.param('id');
    const p = ID.test(id) ? await service.preview(who(c), id) : null;
    return p ? c.json(p) : c.json({ error: 'お知らせが見つかりません' }, 404);
  });

  /** 承認へ進める（付属の業務「お知らせを出す」を始める。管理者か承認者が承認すると出る）。 */
  app.post('/:id/submit', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'お知らせが見つかりません' }, 404);
    if (!aiAvailable(await deps.ai.llmFor(c.get('ctx').tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const r = await service.submit(who(c), id);
    if ('error' in r) return c.json({ error: r.error }, r.error.includes('見つかりません') ? 404 : 400);
    return c.json(r, 201);
  });

  /** 予約を取り消す（出す前だけ）。 */
  app.post('/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const problem = ID.test(id) ? await service.cancel(who(c), id) : 'お知らせが見つかりません';
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 409);
    return c.json({ ok: true });
  });

  /** メールの宛先（名刺管理の連絡先の名前とアドレス）。 */
  app.get('/:id/recipients', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: 'お知らせが見つかりません' }, 404);
    return c.json({ recipients: await service.mailRecipients(who(c), id) });
  });

  /** WordPress が無い会社が写して使う文（HTML とテキスト）。 */
  app.get('/:id/copy', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.copy(who(c), id) : null;
    return r ? c.json(r) : c.json({ error: 'お知らせが見つかりません' }, 404);
  });

  /** 店頭の画面の 1 枚の見本（PNG）。 */
  app.get('/:id/screen.png', async (c) => {
    const id = c.req.param('id');
    const d = ID.test(id) ? await service.detail(who(c), id) : null;
    if (!d) return c.json({ error: 'お知らせが見つかりません' }, 404);
    const settings = await deps.repo.getTenantSettings(c.get('ctx').tenant.id);
    const a = d.announcement;
    const png = renderScreenCard({
      headline: a.texts.signage.headline || a.title, period: a.texts.signage.period || periodText(a.startDate, a.endDate), note: a.texts.signage.note,
      company: settings.company.shortName || settings.company.legalName,
    });
    return new Response(Buffer.from(png), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
  });

  return app;
}
