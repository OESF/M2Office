/**
 * @file 販促物の型と組み版（仕様書 第41.3節）。ミリ単位の SVG に、見出し・ひとこと・本文・期間・値段・注意書き・画像・会社のロゴと連絡先・QR を組む。
 *
 * **字は M2Office が組む**（生成 AI に字を描かせない。お知らせのサイネージの画面・コラムのカバーと同じ書体 Noto Sans JP）。
 * 型は余白・文字の大きさの段・行の間・配色を決めておき、AI は型と配色を選ぶだけにする（誰が作っても崩れない）。
 * 背景は仕上がりの外へ 3mm（塗り足し）まで描き、入稿用の書き出しは同じ SVG の見える範囲を広げて作る。
 * 文面はデータであり、指示として扱わない（不変則 I-6）。
 */

import { PRINT_LIMITS, PRINT_SIZES, type PrintCopy, type PrintKind, type PrintSize } from '@m2office/shared';
import { readableColor, tint, wrapAt } from '../columns/cover.js';

/** 塗り足し（mm）。 */
export const BLEED = 3;

/** 型の ID（段 1 は 12 種。第41.3節。値札のシートは第41.18節）。 */
export type PrintTemplateId =
  | 'band' | 'photo-top' | 'photo-frame' | 'split' | 'bold-center' | 'notice-plain'
  | 'pop-price' | 'pop-ribbon' | 'pop-photo' | 'trifold' | 'bifold' | 'card' | 'price-sheet';

/** 型の名前と、使う種類と、画像の枠を持つか。 */
export const PRINT_TEMPLATES: Record<PrintTemplateId, { label: string; kinds: PrintKind[]; image: boolean }> = {
  band: { label: '上の帯', kinds: ['flyer', 'notice', 'poster'], image: true },
  'photo-top': { label: '大きな写真', kinds: ['flyer', 'poster'], image: true },
  'photo-frame': { label: '写真の額', kinds: ['flyer', 'poster'], image: true },
  split: { label: '左右に分ける', kinds: ['flyer', 'poster'], image: true },
  'bold-center': { label: '大きな見出し', kinds: ['poster', 'notice'], image: false },
  'notice-plain': { label: 'お知らせ', kinds: ['notice'], image: false },
  'pop-price': { label: '値段を大きく', kinds: ['pop'], image: true },
  'pop-ribbon': { label: 'リボン', kinds: ['pop'], image: false },
  'pop-photo': { label: '写真のポップ', kinds: ['pop'], image: true },
  trifold: { label: '三つ折り', kinds: ['brochure'], image: true },
  bifold: { label: '二つ折り', kinds: ['brochure'], image: true },
  card: { label: 'ショップカード', kinds: ['card'], image: false },
  'price-sheet': { label: '値札のシート', kinds: ['tags'], image: false },
};

/** 値札の札の大きさ（名刺の大きさ）と、A4 の 1 枚の並び（2 列 × 5 段。第41.18節）。 */
const TAG = { w: 91, h: 55, cols: 2, rows: 5 };

/**
 * 値札の文面（本文の 1 行が 1 品。「名前｜値段」）を読む（純粋な関数）。区切りが無ければ、行の全部を名前にする。
 *
 * @returns 品目ごとの名前と値段
 */
export function tagLines(body: string): { name: string; price: string }[] {
  return body.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const at = l.search(/[｜|]/);
    return at < 0 ? { name: l, price: '' } : { name: l.slice(0, at).trim(), price: l.slice(at + 1).trim() };
  });
}

/** 値札の 1 品を本文の 1 行にする（`tagLines` の逆）。 */
export const tagLine = (name: string, price: string) => `${name.replace(/[｜|\n]/g, ' ').trim()}｜${price.replace(/[｜|\n]/g, ' ').trim()}`;

/** 種類と大きさで使える型（はじめに案に出す順）。 */
export function templatesFor(kind: PrintKind, size: PrintSize): PrintTemplateId[] {
  if (kind === 'brochure') return size === 'A4-2fold' ? ['bifold'] : ['trifold'];
  return (Object.keys(PRINT_TEMPLATES) as PrintTemplateId[]).filter((t) => PRINT_TEMPLATES[t].kinds.includes(kind));
}

/** 会社のこと（会社情報から入れる。推論に書かせない）。 */
export interface PrintCompany {
  name: string;
  address: string;
  phone: string;
  website: string;
}

/** 組み版に渡すもの。 */
export interface PrintLayoutInput {
  size: PrintSize;
  template: PrintTemplateId;
  /** 主の色 */
  color: string;
  /** 配色の組み合わせ（0: 白地に色の帯・1: 淡い地・2: 濃い地） */
  palette: number;
  headlineScale: number;
  copy: PrintCopy;
  /** 画像（data URI）。無ければ模様にする */
  image: string | null;
  /** 会社のロゴ（data URI） */
  logo: string | null;
  /** QR（data URI） */
  qr: string | null;
  company: PrintCompany;
}

