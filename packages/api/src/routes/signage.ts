/**
 * @file 店頭サイネージ（内蔵の拡張）の使う人の API。画面の一覧と状態・画面の名前と向きと回し方と音の大きさ・流れ・素材（段 1）、
 * 割り込み・よく出す案内・割り込みの素材・スタッフのページの QR（段 2）。
 *
 * 会社がサイネージを切っているときと、利用範囲の外の人には、どの口も使わせない。
 * 画面と素材は会社で共有する。画面の登録と取り外しは管理者の API（`/v1/admin/extensions/signage`）で行う。
 *
 * @see 仕様書 第31章 店頭サイネージ・第31.15.2節
 */

import { Hono } from 'hono';
import QRCode from 'qrcode';
import { assetKey } from '@m2office/core';
import { SIGNAGE_LIMITS } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { receiveToTemp, serveAsset } from '../signage-files.js';
import { tenantOrigin } from '../tenant-origin.js';

/**
 * 店頭サイネージの使う人の API（`/v1/signage`）。
 *
 * @remarks テナント境界: 処理と置き場が会社ごとに絞る（不変則 I-2）。流れの 1 回ずつの直しは 10 分の間 1 件にまとめて監査ログに残す
 */
export function signageRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service, interrupts } = deps.signage;

  // サイネージを使えない会社・人には、どの口も使わせない（第31.2節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.signage.access(tenant.id, user.id))) {
      return c.json({ error: '店頭サイネージは使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 画面の一覧と状態・使っている容量と上限・管理者か。 */
  app.get('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    return c.json({ ...(await service.overview(tenant.id)), admin: user.roles.includes('admin') });
  });

  /** 画面の名前・向き・回し方を直す（利用範囲の全員）。 */
  app.patch('/screens/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.updateScreen(tenant.id, user.id, c.req.param('id'), { name: b['name'], orientation: b['orientation'], rotation: b['rotation'], volume: b['volume'] });
    return 'error' in r ? c.json(r, r.error === '画面が見つかりません' ? 404 : 400) : c.json(r);
  });

  /** 画面の流れと版（`band`: 時間帯の ID。無ければいつもの流れ。答えに時間帯の一覧。第31.6.6節）。 */
  app.get('/screens/:id/entries', async (c) => {
    const { tenant } = c.get('ctx');
    const f = await service.flow(tenant.id, c.req.param('id'), c.req.query('band') || null);
    return f ? c.json(f) : c.json({ error: '画面か時間帯が見つかりません' }, 404);
  });

  /** 流れを並びごと置き換える（`entries`・読んだ版 `version`。違えば 409。`band`: 時間帯の ID）。 */
  app.put('/screens/:id/entries', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ entries?: unknown; version?: unknown }>().catch(() => ({} as { entries?: unknown; version?: unknown }));
    const r = await service.replaceFlow(tenant.id, user.id, c.req.param('id'), b.entries, b.version, c.req.query('band') || null);
    return 'error' in r ? c.json({ error: r.error }, r.status as 400) : c.json(r);
  });

  /** 時間帯を足す（`start`・`end`: HH:MM、`days`: 曜日のビット。画面ごとに 3 つまで。重なれば 409。第31.6.6節）。 */
  app.post('/screens/:id/bands', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.addBand(tenant.id, user.id, c.req.param('id'), { start: b['start'], end: b['end'], days: b['days'] });
    return 'error' in r ? c.json({ error: r.error }, r.status as 400) : c.json(r, 201);
  });

  /** 時間帯の時刻と曜日を直す。 */
  app.patch('/bands/:bandId', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.updateBand(tenant.id, user.id, c.req.param('bandId'), { start: b['start'], end: b['end'], days: b['days'] });
    return 'error' in r ? c.json({ error: r.error }, r.status as 400) : c.json(r);
  });

  /** 時間帯と、その流れを削除する（素材は残る）。 */
  app.delete('/bands/:bandId', async (c) => {
    const { tenant, user } = c.get('ctx');
    return (await service.deleteBand(tenant.id, user.id, c.req.param('bandId'))) ? c.json({ ok: true }) : c.json({ error: '時間帯が見つかりません' }, 404);
  });

  /** 素材の一覧（どの画面の流れに入っているかつき）。 */
  app.get('/assets', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ assets: await service.listAssets(tenant.id) });
  });

  /**
   * 素材を足す。本文はファイルの中身そのもの（画面で縮めた画像か MP4）。名前は `x-file-name`（URL の形に符号化）、
   * 画面で調べた縦横は `x-width`・`x-height`。形式・大きさ・縦横・長さはサーバーでも確かめ直す（第31.6.1節）。
   */
  app.post('/assets', async (c) => {
    const { tenant, user } = c.get('ctx');
    const got = await receiveToTemp(c.req.raw.body, SIGNAGE_LIMITS.videoBytes);
    if ('error' in got) return c.json({ error: got.error }, got.status as 400);
    let name = '';
    try { name = decodeURIComponent(c.req.header('x-file-name') ?? ''); } catch { name = ''; }
    name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const r = await service.addAsset(tenant.id, user.id, {
      ...got, mime: c.req.header('content-type') ?? '', name, thumbnail: null,
      width: Number(c.req.header('x-width')) || undefined, height: Number(c.req.header('x-height')) || undefined,
    });
    return 'error' in r ? c.json({ error: r.error }, r.status as 400) : c.json(r, r.existing ? 200 : 201);
  });

  /** 縮小画像を入れる（本文は JPEG。100 KB まで）。 */
  app.put('/assets/:id/thumbnail', async (c) => {
    const { tenant } = c.get('ctx');
    const buf = new Uint8Array(await c.req.arrayBuffer());
    const r = await service.setThumbnail(tenant.id, c.req.param('id'), buf);
    return 'error' in r ? c.json(r, r.error === '素材が見つかりません' ? 404 : 400) : c.json(r);
  });

  /** 素材の名前を直す（`name`）・割り込みの素材にする（`isInterrupt`）・その音（`jingle`）。 */
  app.patch('/assets/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ name?: unknown; isInterrupt?: unknown; jingle?: unknown }>().catch(() => ({} as { name?: unknown; isInterrupt?: unknown; jingle?: unknown }));
    let out: unknown = null;
    if (b.name !== undefined) {
      const r = await service.renameAsset(tenant.id, user.id, c.req.param('id'), b.name);
      if ('error' in r) return c.json(r, r.error === '素材が見つかりません' ? 404 : 400);
      out = r;
    }
    if (b.isInterrupt !== undefined || b.jingle !== undefined) {
      const r = await service.setInterruptAsset(tenant.id, user.id, c.req.param('id'), { isInterrupt: b.isInterrupt, jingle: b.jingle });
      if ('error' in r) return c.json(r, r.error === '素材が見つかりません' ? 404 : 400);
      out = r;
    }
    return out ? c.json(out) : c.json({ error: '直す項目がありません' }, 400);
  });

  /** 素材を消す（流れに入っていても断らず、流れからも外す。外した画面の名前を返す）。 */
  app.delete('/assets/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await service.deleteAsset(tenant.id, user.id, c.req.param('id'));
    return r ? c.json(r) : c.json({ error: '素材が見つかりません' }, 404);
  });

  /** 素材の中身（`Range` に応じる。HTML は源の無い文書として開く見出しを付ける。第31.6.3節）。 */
  app.get('/assets/:id/content', async (c) => {
    const { tenant } = c.get('ctx');
    const a = await deps.signage.service.deps.store.getAsset(tenant.id, c.req.param('id'));
    if (!a) return c.json({ error: '素材が見つかりません' }, 404);
    return serveAsset(deps.files, tenant.id, assetKey(a.id), a.mime, c.req.header('range'));
  });

  /** 割り込みを出す（文・番号と場所・割り込みの素材・出す先・秒数・ジングル。第31.7.2節）。 */
  app.post('/interrupts', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
    const r = await interrupts.create(tenant.id, user.id, {
      ...(str(b['text']) !== undefined ? { text: str(b['text']) } : {}),
      ...(str(b['number']) !== undefined ? { number: str(b['number']) } : {}),
      ...(str(b['place']) !== undefined ? { place: str(b['place']) } : {}),
      ...(typeof b['assetId'] === 'string' ? { assetId: b['assetId'] } : {}),
      ...(Array.isArray(b['screens']) ? { screens: b['screens'].filter((x): x is string => typeof x === 'string') } : {}),
      ...(b['seconds'] !== undefined ? { seconds: Number(b['seconds']) } : {}),
      ...(typeof b['chime'] === 'boolean' ? { chime: b['chime'] } : {}),
      ...(typeof b['jingle'] === 'string' ? { jingle: b['jingle'] } : {}),
    }, 'staff');
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r, 201);
  });

  /** 最近 24 時間の割り込みと、画面ごとのいま（出しているもの・待っている数）。 */
  app.get('/interrupts', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ interrupts: await interrupts.recent(tenant.id) });
  });

  /** その割り込みを消す（出しているすべての画面から。待っているものも外す）。 */
  app.post('/interrupts/:id/clear', async (c) => {
    const { tenant, user } = c.get('ctx');
    return c.json({ cleared: await interrupts.clear(tenant.id, user.id, c.req.param('id')) });
  });

  /** すべて消す（`screens` で画面を選べる。無ければすべての画面）。 */
  app.post('/clear', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ screens?: unknown }>().catch(() => ({} as { screens?: unknown }));
    const screens = Array.isArray(b.screens) ? b.screens.filter((x): x is string => typeof x === 'string') : undefined;
    return c.json({ cleared: await interrupts.clearAll(tenant.id, user.id, screens) });
  });

  /** よく出す案内（番号を空けた形。最近 14 日の回数の多い順）と、割り込みの素材の回数。 */
  app.get('/phrases', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json(await interrupts.phrases(tenant.id));
  });

  /** よく出す案内を外す（また 3 回使うまで出さない）。 */
  app.post('/phrases/:id/hide', async (c) => {
    const { tenant } = c.get('ctx');
    return (await service.deps.store.hidePhrase(tenant.id, c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: '見つかりません' }, 404);
  });

  /** 会社のジングルの音の一覧（割り込みの素材の音を選ぶため）。 */
  app.get('/sounds', async (c) => {
    const { tenant } = c.get('ctx');
    return c.json({ sounds: await service.deps.store.listSounds(tenant.id) });
  });

  /** スタッフのページ（/m/signage）を開く QR（パソコンの画面の「スマホで開く」）。 */
  app.get('/mobile-qr.svg', async (c) => {
    const url = `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/m/signage`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return c.body(svg, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
  });

  /** 縮小画像（JPEG）。 */
  app.get('/assets/:id/thumbnail', async (c) => {
    const { tenant } = c.get('ctx');
    // 縮小画像の無い画像の素材は、その場で作って残す（第 0.259.1 版）。種類は中身に合わせる
    const t = await deps.signage.service.thumbnail(tenant.id, c.req.param('id'));
    if (!t) return c.json({ error: '縮小画像がありません' }, 404);
    return new Response(Buffer.from(t.bytes), {
      headers: { 'content-type': t.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=86400' },
    });
  });

  return app;
}
