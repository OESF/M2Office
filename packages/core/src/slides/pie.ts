/**
 * @file スライドの円グラフ（ドーナツ型）の画像を、数値から正確に描く（仕様書 第9.4.2節「段 2」、Q-263）。
 *
 * Slides API では扇形の角度を決められないため、円グラフは画像にして貼る。描くのは M2Office（SVG を PNG にする）で、AI は使わない。
 * 画像には文字を入れない（項目の名前と割合は Google スライドの文字として横に置き、あとで直せるようにする）。
 */

import { Resvg } from '@resvg/resvg-js';
import type { SlideRgb } from '@m2office/shared';

/** 描く大きさ（正方形の一辺。ピクセル）。 */
const SIZE = 800;

const hex = (c: SlideRgb) => `#${[c.red, c.green, c.blue].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * ドーナツ型の円グラフの SVG。12 時の位置から時計回りに、値の大きさの順ではなく渡された順に描く。
 *
 * @param values 値（合計が 0 なら何も描かない）
 * @param colors 項目ごとの色（足りなければ最後の色を使う）
 * @param gap 扇形のすき間の色（ページの背景の色にすると、すき間が背景に溶ける）
 */
export function pieChartSvg(values: number[], colors: SlideRgb[], gap: SlideRgb = { red: 1, green: 1, blue: 1 }): string {
  const total = values.reduce((a, v) => a + Math.max(0, v), 0);
  const c = SIZE / 2;
  const outer = SIZE / 2 - 8;
  const inner = outer * 0.58;
  const parts: string[] = [];
  if (total > 0) {
    let start = -Math.PI / 2;
    values.forEach((raw, k) => {
      const v = Math.max(0, raw);
      if (v <= 0) return;
      const color = hex(colors[Math.min(k, colors.length - 1)] ?? { red: 0.5, green: 0.5, blue: 0.5 });
      // 1 つで全体を占めるときは、円の弧を描けないので輪を描く
      if (v >= total) {
        parts.push(`<circle cx="${c}" cy="${c}" r="${(outer + inner) / 2}" fill="none" stroke="${color}" stroke-width="${outer - inner}"/>`);
        return;
      }
      const end = start + (v / total) * Math.PI * 2;
      const large = end - start > Math.PI ? 1 : 0;
      const p = (r: number, a: number) => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
      parts.push(`<path d="M ${p(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, end)} L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, start)} Z" fill="${color}" stroke="${hex(gap)}" stroke-width="4"/>`);
      start = end;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${parts.join('')}</svg>`;
}

/**
 * ドーナツ型の円グラフの PNG（背景は透明）。
 *
 * @returns PNG のバイト列
 */
export function pieChartPng(values: number[], colors: SlideRgb[], gap?: SlideRgb): Uint8Array {
  return new Uint8Array(new Resvg(pieChartSvg(values, colors, gap), { fitTo: { mode: 'width', value: SIZE } }).render().asPng());
}
