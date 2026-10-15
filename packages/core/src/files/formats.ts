/**
 * @file 受け付けるファイルの形式と、拡張子・中身の先頭からの形式の判定。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

/**
 * 受け付けるファイルの形式。
 *
 * 拡張子と先頭のバイト列の両方で確かめる。拡張子だけを信じない。
 * `heic`・`webp` は名刺の画像に限って受け付ける（仕様書 第27.4節。{@link detectKind} は受け付けない）。
 * `mp3`・`m4a`・`wav` は録音（第9.4.5節）。`txt` は録音を文字にした結果で、受け取りでは受け付けない（録音を置き換えて作る）。
 */
export type FileKind = 'pdf' | 'xlsx' | 'csv' | 'docx' | 'png' | 'jpeg' | 'heic' | 'webp' | 'mp3' | 'm4a' | 'wav' | 'txt';

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8',
};

/** 録音の形式（第9.4.5節）。 */
export const AUDIO_KINDS: readonly FileKind[] = ['mp3', 'm4a', 'wav'];

/** 録音の形式か。 */
export function isAudioKind(kind: string): kind is 'mp3' | 'm4a' | 'wav' {
  return (AUDIO_KINDS as readonly string[]).includes(kind);
}

/** 録音の 1 ファイルの上限（バイト。第9.4.5節）。 */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
/** 録音の長さの上限（秒。第9.4.5節）。 */
export const MAX_AUDIO_SECONDS = 3 * 3600;

/** 拡張子から、録音として受け取るものか（大きさの上限を先に決めるため。中身は {@link detectKind} で確かめる）。 */
export function isAudioName(name: string): boolean {
  return /\.(mp3|m4a|wav)$/i.test(name);
}

/** 1 ファイルの上限（バイト）。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * ファイル名と中身から形式を判定する。
 *
 * @returns 形式。受け付けないもの、拡張子と中身が食い違うものは `null`
 */
export function detectKind(name: string, bytes: Uint8Array): FileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const zip = starts(0x50, 0x4b, 0x03, 0x04);
  switch (ext) {
    case 'pdf': return starts(0x25, 0x50, 0x44, 0x46) ? 'pdf' : null; // %PDF
    case 'xlsx': return zip ? 'xlsx' : null;
    case 'docx': return zip ? 'docx' : null;
    case 'png': return starts(0x89, 0x50, 0x4e, 0x47) ? 'png' : null;
    case 'jpg': case 'jpeg': return starts(0xff, 0xd8, 0xff) ? 'jpeg' : null;
    // CSV は署名を持たない。NUL を含まないことだけを確かめる
    case 'csv': return bytes.subarray(0, 4096).includes(0) ? null : 'csv';
    // 録音（第9.4.5節）。MP3 は ID3 か、フレームの先頭（11 ビットの 1）。M4A は `ftyp` の箱。WAV は RIFF…WAVE
    case 'mp3': return starts(0x49, 0x44, 0x33) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) ? 'mp3' : null;
    case 'm4a': return ascii(bytes, 4, 4) === 'ftyp' ? 'm4a' : null;
    case 'wav': return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE' ? 'wav' : null;
    default: return null;
  }
}

/** バイト列の一部を ASCII として読む。 */
function ascii(bytes: Uint8Array, at: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + len));
}
