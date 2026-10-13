/**
 * @file ナレーション付きスライドを ffmpeg で MP4 にまとめる（仕様書 第32.18.6節 段 3、ADR-0094）。
 *
 * ffmpeg は M2Office に同梱せず、機械に入っているものを別のプロセスとして呼ぶ（`FFMPEG_PATH`。無ければ `PATH` の ffmpeg）。
 * 渡すのは M2Office が作った画像（PNG）・読み上げの音（WAV）と、形を確かめた BGM（WAV・MP3）だけ。入力の形を明示し（`-f`）、
 * 時間の上限で止め、作業の置き場は終わったら消す。
 *
 * 場面ごとに「読み上げの前の間 ＋ 読み上げ ＋ 後の間」だけ映し、場面の間はクロスフェードでつなぐ。絵はゆっくり横に動かし、
 * 文字の帯（題名・一言・何枚目か）は動かさずに上に重ねる（動くと読みにくいため。第 0.356.0 版）。
 * BGM はナレーションの間だけ小さくする（サイドチェインのコンプレッサー）。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 場面の間のクロスフェード（秒）。 */
export const CROSSFADE = 0.5;
/** 場面に入ってから読み上げを始めるまでの間（秒）。 */
const LEAD = 0.3;
/** 読み上げの後の間（秒）。 */
const TAIL = 0.5;
/** ffmpeg を止める時間（ミリ秒）。 */
const TIMEOUT_MS = 5 * 60_000;

/** 場面ごとの時間（秒）。 */
export interface NarratedTimeline {
  /** 場面ごとの映す長さ（次の場面とのクロスフェードを含む） */
  durations: number[];
  /** 場面ごとの始まり */
  starts: number[];
  /** 場面ごとの読み上げの始まり */
  speechStarts: number[];
  /** 全体の長さ */
  total: number;
}

/**
 * 読み上げの長さから、場面ごとの時間を決める。
 *
 * @param speechMs 場面ごとの読み上げの長さ（ミリ秒）
 */
