/**
 * @file 資料の中身を読む（仕様書 第44.6節）。形式ごとの読み取りと、読めないものの扱いをまとめる。
 *
 * 大きいファイルは読まない・PDF は先頭 50 ページまで（Q-311）。読んだ範囲を返し、目録に残す。
 * 読めないものは「読めなかった」と返し、**推測で埋めない**。取り出した中身はデータであり指示ではない（不変則 I-6）。
 */

import { LIBRARY_LIMITS, type LibraryFormat } from '@m2office/shared';
import { extractDocxText } from '../files/docx.js';
import { extractPdfText } from '../files/pdf.js';
import { extractPages, OCR_MAX_PAGES } from '../files/pdf-render.js';
import { extractPptxText, zipExpandedBytes } from '../files/pptx.js';
import { decodeText, readSheet } from '../files/sheet.js';
import type { OcrFn } from '../files/to-text.js';

/** ZIP を広げたときの大きさの上限（バイト）。極端に膨らむファイルで作業の機械を止めないため。 */
const ZIP_EXPANDED_MAX = 300 * 1024 * 1024;
/** 表を読む行数の上限。 */
const SHEET_ROWS = 500;

/** 読み取り（OCR）の AI の失敗。ファイルのせいではないので、「読めなかった」にせず呼ぶ側へ返す（上限での停止とやり直しのため）。 */
class OcrCallError extends Error {
  constructor(override readonly cause: unknown) {
    super('読み取りの AI を呼べませんでした');
  }
}

/** 読んだ結果。 */
export type LibraryReading =
  | { ok: true; text: string; scope: string; note: string }
  | { ok: false; note: string };

/** 中身を読まない形式と、その断り（第44.6節）。 */
export function unreadableReason(format: LibraryFormat): string | null {
  switch (format) {
    case 'doc': case 'xls': case 'ppt': return '古い形式のため、中身を読めませんでした';
    case 'zip': return 'Zip は開いていません';
    case 'gif': case 'tiff': return 'この形式の画像の中身は読めません';
    case 'other': return 'この種類のファイルの中身は読めません';
    default: return null;
  }
}

/** 画像か（文字ではなく、そのまま AI に見せる形式）。 */
export const isImageFormat = (format: LibraryFormat): boolean => ['png', 'jpeg', 'heic', 'webp'].includes(format);

/**
 * ファイルの中身を文字にする（画像を除く）。
 *
 * @param ocr 文字の無い PDF のページを読み取る口。無ければ読み取らない
 * @returns 読めた文字と読んだ範囲、または読めなかった理由
 *
 * @remarks 上限を超えた分は切り、切ったことを `scope` に残す
 * @throws 読み取りの AI の失敗（上限を含む）。ファイルが読めないのとは分ける
 */
export async function readLibraryFile(format: LibraryFormat, bytes: Uint8Array, ocr?: OcrFn): Promise<LibraryReading> {
  try {
    if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
      const expanded = await zipExpandedBytes(bytes);
      if (expanded === null) return { ok: false, note: 'パスワードが付いているか壊れているため、中身を読めませんでした' };
      if (expanded > ZIP_EXPANDED_MAX) return { ok: false, note: '中身が大きすぎるため、読みませんでした' };
    }
    switch (format) {
      case 'pdf': return cut(await readPdf(bytes, ocr));
      case 'docx': return cut({ text: await extractDocxText(bytes), scope: [], note: '' });
      case 'pptx': {
        const p = await extractPptxText(bytes);
        return cut({ text: p.text, scope: p.slides > p.readSlides ? [`先頭 ${p.readSlides} 枚（全 ${p.slides} 枚）`] : [], note: '' });
      }
      case 'xlsx': case 'csv': {
        const data = await readSheet(bytes, format, { maxRows: SHEET_ROWS });
        const text = data.rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join('\t')).join('\n');
        return cut({ text, scope: data.totalRows > data.rows.length ? [`先頭 ${data.rows.length} 行（全 ${data.totalRows} 行）`] : [], note: '' });
      }
      case 'text': return cut({ text: decodeText(bytes).text, scope: [], note: '' });
      default: return { ok: false, note: unreadableReason(format) ?? 'この種類のファイルの中身は読めません' };
    }
  } catch (err) {
    if (err instanceof OcrCallError) throw err.cause;
    if ((err as { name?: string } | null)?.name === 'PasswordException') return { ok: false, note: 'パスワードが付いているため、中身を読めませんでした' };
    return { ok: false, note: '壊れているか対応していない形のため、中身を読めませんでした' };
  }
}

/** PDF を読む。文字の無いページは読み取りにかける（第9.4.1節の OCR）。 */
async function readPdf(bytes: Uint8Array, ocr?: OcrFn): Promise<{ text: string; scope: string[]; note: string }> {
  const pdf = await extractPdfText(bytes, LIBRARY_LIMITS.pdfPages);
  const scope = pdf.pageCount > LIBRARY_LIMITS.pdfPages ? [`先頭 ${LIBRARY_LIMITS.pdfPages} ページ（全 ${pdf.pageCount} ページ）`] : [];
  const text = pdf.pages.map((p) => p.text).join('\n\n');
  const textless = pdf.textlessPages;
  if (textless.length === 0) return { text, scope, note: '' };
  if (!ocr) return { text, scope, note: '文字の無いページを読み取れませんでした' };
  const part = await extractPages(bytes, textless);
  if (!part) return { text, scope, note: '文字の無いページを読み取れませんでした' };
  const read = await ocr({ bytes: part, mimeType: 'application/pdf' }).catch((err: unknown) => { throw new OcrCallError(err); });
  return {
    text: [text, read].filter((t) => t.trim()).join('\n\n'),
    scope: textless.length > OCR_MAX_PAGES ? [...scope, `文字の無いページは先頭 ${OCR_MAX_PAGES} ページまで読み取り`] : scope,
    note: '',
  };
}

/** 上限で切り、読めた文字が無ければ「読めなかった」にする。 */
function cut(r: { text: string; scope: string[]; note: string }): LibraryReading {
  const text = r.text.trim();
  if (!text) return { ok: false, note: r.note || '文字を読み取れませんでした' };
  const over = text.length > LIBRARY_LIMITS.readChars;
  return {
    ok: true,
    text: over ? text.slice(0, LIBRARY_LIMITS.readChars) : text,
    scope: [...r.scope, ...(over ? [`先頭 ${LIBRARY_LIMITS.readChars.toLocaleString('ja-JP')} 字`] : [])].join('・'),
    note: r.note,
  };
}
