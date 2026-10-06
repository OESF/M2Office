/**
 * @file 販促物の書き出し（仕様書 第41.7節）。組み版の SVG を、画面と SNS 用の PNG、社内で印刷する実寸の PDF、印刷会社に出す入稿用の PDF にする。
 *
 * 入稿用は、塗り足し 3mm まで描いた同じ SVG を、裁つ位置の印（トンボ）を付けた一回り大きな紙に置く。色は RGB（CMYK への変換は段 3）。
 * 字は同梱の Noto Sans JP で画像にしてから PDF に入れる（書体を埋め込む手間と崩れを避ける）。解像度はおよそ 200dpi（大きな紙は上限で抑える）。
 */

import { PDFDocument, rgb } from 'pdf-lib';
import { PRINT_SIZES, type PrintSize } from '@m2office/shared';
import { renderSvgPng } from '../columns/cover.js';
import { BLEED, type PrintPage } from './templates.js';

/** mm を PDF の点（pt）に。 */
const MM = 72 / 25.4;
/** 書き出しの解像度（dpi）と、画像の幅の上限（画素）。 */
const DPI = 200;
const MAX_PX = 4800;
/** 入稿用の紙の、塗り足しの外の余白（mm。トンボを置く）。 */
const MARGIN = 10;

/** 見える範囲を塗り足しまで広げた SVG（入稿用）。 */
export function withBleed(svg: string, size: PrintSize): string {
  const { w, h } = PRINT_SIZES[size];
  return svg.replace(/^<svg ([^>]*?)viewBox="[^"]*" width="[^"]*" height="[^"]*">/,
    `<svg $1viewBox="${-BLEED} ${-BLEED} ${w + BLEED * 2} ${h + BLEED * 2}" width="${w + BLEED * 2}mm" height="${h + BLEED * 2}mm">`);
}

/** 幅の画素（mm と解像度から。上限で抑える）。 */
const pxOf = (mm: number, dpi = DPI) => Math.min(MAX_PX, Math.round((mm / 25.4) * dpi));

/**
 * 1 面を PNG にする。
 *
 * @param widthPx 幅の画素（省略すれば印刷の解像度）
 */
export function pagePng(page: PrintPage, size: PrintSize, widthPx?: number): Uint8Array {
  return renderSvgPng(page.svg, widthPx ?? pxOf(PRINT_SIZES[size].w));
}

/** 画面に出す小さな PNG（案を並べる）。 */
export function previewPng(page: PrintPage, size: PrintSize): Uint8Array {
  const { w, h } = PRINT_SIZES[size];
  return renderSvgPng(page.svg, Math.round(w >= h ? 900 : 900 * (w / h) * 1.4));
}

/**
 * PDF にする。実寸（社内で印刷する）か、入稿用（塗り足しとトンボ）。
 *
 * @returns PDF の中身
 */
export async function toPdf(pages: PrintPage[], size: PrintSize, kind: 'trim' | 'bleed'): Promise<Uint8Array> {
  const { w, h } = PRINT_SIZES[size];
  const doc = await PDFDocument.create();
  doc.setCreator('M2Office');
  doc.setProducer('M2Office');
  for (const page of pages) {
    if (kind === 'trim') {
      const png = await doc.embedPng(renderSvgPng(page.svg, pxOf(w)));
      const p = doc.addPage([w * MM, h * MM]);
      p.drawImage(png, { x: 0, y: 0, width: w * MM, height: h * MM });
      continue;
    }
    const bw = w + BLEED * 2;
    const bh = h + BLEED * 2;
    const pw = bw + MARGIN * 2;
    const ph = bh + MARGIN * 2;
    const png = await doc.embedPng(renderSvgPng(withBleed(page.svg, size), pxOf(bw)));
    const p = doc.addPage([pw * MM, ph * MM]);
    p.drawImage(png, { x: MARGIN * MM, y: MARGIN * MM, width: bw * MM, height: bh * MM });
    // トンボ: 仕上がりの角から外へ（塗り足しの外から 7mm）
    const tx0 = MARGIN + BLEED;
    const ty0 = MARGIN + BLEED;
    const tx1 = tx0 + w;
    const ty1 = ty0 + h;
    const black = rgb(0, 0, 0);
    const line = (x1: number, y1: number, x2: number, y2: number) => p.drawLine({ start: { x: x1 * MM, y: y1 * MM }, end: { x: x2 * MM, y: y2 * MM }, thickness: 0.25, color: black });
    for (const [x, y, dx, dy] of [[tx0, ty0, -1, -1], [tx1, ty0, 1, -1], [tx0, ty1, -1, 1], [tx1, ty1, 1, 1]] as const) {
      line(x + dx * BLEED, y, x + dx * (BLEED + 7), y);
      line(x, y + dy * BLEED, x, y + dy * (BLEED + 7));
      line(x + dx * BLEED, y + dy * BLEED, x + dx * (BLEED + 7), y + dy * BLEED);
      line(x + dx * BLEED, y + dy * BLEED, x + dx * BLEED, y + dy * (BLEED + 7));
    }
  }
  return new Uint8Array(await doc.save());
}
