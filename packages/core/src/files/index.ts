/**
 * @file ファイルの置き場と、PDF・Excel・CSV・Word を扱う部品の公開窓口（帳票の PDF 出力を含む）。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

export { LocalFileStore, MemoryFileStore, type FileStore } from './store.js';
export { detectKind, MIME, MAX_FILE_BYTES, type FileKind } from './formats.js';
export { saveFile, loadFile } from './service.js';
export { readSheet, renderSheet, parseCsv, decodeText, type SheetData } from './sheet.js';
export { extractPdfText, normalizeRadicals, type PdfText } from './pdf.js';
export { renderDocx, extractDocxText, type DocBlock } from './docx.js';
export { fileToText, TEXT_LIMIT, type FileText, type OcrFn } from './to-text.js';
export {
  renderPdf, rowAmount, yen, missingCharacters, extractPages, REPLACEMENT, OCR_MAX_PAGES,
  type InvoiceDoc, type InvoiceRow,
} from './pdf-render.js';
