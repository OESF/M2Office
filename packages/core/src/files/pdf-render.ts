/**
 * @file 帳票の PDF を作る。日本語の書体（Noto Sans JP）を、使った文字だけ抜き出して埋め込む。
 *
 * 書体は JIS X 0208 の範囲に絞って同梱している（`scripts/build-font-subset.mjs` で作る）。
 * 範囲の外の字は `〓` に置き換え、どの字だったかを `missingCharacters()` で示す。
 *
 * 体裁は最小限（表題・宛先などの項目・明細の表・合計・備考）にとどめる。
 * 会社ごとのひな形（ロゴ・色・並び）は Q-57 で決める。
 *
 * @see 仕様書 第9.4.1節、Q-59、ADR-0017
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/** 同梱した書体の置き場（リポジトリの `assets/fonts`。Q-59 で同梱と決めた）。 */
const FONT_DIR = new URL('../../../../assets/fonts/', import.meta.url);

/** A4（ポイント）。 */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const LINE = 16;

/** 帳票の明細の 1 行。 */
export interface InvoiceRow {
  /** 品目。 */
  name: string;
  /** 数量。 */
  quantity?: number | null;
  /** 単価。 */
  unitPrice?: number | null;
  /** 金額。省略すると数量×単価から求める。 */
  amount?: number | null;
}

/** 帳票の中身。金額の計算と体裁だけを扱い、制度の判断はしない。 */
export interface InvoiceDoc {
  /** 表題（例: 請求書）。 */
  title: string;
  /** 宛先（例: 株式会社○○ 御中）。 */
  to?: string;
  /** 差出人（自社）。複数行。 */
  from?: string[];
  /** 表題の下に並べる項目（発行日・番号・支払期限など）。 */
  fields?: { label: string; value: string }[];
  /** 明細。 */
  rows: InvoiceRow[];
  /** 合計の欄（小計・消費税・合計など）。省略すると明細の合計だけを出す。 */
  totals?: { label: string; value: string }[];
  /** 備考。 */
  notes?: string[];
}

/** 明細 1 行の金額。指定が無ければ数量×単価。 */
export function rowAmount(row: InvoiceRow): number {
  if (typeof row.amount === 'number') return row.amount;
  const q = typeof row.quantity === 'number' ? row.quantity : 1;
  const p = typeof row.unitPrice === 'number' ? row.unitPrice : 0;
  return q * p;
}

/** 金額の表記（例: `1,234`）。通貨の記号は付けない（会社ごとに違うため）。 */
export function yen(n: number): string {
  return Math.round(n).toLocaleString('ja-JP');
}

/**
 * 同梱した書体に無い字の代わりに置く記号。
 *
 * @remarks
 * 書体は JIS X 0208 の範囲に絞って同梱している（Q-59）。範囲の外の字（人名の異体字など）は
 * 黙って空白にせず、この記号に置き換えたうえで、どの字が置き換わったかを呼び出し側へ返す。
 */
export const REPLACEMENT = '〓';

let cache: { regular: Uint8Array; bold: Uint8Array } | null = null;
let coverage: { has(code: number): boolean } | null = null;

/**
 * 同梱した書体を読む。
 *
 * @remarks 1 度読んだら使い回す。書体のファイルは 4〜5 MB あり、毎回読むと遅いため
 */
async function loadFonts(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  if (cache) return cache;
  const [regular, bold] = await Promise.all([
    readFile(fileURLToPath(new URL('NotoSansJP-Regular.ttf', FONT_DIR))),
    readFile(fileURLToPath(new URL('NotoSansJP-Bold.ttf', FONT_DIR))),
  ]);
  cache = { regular: new Uint8Array(regular), bold: new Uint8Array(bold) };
  // 字があるかの判定は通常の書体で行う（太字も同じ範囲で作っている）
  const font = fontkit.create(cache.regular) as { hasGlyphForCodePoint(code: number): boolean };
  coverage = { has: (code) => font.hasGlyphForCodePoint(code) };
  return cache;
}

/**
 * 同梱した書体に無い字を挙げる。
 *
 * @param texts 帳票に載せる文字列
 * @returns 書体に無い字（重複を除く）。すべて出せるなら空
 *
 * @remarks 呼び出し側は、これを「置き換えた字」として利用者に示す。黙って落とさないため。
 */
