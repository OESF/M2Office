/**
 * @file 資料に入れるファイルの形式を、拡張子と中身の先頭の両方で確かめる（仕様書 第44.10節「ファイルの確かめ」）。
 *
 * 読めない形式でも、資料でないものでなければ置いて、名前と種類で探せるようにする（第44.6節）。
 * 実行ファイルとスクリプトは、名前を変えてあっても受け取らない（第44.3節）。
 */

import { isRefusedLibraryName, type LibraryFormat } from '@m2office/shared';

const MIME_OF: Partial<Record<LibraryFormat, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  text: 'text/plain',
  png: 'image/png',
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  zip: 'application/zip',
};

/** 形式の種類（ドライブに置くときに渡す）。 */
export const libraryMimeOf = (format: LibraryFormat): string => MIME_OF[format] ?? 'application/octet-stream';

/** 拡張子ごとの形式。ここに無いものは `other`。 */
const EXT_FORMAT: Record<string, LibraryFormat> = {
  pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', csv: 'csv', txt: 'text', md: 'text',
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', heic: 'heic', webp: 'webp', gif: 'gif', tif: 'tiff', tiff: 'tiff',
  doc: 'doc', xls: 'xls', ppt: 'ppt', zip: 'zip',
};

/** 中身が実行ファイルかスクリプトか（Windows の MZ、Linux の ELF、Mac の Mach-O、`#!`）。 */
function isExecutable(b: Uint8Array): boolean {
  const at = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  return at(0x4d, 0x5a) || at(0x7f, 0x45, 0x4c, 0x46) || at(0x23, 0x21)
    || at(0xfe, 0xed, 0xfa, 0xce) || at(0xfe, 0xed, 0xfa, 0xcf) || at(0xce, 0xfa, 0xed, 0xfe) || at(0xcf, 0xfa, 0xed, 0xfe) || at(0xca, 0xfe, 0xba, 0xbe);
}

/**
 * ファイルの名前と中身から、資料の形式を決める。
 *
 * @returns 形式。受け取らないもの（資料でないもの・拡張子と中身が食い違うもの）は `null`
 *
 * @remarks Office の新しい形式でパスワードが付いたものは、中身が古い形式と同じ（OLE）になる。受け取ったうえで「読めなかった」と示す（第44.6節）
 */
export function detectLibraryFormat(name: string, bytes: Uint8Array): LibraryFormat | null {
  if (isRefusedLibraryName(name) || isExecutable(bytes)) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  const format = EXT_FORMAT[ext] ?? 'other';
  const at = (...sig: number[]) => sig.every((v, i) => bytes[i] === v);
  const ascii = (from: number, len: number) => String.fromCharCode(...bytes.subarray(from, from + len));
  const zip = at(0x50, 0x4b);
  const ole = at(0xd0, 0xcf, 0x11, 0xe0);
  switch (format) {
    case 'pdf': return at(0x25, 0x50, 0x44, 0x46) ? format : null;
    case 'docx': case 'xlsx': case 'pptx': return zip || ole ? format : null;
    case 'doc': case 'xls': case 'ppt': return ole ? format : null;
    case 'zip': return zip ? format : null;
    case 'png': return at(0x89, 0x50, 0x4e, 0x47) ? format : null;
    case 'jpeg': return at(0xff, 0xd8, 0xff) ? format : null;
    case 'gif': return ascii(0, 3) === 'GIF' ? format : null;
    case 'webp': return ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' ? format : null;
    case 'heic': return ascii(4, 4) === 'ftyp' ? format : null;
    case 'tiff': return at(0x49, 0x49, 0x2a, 0x00) || at(0x4d, 0x4d, 0x00, 0x2a) ? format : null;
    // 文字のファイルに署名は無い。NUL を含まないことだけを確かめる
    case 'csv': case 'text': return bytes.subarray(0, 4096).includes(0) ? null : format;
    default: return format;
  }
}

/** ドライブのファイルの情報（名前と種類）から形式を決める。中身は読むときに確かめる。 */
export function libraryFormatFromDrive(name: string, kind: string): LibraryFormat {
  if (kind === 'document' || kind === 'spreadsheet' || kind === 'presentation') return 'google';
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return EXT_FORMAT[dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''] ?? (kind === 'pdf' ? 'pdf' : 'other');
}
