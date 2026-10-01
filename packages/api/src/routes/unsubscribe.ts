/**
 * @file まとめてのメールの配信の停止の受け口（仕様書 第27.9.1節、ADR-0058）。ログインなしに開ける。
 *
 * 宣伝のメールの末尾と見出し（`List-Unsubscribe`）に入れた URL で受ける。URL の鍵は会社とメールアドレスを暗号化したもので、
 * 会社はこの鍵から決まる（アドレスで会社を決めない）。開くと「配信を停止する」のボタンだけの画面を出し、押すと止める。
 * メールのアプリが押すだけで止める形（`List-Unsubscribe-Post`）は、同じ URL への POST で受ける。
 * 読めない鍵はすべて同じ「見つかりません」で断る（会社やアドレスの有無を示さない）。
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';

/** 画面の HTML。文字は固定の文だけを入れる（外から来た値を入れない）。 */
const page = (title: string, body: string) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.7;color:#222}
button{font-size:1rem;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #888;background:#fff;cursor:pointer}</style>
</head><body><h1 style="font-size:1.3rem">${title}</h1>${body}</body></html>`;

const NOT_FOUND = page('ページが見つかりません', '<p>この URL は使えません。</p>');

/**
 * 配信の停止の受け口。会社の判定とログインより前に置く（鍵から会社を決めるため）。
 *
 * @remarks 危険度: 外から誰でも呼べるが、できるのは鍵に入ったアドレスの配信を止めることだけ（再開はできない）
 */
export function unsubscribeRoute(deps: AppDeps) {
  const app = new Hono();

  const read = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{16,2048}$/.test(token)) return null;
    const t = deps.cards.bulk.readUnsubscribeToken(token);
    if (!t) return null;
    return (await deps.repo.findTenantById(t.tenantId)) ? t : null;
  };

  app.get('/:token', async (c) => {
    const t = await read(c.req.param('token'));
    if (!t) return c.html(NOT_FOUND, 404);
    return c.html(page('配信の停止', '<p>このメールアドレスへのご案内のメールを停止します。</p><form method="post"><button type="submit">配信を停止する</button></form>'));
  });

  app.post('/:token', async (c) => {
    const t = await read(c.req.param('token'));
    if (!t) return c.html(NOT_FOUND, 404);
    await deps.cards.bulk.optOut(t.tenantId, t.email, 'url');
    return c.html(page('配信を停止しました', '<p>今後、このメールアドレスにご案内のメールはお送りしません。</p>'));
  });

  return app;
}
