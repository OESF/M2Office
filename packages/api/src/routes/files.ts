/**
 * @file ファイルの受け取り（アップロード）と取り出し（ダウンロード）の API。
 *
 * 形式は拡張子と中身の先頭の両方で確かめる。取り出せるのは所有者本人と承認者だけ。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

import { Hono } from 'hono';
import { detectKind, loadFile, MAX_FILE_BYTES, saveFile } from '@m2office/core';
import type { AppDeps } from '../context.js';
import { driveFilesFor } from '../drive-files.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * ファイルの受け取りと取り出し（仕様書 第9.4.1節）。
 *
 * @remarks
 * - 受け付ける形式は PDF・Excel・CSV・Word・画像。拡張子と中身の先頭の両方で確かめる
 * - 取り出せるのは所有者本人と、判断のために中身を見る承認者だけ。それ以外には存在を示さない
 */
export function filesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'file を指定してください' }, 400);
    if (file.size > MAX_FILE_BYTES) return c.json({ error: 'ファイルが大きすぎます（10 MB まで）' }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(file.name, bytes);
    if (!kind) return c.json({ error: '受け付けない形式か、拡張子と中身が一致しません' }, 415);

    const meta = await saveFile(deps.repo, deps.files, {
      tenantId: tenant.id, ownerUserId: user.id, name: file.name, kind, bytes, origin: 'upload', runId: null,
    });
    await deps.repo.appendAudit({
      id: crypto.randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
      action: 'file.upload', targetType: 'file', targetId: meta.id,
      detail: { kind, size: meta.size, sha256: meta.sha256 }, occurredAt: new Date().toISOString(),
    });
    return c.json(meta, 201);
  });

  const drive = driveFilesFor(deps);

  /** 秘書に渡すドライブのファイルを選ぶ画面の材料（`drive.file` だけに絞ったトークン。見本の会社は見本のドライブの一覧。第10.10.8節）。 */
  app.get('/drive-picker', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await drive.picker({ tenantId: tenant.id, userId: user.id });
    return 'error' in r ? c.json(r, 400) : c.json(r);
  });

  /** 本人がドライブで選んだファイルを受け取る（本文: `fileId`）。手元から渡したファイルと同じ置き場に入れる（第10.10.8節）。 */
  app.post('/from-drive', async (c) => {
    const { tenant, user } = c.get('ctx');
    const b = await c.req.json<{ fileId?: unknown }>().catch(() => ({} as { fileId?: unknown }));
    const r = await drive.receive({ tenantId: tenant.id, userId: user.id }, String(b.fileId ?? ''));
    return 'error' in r ? c.json({ error: r.error }, r.status) : c.json(r.file, 201);
  });

  app.get('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const f = await loadFile(deps.repo, deps.files, tenant.id, c.req.param('id'), user);
    if (!f) return c.json({ error: 'ファイルが見つかりません' }, 404);
    return c.json(f.meta);
  });

  /**
   * 画像（PNG・JPEG）を画面に出す（承認の画面のカバー画像など。仕様書 第32.18.2節）。読める人は中身と同じ（所有者と、判断する承認者）。
   *
   * @remarks 画像のほかは返さない（PDF などを画面の権限で開かせない）。中身を実行させない見出しを付ける
   */
  app.get('/:id/view', async (c) => {
    const { tenant, user } = c.get('ctx');
    const f = await loadFile(deps.repo, deps.files, tenant.id, c.req.param('id'), user);
    if (!f || (f.meta.kind !== 'png' && f.meta.kind !== 'jpeg')) return c.json({ error: 'ファイルが見つかりません' }, 404);
    return new Response(Buffer.from(f.bytes), {
      headers: { 'content-type': f.meta.mime, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=3600' },
    });
  });

  app.get('/:id/content', async (c) => {
    const { tenant, user } = c.get('ctx');
    const f = await loadFile(deps.repo, deps.files, tenant.id, c.req.param('id'), user);
    if (!f) return c.json({ error: 'ファイルが見つかりません' }, 404);
    return new Response(Buffer.from(f.bytes), {
      headers: {
        'content-type': f.meta.mime,
        // 画面に埋め込ませず、必ず保存させる。PDF などの中身を画面の権限で実行させないため
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
        'x-content-type-options': 'nosniff',
      },
    });
  });

  return app;
}
