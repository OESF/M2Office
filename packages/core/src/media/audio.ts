/**
 * @file 録音の長さを、中身の見出しから読む（仕様書 第9.4.5節。3 時間の上限と、30 分ずつに区切るため）。
 *
 * 音を解く仕組みは持たない。WAV は `fmt `・`data` の箱、M4A は `moov` の中の `mvhd`、MP3 は最初のフレームの見出し
 * （Xing・Info のフレーム数があればそれを、無ければ固定のビットレートとみなして大きさから）で求める。読めなければ `null`。
 *
 * 長い録音を 30 分ずつに分けるのもここで行う（{@link splitAudio}）。MP3 はフレームの切れ目で、WAV は標本の切れ目で、
 * 音を解かずに切る。M4A は箱の作りのため切れないので、機械の ffmpeg（`FFMPEG_PATH`。無ければ `PATH`）で音を変えずに分ける。
 * ffmpeg が無ければ分けない（呼び出し側が時刻で範囲を指して読ませる）。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 録音の形式。 */
export type AudioKind = 'mp3' | 'm4a' | 'wav';

/**
 * 録音の長さ（秒）。
 *
 * @returns 読めなければ `null`（呼び出し側は大きさから見積もる）
 */
export function audioDurationSec(bytes: Uint8Array, kind: AudioKind): number | null {
  try {
    const d = kind === 'wav' ? wavSec(bytes) : kind === 'm4a' ? m4aSec(bytes) : mp3Sec(bytes);
    return d !== null && Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * 長さが読めないときの見積もり（秒）。128 kbps とみなす（ボイスメモ・会議の録音でよくある値。WAV は長さが読めるので使わない）。
 */
export function estimateDurationSec(size: number): number {
  return size / (128_000 / 8);
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

function wavSec(b: Uint8Array): number | null {
  const v = view(b);
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const id = tag(b, at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') byteRate = v.getUint32(at + 16, true);
    if (id === 'data') return byteRate ? Math.min(size, b.length - at - 8) / byteRate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

function m4aSec(b: Uint8Array): number | null {
  const v = view(b);
  // 箱をたどる（moov の中の mvhd）。moov が後ろにある録音もあるので、全体を見る
  const find = (start: number, end: number, want: string): { at: number; size: number } | null => {
    for (let at = start; at + 8 <= end;) {
      let size = v.getUint32(at);
      let head = 8;
      if (size === 1) { size = Number(v.getBigUint64(at + 8)); head = 16; }
      if (size === 0) size = end - at;
      if (size < head) return null;
      if (tag(b, at + 4) === want) return { at: at + head, size: size - head };
      at += size;
    }
    return null;
  };
  const moov = find(0, b.length, 'moov');
  if (!moov) return null;
  const mvhd = find(moov.at, moov.at + moov.size, 'mvhd');
  if (!mvhd) return null;
  const version = b[mvhd.at]!;
  if (version === 1) {
    const scale = v.getUint32(mvhd.at + 20);
    return scale ? Number(v.getBigUint64(mvhd.at + 24)) / scale : null;
  }
  const scale = v.getUint32(mvhd.at + 12);
  return scale ? v.getUint32(mvhd.at + 16) / scale : null;
}

/** MPEG の版ごとのビットレート（kbps）。[MPEG-1 の Layer III, MPEG-2/2.5 の Layer III]。 */
const BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Sec(b: Uint8Array): number | null {
  let at = 0;
  // ID3v2 の見出しを飛ばす（大きさは 7 ビットずつの 4 バイト）
  if (tag(b, 0).startsWith('ID3')) at = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
  // 最初のフレームの見出しを探す（先頭の 64 KB まで）
  const limit = Math.min(b.length - 4, at + 65_536);
  for (; at < limit; at++) if (b[at] === 0xff && (b[at + 1]! & 0xe0) === 0xe0) break;
  if (at >= limit) return null;
  const h1 = b[at + 1]!;
  const h2 = b[at + 2]!;
  const h3 = b[at + 3]!;
  const versionBits = (h1 >> 3) & 0x03; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
  const layer = (h1 >> 1) & 0x03; // 1: Layer III
  if (versionBits === 1 || layer !== 1) return null;
  const kbps = BITRATES[versionBits === 3 ? 0 : 1]![(h2 >> 4) & 0x0f] ?? 0;
  const rate = SAMPLE_RATES[versionBits]?.[(h2 >> 2) & 0x03] ?? 0;
  if (!kbps || !rate) return null;
  const mono = ((h3 >> 6) & 0x03) === 3;
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  // Xing・Info（可変のビットレート）のフレーム数
  const side = versionBits === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const x = at + 4 + side;
  if (x + 12 <= b.length && ['Xing', 'Info'].includes(tag(b, x)) && (view(b).getUint32(x + 4) & 0x1) === 1) {
    return (view(b).getUint32(x + 8) * samplesPerFrame) / rate;
  }
  return ((b.length - at) * 8) / (kbps * 1000);
}

/** 分けた録音の 1 つ。 */
export interface AudioSegment {
  bytes: Uint8Array;
  kind: AudioKind;
  /** 録音全体の中での始まりと終わり（秒）。 */
  startSec: number;
  endSec: number;
}

/**
 * 録音を、おおよそ `segmentSec` 秒ずつに分ける。
 *
 * @returns 分けた録音。分けられない（M4A で ffmpeg が無い）ときは `null`。短い録音は 1 つのまま返す
 * @remarks 切れ目の秒は長さの割合からの見積もり（固定のビットレートでない MP3 では少しずれる）。時刻の付け直しに使う
 */
export async function splitAudio(bytes: Uint8Array, kind: AudioKind, durationSec: number, segmentSec: number): Promise<AudioSegment[] | null> {
  const n = Math.max(1, Math.ceil(durationSec / segmentSec - 0.1));
  if (n === 1) return [{ bytes, kind, startSec: 0, endSec: durationSec }];
  if (kind === 'wav') return splitWav(bytes, n, durationSec);
  if (kind === 'mp3') return splitMp3(bytes, n, durationSec);
  return splitWithFfmpeg(bytes, kind, segmentSec, durationSec);
}

function splitWav(b: Uint8Array, n: number, durationSec: number): AudioSegment[] | null {
  const v = view(b);
  let fmt: Uint8Array | null = null;
  let blockAlign = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const id = tag(b, at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') { fmt = b.subarray(at, at + 8 + size); blockAlign = v.getUint16(at + 20, true); }
    if (id === 'data' && fmt && blockAlign) {
      const data = b.subarray(at + 8, Math.min(b.length, at + 8 + size));
      const per = Math.ceil(data.length / n / blockAlign) * blockAlign;
      const out: AudioSegment[] = [];
      for (let i = 0, from = 0; from < data.length; i++, from += per) {
        const part = data.subarray(from, Math.min(data.length, from + per));
        out.push({ bytes: wavWith(fmt, part), kind: 'wav', startSec: (from / data.length) * durationSec, endSec: (Math.min(data.length, from + per) / data.length) * durationSec });
      }
      return out;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** `fmt ` の箱と音のデータから WAV を作る。 */
function wavWith(fmt: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + fmt.length + 8 + data.length);
  const v = view(out);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  v.setUint32(4, out.length - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set(fmt, 12);
  const at = 12 + fmt.length;
  out.set([0x64, 0x61, 0x74, 0x61], at);
  v.setUint32(at + 4, data.length, true);
  out.set(data, at + 8);
  return out;
}

function splitMp3(b: Uint8Array, n: number, durationSec: number): AudioSegment[] {
  let first = 0;
  if (tag(b, 0).startsWith('ID3')) first = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
  const body = b.length - first;
  // 割合の位置から、次のフレームの先頭（11 ビットの 1 と、Layer III の印）を探して切る
  const syncFrom = (at: number) => {
    for (let i = at; i < b.length - 4; i++) if (b[i] === 0xff && (b[i + 1]! & 0xe6) === 0xe2) return i;
    return b.length;
  };
  const cuts = [first];
  for (let i = 1; i < n; i++) cuts.push(syncFrom(first + Math.floor((body * i) / n)));
  cuts.push(b.length);
  const out: AudioSegment[] = [];
  for (let i = 0; i < n; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    if (to <= from) continue;
    out.push({ bytes: b.subarray(from, to), kind: 'mp3', startSec: ((from - first) / body) * durationSec, endSec: ((to - first) / body) * durationSec });
  }
  return out;
}

async function splitWithFfmpeg(bytes: Uint8Array, kind: AudioKind, segmentSec: number, durationSec: number): Promise<AudioSegment[] | null> {
  const path = process.env['FFMPEG_PATH']?.trim() || 'ffmpeg';
  const dir = await mkdtemp(join(tmpdir(), 'm2o-audio-'));
  try {
    const input = join(dir, `in.${kind}`);
    await writeFile(input, bytes);
    // 音を変えずに（-c copy）時間で分ける。録音は消す決まりなので、作業の場所は終わったらすぐ消す
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(path, ['-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:a', '-c', 'copy', '-f', 'segment', '-segment_time', String(segmentSec), '-reset_timestamps', '1', join(dir, `part-%03d.${kind}`)], { stdio: 'ignore' });
      const timer = setTimeout(() => p.kill('SIGKILL'), 5 * 60_000);
      p.on('error', () => { clearTimeout(timer); resolve(null); });
      p.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });
    if (code !== 0) return null;
    const names = (await readdir(dir)).filter((f) => f.startsWith('part-')).sort();
    if (names.length === 0) return null;
    const out: AudioSegment[] = [];
    for (const [i, name] of names.entries()) {
      out.push({ bytes: new Uint8Array(await readFile(join(dir, name))), kind, startSec: i * segmentSec, endSec: Math.min(durationSec, (i + 1) * segmentSec) });
    }
    return out;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
