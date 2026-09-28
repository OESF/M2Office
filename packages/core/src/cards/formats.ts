/**
 * @file 名刺の画像の形式。受け付ける形式の判定と、PDF を 1 ページ 1 枚の名刺に分けること。
 *
 * 名刺に限り、iPhone の写真の形式（HEIC・HEIF）と WebP も受け付ける。拡張子と中身の先頭の両方で確かめる。
 * スキャナーの PDF は 1 ページを 1 枚の名刺とみなし、ページに埋め込まれた JPEG があればそれを名刺の画像にする。
 *
 * @see 仕様書 第27.4節 取り込み
 */

import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';
import type { FileKind } from '../files/formats.js';

/** 名刺として受け付ける形式。 */
export type CardFileKind = Extract<FileKind, 'png' | 'jpeg' | 'pdf' | 'heic' | 'webp'>;

/** 一度に渡せる名刺のファイルの数（第27.4節）。 */
export const CARD_BATCH_MAX = 50;

/** 1 つの PDF から取り出す名刺の上限（1 回の上限と同じ）。 */
const PDF_PAGE_MAX = CARD_BATCH_MAX;

/**
 * ファイル名と中身から、名刺として受け付ける形式を判定する。
 *
 * @returns 形式。受け付けないもの、拡張子と中身が食い違うものは `null`
 */
export function detectCardKind(name: string, bytes: Uint8Array): CardFileKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  switch (ext) {
    case 'pdf': return starts(0x25, 0x50, 0x44, 0x46) ? 'pdf' : null;
    case 'png': return starts(0x89, 0x50, 0x4e, 0x47) ? 'png' : null;
    case 'jpg': case 'jpeg': return starts(0xff, 0xd8, 0xff) ? 'jpeg' : null;
    // RIFF....WEBP
    case 'webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'webp' : null;
    // ISO の箱の形（....ftypheic など）。HEIF の系列の印を見る
    case 'heic': case 'heif': {
      const brand = ascii(8, 12);
      return ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand) ? 'heic' : null;
    }
    default: return null;
  }
}

/** 形式ごとの推論に渡す種類。 */
export const CARD_MIME: Record<CardFileKind, string> = {
  png: 'image/png', jpeg: 'image/jpeg', pdf: 'application/pdf', heic: 'image/heic', webp: 'image/webp',
};

/** PDF の 1 ページから取り出した名刺の画像。 */
export interface CardPage {
  /** ページの番号（1 から）。 */
  page: number;
  kind: 'jpeg' | 'pdf';
  bytes: Uint8Array;
}

/**
 * PDF を 1 ページ 1 枚の名刺に分ける（第27.4節）。
 *
 * @returns ページごとの画像。ページに JPEG が 1 つだけ埋め込まれていれば（スキャナーの PDF）その JPEG、
 *   無ければそのページだけの PDF。読めない PDF は空
 * @remarks 画面に出すため、できるだけ画像にする。ページだけの PDF は、画面ではそのまま PDF として出す
 */
export async function splitCardPdf(bytes: Uint8Array): Promise<CardPage[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    return [];
  }
  const out: CardPage[] = [];
  const count = Math.min(doc.getPageCount(), PDF_PAGE_MAX);
  for (let i = 0; i < count; i++) {
    const jpeg = onlyJpegOf(doc, i);
    if (jpeg) {
      out.push({ page: i + 1, kind: 'jpeg', bytes: jpeg });
      continue;
    }
    const one = await PDFDocument.create();
    const [copied] = await one.copyPages(doc, [i]);
    one.addPage(copied!);
    out.push({ page: i + 1, kind: 'pdf', bytes: await one.save() });
  }
  return out;
}

/**
 * ページに埋め込まれた画像が、JPEG（DCTDecode）の 1 つだけなら、その中身を返す。
 *
 * @remarks スキャナーの PDF はページごとに JPEG を 1 つ持つことが多い。文字や図形が重なるページは画像にしない
 */
function onlyJpegOf(doc: PDFDocument, index: number): Uint8Array | null {
  try {
    const page = doc.getPage(index);
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) return null;
    const images: PDFRawStream[] = [];
    for (const [, ref] of xobjects.entries()) {
      const obj = doc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream)) return null;
      if (obj.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() !== '/Image') return null;
      images.push(obj);
    }
    if (images.length !== 1) return null;
    const filter = images[0]!.dict.lookup(PDFName.of('Filter'));
    const names = filter instanceof PDFArray ? filter.asArray().map((x) => String(x)) : [String(filter)];
    if (names.length !== 1 || names[0] !== '/DCTDecode') return null;
    const data = images[0]!.contents;
    return data[0] === 0xff && data[1] === 0xd8 ? data : null;
  } catch {
    return null;
  }
}
