/**
 * @file 元の画像（assets/brand/icon.png か icon.svg）から、画面のタブのアイコン（favicon）とホーム画面のアイコンを作る。
 *
 * 作るもの（packages/web/public/）:
 * - favicon.ico（16・32・48 を 1 つに入れたもの）
 * - apple-touch-icon.png（180×180。iPhone の「ホーム画面に追加」）
 * - icon-192.png・icon-512.png（Android のホーム画面。manifest.webmanifest から指す）
 * - icon-maskable-512.png（丸く切り抜かれても欠けないよう、絵を中央の 8 割に縮め、周りを元の画像の四隅の色で埋めたもの）
 *
 * 使い方: node scripts/build-icons.mjs
 * 元の画像を差し替えたら、もう一度実行して、できたファイルをコミットする（仕様書 第6.1.1.3節）。
 *
 * @remarks 画像の組み立ては @resvg/resvg-js（カバー画像と同じ部品。ADR-0065）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');

const root = new URL('../', import.meta.url);
const out = new URL('packages/web/public/', root);
const svgPath = new URL('assets/brand/icon.svg', root);
const pngPath = new URL('assets/brand/icon.png', root);

if (!existsSync(svgPath) && !existsSync(pngPath)) {
  console.error('assets/brand/icon.svg か icon.png を置いてください');
  process.exit(1);
}
// 元の画像は SVG を先にする（どの大きさでも滑らか）
const source = existsSync(svgPath)
  ? `data:image/svg+xml;base64,${readFileSync(svgPath).toString('base64')}`
  : `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`;

/** 元の画像を `size` 四方の PNG にする。`body` は SVG の中身（既定は元の画像をそのまま敷く）。 */
function render(size, body = `<image href="${source}" x="0" y="0" width="${size}" height="${size}"/>`) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
}

/** PNG をいくつか入れた .ico を作る（PNG をそのまま入れる形。今のブラウザーと Windows が読める）。 */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

const write = (name, data) => {
  writeFileSync(new URL(name, out), data);
  console.log(`${name}（${data.length.toLocaleString('ja-JP')} バイト）`);
};

write('favicon.ico', ico([16, 32, 48].map((size) => ({ size, data: render(size) }))));
write('apple-touch-icon.png', render(180));
write('icon-192.png', render(192));
write('icon-512.png', render(512));
// マスク用: 元の画像の四隅の色で周りを塗り、その上に 8 割に縮めた絵を、縁をなじませて重ねる
const base = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><image href="${source}" width="512" height="512"/></svg>`).render();
const at = (x, y) => {
  const i = (y * base.width + x) * 4;
  return `#${[0, 1, 2].map((k) => base.pixels[i + k].toString(16).padStart(2, '0')).join('')}`;
};
const [tl, tr, bl, br] = [at(6, 6), at(505, 6), at(6, 505), at(505, 505)];
write('icon-maskable-512.png', render(512, [
  '<defs>',
  `<linearGradient id="bg1" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${bl}"/><stop offset="1" stop-color="${tr}"/></linearGradient>`,
  `<linearGradient id="bg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tl}"/><stop offset="1" stop-color="${br}"/></linearGradient>`,
  '<radialGradient id="fade"><stop offset="0.86" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>',
  '<mask id="soft"><rect x="51" y="51" width="410" height="410" fill="url(#fade)"/></mask>',
  '</defs>',
  '<rect width="512" height="512" fill="url(#bg1)"/>',
  '<rect width="512" height="512" fill="url(#bg2)" fill-opacity="0.5"/>',
  `<image href="${source}" x="51" y="51" width="410" height="410" mask="url(#soft)"/>`,
].join('')));
