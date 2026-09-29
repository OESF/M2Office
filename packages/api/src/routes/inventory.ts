/**
 * @file 在庫管理（内蔵の拡張）の API。品目の一覧と詳細・作成と修正・止め・バーコードで引く・場所と棚のラベル・入出庫の記録と取り消し・
 * 棚卸し・取り込みと書き出し。
 *
 * 会社が在庫管理を切っているときと、利用範囲の外の人には、どの口も使わせない。
 * 在庫は会社で共有する。品目の止めと場所の削除は管理者だけ（第29.16節）。
 *
 * @see 仕様書 第29章 在庫管理
 */

import { Hono } from 'hono';
import QRCode from 'qrcode';
import {
  readSheet, renderSheet, renderShelfLabels, saveFile, detectKind, enqueueJob, IMPORT_MAX_ROWS, INVENTORY_ORDER, MAX_FILE_BYTES, MIME,
  MOBILE_INVENTORY_PATH, type ItemInput, type MoveInput,
} from '@m2office/core';
import type { InventoryMoveKind } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

/** 取り込むファイルの大きさの上限（品目は数十〜数千。第29.1.1節）。 */
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const numOrNull = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  if (v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 画面から受け取った品目の値を、処理の形にする（知らない項目は捨てる）。 */
function itemInput(body: Record<string, unknown>): ItemInput {
  const out: ItemInput = {};
  for (const k of ['name', 'publicName', 'sku', 'category', 'unit', 'packUnit', 'note'] as const) {
    const v = str(body[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['packSize', 'price', 'lowThreshold', 'leadDays'] as const) {
    const v = numOrNull(body[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof body['priceTaxIncluded'] === 'boolean') out.priceTaxIncluded = body['priceTaxIncluded'];
  if (body['supplierId'] === null || typeof body['supplierId'] === 'string') out.supplierId = (body['supplierId'] as string | null) || null;
  if (Array.isArray(body['codes'])) out.codes = body['codes'].filter((c): c is string => typeof c === 'string').slice(0, 20);
  return out;
}

/**
 * 在庫管理の API（仕様書 第29章）。
 *
 * @remarks 入出庫の 1 件ずつは監査ログに入れない（記録そのものが誰がいつを持ち、消せないため。第29.16節）
 */
export function inventoryRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.inventory;

  // 在庫管理を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.inventory.access(tenant.id, user.id))) {
      return c.json({ error: '在庫管理は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  const isAdmin = (c: { get(k: 'ctx'): AppEnv['Variables']['ctx'] }) => c.get('ctx').user.roles.includes('admin');

  /** 品目の一覧と、場所・会社の設定（第29.6節）。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [items, locations, settings] = await Promise.all([
      service.list(tenant.id, { q: (c.req.query('q') ?? '').slice(0, 100), includeStopped: c.req.query('stopped') === '1' }),
      service.locations(tenant.id),
      service.settings(tenant.id),
    ]);
    return c.json({ items, locations, settings: { features: settings.features, lowDefault: settings.lowDefault }, admin: isAdmin(c) });
  });

  /** 品目 1 件（場所とロットごとの数・最近の記録）。 */
  app.get('/items/:id', async (c) => {
    const { tenant } = c.get('ctx');
    const d = await service.detail(tenant.id, c.req.param('id'));
    if (!d) return c.json({ error: '品目が見つかりません' }, 404);
    return c.json(d);
  });

  /** 品目を作る。はじめの数（`initialQty`）があれば入庫として記録する（第29.6節）。 */
  app.post('/items', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const initial = numOrNull(body['initialQty']);
    const res = await service.createItem(tenant.id, user.id, itemInput(body), initial ?? null);
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ item: res.item, moves: res.moves, note: res.note }, 201);
  });

  /** 品目を直す（直した人と日時を残す）。 */
  app.put('/items/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const res = await service.saveItem(tenant.id, user.id, { ...itemInput(body), id: c.req.param('id') });
    if ('error' in res) return c.json({ error: res.error }, res.error === '品目が見つかりません' ? 404 : 400);
    return c.json({ item: res.item });
  });

  /** 品目を止める・使うに戻す（管理者。第29.16節）。 */
  app.put('/items/:id/status', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!isAdmin(c)) return c.json({ error: '品目を止められるのは管理者です' }, 403);
    const body = await c.req.json().catch(() => ({})) as { status?: unknown };
    if (body.status !== 'active' && body.status !== 'stopped') return c.json({ error: 'status は active か stopped です' }, 400);
    const res = await service.setItemStatus(tenant.id, user.id, c.req.param('id'), body.status);
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ ok: true });
  });

  /** 品目からバーコードを外す。 */
  app.delete('/items/:id/codes/:code', async (c) => {
    const { tenant } = c.get('ctx');
    await service.removeCode(tenant.id, c.req.param('id'), c.req.param('code'));
    return c.json({ ok: true });
  });

  /** 読んだバーコード・QR の値から、品目か棚を引く（第29.11節）。 */
  app.get('/lookup', async (c) => {
    const { tenant } = c.get('ctx');
    const code = (c.req.query('code') ?? '').slice(0, 200);
    if (!code) return c.json({ error: 'code を入れてください' }, 400);
    return c.json(await service.lookup(tenant.id, code));
  });

  /** 場所を足す。 */
  app.post('/locations', async (c) => {
    const { tenant } = c.get('ctx');
    const body = await c.req.json().catch(() => ({})) as { warehouse?: unknown; shelf?: unknown };
    const res = await service.addLocation(tenant.id, str(body.warehouse) ?? '', str(body.shelf) ?? '');
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ location: res }, 201);
  });

  /** 場所を外す（管理者。在庫が残っていれば外せない）。 */
  app.delete('/locations/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!isAdmin(c)) return c.json({ error: '場所を外せるのは管理者です' }, 403);
    const res = await service.removeLocation(tenant.id, user.id, c.req.param('id'));
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ ok: true });
  });

  /** 入出庫を記録する（第29.9節）。 */
  app.post('/moves', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const kind = str(b['kind']) as InventoryMoveKind | undefined;
    if (!kind || !['in', 'out', 'transfer', 'adjust'].includes(kind)) return c.json({ error: '記録の種類が正しくありません' }, 400);
    const input: MoveInput = {
      kind, itemId: str(b['itemId']) ?? '', qty: typeof b['qty'] === 'number' ? b['qty'] : Number(b['qty']),
      unit: b['unit'] === 'pack' ? 'pack' : 'unit',
      ...(str(b['locationId']) ? { locationId: str(b['locationId'])! } : {}),
      ...(str(b['toLocationId']) ? { toLocationId: str(b['toLocationId'])! } : {}),
      ...(str(b['lot']) ? { lot: str(b['lot'])! } : {}),
      ...(str(b['expiresOn']) ? { expiresOn: str(b['expiresOn'])! } : {}),
      ...(str(b['reason']) ? { reason: str(b['reason'])! } : {}),
      source: 'manual',
    };
    const res = await service.recordMove(tenant.id, user.id, input);
    if (!res.ok) return c.json({ error: res.error }, res.error === '品目が見つかりません' ? 404 : 400);
    return c.json(res, 201);
  });

  /** 自分の記録を、その日のうちなら取り消す（逆の記録を足す。第29.9節）。 */
  app.post('/moves/:id/undo', async (c) => {
    const { tenant, user } = c.get('ctx');
    const res = await service.undo(tenant.id, user.id, c.req.param('id'));
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json(res, 201);
  });

  /** 入出庫の記録（新しい順）。 */
  app.get('/moves', async (c) => {
    const { tenant } = c.get('ctx');
    const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const from = day(c.req.query('from'));
    const to = day(c.req.query('to'));
    const moves = await service.history(tenant.id, {
      ...(c.req.query('itemId') ? { itemId: c.req.query('itemId')! } : {}),
      ...(from ? { since: new Date(`${from}T00:00:00+09:00`).toISOString() } : {}),
      ...(to ? { until: new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86_400_000).toISOString() } : {}),
      limit: Math.min(500, Math.max(1, Number(c.req.query('limit')) || 200)),
    });
    return c.json({ moves });
  });

  // ---- 仕入先と見張り（第29.4.1節・第29.14節） ----

  /** 仕入先の一覧。 */
  app.get('/suppliers', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ suppliers: await service.suppliers(tenant.id) });
  });

  /** 仕入先を足す（`id` があれば直す）。 */
  app.post('/suppliers', async (c) => {
    const { tenant } = c.get('ctx');
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const res = await service.saveSupplier(tenant.id, {
      ...(str(b['id']) ? { id: str(b['id'])! } : {}),
      ...(str(b['name']) !== undefined ? { name: str(b['name'])! } : {}),
      ...(b['method'] === 'mail' || b['method'] === 'web' || b['method'] === 'phone' ? { method: b['method'] } : {}),
      ...(str(b['contact']) !== undefined ? { contact: str(b['contact'])! } : {}),
      ...(numOrNull(b['leadDays']) !== undefined ? { leadDays: numOrNull(b['leadDays'])! } : {}),
      ...(str(b['note']) !== undefined ? { note: str(b['note'])! } : {}),
      ...(b['status'] === 'active' || b['status'] === 'stopped' ? { status: b['status'] } : {}),
    });
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ supplier: res });
  });

  /**
   * 納品書から入庫する（第29.9節）。写真か PDF を受け取り、読み取って品目に照らせた行を入庫にし、照らせない行を返す。
   *
   * @remarks 納品書のファイルは会社のファイルとして残し、入出庫の記録の元（source_id）にする。金額は読まない
   */
  app.post('/slips', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: '納品書の写真か PDF を選んでください' }, 400);
    if (f.size > MAX_FILE_BYTES) return c.json({ error: 'ファイルが大きすぎます（10 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const kind = detectKind(f.name || 'slip.jpg', bytes);
    if (!kind || !['png', 'jpeg', 'webp', 'pdf'].includes(kind)) return c.json({ error: '納品書の写真（PNG・JPEG・WebP）か PDF を選んでください' }, 400);
    const saved = await saveFile(deps.repo, deps.files, {
      tenantId: tenant.id, ownerUserId: user.id, name: f.name || '納品書', kind, bytes, origin: 'upload', runId: null,
    });
    const locationId = str(form['locationId']);
    const res = await service.receiveSlip(tenant.id, user.id, { bytes, mimeType: MIME[kind], sourceId: saved.id }, locationId || undefined);
    return c.json({ ...res, fileId: saved.id }, res.read.ok ? 201 : 422);
  });

  /**
   * 発注を始める（第29.14節）。メールで受ける仕入先なら、付属の業務「発注の下書き」を起こす（送るのは本人の承認のあと）。
   * Web・電話の仕入先は、発注の画面の URL か電話番号と、伝える内容を返す。
   */
  app.post('/orders', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json().catch(() => ({})) as { supplierId?: unknown; lines?: unknown };
    const suppliers = await service.suppliers(tenant.id);
    const supplier = suppliers.find((s) => s.id === str(b.supplierId));
    if (!supplier) return c.json({ error: '仕入先を選んでください' }, 400);
    const items = new Map((await service.list(tenant.id)).map((i) => [i.id, i]));
    const lines = (Array.isArray(b.lines) ? b.lines : []).flatMap((l) => {
      const o = l as { itemId?: unknown; qty?: unknown };
      const item = items.get(str(o.itemId) ?? '');
      const qty = typeof o.qty === 'number' ? o.qty : Number(o.qty);
      if (!item || !Number.isFinite(qty) || qty <= 0) return [];
      const amount = item.packUnit && item.packSize ? `${Math.ceil(qty / item.packSize)} ${item.packUnit}（${qty} ${item.unit}）` : `${qty} ${item.unit}`;
      return [`${item.name}${item.sku ? `（品番 ${item.sku}）` : ''}: ${amount}`];
    });
    if (lines.length === 0) return c.json({ error: '発注する品目と数を選んでください' }, 400);
    if (supplier.method !== 'mail') {
      return c.json({ method: supplier.method, contact: supplier.contact, supplier: supplier.name, text: lines.join('\n') });
    }
    if (!supplier.contact) return c.json({ error: `仕入先「${supplier.name}」のメールアドレスがありません。仕入先に登録してください` }, 400);
    const view = await deps.tenantView(tenant.id);
    const def = view.resolve(INVENTORY_ORDER.id, INVENTORY_ORDER.version);
    if (!def || !view.isAvailable(INVENTORY_ORDER.id)) return c.json({ error: '発注の下書きの業務を使えません（Google と接続していないか、業務を止めています）' }, 409);
    const { runId } = await enqueueJob(deps.repo, {
      tenantId: tenant.id, requestedBy: user.id, def, origin: 'menu', actor: { type: 'user', id: user.id },
      input: { request: `${supplier.name}へ発注する`, supplier: supplier.name, to: supplier.contact, lines: lines.join('\n') },
    });
    return c.json({ method: 'mail', runId, supplier: supplier.name }, 201);
  });

  /** 見張りの結果（無くなる見込み・残りわずか・使用期限・発注の案。急ぐ順）。 */
  app.get('/forecast', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ rows: await service.forecast(tenant.id) });
  });

  /** スマホ用のページを開く QR（SVG。パソコンの画面の「スマホで開く」。第29.11.1節）。 */
  app.get('/mobile-qr.svg', async (c) => {
    const url = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}${MOBILE_INVENTORY_PATH}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'no-store');
    return c.body(svg);
  });

  /** 棚のラベル（QR）を A4 に並べた PDF（第29.7節）。`ids` を省けば、すべての場所。 */
  app.get('/locations/labels.pdf', async (c) => {
    const { tenant } = c.get('ctx');
    const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean);
    const all = await service.locations(tenant.id);
    const chosen = ids.length ? all.filter((l) => ids.includes(l.id)) : all;
    if (chosen.length === 0) return c.json({ error: '場所がありません' }, 404);
    const bytes = await renderShelfLabels(chosen, tenantOrigin(c.req.header('origin'), c.req.header('host')));
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `attachment; filename="shelf-labels.pdf"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  // ---- 棚卸し（第29.10節） ----

  /** 開いている棚卸し（無ければ `count: null`）と、最近の棚卸し。 */
  app.get('/counts', async (c) => {
    const { tenant } = c.get('ctx');
    const open = await service.openCount(tenant.id);
    return c.json({ open: open ? await service.countView(tenant.id, open.id) : null, recent: await service.store.listCounts(tenant.id, 10) });
  });

  /** 棚卸しを始める（開いていれば、それを続ける）。 */
  app.post('/counts', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json().catch(() => ({})) as { scope?: unknown; value?: unknown };
    const kind = b.scope === 'location' || b.scope === 'category' ? b.scope : 'all';
    const res = await service.startCount(tenant.id, user.id, { kind, value: str(b.value) });
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json({ view: await service.countView(tenant.id, res.count.id), created: res.created }, res.created ? 201 : 200);
  });

  app.get('/counts/:id', async (c) => {
    const { tenant } = c.get('ctx');
    const view = await service.countView(tenant.id, c.req.param('id'));
    if (!view) return c.json({ error: '棚卸しが見つかりません' }, 404);
    return c.json(view);
  });

  /** 数える（読むたびに 1 つ足す・数を足す・数え直して置き換える）。 */
  app.post('/counts/:id/lines', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const res = await service.recordCount(tenant.id, user.id, c.req.param('id'), {
      itemId: str(b['itemId']) ?? '', qty: typeof b['qty'] === 'number' ? b['qty'] : Number(b['qty'] ?? 1),
      mode: b['mode'] === 'set' ? 'set' : 'add', unit: b['unit'] === 'pack' ? 'pack' : 'unit',
      ...(str(b['locationId']) ? { locationId: str(b['locationId'])! } : {}),
      ...(str(b['lot']) ? { lot: str(b['lot'])! } : {}),
      ...(str(b['expiresOn']) ? { expiresOn: str(b['expiresOn'])! } : {}),
    });
    if ('error' in res) return c.json({ error: res.error }, 400);
    return c.json(res, 201);
  });

  /** 差の大きい品目の、考えられる理由（秘書の推測）。 */
  app.post('/counts/:id/explain', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ text: await service.explainCount(tenant.id, c.req.param('id')) });
  });

  /** 確定する（始めた人と管理者）。差の分を調整にし、数えていない行は 0 にしない。 */
  app.post('/counts/:id/close', async (c) => {
    const { tenant, user } = c.get('ctx');
    const res = await service.closeCount(tenant.id, user.id, c.req.param('id'), isAdmin(c));
    if ('error' in res) return c.json({ error: res.error }, res.error.includes('できるのは') ? 403 : 400);
    return c.json(res);
  });

  /** やめる（始めた人と管理者）。帳簿は変えない。 */
  app.post('/counts/:id/cancel', async (c) => {
    const { tenant, user } = c.get('ctx');
    const res = await service.cancelCount(tenant.id, user.id, c.req.param('id'), isAdmin(c));
    if ('error' in res) return c.json({ error: res.error }, res.error.includes('できるのは') ? 403 : 400);
    return c.json(res);
  });

  /** 棚卸しの結果を CSV で書き出す（監査ログに残す）。 */
  app.get('/counts/:id/export', async (c) => {
    const { tenant, user } = c.get('ctx');
    const table = await service.countRows(tenant.id, user.id, c.req.param('id'));
    if (!table) return c.json({ error: '棚卸しが見つかりません' }, 404);
    const bytes = await renderSheet('棚卸し', table.columns, table.rows, 'csv');
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="stocktake-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  /** CSV・Excel から品目を取り込む（第29.6節）。列の見出しは AI が読む。 */
  app.post('/import', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const f = form['file'];
    if (!(f instanceof File)) return c.json({ error: 'ファイルを選んでください' }, 400);
    if (f.size > IMPORT_MAX_BYTES) return c.json({ error: 'ファイルが大きすぎます（5 MB まで）' }, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const kind = zip || /\.xlsx$/i.test(f.name) ? 'xlsx' : 'csv';
    let rows;
    try {
      rows = (await readSheet(bytes, kind, { maxRows: IMPORT_MAX_ROWS + 1 })).rows;
    } catch {
      return c.json({ error: '表として読めませんでした（CSV か Excel のファイルを選んでください）' }, 400);
    }
    if (rows.length < 2) return c.json({ error: '見出しの行と、品目の行が要ります' }, 400);
    return c.json(await service.importRows(tenant.id, user.id, rows));
  });

  /** 品目と数を CSV・Excel で書き出す（監査ログに残す）。 */
  app.get('/export', async (c) => {
    const { tenant, user } = c.get('ctx');
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const { columns, rows } = await service.exportRows(tenant.id, user.id);
    const bytes = await renderSheet('在庫', columns, rows, format);
    const date = new Date().toISOString().slice(0, 10);
    c.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="inventory-${date}.${format}"`);
    return c.body(bytes as unknown as ArrayBuffer);
  });

  return app;
}
