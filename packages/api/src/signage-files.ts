/**
 * @file 店頭サイネージの素材の受け取りと出し方（仕様書 第31.6.1節）。
 *
 * 大きな動画（200 MB まで）を丸ごと記憶に載せないよう、受け取った中身は流したまま一時ファイルに書き、SHA-256 と大きさを数える。
 * 出すときは部分の読み出し（`Range`）に応じ、種類を推測させず（`nosniff`）、画面の中で何も動かさない見出しを付ける。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileStore } from '@m2office/core';

/**
 * 要求の本文を一時ファイルに書く。
 *
 * @param max 受け取る大きさの上限（バイト）。超えたら書くのをやめ、一時ファイルを消す
 */
export async function receiveToTemp(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ path: string; bytes: number; sha256: string } | { error: string; status: number }> {
  if (!body) return { error: 'ファイルがありません', status: 400 };
  const path = join(tmpdir(), `m2o-signage-${randomUUID()}`);
  const out = createWriteStream(path);
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) {
        await reader.cancel().catch(() => undefined);
        out.destroy();
        await rm(path, { force: true });
        return { error: `ファイルが大きすぎます（${Math.round(max / 1024 / 1024)} MB まで）`, status: 413 };
      }
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await rm(path, { force: true });
    throw err;
  }
  if (bytes === 0) {
    await rm(path, { force: true });
    return { error: 'ファイルが空です', status: 400 };
  }
  return { path, bytes, sha256: hash.digest('hex') };
}

/**
 * 素材の中身を返す（`Range` に応じる）。
 *
 * @param range 要求の `Range` の見出し
 */
export async function serveAsset(files: FileStore, tenantId: string, key: string, mime: string, range: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'accept-ranges': 'bytes',
    // 素材は中身が変わらない（同じ ID の中身は作り直さない）。端末は取り置きの場所にも置く
    'cache-control': 'private, max-age=86400',
  };
  if (!files.openRead) {
    const bytes = await files.get(tenantId, key);
    if (!bytes) return new Response('{"error":"素材がありません"}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(Buffer.from(bytes), { headers: { ...headers, 'content-length': String(bytes.length) } });
  }
  const whole = await files.openRead(tenantId, key);
  if (!whole) return new Response('{"error":"素材がありません"}', { status: 404, headers: { 'content-type': 'application/json' } });
  const size = whole.size;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(whole.stream, { headers: { ...headers, 'content-length': String(size) } });
  }
  await whole.stream.cancel().catch(() => undefined);
  let start: number;
  let end: number;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  const part = await files.openRead(tenantId, key, { start, end });
  if (!part) return new Response('{"error":"素材がありません"}', { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(part.stream, {
    status: 206,
    headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` },
  });
}
