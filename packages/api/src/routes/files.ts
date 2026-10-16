/**
 * @file ファイルの受け取り（アップロード）と取り出し（ダウンロード）の API。
 *
 * 形式は拡張子と中身の先頭の両方で確かめる。取り出せるのは所有者本人と承認者だけ。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  detectKind, discardLiveRecording, finishLiveRecording, isAudioName, LIVE_PART_MAX_BYTES, liveSeconds, LiveRecordingError, loadFile, MAX_AUDIO_BYTES, MAX_FILE_BYTES,
  putLiveRecordingPart, saveFile, startLiveRecording, type LiveRecording,
} from '@m2office/core';
import type { AppDeps } from '../context.js';
import { driveFilesFor } from '../drive-files.js';
import { recordingRefusal, recordingUnavailable } from '../recording-check.js';
import type { AppEnv } from '../middleware/tenant.js';

/**
 * ファイルの受け取りと取り出し（仕様書 第9.4.1節）。
 *
 * @remarks
 * - 受け付ける形式は PDF・Excel・CSV・Word・画像・録音（MP3・M4A・WAV。第9.4.5節）。拡張子と中身の先頭の両方で確かめる
 * - 録音だけ 200 MB まで。ローカルの方針の会社・AI の無い会社では受け取らない
 * - 取り出せるのは所有者本人と、判断のために中身を見る承認者だけ。それ以外には存在を示さない
 * - その場で録る録音（第9.4.5.1節）は `/recordings` で受ける。途中の録音は録った本人だけが扱う
 */
export function filesRoute(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const { tenant, user } = c.get('ctx');
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'file を指定してください' }, 400);
    const audio = isAudioName(file.name);
    if (file.size > (audio ? MAX_AUDIO_BYTES : MAX_FILE_BYTES)) return c.json({ error: audio ? '録音が大きすぎます（200 MB まで）' : 'ファイルが大きすぎます（10 MB まで）' }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectKind(file.name, bytes);
    if (!kind) return c.json({ error: '受け付けない形式か、拡張子と中身が一致しません' }, 415);
    const refusal = await recordingRefusal(deps, tenant.id, kind, bytes);
    if (refusal) return c.json({ error: refusal }, 422);

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

  /** 途中の録音を画面に返す形（長さは秒）。 */
  const liveView = (r: LiveRecording) => ({ id: r.id, createdAt: r.createdAt, seconds: liveSeconds(r.bytes), nextSeq: r.nextSeq });
  const liveError = (c: { json: (b: unknown, s: 400 | 404 | 409 | 413 | 500) => Response }, err: unknown) => {
    if (err instanceof LiveRecordingError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  /** 本人の途中の録音（第9.4.5.1節）。無ければ `recording: null`。 */
  app.get('/recordings/current', async (c) => {
    const { tenant, user } = c.get('ctx');
    const r = await deps.repo.getLiveRecording(tenant.id, user.id);
    return c.json({ recording: r ? liveView(r) : null });
  });

  /**
   * その場で録り始める。録音を受け取れない会社（ローカルの方針・AI の設定が無い）では断る（422）。
   * 本人の途中の録音があれば、新しく作らずにそれを返す（`resumed: true`）。
   */
  app.post('/recordings', async (c) => {
    const { tenant, user } = c.get('ctx');
    const unavailable = await recordingUnavailable(deps, tenant.id);
    if (unavailable) return c.json({ error: unavailable }, 422);
    const { recording, resumed } = await startLiveRecording(deps.repo, { tenantId: tenant.id, userId: user.id });
    return c.json({ recording: liveView(recording), resumed }, resumed ? 200 : 201);
  });

  /** 録音の欠片（16 kHz・モノラル・16 ビットの PCM。本文はそのままのバイト）を受ける。同じ番号は置き換える。 */
  app.put('/recordings/:id/parts/:seq',
    bodyLimit({ maxSize: LIVE_PART_MAX_BYTES, onError: (c) => c.json({ error: '録音の欠片が大きすぎます' }, 413) }),
    async (c) => {
      const { tenant, user } = c.get('ctx');
      try {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        const r = await putLiveRecordingPart(deps.repo, deps.files, { tenantId: tenant.id, userId: user.id }, c.req.param('id'), Number(c.req.param('seq')), bytes);
        return c.json({ recording: liveView(r) });
      } catch (err) {
        return liveError(c, err);
      }
    });

  /** 録音を止めて 1 つの WAV のファイルにする。渡された録音と同じに扱う（第9.4.5節）。 */
  app.post('/recordings/:id/finish', async (c) => {
    const { tenant, user } = c.get('ctx');
    try {
      const { file, seconds } = await finishLiveRecording(deps.repo, deps.files, { tenantId: tenant.id, userId: user.id }, c.req.param('id'));
      await deps.repo.appendAudit({
        id: crypto.randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
        action: 'file.upload', targetType: 'file', targetId: file.id,
        detail: { kind: file.kind, size: file.size, sha256: file.sha256, seconds, live: true }, occurredAt: new Date().toISOString(),
      });
      return c.json(file, 201);
    } catch (err) {
      return liveError(c, err);
    }
  });

  /** 途中の録音を消す（「削除」「キャンセル」）。 */
  app.delete('/recordings/:id', async (c) => {
    const { tenant, user } = c.get('ctx');
    try {
      const r = await discardLiveRecording(deps.repo, deps.files, { tenantId: tenant.id, userId: user.id }, c.req.param('id'));
      await deps.repo.appendAudit({
        id: crypto.randomUUID(), tenantId: tenant.id, actorType: 'user', actorId: user.id,
        action: 'file.audio_discard', targetType: 'live_recording', targetId: r.id,
        detail: { size: r.bytes, seconds: liveSeconds(r.bytes), transcribed: false, live: true }, occurredAt: new Date().toISOString(),
      });
      return c.json({ ok: true });
    } catch (err) {
      return liveError(c, err);
    }
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
