/**
 * @file 意思決定支援の API（仕様書 第43章）。相談の一覧・開始・中身・順次の差分（SSE）・割り込み・止める・続ける・掘り下げる・材料の追加・共有・ゴミ箱。
 *
 * - 使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）。
 * - 中身は始めた人と共有された人だけに返す（第43.9節）。操作は始めた人だけ（処理の側で確かめる）。
 * - 討論はワーカーが進め、ここは置き場の差分を 0.5 秒ごとに読んで画面へ流す（`GET /:id/stream`。第43.11.2節）。
 *   つなぎ直したときは、画面が最後に受け取った番号（`Last-Event-ID` か `since`）より後の差分から流す。
 */

import { Hono, type Context } from 'hono';
import { DecisionError, DECISIONS_UNAVAILABLE, type DecisionViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** 差分を読む間隔（ミリ秒）。 */
const STREAM_TICK_MS = Number(process.env['DECISIONS_STREAM_TICK_MS'] ?? 500);
/** 何も変わらないときの合図の間隔（串に切られないように）。 */
const STREAM_HEARTBEAT_MS = 15_000;
/** 1 本の流れを開いておく上限（つなぎ直しは画面が行う）。 */
const STREAM_MAX_MS = 30 * 60_000;

export function decisionsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.decisions;
  const who = (c: Context<AppEnv>): DecisionViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  /** 処理の失敗を、状態の番号つきで返す。 */
  const fail = (c: Context<AppEnv>, err: unknown) => {
    if (err instanceof DecisionError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.decisions.access(tenant.id, user.id))) return c.json({ error: DECISIONS_UNAVAILABLE }, 403);
    await next();
  });

  /** 自分の相談と、共有された相談の一覧。 */
  app.get('/', async (c) => c.json({ items: await service.list(who(c)) }));

  /** 相談を始める（討論はワーカーが進める）。 */
  app.post('/', async (c) => {
    const body = await c.req.json<{ topic?: unknown; turns?: unknown; crossCheck?: unknown; fileIds?: unknown }>().catch(() => ({} as Record<string, unknown>));
    try {
      const s = await service.start(who(c), {
        topic: typeof body.topic === 'string' ? body.topic : '',
        ...(typeof body.turns === 'number' ? { turns: body.turns } : {}),
        crossCheck: body.crossCheck === true,
        fileIds: Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === 'string') : [],
      });
      return c.json({ id: s.id }, 201);
    } catch (err) { return fail(c, err); }
  });

  /** 共有の相手に選べる人。 */
  app.get('/people', async (c) => c.json({ items: await service.people(who(c)) }));

  /** 相談の中身（全文・主張・優勢の推移・材料）。 */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const d = ID.test(id) ? await service.detail(who(c), id) : null;
    return d ? c.json(d) : c.json({ error: '相談が見つかりません' }, 404);
  });

  /** 順次の差分（SSE）。 */
  app.get('/:id/stream', async (c) => {
    const id = c.req.param('id');
    const w = who(c);
    if (!ID.test(id) || !(await service.changes(w, id, Number.MAX_SAFE_INTEGER))) return c.json({ error: '相談が見つかりません' }, 404);
    const fromHeader = Number(c.req.header('last-event-id') ?? NaN);
    const fromQuery = Number(c.req.query('since') ?? NaN);
    let since = Number.isFinite(fromHeader) ? fromHeader : Number.isFinite(fromQuery) ? fromQuery : 0;
    const log = c.get('log');
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (text: string) => controller.enqueue(enc.encode(text));
        let closed = false;
        let lastBeat = Date.now();
        const opened = Date.now();
        c.req.raw.signal.addEventListener('abort', () => { closed = true; });
        send('retry: 2000\n\n');
        while (!closed && Date.now() - opened < STREAM_MAX_MS) {
          try {
            const ev = await service.changes(w, id, since);
            if (!ev) { send('event: gone\ndata: {}\n\n'); break; }
            if (ev.rev > since) {
              since = ev.rev;
              send(`id: ${ev.rev}\nevent: change\ndata: ${JSON.stringify(ev)}\n\n`);
              lastBeat = Date.now();
            } else if (Date.now() - lastBeat >= STREAM_HEARTBEAT_MS) {
              send(': 心拍\n\n');
              lastBeat = Date.now();
            }
          } catch (err) {
            log.warn('意思決定支援の差分の送信で例外が発生しました', { err });
            break;
          }
          await new Promise((r) => setTimeout(r, STREAM_TICK_MS));
        }
        try { controller.close(); } catch { /* すでに閉じている */ }
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  });

  /** 経営者の一言（事実の訂正・材料の追加）。 */
  app.post('/:id/interject', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({} as { text?: unknown }));
    try {
      await service.interject(who(c), id, typeof body.text === 'string' ? body.text : '');
      return c.json({ ok: true });
    } catch (err) { return fail(c, err); }
  });

  /** 止める。 */
  app.post('/:id/stop', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    try { await service.stop(who(c), id); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
  });

  /** 続ける（ターン数を指定）。 */
  app.post('/:id/continue', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    const body = await c.req.json<{ turns?: unknown }>().catch(() => ({} as { turns?: unknown }));
    try { await service.continueDebate(who(c), id, body.turns); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
  });

  /** この論点を掘り下げる。 */
  app.post('/:id/dig', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    const body = await c.req.json<{ issue?: unknown; turns?: unknown }>().catch(() => ({} as { issue?: unknown; turns?: unknown }));
    try { await service.dig(who(c), id, typeof body.issue === 'string' ? body.issue : '', body.turns); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
  });

  /** 添付を材料に足す。 */
  app.post('/:id/materials', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    const body = await c.req.json<{ fileId?: unknown }>().catch(() => ({} as { fileId?: unknown }));
    if (typeof body.fileId !== 'string' || !ID.test(body.fileId)) return c.json({ error: 'ファイルが見つかりません' }, 404);
    try { return c.json({ material: await service.addMaterial(who(c), id, body.fileId) }); } catch (err) { return fail(c, err); }
  });

  /** 共有する人を決める（見るだけ）。 */
  app.put('/:id/shares', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    const body = await c.req.json<{ userIds?: unknown }>().catch(() => ({} as { userIds?: unknown }));
    const ids = Array.isArray(body.userIds) ? body.userIds.filter((x): x is string => typeof x === 'string' && ID.test(x)) : [];
    try { await service.share(who(c), id, ids); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
  });

  /** ゴミ箱に入れる（30 日後に消す）。 */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID.test(id)) return c.json({ error: '相談が見つかりません' }, 404);
    try { await service.trash(who(c), id); return c.json({ ok: true }); } catch (err) { return fail(c, err); }
  });

  return app;
}
