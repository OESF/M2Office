/**
 * @file デバッグモードの記録を見る API（仕様書 第20.4.1節「デバッグモード」）。`M2O_DEBUG=true` のときだけ答え、それ以外は 404。
 *
 * 見られるのは本人の記録だけ。管理者でもほかの人の記録は見られない。
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * デバッグモードの記録の API（`/v1/debug`）。
 *
 * @remarks テナント境界: 本人（会社と利用者の組）の記録だけを返す（不変則 I-2）
 */
export function debugRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => (deps.debug ? next() : c.json({ error: 'デバッグモードではありません' }, 404)));

  /** 本人の記録（新しい順）。`after` を渡すと、それより後に足したものだけ。 */
  app.get('/events', (c) => {
    const ctx = c.get('ctx');
    return c.json({ events: deps.debug!.list(ctx.tenant.id, ctx.user.id, c.req.query('after') || undefined) });
  });

  /** 本人の記録を消す。 */
  app.delete('/events', (c) => {
    const ctx = c.get('ctx');
    deps.debug!.clear(ctx.tenant.id, ctx.user.id);
    return c.json({ ok: true });
  });

  return app;
}
