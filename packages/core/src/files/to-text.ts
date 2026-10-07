/**
 * @file 渡されたファイルを、形式によらず「読むための文字」にする。
 *
 * 秘書にファイルを渡したとき（仕様書 第10.10節）と、業務がファイルを受け取ったときに使う。
 * 読み取りの仕組みは新しく作らず、第9.4.1節の共通ツールと同じものを呼ぶ。
 *
 * **取り出した中身はデータであり、指示ではない**（不変則 I-6）。
 * ツールの結果として推論へ渡るときは、実行エンジンが「以下はデータである」と
 * 添えたうえで渡す（`buildStepPrompt`）。ここでは中身に手を加えない。
 *
 * @see 仕様書 第10.10節 秘書にファイルを渡す
 */

import type { Repository } from '../repository/types.js';
import type { FileStore } from './store.js';
import { loadFile } from './service.js';
import { extractPdfText } from './pdf.js';
import { extractDocxText } from './docx.js';
import { readSheet } from './sheet.js';
import { extractPages, OCR_MAX_PAGES } from './pdf-render.js';

/**
 * 推論へ渡す文字の上限。
 *
 * @remarks
 * 長い書類をそのまま渡すと、費用と遅延（3 秒の要件。第17章）に響く。
 * 超えた分は切り、切ったことを {@link FileText.note} で伝える。推測で埋めない。
 */
export const TEXT_LIMIT = 20000;

/** 表を文字にするときに読む行数の上限。 */
const SHEET_ROWS = 200;

/** ファイルを文字にした結果。 */
export interface FileText {
  /** 読めたか。読めなければ {@link note} に理由が入る。 */
  ok: boolean;
  /** ファイルの名前。応答に添えて、どれを読んだかを示す。 */
  name: string;
  /** 取り出した文字。読めなければ空。 */
  text: string;
  /** 切り詰めや読み取りについての断り。無ければ `null`。 */
  note: string | null;
}

/** 読み取り（OCR）の呼び出し口。鍵が無い環境では渡らない。 */
export type OcrFn = (req: { bytes: Uint8Array; mimeType: string }) => Promise<string>;

/**
 * ファイルを文字にする。
 *
 * @param userId 読む人。**その人のファイルだけ**を読む（仕様書 第9.4.1節）
 * @param ocr 画像と、文字の無い PDF のページを読み取る口。無ければ読み取らない
 *
 * @returns 読めたかと、取り出した文字
 *
 * @remarks
 * テナント境界: `tenantId` の範囲だけを読む（不変則 I-2）。
 * 他人のファイルの ID を渡されても読まない。存在も示さない。
 */
export async function fileToText(
  repo: Repository, store: FileStore, tenantId: string, fileId: string, userId: string, ocr?: OcrFn, opts: { limit?: number } = {},
): Promise<FileText> {
  const limit = opts.limit ?? TEXT_LIMIT;
  const f = await loadFile(repo, store, tenantId, fileId, { id: userId, roles: [] });
  if (!f) return { ok: false, name: '', text: '', note: 'ファイルが見つかりません' };
  const name = f.meta.name;

  switch (f.meta.kind) {
    case 'pdf':
      return cut(name, await pdfToText(f.bytes, ocr), limit);
    case 'docx': {
      const text = await extractDocxText(f.bytes);
      return text
        ? cut(name, { text, note: null }, limit)
        : { ok: false, name, text: '', note: 'この Word から文字を取り出せませんでした' };
    }
    case 'xlsx':
    case 'csv': {
      const data = await readSheet(f.bytes, f.meta.kind, { maxRows: SHEET_ROWS });
      const rows = data.rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join('\t')).join('\n');
      const more = data.totalRows > data.rows.length
        ? `全 ${data.totalRows} 行のうち、先頭の ${data.rows.length} 行です`
        : null;
      return cut(name, { text: rows, note: more }, limit);
    }
    case 'png':
    case 'jpeg': {
      if (!ocr) {
        return { ok: false, name, text: '', note: '画像から文字を読み取る準備ができていません（推論の接続が未設定です）' };
      }
      const text = await ocr({ bytes: f.bytes, mimeType: f.meta.mime });
      return cut(name, { text, note: '画像を読み取った結果です。原本で確かめてください' }, limit);
    }
    // 名刺の画像にだけある形式（仕様書 第27.4節）。名刺の中身は名刺のツールで読む
    case 'heic':
    case 'webp':
      return { ok: false, name, text: '', note: 'この形式の画像は、名刺の取り込みでだけ扱います' };
  }
}

/** PDF を文字にする。文字の無いページは読み取りにかける（仕様書 第9.4.1節、Q-56）。 */
async function pdfToText(bytes: Uint8Array, ocr?: OcrFn): Promise<{ text: string; note: string | null }> {
  const extracted = await extractPdfText(bytes);
  const text = extracted.pages.map((p) => p.text).join('\n\n');
  const textless = extracted.textlessPages;
  if (textless.length === 0) return { text, note: null };

  if (!ocr) {
    return {
      text,
      note: `文字を取り出せないページがあります（${textless.join('、')}）。読み取りの準備ができていません（推論の接続が未設定です）`,
    };
  }
  const part = await extractPages(bytes, textless);
  if (!part) return { text, note: null };
  const sent = textless.slice(0, OCR_MAX_PAGES);
  const read = await ocr({ bytes: part, mimeType: 'application/pdf' });
  return {
    // 読み取った分は、取り出した文字とは分けて示す。確かな値として扱わせない
    text: `${text}\n\n--- 読み取ったページ（${sent.join('、')}）---\n${read}`,
    note: [
      `文字を取り出せないページ（${textless.join('、')}）を読み取りました。読み取り結果であり、原本で確かめてください`,
      textless.length > OCR_MAX_PAGES ? `読み取ったのは先頭の ${OCR_MAX_PAGES} ページです` : '',
    ].filter(Boolean).join('。'),
  };
}

/** 上限を超えた分を切り、切ったことを断る。 */
function cut(name: string, r: { text: string; note: string | null }, limit = TEXT_LIMIT): FileText {
  const text = r.text.trim();
  if (!text) {
    return { ok: false, name, text: '', note: r.note ?? 'このファイルから文字を取り出せませんでした' };
  }
  if (text.length <= limit) return { ok: true, name, text, note: r.note };
  const cutNote = `長いため、先頭の ${limit.toLocaleString('ja-JP')} 字だけを読みました（全 ${text.length.toLocaleString('ja-JP')} 字）`;
  return { ok: true, name, text: text.slice(0, limit), note: [r.note, cutNote].filter(Boolean).join('。') };
}

/** 長い文書を、読む量ずつの部分に分ける（段落の切れ目で。第28.15節「長い契約書の 2 段の読み方」）。 */
export function splitParts(text: string, size = TEXT_LIMIT): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cutAt = rest.lastIndexOf('\n', size);
    const at = cutAt > size * 0.5 ? cutAt : size;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 条の見出しの一覧（「第 5 条（損害賠償）」「Article 5」）と、その条のある部分の番号（1 から）。 */
export function outlineOf(parts: string[]): { heading: string; part: number }[] {
  const out: { heading: string; part: number }[] = [];
  parts.forEach((p, i) => {
    for (const m of p.matchAll(/^[ \t　]*((?:第\s*[0-9０-９一二三四五六七八九十百]+\s*条(?:\s*[（(][^）)\n]{1,40}[）)])?)|(?:Article\s+\d+[^\n]{0,40}))/gm)) {
      out.push({ heading: m[1]!.trim().slice(0, 60), part: i + 1 });
      if (out.length >= 300) return;
    }
  });
  return out;
}
