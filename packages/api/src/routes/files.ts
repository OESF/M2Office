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

  app.get('/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    const f = await loadFile(deps.repo, deps.files, tenant.id, c.req.param('id'), user);
    if (!f) return c.json({ error: 'ファイルが見つかりません' }, 404);
    return c.json(f.meta);
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
