/**
 * @file 販売管理とのつなぎの口（仕様書 第29.20.1節、ADR-0087）。販売管理（レジ・POS・EC）が、ログインの無いまま鍵で呼ぶ。
 *
 * - `GET /v1/hooks/inventory/sales/items` 商品の一覧（承認した範囲だけ）
 * - `POST /v1/hooks/inventory/sales/events` 販売の通知（注文・販売・取り消し・返品）
 *
 * 会社の判定とログインより前に置き、`Authorization: Bearer <鍵>` から会社とつなぎを引く（鍵はハッシュだけを持つ）。
 * 鍵が違う・つなぎを止めた・会社が止まっている・在庫管理を切ったは、どれも同じ 404（理由を分けない）。
 * 本文は 64 KB まで。中身はデータとして扱い、指示として読まない（不変則 I-6）。本文は残さない。
 */

import { Hono, type Context } from 'hono';
import { SALES_PAYLOAD_MAX_BYTES, type HookResponse, type SalesItemQuery } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { isOperational } from '../middleware/tenant.js';

const NOT_FOUND = { error: 'not found' };

/** カンマ区切りの絞り込み（同じ名前を重ねても読む）。 */
function list(c: Context, name: string): string[] | undefined {
  const all = c.req.queries(name);
  if (!all) return undefined;
  return all.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

/**
 * 販売管理とのつなぎの口。
 *
 * @remarks テナント境界: 鍵のハッシュから会社とつなぎを 1 行だけ返す関数で引き、その後は会社の中だけを読む（不変則 I-2）
 */
export function inventorySalesHooksRoute(deps: AppDeps) {
  const app = new Hono();
  const sales = deps.inventory.sales;

  /** 鍵を確かめ、会社の状態と在庫管理の入り切りを見る。だめなら答えを返す。 */
  const gate = async (c: Context): Promise<{ tenantId: string; linkId: string } | Response> => {
    c.header('Cache-Control', 'no-store');
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const hit = m ? await sales.authenticate(m[1]!) : null;
    if (!hit) return c.json(NOT_FOUND, 404);
    const tenant = await deps.repo.findTenantById(hit.tenantId);
    if (!tenant || !isOperational(tenant) || !(await deps.repo.getTenantSettings(hit.tenantId)).inventory.enabled) return c.json(NOT_FOUND, 404);
    if (!sales.allowHit(hit.linkId)) return c.json({ error: 'too many requests' }, 429, { 'Retry-After': '60' });
    return hit;
  };

  const reply = <T>(c: Context, r: HookResponse<T>) => {
    if (r.status === 200) return c.json(r.body as object, 200);
    return c.json(r.body, r.status, 'retryAfter' in r && r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
  };

  /** 商品の一覧（承認した範囲だけ。`updatedSince`・`categories`・`ids`・`codes`・`barcodes`・`limit`・`cursor`）。 */
  app.get('/items', async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const limit = c.req.query('limit');
    const q: SalesItemQuery = {
      ...(c.req.query('updatedSince') !== undefined ? { updatedSince: c.req.query('updatedSince')! } : {}),
      ...(list(c, 'categories') ? { categories: list(c, 'categories')! } : {}),
      ...(list(c, 'ids') ? { ids: list(c, 'ids')! } : {}),
      ...(list(c, 'codes') ? { codes: list(c, 'codes')! } : {}),
      ...(list(c, 'barcodes') ? { barcodes: list(c, 'barcodes')! } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(c.req.query('cursor') !== undefined ? { cursor: c.req.query('cursor')! } : {}),
    };
    try {
      return reply(c, await sales.listItems(g.tenantId, g.linkId, q));
    } catch (err) {
      deps.log.warn('販売管理に商品の一覧を返せませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  /** 販売の通知（注文・販売・取り消し・返品）。同じ `eventId` の送り直しには、前と同じ答えを返す。 */
  app.post('/events', async (c) => {
    const g = await gate(c);
    if (g instanceof Response) return g;
    const type = (c.req.header('content-type') ?? '').toLowerCase();
    if (!type.startsWith('application/json') || (/charset=/.test(type) && !/charset=utf-8/.test(type))) return c.json({ error: 'JSON（UTF-8）で送ってください' }, 415);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > SALES_PAYLOAD_MAX_BYTES) return c.json({ error: '本文は 64 KB までです' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'JSON として読めません', field: '' }, 400);
    }
    try {
      return reply(c, await sales.postEvent(g.tenantId, g.linkId, body));
    } catch (err) {
      deps.log.warn('販売の通知を受け取れませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  return app;
}
