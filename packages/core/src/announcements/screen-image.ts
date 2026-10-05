/**
 * @file お知らせのサイネージの画面の 1 枚（1920×1080。仕様書 第35.6.4節）。帯・見出し・期間・説明・一言を、大きな字で組む。
 *
 * 字は M2Office が組む（生成 AI に字を描かせない。日本語の字が崩れるため）。書体はコラムのカバーと同じ Noto Sans JP。
 */

import { renderSvgPng, wrapAt } from '../columns/cover.js';

/** 横と縦の画素数。 */
export const SCREEN_WIDTH = 1920;
export const SCREEN_HEIGHT = 1080;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 1 枚の中身。 */
export interface ScreenCard {
  headline: string;
  period: string;
  /** 見出しの下の説明（2 行まで。空なら出さない。第 0.261.0 版） */
  detail?: string;
  note: string;
  /** 帯の色（`#RRGGBB`）。無ければ濃い青 */
  color?: string | null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** 色を白に寄せる（期間の囲みの地に使う）。 */
function tint(hex: string, toWhite: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * toWhite).toString(16).padStart(2, '0');
  return `#${mix((n >> 16) & 255)}${mix((n >> 8) & 255)}${mix(n & 255)}`;
}

/** 1 枚の SVG（白い地に、上の帯・見出し・期間・説明・一言）。会社の名前は出さない（第35.6.4節）。 */
export function screenSvg(c: ScreenCard): string {
  const W = SCREEN_WIDTH;
  const H = SCREEN_HEIGHT;
  const accent = c.color && HEX.test(c.color) ? c.color : '#1f3a5f';
  const headSize = [...c.headline].length > 16 ? 104 : 132;
  const head = wrapAt(c.headline || 'お知らせ', (W - 240) / headSize).slice(0, 2);
  const periodLines = c.period ? wrapAt(c.period, (W - 320) / 64).slice(0, 2) : [];
  const detailLines = c.detail ? wrapAt(c.detail, (W - 320) / 56).slice(0, 2) : [];
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#fbfaf6"/>`,
    `<rect width="${W}" height="140" fill="${accent}"/>`,
    `<text x="120" y="96" font-family="Noto Sans JP" font-weight="700" font-size="56" fill="#ffffff">お知らせ</text>`,
  ];
  // 中身の高さに合わせて、帯の下の空きの真ん中に置く（説明が無いときに上に寄らないように）
  const headH = head.length * Math.round(headSize * 1.25);
  const periodH = periodLines.length ? periodLines.length * 86 + 50 : 0;
  const detailH = detailLines.length * 76;
  const gaps = (periodLines.length ? 40 : 0) + (detailLines.length ? 40 : 0);
  const top = 140 + Math.max(50, Math.round((H - 140 - 130 - (headH + periodH + detailH + gaps)) / 2));
  let y = top + Math.round(headSize * 0.95);
  for (const line of head) {
    parts.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="${headSize}" fill="#1d2733">${esc(line)}</text>`);
    y += Math.round(headSize * 1.25);
  }
  y -= Math.round(headSize * 0.95);
  if (periodLines.length) {
    y += 40;
    parts.push(`<rect x="160" y="${y}" width="${W - 320}" height="${periodH}" rx="24" fill="${tint(accent, 0.88)}"/>`);
    let py = y + 25 + 66;
    for (const line of periodLines) {
      parts.push(`<text x="${W / 2}" y="${py}" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="64" fill="${accent}">${esc(line)}</text>`);
      py += 86;
    }
    y += periodH;
  }
  if (detailLines.length) {
    y += 40;
    for (const line of detailLines) {
      y += 60;
      parts.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Noto Sans JP" font-size="56" fill="#2c3640">${esc(line)}</text>`);
      y += 16;
    }
  }
  if (c.note) parts.push(`<text x="${W / 2}" y="${H - 80}" text-anchor="middle" font-family="Noto Sans JP" font-size="48" fill="#4a5560">${esc([...c.note].slice(0, 30).join(''))}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** 1 枚を PNG にする。 */
export function renderScreenCard(c: ScreenCard): Uint8Array {
  return renderSvgPng(screenSvg(c), SCREEN_WIDTH);
}
