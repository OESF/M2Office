/**
 * @file 店頭サイネージの素材の縮小画像をサーバーで作る（仕様書 第31.6.1節。第 0.259.1 版）。
 *
 * 画面から足す素材は、ブラウザーが縮小画像（JPEG）を作って送る。コラム（第32.18.6節）やお知らせ（第35.6.4節）から
 * サーバーが足す素材と、縮小画像の無い素材は、ここで長い辺 320 の PNG を作る（JPEG の部品を足さないため PNG にする）。
 */

import { Resvg } from '@resvg/resvg-js';
import { SIGNAGE_LIMITS } from '@m2office/shared';
import { imageSize } from './image-size.js';

/** 縮小画像が JPEG か PNG か（送り出すときの種類を決める）。どちらでもなければ `null`。 */
export function thumbnailMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/**
 * 画像（PNG・JPEG）から、長い辺 320 の PNG の縮小画像を作る。100 KB を超えれば小さくして作り直す。
 *
 * @returns 作れなければ `null`（縮小画像は無くても素材は使える）
 */
export function thumbnailPng(bytes: Uint8Array): Uint8Array | null {
  const size = imageSize(bytes.subarray(0, 64 * 1024));
  if (!size || !size.width || !size.height) return null;
  const data = `data:${size.mime};base64,${Buffer.from(bytes).toString('base64')}`;
  for (const side of [320, 240, 160]) {
    const s = Math.min(1, side / Math.max(size.width, size.height));
    const w = Math.max(1, Math.round(size.width * s));
    const h = Math.max(1, Math.round(size.height * s));
    try {
      const png = new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="${data}" width="${w}" height="${h}" preserveAspectRatio="none"/></svg>`,
        { fitTo: { mode: 'width', value: w } }).render().asPng());
      if (png.length <= SIGNAGE_LIMITS.thumbnailBytes) return png;
    } catch {
      return null;
    }
  }
  return null;
}
