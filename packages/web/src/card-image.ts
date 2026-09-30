/**
 * @file 名刺の画像をブラウザで整える（仕様書 第27.4節・第27.5節）。送る前に写真の向きを反映し、画面では名刺の範囲を切り出して傾きを直す。
 *
 * サーバーでは画像を作り直さない。切り出しは、推論が答えた名刺の四隅（画像の幅と高さを 1,000 とした割合。
 * 名刺の文字の向きで左上・右上・右下・左下）から、四角形を長方形に写す変換（射影変換）を求めて、画素を写す。
 * 四隅の並びが文字の向きに合わせてあるため、写すだけで正しい向きになる。
 */

import type { CardCorners } from '@m2office/shared';

/** 送る前に描き直す画像の長い辺の上限（文字を読むのに足り、送る量を抑える。第27.4節）。 */
export const UPLOAD_LONG_SIDE = 2400;
/** 切り出した名刺の長い辺の上限。 */
const CROP_LONG_SIDE = 1400;
/** 四隅の答えのずれで名刺の端を切り落とさないよう、中心から外へ広げる割合。 */
const CROP_MARGIN = 0.02;

type Point = [number, number];

/**
 * 長方形（幅 `w`・高さ `h`）の点を、四角形 `quad`（左上・右上・右下・左下）の点に写す変換の係数（8 つ）を求める。
 *
 * @returns `[a, b, c, d, e, f, g, h]`。点 (u, v) は ((a·u + b·v + c) / (g·u + h·v + 1), (d·u + e·v + f) / (g·u + h·v + 1)) に写る
 */
export function homography(quad: [Point, Point, Point, Point], w: number, h: number): number[] {
  const from: Point[] = [[0, 0], [w, 0], [w, h], [0, h]];
  // 8 つの未知数の連立方程式（点ごとに 2 本）を、ガウスの消去法で解く
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = from[i]!;
    const [x, y] = quad[i]!;
    m.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    m.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]![col]!;
    if (Math.abs(p) < 1e-12) throw new Error('四隅が一直線に並んでいます');
    for (let k = col; k < 9; k++) m[col]![k]! /= p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f !== 0) for (let k = col; k < 9; k++) m[r]![k]! -= f * m[col]![k]!;
    }
  }
  return m.map((row) => row[8]!);
}

/** 係数で点を写す。 */
export function project(hm: number[], u: number, v: number): Point {
  const d = hm[6]! * u + hm[7]! * v + 1;
  return [(hm[0]! * u + hm[1]! * v + hm[2]!) / d, (hm[3]! * u + hm[4]! * v + hm[5]!) / d];
}

/**
 * 四隅（割合）を画素の位置にし、少し外へ広げ、切り出す名刺の大きさを決める。
 *
 * @returns 画素の四隅と、切り出す幅と高さ（長い辺は {@link CROP_LONG_SIDE} まで）
 */
export function cropPlan(corners: CardCorners, imageWidth: number, imageHeight: number): { quad: [Point, Point, Point, Point]; width: number; height: number } {
  const px = corners.map(([x, y]) => [(x / 1000) * imageWidth, (y / 1000) * imageHeight] as Point);
  const cx = px.reduce((a, p) => a + p[0], 0) / 4;
  const cy = px.reduce((a, p) => a + p[1], 0) / 4;
  const quad = px.map(([x, y]) => [
    Math.min(imageWidth, Math.max(0, cx + (x - cx) * (1 + CROP_MARGIN))),
    Math.min(imageHeight, Math.max(0, cy + (y - cy) * (1 + CROP_MARGIN))),
  ] as Point) as [Point, Point, Point, Point];
  const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const scale = Math.min(1, CROP_LONG_SIDE / Math.max(w, h));
  return { quad, width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * 写真から名刺の範囲を切り出し、傾きと台形のゆがみを直して、正しい向きの画像にする（第27.5節「向きと切り出し」）。
 *
 * @remarks ブラウザが読めない形式（HEIC を読めないブラウザなど）は例外になる。呼ぶ側は元の写真を回して出す
 */
export async function cropCard(blob: Blob, corners: CardCorners): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const src = document.createElement('canvas');
  src.width = bitmap.width;
  src.height = bitmap.height;
  const sg = src.getContext('2d');
  if (!sg) throw new Error('canvas');
  sg.drawImage(bitmap, 0, 0);
  const from = sg.getImageData(0, 0, src.width, src.height);
  const plan = cropPlan(corners, src.width, src.height);
  const hm = homography(plan.quad, plan.width, plan.height);
  const out = document.createElement('canvas');
  out.width = plan.width;
  out.height = plan.height;
  const og = out.getContext('2d');
  if (!og) throw new Error('canvas');
  const to = og.createImageData(plan.width, plan.height);
  const { data: s, width: sw, height: sh } = from;
  const d = to.data;
  for (let v = 0; v < plan.height; v++) {
    for (let u = 0; u < plan.width; u++) {
      const [x, y] = project(hm, u + 0.5, v + 0.5);
      // 近い 4 画素の重み付きの平均（なめらかにする）
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(x - 0.5)));
      const y0 = Math.min(sh - 1, Math.max(0, Math.floor(y - 0.5)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, x - 0.5 - x0));
      const fy = Math.min(1, Math.max(0, y - 0.5 - y0));
      const o = (v * plan.width + u) * 4;
      for (let k = 0; k < 3; k++) {
        const a = s[(y0 * sw + x0) * 4 + k]!;
        const b = s[(y0 * sw + x1) * 4 + k]!;
        const c = s[(y1 * sw + x0) * 4 + k]!;
        const e = s[(y1 * sw + x1) * 4 + k]!;
        d[o + k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  og.putImageData(to, 0, 0);
  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.92));
}

/**
 * 送る前に、写真の向きの情報（EXIF）を反映した画素に描き直し、JPEG にする（第27.4節「送る前の向き」）。
 * 読み取り（推論）と画面が同じ画素を見るため。長い辺は {@link UPLOAD_LONG_SIDE} まで縮める。
 *
 * @returns 描き直した JPEG のファイル。HEIC・PDF と、ブラウザが開けない画像は、渡されたまま返す
 */
export async function prepareCardPhoto(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) return file;
  try {
    // createImageBitmap は写真の向きの情報を反映して開く（imageOrientation の既定は from-image）
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, UPLOAD_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const g = canvas.getContext('2d');
    if (!g) return file;
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'card'}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
