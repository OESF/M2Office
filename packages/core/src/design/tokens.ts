/**
 * @file 会社の見た目の値（仕様書 第46.3節）。推論や取り込んだファイルの値を決まった形に直し、文字と背景の明るさの差を確かめる。
 *
 * 外から来た値は信じない。色は `#rrggbb`、書体は名前の文字だけ、数は決まった幅に収める（CSS に入れても崩れない・注入されないように）。
 */

import type { CompanyDesignTokens } from '@m2office/shared';

/** 会社の見た目がまだ無いときの値（落ち着いた青。M2Office の既定）。 */
export const DEFAULT_DESIGN: CompanyDesignTokens = {
  colors: {
    primary: '#1f5f8b', onPrimary: '#ffffff', secondary: '#4a6b82', accent: '#c8742b', background: '#ffffff', surface: '#f5f7f9',
    text: '#1d2733', muted: '#5f6b76', border: '#d8dee2', link: '#1f5f8b',
  },
  typography: { headingJa: 'Noto Sans JP', bodyJa: 'Noto Sans JP', latin: 'Inter', baseSize: 16, scale: 1.25, headingWeight: 700, bodyWeight: 400 },
  shape: { radiusSmall: 4, radiusMedium: 8, radiusLarge: 12, spacing: 16, shadow: false, button: 'rounded' },
  imagery: '明るく清潔な写真。人物は自然な表情',
  voice: 'です・ます。親しみがありつつ、きちんとした調子',
};

/** 本文の文字と背景の明るさの差の下限（WCAG AA）。 */
export const MIN_TEXT_CONTRAST = 4.5;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb`・`#rrggbb`・`rgb()` を `#rrggbb` にする。読めなければ `null`。 */
export function toHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  const m = HEX.exec(s);
  if (m) {
    const h = m[1]!;
    return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`;
  const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000' };
  return NAMED[s] ?? null;
}

const channels = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as [number, number, number];
const toHexOf = (c: number[]) => `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;

/** 相対輝度（WCAG）。 */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 2 つの色の明るさの差（1〜21）。 */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** 色を白か黒に寄せる（0〜1）。 */
export function mix(hex: string, toward: '#ffffff' | '#000000', t: number): string {
  const a = channels(hex);
  const b = channels(toward);
  return toHexOf(a.map((x, i) => x + (b[i]! - x) * t));
}

/**
 * 文字の色を、背景との差が足りるまで白か黒に寄せる（色みはできるだけ残す）。
 *
 * @returns 直した色と、直したか
 */
export function readableOn(fg: string, bg: string, min = MIN_TEXT_CONTRAST): { color: string; fixed: boolean } {
  if (contrast(fg, bg) >= min) return { color: fg, fixed: false };
  const toward = luminance(bg) > 0.4 ? '#000000' : '#ffffff';
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, toward, t);
    if (contrast(c, bg) >= min) return { color: c, fixed: true };
  }
  return { color: toward, fixed: true };
}

/** 書体の名前（CSS に入れても崩れない文字だけ）。 */
export function fontName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  // 最初の書体の名前の、文字・数字・空白・点・ハイフンが続く所だけを使う（CSS を壊す文字の後ろは捨てる）
  const m = /^[\p{L}\p{N} ._+-]+/u.exec(v.split(',')[0]!.replace(/^[\s"']+/, ''));
  const s = (m?.[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || fallback;
}

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (v: unknown, fallback: string, max = 200) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : fallback);

/**
 * 外から来た値（推論の答え・取り込んだファイル）を、決まった形に直す。足りない所は `base` で埋め、読めることを確かめる。
 *
 * @returns 直した値と、直したことの添え書き
 */
export function normalizeDesign(v: unknown, base: CompanyDesignTokens = DEFAULT_DESIGN): { tokens: CompanyDesignTokens; notes: string[] } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const c = (o['colors'] && typeof o['colors'] === 'object' ? o['colors'] : {}) as Record<string, unknown>;
  const t = (o['typography'] && typeof o['typography'] === 'object' ? o['typography'] : {}) as Record<string, unknown>;
  const s = (o['shape'] && typeof o['shape'] === 'object' ? o['shape'] : {}) as Record<string, unknown>;
  const color = (k: keyof CompanyDesignTokens['colors']) => toHex(c[k]) ?? base.colors[k];
  const colors = {
    primary: color('primary'), onPrimary: color('onPrimary'), secondary: color('secondary'), accent: color('accent'), background: color('background'),
    surface: color('surface'), text: color('text'), muted: color('muted'), border: color('border'), link: color('link'),
  };
  const notes: string[] = [];
  // 読めることを守る（本文・薄い文字・リンクは背景に、ボタンの文字は主の色に。第46.2節）
  const fix = (k: 'text' | 'muted' | 'link', min: number, label: string) => {
    const r = readableOn(colors[k], colors.background, min);
    if (r.fixed) { colors[k] = r.color; notes.push(`${label}が背景に対して読みにくいので、濃さを直しました`); }
  };
  fix('text', MIN_TEXT_CONTRAST, '本文の色');
  fix('link', MIN_TEXT_CONTRAST, 'リンクの色');
  fix('muted', 3, '薄い文字の色');
  const on = readableOn(colors.onPrimary, colors.primary);
  if (on.fixed) {
    const white = contrast('#ffffff', colors.primary) >= contrast('#000000', colors.primary) ? '#ffffff' : '#000000';
    colors.onPrimary = contrast(white, colors.primary) >= MIN_TEXT_CONTRAST ? white : on.color;
    notes.push('ボタンの文字が読みにくいので、色を直しました');
  }
  const button = s['button'] === 'square' || s['button'] === 'pill' || s['button'] === 'rounded' ? s['button'] : base.shape.button;
  return {
    tokens: {
      colors,
      typography: {
        headingJa: fontName(t['headingJa'], base.typography.headingJa), bodyJa: fontName(t['bodyJa'], base.typography.bodyJa), latin: fontName(t['latin'], base.typography.latin),
        baseSize: Math.round(num(t['baseSize'], 12, 22, base.typography.baseSize)), scale: Math.round(num(t['scale'], 1.05, 1.8, base.typography.scale) * 100) / 100,
        headingWeight: Math.round(num(t['headingWeight'], 300, 900, base.typography.headingWeight) / 100) * 100,
        bodyWeight: Math.round(num(t['bodyWeight'], 300, 700, base.typography.bodyWeight) / 100) * 100,
      },
      shape: {
        radiusSmall: Math.round(num(s['radiusSmall'], 0, 24, base.shape.radiusSmall)), radiusMedium: Math.round(num(s['radiusMedium'], 0, 32, base.shape.radiusMedium)),
        radiusLarge: Math.round(num(s['radiusLarge'], 0, 48, base.shape.radiusLarge)), spacing: Math.round(num(s['spacing'], 4, 40, base.shape.spacing)),
        shadow: typeof s['shadow'] === 'boolean' ? s['shadow'] : base.shape.shadow, button,
      },
      imagery: text(o['imagery'], base.imagery),
      voice: text(o['voice'], base.voice),
    },
    notes,
  };
}

/** CSS の書体の並び（和文を先に、欧文を後に。最後に端末の書体）。 */
export function fontStack(ja: string, latin: string): string {
  const q = (f: string) => (/^[\w-]+$/.test(f) ? f : `"${f}"`);
  return [...new Set([latin, ja])].filter(Boolean).map(q).concat(['"Hiragino Sans"', '"Yu Gothic"', 'sans-serif']).join(', ');
}
