/**
 * @file 見積書の API（仕様書 第42.14節、Q-278）。作った見積書の一覧・1 通・PDF・失注・取り消し・受注にする。
 *
 * 業務「見積書の作成」を使える人（または販売の書類と受注を使える人）だけが使える。会社の見積書は、使える人が全員見られる（会社の取引の記録）。
 * 見積書を作る・再見積をするのは業務「見積書の作成」の実行（`POST /v1/runs`。再見積は `documentId` を渡す）で行い、この道では行わない。
 * 受注にするのは、販売の書類と受注を使える人だけ。社外には何も出さない。
 */

import { Hono, type Context } from 'hono';
import { salesQuoteState, type SalesQuoteState } from '@m2office/shared';
import { salesToday, type SalesViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const STATES: SalesQuoteState[] = ['submitted', 'won', 'lost', 'expired', 'cancelled'];

/**
 * 見積書の API（仕様書 第42.14.1節）。
 *
 * @remarks 監査ログは処理（SalesDocService）が残す
 */
export function quotesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.salesDocs;
  const who = (c: Context<AppEnv>): SalesViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  const body = async (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const status = (problem: string) => (problem.includes('見つかりません') ? 404 : problem.includes('だけです') ? 403 : 400);

  // 見積書の作成か、販売の書類と受注を使える人だけ
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    const ok = (await deps.canUse(tenant.id, user.id, 'quote')) || !!(await deps.salesDocs.access(tenant.id, user.id));
    if (!ok) return c.json({ error: '見積書は使えません（利用範囲の外です）' }, 403);
    await next();
  });
  app.use('/:id/*', async (c, next) => (ID.test(c.req.param('id')) ? next() : c.json({ error: '見積書が見つかりません' }, 404)));

  /** 見積書の一覧（新しい版だけ。新しい順。`party`・`state`: submitted・won・lost・expired・cancelled）。 */
  app.get('/', async (c) => {
    const state = c.req.query('state') as SalesQuoteState | undefined;
    const today = salesToday();
    let items = await service.listQuotes(who(c), { ...(c.req.query('party') ? { party: c.req.query('party')!.slice(0, 100) } : {}), limit: 500 });
    if (state && STATES.includes(state)) items = items.filter((d) => salesQuoteState(d, today) === state);
    return c.json({ items, orders: !!(await deps.salesDocs.access(who(c).tenantId, who(c).userId)) });
  });

  /** 見積書 1 通（版・この見積書に対する受注・前の版からの違い）。 */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.get(who(c), id) : null;
    return r && r.doc.kind === 'quote' ? c.json(r) : c.json({ error: '見積書が見つかりません' }, 404);
  });

  /** 見積書の PDF。 */
  app.get('/:id/pdf', async (c) => {
    const d = (await service.get(who(c), c.req.param('id')))?.doc;
    const r = d?.kind === 'quote' ? await service.pdf(who(c), d.id) : null;
    if (!r) return c.json({ error: '見積書が見つかりません' }, 404);
    return new Response(Buffer.from(r.bytes), {
      headers: {
        'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      },
    });
  });

  /** 失注にする（`reason`。第42.14.4節）。 */
  app.post('/:id/lost', async (c) => {
    const b = await body(c);
    const problem = await service.loseQuote(who(c), c.req.param('id'), typeof b['reason'] === 'string' ? b['reason'] : '');
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.get(who(c), c.req.param('id')));
  });

  /** 取り消す（`reason`。作った人と管理者だけ。出し間違いなど）。 */
  app.post('/:id/cancel', async (c) => {
    const d = (await service.get(who(c), c.req.param('id')))?.doc;
    if (d?.kind !== 'quote') return c.json({ error: '見積書が見つかりません' }, 404);
    const b = await body(c);
    const problem = await service.cancel(who(c), d.id, typeof b['reason'] === 'string' ? b['reason'] : '');
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.get(who(c), d.id));
  });

  /** 受注にする（その番号のいちばん新しい版から。販売の書類と受注を使える人だけ。第42.14.4節）。 */
  app.post('/:id/order', async (c) => {
    const w = who(c);
    if (!(await deps.salesDocs.access(w.tenantId, w.userId))) return c.json({ error: '受注にするには、拡張機能「販売の書類と受注」が要ります' }, 403);
    const r = await service.orderFromQuote(w, c.req.param('id'));
    if ('error' in r) return c.json(r, status(r.error));
    return c.json(r, r.duplicate ? 200 : 201);
  });

  return app;
}
