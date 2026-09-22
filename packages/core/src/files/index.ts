/**
 * @file ファイルの置き場と、PDF・Excel・CSV・Word を扱う部品の公開窓口。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 */

export { LocalFileStore, MemoryFileStore, type FileStore } from './store.js';
export { detectKind, MIME, MAX_FILE_BYTES, type FileKind } from './formats.js';
export { saveFile, loadFile } from './service.js';
export { readSheet, renderSheet, parseCsv, decodeText, type SheetData } from './sheet.js';
export { extractPdfText, normalizeRadicals, type PdfText } from './pdf.js';
export { renderDocx, type DocBlock } from './docx.js';