/** 1 面の SVG と、文が枠に入りきらなかった所。 */
export interface PrintPage {
  svg: string;
  /** 入りきらなかった欄の名前（点検に使う） */
  overflow: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** 1 pt を mm に。 */
const PT = 0.3528;

/** 配色（第41.3節）。主の色から、地・帯・字・差し色を決める。字と地の明るさの差は読みやすい幅に保つ。 */
export interface Palette {
  bg: string; band: string; bandText: string; head: string; text: string; muted: string; accent: string; panel: string; pattern: string;
}

/** 主の色と組み合わせの番号から配色を作る（純粋な関数）。 */
export function paletteOf(color: string, n: number): Palette {
  const main = readableColor(color) ?? '#1f3a5f';
  const deep = shade(main, 0.55);
  if (n === 1) return { bg: tint(main, 0.9), band: main, bandText: '#ffffff', head: deep, text: '#2b2b2b', muted: '#5b5b5b', accent: main, panel: '#ffffff', pattern: tint(main, 0.78) };
  if (n === 2) return { bg: deep, band: main, bandText: '#ffffff', head: '#ffffff', text: '#f4f4f4', muted: tint(main, 0.75), accent: tint(main, 0.55), panel: shade(main, 0.75), pattern: shade(main, 0.65) };
  return { bg: '#ffffff', band: main, bandText: '#ffffff', head: main, text: '#262626', muted: '#5f5f5f', accent: main, panel: tint(main, 0.92), pattern: tint(main, 0.85) };
}

/** 色を黒に寄せる。 */
function shade(hex: string, keep: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c * keep).toString(16).padStart(2, '0');
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** 文の 1 行の字数の目安で割り、枠の高さに収まるまで字を小さくする。収まらなければ最小の大きさで行を切る。 */
export function fitText(text: string, boxW: number, boxH: number, maxSize: number, minSize: number, lineHeight = 1.45): { size: number; lines: string[]; overflow: boolean } {
  const paras = text.split('\n').map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return { size: maxSize, lines: [], overflow: false };
  for (let size = maxSize; size >= minSize - 1e-6; size *= 0.92) {
    const lines = paras.flatMap((p) => wrapAt(p, boxW / size));
    if (lines.length * size * lineHeight <= boxH) return { size, lines, overflow: false };
  }
  const lines = paras.flatMap((p) => wrapAt(p, boxW / minSize));
  const max = Math.max(1, Math.floor(boxH / (minSize * lineHeight)));
  return { size: minSize, lines: lines.length > max ? [...lines.slice(0, max - 1), `${lines[max - 1]}…`] : lines, overflow: lines.length > max };
}

/** 字の塊（行ごとの <text>）。`anchor` は start・middle・end。 */
function textBlock(lines: string[], x: number, y: number, size: number, fill: string, o: { weight?: number; anchor?: 'start' | 'middle' | 'end'; lineHeight?: number } = {}): string {
  const lh = size * (o.lineHeight ?? 1.45);
  return lines.map((l, i) => `<text x="${x.toFixed(2)}" y="${(y + size * 0.88 + i * lh).toFixed(2)}" font-family="Noto Sans JP" font-size="${size.toFixed(2)}" font-weight="${o.weight ?? 400}" fill="${fill}" text-anchor="${o.anchor ?? 'start'}">${esc(l)}</text>`).join('');
}

/** 文を枠に入れる（収まらなければ overflow に名前を足す）。返すのは SVG と使った高さ。 */
function boxText(
  text: string, name: string, x: number, y: number, w: number, h: number, maxSize: number, minSize: number, fill: string, overflow: string[],
  o: { weight?: number; anchor?: 'start' | 'middle' | 'end'; lineHeight?: number } = {},
): { svg: string; used: number } {
  if (!text.trim()) return { svg: '', used: 0 };
  const f = fitText(text, w, h, maxSize, minSize, o.lineHeight ?? 1.45);
  if (f.overflow) overflow.push(name);
  const ax = o.anchor === 'middle' ? x + w / 2 : o.anchor === 'end' ? x + w : x;
  return { svg: textBlock(f.lines, ax, y, f.size, fill, o), used: f.lines.length * f.size * (o.lineHeight ?? 1.45) };
}

let clipSeq = 0;
/** 画像を枠いっぱいに（はみ出しは切る）。無ければ淡い模様にする。 */
function picture(img: string | null, x: number, y: number, w: number, h: number, p: Palette, radius = 0): string {
  const id = `c${clipSeq++}`;
  const clip = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}"/></clipPath>`;
  if (img) return `${clip}<image href="${img}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
  const r = Math.min(w, h);
  return `${clip}<g clip-path="url(#${id})"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${p.panel}"/>`
    + `<circle cx="${x + w * 0.82}" cy="${y + h * 0.2}" r="${r * 0.42}" fill="${p.pattern}"/><circle cx="${x + w * 0.12}" cy="${y + h * 0.9}" r="${r * 0.3}" fill="${p.pattern}" opacity="0.7"/></g>`;
}

