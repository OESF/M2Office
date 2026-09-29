/**
 * @file 予約の受け口（通知を受け取る URL。仕様書 第29.13.1節）。予約のシステムが、ログインの無いまま呼ぶ。
 *
 * 会社の判定とログインより前に置き、URL の鍵（推測されにくい値。M2Office はハッシュだけを持つ）から会社と受け口を引く。
 * 本文は 64 KB まで。中身はデータとして扱い、指示として読まない（不変則 I-6）。氏名などは台帳に入れない（第29.17節）。
 * 相手には受け取れたかどうかだけを返し、台帳の中身は返さない。
 */

import { Hono } from 'hono';
import { BOOKING_PAYLOAD_MAX_BYTES } from '@m2office/core';
import type { AppDeps } from '../context.js';

/** 鍵の形（base64url の 32 字）。形の違う鍵は引かずに断る。 */
const KEY = /^[A-Za-z0-9_-]{32}$/;

/**
 * 予約の受け口の API（`POST /v1/hooks/inventory/:key`）。
 *
 * @remarks 断るときも理由の細部は返さない（鍵の有無を探られないため、知らない鍵と止めた受け口は同じ 404）
 */
export function inventoryHooksRoute(deps: AppDeps) {
  const app = new Hono();

  app.post('/:key', async (c) => {
    const key = c.req.param('key');
    if (!KEY.test(key)) return c.json({ ok: false }, 404);
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > BOOKING_PAYLOAD_MAX_BYTES) return c.json({ ok: false, error: 'too large' }, 413);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return c.json({ ok: false, error: 'json required' }, 400);
    }
    try {
      const res = await deps.inventory.bookings.ingest(key, payload);
      if (res.ok) return c.json({ ok: true });
      if (res.reason === 'unknown' || res.reason === 'stopped' || res.reason === 'disabled') return c.json({ ok: false }, 404);
      return c.json({ ok: false, error: 'unreadable' }, 422);
    } catch (err) {
      deps.log.warn('予約の通知を受け取れませんでした', { error: String(err) });
      return c.json({ ok: false }, 500);
    }
  });

  return app;
}
