/**
 * @file 店頭サイネージの素材の縮小画像をサーバーで作る処理の単体テスト（仕様書 第31.6.1節）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize, slideSvg, thumbnailMime, thumbnailPng } from '../src/index.js';
import { renderSvgPng } from '../src/columns/cover.js';

test('縮小画像: 長い辺 320 の PNG を 100 KB までで作る。種類を中身から見分ける', () => {
  const png = renderSvgPng(slideSvg({ side: 'landscape', title: '題名', caption: '一言', index: 0, total: 1, background: { kind: 'template', color: '#1f5f8b', pattern: 'dots' } }), 1920);
  const t = thumbnailPng(png)!;
  assert.ok(t);
  assert.equal(thumbnailMime(t), 'image/png');
  const size = imageSize(t)!;
  assert.equal(size.width, 320);
  assert.equal(size.height, 180);
  assert.ok(t.length <= 100 * 1024);
  assert.equal(thumbnailMime(new Uint8Array([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(thumbnailMime(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(thumbnailPng(new Uint8Array([1, 2, 3])), null, '画像でなければ作らない');
});