/** 下の会社の欄（ロゴ・名前・住所・電話・Web・QR）。高さ `h` に収める。 */
function footer(i: PrintLayoutInput, p: Palette, x: number, y: number, w: number, h: number, overflow: string[], dark = false): string {
  const parts: string[] = [];
  let left = x;
  if (i.logo) {
    parts.push(`<image href="${i.logo}" x="${left}" y="${y + h * 0.1}" width="${h * 0.8}" height="${h * 0.8}" preserveAspectRatio="xMidYMid meet"/>`);
    left += h * 0.95;
  }
  const qrW = i.qr ? h : 0;
  const textW = w - (left - x) - qrW - (i.qr ? h * 0.15 : 0);
  const fill = dark ? p.text : p.muted;
  const name = boxText(i.company.name, '会社の名前', left, y, textW, h * 0.42, h * 0.3, h * 0.18, dark ? p.head : p.head, overflow, { weight: 700 });
  const info = [i.company.address, [i.company.phone && `TEL ${i.company.phone}`, i.company.website].filter(Boolean).join('　')].filter(Boolean).join('\n');
  const rest = boxText(info, '連絡先', left, y + h * 0.45, textW, h * 0.55, h * 0.2, h * 0.12, fill, overflow);
  parts.push(name.svg, rest.svg);
  if (i.qr) parts.push(`<rect x="${x + w - qrW}" y="${y}" width="${qrW}" height="${qrW}" fill="#ffffff"/><image href="${i.qr}" x="${x + w - qrW + qrW * 0.04}" y="${y + qrW * 0.04}" width="${qrW * 0.92}" height="${qrW * 0.92}"/>`);
  return parts.join('');
}

/** 値段の札（丸い角の塗り）。 */
function priceTag(text: string, x: number, y: number, w: number, h: number, p: Palette, overflow: string[]): string {
  if (!text.trim()) return '';
  const t = boxText(text, '値段', x + w * 0.06, y + h * 0.12, w * 0.88, h * 0.76, h * 0.62, h * 0.3, '#ffffff', overflow, { weight: 700, anchor: 'middle', lineHeight: 1.2 });
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h * 0.22}" fill="${p.accent}"/>${t.svg}`;
}

/** 面の外枠（背景を塗り足しまで描く）。 */
function frame(w: number, h: number, bg: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm">`
    + `<rect x="${-BLEED}" y="${-BLEED}" width="${w + BLEED * 2}" height="${h + BLEED * 2}" fill="${bg}"/>${body}</svg>`;
}

/**
 * 組み版をする（純粋な関数）。パンフレットは外側と内側の 2 面、値札は 10 品ごとに 1 面、何枚も作る物は 1 枚ごとに 1 面、ほかは 1 面。
 *
 * @returns 面ごとの SVG（`viewBox` は仕上がりの寸法。塗り足しは外へ 3mm）
 */
