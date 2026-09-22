/**
 * @file 拡張機能のファイル（`.m2ext`）の作成と展開。
 *
 * `.m2ext` は ZIP であり、直下に `manifest.json` を置く。展開はメモリの上だけで行い、
 * ディスクには書かない。入れてよいファイル以外は、展開の時点で拒否する。
 *
 * @see 仕様書 第12.10.2節 ファイルの形式
 */

import JSZip from 'jszip';
import { isAllowedExtensionFile, type ExtensionFiles } from './loader.js';

/** `.m2ext` の大きさの上限（仕様書 第12.10.2節）。 */
export const EXTENSION_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** 展開したあとの大きさの合計の上限。極端に圧縮したファイルで記憶を使い尽くさないため。 */
const EXPANDED_MAX_BYTES = 20 * 1024 * 1024;

/** ファイルの数の上限。 */
const MAX_ENTRIES = 200;

/**
 * ファイルの集まりを `.m2ext`（ZIP）にする。
 *
 * @remarks 入れてよいファイルだけを入れる。ほかのファイルは飛ばし、その名前を返す。
 */
export async function packExtension(files: ExtensionFiles): Promise<{ data: Uint8Array; skipped: string[] }> {
  const zip = new JSZip();
  const skipped: string[] = [];
  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isAllowedExtensionFile(path)) { skipped.push(path); continue; }
    // 同じ中身から同じファイルができるよう、日時を固定する
    zip.file(path, bytes, { date: new Date('2026-01-01T00:00:00Z') });
  }
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { data, skipped };
}

/**
 * `.m2ext`（ZIP）を展開する。
 *
 * @returns 展開したファイルと、展開の段階で見つかった問題。問題があれば取り込まない
 *
 * @remarks
 * すべてのファイルが 1 つのフォルダの下にある場合（フォルダごと圧縮した場合）は、そのフォルダを外す。
 * パスに `..` や絶対パスを含むものは拒否する。中身の検証は {@link loadExtensionFiles} で行う。
 */
export async function unpackExtension(data: Uint8Array): Promise<{ files: ExtensionFiles; problems: string[] }> {
  const files: ExtensionFiles = new Map();
  if (data.length > EXTENSION_FILE_MAX_BYTES) {
    return { files, problems: ['ファイルが大きすぎます（5 MB まで）'] };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return { files, problems: ['ZIP として読めません。.m2ext は ZIP の形式です'] };
  }
  const entries = Object.values(zip.files).filter((e) => !e.dir && !isJunk(e.name));
  if (entries.length > MAX_ENTRIES) return { files, problems: [`ファイルの数が多すぎます（${MAX_ENTRIES} まで）`] };
  // JSZip は `..` を正規化して名前を返すため、正規化の前の名前で確かめる
  const original = (e: JSZip.JSZipObject) => e.unsafeOriginalName ?? e.name;
  const unsafe = entries.filter((e) => {
    const n = original(e);
    return n.startsWith('/') || n.split('/').includes('..') || n.includes('\\');
  });
  if (unsafe.length > 0) return { files, problems: [`不正なパスがあります: ${unsafe.map(original).join(', ')}`] };

  const prefix = commonFolder(entries.map((e) => e.name));
  let total = 0;
  for (const e of entries) {
    const bytes = await e.async('uint8array');
    total += bytes.length;
    if (total > EXPANDED_MAX_BYTES) return { files: new Map(), problems: ['展開したあとの大きさが大きすぎます'] };
    files.set(e.name.slice(prefix.length), bytes);
  }
  return { files, problems: [] };
}

/** OS が自動で作るファイル。取り込みの対象にしない。 */
function isJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').some((p) => p === '.DS_Store' || p === 'Thumbs.db');
}

/** すべてのパスが同じ 1 つのフォルダの下にあり、直下に manifest.json が無ければ、そのフォルダ名（末尾に `/`）。 */
function commonFolder(names: string[]): string {
  if (names.includes('manifest.json')) return '';
  const first = names[0]?.split('/')[0];
  if (!first || !names.every((n) => n.startsWith(`${first}/`))) return '';
  return `${first}/`;
}
