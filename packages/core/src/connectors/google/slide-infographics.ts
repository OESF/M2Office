/**
 * @file 図で見せるスライドのレイアウト（仕様書 第9.4.2節「プレゼンテーションの表現」、Q-262）。
 *
 * 大きな数字・棒グラフ・割合・進み具合・手順・時の流れ・カード・対比・2×2・積み上げ・チェックを、
 * Slides API の図形と文字だけで描く（画像のファイルもスプレッドシートも使わない。権限は `drive.file` のまま）。
 * 色と字体は組み込みのデザイン（`SlideDesign`）から取る。位置はインチ（既定の大きさ 10 × 5.625）で決め、呼ぶ側が伸び縮みさせる。
 * 円グラフは描かない（Slides API では扇形の角度を決められないため）。割合は帯か 10×10 のます目で見せる。
 */

import type { SlideDesign, SlideRgb } from '@m2office/shared';
import type { SlideItem, SlideSpec } from '../../slides/plan.js';

/** 置く場所（インチ）。 */
export type Box = { x: number; y: number; w: number; h: number };

/** 図形の種類（Slides API の `shapeType`）。 */
export type ShapeKind = 'RECTANGLE' | 'ROUND_RECTANGLE' | 'ELLIPSE' | 'CHEVRON' | 'HOME_PLATE' | 'RIGHT_ARROW' | 'TEXT_BOX';

/** 文字の書式。 */
export interface TextStyle {
  size: number;
  bold?: boolean;
  color?: SlideRgb;
  /** 見出しの字体か本文の字体か（既定は本文）。 */
  heading?: boolean;
  align?: 'START' | 'CENTER' | 'END';
  /** 枠の中の上下の位置（既定は上）。 */
  valign?: 'TOP' | 'MIDDLE' | 'BOTTOM';
}

/** 描く道具（組み立ての側が用意する）。 */
export interface SlideDraw {
  design: SlideDesign;
  /** 図形を置く（塗りが `null` なら塗らない。枠の線は描かない）。文字があれば中に入れる。 */
  shape(id: string, slide: string, b: Box, kind: ShapeKind, fill: SlideRgb | null, text?: string, style?: TextStyle): void;
  /** 文字の一部の書式を変える（見出しの行だけ大きくするなど）。 */
  restyle(id: string, start: number, end: number, style: TextStyle): void;
  /** 箇条書きの印を付ける（`from` の文字から後ろだけ。見出しの行に印を付けないため）。 */
  bullets(id: string, from?: number): void;
}

/** 明るさ（0〜1）。 */
const luminance = (c: SlideRgb) => 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue;

/** 塗りの上に置く文字の色（明るい塗りには濃い字、暗い塗りには白）。 */
export function onColor(fill: SlideRgb): SlideRgb {
  return luminance(fill) > 0.6 ? { red: 0.12, green: 0.12, blue: 0.14 } : { red: 1, green: 1, blue: 1 };
}

/** 2 つの色を混ぜる（t = 0 で a、1 で b）。 */
export function mix(a: SlideRgb, b: SlideRgb, t: number): SlideRgb {
  return { red: a.red + (b.red - a.red) * t, green: a.green + (b.green - a.green) * t, blue: a.blue + (b.blue - a.blue) * t };
}

/** n 色の並び（強調の色から薄い強調の色へ）。割合・手順・積み上げの塗りに使う。 */
export function palette(d: SlideDesign, n: number): SlideRgb[] {
  return Array.from({ length: n }, (_, i) => mix(d.accent, d.accentLight, n <= 1 ? 0 : (i / n) * 0.85));
}

/** 数を見やすく（3 桁ごとに区切る）。 */
const num = (v: number) => (Number.isInteger(v) ? v.toLocaleString('ja-JP') : (Math.round(v * 10) / 10).toLocaleString('ja-JP'));

/** 項目の名前（名前か見出し）。 */
const nameOf = (it: SlideItem) => it.label ?? it.title ?? '';

