/**
 * @file Google のプロフィール写真の取り込みの単体テスト（仕様書 第6.5.1.1節）。
 *
 * 要は、受け取った URL をそのまま取りに行かないこと。`https` で Google の画像の置き場だけに限る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PHOTO_BYTES, fetchGooglePhoto, isGooglePhotoUrl } from '../src/index.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

/** 決まった応答を返し、呼ばれた URL と指定を控える `fetch` の代わり。 */
function fakeFetch(body: Uint8Array | Error, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; opts: RequestInit | undefined }[] = [];
  const impl = (async (url: string, opts?: RequestInit) => {
    calls.push({ url, opts });
    if (body instanceof Error) throw body;
    return new Response(body, { status: init.status ?? 200, headers: init.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('写真の URL: https で、Google の画像の置き場だけを許す', () => {
  assert.equal(isGooglePhotoUrl('https://lh3.googleusercontent.com/a/ACg8oc=s96-c'), true);
  assert.equal(isGooglePhotoUrl('https://googleusercontent.com/x'), true);
  assert.equal(isGooglePhotoUrl('http://lh3.googleusercontent.com/a/x'), false, 'http は許さない');
  assert.equal(isGooglePhotoUrl('https://lh3.googleusercontent.com.evil.example/a'), false, '後ろに付け足した偽の置き場');
  assert.equal(isGooglePhotoUrl('https://evilgoogleusercontent.com/a'), false, '名前の一部だけが一致する置き場');
  assert.equal(isGooglePhotoUrl('https://lh3.googleusercontent.com:8443/a'), false, 'ポートの指定');
  assert.equal(isGooglePhotoUrl('https://user:pass@lh3.googleusercontent.com/a'), false, '利用者名つき');
  assert.equal(isGooglePhotoUrl('https://169.254.169.254/latest/meta-data'), false, '内部の住所');
  assert.equal(isGooglePhotoUrl('file:///etc/passwd'), false);
  assert.equal(isGooglePhotoUrl('not a url'), false);
});

test('写真の取り込み: PNG と JPEG だけを、中身の印で見分けて受け取る', async () => {
  const png = fakeFetch(PNG, { headers: { 'content-type': 'image/png' } });
  assert.deepEqual(await fetchGooglePhoto('https://lh3.googleusercontent.com/a', png.impl), { mime: 'image/png', bytes: PNG });
  assert.equal(png.calls[0]!.opts?.redirect, 'error', '転送を追わない（許した置き場の外へ連れ出されないため）');

  const jpeg = fakeFetch(JPEG, { headers: { 'content-type': 'image/png' } });
  assert.equal((await fetchGooglePhoto('https://lh3.googleusercontent.com/a', jpeg.impl))?.mime, 'image/jpeg', '見出しでなく中身で見る');

  assert.equal(await fetchGooglePhoto('https://lh3.googleusercontent.com/a', fakeFetch(GIF).impl), null, 'GIF は受け取らない');
});

test('写真の取り込み: 取れないときは null を返し、例外を投げない（ログインを止めない）', async () => {
  const never = fakeFetch(PNG);
  assert.equal(await fetchGooglePhoto('https://evil.example/a.png', never.impl), null);
  assert.equal(never.calls.length, 0, '許されない URL には要求を出さない');
  assert.equal(await fetchGooglePhoto('https://lh3.googleusercontent.com/a', fakeFetch(PNG, { status: 404 }).impl), null);
  assert.equal(await fetchGooglePhoto('https://lh3.googleusercontent.com/a', fakeFetch(new Error('network')).impl), null);
  assert.equal(await fetchGooglePhoto('https://lh3.googleusercontent.com/a', fakeFetch(new Uint8Array()).impl), null, '空');
  const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
  big.set(PNG);
  assert.equal(await fetchGooglePhoto('https://lh3.googleusercontent.com/a', fakeFetch(big).impl), null, '1 MB を超えるもの');
  assert.equal(await fetchGooglePhoto('https://lh3.googleusercontent.com/a',
    fakeFetch(PNG, { headers: { 'content-length': String(MAX_PHOTO_BYTES + 1) } }).impl), null, '大きいと宣言したもの');
});
