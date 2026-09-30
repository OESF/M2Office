/**
 * @file 店頭サイネージの再生のページ（端末）の API（段 1）。登録の番号と QR・登録されたかの問い合わせ・状態・素材・即時の知らせ・生きている知らせ。
 *
 * **ログインを使わない。** 会社はアドレスで決まり、端末は画面の鍵（`Authorization: Bearer`）で名乗る（第31.5.1節・第31.15.2節）。
 * 鍵は URL に載せない。鍵が無い・効かない・違う会社の鍵は 401、サイネージを切った会社は 404（緊急停止・解約は会社の判定で 403）。
 * 画面の鍵で読めるのは、その画面の流れと素材・再生に要る会社の設定だけ。割り込みを出す・流れを変える・ほかの画面を読むことはできない。
 *
 * @see 仕様書 第31.9.1節・第31.15.2節
 */

import { Hono, type Context } from 'hono';
import QRCode from 'qrcode';
import { assetKey, type ScreenRecord } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';
import { serveAsset } from '../signage-files.js';

/** 登録の番号を作れる回数（同じ接続元から 1 時間に。第31.5.1節）。 */
const PAIRING_PER_HOUR = 20;
/** 即時の知らせで、画面の状態を確かめ直す間隔。 */
const EVENTS_CHECK_MS = Number(process.env['SIGNAGE_EVENTS_CHECK_MS'] ?? 5000);
/** 即時の知らせの心拍の間隔。 */
const EVENTS_HEARTBEAT_MS = 15_000;

type C = Context<AppEnv & { Variables: { screen: ScreenRecord } }>;

/**
 * 再生のページの API（`/v1/signage-play`）。
 *
 * @param version サーバーの版（生きている知らせの答えに入れ、ページが古ければ読み直させる）
 * @remarks テナント境界: 会社はアドレスで決まり、画面の鍵はその会社の中でだけ引く（不変則 I-2）
 */
