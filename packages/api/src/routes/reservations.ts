/**
 * @file 会議室・社用車・備品の予約（内蔵の拡張）の API。予約できるもの（一覧・足す・直す・止める・並べ替え。管理者）、
 * 期間の予約・自分の予約・予約する・変える・取り消す・終わった。
 *
 * 会社が予約を切っているときと、利用範囲の外の人には、どの口も使わせない。重なる予約は 409 と、空いている時間・ほかのものを返す。
 *
 * @see 仕様書 第37.13節 API
 */

import { Hono, type Context } from 'hono';
import type { BookResult, ReservationViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** 一度に読む期間の長さ（週の表と、またがる予約の分） */
const RANGE_MAX_MS = 15 * 86_400_000;

/**
 * 予約の API（仕様書 第37章）。
 *
 * @remarks 監査ログは処理（ReservationService）が残す
 */
export function reservationsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.reservations;
  const who = (c: Context<AppEnv>): ReservationViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  const isAdmin = (c: Context<AppEnv>) => c.get('ctx').user.roles.includes('admin');
  const body = (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  /** 予約した結果を返す（重なれば 409）。 */
  const booked = (c: Context<AppEnv>, r: BookResult, status: 200 | 201) => {
    if ('error' in r) return c.json({ error: r.error }, 400);
    if ('conflict' in r) return c.json({ error: `${r.item.name}はその時間に予約があります`, conflict: r.conflict }, 409);
    return c.json({ reservation: r.reservation, calendar: r.calendar }, status);
  };

  // 予約を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.reservations.access(tenant.id, user.id))) {
      return c.json({ error: '予約は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 予約できるもの（止めたものも含む）と、本人が管理者か。 */
  app.get('/items', async (c) => c.json({ items: await service.items(who(c)), admin: isAdmin(c) }));

  /** 足す（管理者だけ。種類を言わなければ名前から決める）。 */
  app.post('/items', async (c) => {
    const r = await service.addItem(who(c), await body(c));
    if ('error' in r) return c.json(r, isAdmin(c) ? 400 : 403);
    return c.json(r, 201);
  });

  /** 並べ替え（管理者だけ。`ids` の順に並べる）。 */
  app.put('/items/order', async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b['ids']) ? b['ids'].map(String).filter((x) => ID.test(x)).slice(0, 500) : [];
    const problem = await service.reorder(who(c), ids);
    return problem ? c.json({ error: problem }, 403) : c.json({ ok: true });
  });

  /** 直す・止める・使うに戻す（管理者だけ）。 */
  app.patch('/items/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '予約できるものが見つかりません' }, 404);
    const problem = await service.updateItem(who(c), id, await body(c));
    if (problem) return c.json({ error: problem }, problem.includes('管理者だけ') ? 403 : problem.includes('見つかりません') ? 404 : 400);
    return c.json({ ok: true });
  });

  /** 期間の予約（`from`・`to` は ISO。15 日まで）。予約できるものと一緒に返す。 */
  app.get('/', async (c) => {
    const from = Date.parse(c.req.query('from') ?? '');
    const to = Date.parse(c.req.query('to') ?? '');
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > RANGE_MAX_MS) return c.json({ error: '期間が違います（15 日まで）' }, 400);
    const w = who(c);
    const [items, reservations] = await Promise.all([
      service.items(w), service.list(w, { from: new Date(from).toISOString(), to: new Date(to).toISOString() }),
    ]);
    return c.json({ items, reservations, me: w.userId, admin: isAdmin(c) });
  });

  /** 本人のこれからの予約。 */
  app.get('/mine', async (c) => c.json({ reservations: await service.mine(who(c)) }));

  /** 予約する。重なれば 409 と、次に空いている時間・同じ種類で空いているほかのもの。 */
  app.post('/', async (c) => {
    const b = await body(c);
    const r = await service.book(who(c), {
      itemId: String(b['itemId'] ?? ''), startAt: String(b['startAt'] ?? ''), endAt: String(b['endAt'] ?? ''), purpose: String(b['purpose'] ?? ''),
    });
    return booked(c, r, 201);
  });

  /** 繰り返しの予約を作る（第37.18節。`itemId`・`rule`・`startsOn`・`startTime`・`endTime`・`endsOn`・`purpose`）。90 日先までの回を作る。 */
  app.post('/series', async (c) => {
    const b = await body(c);
    const r = await service.createSeries(who(c), {
      itemId: String(b['itemId'] ?? ''), rule: String(b['rule'] ?? '') as 'weekly', startsOn: String(b['startsOn'] ?? ''),
      startTime: String(b['startTime'] ?? ''), endTime: String(b['endTime'] ?? ''), endsOn: typeof b['endsOn'] === 'string' && b['endsOn'] ? b['endsOn'] : null,
      purpose: String(b['purpose'] ?? ''),
    });
    if ('error' in r) return c.json(r, 400);
    return c.json(r, 201);
  });

  /** 繰り返し（決まりの文・ものの名前・予約した人・取れなかった日）。 */
  app.get('/series/:id', async (c) => {
    const id = c.req.param('id');
    const s = ID.test(id) ? await service.seriesOf(who(c), id) : null;
    return s ? c.json({ series: s }) : c.json({ error: '繰り返しが見つかりません' }, 404);
  });

  /** 繰り返しを止める（これからの回をまとめて取り消す。本人と管理者だけ）。 */
  app.delete('/series/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '繰り返しが見つかりません' }, 404);
    const problem = await service.stopSeries(who(c), id);
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 403);
    return c.json({ ok: true });
  });

  /** 変える（時間・もの・用件。本人と管理者だけ）。 */
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '予約が見つかりません' }, 404);
    const b = await body(c);
    const input: { itemId?: string; startAt?: string; endAt?: string; purpose?: string } = {};
    for (const k of ['itemId', 'startAt', 'endAt', 'purpose'] as const) if (typeof b[k] === 'string') input[k] = b[k] as string;
    const r = await service.change(who(c), id, input);
    if ('error' in r) return c.json({ error: r.error }, r.error.includes('見つかりません') ? 404 : r.error.includes('だけです') ? 403 : 400);
    return booked(c, r, 200);
  });

  /** 取り消す（本人と管理者だけ）。 */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '予約が見つかりません' }, 404);
    const problem = await service.cancel(who(c), id);
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 403);
    return c.json({ ok: true });
  });

  /** 早く終わったので、終わりをいまにする（本人と管理者だけ）。 */
  app.post('/:id/finish', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '予約が見つかりません' }, 404);
    const problem = await service.finish(who(c), id);
    if (problem) return c.json({ error: problem }, problem.includes('見つかりません') ? 404 : 403);
    return c.json({ ok: true });
  });

  return app;
}
