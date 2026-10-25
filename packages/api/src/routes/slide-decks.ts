/**
 * @file 作ったスライドの API。一覧（本人のものと会社で共有されたもの）・1 件・共有の切り替え・削除（仕様書 第9.4.2節「作ったスライドの扱い」、Q-264）。
 *
 * 作り直すのは業務「スライドの作成」の実行（`POST /v1/runs` に `deckId` と直す頼みを渡す）で行い、この道では行わない。
 * 共有の切り替えと削除は作った人だけ。会社で共有は会社の Workspace のドメインへの閲覧だけで、社外には出さない（境界 2）。
 */

import { Hono, type Context } from 'hono';
import type { SlideDeckViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 作ったスライドの API（仕様書 第9.4.2節「作ったスライドの扱い」）。
 */
export function slideDecksRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const service = deps.slideDecks;
  const who = (c: Context<AppEnv>): SlideDeckViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  app.use('/:id/*', async (c, next) => (ID.test(c.req.param('id')) ? next() : c.json({ error: 'スライドが見つかりません' }, 404)));
  app.use('/:id', async (c, next) => (ID.test(c.req.param('id')) ? next() : c.json({ error: 'スライドが見つかりません' }, 404)));

  /** 本人が作ったもの（mine）と、会社で共有されたもの（shared）。新しい順。 */
  app.get('/', async (c) => c.json(await service.list(who(c))));

  /** 1 件（本人のものか会社で共有されたもの）。 */
  app.get('/:id', async (c) => {
    const d = await service.getSummary(who(c), c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'スライドが見つかりません' }, 404);
  });

  /** 共有の範囲を切り替える（`sharing`: `private`・`company`）。作った人だけ。 */
  app.post('/:id/share', async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (b['sharing'] !== 'private' && b['sharing'] !== 'company') return c.json({ error: '共有の範囲は「自分だけ」か「会社で共有」です' }, 400);
    const got = await service.share(who(c), c.req.param('id'), b['sharing']);
    return 'error' in got ? c.json(got, got.error.includes('見つかりません') ? 404 : 400) : c.json(got);
  });

  /**
   * PowerPoint の形で受け取る（第9.4.2節「PowerPoint の取り出し」）。M2Office が Google から受け取って返す（画面は新しいタブを開かずに保存する）。
   * 本人の権限で読めないもの・大きすぎるものは 409 と Google の書き出しの道（`fallback`）。
   */
  app.get('/:id/pptx', async (c) => {
    const r = await service.exportPptx(who(c), c.req.param('id'));
    if ('error' in r) return c.json(r, r.error.includes('見つかりません') || r.error.includes('見つかりませんでした') ? 404 : 400);
    if ('fallback' in r) return c.json(r, 409);
    return new Response(Buffer.from(r.bytes), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`,
        'cache-control': 'no-store',
      },
    });
  });

  /** 削除する（ファイルはドライブのごみ箱へ）。作った人だけ。 */
  app.delete('/:id', async (c) => {
    const e = await service.remove(who(c), c.req.param('id'));
    return e ? c.json({ error: e }, e.includes('見つかりません') ? 404 : 400) : c.json({ ok: true });
  });

  return app;
}
