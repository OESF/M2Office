/**
 * @file Excel・CSV の読み書き。Shift_JIS の CSV を読み、CSV は BOM 付き UTF-8 で書く。
 *
 * @see 仕様書 第9.4.1節 文書を扱う共通ツール
 * @see ADR-0004 文書形式を扱うライブラリの選定
 */

import ExcelJS from 'exceljs';

/** 表として読んだ結果。値はすべて文字列・数値・真偽値・空（null）のいずれか。 */
export interface SheetData {
  sheets: string[];
  sheet: string;
  rows: (string | number | boolean | null)[][];
  totalRows: number;
  /** CSV のときの文字コード。Excel のときは `null`。 */
  encoding: 'utf-8' | 'shift_jis' | null;
}

/**
 * Excel（xlsx）または CSV を表として読む。
 *
 * @param bytes ファイルの中身
 * @param kind 形式
 * @param opts 読むシート（省略時は先頭）と最大行数
 * @throws {Error} シートが見つからない場合
 *
 * @remarks
 * 国内の銀行や会計ソフトが出す CSV は Shift_JIS のことが多い。
 * UTF-8 として読めなければ Shift_JIS として読み直す（文字化けを推測で直さない）。
 */
export async function readSheet(
  bytes: Uint8Array,
  kind: 'xlsx' | 'csv',
  opts: { sheet?: string; maxRows?: number } = {},
): Promise<SheetData> {
  const maxRows = opts.maxRows ?? 500;
  if (kind === 'csv') {
    const { text, encoding } = decodeText(bytes);
    const rows = parseCsv(text).map((r) => r.map(cell));
    return { sheets: ['CSV'], sheet: 'CSV', rows: rows.slice(0, maxRows), totalRows: rows.length, encoding };
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const names = wb.worksheets.map((w) => w.name);
  const ws = opts.sheet ? wb.getWorksheet(opts.sheet) : wb.worksheets[0];
  if (!ws) throw new Error(`シートが見つかりません: ${opts.sheet ?? '(先頭)'}`);
  const rows: SheetData['rows'] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1); // 1 始まりのため先頭を捨てる
    rows.push(values.map(excelCell));
  });
  return { sheets: names, sheet: ws.name, rows: rows.slice(0, maxRows), totalRows: rows.length, encoding: null };
}

/**
 * 表を Excel（xlsx）または CSV にする。
 *
 * @remarks
 * CSV は BOM 付きの UTF-8 で出す。BOM が無いと、Excel で開いたときに日本語が化けるため。
 */
export async function renderSheet(
  title: string,
  columns: string[],
  rows: (string | number | boolean | null)[][],
  format: 'xlsx' | 'csv',
): Promise<Uint8Array> {
  if (format === 'csv') {
    const lines = [columns, ...rows].map((r) => r.map(csvEscape).join(','));
    return new TextEncoder().encode('﻿' + lines.join('\r\n') + '\r\n');
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31) || 'Sheet1'); // シート名は 31 文字まで
  ws.addRow(columns).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((c) => { c.width = 16; });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** UTF-8 として読めなければ Shift_JIS として読む。先頭の BOM は取り除く。 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'shift_jis' } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.replace(/^﻿/, ''), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  }
}

/**
 * CSV を行と列に分ける（RFC 4180。引用符の中の改行・カンマ・二重引用符に対応）。
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvEscape(v: string | number | boolean | null): string {
  const s = v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV の値。空は null、数値として読めるものも文字列のまま返す（先頭の 0 を落とさないため）。 */
function cell(v: string): string | null {
  return v === '' ? null : v;
}

function excelCell(v: ExcelJS.CellValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return excelCell((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue); // 数式は計算結果
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return null;
  }
  return String(v);
}
