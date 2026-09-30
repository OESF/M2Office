/**
 * @file 店頭サイネージの単体テスト（仕様書 第31.6.1節・第31.5.1節）。
 *
 * MP4 の入れ物の記録の読み方（H.264 か・長さ・縦横。moov が後ろにある動画も）、画像の種類と縦横、
 * ふだん動いている時間帯の決め方、生きている知らせの整え方を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMp4, imageSize, usualSlot, jstSlot, cleanReport } from '../src/index.js';

const box = (type: string, ...parts: Uint8Array[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const mp4 = (codec = 'avc1', w = 1280, h = 720, ms = 5000, moovLast = false) => {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(ms, 16);
  const soun = Buffer.alloc(24); soun.write('soun', 8, 'latin1');
  const vide = Buffer.alloc(24); vide.write('vide', 8, 'latin1');
  const entry = (w2: number, h2: number) => { const e = Buffer.alloc(78); e.writeUInt16BE(w2, 24); e.writeUInt16BE(h2, 26); return e; };
  const stsd = (c: string, w2: number, h2: number) => Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), box(c, entry(w2, h2))]);
  // 音の箱（mp4a）を先に置き、映像の箱だけを見ることを確かめる
  const audio = box('trak', box('mdia', box('hdlr', soun), box('minf', box('stbl', box('stsd', stsd('mp4a', 0, 0))))));
  const video = box('trak', box('mdia', box('hdlr', vide), box('minf', box('stbl', box('stsd', stsd(codec, w, h))))));
  const moov = box('moov', box('mvhd', mvhd), audio, video);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(256));
  return moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
};
const reader = (b: Buffer) => async (o: number, l: number) => new Uint8Array(b.subarray(o, Math.min(b.length, o + l)));

test('MP4: 映像の箱の H.264・長さ・縦横を読む（moov が後ろにあっても）', async () => {
  const a = mp4();
  assert.deepEqual(await readMp4(reader(a), a.length), { ok: true, codec: 'avc1', durationMs: 5000, width: 1280, height: 720 });
  const b = mp4('avc3', 1080, 1920, 12_345, true);
  const r = await readMp4(reader(b), b.length);
  assert.ok(r.ok && r.codec === 'avc3' && r.durationMs === 12_345 && r.width === 1080 && r.height === 1920, '後ろの moov・縦の動画');
});

test('MP4: H.264 でない・MP4 でない・映像の無いものは断る', async () => {
  const hevc = mp4('hvc1');
  const r = await readMp4(reader(hevc), hevc.length);
  assert.ok(!r.ok && /H\.264/.test(r.reason));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  assert.equal((await readMp4(reader(png), png.length)).ok, false);
});

test('画像: PNG と JPEG の縦横を中身の先頭から読み、ほかは null', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  assert.deepEqual(imageSize(png), { mime: 'image/png', width: 1920, height: 1080 });
  // JPEG: SOI・APP0（長さ 16）・SOF0（高さ 600・幅 800）
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
  assert.deepEqual(imageSize(jpg), { mime: 'image/jpeg', width: 800, height: 600 });
  assert.equal(imageSize(Buffer.from('GIF89a')), null);
});

test('ふだん動いている時間帯: 記録が 3 日未満は 7〜22 時、以後は知らせのあった日が半分以上の時間帯', () => {
  assert.equal(usualSlot([], 14), true, '7:00');
  assert.equal(usualSlot([], 13), false, '6:30');
  assert.equal(usualSlot([], 44), false, '22:00');
  const on = (slots: number[]) => ({ slots: slots.reduce((a, s) => a | (1n << BigInt(s)), 0n) });
  const days = [on([20, 21]), on([20]), on([20, 40]), on([])];
  assert.equal(usualSlot(days, 20), true, '4 日のうち 3 日');
  assert.equal(usualSlot(days, 21), false, '4 日のうち 1 日');
  assert.deepEqual(jstSlot(new Date('2026-09-30T15:40:00Z')), { day: '2026-10-01', slot: 1 }, '日本時間の 0:40');
});

test('生きている知らせ: 知らない項目と形の違う値を捨てる（割り込みの文を受けない）', () => {
  const r = cleanReport({ current: 'a-1', flowVersion: 3, cached: 2, uncached: ['x', 'bad id!'], failed: [], pageVersion: '0.11.0', viewport: { width: 1920, height: 1080 }, storageFree: 1e9, text: '12番の方' });
  assert.deepEqual(r, { current: 'a-1', flowVersion: 3, cached: 2, uncached: ['x'], failed: [], pageVersion: '0.11.0', viewport: { width: 1920, height: 1080 }, storageFree: 1e9 });
  assert.equal(cleanReport('x'), null);
});
