/**
 * @file 在庫の Web への公開のページとデータ（仕様書 第29.12.1節）。会社の Web サイトに貼られ、ログインの無い人が読む。
 *
 * 会社の判定とログインより前に置き、URL の鍵から会社を引く。返すのは作り直して置いた中身だけで、在庫の表は読まない。
 * ページは他のサイトの iframe に入れてよく、スクリプトを持たず外のものを読まない。データはどのサイトからも読める。
 * 鍵が違う・止めた・公開を切った会社は、区別せずに同じ 404 にする（鍵の有無を探られないため）。
 */

import { Hono } from 'hono';
import { renderPublicPage } from '@m2office/core';
import type { AppDeps } from '../context.js';

/** ページの見出し。スクリプトと外の読み込みを許さず、どのサイトの iframe にも入れてよい。 */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *; base-uri 'none'; form-action 'none'";

/**
 * 公開のページ（`GET /v1/public/inventory/:key`）とデータ（`GET /v1/public/inventory/:key.json`）。
 *
 * @remarks 毎回、置いてある最新の中身を返す（`no-cache`）。作り直しは在庫が変わったときに行う
 */
export function inventoryPublicRoute(deps: AppDeps) {
  const app = new Hono();

  app.get('/:key', async (c) => {
    const raw = c.req.param('key');
    const json = raw.endsWith('.json');
    const key = json ? raw.slice(0, -'.json'.length) : raw;
    let snapshot = null;
    try {
      snapshot = await deps.inventory.publisher.byKey(key);
    } catch (err) {
      deps.log.warn('在庫の公開を読めませんでした', { error: String(err) });
      return json ? c.json({ error: 'unavailable' }, 500) : c.html(renderPublicPage(null), 500);
    }
    c.header('Cache-Control', 'no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (json) {
      // 公開のデータは、どのサイトの画面からも読める（ログインの情報は使わない）
      c.header('Access-Control-Allow-Origin', '*');
      return snapshot ? c.json(snapshot) : c.json({ error: 'not found' }, 404);
    }
    c.header('Content-Security-Policy', PAGE_CSP);
    return c.html(renderPublicPage(snapshot), snapshot ? 200 : 404);
  });

  return app;
}
