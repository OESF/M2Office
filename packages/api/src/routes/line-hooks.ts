/**
 * @file LINE 公式アカウントの受け口（Webhook の URL。仕様書 第33.6.2節・第33.19節）。LINE のサーバーが、ログインの無いまま呼ぶ。
 *
 * 会社の判定とログインより前に置き、URL の鍵（M2Office はハッシュだけを持つ）から会社を引き、**その会社のチャネルのシークレットで
 * 署名（`X-Line-Signature`）を確かめる**。合わないものは捨てる。確かめたらすぐに 200 を返し、問い合わせへの取り込みは後ろで行う
 * （LINE は応答の遅い受け口を、届かなかったとみなして送り直すため。送り直しは出来事の ID で 2 度残さない）。
 * 本文は 1 MB まで。中身はデータとして扱い、指示として読まない（不変則 I-6）。記録には本文を残さない。
 */

import { Hono } from 'hono';
import type { AppDeps } from '../context.js';

/** 鍵の形（base64url の 32 字）。形の違う鍵は引かずに断る。 */
const KEY = /^[A-Za-z0-9_-]{32}$/;
/** 本文の大きさの上限。 */
const MAX_BYTES = 1024 * 1024;

/**
 * LINE の受け口の API（`POST /v1/hooks/line/:key`）。
 *
 * @remarks 知らない鍵と、問い合わせの記録や LINE を切っている会社は同じ 404。署名が違えば 401
 */
export function lineHooksRoute(deps: AppDeps) {
  const app = new Hono();

  app.post('/:key', async (c) => {
    const key = c.req.param('key');
    if (!KEY.test(key)) return c.json({ ok: false }, 404);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > MAX_BYTES) return c.json({ ok: false }, 413);
    const verdict = await deps.inquiries.service.verifyLineHook(key, raw, c.req.header('x-line-signature') ?? '').catch((err: unknown) => {
      deps.log.warn('LINE の受け口で確かめられませんでした', { error: String(err) });
      return null;
    });
    if (!verdict) return c.json({ ok: false }, 500);
    if ('reason' in verdict) return c.json({ ok: false }, verdict.reason === 'signature' ? 401 : 404);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ ok: false }, 400);
    }
    // すぐに返し、取り込みは後ろで行う（失敗しても LINE には 200 を返している。記録に残す）
    void deps.inquiries.service.processLine(verdict.tenantId, payload)
      .then((r) => { if (r.created + r.appended > 0) deps.log.info('LINE のメッセージを問い合わせにしました', { tenantId: verdict.tenantId, ...r }); })
      .catch((err: unknown) => deps.log.warn('LINE のメッセージを取り込めませんでした', { tenantId: verdict.tenantId, error: String(err) }));
    return c.json({ ok: true });
  });

  return app;
}
