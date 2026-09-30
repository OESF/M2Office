/**
 * @file 店頭サイネージの呼び出しの受け口（仕様書 第31.8.2節）。受付・順番待ち・注文などのシステムが、ログインの無いまま呼ぶ。
 *
 * 会社の判定とログインより前に置き、鍵から会社と受け口を引く（予約の受け口と同じ）。鍵は URL（`/v1/hooks/signage/{鍵}`）か
 * `Authorization: Bearer {鍵}`（`/v1/hooks/signage`）で受ける。記録ではパスの鍵を伏せ、本文は残さない。
 * 出せるのは文字と登録した割り込みの素材だけ。中身はデータとして扱い、指示として読まない（不変則 I-6）。
 */

import { Hono, type Context } from 'hono';
import { hashSecret } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { isOperational } from '../middleware/tenant.js';

/** 本文の大きさの上限。 */
const MAX_BODY = 4 * 1024;
/** 鍵の形（24 バイトの乱数を base64url にした 32 字）。 */
const KEY = /^[A-Za-z0-9_-]{32}$/;
/** 知らない鍵などの答え（鍵の有無を探らせないため、どれも同じにする）。 */
const NOT_FOUND = { error: 'not found' };

/**
 * 呼び出しの受け口（`/v1/hooks/signage`）。
 *
 * @remarks テナント境界: 鍵のハッシュから会社と受け口を 1 行だけ返す関数で引き、その後は会社の中だけを読む（不変則 I-2）
 */
export function signageHooksRoute(deps: AppDeps) {
  const app = new Hono();
  const { interrupts } = deps.signage;

  const receive = async (c: Context, key: string | null) => {
    if (!key || !KEY.test(key)) return c.json(NOT_FOUND, 404);
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    const json = type.startsWith('application/json');
    const form = type.startsWith('application/x-www-form-urlencoded');
    if ((!json && !form) || (/charset=/.test(type) && !/charset=utf-8/.test(type))) return c.json({ error: 'unsupported media type' }, 415);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return c.json({ error: 'payload too large' }, 413);
    const src = await deps.signage.service.deps.store.findSourceByHash(hashSecret(key));
    if (!src || src.status !== 'active') return c.json(NOT_FOUND, 404);
    // 会社の判定より前に置くため、会社の状態（停止・緊急停止・解約）とサイネージの入り切りをここで確かめる（第23.8.6節）
    const tenant = await deps.repo.findTenantById(src.tenantId);
    if (!tenant || !isOperational(tenant) || !(await deps.repo.getTenantSettings(src.tenantId)).signage.enabled) return c.json(NOT_FOUND, 404);
    if (!interrupts.allowHit(src.id)) return c.json({ error: 'too many requests' }, 429, { 'retry-after': '60' });
    let payload: unknown;
    if (json) {
      try { payload = JSON.parse(raw); } catch { return c.json({ error: 'unreadable' }, 422); }
    } else {
      payload = Object.fromEntries(new URLSearchParams(raw));
    }
    const r = await interrupts.ingest(src.tenantId, src.id, payload);
    if ('ok' in r) return c.json({ ok: true });
    return r.status === 429 ? c.json({ error: 'too many requests' }, 429, { 'retry-after': '10' }) : c.json(r.status === 404 ? NOT_FOUND : { error: r.error }, r.status);
  };

  /** 見出しで鍵を送る呼び方（`Authorization: Bearer {鍵}`）。相手のシステムが見出しを付けられるなら、こちらを勧める。 */
  app.post('/', (c) => receive(c, /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? null));
  /** URL に鍵を入れる呼び方。 */
  app.post('/:key', (c) => receive(c, c.req.param('key')));
  // POST 以外は受けない（URL の問い合わせに文を載せる呼び方は、文が記録に残るため受けない）
  app.all('*', (c) => c.json({ error: 'method not allowed' }, 405));
  return app;
}