/**
 * 図のレイアウトを描く。描いたら `true`（描かないレイアウトなら `false`。呼ぶ側が描く）。
 *
 * @param area 題名の下の中身の場所
 */
export function drawInfographic(g: SlideDraw, s: SlideSpec, id: string, area: Box): boolean {
  const d = g.design;
  const items = s.items ?? [];
  switch (s.layout) {
    case 'KPI': {
      const stats = s.stats ?? [];
      const n = stats.length;
      const gap = 0.3;
      const w = (area.w - gap * (n - 1)) / n;
      stats.forEach((st, k) => {
        const x = area.x + k * (w + gap);
        g.shape(`${id}_k${k + 1}`, id, { x, y: area.y + 0.2, w, h: area.h - 0.4 }, 'ROUND_RECTANGLE', d.accentLight);
        if (st.icon) g.shape(`${id}_ki${k + 1}`, id, { x: x + w / 2 - 0.4, y: area.y + 0.45, w: 0.8, h: 0.8 }, 'ELLIPSE', d.accent, st.icon, { size: 24, align: 'CENTER', valign: 'MIDDLE', color: onColor(d.accent) });
        const top = area.y + (st.icon ? 1.4 : 0.8);
        const value = `${st.value}${st.unit ?? ''}`;
        g.shape(`${id}_kv${k + 1}`, id, { x: x + 0.1, y: top, w: w - 0.2, h: 0.9 }, 'TEXT_BOX', null, value, { size: n >= 4 ? 30 : 38, bold: true, heading: true, color: d.accent, align: 'CENTER', valign: 'MIDDLE' });
        if (st.unit) g.restyle(`${id}_kv${k + 1}`, st.value.length, value.length, { size: n >= 4 ? 14 : 18, bold: true, color: d.accent });
        g.shape(`${id}_kl${k + 1}`, id, { x: x + 0.15, y: top + 0.95, w: w - 0.3, h: 0.8 }, 'TEXT_BOX', null, st.label, { size: 13, color: d.text, align: 'CENTER' });
      });
      return true;
    }
    case 'BIG_NUMBER': {
      const st = s.stats?.[0];
      if (!st) return false;
      const value = `${st.value}${st.unit ?? ''}`;
      g.shape(`${id}_n`, id, { x: area.x, y: area.y + 0.1, w: area.w, h: 1.9 }, 'TEXT_BOX', null, value, { size: 88, bold: true, heading: true, color: d.accent, align: 'CENTER', valign: 'MIDDLE' });
      if (st.unit) g.restyle(`${id}_n`, st.value.length, value.length, { size: 36, bold: true, color: d.accent });
      g.shape(`${id}_nl`, id, { x: area.x + 1, y: area.y + 2.1, w: area.w - 2, h: 0.6 }, 'TEXT_BOX', null, st.label, { size: 20, bold: true, color: d.text, align: 'CENTER' });
      if (s.sub) g.shape(`${id}_ns`, id, { x: area.x + 1, y: area.y + 2.75, w: area.w - 2, h: 0.5 }, 'TEXT_BOX', null, s.sub, { size: 14, color: d.muted, align: 'CENTER' });
      return true;
    }
    case 'BAR': {
      const max = Math.max(...items.map((it) => it.value ?? 0), 1);
      const unit = s.unit ?? '';
      const color = (it: SlideItem) => (!s.highlight || nameOf(it) === s.highlight ? d.accent : mix(d.accentLight, d.muted, 0.25));
      if (s.orientation === 'vertical') {
        const n = items.length;
        const slot = area.w / n;
        const bw = Math.min(1.1, slot * 0.6);
        const baseY = area.y + area.h - 0.45;
        const maxH = area.h - 1.0;
        items.forEach((it, k) => {
          const h = Math.max(0.04, ((it.value ?? 0) / max) * maxH);
          const x = area.x + k * slot + (slot - bw) / 2;
          g.shape(`${id}_b${k + 1}`, id, { x, y: baseY - h, w: bw, h }, 'RECTANGLE', color(it));
          g.shape(`${id}_bv${k + 1}`, id, { x: x - 0.3, y: baseY - h - 0.4, w: bw + 0.6, h: 0.35 }, 'TEXT_BOX', null, `${num(it.value ?? 0)}${unit}`, { size: 13, bold: true, color: d.text, align: 'CENTER' });
          g.shape(`${id}_bl${k + 1}`, id, { x: area.x + k * slot, y: baseY + 0.05, w: slot, h: 0.4 }, 'TEXT_BOX', null, nameOf(it), { size: 12, color: d.muted, align: 'CENTER' });
        });
        g.shape(`${id}_base`, id, { x: area.x, y: baseY, w: area.w, h: 0.02 }, 'RECTANGLE', d.muted);
        return true;
      }
      const n = items.length;
      const rowH = Math.min(0.85, area.h / n);
      const top = area.y + (area.h - rowH * n) / 2;
      const labelW = 2.3;
      const fs = rowH >= 0.7 ? 16 : 13;
      const maxW = area.w - labelW - 1.3;
      items.forEach((it, k) => {
        const y = top + k * rowH;
        const w = Math.max(0.04, ((it.value ?? 0) / max) * maxW);
        g.shape(`${id}_bl${k + 1}`, id, { x: area.x, y, w: labelW - 0.15, h: rowH }, 'TEXT_BOX', null, nameOf(it), { size: fs, color: d.text, align: 'END', valign: 'MIDDLE' });
        g.shape(`${id}_b${k + 1}`, id, { x: area.x + labelW, y: y + rowH * 0.15, w, h: rowH * 0.7 }, 'RECTANGLE', color(it));
        g.shape(`${id}_bv${k + 1}`, id, { x: area.x + labelW + w + 0.08, y, w: 1.2, h: rowH }, 'TEXT_BOX', null, `${num(it.value ?? 0)}${unit}`, { size: fs + 2, bold: true, color: d.text, valign: 'MIDDLE' });
      });
      return true;
    }
    case 'SHARE': {
      const total = items.reduce((a, it) => a + (it.value ?? 0), 0) || 1;
      const pct = items.map((it) => ((it.value ?? 0) / total) * 100);
      const colors = palette(d, items.length);
      const legend = (x: number, y: number, w: number) => items.forEach((it, k) => {
        g.shape(`${id}_sk${k + 1}`, id, { x, y: y + k * 0.48 + 0.08, w: 0.26, h: 0.26 }, 'RECTANGLE', colors[k]!);
        g.shape(`${id}_sl${k + 1}`, id, { x: x + 0.38, y: y + k * 0.48, w: w - 0.4, h: 0.42 }, 'TEXT_BOX', null, `${nameOf(it)}　${Math.round(pct[k]!)}%`, { size: 14, color: d.text, valign: 'MIDDLE' });
      });
      if (s.shareStyle === 'grid') {
        // 10×10 のます目。上の行から順に、項目ごとの数だけ塗る
        const cell = Math.min(0.33, (area.h - 0.1) / 10);
        let filled = 0;
        const counts = pct.map((p) => Math.round(p));
        const diff = 100 - counts.reduce((a, b) => a + b, 0);
        counts[0] = Math.max(0, counts[0]! + diff);
        counts.forEach((c, k) => {
          for (let m = 0; m < c && filled < 100; m++, filled++) {
            const r = Math.floor(filled / 10);
            const col = filled % 10;
            g.shape(`${id}_g${filled + 1}`, id, { x: area.x + 0.3 + col * cell, y: area.y + r * cell, w: cell - 0.04, h: cell - 0.04 }, 'RECTANGLE', colors[k]!);
          }
        });
        legend(area.x + 0.3 + cell * 10 + 0.6, area.y + 0.3, area.w - cell * 10 - 1);
        return true;
      }
      // 100% の帯を割合で区切る。広い区切りには割合を中に書く
      const bandY = area.y + 0.5;
      let x = area.x;
      items.forEach((it, k) => {
        const w = (pct[k]! / 100) * area.w;
        if (w <= 0) return;
        g.shape(`${id}_s${k + 1}`, id, { x, y: bandY, w, h: 1.1 }, 'RECTANGLE', colors[k]!, w >= 0.8 ? `${Math.round(pct[k]!)}%` : '', { size: w >= 1.5 ? 22 : 14, bold: true, color: onColor(colors[k]!), align: 'CENTER', valign: 'MIDDLE' });
        x += w;
      });
      legend(area.x, bandY + 1.45, area.w);
      return true;
    }
    case 'PROGRESS': {
      const n = items.length;
      const rowH = Math.min(0.7, area.h / n);
      const top = area.y + (area.h - rowH * n) / 2;
      const labelW = 2.4;
      const trackW = area.w - labelW - 1.1;
      items.forEach((it, k) => {
        const y = top + k * rowH;
        const p = Math.max(0, Math.min(100, it.value ?? 0));
        g.shape(`${id}_pl${k + 1}`, id, { x: area.x, y, w: labelW - 0.15, h: rowH }, 'TEXT_BOX', null, nameOf(it), { size: 14, color: d.text, align: 'END', valign: 'MIDDLE' });
        g.shape(`${id}_pt${k + 1}`, id, { x: area.x + labelW, y: y + rowH * 0.3, w: trackW, h: rowH * 0.4 }, 'ROUND_RECTANGLE', d.accentLight);
        if (p > 0) g.shape(`${id}_pf${k + 1}`, id, { x: area.x + labelW, y: y + rowH * 0.3, w: Math.max(0.1, (p / 100) * trackW), h: rowH * 0.4 }, 'ROUND_RECTANGLE', d.accent);
        g.shape(`${id}_pv${k + 1}`, id, { x: area.x + labelW + trackW + 0.1, y, w: 1, h: rowH }, 'TEXT_BOX', null, `${num(p)}%`, { size: 16, bold: true, color: d.accent, valign: 'MIDDLE' });
      });
      return true;
    }
    case 'STEPS': {
      const n = items.length;
      const w = (area.w + 0.15 * (n - 1)) / n;
      const colors = palette(d, n);
      // 矢印の形と、その下の 1 行を、中身の場所の上下の真ん中に置く
      const top = area.y + Math.max(0, (area.h - 2.9) / 2);
      items.forEach((it, k) => {
        const x = area.x + k * (w - 0.15);
        const head = `${String(k + 1).padStart(2, '0')}\n${it.title ?? ''}`;
        g.shape(`${id}_st${k + 1}`, id, { x, y: top, w, h: 1.5 }, k === 0 ? 'HOME_PLATE' : 'CHEVRON', colors[k]!, head, { size: n >= 5 ? 15 : 18, bold: true, heading: true, color: onColor(colors[k]!), align: 'CENTER', valign: 'MIDDLE' });
        g.restyle(`${id}_st${k + 1}`, 0, 2, { size: 13, bold: true, color: onColor(colors[k]!) });
        if (it.text) g.shape(`${id}_sx${k + 1}`, id, { x: x + 0.25, y: top + 1.7, w: w - 0.5, h: 1.2 }, 'TEXT_BOX', null, it.text, { size: n >= 5 ? 13 : 15, color: d.text, align: 'CENTER' });
      });
      return true;
    }
    case 'TIMELINE': {
      const n = items.length;
      const lineY = area.y + area.h / 2;
      g.shape(`${id}_tl`, id, { x: area.x, y: lineY - 0.02, w: area.w, h: 0.04 }, 'RECTANGLE', d.accent);
      const slot = area.w / n;
      items.forEach((it, k) => {
        const cx = area.x + slot * k + slot / 2;
        g.shape(`${id}_td${k + 1}`, id, { x: cx - 0.16, y: lineY - 0.16, w: 0.32, h: 0.32 }, 'ELLIPSE', d.accent);
        g.shape(`${id}_tt${k + 1}`, id, { x: cx - slot / 2 + 0.05, y: lineY - 0.95, w: slot - 0.1, h: 0.6 }, 'TEXT_BOX', null, it.date ?? '', { size: 16, bold: true, heading: true, color: d.accent, align: 'CENTER', valign: 'BOTTOM' });
        const body = [it.title, it.text].filter(Boolean).join('\n');
        g.shape(`${id}_tx${k + 1}`, id, { x: cx - slot / 2 + 0.05, y: lineY + 0.3, w: slot - 0.1, h: area.h / 2 - 0.35 }, 'TEXT_BOX', null, body, { size: 12, color: d.text, align: 'CENTER' });
        if (it.title) g.restyle(`${id}_tx${k + 1}`, 0, it.title.length, { size: 14, bold: true, color: d.text });
      });
      return true;
    }
    case 'CARDS': {
      const n = items.length;
      const gap = 0.3;
      const w = (area.w - gap * (n - 1)) / n;
      items.forEach((it, k) => {
        const x = area.x + k * (w + gap);
        g.shape(`${id}_c${k + 1}`, id, { x, y: area.y + 0.1, w, h: area.h - 0.2 }, 'ROUND_RECTANGLE', d.accentLight);
        g.shape(`${id}_ci${k + 1}`, id, { x: x + w / 2 - 0.42, y: area.y + 0.35, w: 0.84, h: 0.84 }, 'ELLIPSE', d.accent, it.icon ?? String(k + 1), { size: it.icon ? 26 : 20, bold: !it.icon, align: 'CENTER', valign: 'MIDDLE', color: onColor(d.accent) });
        g.shape(`${id}_ct${k + 1}`, id, { x: x + 0.15, y: area.y + 1.35, w: w - 0.3, h: 0.55 }, 'TEXT_BOX', null, it.title ?? it.label ?? '', { size: 17, bold: true, heading: true, color: d.accent, align: 'CENTER' });
        if (it.text) g.shape(`${id}_cx${k + 1}`, id, { x: x + 0.2, y: area.y + 1.95, w: w - 0.4, h: area.h - 2.2 }, 'TEXT_BOX', null, it.text, { size: 13, color: d.text, align: 'CENTER' });
      });
      return true;
    }
    case 'COMPARISON': {
      const w = (area.w - 0.9) / 2;
      const panel = (side: 'l' | 'r', x: number, head: string, body: string, fill: SlideRgb) => {
        const fg = onColor(fill);
        const text = [head, body].filter(Boolean).join('\n');
        g.shape(`${id}_${side}`, id, { x, y: area.y + 0.1, w, h: area.h - 0.2 }, 'ROUND_RECTANGLE', fill, text, { size: 14, color: fg, valign: 'MIDDLE' });
        if (head) g.restyle(`${id}_${side}`, 0, head.length, { size: 20, bold: true, heading: true, color: fg });
        if (body) g.bullets(`${id}_${side}`, head ? head.length + 1 : 0);
      };
      panel('l', area.x, s.compareLeftTitle ?? '', s.compareLeftBody ?? '', d.accentLight);
      panel('r', area.x + w + 0.9, s.compareRightTitle ?? '', s.compareRightBody ?? '', d.accent);
      const cx = area.x + w + 0.45;
      if (s.mode === 'before-after') {
        g.shape(`${id}_ar`, id, { x: cx - 0.35, y: area.y + area.h / 2 - 0.3, w: 0.7, h: 0.6 }, 'RIGHT_ARROW', d.muted);
      } else {
        g.shape(`${id}_vs`, id, { x: cx - 0.38, y: area.y + area.h / 2 - 0.38, w: 0.76, h: 0.76 }, 'ELLIPSE', d.text, 'VS', { size: 15, bold: true, heading: true, color: onColor(d.text), align: 'CENTER', valign: 'MIDDLE' });
      }
      return true;
    }
    case 'MATRIX': {
      const ax = 0.45;
      const gw = (area.w - ax - 0.15) / 2;
      const gh = (area.h - ax - 0.15) / 2;
      // 左上・右上・左下・右下。右上（両方の軸で高い）を強調する
      items.slice(0, 4).forEach((it, k) => {
        const col = k % 2;
        const row = Math.floor(k / 2);
        const fill = k === 1 ? d.accent : d.accentLight;
        const fg = onColor(fill);
        const text = [it.title, it.text].filter(Boolean).join('\n');
        g.shape(`${id}_m${k + 1}`, id, { x: area.x + ax + col * (gw + 0.15), y: area.y + row * (gh + 0.15), w: gw, h: gh }, 'ROUND_RECTANGLE', fill, text, { size: 13, color: fg, align: 'CENTER', valign: 'MIDDLE' });
        if (it.title) g.restyle(`${id}_m${k + 1}`, 0, it.title.length, { size: 17, bold: true, heading: true, color: fg });
      });
      if (s.yAxis) g.shape(`${id}_my`, id, { x: area.x - 0.1, y: area.y, w: ax + 0.1, h: area.h - ax }, 'TEXT_BOX', null, `↑\n${[...s.yAxis].join('\n')}`, { size: 11, color: d.muted, align: 'CENTER', valign: 'MIDDLE' });
      if (s.xAxis) g.shape(`${id}_mx`, id, { x: area.x + ax, y: area.y + area.h - ax + 0.05, w: area.w - ax, h: ax }, 'TEXT_BOX', null, `${s.xAxis} →`, { size: 12, color: d.muted, align: 'CENTER' });
      return true;
    }
    case 'PYRAMID': {
      // 上が狭く下が広い段を左に、段ごとの説明を右に
      const n = items.length;
      const h = Math.min(0.85, (area.h - 0.1 * (n - 1)) / n);
      const top = area.y + (area.h - (h * n + 0.1 * (n - 1))) / 2;
      const left = area.x;
      const maxW = 4.6;
      const colors = palette(d, n);
      items.forEach((it, k) => {
        const w = maxW * (0.35 + (0.65 * (k + 1)) / n);
        const y = top + k * (h + 0.1);
        g.shape(`${id}_y${k + 1}`, id, { x: left + (maxW - w) / 2, y, w, h }, 'RECTANGLE', colors[k]!, it.title ?? '', { size: 15, bold: true, heading: true, color: onColor(colors[k]!), align: 'CENTER', valign: 'MIDDLE' });
        if (it.text) g.shape(`${id}_yx${k + 1}`, id, { x: left + maxW + 0.35, y, w: area.w - maxW - 0.35, h }, 'TEXT_BOX', null, it.text, { size: 13, color: d.text, valign: 'MIDDLE' });
      });
      return true;
    }
    case 'CHECKLIST': {
      const n = items.length;
      const rowH = Math.min(0.75, area.h / n);
      const top = area.y + (area.h - rowH * n) / 2;
      items.forEach((it, k) => {
        const y = top + k * rowH;
        g.shape(`${id}_ck${k + 1}`, id, { x: area.x + 0.6, y: y + (rowH - 0.46) / 2, w: 0.46, h: 0.46 }, 'ELLIPSE', d.accent, '✓', { size: 16, bold: true, color: onColor(d.accent), align: 'CENTER', valign: 'MIDDLE' });
        const text = [it.title ?? it.label, it.text].filter(Boolean).join('　');
        g.shape(`${id}_cx${k + 1}`, id, { x: area.x + 1.3, y, w: area.w - 1.5, h: rowH }, 'TEXT_BOX', null, text, { size: 18, color: d.text, valign: 'MIDDLE' });
        const head = it.title ?? it.label ?? '';
        if (head && it.text) g.restyle(`${id}_cx${k + 1}`, 0, head.length, { size: 18, bold: true, color: d.text });
      });
      return true;
    }
    default:
      return false;
  }
}
