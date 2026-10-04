/**
 * @file Web のコラム（内蔵の拡張）の API。一覧・書く・詳細・直す・書き直しを頼む・直し案に置き換える・前の版に戻す・
 * 承認へ進める・コピーする形・削除・カバー画像（見る・再作成・ファイルから選択・以前の画像に戻す）。
 *
 * 会社が Web のコラムを切っているときと、利用範囲の外の人には、どの口も使わせない。コラムは会社で共有する。
 * 設定と WordPress の鍵は管理者の口（拡張機能）で扱う。
 *
 * @see 仕様書 第32.18.1節 段 1 の実装の決まり
 */

import { Hono, type Context } from 'hono';
import { AI_NOT_CONFIGURED_MESSAGE, COLUMN_PHOTO_MAX_BYTES, WEB_COLUMN_PLACE, aiAvailable, columnPublicUrl, enqueueJob, type ColumnViewer } from '@m2office/core';
import type { AppDeps } from '../context.js';
import type { AppEnv } from '../middleware/tenant.js';
import { tenantOrigin } from '../tenant-origin.js';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Web のコラムの API（仕様書 第32章）。
 *
 * @remarks 監査ログは処理（ColumnService）が残す（書く・承認へ進める・入れる・削除）
 */
export function columnsRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { service } = deps.columns;
  const who = (c: Context<AppEnv>): ColumnViewer => {
    const { tenant, user } = c.get('ctx');
    return { tenantId: tenant.id, userId: user.id };
  };

  // Web のコラムを使えない会社・人には、どの口も使わせない（第12.13節・第16.7.3節）
  app.use('*', async (c, next) => {
    const { tenant, user } = c.get('ctx');
    if (!(await deps.columns.access(tenant.id, user.id))) {
      return c.json({ error: 'コラムの作成は使えません（会社で切っているか、利用範囲の外です）' }, 403);
    }
    await next();
  });

  /** 貼るだけのページの URL の頭（使っていなければ `null`）。 */
  const pageBase = (c: Context<AppEnv>, key: string | null | undefined) => (key ? `${tenantOrigin(c.req.header('origin'), c.req.header('host'))}/v1/public/columns/${key}` : null);

  /** コラムの一覧（新しい順）と、入れ先の WordPress・テーマ案・予定表・貼るだけのページ（段 2。第32.18.4節）。 */
  app.get('/', async (c) => {
    const { tenant } = c.get('ctx');
    const [columns, settings, themes, plan] = await Promise.all([
      service.list(tenant.id), deps.repo.getTenantSettings(tenant.id),
      deps.columns.planner?.themes(tenant.id) ?? [], deps.columns.planner?.plan(tenant.id) ?? [],
    ]);
    return c.json({ columns, wordpress: settings.webColumns.wordpress, themes, plan, pageUrl: pageBase(c, settings.webColumns.pastePage?.key) });
  });

  /** テーマ案を作る（画面の「テーマ案を出す」）。 */
  app.post('/themes', async (c) => {
    const { tenant, user } = c.get('ctx');
    if (!deps.columns.planner) return c.json({ error: 'テーマ案は使えません' }, 409);
    const r = await deps.columns.planner.generateThemes(tenant.id, user.id, new Date(), false);
    return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r, 201);
  });

  /** テーマ案から書き始める（書き直しの案なら書き直す）。 */
  app.post('/themes/:id/write', async (c) => {
    if (!deps.columns.planner) return c.json({ error: 'テーマ案は使えません' }, 409);
    const r = await deps.columns.planner.writeFromTheme(who(c), c.req.param('id'));
    return 'error' in r ? c.json({ error: r.error }, 400) : c.json(r, 201);
  });

  /** テーマ案を見送りにする。 */
  app.post('/themes/:id/dismiss', async (c) => {
    if (!deps.columns.planner) return c.json({ error: 'テーマ案は使えません' }, 409);
    const err = await deps.columns.planner.dismissTheme(who(c), c.req.param('id'));
    return err ? c.json({ error: err }, 400) : c.json({ ok: true });
  });

  /** 公開の日時（予約）を入れる・外す（`publishAt`: ISO か `null`。下書きのときだけ）。 */
  app.put('/:id/publish-at', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const at = body['publishAt'] === null ? null : typeof body['publishAt'] === 'string' ? body['publishAt'] : undefined;
    if (at === undefined) return c.json({ error: '公開の日時が読めません' }, 400);
    const err = await service.setPublishAt(who(c), c.req.param('id'), at);
    return err ? c.json({ error: err }, 400) : c.json({ ok: true });
  });

  /** 取り下げる（承認済み・予約・入れたもの。管理者と承認者だけ）。 */
  app.post('/:id/withdraw', async (c) => {
    const { user } = c.get('ctx');
    if (!user.roles.includes('admin') && !user.roles.includes('approver')) return c.json({ error: '取り下げられるのは管理者と承認者です' }, 403);
    const err = await service.withdraw(who(c), c.req.param('id'));
    return err ? c.json({ error: err }, 400) : c.json({ ok: true });
  });

  /**
   * コラムを書き始める。書き上げは裏で進め、すぐに ID を返す（状態「書いています」）。
   *
   * @returns 作ったコラムの ID。推論が使えなければ 409
   */
  app.post('/', async (c) => {
    const { tenant } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const res = await service.create(who(c), { theme: str(body['theme']) ?? '', memo: str(body['memo']) ?? '' });
    return 'error' in res ? c.json({ error: res.error }, 400) : c.json(res, 201);
  });

  /** 1 つのコラムと版の一覧。 */
  app.get('/:id', async (c) => {
    const d = await service.detail(who(c), c.req.param('id'));
    if (!d) return c.json({ error: 'コラムが見つかりません' }, 404);
    // 公開されたコラムの数字（この 28 日）。Web の分析を使える人にだけ添える（第34.19節）
    const { tenant, user } = c.get('ctx');
    const metrics = (await deps.webReview.access(tenant.id, user.id)) ? await deps.webReview.service.columnMetrics(tenant.id, d.column.id).catch(() => null) : null;
    // 公開の URL（SNS の告知文に足す。WordPress で公開された URL か、貼るだけのページの記事の URL。第32.18.4節）
    const [settings, placed] = await Promise.all([deps.repo.getTenantSettings(tenant.id), service.store.placed(tenant.id)]);
    const publicUrl = columnPublicUrl({ ...d.column, webUrl: placed.find((x) => x.id === d.column.id)?.webUrl ?? null }, pageBase(c, settings.webColumns.pastePage?.key));
    return c.json({ ...d, webMetrics: metrics, publicUrl });
  });

  /** 直して保存する（新しい版になる）。 */
  app.put('/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const sns = (body['sns'] ?? {}) as Record<string, unknown>;
    const err = await service.saveEdit(who(c), c.req.param('id'), {
      ...(str(body['title']) !== undefined ? { title: str(body['title'])! } : {}),
      ...(str(body['body']) !== undefined ? { body: str(body['body'])! } : {}),
      ...(str(body['description']) !== undefined ? { description: str(body['description'])! } : {}),
      sns: { ...(str(sns['short']) !== undefined ? { short: str(sns['short'])! } : {}), ...(str(sns['long']) !== undefined ? { long: str(sns['long'])! } : {}) },
    });
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 指示で書き直してもらう（新しい版になる）。 */
  app.post('/:id/rewrite', async (c) => {
    const { tenant } = c.get('ctx');
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const err = await service.rewrite(who(c), c.req.param('id'), str(body['instruction']) ?? '');
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 書けなかったコラムを、もう一度書く。 */
  app.post('/:id/retry', async (c) => {
    const { tenant } = c.get('ctx');
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const err = await service.retry(who(c), c.req.param('id'));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 赤入れの直し案に置き換える（今の版の `index` 番目）。 */
  app.post('/:id/suggestions/:index', async (c) => {
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: '指摘が見つかりません' }, 400);
    const err = await service.applySuggestion(who(c), c.req.param('id'), index);
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** 前の版に戻す（その版を写した新しい版を足す）。 */
  app.post('/:id/versions/:version/restore', async (c) => {
    const err = await service.restore(who(c), c.req.param('id'), Number(c.req.param('version')));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /**
   * カバー画像（PNG）。`version` で前の版、`download=1` で保存させる（第32.18.2節）。
   *
   * @remarks 画面に埋め込むため inline で返す。M2Office が組み立てた PNG だけを返し、中身を実行させない見出しを付ける
   */
  app.get('/:id/cover', async (c) => {
    const version = c.req.query('version') ? Number(c.req.query('version')) : undefined;
    const bytes = await service.coverBytes(who(c), c.req.param('id'), Number.isInteger(version) ? version : undefined);
    if (!bytes) return c.json({ error: 'カバー画像がありません' }, 404);
    return new Response(Buffer.from(bytes), {
      headers: {
        'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=3600',
        ...(c.req.query('download') === '1' ? { 'content-disposition': 'attachment; filename="column-cover.png"' } : {}),
      },
    });
  });

  /** 前に作ったカバーに戻す（`fileId`。本文はいまのまま、新しい版になる）。 */
  app.post('/:id/cover/restore', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const err = await service.useCover(who(c), c.req.param('id'), str(body['fileId']) ?? '');
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /** カバーを作り直す（`kind`・`hint`。新しい版になる）。 */
  app.post('/:id/cover', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const kind = ['template', 'ai', 'photo'].includes(String(body['kind'])) ? (body['kind'] as 'template' | 'ai' | 'photo') : undefined;
    const err = await service.recover(who(c), c.req.param('id'), { ...(kind ? { kind } : {}), ...(str(body['hint']) ? { hint: str(body['hint'])! } : {}) });
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  /**
   * 写真を入れ、そのコラムのカバーにする（会社の写真の置き場にも入る）。本文は写真の中身そのもの（JPEG・PNG、10 MB まで）。
   */
  app.post('/:id/photos', async (c) => {
    const size = Number(c.req.header('content-length') ?? '0');
    if (size > COLUMN_PHOTO_MAX_BYTES) return c.json({ error: '写真は 10 MB までです' }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const name = decodeURIComponent(c.req.header('x-file-name') ?? 'photo').slice(0, 200);
    const err = await service.addPhoto(who(c), c.req.param('id'), { bytes, mimeType: (c.req.header('content-type') ?? '').split(';')[0]!.trim(), name });
    return err ? c.json({ error: err }, 400) : c.json({ ok: true }, 201);
  });

  /** 記事に入れる形（Markdown と HTML）。写して使う。 */
  app.get('/:id/export', async (c) => {
    const e = await service.exported(who(c), c.req.param('id'));
    return e ? c.json(e) : c.json({ error: 'コラムが見つかりません' }, 404);
  });

  /**
   * 承認へ進める（業務「コラムを WordPress に入れる」を始め、責任者の承認を待つ。第32.18.1節）。
   *
   * @returns 実行の ID。入れられない理由があれば 400
   */
  app.post('/:id/submit', async (c) => {
    const { tenant, user } = c.get('ctx');
    const v = who(c);
    const id = c.req.param('id');
    await service.syncAwaiting(v, id);
    const col = await service.store.get(tenant.id, id);
    if (!col) return c.json({ error: 'コラムが見つかりません' }, 404);
    if (col.status === 'awaiting') return c.json({ error: 'すでに承認へ進めています' }, 409);
    const p = await service.preview(v, id);
    if (!p) return c.json({ error: 'コラムが見つかりません' }, 404);
    if (p.problems.length > 0) return c.json({ error: p.problems.join('／') }, 400);
    const def = (await deps.tenantView(tenant.id)).resolve(WEB_COLUMN_PLACE.id, WEB_COLUMN_PLACE.version);
    if (!def) return c.json({ error: 'コラムを WordPress に入れる業務が見つかりません' }, 404);
    if (!aiAvailable(await deps.ai.llmFor(tenant.id))) return c.json({ error: AI_NOT_CONFIGURED_MESSAGE }, 409);
    const { runId } = await enqueueJob(deps.repo, {
      // カバーのファイルを入力に含め、承認する人がその画像を見られるようにする（第32.18.2節）
      tenantId: tenant.id, requestedBy: user.id, def, input: { columnId: id, ...(p.cover ? { coverFileId: p.cover.fileId } : {}) }, origin: 'menu', actor: { type: 'user', id: user.id },
    });
    await service.markAwaiting(v, id, runId, p);
    return c.json({ runId }, 201);
  });

  /** 削除する（承認へ進めていないものだけ）。 */
  app.delete('/:id', async (c) => {
    const err = await service.remove(who(c), c.req.param('id'));
    return err ? c.json({ error: err }, 409) : c.json({ ok: true });
  });

  return app;
}
