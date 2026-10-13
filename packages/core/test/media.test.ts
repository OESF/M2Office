/**
 * @file 動画をまとめる部品の単体テスト（仕様書 第32.18.6節 段 3）。場面の時間・ffmpeg の引数・BGM の合成・WAV の読み書き。
 * 機械に ffmpeg があれば、実際に MP4 にまとめて確かめる（無ければ飛ばす）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNarrated, ffmpegArgs, ffmpegInfo, narratedTimeline, CROSSFADE } from '../src/media/compose.js';
import { synthBgm, BUILTIN_BGM_NAMES } from '../src/media/bgm.js';
import { pcmToWav, readWav, samplesToWav, wavDurationMs } from '../src/media/wav.js';
import { deflateSync } from 'node:zlib';
import { readMp4 } from '../src/signage/mp4.js';

/** 単色の PNG を作る（テストの場面の画像）。 */
function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('場面の時間: 読み上げの長さに前後の間とクロスフェードを足し、次の場面はクロスフェードの分だけ重ねる', () => {
  const t = narratedTimeline([3000, 4000]);
  assert.deepEqual(t.durations, [0.3 + 3 + 0.5 + CROSSFADE, 0.3 + CROSSFADE + 4 + 0.5]);
  assert.deepEqual(t.starts, [0, t.durations[0]! - CROSSFADE]);
  assert.deepEqual(t.speechStarts, [0.3, t.starts[1]! + CROSSFADE + 0.3], '2 枚目はクロスフェードが終わってから読み上げる');
  assert.equal(t.total, t.starts[1]! + t.durations[1]!);
  assert.equal(narratedTimeline([5000]).total, 5.8);
});

test('ffmpeg の引数: 入力の形を明示し、クロスフェード・読み上げの位置・BGM を小さくする処理・H.264 と AAC にする', () => {
  const t = narratedTimeline([2000, 2000, 2000]);
  const args = ffmpegArgs({ images: ['a.png', 'b.png', 'c.png'], speech: ['a.wav', 'b.wav', 'c.wav'], bgm: { path: 'm.mp3', format: 'mp3' }, out: 'o.mp4' }, t, { width: 1920, height: 1080 }, 'libx264');
  const graph = args[args.indexOf('-filter_complex') + 1]!;
  assert.equal(args.filter((a) => a === '-f').length, 7, '画像 3・音 3・BGM 1 のすべてに形を付ける');
  assert.ok(args.includes('mp3') && args.includes('-stream_loop'));
  assert.match(graph, new RegExp(`xfade=transition=fade:duration=${CROSSFADE}:offset=${t.starts[1]}`));
  assert.match(graph, new RegExp(`adelay=${Math.round(t.speechStarts[2]! * 1000)}:all=1`));
  assert.match(graph, /sidechaincompress/);
  assert.ok(args.includes('libx264') && args.includes('aac') && args.includes('+faststart') && args.at(-1) === 'o.mp4');
  const none = ffmpegArgs({ images: ['a.png'], speech: ['a.wav'], bgm: null, out: 'o.mp4' }, narratedTimeline([2000]), { width: 1080, height: 1920 }, 'h264_videotoolbox');
  const g2 = none[none.indexOf('-filter_complex') + 1]!;
  assert.ok(!g2.includes('sidechaincompress') && g2.includes('[v0]null[vout]') && none.includes('h264_videotoolbox'));
});

test('ffmpeg の引数: 文字の層があれば、絵だけを動かし、文字の層は動かさずに重ねる（読み上げの入力の番号もずらす）', () => {
  const t = narratedTimeline([2000, 2000]);
  const args = ffmpegArgs({ images: ['a.png', 'b.png'], overlays: ['ta.png', 'tb.png'], speech: ['a.wav', 'b.wav'], bgm: { path: 'm.wav', format: 'wav' }, out: 'o.mp4' }, t, { width: 1920, height: 1080 }, 'libx264');
  const graph = args[args.indexOf('-filter_complex') + 1]!;
  assert.match(graph, /\[0:v\]scale=2074:1166,crop=1920:1080:x=/, '絵は大きくして動かす');
  assert.match(graph, /\[2:v\]scale=1920:1080,setsar=1,fps=30,format=rgba\[ov0\]/, '文字の層は動画と同じ大きさのまま（動かさない）');
  assert.match(graph, /\[bg0\]\[ov0\]overlay=0:0/);
  assert.match(graph, /\[4:a\]aresample/, '読み上げは文字の層の後の番号');
  assert.match(graph, /\[6:a\]aresample=48000,aformat=channel_layouts=mono,volume/, 'BGM はその後');
});

test('組み込みの BGM: 3 種を指定の長さで合成し、知らない名前は作らない。WAV にして読み直せる', () => {
  assert.deepEqual(BUILTIN_BGM_NAMES, ['gentle', 'bright', 'calm']);
  for (const name of BUILTIN_BGM_NAMES) {
    const p = synthBgm(name, 3)!;
    assert.equal(p.samples.length, 3 * p.sampleRate);
    assert.ok(p.samples.some((x) => Math.abs(x) > 1000), '音が鳴っている');
    assert.equal(wavDurationMs(samplesToWav(p)), 3000);
  }
  assert.equal(synthBgm('rock', 3), null);
  const wav = pcmToWav(new Uint8Array(48_000), 24_000, 1);
  assert.deepEqual([readWav(wav)?.sampleRate, wavDurationMs(wav)], [24_000, 1000]);
  assert.equal(readWav(new Uint8Array([1, 2, 3])), null);
});

test('まとめる: 機械に ffmpeg があれば、実際に H.264 と AAC の MP4 にまとまる', async (t) => {
  const info = await ffmpegInfo();
  if (!info) { t.skip('ffmpeg が無い機械'); return; }
  // 単色の PNG を 2 枚と、1 秒の音を 2 つ
  const png = solidPng(64, 36, [200, 60, 60]);
  const tone = samplesToWav({ sampleRate: 24_000, channels: 1, samples: Int16Array.from({ length: 24_000 }, (_, i) => Math.round(Math.sin(i / 10) * 4000)) });
  const bgm = samplesToWav(synthBgm('gentle', 5)!);
  const r = await composeNarrated({ scenes: [{ image: png, overlay: solidPng(320, 180, [255, 255, 255]), speech: tone, speechMs: 1000 }, { image: solidPng(64, 36, [60, 60, 200]), overlay: solidPng(320, 180, [255, 255, 255]), speech: tone, speechMs: 1000 }], size: { width: 320, height: 180 }, bgm: { bytes: bgm, format: 'wav' } }, info);
  // 壊れた画像では、時間の上限まで待たずにすぐ断る
  const started = Date.now();
  await assert.rejects(composeNarrated({ scenes: [{ image: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), speech: tone, speechMs: 1000 }], size: { width: 320, height: 180 }, bgm: null }, info), /動画にまとめられませんでした/);
  assert.ok(Date.now() - started < 20_000, '壊れた入力ですぐ止まる');
  const mp4 = await readMp4(async (o, l) => r.mp4.subarray(o, o + l), r.mp4.length);
  assert.ok(mp4.ok, '読める MP4');
  assert.ok(mp4.ok && Math.abs(mp4.durationMs - r.totalMs) < 300, '長さが場面の時間と合う');
});