export function signagePlayRoute(deps: AppDeps, version: string | null) {
  const app = new Hono<AppEnv & { Variables: { screen: ScreenRecord } }>();
  const { service, interrupts } = deps.signage;
  const pairingHits = new Map<string, number[]>();

  const enabled = async (tenantId: string) => (await deps.repo.getTenantSettings(tenantId)).signage.enabled;
  const bearer = (c: C) => /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? null;

  // 登録の前の口（番号・QR・問い合わせ）はサイネージを入れた会社だけ。鍵の口は画面の鍵で名乗る
  app.use('*', async (c, next) => {
    const tenant = c.get('tenant');
    if (!(await enabled(tenant.id))) return c.json({ error: 'サイネージを使っていません' }, 404);
    if (c.req.path.includes('/pairings')) return next();
    const screen = await service.screenByKey(tenant.id, bearer(c));
    if (!screen) return c.json({ error: '画面の鍵が効きません' }, 401);
    c.set('screen', screen);
    await next();
  });

  /** 登録の番号を作る（本文: 登録の合言葉 `secret`・画面の縦横 `viewport`）。 */
  app.post('/pairings', async (c) => {
    const tenant = c.get('tenant');
    const who = (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'local';
    const now = Date.now();
    const hits = (pairingHits.get(who) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= PAIRING_PER_HOUR) return c.json({ error: '登録の番号を作りすぎました。しばらく待ってからお試しください' }, 429);
    pairingHits.set(who, [...hits, now]);
    const b = await c.req.json<{ secret?: unknown; viewport?: unknown }>().catch(() => ({} as { secret?: unknown; viewport?: unknown }));
    const r = await service.createPairing(tenant.id, b.secret, b.viewport);
    return 'error' in r ? c.json(r, 400) : c.json(r, 201);
  });

  /** 登録の QR（番号の入った登録のページの URL だけを描く）。 */
  app.get('/pairings/qr.svg', async (c) => {
    const code = c.req.query('code') ?? '';
    if (!/^\d{6}$/.test(code)) return c.json({ error: '番号が違います' }, 400);
    const url = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/m/signage/pair?code=${code}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  });

  /** 登録されたか（本文: 登録の合言葉 `secret`）。登録されていれば画面の鍵を 1 度だけ返す。 */
  app.post('/pairings/poll', async (c) => {
    const tenant = c.get('tenant');
    const b = await c.req.json<{ secret?: unknown }>().catch(() => ({} as { secret?: unknown }));
    return c.json(await service.pollPairing(tenant.id, b.secret));
  });

  /** 画面の設定・流れと版・素材（割り込みの素材を含む）・会社の音・店の色・会社の名前・サーバーの時刻・待っている割り込み。 */
  app.get('/state', async (c) => {
    const tenant = c.get('tenant');
    return c.json({
      ...(await service.playState(tenant.id, c.get('screen'))), pageVersion: version,
      interrupts: await interrupts.pending(tenant.id, c.get('screen').id),
    });
  });

  /** 待っている割り込みと出している割り込み（経過はサーバーが数える。2 分を過ぎたものは出さない。第31.9.2節）。 */
  app.get('/interrupts', async (c) => {
    const tenant = c.get('tenant');
    return c.json({ interrupts: await interrupts.pending(tenant.id, c.get('screen').id) });
  });

  /** 割り込みを出し始めた。 */
  app.post('/interrupts/:id/started', async (c) => {
    const tenant = c.get('tenant');
    return c.json({ ok: await interrupts.started(tenant.id, c.get('screen').id, c.req.param('id')) });
  });

  /** 割り込みを出し終えた（秒数が過ぎた）。停止中も受ける。 */
  app.post('/interrupts/:id/ended', async (c) => {
    const tenant = c.get('tenant');
    return c.json({ ok: await interrupts.ended(tenant.id, c.get('screen').id, c.req.param('id')) });
  });

  /** 会社のジングルの音の中身。 */
  app.get('/sounds/:id', async (c) => {
    const tenant = c.get('tenant');
    const s = await service.deps.store.getSound(tenant.id, c.req.param('id'));
    if (!s) return c.json({ error: '音がありません' }, 404);
    return new Response(Buffer.from(s.data), { headers: { 'content-type': s.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' } });
  });

  /** 素材の中身（その画面の流れの素材だけ。`Range` に応じる）。 */
  app.get('/assets/:id', async (c) => {
    const tenant = c.get('tenant');
    const a = await service.screenCanRead(tenant.id, c.get('screen').id, c.req.param('id'));
    if (!a) return c.json({ error: '素材が見つかりません' }, 404);
    return serveAsset(deps.files, tenant.id, assetKey(a.id), a.mime, c.req.header('range'));
  });

  /** 素材の縮小画像（その画面の流れの素材だけ。動画の余白にぼかして敷く。第31.6.2節）。 */
  app.get('/assets/:id/thumbnail', async (c) => {
    const tenant = c.get('tenant');
    const a = await service.screenCanRead(tenant.id, c.get('screen').id, c.req.param('id'));
    const t = a ? await service.deps.store.getThumbnail(tenant.id, a.id) : null;
    if (!t) return c.json({ error: '縮小画像がありません' }, 404);
    return new Response(Buffer.from(t), { headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=86400' } });
  });

  /** 生きている知らせ（第31.5.1節）。答えにサーバーの時刻・流れの版・ページの版。 */
  app.post('/heartbeat', async (c) => {
    const tenant = c.get('tenant');
    const b = await c.req.json<unknown>().catch(() => null);
    return c.json({ ...(await service.heartbeat(tenant.id, c.get('screen'), b)), pageVersion: version });
  });

  /**
   * 即時の知らせ（SSE）。「流れが変わった（flow）」「画面の設定が変わった（screen）」「会社の設定が変わった（settings）」「外された（removed）」、
   * 「割り込み（interrupt）」「消す（clear）」「音の大きさ（volume）」。
   * 15 秒ごとに心拍を送る。知らせが届かない場合に備え、画面の状態も確かめ直す。
   */
  app.get('/events', (c) => {
    const tenant = c.get('tenant');
    const first = c.get('screen');
    const enc = new TextEncoder();
    let stop = () => undefined as void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let lastVersion = first.flowVersion;
        let lastRotation = first.rotation;
        const send = (event: string) => { if (!closed) controller.enqueue(enc.encode(`event: ${event}\ndata: {}\n\n`)); };
        const onChange = (kind: string) => {
          send(kind);
          if (kind === 'removed') stop();
        };
        const keys = [`${tenant.id}:${first.id}`, `${tenant.id}:*`];
        for (const k of keys) service.changes.on(k, onChange);
        const beat = setInterval(() => { if (!closed) controller.enqueue(enc.encode(': 心拍\n\n')); }, EVENTS_HEARTBEAT_MS);
        const check = setInterval(() => {
          void (async () => {
            const s = await service.deps.store.getScreen(tenant.id, first.id);
            if (!s || s.status !== 'active') { onChange('removed'); return; }
            if (!(await enabled(tenant.id))) { send('settings'); stop(); return; }
            if (s.flowVersion !== lastVersion) { lastVersion = s.flowVersion; send('flow'); }
            if (s.rotation !== lastRotation) { lastRotation = s.rotation; send('screen'); }
          })().catch(() => undefined);
        }, EVENTS_CHECK_MS);
        stop = () => {
          if (closed) return;
          closed = true;
          clearInterval(beat);
          clearInterval(check);
          for (const k of keys) service.changes.off(k, onChange);
          try { controller.close(); } catch { /* 閉じ済み */ }
        };
        c.req.raw.signal.addEventListener('abort', () => stop());
        send('hello');
        void service.deps.store.touchScreen(tenant.id, first.id, null).catch(() => undefined);
      },
      cancel() { stop(); },
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
  });

  return app;
}
