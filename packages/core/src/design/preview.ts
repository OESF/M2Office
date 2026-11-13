/**
 * @file 会社の見た目の見本の画像（仕様書 第46.8節）。色の組と、見出し・本文・ボタン・リンクを置いた簡単なページの絵を描く。
 *
 * 本物のページの写しではない（M2Office が描く絵）。書体は同梱の Noto Sans JP で描き、指定の書体の名前を添える。
 */

import { Resvg } from '@resvg/resvg-js';
import type { CompanyDesignTokens } from '@m2office/shared';
import { COVER_FONT_FILES } from '../columns/cover.js';
import { toBundledFontChars } from '../files/font-chars.js';

const W = 1200;
const H = 630;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 簡単なページの絵 1 枚（x・幅の中に描く）。 */
function pageSvg(t: CompanyDesignTokens, name: string, x: number, w: number, label: string): string {
  const c = t.colors;
  const r = t.shape.radiusMedium;
  const br = t.shape.button === 'pill' ? 22 : t.shape.button === 'square' ? 0 : r;
  const pad = 28;
  const h1 = Math.round(Math.min(40, t.typography.baseSize * t.typography.scale ** 3 * 0.9));
  const body = Math.round(t.typography.baseSize * 0.95);
  const shadow = t.shape.shadow ? `<rect x="${x + pad + 3}" y="${330 + 4}" width="${w - pad * 2}" height="150" rx="${t.shape.radiusLarge}" fill="#000" opacity="0.08"/>` : '';
  return `
  <g>
    <rect x="${x}" y="40" width="${w}" height="${H - 80}" rx="10" fill="${c.background}" stroke="${c.border}"/>
    <rect x="${x}" y="40" width="${w}" height="64" rx="10" fill="${c.primary}"/>
    <rect x="${x}" y="80" width="${w}" height="24" fill="${c.primary}"/>
    <text x="${x + pad}" y="80" font-size="22" font-weight="700" fill="${c.onPrimary}">${esc(name.slice(0, 18))}</text>
    <text x="${x + pad}" y="${150 + h1 * 0.4}" font-size="${h1}" font-weight="${t.typography.headingWeight >= 600 ? 700 : 400}" fill="${c.text}">お知らせ</text>
    <text x="${x + pad}" y="${210 + h1 * 0.2}" font-size="${body}" fill="${c.text}">本文の文字。読みやすさを確かめるための見本です。</text>
    <text x="${x + pad}" y="${240 + h1 * 0.2}" font-size="${Math.round(body * 0.85)}" fill="${c.muted}">2026年11月13日・薄い文字</text>
    <text x="${x + pad}" y="${272 + h1 * 0.2}" font-size="${body}" fill="${c.link}" text-decoration="underline">リンクの文字</text>
    ${shadow}
    <rect x="${x + pad}" y="330" width="${w - pad * 2}" height="150" rx="${t.shape.radiusLarge}" fill="${c.surface}" stroke="${t.shape.shadow ? 'none' : c.border}"/>
    <rect x="${x + pad + 20}" y="350" width="${Math.min(160, w / 3)}" height="10" rx="5" fill="${c.secondary}"/>
    <rect x="${x + pad + 20}" y="372" width="${Math.min(260, w / 2)}" height="8" rx="4" fill="${c.muted}" opacity="0.5"/>
    <rect x="${x + pad + 20}" y="410" width="168" height="46" rx="${br}" fill="${c.primary}"/>
    <text x="${x + pad + 104}" y="440" font-size="17" font-weight="700" fill="${c.onPrimary}" text-anchor="middle">お問い合わせ</text>
    <rect x="${x + pad + 204}" y="418" width="30" height="30" rx="${t.shape.radiusSmall}" fill="${c.accent}"/>
    <text x="${x + pad}" y="${H - 66}" font-size="14" fill="${c.muted}">${esc(`見出し ${t.typography.headingJa}・本文 ${t.typography.bodyJa}・欧文 ${t.typography.latin}`.slice(0, 60))}</text>
    <text x="${x + w - pad}" y="${H - 66}" font-size="14" fill="${c.muted}" text-anchor="end">${esc(label)}</text>
  </g>`;
}

/** 色の組の見本（下の帯）。 */
function paletteSvg(t: CompanyDesignTokens, y: number): string {
  const keys: (keyof CompanyDesignTokens['colors'])[] = ['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'muted', 'link'];
  const w = (W - 80) / keys.length;
  return keys.map((k, i) => `<rect x="${40 + i * w}" y="${y}" width="${w - 6}" height="14" rx="3" fill="${t.colors[k]}" stroke="#00000022"/>`).join('');
}

/**
 * 見本の画像（PNG）を描く。前の見た目を渡すと、いまの見た目と並べる。
 *
 * @param name 会社の名前（ページの上の帯に置く）
 */
export function renderDesignPreview(t: CompanyDesignTokens, name: string, before?: CompanyDesignTokens): Uint8Array {
  const body = before
    ? pageSvg(before, name, 30, 555, 'いま') + pageSvg(t, name, 615, 555, '直した後')
    : pageSvg(t, name, 120, 960, '見本（本物のページの写しではありません）');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Noto Sans JP">
  <rect width="${W}" height="${H}" fill="#eef1f4"/>${body}${paletteSvg(t, H - 30)}</svg>`;
  const png = new Resvg(toBundledFontChars(svg), {
    fitTo: { mode: 'width', value: W },
    font: { fontFiles: COVER_FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Noto Sans JP' },
  }).render().asPng();
  return new Uint8Array(png);
}
