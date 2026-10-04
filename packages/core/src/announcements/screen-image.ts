/**
 * @file お知らせの店頭の画面の 1 枚（1920×1080。仕様書 第35.6.4節）。見出し・期間・一言・会社の名前を、大きな字で組む。
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
  note: string;
  company: string;
}

/** 1 枚の SVG（白い地に、上の帯・見出し・期間・一言）。 */
export function screenSvg(c: ScreenCard): string {
  const W = SCREEN_WIDTH;
  const H = SCREEN_HEIGHT;
  const accent = '#1f5f8b';
  const headSize = [...c.headline].length > 16 ? 104 : 132;
  const head = wrapAt(c.headline || 'お知らせ', (W - 240) / headSize).slice(0, 2);
  const periodLines = c.period ? wrapAt(c.period, (W - 240) / 64).slice(0, 2) : [];
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#fbfaf6"/>`,
    `<rect width="${W}" height="140" fill="${accent}"/>`,
    `<text x="120" y="96" font-family="Noto Sans JP" font-weight="700" font-size="56" fill="#ffffff">お知らせ</text>`,
  ];
  let y = 330;
  for (const line of head) {
    parts.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="${headSize}" fill="#1d2733">${esc(line)}</text>`);
    y += Math.round(headSize * 1.3);
  }
  y += 30;
  if (periodLines.length) {
    parts.push(`<rect x="160" y="${y - 70}" width="${W - 320}" height="${periodLines.length * 90 + 40}" rx="24" fill="#e8f0f6"/>`);
    for (const line of periodLines) {
      parts.push(`<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Noto Sans JP" font-weight="700" font-size="64" fill="${accent}">${esc(line)}</text>`);
      y += 90;
    }
    y += 40;
  }
  if (c.note) parts.push(`<text x="${W / 2}" y="${Math.min(y + 40, H - 150)}" text-anchor="middle" font-family="Noto Sans JP" font-size="52" fill="#3c4650">${esc(c.note.slice(0, 30))}</text>`);
  if (c.company) parts.push(`<text x="${W - 120}" y="${H - 70}" text-anchor="end" font-family="Noto Sans JP" font-size="44" fill="#5b6570">${esc(c.company.slice(0, 30))}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

/** 1 枚を PNG にする。 */
export function renderScreenCard(c: ScreenCard): Uint8Array {
  return renderSvgPng(screenSvg(c), SCREEN_WIDTH);
}
