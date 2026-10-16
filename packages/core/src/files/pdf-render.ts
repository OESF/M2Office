/**
 * @file 帳票の PDF を作る。日本語の書体（Noto Sans JP）を、使った文字だけ抜き出して埋め込む。
 *
 * 書体は JIS X 0208 の範囲に絞って同梱している（`scripts/build-font-subset.mjs` で作る）。
 * 範囲の外の字は `〓` に置き換え、どの字だったかを `missingCharacters()` で示す。
 *
 * 体裁は最小限（表題・宛先などの項目・明細の表・合計・備考）の `renderPdf` と、よくある見積書の形（罫線の表）の
 * `renderRuledQuote` の 2 つ。会社は型を選ぶだけで、配置は作らない（第15.2.3節、ADR-0104）。印影は差出人の会社名に重ねて押す。
 *
 * @see 仕様書 第9.4.1節、Q-59、ADR-0017
 */

import { pathToFileURL } from 'node:url';
import { appPath } from '../app-root.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BlendMode, PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { toBundledFontChars } from './font-chars.js';

/** 同梱した書体の置き場（リポジトリの `assets/fonts`。Q-59 で同梱と決めた）。 */
const FONT_DIR = pathToFileURL(`${appPath('assets', 'fonts')}/`);

/** A4（ポイント）。 */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const LINE = 16;

/** 1 回の読み取りで送るページ数の上限（仕様書 第9.4.1節）。 */
export const OCR_MAX_PAGES = 10;

/**
 * 指定したページだけを抜き出した PDF を作る（仕様書 第9.4.1節）。
 *
 * @param bytes 元の PDF
 * @param pages 抜き出すページ（1 始まり）
 * @returns 抜き出した PDF。ページが 1 つも無ければ `null`
 *
 * @remarks
 * 文字を取り出せなかったページだけを読み取りへ送るために使う。
 * ページを画像にはしない（描画の部品を増やさないため。ADR-0017 決定 8）。
 */
export async function extractPages(bytes: Uint8Array, pages: number[]): Promise<Uint8Array | null> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const wanted = [...new Set(pages)]
    .filter((n) => n >= 1 && n <= source.getPageCount())
    .sort((a, b) => a - b)
    .slice(0, OCR_MAX_PAGES);
  if (wanted.length === 0) return null;
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, wanted.map((n) => n - 1));
  for (const page of copied) out.addPage(page);
  return out.save();
}

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

/**
 * 会社の帳票の体裁（仕様書 第15.2.2節、Q-57）。会社情報と設定から組み立てて渡す。
 *
 * @remarks 値が無ければ、その欄を出さない。
 */
export interface InvoiceStyleInput {
  /** ロゴの画像（PNG・JPEG）。 */
  logo?: { bytes: Uint8Array; kind: 'png' | 'jpeg' } | null;
  /** 差出人の各行（正式な会社名・住所・電話・登録番号）。 */
  from?: string[];
  /** 振込先。 */
  bankAccount?: string;
  /** 備考の定型文。 */
  notes?: string;
  /** 印を押すか（第15.2.3節）。印影が無ければ薄い「印」の字を出す。 */
  sealBox?: boolean;
  /** 印影（社印）の画像。 */
  seal?: { bytes: Uint8Array; kind: 'png' | 'jpeg' } | null;
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
  /** 会社の体裁（ロゴ・差出人・振込先・備考の定型文・印の欄）。 */
  style?: InvoiceStyleInput;
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
    for (const ch of toBundledFontChars(text)) {
      const code = ch.codePointAt(0);
      if (ch === '\n' || code === undefined) continue;
      if (!coverage?.has(code)) missing.add(ch);
    }
  }
  return [...missing];
}

/**
 * pdf-lib の「使った字だけを埋め込む」（`subset: true`）は、同梱の書体では**ほとんどの字の形を落とす**（2026-09-29 に確認。
 * 文字の情報は残るため、文字の取り出しでは気づけない）。書体をそのまま埋め込む。1 つの書体で約 1.5 MB 増える（ADR-0017 の改め）
 */
const EMBED = { subset: false } as const;

