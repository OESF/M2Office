/**
 * @file 店頭サイネージの単体テスト（仕様書 第31.6.1節・第31.5.1節）。
 *
 * MP4 の入れ物の記録の読み方（H.264 か・長さ・縦横。moov が後ろにある動画も）、画像の種類と縦横、
 * ふだん動いている時間帯の決め方、生きている知らせの整え方を確かめる。
 * 段 2: 割り込みの文の整え方・よく出す案内の形・受け口の骨組み（値を渡さない）・音の形式・HTML の外への参照・秘書への依頼の見分け方（第31.7節〜第31.9節）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeSignageBand, signageBandLabel, signageBandsOverlap, signageDaysLabel, signageMinutes } from '@m2office/shared';
import {
  readMp4, imageSize, usualSlot, jstSlot, cleanReport, normalizeText, fillTemplate, leadingNumber, phraseTemplate, valueSkeleton, pickPath,
  soundMime, externalRefs, signageRequest, signageFileRequest,
} from '../src/index.js';

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
  assert.deepEqual(r, { current: 'a-1', flowVersion: 3, cached: 2, uncached: ['x'], failed: [], pageVersion: '0.11.0', viewport: { width: 1920, height: 1080 }, storageFree: 1e9, audio: null, interrupting: false });
  assert.equal(cleanReport('x'), null);
});

test('割り込みの文: 全角の英数字を半角に、改行と見えない文字を除き、先頭の番号を拾う', () => {
  assert.equal(normalizeText('１２番の方、\nＸ線室へ\u200b  どうぞ'), '12番の方、 X線室へ どうぞ');
  assert.equal(normalizeText('  \t '), '');
  assert.equal(fillTemplate('{番号}番の方、{場所}へお越しください', '12', '2番診察室'), '12番の方、2番診察室へお越しください');
  assert.equal(leadingNumber('105番の方'), '105');
  assert.equal(leadingNumber('本日は105番まで'), null, '先頭にないものは大きくしない');
  assert.equal(leadingNumber('12345番'), null, '5 桁は番号とみなさない');
});

test('よく出す案内: 先頭の番号だけを空けた形で数える', () => {
  assert.deepEqual(phraseTemplate('12番の方、受付へ'), { template: '{番号}番の方、受付へ', hasNumber: true });
  assert.deepEqual(phraseTemplate('焼き上がりました'), { template: '焼き上がりました', hasNumber: false });
});

test('受け口の骨組み: 項目の名前と値の種類だけにし、値を残さない（推論に渡すもの）', () => {
  const payload = { ticket: { no: '0012', counter: 'レントゲン室', vip: true }, at: 1700000000, items: [{ a: 'x' }, { a: 'y' }, { a: 'z' }] };
  const sk = valueSkeleton(payload);
  assert.deepEqual(sk, { ticket: { no: '<数字の文字>', counter: '<文字>', vip: '<真偽>' }, at: '<数>', items: [{ a: '<文字>' }, { a: '<文字>' }] });
  assert.ok(!JSON.stringify(sk).includes('レントゲン'), '値が入らない');
  assert.equal(pickPath(payload, 'ticket.no'), '0012');
  assert.equal(pickPath(payload, 'items.1.a'), 'y');
  assert.equal(pickPath(payload, 'ticket.none.x'), undefined);
});

test('会社の音: 中身の先頭で MP3・WAV を見分け、ほかは断る', () => {
  assert.equal(soundMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), 'audio/wav');
  assert.equal(soundMime(new Uint8Array([0x49, 0x44, 0x33, 4])), 'audio/mpeg');
  assert.equal(soundMime(new Uint8Array([0xff, 0xfb, 0x90])), 'audio/mpeg');
  assert.equal(soundMime(new Uint8Array([0x4f, 0x67, 0x67, 0x53])), null, 'Ogg は受けない');
});

test('HTML: 外への参照（画像・スクリプト・CSS・移動）を拾い、中に入れたものと相対の参照は拾わない', () => {
  const html = `<img src="https://a.example/x.png"><script src='//cdn.example/y.js'></script>
    <style>@import "https://f.example/z.css"; .a{background:url(http://b.example/bg.png)}</style>
    <meta http-equiv="refresh" content="0; url=https://c.example/">
    <img srcset="data:image/png;base64,AA 1x, https://d.example/2x.png 2x"><img src="img/local.png"><a href="#top">上へ</a>`;
  assert.deepEqual(externalRefs(html).sort(), ['//cdn.example/y.js', 'http://b.example/bg.png', 'https://a.example/x.png', 'https://c.example/', 'https://d.example/2x.png', 'https://f.example/z.css']);
  assert.deepEqual(externalRefs('<img src="data:image/png;base64,AA"><link rel="stylesheet" href="a.css">'), []);
});

test('秘書への依頼: 番号の呼び出し・かぎかっこの文・画面の指定・消す・状態を見分け、やり方の質問は会話に回す', () => {
  assert.deepEqual(signageRequest('14番の方を呼んで'), { kind: 'show', number: '14', screens: [], seconds: undefined, chime: undefined });
  assert.deepEqual(signageRequest('12番、レントゲン室'), { kind: 'show', number: '12', place: 'レントゲン室', screens: [], seconds: undefined, chime: undefined });
  const q = signageRequest('待合だけに「本日は17時まで」を出して、30秒、音なしで');
  assert.deepEqual(q, { kind: 'show', text: '本日は17時まで', screens: ['待合'], seconds: 30, chime: false });
  assert.deepEqual(signageRequest('入口と待合に「雨の日セール」を出して'), { kind: 'show', text: '雨の日セール', screens: ['入口', '待合'], seconds: undefined, chime: undefined });
  assert.deepEqual(signageRequest('呼び出しを全部消して'), { kind: 'clear', all: true, screens: [] });
  assert.deepEqual(signageRequest('サイネージはつながってる?'), { kind: 'status' });
  assert.deepEqual(signageRequest('入口の画面を切断して'), { kind: 'remove', screen: '入口' });
  assert.deepEqual(signageRequest('入口の画面を外して'), { kind: 'remove', screen: '入口' });
  assert.deepEqual(signageRequest('呼び出しの言い回しを「〇番の方、〇へどうぞ」にして'), { kind: 'template', template: '{番号}番の方、{場所}へどうぞ' });
  assert.equal(signageRequest('サイネージに文字を出す方法は?'), null);
  assert.equal(signageRequest('明日の予定を教えて'), null);
});

test('時間帯の流れ: 時刻と曜日で当たる時間帯を選び、夜中をまたぐ時間帯は始めた日で見る。重なりを見分ける（第31.6.6節）', () => {
  // 2026-10-05 は月曜日。日本時間の値を getUTC* で読める形にする
  const at = (iso: string) => new Date(`${iso}Z`);
  const lunch = { id: 'l', start: '11:00', end: '14:00', days: 31 };
  const night = { id: 'n', start: '22:00', end: '02:00', days: 32 };
  assert.equal(activeSignageBand([lunch, night], at('2026-10-05T11:00:00'))?.id, 'l', '始めの時刻から当たる');
  assert.equal(activeSignageBand([lunch, night], at('2026-10-05T14:00:00')), null, '終わりの時刻で外れる');
  assert.equal(activeSignageBand([lunch, night], at('2026-10-10T12:00:00')), null, '土曜は平日の時間帯に当たらない');
  assert.equal(activeSignageBand([lunch, night], at('2026-10-10T23:30:00'))?.id, 'n', '土曜の夜');
  assert.equal(activeSignageBand([lunch, night], at('2026-10-11T01:00:00'))?.id, 'n', '日曜の朝 1 時は、土曜に始めた時間帯');
  assert.equal(activeSignageBand([lunch, night], at('2026-10-12T01:00:00')), null, '月曜の朝 1 時は、日曜に始めていないので外れる');
  assert.equal(signageBandLabel(lunch), '11:00〜14:00 平日');
  assert.equal(signageDaysLabel(96), '土日');
  assert.equal(signageDaysLabel(1 | 4 | 16), '月・水・金');
  assert.equal(signageBandsOverlap(lunch, { start: '13:00', end: '15:00', days: 1 }), true);
  assert.equal(signageBandsOverlap(lunch, { start: '13:00', end: '15:00', days: 32 }), false, '曜日が違えば重ならない');
  assert.equal(signageBandsOverlap(lunch, { start: '14:00', end: '17:00', days: 31 }), false, '終わりと始めが同じなら重ならない');
  assert.equal(signageBandsOverlap(night, { start: '01:00', end: '03:00', days: 64 }), true, '土曜の夜から日曜の朝にまたぐ');
  assert.equal(signageMinutes('7:05'), 425);
  assert.equal(signageMinutes('24:00'), null);
});

test('秘書の頼み: 流れに足す・時間帯を作る・消す・設定を見分け、ほかの頼みと取り違えない（第31.11.2節）', () => {
  assert.deepEqual(signageFileRequest('入口の画面の流れに足して'), { kind: 'add-file', screens: ['入口'] });
  assert.deepEqual(signageFileRequest('この画像を17時からの流れに入れて'), { kind: 'add-file', screens: [], bandStart: '17:00' });
  assert.equal(signageFileRequest('この表の品目を挙げて'), null, 'サイネージの話でなければ、ほかの業務に回す');
  assert.deepEqual(signageRequest('入口の画面に17時から22時の時間帯を作って'), { kind: 'band-add', screens: ['入口'], start: '17:00', end: '22:00', days: 127 });
  assert.deepEqual(signageRequest('平日の11:00〜14:00の時間帯を作って'), { kind: 'band-add', screens: [], start: '11:00', end: '14:00', days: 31 });
  assert.deepEqual(signageRequest('土日の10時半から12時の時間帯を足して'), { kind: 'band-add', screens: [], start: '10:30', end: '12:00', days: 96 });
  assert.deepEqual(signageRequest('入口の17時からの時間帯を消して'), { kind: 'band-remove', screens: ['入口'], start: '17:00' });
  assert.deepEqual(signageRequest('この画像をサイネージの流れに足して'), { kind: 'add-file', screens: [] }, '画像が無ければ、渡すよう答える');
  assert.deepEqual(signageRequest('サイネージの画像の秒数を8秒にして'), { kind: 'settings', patch: { imageSeconds: 8 } });
  assert.deepEqual(signageRequest('割り込みは20秒にして'), { kind: 'settings', patch: { interruptSeconds: 20 } });
  assert.deepEqual(signageRequest('店の色を緑にして'), { kind: 'settings', patch: { color: '#2e6e4f' } });
  assert.deepEqual(signageRequest('店の色を#AA3300に変えて'), { kind: 'settings', patch: { color: '#aa3300' } });
  assert.deepEqual(signageRequest('呼び出しの音をベルにして'), { kind: 'settings', patch: { jingle: 'bell', chime: true } });
  assert.deepEqual(signageRequest('呼び出しの音を止めて'), { kind: 'settings', patch: { chime: false } }, '割り込みを消す頼みと取り違えない');
  assert.deepEqual(signageRequest('呼び出しを消して'), { kind: 'clear', all: false, screens: [] });
  assert.equal(signageRequest('明日17時から22時に会議を入れて'), null, '予定の頼みは取らない');
});