export function layout(i: PrintLayoutInput): PrintPage[] {
  // 同じ型で何枚も: 1 枚ごとに見出し・ひとこと・値段を差し替えて組む（第41.19.1節。パンフレットと値札は対象外）
  const pieces = i.copy.pieces ?? [];
  if (pieces.length && i.template !== 'trifold' && i.template !== 'bifold' && i.template !== 'price-sheet') {
    return pieces.flatMap((p) => layout({ ...i, copy: { ...i.copy, ...p, pieces: [] } }));
  }
  const { w, h } = PRINT_SIZES[i.size];
  const p = paletteOf(i.color, i.palette);
  const c = i.copy;
  const overflow: string[] = [];
  const m = Math.min(w, h) * 0.07; // 余白
  const hs = i.headlineScale;
  const unit = Math.min(w, h) / 100; // 字の大きさの段の元（短い辺の 1%）
  const head = (x: number, y: number, bw: number, bh: number, fill: string, size: number, anchor: 'start' | 'middle' = 'start') =>
    boxText(c.headline, '見出し', x, y, bw, bh, size * hs, size * 0.45, fill, overflow, { weight: 700, anchor, lineHeight: 1.2 });
  const one = (svg: string): PrintPage[] => [{ svg, overflow }];

  switch (i.template) {
    case 'band': {
      const bandH = h * 0.2;
      const H = head(m, m * 0.8, w - m * 2, bandH - m * 1.1, p.bandText, unit * 11);
      const imgY = bandH + m * 0.6;
      const imgH = h * 0.3;
      const sub = boxText(c.sub, 'ひとこと', m, imgY + imgH + m * 0.5, w - m * 2, unit * 12, unit * 5.2, unit * 3.2, p.head, overflow, { weight: 700 });
      const y1 = imgY + imgH + m * 0.5 + sub.used + m * 0.3;
      const tagW = c.price ? w * 0.36 : 0;
      const body = boxText(c.body, '本文', m, y1, w - m * 2 - tagW - (tagW ? m * 0.4 : 0), h * 0.82 - unit * 9.5 - y1, unit * 4.2, unit * 2.6, p.text, overflow);
      const per = boxText(c.period, '期間', m, h * 0.82 - unit * 7.5, w - m * 2, unit * 7, unit * 4.6, unit * 3, p.head, overflow, { weight: 700 });
      const note = boxText(c.note, '注意書き', m, h * 0.82 - unit * 0.2, w - m * 2, unit * 4.6, unit * 2.6, unit * 2, p.muted, overflow);
      return one(frame(w, h, p.bg, [
        `<rect x="${-BLEED}" y="${-BLEED}" width="${w + BLEED * 2}" height="${bandH + BLEED}" fill="${p.band}"/>`, H.svg,
        picture(i.image, m, imgY, w - m * 2, imgH, p, unit * 2), sub.svg, body.svg,
        priceTag(c.price, w - m - tagW, y1, tagW, unit * 14, p, overflow), per.svg, note.svg,
        `<line x1="${m}" y1="${h * 0.87}" x2="${w - m}" y2="${h * 0.87}" stroke="${p.accent}" stroke-width="${unit * 0.3}"/>`,
        footer(i, p, m, h * 0.885, w - m * 2, h * 0.09, overflow, i.palette === 2),
      ].join('')));
    }
    case 'photo-top': {
      const imgH = h * 0.5;
      const stripY = imgH - h * 0.13;
      const H = head(m, stripY + m * 0.3, w - m * 2, h * 0.13 - m * 0.4, '#ffffff', unit * 11);
      const sub = boxText(c.sub, 'ひとこと', m, imgH + m * 0.6, w - m * 2, unit * 12, unit * 5.4, unit * 3.2, p.head, overflow, { weight: 700 });
      const y1 = imgH + m * 0.6 + sub.used + m * 0.3;
      const tagW = c.price ? w * 0.36 : 0;
      const body = boxText(c.body, '本文', m, y1, w - m * 2 - tagW - (tagW ? m * 0.4 : 0), h * 0.83 - unit * 9.6 - y1, unit * 4.2, unit * 2.6, p.text, overflow);
      const per = boxText(c.period, '期間', m, h * 0.83 - unit * 7.6, w - m * 2, unit * 7, unit * 4.6, unit * 3, p.head, overflow, { weight: 700 });
      const note = boxText(c.note, '注意書き', m, h * 0.83 - unit * 0.3, w - m * 2, unit * 4.6, unit * 2.6, unit * 2, p.muted, overflow);
      return one(frame(w, h, p.bg, [
        picture(i.image, -BLEED, -BLEED, w + BLEED * 2, imgH + BLEED, p),
        `<rect x="${-BLEED}" y="${stripY}" width="${w + BLEED * 2}" height="${h * 0.13}" fill="${p.band}" opacity="0.92"/>`, H.svg,
        sub.svg, body.svg, priceTag(c.price, w - m - tagW, y1, tagW, unit * 14, p, overflow), per.svg, note.svg,
        footer(i, p, m, h * 0.885, w - m * 2, h * 0.09, overflow, i.palette === 2),
      ].join('')));
    }
    case 'photo-frame': {
      const H = head(m, m, w - m * 2, h * 0.15, p.head, unit * 10.5, 'middle');
      const sub = boxText(c.sub, 'ひとこと', m, m + H.used + unit * 2, w - m * 2, unit * 10, unit * 5, unit * 3.2, p.accent, overflow, { weight: 700, anchor: 'middle' });
      const imgY = m + H.used + sub.used + unit * 4;
      const imgH = h * 0.34;
      const y1 = imgY + imgH + m * 0.5;
      const body = boxText(c.body, '本文', m * 1.3, y1, w - m * 2.6, h * 0.8 - y1 - unit * 15, unit * 4.2, unit * 2.6, p.text, overflow, { anchor: 'middle' });
      const per = boxText(c.period, '期間', m, h * 0.8 - unit * 14, w - m * 2, unit * 7, unit * 4.8, unit * 3, p.head, overflow, { weight: 700, anchor: 'middle' });
      const price = priceTag(c.price, w * 0.3, h * 0.8 - unit * 6.5, w * 0.4, unit * 9, p, overflow);
      const note = boxText(c.note, '注意書き', m, h * 0.8 + unit * 3.2, w - m * 2, unit * 4.4, unit * 2.6, unit * 2, p.muted, overflow, { anchor: 'middle' });
      return one(frame(w, h, p.bg, [
        `<rect x="${m * 0.5}" y="${m * 0.5}" width="${w - m}" height="${h - m}" rx="${unit * 3}" fill="none" stroke="${p.accent}" stroke-width="${unit * 0.5}"/>`,
        H.svg, sub.svg, picture(i.image, m * 1.3, imgY, w - m * 2.6, imgH, p, unit * 4), body.svg, per.svg, price, note.svg,
        footer(i, p, m, h * 0.885, w - m * 2, h * 0.075, overflow, i.palette === 2),
      ].join('')));
    }
    case 'split': {
      const imgW = w * 0.44;
      const x0 = imgW + m * 0.8;
      const tw = w - x0 - m;
      const H = head(x0, m * 1.2, tw, h * 0.26, p.head, unit * 10);
      let y = m * 1.2 + H.used + unit * 3;
      const sub = boxText(c.sub, 'ひとこと', x0, y, tw, unit * 14, unit * 5, unit * 3.2, p.accent, overflow, { weight: 700 });
      y += sub.used + unit * 3;
      const body = boxText(c.body, '本文', x0, y, tw, h * 0.66 - y, unit * 4, unit * 2.6, p.text, overflow);
      const price = priceTag(c.price, x0, h * 0.66 + unit * 1, tw, unit * 12, p, overflow);
      const per = boxText(c.period, '期間', x0, h * 0.66 + unit * 15, tw, unit * 9, unit * 4.6, unit * 3, p.head, overflow, { weight: 700 });
      const note = boxText(c.note, '注意書き', x0, h * 0.66 + unit * 25, tw, unit * 6, unit * 2.6, unit * 2, p.muted, overflow);
      return one(frame(w, h, p.bg, [
        picture(i.image, -BLEED, -BLEED, imgW + BLEED, h + BLEED * 2, p),
        `<rect x="${imgW}" y="${-BLEED}" width="${unit * 1.2}" height="${h + BLEED * 2}" fill="${p.band}"/>`,
        H.svg, sub.svg, body.svg, price, per.svg, note.svg, footer(i, p, x0, h * 0.885, tw, h * 0.08, overflow, i.palette === 2),
      ].join('')));
    }
    case 'bold-center': {
      const bg = i.palette === 0 ? p.band : p.bg;
      const fg = i.palette === 0 ? '#ffffff' : p.head;
      const txt = i.palette === 0 ? '#ffffff' : p.text;
      const H = head(m, h * 0.16, w - m * 2, h * 0.3, fg, unit * 15, 'middle');
      const sub = boxText(c.sub, 'ひとこと', m, h * 0.16 + H.used + unit * 4, w - m * 2, unit * 14, unit * 6, unit * 3.4, fg, overflow, { weight: 700, anchor: 'middle' });
      const y1 = h * 0.16 + H.used + sub.used + unit * 9;
      const body = boxText(c.body, '本文', m * 1.4, y1, w - m * 2.8, h * 0.72 - y1, unit * 4.6, unit * 2.8, txt, overflow, { anchor: 'middle' });
      const per = boxText(c.period, '期間', m, h * 0.72, w - m * 2, unit * 8, unit * 5.6, unit * 3.4, fg, overflow, { weight: 700, anchor: 'middle' });
      const price = c.price ? `<rect x="${w * 0.25}" y="${h * 0.72 + unit * 9}" width="${w * 0.5}" height="${unit * 11}" rx="${unit * 5.5}" fill="#ffffff"/>${boxText(c.price, '値段', w * 0.27, h * 0.72 + unit * 10.5, w * 0.46, unit * 8, unit * 6.4, unit * 3, p.band, overflow, { weight: 700, anchor: 'middle', lineHeight: 1.2 }).svg}` : '';
      const note = boxText(c.note, '注意書き', m, h * 0.72 + unit * 21.5, w - m * 2, unit * 4.4, unit * 2.6, unit * 2, txt, overflow, { anchor: 'middle' });
      return one(frame(w, h, bg, [
        `<circle cx="${w * 0.92}" cy="${h * 0.06}" r="${w * 0.22}" fill="${i.palette === 0 ? tint(p.band, 0.2) : p.pattern}" opacity="0.6"/>`,
        H.svg, sub.svg, body.svg, per.svg, price, note.svg,
        `<rect x="${m}" y="${h * 0.875}" width="${w - m * 2}" height="${h * 0.1}" rx="${unit * 2}" fill="#ffffff"/>`,
        footer(i, paletteOf(i.color, 0), m * 1.3, h * 0.885, w - m * 2.6, h * 0.08, overflow),
      ].join('')));
    }
    case 'notice-plain': {
      const bandH = h * 0.12;
      const H = head(m, bandH * 0.18, w - m * 2, bandH * 0.7, p.bandText, unit * 8, 'middle');
      const sub = boxText(c.sub, 'ひとこと', m, bandH + m, w - m * 2, unit * 12, unit * 5.4, unit * 3.4, p.head, overflow, { weight: 700, anchor: 'middle' });
      const per = c.period ? `<rect x="${m}" y="${bandH + m + sub.used + unit * 3}" width="${w - m * 2}" height="${unit * 12}" rx="${unit * 2}" fill="${p.panel}"/>${boxText(c.period, '期間', m * 1.3, bandH + m + sub.used + unit * 5, w - m * 2.6, unit * 8, unit * 5.6, unit * 3.4, p.head, overflow, { weight: 700, anchor: 'middle' }).svg}` : '';
      const y1 = bandH + m + sub.used + (c.period ? unit * 18 : unit * 4);
      const body = boxText(c.body, '本文', m * 1.2, y1, w - m * 2.4, h * 0.8 - y1, unit * 4.8, unit * 3, p.text, overflow, { lineHeight: 1.7 });
      const note = boxText([c.price, c.note].filter(Boolean).join('\n'), '注意書き', m, h * 0.8, w - m * 2, unit * 8, unit * 3.4, unit * 2.2, p.muted, overflow);
      return one(frame(w, h, p.bg, [
        `<rect x="${-BLEED}" y="${-BLEED}" width="${w + BLEED * 2}" height="${bandH + BLEED}" fill="${p.band}"/>`, H.svg, sub.svg, per, body.svg, note.svg,
        `<line x1="${m}" y1="${h * 0.87}" x2="${w - m}" y2="${h * 0.87}" stroke="${p.accent}" stroke-width="${unit * 0.3}"/>`,
        footer(i, p, m, h * 0.885, w - m * 2, h * 0.085, overflow, i.palette === 2),
      ].join('')));
    }
    case 'pop-price':
    case 'pop-photo':
    case 'pop-ribbon': {
      const t = i.template;
      const parts: string[] = [`<rect x="${m * 0.5}" y="${m * 0.5}" width="${w - m}" height="${h - m}" rx="${unit * 4}" fill="none" stroke="${p.accent}" stroke-width="${unit * 1.2}"/>`];
      let y = m * 1.2;
      if (t === 'pop-ribbon' || t === 'pop-price') {
        const label = c.sub && c.sub.length <= 10 ? c.sub : 'おすすめ';
        parts.push(`<path d="M ${m} ${y} h ${w * 0.5} l ${-unit * 4} ${unit * 6} l ${unit * 4} ${unit * 6} h ${-w * 0.5} z" fill="${p.band}"/>`,
          boxText(label, 'ひとこと', m + unit * 3, y + unit * 1.6, w * 0.42, unit * 9, unit * 7, unit * 3.6, '#ffffff', overflow, { weight: 700, lineHeight: 1.2 }).svg);
        y += unit * 16;
      }
      if (t === 'pop-photo' || t === 'pop-price') {
        const imgH = t === 'pop-photo' ? h * 0.3 : h * 0.2;
        parts.push(picture(i.image, m * 1.2, y, w - m * 2.4, imgH, p, unit * 3));
        y += imgH + unit * 4;
      }
      const H = head(m * 1.2, y, w - m * 2.4, h * (t === 'pop-ribbon' ? 0.26 : 0.18), p.head, unit * (t === 'pop-ribbon' ? 13 : 11), 'middle');
      parts.push(H.svg);
      y += H.used + unit * 3;
      if (t === 'pop-photo' && c.sub) { const s = boxText(c.sub, 'ひとこと', m * 1.2, y, w - m * 2.4, unit * 12, unit * 6, unit * 3.4, p.accent, overflow, { weight: 700, anchor: 'middle' }); parts.push(s.svg); y += s.used + unit * 2; }
      const priceH = c.price ? unit * (t === 'pop-price' ? 20 : 15) : 0;
      const bodyH = h - m * 1.4 - y - priceH - unit * 9;
      parts.push(boxText(c.body, '本文', m * 1.3, y, w - m * 2.6, bodyH, unit * 5.6, unit * 3.4, p.text, overflow, { anchor: 'middle' }).svg);
      if (c.price) parts.push(priceTag(c.price, w * 0.18, h - m * 1.4 - priceH - unit * 8, w * 0.64, priceH, p, overflow));
      parts.push(boxText([c.period, c.note].filter(Boolean).join('　'), '期間', m * 1.2, h - m * 1.4 - unit * 7, w - m * 2.4, unit * 7, unit * 3.6, unit * 2.4, p.muted, overflow, { anchor: 'middle' }).svg);
      return one(frame(w, h, p.bg, parts.join('')));
    }
    case 'card': {
      const pad = h * 0.1;
      const qr = i.qr ? h * 0.42 : 0;
      const tw = w - pad * 2 - (qr ? qr + pad * 0.6 : 0);
      const logoH = i.logo ? h * 0.22 : 0;
      const parts = [
        `<rect x="${-BLEED}" y="${h * 0.84}" width="${w + BLEED * 2}" height="${h * 0.16 + BLEED}" fill="${p.band}"/>`,
        i.logo ? `<image href="${i.logo}" x="${pad}" y="${pad}" width="${logoH * 2.5}" height="${logoH}" preserveAspectRatio="xMinYMid meet"/>` : '',
      ];
      let y = pad + (logoH ? logoH + h * 0.04 : 0);
      const name = boxText(c.headline || i.company.name, '見出し', pad, y, tw, h * 0.2, h * 0.11 * i.headlineScale, h * 0.06, p.head, overflow, { weight: 700, lineHeight: 1.2 });
      y += name.used + h * 0.03;
      const sub = boxText(c.sub, 'ひとこと', pad, y, tw, h * 0.1, h * 0.06, h * 0.045, p.accent, overflow, { weight: 700 });
      y += sub.used + h * 0.02;
      const info = [i.company.address, i.company.phone && `TEL ${i.company.phone}`, c.body].filter(Boolean).join('\n');
      const rest = boxText(info, '連絡先', pad, y, tw, h * 0.82 - y, h * 0.052, h * 0.04, p.text, overflow, { lineHeight: 1.35 });
      parts.push(name.svg, sub.svg, rest.svg);
      if (i.qr) parts.push(`<rect x="${w - pad - qr}" y="${h * 0.3}" width="${qr}" height="${qr}" fill="#ffffff"/><image href="${i.qr}" x="${w - pad - qr}" y="${h * 0.3}" width="${qr}" height="${qr}"/>`);
      parts.push(boxText(i.company.website, 'Web', pad, h * 0.865, w - pad * 2, h * 0.1, h * 0.05, h * 0.035, p.bandText, overflow, { anchor: 'middle' }).svg);
      return one(frame(w, h, p.bg, parts.join('')));
    }
    case 'price-sheet': {
      // A4 に名刺の大きさの札を 2 列 × 5 段。切り取りの線は淡い破線。11 品目からは次のシート（第41.18節）
      const tags = tagLines(c.body);
      const per = PRINT_LIMITS.tagsPerSheet;
      if (tags.length > PRINT_LIMITS.tagsMax) overflow.push('値札の数');
      const sheets = Math.max(1, Math.min(Math.ceil(tags.length / per), PRINT_LIMITS.tagsMax / per));
      const x0 = (w - TAG.w * TAG.cols) / 2;
      const y0 = (h - TAG.h * TAG.rows) / 2;
      const fill = i.palette === 1 ? tint(p.band, 0.9) : i.palette === 2 ? p.band : '#ffffff';
      const ink = i.palette === 2 ? '#ffffff' : p.head;
      const sub = i.palette === 2 ? tint(p.band, 0.75) : p.muted;
      const u = TAG.h / 100;
      return Array.from({ length: sheets }, (_, s) => {
        const parts: string[] = [];
        tags.slice(s * per, (s + 1) * per).forEach((t, k) => {
          const x = x0 + (k % TAG.cols) * TAG.w;
          const y = y0 + Math.floor(k / TAG.cols) * TAG.h;
          const pad = u * 9;
          parts.push(`<rect x="${x + u * 3}" y="${y + u * 3}" width="${TAG.w - u * 6}" height="${TAG.h - u * 6}" rx="${u * 5}" fill="${fill}" stroke="${p.accent}" stroke-width="${u * 1.2}"/>`);
          if (c.sub) parts.push(boxText(c.sub, 'ひとこと', x + pad, y + pad, TAG.w - pad * 2, u * 13, u * 11, u * 7, i.palette === 2 ? '#ffffff' : p.accent, overflow, { weight: 700 }).svg);
          const top = y + pad + (c.sub ? u * 15 : 0);
          parts.push(boxText(t.name, '品目の名前', x + pad, top, TAG.w - pad * 2, u * (c.sub ? 32 : 40), u * 16 * i.headlineScale, u * 8, ink, overflow, { weight: 700, lineHeight: 1.25 }).svg);
          // 金額は大きく、「（税込）」などは小さく右下に
          const m = /^(.*?)\s*([（(][^）)]*[）)])$/.exec(t.price);
          const [amount, tax] = m ? [m[1]!, m[2]!] : [t.price, ''];
          parts.push(boxText(amount, '値段', x + pad, y + TAG.h - pad - u * 36, TAG.w - pad * 2, u * 27, u * 25, u * 12, ink, overflow, { weight: 700, anchor: 'end', lineHeight: 1.1 }).svg);
          if (tax) parts.push(boxText(tax, '値段', x + TAG.w * 0.5, y + TAG.h - pad - u * 8, TAG.w * 0.5 - pad, u * 8, u * 7, u * 5, ink, overflow, { anchor: 'end', lineHeight: 1.1 }).svg);
          if (c.note) parts.push(boxText(c.note, '注意書き', x + pad, y + TAG.h - pad - u * 8, TAG.w * 0.45, u * 8, u * 6.5, u * 4.5, sub, overflow).svg);
        });
        // 切り取りの線
        for (let col = 0; col <= TAG.cols; col += 1) parts.push(`<line x1="${x0 + col * TAG.w}" y1="${y0 - 4}" x2="${x0 + col * TAG.w}" y2="${y0 + TAG.rows * TAG.h + 4}" stroke="#c8c8c8" stroke-width="0.15" stroke-dasharray="1.2 1.2"/>`);
        for (let row = 0; row <= TAG.rows; row += 1) parts.push(`<line x1="${x0 - 4}" y1="${y0 + row * TAG.h}" x2="${x0 + TAG.cols * TAG.w + 4}" y2="${y0 + row * TAG.h}" stroke="#c8c8c8" stroke-width="0.15" stroke-dasharray="1.2 1.2"/>`);
        return { svg: frame(w, h, '#ffffff', parts.join('')), overflow };
      });
    }
    case 'trifold':
    case 'bifold': {
      const panels = i.template === 'trifold' ? 3 : 2;
      const pw = w / panels;
      const pm = pw * 0.09;
      const u = Math.min(pw, h) / 100;
      const folds = Array.from({ length: panels - 1 }, (_, k) => `<line x1="${pw * (k + 1)}" y1="0" x2="${pw * (k + 1)}" y2="${h}" stroke="${p.pattern}" stroke-width="0.2" stroke-dasharray="1.5 1.5"/>`).join('');
      // 外側: 右端が表紙、その左が裏表紙（会社の欄）、三つ折りは左端が折り込み（ひとことと期間）
      const cx = pw * (panels - 1);
      const cover = [
        picture(i.image, cx - (panels === 2 ? 0 : 0), -BLEED, pw + BLEED, h * 0.55 + BLEED, p),
        `<rect x="${cx}" y="${h * 0.55}" width="${pw + BLEED}" height="${h * 0.45 + BLEED}" fill="${p.band}"/>`,
        boxText(c.headline, '見出し', cx + pm, h * 0.58, pw - pm * 2, h * 0.24, u * 11 * i.headlineScale, u * 5, '#ffffff', overflow, { weight: 700, lineHeight: 1.2 }).svg,
        boxText(c.sub, 'ひとこと', cx + pm, h * 0.84, pw - pm * 2, h * 0.12, u * 5, u * 3, '#ffffff', overflow).svg,
      ].join('');
      const bx = pw * (panels - 2);
      const back = [
        boxText(c.note, '注意書き', bx + pm, pm, pw - pm * 2, h * 0.5, u * 4.4, u * 2.8, p.text, overflow).svg,
        footer(i, p, bx + pm, h * 0.72, pw - pm * 2, h * 0.16, overflow, i.palette === 2),
      ].join('');
      const flap = panels === 3 ? [
        boxText(c.period, '期間', pm, pm * 1.5, pw - pm * 2, h * 0.2, u * 6, u * 3.6, p.head, overflow, { weight: 700 }).svg,
        c.price ? priceTag(c.price, pm, h * 0.3, pw - pm * 2, u * 18, p, overflow) : '',
        picture(null, pm, h * 0.55, pw - pm * 2, h * 0.35, p, u * 3),
      ].join('') : '';
      const outside = frame(w, h, p.bg, `${flap}${back}${cover}${folds}`);
      // 内側: 本文を面の数に分けて流す
      const paras = c.body.split('\n').filter((x) => x.trim());
      const per = Math.max(1, Math.ceil(paras.length / panels));
      const inner = Array.from({ length: panels }, (_, k) => {
        const chunk = paras.slice(k * per, (k + 1) * per).join('\n');
        const x = pw * k + pm;
        return [
          k === 0 ? boxText(c.headline, '見出し', x, pm, pw - pm * 2, h * 0.16, u * 7, u * 4, p.head, overflow, { weight: 700, lineHeight: 1.2 }).svg : '',
          `<rect x="${x}" y="${k === 0 ? h * 0.2 : pm}" width="${u * 10}" height="${u * 1}" fill="${p.accent}"/>`,
          boxText(chunk, '本文', x, (k === 0 ? h * 0.2 : pm) + u * 4, pw - pm * 2, h * (k === 0 ? 0.72 : 0.84), u * 4.4, u * 2.8, p.text, overflow, { lineHeight: 1.6 }).svg,
        ].join('');
      }).join('');
      return [{ svg: outside, overflow }, { svg: frame(w, h, p.bg === '#ffffff' ? '#ffffff' : p.bg, `${inner}${folds}`), overflow }];
    }
  }
}

/** 文字の大きさ（pt）を mm に（型の外で使う）。 */
export const ptToMm = (pt: number) => pt * PT;
