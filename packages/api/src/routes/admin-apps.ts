/**
 * @file 外部のアプリの管理者の API（仕様書 第13.4.1節、ADR-0090）。登録・名前・承認・鍵の出し直し・停止・削除と、
 * 機能「商品の一覧を読む」の見本。管理者だけ。どれも監査ログに残す（`app.*`）。鍵は登録と出し直しの答えでだけ返す。
 */

import { Hono } from 'hono';
import { catalogScopeOf } from '@m2office/core';
import { APP_FUNCTIONS, EXTERNAL_APP_MAX, type AppFunctionId, type AppSettings, type RiskLevel } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import { requireRole, type AppEnv } from '../middleware/tenant.js';

/** 承認の本文（機能と機能ごとの設定）を整える。知らない項目は捨てる。 */
function approvalOf(body: unknown): { functions: AppFunctionId[]; settings: AppSettings } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const known = new Set(APP_FUNCTIONS.map((f) => f.id));
  const functions = Array.isArray(b['functions']) ? b['functions'].filter((x): x is AppFunctionId => typeof x === 'string' && known.has(x as AppFunctionId)) : [];
  const s = (b['settings'] && typeof b['settings'] === 'object' ? b['settings'] : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : []);
  const settings: AppSettings = {};
  if (s['catalog']) settings.catalog = catalogScopeOf(s['catalog']);
  const n = obj(s['notices']);
  if (n) settings.notices = { all: n['all'] === true, groupIds: strs(n['groupIds']) };
  const r = obj(s['reservations']);
  if (r) settings.reservations = { all: r['all'] === true, itemIds: strs(r['itemIds']) };
  const k = obj(s['knowledgeRules']);
  if (k) settings.knowledgeRules = { compartments: strs(k['compartments']) };
  const j = obj(s['jobs']);
  if (j) settings.jobs = { agentIds: strs(j['agentIds']), maxRisk: (typeof j['maxRisk'] === 'string' ? j['maxRisk'] : 'read') as RiskLevel };
  return { functions, settings };
}

/**
 * 外部のアプリの管理者の API（`/v1/admin/apps`）。
 *
 * @remarks テナント境界: ログインした会社の中のアプリだけを扱う（不変則 I-2）
 */
export function adminAppsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireRole('admin'));
  const { apps } = deps;

  /** アプリの一覧（登録した順）と、この会社で選べる機能。鍵は返さない。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const available = new Set(await apps.available(tenant.id));
    return c.json({
      items: await apps.list(tenant.id), max: EXTERNAL_APP_MAX, functions: APP_FUNCTIONS.filter((f) => available.has(f.id)),
      // 機能ごとの設定の候補（お知らせの宛先・予約できるもの・規程の区画・業務。第13.4.2節）
      options: await apps.settingOptions(tenant.id),
    });
  });

  /** アプリを登録する。鍵はこの答えでだけ返す。 */
  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
    const res = await apps.create(tenant.id, user.id, typeof body.name === 'string' ? body.name : '');
    return 'error' in res ? c.json(res, 400) : c.json(res, 201);
  });

  /** 機能「商品の一覧を読む」の見本（アプリに渡るとおりの一覧）。 */
  app.post('/preview/inventory-catalog', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ items: await deps.inventory.sales.preview(tenant.id, catalogScopeOf(await c.req.json().catch(() => ({})))) });
  });

  /** 名前を変える（承認し直さない）。 */
  app.put('/:id/name', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
    const res = await apps.rename(tenant.id, user.id, c.req.param('id'), typeof body.name === 'string' ? body.name : '');
    return 'error' in res ? c.json(res, 400) : c.json(res);
  });

  /** この内容で許す（機能と機能ごとの設定を承認する。押した管理者が承認者）。 */
  app.put('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const res = await apps.approve(tenant.id, user.id, c.req.param('id'), approvalOf(await c.req.json().catch(() => ({}))));
    return 'error' in res ? c.json(res, 400) : c.json(res);
  });

  /** 鍵を出し直す（前の鍵はすぐ使えなくなる）。新しい鍵はこの答えでだけ返す。 */
  app.post('/:id/rekey', async (c) => {
    const { tenant, user } = c.get('ctx');
    const res = await apps.rekey(tenant.id, user.id, c.req.param('id'));
    return 'error' in res ? c.json(res, 404) : c.json(res);
  });

  /** 止める・動かす。 */
  for (const [path, status] of [['stop', 'stopped'], ['resume', 'active']] as const) {
    app.post(`/:id/${path}`, async (c) => {
      const { tenant, user } = c.get('ctx');
      const res = await apps.setStatus(tenant.id, user.id, c.req.param('id'), status);
      return 'error' in res ? c.json(res, 404) : c.json(res);
    });
  }

  /** 削除する（止めてあるアプリだけ）。 */
  app.delete('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const res = await apps.remove(tenant.id, user.id, c.req.param('id'));
    return 'error' in res ? c.json(res, 409) : c.json(res);
  });

  return app;
}
