/**
 * @file コラムの貼るだけのページ（仕様書 第32.10節・第32.18.4節）。WordPress の無い会社の Web サイトに貼られ、ログインの無い人が読む。
 *
 * 会社の判定とログインより前に置き、URL の鍵から会社を引く。出すのは承認済みで公開の日時を過ぎたコラムだけ。
 * ページはスクリプトを持たず外のものを読まず、どのサイトの iframe にも入れてよい（在庫の公開と同じ形。第29.12.1節）。
 * 鍵が違う・止めた・コラムの作成を切った会社は、区別せずに同じ 404 にする（鍵の有無を探られないため）。
 */

import { Hono } from 'hono';
import type { PastePageColumn } from '@m2office/core';
import type { AppDeps } from '../context.js';

/** ページの見出し。スクリプトと外の読み込みを許さない（カバー画像は同じ場所から）。どのサイトの iframe にも入れてよい。 */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'none'";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const day = (iso: string) => new Date(iso).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' });

const STYLE = `body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:16px;color:#1a1a1a;background:#fff;line-height:1.8}
main{max-width:760px;margin:0 auto}a{color:#0f766e}h1{font-size:1.5em;line-height:1.4}h2{font-size:1.2em}
.list{list-style:none;padding:0}.list li{border-bottom:1px solid #e5e7eb;padding:12px 0}.date{color:#6b7280;font-size:.85em}
img{max-width:100%;height:auto;border-radius:6px}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function listPage(key: string, company: string, columns: PastePageColumn[]): string {
  const items = columns.map((c) => `<li><a href="./${encodeURIComponent(key)}/${encodeURIComponent(c.id)}">${esc(c.title)}</a>`
    + `<div class="date">${esc(day(c.date))}</div><div>${esc(c.description)}</div></li>`).join('');
  return page(`${company} のコラム`, `<h1>${esc(company)} のコラム</h1>${columns.length ? `<ul class="list">${items}</ul>` : '<p>まだコラムはありません。</p>'}`);
}

function articlePage(key: string, company: string, c: PastePageColumn): string {
  const cover = c.hasCover ? `<img src="./${encodeURIComponent(c.id)}/cover.png" alt="">` : '';
  return page(`${c.title} | ${company}`, `<p><a href="../${encodeURIComponent(key)}">${esc(company)} のコラムの一覧</a></p>`
    + `<article><h1>${esc(c.title)}</h1><div class="date">${esc(day(c.date))}</div>${cover}${c.html}</article>`);
}

function rss(base: string, company: string, columns: PastePageColumn[]): string {
  const items = columns.map((c) => `<item><title>${esc(c.title)}</title><link>${esc(`${base}/${c.id}`)}</link><guid>${esc(`${base}/${c.id}`)}</guid>`
    + `<pubDate>${new Date(c.date).toUTCString()}</pubDate><description>${esc(c.description)}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(company)} のコラム</title><link>${esc(base)}</link>`
    + `<description>${esc(company)} のコラム</description>${items}</channel></rss>`;
}

/**
 * 貼るだけのページ（`GET /v1/public/columns/:key`）・記事（`/:key/:id`）・データ（`/:key.json`）・RSS（`/:key.rss`）・カバー（`/:key/:id/cover.png`）。
 *
 * @remarks 毎回、いまの承認済みのコラムから作る（`no-cache`）
 */
export function columnsPublicRoute(deps: AppDeps) {
  const app = new Hono();
  const common = (c: { header(k: string, v: string): void }) => {
    c.header('Cache-Control', 'no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  };
  const notFound = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>見つかりません</title></head><body><p>ページが見つかりません。</p></body></html>';

  app.get('/:key', async (c) => {
    const raw = c.req.param('key');
    const kind = raw.endsWith('.json') ? 'json' : raw.endsWith('.rss') ? 'rss' : 'html';
    const key = kind === 'html' ? raw : raw.slice(0, -(kind === 'json' ? 5 : 4));
    const data = await deps.columns.planner?.pageByKey(key).catch((err: unknown) => { deps.log.warn('コラムの貼るだけのページを読めませんでした', { error: String(err) }); return null; }) ?? null;
    common(c);
    if (kind === 'json') {
      c.header('Access-Control-Allow-Origin', '*');
      return data ? c.json({ company: data.company, columns: data.columns.map(({ hasCover: _h, ...x }) => x) }) : c.json({ error: 'not found' }, 404);
    }
    if (kind === 'rss') {
      if (!data) return c.text('not found', 404);
      const base = new URL(c.req.url).toString().replace(/\.rss$/, '');
      c.header('Content-Type', 'application/rss+xml; charset=utf-8');
      return c.body(rss(base, data.company, data.columns));
    }
    c.header('Content-Security-Policy', PAGE_CSP);
    return data ? c.html(listPage(key, data.company, data.columns)) : c.html(notFound, 404);
  });

  app.get('/:key/:id', async (c) => {
    const data = await deps.columns.planner?.pageByKey(c.req.param('key')).catch(() => null) ?? null;
    const col = data?.columns.find((x) => x.id === c.req.param('id'));
    common(c);
    c.header('Content-Security-Policy', PAGE_CSP);
    return data && col ? c.html(articlePage(c.req.param('key'), data.company, col)) : c.html(notFound, 404);
  });

  app.get('/:key/:id/cover.png', async (c) => {
    const bytes = await deps.columns.planner?.pageCover(c.req.param('key'), c.req.param('id')).catch(() => null) ?? null;
    common(c);
    if (!bytes) return c.text('not found', 404);
    c.header('Content-Type', 'image/png');
    return c.body(Buffer.from(bytes));
  });

  return app;
}
