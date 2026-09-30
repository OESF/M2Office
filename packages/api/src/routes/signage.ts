/**
 * @file 店頭サイネージ（内蔵の拡張）の使う人の API（段 1）。画面の一覧と状態・画面の名前と向きと回し方・流れ・素材。
 *
 * 会社がサイネージを切っているときと、利用範囲の外の人には、どの口も使わせない。
 * 画面と素材は会社で共有する。画面の登録と取り外しは管理者の API（`/v1/admin/extensions/signage`）で行う。
 *
 * @see 仕様書 第31章 店頭サイネージ・第31.15.2節
 */

import { Hono } from 'hono';
import { assetKey } from '@m2office/core';
import { SIGNAGE_LIMITS } from '@m2office/shared';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { receiveToTemp, serveAsset } from '../signage-files.js';

/**
 * 店頭サイネージの使う人の API（`/v1/signage`）。
 *
 * @remarks テナント境界: 処理と置き場が会社ごとに絞る（不変則 I-2）。流れの 1 回ずつの直しは 10 分の間 1 件にまとめて監査ログに残す
 */
export function signageRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.signage;

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
    const r = await service.updateScreen(tenant.id, user.id, c.req.param('id'), { name: b['name'], orientation: b['orientation'], rotation: b['rotation'] });
    return 'error' in r ? c.json(r, r.error === '画面が見つかりません' ? 404 : 400) : c.json(r);
  });

  /** 画面の流れと版。 */
  app.get('/screens/:id/entries', async (c) => {
    const { tenant } = c.get('ctx');
    const f = await service.flow(tenant.id, c.req.param('id'));
    return f ? c.json(f) : c.json({ error: '画面が見つかりません' }, 404);
  });

  /** 流れを並びごと置き換える（`entries`・読んだ版 `version`。違えば 409）。 */
  app.put('/screens/:id/entries', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ entries?: unknown; version?: unknown }>().catch(() => ({} as { entries?: unknown; version?: unknown }));
    const r = await service.replaceFlow(tenant.id, user.id, c.req.param('id'), b.entries, b.version);
    return 'error' in r ? c.json({ error: r.error }, r.status as 400) : c.json(r);
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

  /** 素材の名前を直す。 */
  app.patch('/assets/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
    const r = await service.renameAsset(tenant.id, user.id, c.req.param('id'), b.name);
    return 'error' in r ? c.json(r, r.error === '素材が見つかりません' ? 404 : 400) : c.json(r);
  });

  /** 素材を消す（流れに入っていても断らず、流れからも外す。外した画面の名前を返す）。 */
  app.delete('/assets/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await service.deleteAsset(tenant.id, user.id, c.req.param('id'));
    return r ? c.json(r) : c.json({ error: '素材が見つかりません' }, 404);
  });

  /** 素材の中身（`Range` に応じる）。 */
  app.get('/assets/:id/content', async (c) => {
    const { tenant } = c.get('ctx');
    const a = await deps.signage.service.deps.store.getAsset(tenant.id, c.req.param('id'));
    if (!a) return c.json({ error: '素材が見つかりません' }, 404);
    return serveAsset(deps.files, tenant.id, assetKey(a.id), a.mime, c.req.header('range'));
  });

  /** 縮小画像（JPEG）。 */
  app.get('/assets/:id/thumbnail', async (c) => {
    const { tenant } = c.get('ctx');
    const t = await deps.signage.service.deps.store.getThumbnail(tenant.id, c.req.param('id'));
    if (!t) return c.json({ error: '縮小画像がありません' }, 404);
    return new Response(Buffer.from(t), {
      headers: { 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=86400' },
    });
  });

  return app;
}