/**
 * PDF に同梱の日本語の書体を埋め込む。帳票以外の PDF（棚のラベルなど）が使う。
 *
 * @param which 埋め込む書体。使わない書体は埋め込まない（1 つで約 1.5 MB あるため）
 * @param opts.plainName 書体の名前を、末尾に番号を付けない素の形（`NotoSansJP-Regular`・`NotoSansJP-Bold`）にする。
 *   取り込む側（Canva）が名前で同じ書体を見分けるため（第41.19.3節）。同じ文書に同じ書体を 2 回埋め込まないときだけ使う
 * @returns 書体と、書体に無い字を置き換える関数
 */
export async function embedJapaneseFonts(
  pdf: PDFDocument, which: 'regular' | 'bold' = 'regular', opts: { plainName?: boolean } = {},
): Promise<{ font: PDFFont; fit(text: string): string }> {
  const fonts = await loadFonts();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(which === 'bold' ? fonts.bold : fonts.regular, {
    ...EMBED, ...(opts.plainName ? { customName: which === 'bold' ? 'NotoSansJP-Bold' : 'NotoSansJP-Regular' } : {}),
  });
  return { font, fit };
}

/** 書体に無い字を置き換える。 */
function fit(text: string): string {
  let out = '';
  // 書体に無い字のうち、同じ形の字があるもの（マイナス記号など）は、その字にする
  for (const ch of toBundledFontChars(text)) {
    const code = ch.codePointAt(0);
    out += code !== undefined && coverage?.has(code) ? ch : REPLACEMENT;
  }
  return out;
}

/** 文字を描く小さなツール。 */
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
 * 書体は、そのまま埋め込む（使った字だけを抜き出すと字の形が落ちるため。{@link EMBED}）。1 通が約 3 MB になる。
 */
