/**
 * @file 外部のアプリの機能の道（仕様書 第13.4.1節、ADR-0090）。アプリが鍵で、画面と同じ `/v1` の道を呼ぶ。
 *
 * - `GET /v1/company/profile` 会社の基本情報を読む（`company.profile`）
 * - `GET /v1/inventory/catalog` 商品の一覧を読む（`inventory.catalog`。第29.20.1節）
 * - `POST /v1/inventory/sales-events` 販売を知らせる（`inventory.sales`。第29.20.1節）
 *
 * 鍵・会社・機能・回数の上限は認証の段（`authenticate`）で確かめ済み。ここは機能の業務だけを行う。
 * 画面のログインで呼ばれたときは 404（外部のアプリの鍵で呼ぶ道のため）。送られてきた中身はデータとして扱い、指示として読まない（不変則 I-6）。
 */

import { Hono, type Context } from 'hono';
import { SALES_PAYLOAD_MAX_BYTES, type HookResponse, type SalesItemQuery } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const NOT_FOUND = { error: 'not found' };

/** カンマ区切りの絞り込み（同じ名前を重ねても読む）。 */
function listOf(c: Context, name: string): string[] | undefined {
  const all = c.req.queries(name);
  if (!all) return undefined;
  return all.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

/**
 * 外部のアプリの機能の道。
 *
 * @remarks テナント境界: 認証の段で、鍵の会社と呼んだ名前の会社が合うことを確かめてある。ここは `ctx.tenant` の中だけを読む（不変則 I-2）
 */
export function appFunctionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  /** 外部のアプリの鍵で呼ばれたときだけ通す。 */
  const appOf = (c: Context<AppEnv>) => {
    const auth = c.get('auth');
    return auth?.method === 'app' ? auth : null;
  };
  /** 在庫管理を入れている会社か（切っていれば、会社が止まっているときと同じ 404）。 */
  const inventoryOn = async (tenantId: string) => (await deps.repo.getTenantSettings(tenantId)).inventory.enabled;
  const reply = <T>(c: Context<AppEnv>, r: HookResponse<T>) => {
    if (r.status === 200) return c.json(r.body as object, 200);
    return c.json(r.body, r.status, 'retryAfter' in r && r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
  };

  /**
   * 会社の基本情報（第6.6.1節の会社情報のうち、外に出してよいもの）。
   *
   * @remarks 端数処理・締め日・支払サイトなどの経理の設定と、ロゴのファイルは返さない
   */
  app.get('/company/profile', async (c) => {
    if (!appOf(c)) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    const co = (await deps.repo.getTenantSettings(tenant.id)).company;
    return c.json({
      legalName: co.legalName || tenant.name, shortName: co.shortName || null, postalCode: co.postalCode || null, address: co.address || null,
      phone: co.phone || null, website: co.website || null, invoiceRegistrationNumber: co.invoiceRegistrationNumber || null,
      fiscalYearStartMonth: co.fiscalYearStartMonth, businessDays: [...co.businessDays].sort(), holidaysClosed: co.holidaysClosed,
    });
  });

  /** 商品の一覧（承認した範囲だけ。`updatedSince`・`categories`・`ids`・`codes`・`barcodes`・`limit`・`cursor`）。 */
  app.get('/inventory/catalog', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await inventoryOn(tenant.id))) return c.json(NOT_FOUND, 404);
    const limit = c.req.query('limit');
    const q: SalesItemQuery = {
      ...(c.req.query('updatedSince') !== undefined ? { updatedSince: c.req.query('updatedSince')! } : {}),
      ...(listOf(c, 'categories') ? { categories: listOf(c, 'categories')! } : {}),
      ...(listOf(c, 'ids') ? { ids: listOf(c, 'ids')! } : {}),
      ...(listOf(c, 'codes') ? { codes: listOf(c, 'codes')! } : {}),
      ...(listOf(c, 'barcodes') ? { barcodes: listOf(c, 'barcodes')! } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(c.req.query('cursor') !== undefined ? { cursor: c.req.query('cursor')! } : {}),
    };
    try {
      return reply(c, await deps.inventory.sales.listItems(tenant.id, a.appId, q));
    } catch (err) {
      deps.log.warn('外部のアプリに商品の一覧を返せませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  /** 販売の通知（注文・販売・取り消し・返品）。同じ `eventId` の送り直しには、前と同じ答えを返す。 */
  app.post('/inventory/sales-events', async (c) => {
    const a = appOf(c);
    if (!a) return c.json(NOT_FOUND, 404);
    const { tenant } = c.get('ctx');
    if (!(await inventoryOn(tenant.id))) return c.json(NOT_FOUND, 404);
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
      return reply(c, await deps.inventory.sales.postEvent(tenant.id, a.appId, body));
    } catch (err) {
      deps.log.warn('販売の通知を受け取れませんでした', { error: String(err) });
      return c.json({ error: 'internal error' }, 500);
    }
  });

  return app;
}
