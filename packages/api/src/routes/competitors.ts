/**
 * @file 競合の分析（内蔵の拡張）の API。全体（自社の像・競合・動いている作業）・探す・今すぐ見回る・入れる・外す・事実・レポート。
 *
 * 会社が競合の分析を切っているときと、利用範囲の外の人には、どの口も使わせない。探す・見回るは作業として受け付け、ワーカーが行う。
 *
 * @see 仕様書 第36.18節 段 1 の実装の決まり
 */

import { Hono, type Context } from 'hono';
import type { CompetitorViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 競合の分析の API（仕様書 第36章）。
 *
 * @remarks 監査ログは処理（CompetitorService）が残す（入れる・外す・探す・見回る・レポート）
 */
export function competitorsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.competitors;
  const who = (c: Context<AppEnv>): CompetitorViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // 競合の分析を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.competitors.access(tenant.id, user.id))) {
      return c.json({ error: '競合の分析は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 全体（自社の像・競合・動いている作業）。地図で見つけた競合の名前は、ここで引き直す。 */
  app.get('/', async (c) => c.json(await service.overview(who(c))));

  /**
   * 競合を探す作業を受け付ける。`radiusKm` で半径、`nationwide` で全国、`auto` で商圏を AI に戻す。
   */
  app.post('/discover', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const km = Number(body['radiusKm']);
    const area = body['auto'] === true ? null
      : body['nationwide'] === true ? { local: false, radiusM: null }
        : Number.isFinite(km) && km > 0 ? { local: true, radiusM: Math.round(Math.min(50, km) * 1000) } : undefined;
    const r = await service.requestDiscover(who(c), area);
    return c.json(r, 202);
  });

  /** 今すぐ見回る作業を受け付ける（自社と競合を読み、レポートを作る）。 */
  app.post('/check', async (c) => c.json(await service.requestCheck(who(c)), 202));

  /** 競合を入れる（`text` に URL か店の名前）。入れたら、その 1 社を読む作業を受け付ける。 */
  app.post('/', async (c) => {
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({} as { text?: unknown }));
    const r = await service.add(who(c), typeof body.text === 'string' ? body.text : '');
    if ('error' in r) return c.json({ error: r.error }, 400);
    return c.json(r, 201);
  });

  /** 競合を外す（次に自動で探しても入れない）。 */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id) || !(await service.remove(who(c), id))) return c.json({ error: 'その競合はありません' }, 404);
    return c.json({ ok: true });
  });

  /** 1 社の事実（`self` なら自社）。新しい回から。 */
  app.get('/:id/facts', async (c) => {
    const id = c.req.param('id');
    if (id !== 'self' && !ID.test(id)) return c.json({ error: 'その競合はありません' }, 404);
    return c.json({ facts: await service.facts(who(c), id === 'self' ? null : id) });
  });

  /** レポート（新しい順）。 */
  app.get('/reports/list', async (c) => c.json({ reports: await service.reports(who(c), Number(c.req.query('limit') ?? 12)) }));

  /** いまある事実から、その場のレポートを作る（読み直さない）。 */
  app.post('/reports', async (c) => c.json({ report: await service.makeReport(who(c)) }, 201));

  return app;
}
