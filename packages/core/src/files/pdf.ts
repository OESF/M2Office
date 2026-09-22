/**
 * @file PDF から文字を取り出す。画像だけのページは明示し、部首の文字を通常の漢字に直す。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 * @see ADR-0004 文書形式を扱うライブラリの選定
 */

/** PDF から取り出した 1 ページ分の文字。 */
export interface PdfPage {
  page: number;
  text: string;
}

export interface PdfText {
  pageCount: number;
  pages: PdfPage[];
  /** 文字を取り出せなかったページ。画像だけのページ（スキャンなど）が該当する。 */
  textlessPages: number[];
}

/**
 * PDF から文字を取り出す。
 *
 * @param bytes PDF の中身
 * @param maxPages 読むページ数の上限
 *
 * @remarks
 * 文字情報を持たないページ（スキャンした証憑など）は空として返さず、
 * `textlessPages` に挙げる。OCR は未対応である（Q-56）。
 * 読めなかったことを「何も書いていない」と取り違えないため。
 */
export async function extractPdfText(bytes: Uint8Array, maxPages = 50): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), // pdf.js は渡した配列を手放すため複製する
    useSystemFonts: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  try {
    const pages: PdfPage[] = [];
    const textless: number[] = [];
    const count = Math.min(doc.numPages, maxPages);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      const text = normalizeRadicals(lines.join('\n')).trim();
      if (!text) textless.push(n);
      pages.push({ page: n, text });
    }
    return { pageCount: doc.numPages, pages, textlessPages: textless };
  } finally {
    await task.destroy();
  }
}

/**
 * 康熙部首・CJK 部首補助の文字を、通常の漢字に直す。
 *
 * @remarks
 * PDF の書体によっては「金」が部首の「⾦」（U+2F26）として取り出され、
 * 見た目は同じでも「金額」で検索しても当たらなくなる。
 * 全角の括弧や数字まで変えないよう、NFKC はこの範囲の文字にだけ掛ける。
 */
export function normalizeRadicals(text: string): string {
  return text.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (ch) => ch.normalize('NFKC'));
}
