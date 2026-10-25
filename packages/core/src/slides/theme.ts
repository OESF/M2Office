/**
 * @file Google スライドのテーマ（本人が選んだプレゼンテーションのマスターとレイアウト）を読み、組み立てに使う形にする
 * （仕様書 第9.4.2節「Google スライドのテーマを使う・PowerPoint の取り出し」、Q-265、ADR-0109）。
 *
 * テンプレート ギャラリーそのものを開く API は無いため、本人がギャラリーから作ったファイルを選んでもらい、その中のテーマを使う。
 * 背景・飾り・字体はテーマのまま（ページはテーマのレイアウトで作る）。M2Office が描く図は、テーマの配色と字体で描く。
 * Google には触らず、読んだプレゼンテーションの JSON だけから決める（テストできるように）。
 */

import type { SlideDesign, SlideRgb } from '@m2office/shared';

/** テーマを読むのに要る項目（Slides API の `fields`）。 */
export const THEME_FIELDS = 'pageSize,'
  + 'masters(objectId,pageProperties(colorScheme,pageBackgroundFill),pageElements(shape(placeholder,text(textElements(textRun(style(fontFamily))))))),'
  + 'layouts(objectId,layoutProperties,pageElements(objectId,size,transform,shape(placeholder)))';

/** テーマのファイルを開けない（共有が外れた・消された・本人がまだ選んでいない）。呼ぶ側は標準の見た目にして注意を残す。 */
export class SlideThemeUnavailableError extends Error {}

/** 置く場所（インチ。既定の大きさ 10 × 5.625 での値）。 */
export interface ThemeBox { x: number; y: number; w: number; h: number }

/** テーマのレイアウト 1 つ。 */
export interface ThemeLayout {
  objectId: string;
  /** 枠（プレースホルダー）の種類と番号。ページを作るときに、枠ごとに ID を決めて文を入れる・消す。 */
  placeholders: { type: string; index: number }[];
  /** 題名の枠の場所（あれば）。 */
  title?: ThemeBox;
}

/** 組み立てに使うテーマ。 */
export interface ThemeLook {
  /** 図を描く色と字体（組み込みのデザインと同じ形）。 */
  design: SlideDesign;
  /** 使うレイアウト。見つからないものは無い（白紙に M2Office の置き方で描く）。 */
  layouts: { title?: ThemeLayout; section?: ThemeLayout; titleOnly?: ThemeLayout; blank?: ThemeLayout };
  /** 本文の図を置き始める高さ（インチ。題名の枠の下）。 */
  contentTop: number;
}

/** 文を入れない枠（テーマのまま残す）。 */
export const KEEP_PLACEHOLDERS = new Set(['SLIDE_NUMBER', 'FOOTER', 'DATE_AND_TIME', 'SLIDE_IMAGE']);

type Rgb = SlideRgb;
type Json = Record<string, any>;
const EMU_PER_INCH = 914_400;

const rgb = (c: Json | undefined): Rgb | null =>
  (c ? { red: Number(c['red'] ?? 0), green: Number(c['green'] ?? 0), blue: Number(c['blue'] ?? 0) } : null);
/** 明るさ（0〜1。WCAG の相対輝度）。 */
const luminance = (c: Rgb) => {
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c.red) + 0.7152 * f(c.green) + 0.0722 * f(c.blue);
};
/** 2 つの色の見分けやすさ（コントラスト比）。 */
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
/** a を b へ t だけ寄せた色。 */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  red: a.red + (b.red - a.red) * t, green: a.green + (b.green - a.green) * t, blue: a.blue + (b.blue - a.blue) * t,
});

/** レイアウトの枠を読む。 */
function layoutOf(l: Json, page: { width: number; height: number }): ThemeLayout {
  const placeholders: { type: string; index: number }[] = [];
  let title: ThemeBox | undefined;
  for (const el of (l['pageElements'] as Json[] | undefined) ?? []) {
    const ph = el['shape']?.['placeholder'] as Json | undefined;
    if (!ph?.['type']) continue;
    placeholders.push({ type: String(ph['type']), index: Number(ph['index'] ?? 0) });
    if ((ph['type'] === 'TITLE' || ph['type'] === 'CENTERED_TITLE') && !title && el['size'] && el['transform']) {
      const t = el['transform'] as Json;
      const s = el['size'] as Json;
      const sx = 10 / (page.width / EMU_PER_INCH);
      const sy = 5.625 / (page.height / EMU_PER_INCH);
      title = {
        x: (Number(t['translateX'] ?? 0) / EMU_PER_INCH) * sx,
        y: (Number(t['translateY'] ?? 0) / EMU_PER_INCH) * sy,
        w: ((Number(s['width']?.['magnitude'] ?? 0) * Number(t['scaleX'] ?? 1)) / EMU_PER_INCH) * sx,
        h: ((Number(s['height']?.['magnitude'] ?? 0) * Number(t['scaleY'] ?? 1)) / EMU_PER_INCH) * sy,
      };
    }
  }
  return { objectId: String(l['objectId']), placeholders, ...(title ? { title } : {}) };
}

/** 文を入れる枠の種類（残す枠を除く）。 */
const textTypes = (l: ThemeLayout) => new Set(l.placeholders.map((p) => p.type).filter((t) => !KEEP_PLACEHOLDERS.has(t)));

