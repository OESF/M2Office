/**
 * @file 資料（内蔵の拡張）の API。一覧と絞り込み・ファイルを入れる・ドライブで選ぶ・1 件・直す・読み直す・削除・費用の目安（第44章）。
 *
 * 会社が切っているときと、利用範囲の外の人には、どの口も使わせない。見えるのは本人の資料だけで、管理者にも見せない（第44.8節）。
 * 運営の代理アクセスからは見せない（第23.6節）。監査ログは処理（LibraryService）が残す。
 *
 * @see 仕様書 第44章
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LIBRARY_ENTRY_LABELS, LIBRARY_LIMITS, type LibraryEntry, type LibraryFilter } from '@m2office/shared';
import type { LibraryViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { driveFilesFor } from '../drive-files.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^lib-[A-Za-z0-9-]{1,60}$/;
/** 受け取りの上限（ファイルの上限に、multipart の余白を足す）。 */
const BODY_MAX = LIBRARY_LIMITS.placeBytes + 1024 * 1024;

/**
 * 資料の API（仕様書 第44章）。
 *
 * @remarks 危険度: どの口も本人の資料だけを扱い、社外に何も出さない。共有の口は段 3 で足す
 */
export function libraryRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.library;
  const drive = driveFilesFor(deps);
  const who = (c: Context<AppEnv>): LibraryViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  const notFound = (c: Context<AppEnv>) => c.json({ error: '資料が見つかりません' }, 404);

  // 資料を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.library.access(tenant.id, user.id))) {
      return c.json({ error: '資料は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 一覧（絞り込み）と、絞り込みの選択肢・読み取りの進み具合・ドライブに置けるか。 */
  app.get('/', async (c) => {
    const q = c.req.query();
    const entry = q['entry'] ?? '';
    const year = Number(q['year']);
    const filter: LibraryFilter = {
      q: (q['q'] ?? '').slice(0, LIBRARY_LIMITS.queryChars),
      ...(q['docType'] ? { docType: q['docType'] } : {}),
      ...(q['counterparty'] ? { counterparty: q['counterparty'] } : {}),
      ...(Number.isInteger(year) && year >= 1900 && year <= 2200 ? { year } : {}),
      ...(entry in LIBRARY_ENTRY_LABELS ? { entry: entry as LibraryEntry } : {}),
      offset: Math.max(Number(q['offset']) || 0, 0),
    };
    const me = who(c);
    const [list, facets, progress, connected, picker] = await Promise.all([
      service.list(me, filter), service.facets(me), service.progress(me), googleReady(me), drive.available(me).catch(() => false),
    ]);
    return c.json({ ...list, facets, progress, google: connected, picker });
  });

  /** ドライブに置ける状態か（本人の Google の接続と `drive.file`）。 */
  const googleReady = async (me: LibraryViewer): Promise<boolean> => {
    if (deps.connector.sourceFor(me.tenantId) === 'mock') return true;
    const conn = await deps.repo.getGoogleConnection(me.tenantId, me.userId);
    return !!conn && conn.scopes.includes('drive.file');
  };

  /** ファイルを 1 つ入れる（本文: `file`・`folder`）。同じ中身があれば入口の記録だけを足す。 */
  app.post('/items',
    bodyLimit({ maxSize: BODY_MAX, onError: (c) => c.json({ error: 'ファイルが大きすぎます（100 MB まで）' }, 413) }),
    async (c) => {
      const form = await c.req.parseBody();
      const file = form['file'];
      if (!(file instanceof File)) return c.json({ error: 'file を指定してください' }, 400);
      const folder = typeof form['folder'] === 'string' ? form['folder'] : '';
      const r = await service.importFile(who(c), { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), folder });
      if ('error' in r) return c.json({ error: r.error }, r.status);
      return c.json(r, r.duplicate ? 200 : 201);
    });

  /** 渡したハッシュのうち、もう資料にあるもの（途切れた取り込みの続きのため。第44.3節）。 */
  app.post('/check', async (c) => {
    const b = await c.req.json<{ hashes?: unknown }>().catch(() => ({} as { hashes?: unknown }));
    return c.json({ existing: await service.existing(who(c), b.hashes) });
  });

  /** 件数からの費用の目安（第44.11節）。`jpy` は目安を出せなければ `null`。 */
  app.get('/estimate', async (c) => {
    const count = Math.min(Math.max(Math.floor(Number(c.req.query('count')) || 0), 0), 1_000_000);
    return c.json({ count, jpy: await service.estimate(who(c).tenantId, count), confirmOver: LIBRARY_LIMITS.confirmCount });
  });

  /** Google のファイル選びの材料（`drive.file` だけに絞ったトークン。見本の会社は見本のドライブの一覧）。 */
  app.get('/drive-picker', async (c) => {
    const r = await drive.picker(who(c));
    return 'error' in r ? c.json(r, 400) : c.json(r, 200, { 'cache-control': 'no-store' });
  });

  /** 本人がドライブで選んだファイルを目録に載せる（本文: `fileId`）。ファイルは動かさない。 */
  app.post('/from-drive', async (c) => {
    const b = await c.req.json<{ fileId?: unknown }>().catch(() => ({} as { fileId?: unknown }));
    const r = await service.addFromDrive(who(c), typeof b.fileId === 'string' ? b.fileId : '');
    if ('error' in r) return c.json({ error: r.error }, r.status);
    return c.json(r, r.duplicate ? 200 : 201);
  });

  app.use('/:id/*', async (c, next) => (ID.test(c.req.param('id')) ? next() : notFound(c)));

  /** 1 件（入口の記録つき）。 */
  app.get('/:id', async (c) => {
    if (!ID.test(c.req.param('id'))) return notFound(c);
    const item = await service.get(who(c), c.req.param('id'));
    return item ? c.json(item) : notFound(c);
  });

  /** 題名・種類・取引先・日付を直す。 */
  app.patch('/:id', async (c) => {
    if (!ID.test(c.req.param('id'))) return notFound(c);
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.update(who(c), c.req.param('id'), b);
    if ('error' in r) return c.json(r, r.error.includes('見つかりません') ? 404 : 400);
    return c.json(r);
  });

  /** もう一度読む。 */
  app.post('/:id/reread', async (c) => {
    const r = await service.reread(who(c), c.req.param('id'));
    return r ? c.json(r) : notFound(c);
  });

  /** 削除（目録から消す。M2Office が置いたファイルはドライブのごみ箱へ）。 */
  app.delete('/:id', async (c) => {
    if (!ID.test(c.req.param('id'))) return notFound(c);
    const r = await service.remove(who(c), c.req.param('id'));
    if ('error' in r) return c.json({ error: r.error }, r.status);
    return c.json({ ok: true, ...r });
  });

  return app;
}
