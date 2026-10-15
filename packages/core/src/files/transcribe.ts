/**
 * @file 録音を文字にする（仕様書 第9.4.5節、ADR-0097）。ファイルを読む共通の力の一つで、議事録の作成・録音のまとめ・
 * ファイルを受け取るほかの業務が、文書と同じように録音を読めるようにする。
 *
 * 長い録音は 30 分ずつに分けて（{@link splitAudio}）1 つずつ推論に渡し、時刻を録音の始めからに付け直してつなぐ。
 * 分けられない録音（ffmpeg の無い機械の M4A）は、録音全体を渡して時刻の範囲を指す（区切りの数だけ録音全体が数えられ、費用が増える）。
 * 前の区切りまでの話者と終わりの数行を次の区切りに渡し、同じ人に同じ番号を付けさせる。
 */

import type { LlmProvider } from '../llm/provider.js';
import { audioDurationSec, estimateDurationSec, splitAudio, type AudioKind } from '../media/audio.js';
import { currentAiUsage, withAiUsage } from '../usage/ai-usage.js';
import { MAX_AUDIO_SECONDS } from './formats.js';

/** 1 つの区切りの長さ（秒）。1 回で書き出せる量を超えないため。 */
export const TRANSCRIBE_SEGMENT_SEC = 30 * 60;

/** 録音を文字にできなかった理由（利用者に見せる文）。 */
export class TranscribeError extends Error {}

/** 録音を文字にするのに要るもの。 */
export interface TranscribeDeps {
  /** 会社の推論。`transcribeAudio` を持たなければ文字にできない（ローカル AI・見本でない口）。 */
  llm: LlmProvider;
  /** 聞き取りの手がかり（社内の人・取引先・会社の言葉）。 */
  hints: string[];
  /** 区切りを 1 つ文字にし始めるたびに呼ぶ（進み具合）。 */
  onChunk?: (index: number, total: number) => void | Promise<void>;
}

/** 文字にした結果。 */
export interface Transcript {
  /** 話者と時刻つきの文字起こし。 */
  text: string;
  /** 録音の長さ（秒。読めなければ大きさからの見積もり）。 */
  durationSec: number;
  /** 区切りの数。 */
  chunks: number;
}

/** 秒を、録音の時刻の書き方（1 時間までは `MM:SS`、超えたら `H:MM:SS`）にする。 */
export function clockOf(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const two = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
}

/** 行の先頭の時刻（`[MM:SS]`・`[H:MM:SS]`。分が 60 を超える書き方も読む）を、ずらして書き直す。 */
export function shiftTimes(text: string, offsetSec: number): string {
  return text.replace(/^\[(?:(\d+):)?(\d+):(\d{2})\]/gm, (_m, h: string | undefined, m: string, s: string) => `[${clockOf(Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + offsetSec)}]`);
}

/** 文字起こしに出た話者（`話者 1`・`話者 1（山田）`）。名前の分かったものを残す。 */
export function speakersOf(text: string, known: string[] = []): string[] {
  const byNo = new Map<string, string>();
  for (const k of known) byNo.set(/話者 ?(\d+)/.exec(k)?.[1] ?? k, k);
  for (const m of text.matchAll(/^\[[\d:]+\]\s*(話者 ?(\d+)(（[^）]{1,20}）)?)\s*[:：]/gm)) {
    const no = m[2]!;
    if (m[3] || !byNo.has(no)) byNo.set(no, `話者 ${no}${m[3] ?? ''}`);
  }
  return [...byNo.values()];
}

/**
 * 録音を文字にする。
 *
 * @throws {TranscribeError} 推論が録音を扱えない・長すぎる・話が取れなかったとき（利用者に見せる文）
 * @remarks AI の利用は用途「録音の文字起こし」（`transcribe`）で残す（業務の実行の中なら実行に結び付けたまま）
 */
export async function transcribeRecording(bytes: Uint8Array, kind: AudioKind, deps: TranscribeDeps): Promise<Transcript> {
  const { llm } = deps;
  if (!llm.transcribeAudio) throw new TranscribeError('この会社の AI では、録音を文字にできません');
  const durationSec = audioDurationSec(bytes, kind) ?? estimateDurationSec(bytes.byteLength);
  if (durationSec > MAX_AUDIO_SECONDS * 1.02) throw new TranscribeError('録音が 3 時間を超えています。分けて渡してください');
  const segments = await splitAudio(bytes, kind, durationSec, TRANSCRIBE_SEGMENT_SEC);
  // 分けられなければ、録音全体を渡して時刻の範囲を指す
  const parts = segments
    ? segments.map((s) => ({ bytes: s.bytes, offset: s.startSec, range: null as { startSec: number; endSec: number } | null }))
    : Array.from({ length: Math.max(1, Math.ceil(durationSec / TRANSCRIBE_SEGMENT_SEC - 0.1)) }, (_, i) => ({
      bytes, offset: 0, range: { startSec: i * TRANSCRIBE_SEGMENT_SEC, endSec: Math.min(durationSec, (i + 1) * TRANSCRIBE_SEGMENT_SEC) },
    }));
  const scope = currentAiUsage();
  const out: string[] = [];
  let speakers: string[] = [];
  for (const [i, part] of parts.entries()) {
    await deps.onChunk?.(i + 1, parts.length);
    const previous = out.join('\n').split('\n').filter(Boolean).slice(-3).join('\n');
    const res = await withAiUsage({ ...(scope ?? {}), purpose: 'transcribe' }, () => llm.transcribeAudio!({
      bytes: part.bytes, kind, range: part.range, hints: deps.hints, speakers, previous,
    }));
    const text = shiftTimes(res.text.trim(), part.offset);
    if (text && !/^（話はありません）$/.test(text)) out.push(text);
    speakers = speakersOf(text, speakers);
  }
  if (out.length === 0) throw new TranscribeError('録音から話を聞き取れませんでした');
  return { text: out.join('\n'), durationSec, chunks: parts.length };
}
