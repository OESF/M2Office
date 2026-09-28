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
 */
export type FileKind = 'pdf' | 'xlsx' | 'csv' | 'docx' | 'png' | 'jpeg' | 'heic' | 'webp';

export const MIME: Record<FileKind, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  webp: 'image/webp',
};

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
    default: return null;
  }
}
