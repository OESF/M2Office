/**
 * @file 会員証のページと LINE の入口（仕様書 第40.5節）。お客様がログインなしに開く。会社はアドレスで決まり、会員は鍵つきの URL で決まる。
 *
 * - `GET /v1/member-card/line`・`POST /v1/member-card/line`: LINE の中で開くページ（LIFF）。ID トークンを LINE で確かめて会員証へ移る
 * - `GET /v1/member-card/:key`: 会員証のページ（本人だけが開く鍵つきの URL。QR・ポイント・使える特典）
 *
 * 知らない鍵と、会社が切っているときは、同じ 404 を返す（会員の有無を示さない）。会員証やリンクを自動でどこにも送らない。
 */

import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { CARD_PAGE_CSP, linePageCsp, memberCardUrl, memberQrSvg, renderCardPage, renderLinePage } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

const NOT_FOUND = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>会員証</title></head><body><p>会員証が見つかりません。</p></body></html>';

/** 会員証のページと LINE の入口（ログインなし）。 */
export function memberCardRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.members;
  const headers = (c: { header: (k: string, v: string) => void }, csp: string) => {
    c.header('Content-Security-Policy', csp);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  };
  const companyOf = async (tenantId: string) => {
    const c = (await deps.repo.getTenantSettings(tenantId)).company;
    return c.shortName || c.legalName;
  };

  /** LINE の中で開くページ（LIFF）。会社が LINE の会員証を設定していなければ 404。 */
  app.get('/line', async (c) => {
    const tenant = c.get('tenant');
    const s = await service.settings(tenant.id);
    if (!s.enabled || !s.liffId || !s.lineLoginChannelId) { headers(c, CARD_PAGE_CSP); return c.html(NOT_FOUND, 404); }
    const nonce = randomBytes(16).toString('base64');
    headers(c, linePageCsp(nonce));
    return c.html(renderLinePage(await companyOf(tenant.id), s.liffId, nonce));
  });

  /** LIFF の ID トークンから会員証へ（初めてなら呼び名を受け取って会員にする）。 */
  app.post('/line', async (c) => {
    const tenant = c.get('tenant');
    const b = await c.req.json<{ idToken?: unknown; nickname?: unknown }>().catch(() => ({} as { idToken?: unknown; nickname?: unknown }));
    const r = await service.lineSignIn(tenant.id, typeof b.idToken === 'string' ? b.idToken.slice(0, 4000) : '', typeof b.nickname === 'string' ? b.nickname : '');
    c.header('Cache-Control', 'no-store');
    if ('error' in r) return c.json(r, 400);
    if ('needsNickname' in r) return c.json(r);
    return c.json({ cardUrl: memberCardUrl(tenantOrigin(c.req.header('origin'), c.req.header('host')), r.cardKey) });
  });

  /** 会員証のページ。 */
  app.get('/:key', async (c) => {
    const tenant = c.get('tenant');
    const s = await service.settings(tenant.id);
    const v = s.enabled ? await service.byCard(tenant.id, c.req.param('key')) : null;
    headers(c, CARD_PAGE_CSP);
    if (!v) return c.html(NOT_FOUND, 404);
    const svg = await memberQrSvg(memberCardUrl(tenantOrigin(c.req.header('origin'), c.req.header('host')), v.cardKey));
    return c.html(renderCardPage(await companyOf(tenant.id), v, svg, s.expiryDays));
  });

  return app;
}
