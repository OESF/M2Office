/**
 * @file 棚のラベル（QR）を A4 に並べた印刷用の PDF を作る（仕様書 第29.7節、ADR-0050）。
 *
 * 1 枚に 3 列 × 7 段。ラベルごとに QR と倉庫・棚の名前を出す。
 * QR には、その棚を開くスマホ用のページの URL（会社のホストと棚の推測されにくい値 `labelKey` だけ）を入れる（第 0.162.0 版）。
 * スマホのふつうのカメラで読めば、その棚のページが開く。
 * QR の升目は `qrcode` で計算し、描くのは pdf-lib（帳票と同じ日本語の書体を使う）。
 */

import QRCode from 'qrcode';
import { PDFDocument, rgb } from 'pdf-lib';
import type { InventoryLocation } from '@m2office/shared';
import { embedJapaneseFonts } from '../files/pdf-render.js';

/** A4（ポイント）。 */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 28;
const COLS = 3;
const ROWS = 7;
/** QR の一辺（ポイント。約 27 mm）。 */
const QR_SIZE = 76;

/** スマホ用の在庫のページの道（第29.11.1節）。 */
export const MOBILE_INVENTORY_PATH = '/m/inventory';

/**
 * 棚を開くスマホ用のページの URL。
 *
 * @param origin 会社の画面のオリジン（`https://a.example.jp`）
 */
export function shelfUrl(origin: string, labelKey: string): string {
  return `${origin.replace(/\/+$/, '')}${MOBILE_INVENTORY_PATH}?shelf=${encodeURIComponent(labelKey)}`;
}

/**
 * 読んだ値から棚の値（`labelKey`）を取り出す。スマホ用のページの URL なら `shelf` を、そうでなければ値そのものを返す。
 *
 * @remarks 以前のラベル（値だけの QR）も読めるようにする
 */
export function shelfKeyOf(raw: string): string {
  const m = raw.trim().match(/[?&]shelf=([^&#\s]+)/);
  if (!m) return raw.trim();
  try { return decodeURIComponent(m[1]!); } catch { return m[1]!; }
}

/**
 * 棚のラベルの PDF を作る。
 *
 * @param locations 並べる場所（並べた順に左上から）
 * @param origin 会社の画面のオリジン（QR に入れる URL に使う）
 * @param title PDF の題名
 * @returns PDF の中身。場所が無ければ空のページ 1 枚
 */
export async function renderShelfLabels(locations: InventoryLocation[], origin: string, title = '棚のラベル'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  // 太字の書体 1 つだけを埋め込む（書体は 1 つで約 1.5 MB あるため）
  const { font: bold, fit } = await embedJapaneseFonts(pdf, 'bold');
  const cellW = (PAGE.width - MARGIN * 2) / COLS;
  const cellH = (PAGE.height - MARGIN * 2) / ROWS;
  const perPage = COLS * ROWS;
  const pages = Math.max(1, Math.ceil(locations.length / perPage));
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    locations.slice(p * perPage, (p + 1) * perPage).forEach((loc, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const x = MARGIN + col * cellW;
      const top = PAGE.height - MARGIN - row * cellH;
      // 切り取りの目安の枠（薄い灰色）
      page.drawRectangle({ x, y: top - cellH, width: cellW, height: cellH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.5 });
      // QR
      const qr = QRCode.create(shelfUrl(origin, loc.labelKey), { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const unit = QR_SIZE / n;
      const qx = x + (cellW - QR_SIZE) / 2;
      const qy = top - 10 - QR_SIZE;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (!qr.modules.get(r, c)) continue;
          page.drawRectangle({ x: qx + c * unit, y: qy + (n - 1 - r) * unit, width: unit, height: unit, color: rgb(0, 0, 0) });
        }
      }
      // 倉庫と棚の名前（入らなければ詰める）
      const name = fit(loc.shelf ? `${loc.warehouse} ${loc.shelf}` : loc.warehouse);
      let size = 11;
      while (size > 6 && bold.widthOfTextAtSize(name, size) > cellW - 12) size -= 0.5;
      const w = bold.widthOfTextAtSize(name, size);
      page.drawText(name, { x: x + (cellW - w) / 2, y: qy - 14, size, font: bold, color: rgb(0.1, 0.1, 0.1) });
      const sub = fit('在庫管理 棚');
      const sw = bold.widthOfTextAtSize(sub, 7);
      page.drawText(sub, { x: x + (cellW - sw) / 2, y: qy - 24, size: 7, font: bold, color: rgb(0.45, 0.45, 0.45) });
    });
  }
  return pdf.save();
}