export async function missingCharacters(texts: string[]): Promise<string[]> {
  await loadFonts();
  const missing = new Set<string>();
  for (const text of texts) {
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (ch === '\n' || code === undefined) continue;
      if (!coverage?.has(code)) missing.add(ch);
    }
  }
  return [...missing];
}

/** 書体に無い字を置き換える。 */
function fit(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    out += code !== undefined && coverage?.has(code) ? ch : REPLACEMENT;
  }
  return out;
}

/** 文字を描く小さな道具。 */
function writer(page: PDFPage, font: PDFFont, boldFont: PDFFont) {
  return (text: string, x: number, y: number, opts: { size?: number; bold?: boolean; right?: number } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.bold ? boldFont : font;
    // 同梱した書体に無い字は置き換える。空白のまま出して、消えたことに気づかれないのを避ける
    const shown = fit(text);
    const left = opts.right === undefined ? x : opts.right - f.widthOfTextAtSize(shown, size);
    page.drawText(shown, { x: left, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  };
}

/**
 * 帳票の PDF を作る。
 *
 * @param doc 帳票の中身
 * @returns PDF の中身
 *
 * @remarks
 * 書体は**使った文字だけ**を抜き出して埋め込む（`subset: true`）。
 * 日本語の書体をそのまま入れると 1 通が数 MB になるため。
 */
export async function renderPdf(doc: InvoiceDoc): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [font, bold] = await Promise.all([
    pdf.embedFont(fonts.regular, { subset: true }),
    pdf.embedFont(fonts.bold, { subset: true }),
  ]);
  pdf.setTitle(doc.title);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let write = writer(page, font, bold);
  let y = PAGE.height - MARGIN;
  const right = PAGE.width - MARGIN;
  /** 残りが足りなければ次のページへ送る。 */
  const feed = (need = LINE) => {
    if (y - need >= MARGIN) return;
    page = pdf.addPage([PAGE.width, PAGE.height]);
    write = writer(page, font, bold);
    y = PAGE.height - MARGIN;
  };

  write(doc.title, MARGIN, y, { size: 20, bold: true });
  y -= LINE * 2;

  for (const f of doc.fields ?? []) {
    write(`${f.label}: ${f.value}`, MARGIN, y, { right });
    y -= LINE;
  }
  if (doc.to) {
    y -= LINE / 2;
    write(doc.to, MARGIN, y, { size: 12, bold: true });
    y -= LINE;
  }
  for (const line of doc.from ?? []) {
    write(line, 0, y, { right, size: 9 });
    y -= LINE * 0.9;
  }

  // 明細の表。列は 品目・数量・単価・金額 の 4 つに固定する（最小限の体裁）
  y -= LINE;
  const cols = { name: MARGIN, quantity: right - 260, unitPrice: right - 160, amount: right };
  write('品目', cols.name, y, { bold: true });
  write('数量', 0, y, { right: cols.quantity, bold: true });
  write('単価', 0, y, { right: cols.unitPrice, bold: true });
  write('金額', 0, y, { right: cols.amount, bold: true });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= LINE;

  let subtotal = 0;
  for (const row of doc.rows) {
    feed();
    const amount = rowAmount(row);
    subtotal += amount;
    write(row.name, cols.name, y);
    if (typeof row.quantity === 'number') write(String(row.quantity), 0, y, { right: cols.quantity });
    if (typeof row.unitPrice === 'number') write(yen(row.unitPrice), 0, y, { right: cols.unitPrice });
    write(yen(amount), 0, y, { right: cols.amount });
    y -= LINE;
  }

  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
  y -= LINE * 1.5;
  const totals = doc.totals ?? [{ label: '合計', value: yen(subtotal) }];
  for (const t of totals) {
    feed();
    write(t.label, 0, y, { right: cols.unitPrice, bold: true });
    write(t.value, 0, y, { right: cols.amount, bold: true });
    y -= LINE;
  }

  if ((doc.notes ?? []).length > 0) {
    y -= LINE;
    feed();
    write('備考', MARGIN, y, { bold: true });
    y -= LINE;
    for (const note of doc.notes ?? []) {
      feed();
      write(note, MARGIN, y, { size: 9 });
      y -= LINE * 0.9;
    }
  }

  return pdf.save();
}