export function narratedTimeline(speechMs: number[]): NarratedTimeline {
  const n = speechMs.length;
  const durations: number[] = [];
  const starts: number[] = [];
  const speechStarts: number[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    // 2 枚目からは、前の場面からのクロスフェードが終わってから読み上げる
    const lead = LEAD + (i > 0 ? CROSSFADE : 0);
    const d = lead + speechMs[i]! / 1000 + TAIL + (i < n - 1 ? CROSSFADE : 0);
    starts.push(round(at));
    speechStarts.push(round(at + lead));
    durations.push(round(d));
    at += d - (i < n - 1 ? CROSSFADE : 0);
  }
  return { durations, starts, speechStarts, total: round(at) };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const even = (x: number) => Math.round(x / 2) * 2;

/** 使える H.264 の符号化器（よく使われる順）。 */
export type H264Encoder = 'libx264' | 'h264_videotoolbox' | 'libopenh264';

/** ffmpeg に渡す入力のファイル。 */
export interface ComposeFiles {
  /** 場面ごとの絵（横に動かす） */
  images: string[];
  /** 場面ごとの文字の層（透明の PNG。動かさずに重ねる）。無ければ重ねない */
  overlays?: string[];
  speech: string[];
  bgm: { path: string; format: 'wav' | 'mp3' } | null;
  out: string;
}

/**
 * ffmpeg の引数を作る（入力・フィルター・符号化）。
 *
 * @param size 動画の大きさ（横 1920×1080 か縦 1080×1920）
 */
export function ffmpegArgs(files: ComposeFiles, t: NarratedTimeline, size: { width: number; height: number }, encoder: H264Encoder): string[] {
  const n = files.images.length;
  const { width: W, height: H } = size;
  // 静止画を少し大きくして、横にゆっくり動かす（場面ごとに向きを変える）
  const W2 = even(W * 1.08);
  const H2 = even(H * 1.08);
  // 読めない入力に当たったら、すぐ止める（壊れた入力でエラーを出し続けて時間の上限まで待たない）
  const args = ['-hide_banner', '-loglevel', 'error', '-xerror', '-y'];
  const overlays = files.overlays && files.overlays.length === n ? files.overlays : null;
  files.images.forEach((p, i) => args.push('-f', 'image2', '-loop', '1', '-framerate', '30', '-t', String(t.durations[i]), '-i', p));
  overlays?.forEach((p, i) => args.push('-f', 'image2', '-loop', '1', '-framerate', '30', '-t', String(t.durations[i]), '-i', p));
  // 入力の番号: 絵 0〜n-1、文字の層 n〜2n-1（あれば）、読み上げ、BGM
  const speechAt = overlays ? 2 * n : n;
  files.speech.forEach((p) => args.push('-f', 'wav', '-i', p));
  if (files.bgm) args.push('-stream_loop', '-1', '-f', files.bgm.format, '-i', files.bgm.path);
  const f: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = t.durations[i]!;
    const x = i % 2 === 0 ? `(in_w-out_w)*t/${d}` : `(in_w-out_w)*(1-t/${d})`;
    if (overlays) {
      // 絵だけを動かし、文字の層は止めたまま重ねる
      f.push(`[${i}:v]scale=${W2}:${H2},crop=${W}:${H}:x='${x}':y=(in_h-out_h)/2,setsar=1,fps=30[bg${i}]`);
      f.push(`[${n + i}:v]scale=${W}:${H},setsar=1,fps=30,format=rgba[ov${i}]`);
      f.push(`[bg${i}][ov${i}]overlay=0:0:format=auto,format=yuv420p[v${i}]`);
    } else {
      f.push(`[${i}:v]scale=${W2}:${H2},crop=${W}:${H}:x='${x}':y=(in_h-out_h)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
    }
  }
  let last = 'v0';
  for (let i = 1; i < n; i++) {
    const out = i === n - 1 ? 'vout' : `x${i}`;
    f.push(`[${last}][v${i}]xfade=transition=fade:duration=${CROSSFADE}:offset=${t.starts[i]}[${out}]`);
    last = out;
  }
  if (n === 1) f.push('[v0]null[vout]');
  for (let i = 0; i < n; i++) {
    f.push(`[${speechAt + i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(t.speechStarts[i]! * 1000)}:all=1[a${i}]`);
  }
  f.push(`${Array.from({ length: n }, (_, i) => `[a${i}]`).join('')}amix=inputs=${n}:normalize=0:duration=longest,apad,atrim=0:${t.total}[narr]`);
  if (files.bgm) {
    const fadeAt = Math.max(0, t.total - 2);
    f.push(`[${speechAt + n}:a]aresample=48000,aformat=channel_layouts=mono,volume=0.35,atrim=0:${t.total},afade=t=in:d=1,afade=t=out:st=${fadeAt}:d=2[bgm0]`);
    f.push('[narr]asplit=2[narrA][narrSC]');
    // ナレーションの間だけ BGM を小さくする
    f.push('[bgm0][narrSC]sidechaincompress=threshold=0.03:ratio=10:attack=20:release=500[bgmd]');
    f.push('[narrA][bgmd]amix=inputs=2:normalize=0:duration=first[aout]');
  } else {
    f.push('[narr]anull[aout]');
  }
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]');
  if (encoder === 'libx264') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22');
  else args.push('-c:v', encoder, '-b:v', '6M');
  args.push('-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-t', String(t.total), files.out);
  return args;
}

/** 使う ffmpeg の道と、使える H.264 の符号化器。 */
export interface FfmpegInfo { path: string; encoder: H264Encoder }

let cached: { key: string; info: Promise<FfmpegInfo | null> } | null = null;

/**
 * 機械の ffmpeg を確かめる（あるか・H.264 の符号化器）。結果はプロセスの中で覚える。
 *
 * @returns 使えなければ `null`
 */
export function ffmpegInfo(env: NodeJS.ProcessEnv = process.env): Promise<FfmpegInfo | null> {
  const path = env['FFMPEG_PATH']?.trim() || 'ffmpeg';
  if (cached?.key === path) return cached.info;
  const info = run(path, ['-hide_banner', '-encoders'], 10_000).then(({ code, out }) => {
    if (code !== 0) return null;
    const encoder = (['libx264', 'h264_videotoolbox', 'libopenh264'] as const).find((e) => new RegExp(`\\s${e}\\s`).test(out));
    return encoder ? { path, encoder } : null;
  }).catch(() => null);
  cached = { key: path, info };
  return info;
}

/** プロセスを動かし、終わるか時間の上限まで待つ。 */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => { if (out.length < 200_000) out += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { if (err.length < 20_000) err += d.toString(); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** まとめる中身。 */
export interface NarratedInput {
  /**
   * 場面ごとの絵（PNG。動画と同じ大きさ。横に動かす）・文字の層（透明の PNG。動かさずに重ねる。無ければ絵だけ）・読み上げの音（WAV）
   */
  scenes: { image: Uint8Array; overlay?: Uint8Array; speech: Uint8Array; speechMs: number }[];
  size: { width: number; height: number };
  bgm: { bytes: Uint8Array; format: 'wav' | 'mp3' } | null;
}

/**
 * ナレーション付きスライドを MP4 にまとめる。
 *
 * @throws ffmpeg が無い・失敗した・時間の上限を超えたとき（理由を添える）
 */
export async function composeNarrated(input: NarratedInput, info: FfmpegInfo): Promise<{ mp4: Uint8Array; totalMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'm2o-narrated-'));
  try {
    const images: string[] = [];
    const overlays: string[] = [];
    const speech: string[] = [];
    for (const [i, s] of input.scenes.entries()) {
      const img = join(dir, `scene-${i}.png`);
      const wav = join(dir, `speech-${i}.wav`);
      await writeFile(img, s.image);
      await writeFile(wav, s.speech);
      images.push(img);
      speech.push(wav);
      if (s.overlay) {
        const ov = join(dir, `text-${i}.png`);
        await writeFile(ov, s.overlay);
        overlays.push(ov);
      }
    }
    let bgm: ComposeFiles['bgm'] = null;
    if (input.bgm) {
      const p = join(dir, `bgm.${input.bgm.format}`);
      await writeFile(p, input.bgm.bytes);
      bgm = { path: p, format: input.bgm.format };
    }
    const out = join(dir, 'out.mp4');
    const t = narratedTimeline(input.scenes.map((s) => s.speechMs));
    const r = await run(info.path, ffmpegArgs({ images, ...(overlays.length === images.length ? { overlays } : {}), speech, bgm, out }, t, input.size, info.encoder), TIMEOUT_MS);
    if (r.code !== 0) throw new Error(`動画にまとめられませんでした（${r.code === null ? '時間がかかりすぎました' : r.err.trim().split('\n').slice(-2).join(' ').slice(0, 200) || `ffmpeg ${r.code}`}）`);
    return { mp4: new Uint8Array(await readFile(out)), totalMs: Math.round(t.total * 1000) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
