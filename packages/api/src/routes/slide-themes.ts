/**
 * @file Google スライドのテーマの API。一覧・追加（本人が選んだプレゼンテーション）・削除・見本の縮小の絵・使えるかの確かめ・選ぶ画面の材料
 * （仕様書 第9.4.2節「Google スライドのテーマを使う・PowerPoint の取り出し」、Q-265）。
 *
 * 権限は `drive.file` のまま（選ぶ画面で選んだファイルだけが見える）。会社のテーマの登録と削除は管理者だけ。
 */

import { Hono, type Context } from 'hono';
import type { SlideThemeViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { driveFilesFor } from '../drive-files.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Google スライドのテーマの API（仕様書 第9.4.2節「Google スライドのテーマを使う」）。
 */
export function slideThemesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const service = deps.slideThemes;
  const drive = driveFilesFor(deps);
  const who = (c: Context<AppEnv>): SlideThemeViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id, admin: user.roles.includes('admin') };
  };
  app.use('/:id/*', async (c, next) => (ID.test(c.req.param('id')) ? next() : c.json({ error: 'テーマが見つかりません' }, 404)));

  /** 本人のものと会社のもの。`kind` はスライドのテーマ（既定）か文書のテンプレート（`doc`）。 */
  app.get('/', async (c) => {
    const kind = c.req.query('kind');
    return c.json({ items: await service.list(who(c), kind === 'doc' || kind === 'sheet' ? kind : 'slides') });
  });

  /** 選ぶ画面の材料（`drive.file` だけに絞ったトークン。見本の会社は見本のドライブのプレゼンテーションの一覧）。 */
  app.get('/picker', async (c) => {
    if (deps.connector.sourceFor(c.get('ctx').tenant.id) === 'mock') {
      const files = await deps.connector.drive.search(who(c), { query: '', limit: 100 });
      const kind = c.req.query('kind') === 'doc' ? 'document' : c.req.query('kind') === 'sheet' ? 'spreadsheet' : 'presentation';
      return c.json({ kind: 'mock', items: files.filter((f) => f.kind === kind).map((f) => ({ id: f.id, name: f.name })) });
    }
    const r = await drive.picker(who(c));
    return 'error' in r ? c.json(r, 400) : c.json(r, 200, { 'cache-control': 'no-store' });
  });

  /** 本人が選んだプレゼンテーションをテーマにする（`fileId`。`company: true` は管理者だけ）。 */
  app.post('/', async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const r = await service.add(who(c), { fileId: b['fileId'], company: b['company'], kind: b['kind'] });
    return 'error' in r ? c.json(r, r.error.includes('管理者') ? 403 : 400) : c.json(r, 201);
  });

  /** 削除する（自分のテーマ。会社のテーマは管理者）。ファイルそのものには触らない。 */
  app.delete('/:id', async (c) => {
    if (!ID.test(c.req.param('id'))) return c.json({ error: 'テーマが見つかりません' }, 404);
    const e = await service.remove(who(c), c.req.param('id'));
    return e ? c.json({ error: e }, e.includes('管理者') ? 403 : 404) : c.json({ ok: true });
  });

  /** 見本の縮小の絵。 */
  app.get('/:id/thumbnail', async (c) => {
    const t = await service.thumbnail(who(c), c.req.param('id'));
    if (!t) return c.json({ error: '見本の絵がありません' }, 404);
    return new Response(Buffer.from(t.bytes), { headers: { 'content-type': t.mimeType, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
  });

  /** 本人がテーマのファイルを開けるか。開けなければ、選ぶ画面で選んでもらうファイルの ID（会社のテーマを初めて使うとき）。 */
  app.get('/:id/access', async (c) => {
    const r = await service.access(who(c), c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'テーマが見つかりません' }, 404);
  });

  return app;
}
