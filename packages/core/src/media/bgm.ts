/**
 * @file 組み込みの BGM をプログラムで合成する（仕様書 第32.18.6節 段 3、Q-234）。
 *
 * 曲の素材を持たずに作るので、権利の心配が無い（サイネージのジングルと同じ考え方）。和音を 4 拍ずつ鳴らすやわらかい伴奏で、
 * 「穏やか」「明るい」「落ち着いた」の 3 種。ナレーションの下で小さく流す前提のため、目立つ旋律は入れない。
 */

import type { Pcm16 } from './wav.js';

/** 合成の標本化周波数。 */
const RATE = 32_000;

/** 1 つの曲の譜（和音の並び・1 和音の秒数・分散和音にするか・音の明るさ）。 */
interface Score {
  /** 和音（MIDI の音の番号）。順に繰り返す */
  chords: number[][];
  /** 1 和音の秒数 */
  seconds: number;
  /** 分散和音の 1 音の秒数（0 なら和音をまとめて鳴らす） */
  arpeggio: number;
  /** 倍音の強さ（0〜1。大きいほど明るい） */
  brightness: number;
}

const SCORES: Record<string, Score> = {
  // C → Am → F → G（穏やか）
  gentle: { chords: [[48, 55, 64, 67], [45, 52, 60, 64], [41, 53, 57, 60], [43, 50, 59, 62]], seconds: 4, arpeggio: 0, brightness: 0.25 },
  // D → Bm → G → A の分散和音（明るい）
  bright: { chords: [[50, 62, 66, 69], [47, 59, 62, 66], [43, 59, 62, 67], [45, 57, 61, 64]], seconds: 2.4, arpeggio: 0.3, brightness: 0.4 },
  // Am → F → C → G をゆっくり（落ち着いた）
  calm: { chords: [[45, 57, 60, 64], [41, 57, 60, 65], [48, 55, 60, 64], [43, 55, 59, 62]], seconds: 6, arpeggio: 0, brightness: 0.15 },
};

/** 組み込みの曲の ID（`builtin:` を除いた名前）。 */
export const BUILTIN_BGM_NAMES = Object.keys(SCORES);

const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * 組み込みの曲を、指定の長さで合成する（終わりの 2 秒は消えていく）。
 *
 * @param name `gentle`・`bright`・`calm`（`builtin:` は付けない）
 * @param seconds 長さ（秒）
 * @returns 32 kHz・モノラルの標本。知らない名前なら `null`
 */
export function synthBgm(name: string, seconds: number): Pcm16 | null {
  const score = SCORES[name];
  if (!score) return null;
  const total = Math.max(1, Math.round(seconds * RATE));
  const buf = new Float32Array(total);
  const chordLen = Math.round(score.seconds * RATE);
  for (let start = 0, c = 0; start < total; start += chordLen, c++) {
    const notes = score.chords[c % score.chords.length]!;
    notes.forEach((midi, k) => {
      // 分散和音なら 1 音ずつずらして鳴らし、そうでなければ和音をまとめて鳴らす
      const offset = score.arpeggio ? Math.round(k * score.arpeggio * RATE) : 0;
      const len = chordLen - offset + Math.round(0.6 * RATE);
      const f = freq(midi);
      const gain = (k === 0 ? 0.22 : 0.14);
      for (let i = 0; i < len; i++) {
        const at = start + offset + i;
        if (at >= total) break;
        const t = i / RATE;
        // ゆっくり立ち上がり、ゆっくり消える（パッドのような音）
        const attack = Math.min(1, t / 0.4);
        const release = Math.min(1, Math.max(0, (len - i) / (0.8 * RATE)));
        const env = attack * release;
        const w = Math.sin(2 * Math.PI * f * t) + score.brightness * Math.sin(4 * Math.PI * f * t) * 0.5 + score.brightness * Math.sin(6 * Math.PI * f * t) * 0.2;
        buf[at]! += w * gain * env;
      }
    });
  }
  // 全体の大きさをそろえ、最初の 1 秒と最後の 2 秒をなめらかにする
  let peak = 0;
  for (const x of buf) peak = Math.max(peak, Math.abs(x));
  const scale = peak > 0 ? 0.6 / peak : 0;
  const samples = new Int16Array(total);
  const fadeIn = RATE;
  const fadeOut = 2 * RATE;
  for (let i = 0; i < total; i++) {
    const f = Math.min(1, i / fadeIn, (total - i) / fadeOut);
    samples[i] = Math.round(Math.max(-1, Math.min(1, buf[i]! * scale * f)) * 32767);
  }
  return { sampleRate: RATE, channels: 1, samples };
}
