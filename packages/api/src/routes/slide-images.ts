/**
 * @file スライドの画像の使い捨ての道（仕様書 第9.4.2節「段 2」、Q-263）。Google スライドが画像を貼るときに 1 度だけ読む。
 *
 * 会社の判定とログインより前に置き、URL の鍵（32 バイトの乱数）から 5 分以内の画像を 1 枚だけ返す。
 * 鍵が違う・切れたものは区別せずに 404 にする。画像は貼り終えたらすぐ消える。
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';

/**
 * スライドの画像の公開の道（`/v1/public/slide-images`）。
 */
export function slideImagesPublicRoute(deps: AppDeps) {
  const app = new Hono();
  app.get('/:token', async (c) => {
    const got = await deps.slideImages.take(c.req.param('token')).catch(() => null);
    if (!got) return c.json({ error: 'not found' }, 404);
    return c.body(got.bytes as unknown as ArrayBuffer, 200, { 'content-type': got.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  });
  return app;
}