/** テーマの枠の字体（題名と本文）。 */
function fontsOf(master: Json | undefined): { heading: string | null; body: string | null } {
  const found: { heading: string | null; body: string | null } = { heading: null, body: null };
  for (const el of (master?.['pageElements'] as Json[] | undefined) ?? []) {
    const type = el['shape']?.['placeholder']?.['type'];
    const font = ((el['shape']?.['text']?.['textElements'] as Json[] | undefined) ?? [])
      .map((t) => t['textRun']?.['style']?.['fontFamily'] as string | undefined).find((f) => !!f) ?? null;
    if (!font) continue;
    if ((type === 'TITLE' || type === 'CENTERED_TITLE') && !found.heading) found.heading = font;
    if (type === 'BODY' && !found.body) found.body = font;
  }
  return found;
}

/**
 * プレゼンテーション（{@link THEME_FIELDS} で読んだもの）から、組み立てに使うテーマを決める。
 *
 * @param pres Slides API の `presentations.get` の応答
 * @param name テーマの名前（デザインの名前として結果に出す）
 */
export function readTheme(pres: Json, name: string): ThemeLook {
  const page = {
    width: Number(pres['pageSize']?.['width']?.['magnitude'] ?? 9_144_000) || 9_144_000,
    height: Number(pres['pageSize']?.['height']?.['magnitude'] ?? 5_143_500) || 5_143_500,
  };
  const master = (pres['masters'] as Json[] | undefined)?.[0];
  // 配色（LIGHT1・DARK1・ACCENT1〜6 など）
  const scheme = new Map<string, Rgb>();
  for (const c of (master?.['pageProperties']?.['colorScheme']?.['colors'] as Json[] | undefined) ?? []) {
    const v = rgb(c['color']);
    if (c['type'] && v) scheme.set(String(c['type']), v);
  }
  const white: Rgb = { red: 1, green: 1, blue: 1 };
  const black: Rgb = { red: 0.13, green: 0.13, blue: 0.13 };
  const fill = master?.['pageProperties']?.['pageBackgroundFill']?.['solidFill']?.['color'] as Json | undefined;
  const background = (fill?.['themeColor'] ? scheme.get(String(fill['themeColor'])) : rgb(fill?.['rgbColor'])) ?? scheme.get('LIGHT1') ?? white;
  // 文字は背景と見分けやすいほう（暗い背景のテーマでは明るい色）
  const candidates = [scheme.get('DARK1') ?? black, scheme.get('LIGHT1') ?? white, black, white];
  const text = candidates.reduce((best, c) => (contrast(c, background) > contrast(best, background) ? c : best));
  // 強調の色は、背景と見分けられる最初のアクセント
  const accents = ['ACCENT1', 'ACCENT2', 'ACCENT3', 'ACCENT4', 'ACCENT5', 'ACCENT6'].map((k) => scheme.get(k)).filter((c): c is Rgb => !!c);
  const accent = accents.find((c) => contrast(c, background) >= 2.2) ?? accents[0] ?? text;
  const fonts = fontsOf(master);
  const design: SlideDesign = {
    id: 'theme', name, description: '',
    background, text, muted: mix(text, background, 0.35), accent, accentLight: mix(accent, background, 0.82),
    cover: { background, title: accent, subtitle: mix(text, background, 0.35), style: 'line' },
    // 字体が読めなければ日本語の字体（Google スライドの一覧にあるもの）
    font: { heading: fonts.heading ?? 'Noto Sans JP', body: fonts.body ?? fonts.heading ?? 'Noto Sans JP' },
    rule: false,
    imageStyle: `${luminance(background) < 0.3 ? '暗い背景に映える' : '明るく落ち着いた'}写真風。配色に合う、余白のある画面`,
  };

  const layouts = ((pres['layouts'] as Json[] | undefined) ?? []).map((l) => ({ l: layoutOf(l, page), name: String(l['layoutProperties']?.['name'] ?? ''), display: String(l['layoutProperties']?.['displayName'] ?? '') }));
  const byName = (n: string) => layouts.find((x) => x.name === n)?.l;
  const has = (l: ThemeLayout, ...types: string[]) => types.every((t) => textTypes(l).has(t));
  const title = byName('TITLE')
    ?? layouts.find((x) => has(x.l, 'CENTERED_TITLE'))?.l
    ?? layouts.find((x) => has(x.l, 'TITLE', 'SUBTITLE'))?.l;
  const section = byName('SECTION_HEADER')
    ?? layouts.find((x) => /section|セクション/i.test(x.display) && has(x.l, 'TITLE'))?.l;
  const titleOnly = byName('TITLE_ONLY')
    ?? layouts.find((x) => { const t = textTypes(x.l); return t.size === 1 && t.has('TITLE'); })?.l;
  const blank = byName('BLANK') ?? layouts.find((x) => textTypes(x.l).size === 0)?.l;
  // 図は題名の枠の下から置く（題名の大きいテーマで重ならないように）
  const titleBottom = titleOnly?.title ? titleOnly.title.y + titleOnly.title.h : 1.3;
  const contentTop = Math.min(2, Math.max(1.0, titleBottom + 0.12));
  return {
    design,
    layouts: { ...(title ? { title } : {}), ...(section ? { section } : {}), ...(titleOnly ? { titleOnly } : {}), ...(blank ? { blank } : {}) },
    contentTop,
  };
}
