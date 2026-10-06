/**
 * @file 販促物の作成（内蔵の拡張）の API。一覧・作る（3 案。値札を含む）・1 つ・案を選ぶ・会話で直す・文面を直す・掲示の期間と置き場所・外した・作り直す・削除・書き出し・
 * 店頭サイネージに流す・止める・お知らせの下書きにする（第41.18節）。
 *
 * 会社が切っているときと、利用範囲の外の人には、どの口も使わせない。社外には何も出さない（お知らせは下書きまで。出すのはお知らせの作成の承認の後）。
 * 印刷の発注はしない（第41.7節）。
 *
 * @see 仕様書 第41章
 */

import { Hono, type Context } from 'hono';
import type { PrintExport, PrintViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const EXPORTS: PrintExport[] = ['preview', 'png', 'pdf', 'bleed'];

/**
 * 販促物の作成の API（仕様書 第41章）。
 *
 * @remarks 監査ログは処理（PrintDesignService）が残す
 */
export function printDesignsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.printDesigns;
  const who = (c: Context<AppEnv>): PrintViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };
  const body = (c: Context<AppEnv>) => c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const status = (e: string) => (e.includes('見つかりません') ? 404 : e.includes('だけ') || e.includes('は使えません') ? 403 : 400);
  const problem = (c: Context<AppEnv>, e: string | null) => (e ? c.json({ error: e }, status(e)) : c.json({ ok: true }));
  const result = (c: Context<AppEnv>, r: { error: string } | object, ok: 200 | 201 = 200) => ('error' in r ? c.json(r, status(String((r as { error: string }).error))) : c.json(r, ok));

  // 販促物の作成を使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.printDesigns.access(tenant.id, user.id))) {
      return c.json({ error: '販促物の作成は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });
  app.use('/:id/*', async (c, next) => (ID.test(c.req.param('id')) ? next() : c.json({ error: '販促物が見つかりません' }, 404)));

  /** 一覧（新しく直した順。掲示の状態つき）と、本人が管理者か、「ドライブから」を使えるか（第41.19.2節）。 */
  app.get('/', async (c) => c.json({
    items: await service.list(who(c)), today: service.today(), admin: c.get('ctx').user.roles.includes('admin'),
    drive: !!(await service.deps.drive?.available(who(c)).catch(() => false)),
  }));

  /** 「ドライブから」の選ぶ画面の材料（`drive.file` だけに絞ったトークン。見本の会社は見本の写真の一覧。第41.19.2節）。 */
  app.get('/drive-picker', async (c) => {
    if (!service.deps.drive) return c.json({ error: 'ドライブの写真は使えません' }, 404);
    const r = await service.deps.drive.picker(who(c));
    return 'error' in r ? c.json(r, 400) : c.json(r, 200, { 'cache-control': 'no-store' });
  });

  /** 作る（3 案）。`request`（頼みの文）・`kind`・`size`・`photoFileId`（本人が上げた写真）・`driveFileId`（本人がドライブで選んだ写真）。 */
  app.post('/', async (c) => {
    const b = await body(c);
    return result(c, await service.create(who(c), { request: b['request'], kind: b['kind'], size: b['size'], photoFileId: b['photoFileId'], driveFileId: b['driveFileId'] }), 201);
  });

  /** 1 つの物と版と、つなげる先を使えるか（第41.18節）。 */
  app.get('/:id', async (c) => {
    const d = await service.get(who(c), c.req.param('id'));
    return d ? c.json({ ...d, links: await service.links(who(c)) }) : c.json({ error: '販促物が見つかりません' }, 404);
  });

  /** 店頭サイネージに流す（掲示の始まりより前なら、始まりから流す）。 */
  app.post('/:id/signage', async (c) => result(c, await service.toSignage(who(c), c.req.param('id'))));

  /** 店頭サイネージから外す。 */
  app.delete('/:id/signage', async (c) => problem(c, await service.stopSignage(who(c), c.req.param('id'))));

  /** Canva で仕上げる（選んだ版の PDF を本人の Canva に取り込み、編集の画面の URL を返す。第41.19.3節）。 */
  app.post('/:id/canva', async (c) => result(c, await service.openInCanva(who(c), c.req.param('id'))));

  /** Canva から戻す（Canva のデザインを書き出し、新しい版にする）。 */
  app.post('/:id/canva/pull', async (c) => result(c, await service.pullFromCanva(who(c), c.req.param('id'))));

  /** お知らせの作成の下書きにする（出すのはお知らせの作成の承認の後）。 */
  app.post('/:id/announcement', async (c) => result(c, await service.toAnnouncement(who(c), c.req.param('id')), 201));

  /** 案を選ぶ・前の版に戻す（`versionId`）。 */
  app.post('/:id/choose', async (c) => {
    const b = await body(c);
    return problem(c, await service.choose(who(c), c.req.param('id'), typeof b['versionId'] === 'string' ? b['versionId'] : ''));
  });

  /** 会話で直す（`instruction`・`photoFileId`・`driveFileId`）。新しい版にする。 */
  app.post('/:id/revise', async (c) => {
    const b = await body(c);
    return result(c, await service.revise(who(c), c.req.param('id'), b['instruction'], b['photoFileId'], b['driveFileId']));
  });

  /** 文面をその場で直す（`headline`・`sub`・`body`・`period`・`price`・`note`・`qrUrl`）。新しい版にする。 */
  app.patch('/:id/copy', async (c) => result(c, await service.editCopy(who(c), c.req.param('id'), await body(c))));

  /** 題名・掲示の期間・置き場所を直す。 */
  app.patch('/:id', async (c) => {
    const b = await body(c);
    return problem(c, await service.setPost(who(c), c.req.param('id'), { title: b['title'], postFrom: b['postFrom'], postTo: b['postTo'], place: b['place'] }));
  });

  /** 外した（期間が終わって掲示を外した）。 */
  app.post('/:id/removed', async (c) => problem(c, await service.markRemoved(who(c), c.req.param('id'))));

  /** 作り直す（`instruction`。「今年の日付で」など）。新しい物を返す。 */
  app.post('/:id/remake', async (c) => {
    const b = await body(c);
    return result(c, await service.remake(who(c), c.req.param('id'), b['instruction']), 201);
  });

  /** 削除する（作った人と管理者だけ）。 */
  app.delete('/:id', async (c) => problem(c, await service.remove(who(c), c.req.param('id'))));

  /** 一覧の小さな画像（選んだ版。まだ選んでいなければ 1 つ目の案）。 */
  app.get('/:id/thumb', async (c) => {
    const f = await service.thumb(who(c), c.req.param('id'));
    if (!f) return c.json({ error: '販促物が見つかりません' }, 404);
    return new Response(f.bytes as unknown as ArrayBuffer, { headers: { 'content-type': f.mime, 'cache-control': 'private, max-age=300' } });
  });

  /** 書き出す（`preview`・`png`・`pdf`・`bleed`。`page` はパンフレットの面・値札のシート・何枚も作る物の何枚目か）。 */
  app.get('/:id/versions/:vid/:kind', async (c) => {
    const kind = c.req.param('kind') as PrintExport;
    if (!EXPORTS.includes(kind) || !ID.test(c.req.param('vid'))) return c.json({ error: '書き出しの種類が違います' }, 400);
    const page = Math.max(0, Math.min(9, Number(c.req.query('page') ?? 0) || 0));
    const f = await service.export(who(c), c.req.param('id'), c.req.param('vid'), kind, page);
    if (!f) return c.json({ error: '販促物が見つかりません' }, 404);
    if ('error' in f) return c.json(f, 400);
    const download = kind === 'pdf' || kind === 'bleed' || c.req.query('download') === '1';
    return new Response(f.bytes as unknown as ArrayBuffer, {
      headers: {
        'content-type': f.mime,
        'cache-control': 'private, max-age=300',
        ...(download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` } : {}),
      },
    });
  });

  return app;
}
