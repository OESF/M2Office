/**
 * @file WAV（16 ビットの PCM）の読み書き（仕様書 第32.18.6節 段 3）。読み上げの音と、合成した BGM を ffmpeg に渡すために使う。
 */

/** WAV の中身（16 ビットの PCM）。 */
export interface Pcm16 {
  sampleRate: number;
  channels: number;
  /** 標本（チャンネルを交互に並べたもの）。 */
  samples: Int16Array;
}

/**
 * 16 ビットの PCM を WAV にする。
 *
 * @param pcm 標本の並び（リトルエンディアンの 16 ビット。チャンネルは交互）
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** 標本の並びから WAV を作る。 */
export function samplesToWav(p: Pcm16): Uint8Array {
  return pcmToWav(new Uint8Array(p.samples.buffer, p.samples.byteOffset, p.samples.byteLength), p.sampleRate, p.channels);
}

/**
 * WAV（16 ビットの PCM）を読む。形が違えば `null`。
 *
 * @remarks `fmt ` と `data` の塊を探して読む（ほかの塊は飛ばす）
 */
export function readWav(b: Uint8Array): Pcm16 | null {
  if (b.length < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let at = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (at + 8 <= b.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || !rate || !channels) return null;
      const len = Math.min(size, b.length - body) & ~1;
      const copy = b.slice(body, body + len);
      return { sampleRate: rate, channels, samples: new Int16Array(copy.buffer, 0, len / 2) };
    }
    at = body + size + (size % 2);
  }
  return null;
}

/** WAV の長さ（ミリ秒）。読めなければ 0。 */
export function wavDurationMs(b: Uint8Array): number {
  const p = readWav(b);
  return p ? Math.round((p.samples.length / p.channels / p.sampleRate) * 1000) : 0;
}
