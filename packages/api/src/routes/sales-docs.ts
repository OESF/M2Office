/**
 * @file 販売の書類と受注（内蔵の拡張）の API。受注の一覧・取り込み・直す・取り消し・削除・納品書を作る・見積書とのつながりを直す、
 * 書類の一覧（取引先・日付・金額で探す）・1 通・PDF・請求書にまとめる・発行・取り消し・下書きの削除。
 *
 * 会社が販売の書類と受注を切っているときと、利用範囲の外の人には、どの口も使わせない。社外には何も出さない（送るのは業務の承認の後）。
 * **発行は、この口では本人が押して行う**（画面の「発行」。本人の判断。第42.3.1節）。
 *
 * @see 仕様書 第42章
 */

import { Hono, type Context } from 'hono';
import { SALES_DOC_KIND_LABELS, SALES_ORDER_STATUS_LABELS, type SalesDocKind, type SalesOrderStatus } from '@m2office/shared';
import { itemsFrom, type SalesViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 販売の書類と受注の API（仕様書 第42章）。
 *
 * @remarks 監査ログは処理（SalesDocService）が残す
 */
export function salesDocsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.salesDocs;
  const who = (c: Context<AppEnv>): SalesViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  const body = async (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const status = (problem: string) => (problem.includes('見つかりません') ? 404 : problem.includes('だけです') ? 403 : 400);

  // 販売の書類と受注を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.salesDocs.access(tenant.id, user.id))) {
      return c.json({ error: '販売の書類と受注は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  // ───────── 受注 ─────────

  /** 受注の一覧（新しい順。`status`、`q`: 取引先・注文番号・品名、`from`・`to`: 注文日の範囲。進み具合つき。第42.14.5節）。 */
  app.get('/orders', async (c) => {
    const st = c.req.query('status');
    const from = DATE.test(c.req.query('from') ?? '') ? c.req.query('from')! : '';
    const to = DATE.test(c.req.query('to') ?? '') ? c.req.query('to')! : '';
    let items = await service.listOrders(who(c), {
      ...(st && st in SALES_ORDER_STATUS_LABELS ? { status: st as SalesOrderStatus } : {}),
      ...(c.req.query('q') ? { search: c.req.query('q')!.slice(0, 100) } : {}),
      ...(from || to ? { limit: 2000 } : {}),
    });
    if (from || to) items = items.filter((o) => (!from || (o.orderedOn ?? '') >= from) && (!to || (o.orderedOn ?? '9999') <= to)).slice(0, 200);
    return c.json({ items });
  });

  /**
   * 手で入れる（電話などで受けた注文。第42.5.1.1節）。`party`・`items`（品名・数量・単位・単価）・`dueOn` ほか。
   * 品名が「いつもの」なら前の注文から読む。同じ注文があれば作らずに返す。
   */
  app.post('/orders', async (c) => {
    const b = await body(c);
    const s = (k: string, max: number) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, max) : '');
    const r = await service.recordOrder(who(c), {
      party: s('party', 100), person: s('person', 40), items: itemsFrom(b['items']), orderedOn: s('orderedOn', 10), dueOn: s('dueOn', 10),
      customerRef: s('customerRef', 60), deliverTo: s('deliverTo', 120), terms: s('terms', 80), notes: s('notes', 300),
    }, 'manual');
    if ('error' in r) return c.json(r, 400);
    return c.json(r, r.duplicate ? 200 : 201);
  });

  /** 手で入れるときの候補（取引先の名前と、`party` の前の品目。第42.5.1.1節）。 */
  app.get('/suggestions', async (c) => c.json(await service.suggestions(who(c), (c.req.query('party') ?? '').slice(0, 100))));

  /** 注文書を受注にする（`fileId`: 上げた注文書、か `quoteNumber`: 見積書から。第42.5.1節・第42.14.4節）。同じ注文があれば取り込まずに返す。 */
  app.post('/orders/import', async (c) => {
    const b = await body(c);
    const fileId = typeof b['fileId'] === 'string' && ID.test(b['fileId']) ? b['fileId'] : null;
    const quote = typeof b['quoteNumber'] === 'string' ? b['quoteNumber'].trim().slice(0, 40) : '';
    if (!fileId && !quote) return c.json({ error: '注文書のファイルか、見積書の番号を渡してください' }, 400);
    const r = fileId ? await service.importOrder(who(c), fileId, 'upload') : await service.orderFromQuote(who(c), quote);
    if ('error' in r) return c.json(r, 400);
    return c.json(r, r.duplicate ? 200 : 201);
  });

  app.get('/orders/:id', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.getOrder(who(c), id) : null;
    return r ? c.json(r) : c.json({ error: '受注が見つかりません' }, 404);
  });

  /** 受注を直す（読み取りの直し）。 */
  app.patch('/orders/:id', async (c) => {
    const id = c.req.param('id');
    const problem = ID.test(id) ? await service.updateOrder(who(c), id, await body(c)) : '受注が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.getOrder(who(c), id));
  });

  /** 受注を取り消す（`reason`）。 */
  app.post('/orders/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    const problem = ID.test(id) ? await service.cancelOrder(who(c), id, typeof b['reason'] === 'string' ? b['reason'] : '') : '受注が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.getOrder(who(c), id));
  });

  /** 受注を削除する（取り込み違い。取り込んだ人と管理者だけ）。 */
  app.delete('/orders/:id', async (c) => {
    const id = c.req.param('id');
    const problem = ID.test(id) ? await service.removeOrder(who(c), id) : '受注が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json({ ok: true });
  });

  /** 取り込んだ元の注文書を開く。 */
  app.get('/orders/:id/file', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.orderFile(who(c), id) : null;
    if (!r) return c.json({ error: '注文書が見つかりません' }, 404);
    return new Response(Buffer.from(r.bytes), {
      headers: {
        'content-type': r.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      },
    });
  });

  /** 受注につなぐ見積書を直す（`quoteId`。外すなら `null`。第42.14.4節）。 */
  app.patch('/orders/:id/quote', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    const quoteId = typeof b['quoteId'] === 'string' && ID.test(b['quoteId']) ? b['quoteId'] : null;
    const problem = ID.test(id) ? await service.relinkQuote(who(c), id, quoteId) : '受注が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.getOrder(who(c), id));
  });

  /** 受注から注文請書を作る（作ったら発行済み。第42.13.5節）。送るのは業務の承認の後。 */
  app.post('/orders/:id/acknowledgement', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '受注が見つかりません' }, 404);
    const r = await service.createDocument(who(c), { kind: 'acknowledgement', orderId: id }, null);
    return 'error' in r ? c.json(r, status(r.error)) : c.json(r, 201);
  });

  /** 受注の品目の在庫のつながりを直す（`index`・`itemId`。外すなら `null`。第42.13.4節）。 */
  app.patch('/orders/:id/stock', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    const index = typeof b['index'] === 'number' ? b['index'] : -1;
    const itemId = typeof b['itemId'] === 'string' && ID.test(b['itemId']) ? b['itemId'] : null;
    const problem = ID.test(id) ? await service.relinkStock(who(c), id, index, itemId) : '受注が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.getOrder(who(c), id));
  });

  /** つなげる在庫の品目（在庫管理を使える人だけ）。 */
  app.get('/stock-items', async (c) => {
    const w = who(c);
    const inv = service.deps.inventory;
    if (!inv || !(await inv.access(w.tenantId, w.userId))) return c.json({ items: [] });
    return c.json({ items: await inv.items(w.tenantId) });
  });

  /** 受注の残りの数で納品書を作る（作ったら発行済み。第42.4.2節）。 */
  app.post('/orders/:id/delivery', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '受注が見つかりません' }, 404);
    const r = await service.createDocument(who(c), { kind: 'delivery', orderId: id }, null);
    return 'error' in r ? c.json(r, status(r.error)) : c.json(r, 201);
  });

  // ───────── 書類 ─────────

  /** 書類の一覧（`kind`・`status`・`party`・`from`・`to`・`min`・`max`・`unbilled=1`。第42.6節）。 */
  app.get('/documents', async (c) => {
    const kind = c.req.query('kind');
    const st = c.req.query('status');
    const num = (k: string) => { const v = Number(c.req.query(k)); return c.req.query(k) && Number.isFinite(v) ? v : undefined; };
    const date = (k: string) => (DATE.test(c.req.query(k) ?? '') ? c.req.query(k)! : undefined);
    let items = await service.list(who(c), {
      ...(kind && kind in SALES_DOC_KIND_LABELS ? { kind: kind as SalesDocKind } : {}),
      ...(st === 'draft' || st === 'issued' || st === 'cancelled' ? { status: st } : {}),
      ...(c.req.query('party') ? { party: c.req.query('party')!.slice(0, 100) } : {}),
      ...(date('from') ? { from: date('from')! } : {}), ...(date('to') ? { to: date('to')! } : {}),
      ...(num('min') !== undefined ? { min: num('min')! } : {}), ...(num('max') !== undefined ? { max: num('max')! } : {}),
      limit: 500,
    });
    if (c.req.query('unbilled') === '1') items = items.filter((d) => d.kind === 'delivery' && d.status === 'issued' && !d.invoiceId);
    return c.json({ items });
  });

  /** 納品書をまとめて請求書の下書きを作る（`deliveryIds`。第42.4.2節）。発行は「発行」で行う。 */
  app.post('/documents/invoice', async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b['deliveryIds']) ? b['deliveryIds'].filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 50) : [];
    if (ids.length === 0) return c.json({ error: '納品書を選んでください' }, 400);
    const r = await service.createDocument(who(c), { kind: 'invoice', deliveryIds: ids }, null);
    return 'error' in r ? c.json(r, status(r.error)) : c.json(r, 201);
  });

  app.get('/documents/:id', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.get(who(c), id) : null;
    return r ? c.json(r) : c.json({ error: '書類が見つかりません' }, 404);
  });

  /** 書類の PDF。 */
  app.get('/documents/:id/pdf', async (c) => {
    const id = c.req.param('id');
    const r = ID.test(id) ? await service.pdf(who(c), id) : null;
    if (!r) return c.json({ error: '書類が見つかりません' }, 404);
    const download = c.req.query('download') === '1';
    return new Response(Buffer.from(r.bytes), {
      headers: {
        'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      },
    });
  });

  /** 下書きを発行する（本人が押す。番号を付ける。第42.3.1節）。 */
  app.post('/documents/:id/issue', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '書類が見つかりません' }, 404);
    const r = await service.issue(who(c), id);
    return 'error' in r ? c.json(r, status(r.error)) : c.json({ doc: r });
  });

  /** 発行した書類を取り消す（`reason`。作った人と管理者だけ）。 */
  app.post('/documents/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const b = await body(c);
    const problem = ID.test(id) ? await service.cancel(who(c), id, typeof b['reason'] === 'string' ? b['reason'] : '') : '書類が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json(await service.get(who(c), id));
  });

  /** 下書きを削除する（作った人と管理者だけ）。 */
  app.delete('/documents/:id', async (c) => {
    const id = c.req.param('id');
    const problem = ID.test(id) ? await service.removeDraft(who(c), id) : '書類が見つかりません';
    if (problem) return c.json({ error: problem }, status(problem));
    return c.json({ ok: true });
  });

  return app;
}