export async function renderPdf(doc: InvoiceDoc): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [font, bold] = await Promise.all([
    pdf.embedFont(fonts.regular, EMBED),
    pdf.embedFont(fonts.bold, EMBED),
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
  // ロゴは右上に出す（第15.2.2節）。無ければ出さない
  const logo = doc.style?.logo
    ? await (doc.style.logo.kind === 'png' ? pdf.embedPng(doc.style.logo.bytes) : pdf.embedJpg(doc.style.logo.bytes))
    : null;
  if (logo) {
    const width = 120;
    const height = (logo.height / logo.width) * width;
    page.drawImage(logo, { x: right - width, y: y - height + 14, width, height });
  }
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
  // 差出人は、会社の体裁（会社情報）から出す。帳票ごとに書かない（第15.2.2節）
  const from = (doc.from ?? []).length > 0 ? doc.from ?? [] : doc.style?.from ?? [];
  const nameY = y;
  for (const line of from) {
    write(line, 0, y, { right, size: 9 });
    y -= LINE * 0.9;
  }
  // 印は会社名の右端に重ねる（角印の慣習。第15.2.3節）
  if (doc.style?.sealBox) {
    await drawSeal(pdf, page, font, doc.style, right - SEAL_SIZE + 10, nameY - SEAL_SIZE + 12);
    y = Math.min(y, nameY - SEAL_SIZE + 12 - LINE / 2);
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

  // 振込先と、会社の備考の定型文を、帳票ごとの備考の前に出す（第15.2.2節）
  const notes = [
    ...(doc.style?.bankAccount ? [`お振込先: ${doc.style.bankAccount}`] : []),
    ...(doc.notes ?? []),
    ...(doc.style?.notes ? [doc.style.notes] : []),
  ];
  if (notes.length > 0) {
    y -= LINE;
    feed();
    write('備考', MARGIN, y, { bold: true });
    y -= LINE;
    for (const note of notes) {
      feed();
      write(note, MARGIN, y, { size: 9 });
      y -= LINE * 0.9;
    }
  }

  return pdf.save();
}

/** 印影の大きさ（21 mm 角。ポイント）。 */
const SEAL_SIZE = 59.5;

/**
 * 印を押す（第15.2.3節）。印影があれば白い地が透けるように重ね（乗算）、無ければ薄い灰色の「印」の字を出す。
 *
 * @param x 印の枠の左下
 * @param y 印の枠の左下
 * @remarks 印影が読めなければ、薄い「印」の字にする（帳票が出せないほうが困るため）
 */
async function drawSeal(pdf: PDFDocument, page: PDFPage, font: PDFFont, style: InvoiceStyleInput, x: number, y: number): Promise<void> {
  if (style.seal) {
    try {
      const img = style.seal.kind === 'png' ? await pdf.embedPng(style.seal.bytes) : await pdf.embedJpg(style.seal.bytes);
      const scale = Math.min(SEAL_SIZE / img.width, SEAL_SIZE / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: x + (SEAL_SIZE - w) / 2, y: y + (SEAL_SIZE - h) / 2, width: w, height: h, blendMode: BlendMode.Multiply });
      return;
    } catch {
      // 読めなければ薄い「印」の字にする
    }
  }
  const size = SEAL_SIZE * 0.5;
  const shown = fit('印');
  page.drawText(shown, {
    x: x + (SEAL_SIZE - font.widthOfTextAtSize(shown, size)) / 2, y: y + (SEAL_SIZE - size) / 2 + size * 0.12,
    size, font, color: rgb(0.8, 0.8, 0.8),
  });
}

/** 罫線の表の見積書の明細 1 行（第15.2.3節）。金額は呼び出し側が決まった計算で出したもの。 */
export interface RuledQuoteRow {
  /** 区分の見出し（例: 初期費用）。同じ区分の行はまとめて、その上に見出しの行を置く。 */
  group?: string;
  /** 摘要。 */
  name: string;
  quantity: number;
  unit: string;
  /** 単価。未記入なら空欄。 */
  unitPrice: number | null;
  /** 値引きの額（正の数。赤字の負の数で出す）。 */
  discount: number;
  /** 金額（数量×単価−値引き）。 */
  amount: number;
}

/** 罫線の表の見積書の中身（第15.2.3節）。 */
export interface RuledQuoteDoc {
  /** 表題（例: 御見積書）。 */
  title: string;
  /** 宛先（例: 株式会社○○ 御中）。 */
  to?: string;
  /** 情報の欄（見積番号・発行日・お支払い条件・有効期限）。 */
  fields: { label: string; value: string }[];
  /** 前文。 */
  greeting?: string;
  rows: RuledQuoteRow[];
  /** 合計の枠（小計・消費税・合計）。最後の行を太字にする。 */
  totals: { label: string; value: string }[];
  /** 備考（定型文と、その見積だけの備考）。 */
  notes: string[];
  /** 会社の体裁（ロゴ・差出人・印）。 */
  style?: InvoiceStyleInput;
}

/** 金額の表記（例: `￥1,234`・値引きは `-￥200`）。 */
const money = (n: number) => `${n < 0 ? '-' : ''}￥${yen(Math.abs(n))}`;

/**
 * よくある見積書の形（罫線の表）の PDF を作る（第15.2.3節、Q-240、ADR-0104）。
 *
 * @remarks
 * 左上にロゴ、右上に差出人と印、中央に下線つきの表題、左に宛先・情報の欄・前文、罫線の表（区分の見出しと値引きの列）、
 * 右下に合計の枠、いちばん下に備考の枠。数量がすべて 1 なら数量の列を、値引きが無ければ値引きの列を出さない。
 * 表は空の罫線の行で埋めて 1 ページの形を保ち、収まらなければ次のページに表の見出しを付けて続ける。
 */
export async function renderRuledQuote(doc: RuledQuoteDoc): Promise<Uint8Array> {
  const fonts = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [font, bold] = await Promise.all([pdf.embedFont(fonts.regular, EMBED), pdf.embedFont(fonts.bold, EMBED)]);
  pdf.setTitle(doc.title);
  const M = 40;
  const left = M;
  const right = PAGE.width - M;
  const ink = rgb(0.1, 0.1, 0.1);
  const red = rgb(0.85, 0.1, 0.1);
  const rule = rgb(0.25, 0.25, 0.25);
  const faint = rgb(0.55, 0.55, 0.55);
  const shade = rgb(0.9, 0.9, 0.9);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  const text = (t: string, x: number, y: number, o: { size?: number; bold?: boolean; right?: number; center?: number; color?: ReturnType<typeof rgb>; maxWidth?: number } = {}) => {
    const size = o.size ?? 9;
    const f = o.bold ? bold : font;
    let shown = fit(t);
    // 欄に収まらなければ末尾を切る（行を崩さないため）
    if (o.maxWidth !== undefined) {
      while (shown.length > 1 && f.widthOfTextAtSize(shown, size) > o.maxWidth) shown = `${shown.slice(0, -2)}…`;
    }
    const w = f.widthOfTextAtSize(shown, size);
    const x0 = o.right !== undefined ? o.right - w : o.center !== undefined ? o.center - w / 2 : x;
    page.drawText(shown, { x: x0, y, size, font: f, color: o.color ?? ink });
  };
  const line = (x1: number, y1: number, x2: number, y2: number, thickness = 0.5, color = rule) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
  /** 幅に合わせて文を折り返す。 */
  const wrap = (t: string, width: number, size: number): string[] => {
    const out: string[] = [];
    for (const para of t.split('\n')) {
      let cur = '';
      for (const ch of fit(para)) {
        if (font.widthOfTextAtSize(cur + ch, size) > width && cur) { out.push(cur); cur = ''; }
        cur += ch;
      }
      out.push(cur);
    }
    return out;
  };

  // 上の段: ロゴ（左上）と差出人・印（右上）
  let y = PAGE.height - M;
  const logo = doc.style?.logo ? await (doc.style.logo.kind === 'png' ? pdf.embedPng(doc.style.logo.bytes) : pdf.embedJpg(doc.style.logo.bytes)).catch(() => null) : null;
  if (logo) {
    const scale = Math.min(160 / logo.width, 40 / logo.height);
    page.drawImage(logo, { x: left, y: y - 10 - logo.height * scale - 10, width: logo.width * scale, height: logo.height * scale });
  }
  const fromX = right - 230;
  let fy = y - 12;
  const from = doc.style?.from ?? [];
  from.forEach((l, i) => {
    // 長い住所は折り返す（切らない）
    for (const part of i === 0 ? [l] : wrap(l, right - fromX, 8.5)) {
      text(part, fromX, fy, { size: i === 0 ? 10 : 8.5, bold: i === 0, maxWidth: right - fromX });
      fy -= i === 0 ? 14 : 12;
    }
  });
  if (doc.style?.sealBox) await drawSeal(pdf, page, font, doc.style, right - SEAL_SIZE + 6, y - 12 - SEAL_SIZE + 22);
  y = Math.min(fy, y - SEAL_SIZE, y - 60) - 18;

  // 表題（中央・下線）
  const titleSize = 17;
  text(doc.title, 0, y, { size: titleSize, bold: true, center: PAGE.width / 2 });
  const tw = bold.widthOfTextAtSize(fit(doc.title), titleSize);
  line(PAGE.width / 2 - tw / 2 - 4, y - 5, PAGE.width / 2 + tw / 2 + 4, y - 5, 1, ink);
  y -= 34;

  // 宛先・情報の欄・前文（左）
  if (doc.to) {
    text(doc.to, left, y, { size: 12, bold: true, maxWidth: 300 });
    line(left, y - 4, left + 300, y - 4, 0.75, ink);
    y -= 24;
  }
  const labelW = Math.max(60, ...doc.fields.map((f) => font.widthOfTextAtSize(fit(f.label), 9))) + 8;
  for (const f of doc.fields) {
    text(f.label, left, y);
    text(`：  ${f.value}`, left + labelW, y, { maxWidth: 260 });
    y -= 13;
  }
  if (doc.greeting) {
    y -= 8;
    text(doc.greeting, left, y);
  }
  y -= 18;

  // 明細の表。列は中身で決める（数量がすべて 1 なら数量を、値引きが無ければ値引きを出さない）
  const showQty = doc.rows.some((r) => r.quantity !== 1);
  const showDiscount = doc.rows.some((r) => r.discount > 0);
  const colW = { qty: showQty ? 62 : 0, price: 82, discount: showDiscount ? 78 : 0, amount: 88 };
  const xAmount = right - colW.amount;
  const xDiscount = xAmount - colW.discount;
  const xPrice = xDiscount - colW.price;
  const xQty = xPrice - colW.qty;
  const verticals = [left, xQty, ...(showQty ? [xPrice] : []), ...(showDiscount ? [xDiscount] : []), xAmount, right];
  const ROW = 20;
  const pad = 4;
  const header = () => {
    page.drawRectangle({ x: left, y: y - ROW, width: right - left, height: ROW, color: shade });
    const ty = y - ROW + 6;
    text('摘要', 0, ty, { bold: true, center: (left + xQty) / 2 });
    if (showQty) text('数量', 0, ty, { bold: true, center: (xQty + xPrice) / 2 });
    text('単価', 0, ty, { bold: true, center: (xPrice + xDiscount) / 2 });
    if (showDiscount) text('値引き', 0, ty, { bold: true, center: (xDiscount + xAmount) / 2 });
    text('金額', 0, ty, { bold: true, center: (xAmount + right) / 2 });
    line(left, y, right, y, 0.75);
    y -= ROW;
    line(left, y, right, y, 0.75);
  };
  type Line = { kind: 'group'; label: string } | { kind: 'item'; row: RuledQuoteRow } | { kind: 'blank' };
  const lines: Line[] = [];
  let prev: string | undefined;
  for (const r of doc.rows) {
    const g = r.group?.trim() || undefined;
    if (g !== prev) {
      if (g && lines.length > 0) lines.push({ kind: 'blank' });
      if (g) lines.push({ kind: 'group', label: g });
      prev = g;
    }
    lines.push({ kind: 'item', row: r });
  }
  // 合計の枠と備考の枠に要る高さ（最後のページに置く）
  const notesLines = doc.notes.flatMap((n) => wrap(n, right - left - pad * 4, 8));
  const totalsH = doc.totals.length * ROW + 14;
  const notesH = Math.max(90, ROW + notesLines.length * 11 + 16);
  const tableTop = y;
  let rowTop = tableTop;
  const drawRow = (l: Line) => {
    const by = y - ROW;
    const ty = by + 6;
    for (const vx of verticals) line(vx, y, vx, by, 0.5);
    line(left, by, right, by, 0.3, faint);
    if (l.kind === 'group') text(`【${l.label}】`, left + pad, ty, { maxWidth: xQty - left - pad * 2 });
    if (l.kind === 'item') {
      const r = l.row;
      const indent = r.group ? 10 : 0;
      text(r.name, left + pad + indent, ty, { maxWidth: xQty - left - pad * 2 - indent });
      if (showQty) text(`${r.quantity} ${r.unit}`, 0, ty, { right: xPrice - pad, maxWidth: colW.qty - pad * 2 });
      if (r.unitPrice !== null) text(money(r.unitPrice), 0, ty, { right: xDiscount - pad });
      if (showDiscount && r.discount > 0) text(money(-r.discount), 0, ty, { right: xAmount - pad, color: red });
      text(money(r.amount), 0, ty, { right: right - pad });
    }
    y = by;
  };
  header();
  rowTop = y;
  let i = 0;
  while (i < lines.length) {
    // このページに置ける行が尽きたら、次のページに表の見出しを付けて続ける
    if (y - ROW < M) {
      line(left, rowTop, left, y, 0.75); line(right, rowTop, right, y, 0.75); line(left, y, right, y, 0.75);
      page = pdf.addPage([PAGE.width, PAGE.height]);
      y = PAGE.height - M;
      header();
      rowTop = y;
    }
    drawRow(lines[i]!);
    i++;
  }
  // 空の罫線の行で、合計と備考の枠が下に収まるところまで埋める（1 ページの形を保つ）
  const floor = M + notesH + 20 + totalsH;
  if (y - floor >= 0) {
    while (y - ROW >= floor) drawRow({ kind: 'blank' });
  } else {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - M;
    rowTop = y;
  }
  if (rowTop !== y) { line(left, rowTop, left, y, 0.75); line(right, rowTop, right, y, 0.75); line(left, y, right, y, 0.75); }

  // 合計の枠（右下。最後の 2 列にそろえる）
  y -= 6;
  const tLeft = xAmount - 120;
  doc.totals.forEach((t, k) => {
    const last = k === doc.totals.length - 1;
    page.drawRectangle({ x: tLeft, y: y - ROW, width: right - tLeft, height: ROW, borderColor: rule, borderWidth: 0.75 });
    line(xAmount, y, xAmount, y - ROW, 0.75);
    text(t.label, 0, y - ROW + 6, { right: xAmount - pad, bold: true });
    text(t.value, 0, y - ROW + 6, { right: right - pad, bold: last });
    y -= ROW;
  });

  // 備考の枠（いちばん下）
  y -= 14;
  const nTop = Math.min(y, M + notesH);
  page.drawRectangle({ x: left, y: M, width: right - left, height: nTop - M, borderColor: rule, borderWidth: 0.75 });
  page.drawRectangle({ x: left, y: nTop - ROW, width: right - left, height: ROW, color: shade, borderColor: rule, borderWidth: 0.75 });
  text('備考', 0, nTop - ROW + 6, { bold: true, center: PAGE.width / 2 });
  let ny = nTop - ROW - 14;
  for (const l of notesLines) {
    if (ny < M + 4) break;
    text(l, left + pad * 2, ny, { size: 8 });
    ny -= 11;
  }
  return pdf.save();
}

