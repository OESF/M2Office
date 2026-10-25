/**
 * @file 表の見た目（見出しの行・本文の行の書式と、1 行おきの塗り）を決め、Sheets API の命令にする
 * （仕様書 第9.5.5.2節「表の作成の扱いとテンプレート」、Q-268、ADR-0111）。
 *
 * テンプレート（Google スプレッドシートのテンプレート ギャラリーから作ったもの）からは、最初の表の見出しの行と本文の行の書式を読む。
 * 中身の形（決まった枠・式・グラフ）は使わない。テンプレートを使わないとき（標準）は、スプレッドシートのテーマの色で書式を付ける。
 * Google には触らない（読んだ JSON から決め、命令を作るだけ）。
 */

type Request = Record<string, unknown>;
type Json = Record<string, any>;

/** 色（0〜1 の RGB）。 */
export interface SheetRgb { red: number; green: number; blue: number }

/** 表の見た目。 */
export interface SheetLook {
  header: { background: SheetRgb; foreground: SheetRgb; bold: boolean; font?: string; size?: number };
  body: { foreground?: SheetRgb; font?: string; size?: number };
  /** 1 行おきに塗る色（本文の 2 行目ごと）。 */
  band: SheetRgb;
  /** 本文の 1 行目ごとの色（たいていは白）。 */
  base: SheetRgb;
}

const rgb = (c: Json | undefined): SheetRgb | null =>
  (c && (c['red'] !== undefined || c['green'] !== undefined || c['blue'] !== undefined)
    ? { red: Number(c['red'] ?? 0), green: Number(c['green'] ?? 0), blue: Number(c['blue'] ?? 0) } : null);
const mix = (a: SheetRgb, b: SheetRgb, t: number): SheetRgb => ({
  red: a.red + (b.red - a.red) * t, green: a.green + (b.green - a.green) * t, blue: a.blue + (b.blue - a.blue) * t,
});
const WHITE: SheetRgb = { red: 1, green: 1, blue: 1 };
const isWhite = (c: SheetRgb) => c.red > 0.97 && c.green > 0.97 && c.blue > 0.97;

/**
 * シートの書式（`includeGridData` で読んだ `rowData`）から、見出しの行と本文の行の書式を読む。
 * 見出しの行は、上から見て値が 2 つ以上ある最初の行。本文の行はその次の値のある行。見つからなければ `null`（標準にする）。
 */
export function readLook(rowData: Json[] | undefined): SheetLook | null {
  const rows = (rowData ?? []).map((r) => ((r['values'] as Json[] | undefined) ?? []));
  const filled = (row: Json[]) => row.filter((c) => typeof c['formattedValue'] === 'string' && c['formattedValue'].trim() !== '');
  const h = rows.findIndex((r) => filled(r).length >= 2);
  if (h === -1) return null;
  const hf = (filled(rows[h]!)[0]?.['effectiveFormat'] ?? {}) as Json;
  const bodyRow = rows.slice(h + 1).find((r) => filled(r).length >= 1);
  const bf = ((bodyRow ? filled(bodyRow)[0] : undefined)?.['effectiveFormat'] ?? {}) as Json;
  const background = rgb(hf['backgroundColor']) ?? WHITE;
  const tf = (hf['textFormat'] ?? {}) as Json;
  const btf = (bf['textFormat'] ?? {}) as Json;
  const base = rgb(bf['backgroundColor']) ?? WHITE;
  // 見出しが塗られていなければ、見出しの文字の色を薄めた色で 1 行おきに塗る
  const accent = isWhite(background) ? (rgb(tf['foregroundColor']) ?? { red: 0.4, green: 0.4, blue: 0.4 }) : background;
  return {
    header: {
      background, foreground: rgb(tf['foregroundColor']) ?? { red: 0, green: 0, blue: 0 }, bold: tf['bold'] !== false,
      ...(typeof tf['fontFamily'] === 'string' ? { font: tf['fontFamily'] } : {}), ...(typeof tf['fontSize'] === 'number' ? { size: tf['fontSize'] } : {}),
    },
    body: {
      ...(rgb(btf['foregroundColor']) ? { foreground: rgb(btf['foregroundColor'])! } : {}),
      ...(typeof btf['fontFamily'] === 'string' ? { font: btf['fontFamily'] } : {}), ...(typeof btf['fontSize'] === 'number' ? { size: btf['fontSize'] } : {}),
    },
    band: mix(accent, base, 0.88), base,
  };
}

/**
 * 表の見た目を付ける命令（見出しの行の書式・本文の書式・1 行おきの塗り・見出しの固定・列の幅）。
 *
 * @param look テンプレートから読んだ見た目。`null` なら標準（スプレッドシートのテーマの色で塗る）
 * @param size 列の数と、見出しを含む行の数
 */
export function lookRequests(sheetId: number, size: { columns: number; rows: number }, look: SheetLook | null): Request[] {
  const cols = Math.max(1, size.columns);
  const range = (r0: number, r1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 0, endColumnIndex: cols });
  const requests: Request[] = [];
  const header = look
    ? {
      backgroundColor: look.header.background,
      textFormat: { bold: look.header.bold, foregroundColor: look.header.foreground, ...(look.header.font ? { fontFamily: look.header.font } : {}), ...(look.header.size ? { fontSize: look.header.size } : {}) },
      verticalAlignment: 'MIDDLE',
    }
    : {
      backgroundColorStyle: { themeColor: 'ACCENT1' },
      textFormat: { bold: true, foregroundColorStyle: { themeColor: 'BACKGROUND' } },
      verticalAlignment: 'MIDDLE',
    };
  requests.push({ repeatCell: { range: range(0, 1), cell: { userEnteredFormat: header }, fields: 'userEnteredFormat(backgroundColor,backgroundColorStyle,textFormat,verticalAlignment)' } });
  if (look && (look.body.font || look.body.size || look.body.foreground) && size.rows > 1) {
    requests.push({
      repeatCell: {
        range: range(1, size.rows),
        cell: { userEnteredFormat: { textFormat: { ...(look.body.font ? { fontFamily: look.body.font } : {}), ...(look.body.size ? { fontSize: look.body.size } : {}), ...(look.body.foreground ? { foregroundColor: look.body.foreground } : {}) } } },
        fields: 'userEnteredFormat.textFormat',
      },
    });
  }
  if (size.rows > 1) {
    requests.push({
      addBanding: {
        bandedRange: {
          range: range(1, size.rows),
          rowProperties: look
            ? { firstBandColor: look.base, secondBandColor: look.band }
            : { firstBandColorStyle: { themeColor: 'BACKGROUND' }, secondBandColor: { red: 0.95, green: 0.96, blue: 0.97 } },
        },
      },
    });
  }
  requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
  requests.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } });
  return requests;
}
