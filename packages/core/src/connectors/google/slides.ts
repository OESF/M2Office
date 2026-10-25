/**
 * @file Google スライドの接続口（仕様書 第9.4.2節「標準の見た目」、第14.3.4節）。
 *
 * テンプレートのファイルを使わず、Slides API で空のプレゼンテーションを作ってから、
 * レイアウトごとに決めた位置へ図形と文字を置く。M2Office が作ったファイルしか触らないため、権限は `drive.file` だけで足りる。
 * LLM は内容と構成だけを決め、位置や色はここで決める（ADR-0006）。共有はしない。
 * 色・字体・表紙の飾りは、組み込みのデザイン（`SLIDE_DESIGNS`。第9.4.2節「組み込みのデザイン」）で切り替える。
 */

import { DEFAULT_SLIDE_DESIGN_ID, findSlideDesign, type SlideDesign, type SlideRgb } from '@m2office/shared';
import { drawInfographic, onColor, type ShapeKind, type SlideDraw, type TextStyle } from './slide-infographics.js';

import { SlidePlanError, isStandardLayout, type SlidePlan, type SlideSpec } from '../../slides/plan.js';
import { TEMPLATE_FIELDS, describeTemplate, type SlidesPresentation, type TemplateManifest } from '../../slides/template.js';
import { ConnectorUnavailableError } from '../types.js';
import type { ConnectorPrincipal, SlidesConnector } from '../types.js';
import { callGoogle, type GoogleApiEndpoints, type GoogleTokenSource } from './http.js';

/** 呼び出しに使うもの。接続口の組み立てより後に決まるため、呼ぶたびに引く。 */
type Ctx = () => { tokens: GoogleTokenSource; endpoints: GoogleApiEndpoints };

/** 1 インチの EMU。Slides API の長さの単位。 */
const EMU_PER_INCH = 914_400;

/** 既定の大きさ（16:9、10 × 5.625 インチ）。位置はこの大きさで決め、実際の大きさに合わせて伸び縮みさせる。 */
const BASE = { width: 10 * EMU_PER_INCH, height: 5.625 * EMU_PER_INCH };

/** 表（`CHART` の代わり）に載せる項目の上限。多いとページからはみ出す。 */
export const TABLE_ROWS_MAX = 8;

/** 出典のページに載せる件数の上限。 */
export const SOURCES_MAX = 10;

type Rgb = SlideRgb;

/** 組み立ての後に画像を貼る場所（URL は貼るときに入れる）。 */
export interface ImagePlacement {
  /** 画像の場所の名前（`cover`・`m2slide<n>`・`m2slide<n>_pie`）。 */
  key: string;
  objectId: string;
  elementProperties: Record<string, unknown>;
}

/** 画像を Google から読める URL で渡す手段（使い捨て。貼り終えたら `done` で消す。第9.4.2節「段 2」）。 */
export type PublishImage = (bytes: Uint8Array, mimeType: string) => Promise<{ url: string; done(): Promise<void> }>;

/** 既定のデザイン（ビジネス）。 */
const DEFAULT_DESIGN = findSlideDesign(DEFAULT_SLIDE_DESIGN_ID)!;
type Request = Record<string, unknown>;
/** 置く場所（インチ。既定の大きさでの値）。 */
type Box = { x: number; y: number; w: number; h: number };

/**
 * 構成から、Slides API の一括更新の要求を作る。
 *
 * @param plan 検証済みの構成（`normalizeSlidePlan` を通したもの）
 * @param page 作ったプレゼンテーションの大きさ（EMU）
 * @param initialSlide 作ったときに入っている 1 枚目。最後に消す
 * @param o.design 組み込みのデザイン（無ければ既定の「ビジネス」）
 * @param o.footer 表紙と各ページの下の隅に出す会社名（無ければ出さない）
 * @param o.images 用意できた画像の場所の名前（`cover`・`m2slide<n>`・`m2slide<n>_pie`）。あるものだけ、画像の場所を空けて組む
 * @returns 要求の並び、ページ数、注意（切り詰めたことなど。黙って捨てない）、ページごとの発表者のメモ（ページの ID → 文）、
 *   画像を貼る場所（組み立ての後に、画像の URL を入れて貼る）
 */
export function slideRequests(
  plan: SlidePlan, page: { width: number; height: number }, initialSlide: string | null,
  o: { design?: SlideDesign; footer?: string; images?: ReadonlySet<string> } = {},
): { requests: Request[]; pages: number; warnings: string[]; notes: Record<string, string>; placements: ImagePlacement[] } {
  const sx = page.width / BASE.width;
  const sy = page.height / BASE.height;
  const requests: Request[] = [];
  const warnings: string[] = [];
  const d = o.design ?? DEFAULT_DESIGN;
  const COLOR = { accent: d.accent, accentLight: d.accentLight, text: d.text, muted: d.muted };
  const footer = (o.footer ?? '').trim().slice(0, 40);

  const at = (pageObjectId: string, b: Box) => ({
    pageObjectId,
    size: { width: { magnitude: Math.round(b.w * EMU_PER_INCH * sx), unit: 'EMU' }, height: { magnitude: Math.round(b.h * EMU_PER_INCH * sy), unit: 'EMU' } },
    transform: { scaleX: 1, scaleY: 1, translateX: Math.round(b.x * EMU_PER_INCH * sx), translateY: Math.round(b.y * EMU_PER_INCH * sy), unit: 'EMU' },
  });
  const style = (objectId: string, s: { size?: number; bold?: boolean; color?: Rgb; font?: string }, range: Request = { type: 'ALL' }) => {
    const st: Record<string, unknown> = {};
    const fields: string[] = [];
    if (s.size) { st['fontSize'] = { magnitude: s.size, unit: 'PT' }; fields.push('fontSize'); }
    if (s.font) { st['fontFamily'] = s.font; fields.push('fontFamily'); }
    if (s.bold !== undefined) { st['bold'] = s.bold; fields.push('bold'); }
    if (s.color) { st['foregroundColor'] = { opaqueColor: { rgbColor: s.color } }; fields.push('foregroundColor'); }
    requests.push({ updateTextStyle: { objectId, style: st, textRange: range, fields: fields.join(',') } });
  };
  const text = (objectId: string, value: string) => {
    if (value) requests.push({ insertText: { objectId, text: value, insertionIndex: 0 } });
  };
  /** 文字の枠。塗りがあれば角の丸い四角にし、文字を上下の中央に置く。 */
  const box = (
    id: string, slide: string, b: Box, value: string,
    o: { size: number; bold?: boolean; color?: Rgb; fill?: Rgb; center?: boolean; bullets?: boolean },
  ) => {
    requests.push({ createShape: { objectId: id, shapeType: o.fill ? 'ROUND_RECTANGLE' : 'TEXT_BOX', elementProperties: at(slide, b) } });
    if (o.fill) {
      requests.push({
        updateShapeProperties: {
          objectId: id,
          shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: o.fill } } }, outline: { propertyState: 'NOT_RENDERED' }, contentAlignment: 'MIDDLE' },
          fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState,contentAlignment',
        },
      });
    }
    if (!value) return;
    text(id, value);
    style(id, { size: o.size, bold: o.bold ?? false, color: o.color ?? COLOR.text, font: d.font.body });
    if (o.center) requests.push({ updateParagraphStyle: { objectId: id, style: { alignment: 'CENTER' }, textRange: { type: 'ALL' }, fields: 'alignment' } });
    if (o.bullets) requests.push({ createParagraphBullets: { objectId: id, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
  };
  /** ページの背景を塗る。 */
  const background = (slide: string, color: Rgb) => {
    requests.push({
      updatePageProperties: {
        objectId: slide, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: color } } } }, fields: 'pageBackgroundFill.solidFill.color',
      },
    });
  };
  /** 飾りの図形（枠の線なし）。 */
  const shape = (id: string, slide: string, b: Box, kind: 'RECTANGLE' | 'ELLIPSE', fill: Rgb) => {
    requests.push({ createShape: { objectId: id, shapeType: kind, elementProperties: at(slide, b) } });
    requests.push({
      updateShapeProperties: {
        objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: fill } } }, outline: { propertyState: 'NOT_RENDERED' } },
        fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState',
      },
    });
  };
  /** 画像を貼る場所（第9.4.2節「段 2」）。 */
  const placements: ImagePlacement[] = [];
  const image = (key: string, slide: string, b: Box): boolean => {
    if (!o.images?.has(key)) return false;
    placements.push({ key, objectId: `${key}_img`, elementProperties: at(slide, b) });
    return true;
  };
  /** 図のレイアウトを描く道具（第9.4.2節「プレゼンテーションの表現」）。 */
  const g: SlideDraw = {
    image,
    design: d,
    shape: (id: string, slide: string, b: Box, kind: ShapeKind, fill: Rgb | null, value?: string, st?: TextStyle) => {
      requests.push({ createShape: { objectId: id, shapeType: kind, elementProperties: at(slide, b) } });
      const props: Record<string, unknown> = {};
      const fields: string[] = [];
      if (fill) { props['shapeBackgroundFill'] = { solidFill: { color: { rgbColor: fill } } }; fields.push('shapeBackgroundFill.solidFill.color'); }
      if (kind !== 'TEXT_BOX') { props['outline'] = { propertyState: 'NOT_RENDERED' }; fields.push('outline.propertyState'); }
      if (st?.valign) { props['contentAlignment'] = st.valign; fields.push('contentAlignment'); }
      if (fields.length) requests.push({ updateShapeProperties: { objectId: id, shapeProperties: props, fields: fields.join(',') } });
      if (!value || !st) return;
      text(id, value);
      style(id, { size: st.size, bold: st.bold ?? false, color: st.color ?? COLOR.text, font: st.heading ? d.font.heading : d.font.body });
      if (st.align && st.align !== 'START') requests.push({ updateParagraphStyle: { objectId: id, style: { alignment: st.align }, textRange: { type: 'ALL' }, fields: 'alignment' } });
    },
    restyle: (id: string, start: number, end: number, st: TextStyle) => {
      if (end <= start) return;
      style(id, { size: st.size, bold: st.bold ?? false, ...(st.color ? { color: st.color } : {}), ...(st.heading ? { font: d.font.heading } : {}) }, { type: 'FIXED_RANGE', startIndex: start, endIndex: end });
    },
    bullets: (id: string, from = 0) => {
      requests.push({ createParagraphBullets: { objectId: id, textRange: from > 0 ? { type: 'FROM_START_INDEX', startIndex: from } : { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    },
  };
  /** 題名の無いページ（大きな一文・区切り）を足す。 */
  const blank = (id: string, color: Rgb) => {
    requests.push({ createSlide: { objectId: id, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
    background(id, color);
  };
  /** 発表者のメモ（ページの ID → 文）。組み立ての後に、メモの枠の ID を読んで入れる。 */
  const notes: Record<string, string> = {};
  /** 下の隅の会社名（右の半分に画像があるページは左の隅）。 */
  const footerText = (slide: string, color: Rgb, left = false) => {
    if (!footer) return;
    box(`${slide}_f`, slide, { x: left ? 0.6 : 5.5, y: 5.28, w: 4, h: 0.3 }, footer, { size: 9, color });
    if (!left) requests.push({ updateParagraphStyle: { objectId: `${slide}_f`, style: { alignment: 'END' }, textRange: { type: 'ALL' }, fields: 'alignment' } });
  };
  /** 右の半分の画像の場所（3:4。表紙と区切り）。 */
  const RIGHT_IMAGE: Box = { x: 5.78, y: 0, w: 4.22, h: 5.625 };
  /** 題名だけの型のスライドを足し、題名を入れる。背景・題名の色と字体・題名の下の線・下の隅の会社名をデザインに合わせる。 */
  const titled = (id: string, title: string) => {
    requests.push({
      createSlide: {
        objectId: id, slideLayoutReference: { predefinedLayout: 'TITLE_ONLY' },
        placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: `${id}_t` }],
      },
    });
    background(id, d.background);
    text(`${id}_t`, title);
    // 見出しは言い切りの 1 文（30 文字まで）。1 行に収まる大きさにする
    if (title) style(`${id}_t`, { size: 20, bold: true, color: COLOR.accent, font: d.font.heading });
    if (d.rule) shape(`${id}_rl`, id, { x: 0.5, y: 1.18, w: 9, h: 0.03 }, 'RECTANGLE', COLOR.accent);
    footerText(id, COLOR.muted);
  };

  // 表紙。象徴的な画像があれば右の半分に置き、題名と副題は左に（第9.4.2節「段 2」）
  if (plan.notes) notes['m2cover'] = plan.notes;
  if (image('cover', 'm2cover', RIGHT_IMAGE)) {
    requests.push({ createSlide: { objectId: 'm2cover', slideLayoutReference: { predefinedLayout: 'BLANK' } } });
    background('m2cover', d.cover.background);
    if (d.cover.style === 'band') shape('m2cover_band', 'm2cover', { x: 0, y: 0, w: 0.35, h: 5.625 }, 'RECTANGLE', COLOR.accent);
    if (d.cover.style === 'line' || d.cover.style === 'corner') shape('m2cover_line', 'm2cover', { x: 0.7, y: 1.3, w: 1, h: 0.06 }, 'RECTANGLE', COLOR.accent);
    g.shape('m2cover_t', 'm2cover', { x: 0.7, y: 1.5, w: 4.8, h: 1.9 }, 'TEXT_BOX', null, plan.title, { size: 30, bold: true, heading: true, color: d.cover.title, valign: 'BOTTOM' });
    if (plan.subtitle) g.shape('m2cover_s', 'm2cover', { x: 0.7, y: 3.5, w: 4.8, h: 0.9 }, 'TEXT_BOX', null, plan.subtitle, { size: 15, color: d.cover.subtitle });
    footerText('m2cover', d.cover.subtitle, true);
  } else {
    requests.push({
      createSlide: {
        objectId: 'm2cover', slideLayoutReference: { predefinedLayout: 'TITLE' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'CENTERED_TITLE', index: 0 }, objectId: 'm2cover_t' },
          { layoutPlaceholder: { type: 'SUBTITLE', index: 0 }, objectId: 'm2cover_s' },
        ],
      },
    });
    background('m2cover', d.cover.background);
    // 表紙の飾り（帯・線・角・全面）。全面は背景の色だけで表す
    if (d.cover.style === 'band') shape('m2cover_band', 'm2cover', { x: 0, y: 0, w: 0.35, h: 5.625 }, 'RECTANGLE', COLOR.accent);
    // 線は題名の上に短く置く（題名の下は副題の枠と重なるため）
    if (d.cover.style === 'line') shape('m2cover_line', 'm2cover', { x: 4.5, y: 1.0, w: 1, h: 0.06 }, 'RECTANGLE', COLOR.accent);
    if (d.cover.style === 'corner') {
      shape('m2cover_c1', 'm2cover', { x: 8.2, y: -1, w: 2.6, h: 2.6 }, 'ELLIPSE', COLOR.accentLight);
      shape('m2cover_c2', 'm2cover', { x: -1, y: 4, w: 2.6, h: 2.6 }, 'ELLIPSE', COLOR.accent);
    }
    text('m2cover_t', plan.title);
    if (plan.title) style('m2cover_t', { bold: true, color: d.cover.title, font: d.font.heading });
    if (plan.subtitle) {
      text('m2cover_s', plan.subtitle);
      style('m2cover_s', { color: d.cover.subtitle, font: d.font.body });
    } else requests.push({ deleteObject: { objectId: 'm2cover_s' } });
    footerText('m2cover', d.cover.subtitle);
  }

  // 本文のスライド。中身は題名の下から、伝えたいこと（takeaway）の帯の上まで
  const content: Box = { x: 0.5, y: 1.45, w: 9, h: 3.7 };
  plan.slides.forEach((s: SlideSpec, i) => {
    // Slides API はオブジェクトの ID に 5 文字以上を求める（短いと 400。AI Radio での知見）
    const id = `m2slide${i + 1}`;
    if (s.notes) notes[id] = s.notes;
    if (s.layout === 'STATEMENT') {
      // 大きな一文だけを中央に
      blank(id, d.background);
      g.shape(`${id}_bar`, id, { x: 4.6, y: 1.35, w: 0.8, h: 0.06 }, 'RECTANGLE', COLOR.accent);
      g.shape(`${id}_m`, id, { x: 0.9, y: 1.6, w: 8.2, h: 1.9 }, 'TEXT_BOX', null, s.message ?? s.title, { size: 32, bold: true, heading: true, color: COLOR.accent, align: 'CENTER', valign: 'MIDDLE' });
      if (s.sub) g.shape(`${id}_s`, id, { x: 1.2, y: 3.6, w: 7.6, h: 0.6 }, 'TEXT_BOX', null, s.sub, { size: 16, color: COLOR.muted, align: 'CENTER' });
      footerText(id, COLOR.muted);
      return;
    }
    if (s.layout === 'SECTION') {
      // 区切り。強調の色で塗り、番号と章の名前を大きく
      blank(id, COLOR.accent);
      const fg = onColor(COLOR.accent);
      // 象徴的な画像があれば右の半分に（第9.4.2節「段 2」）
      const w = image(id, id, RIGHT_IMAGE) ? 4.6 : 8.4;
      if (s.number) g.shape(`${id}_n`, id, { x: 0.8, y: 1.3, w: 3, h: 1.2 }, 'TEXT_BOX', null, s.number, { size: 60, bold: true, heading: true, color: fg, valign: 'BOTTOM' });
      g.shape(`${id}_t`, id, { x: 0.8, y: 2.55, w, h: 1.2 }, 'TEXT_BOX', null, s.title, { size: w < 5 ? 30 : 36, bold: true, heading: true, color: fg, valign: 'TOP' });
      if (s.sub) g.shape(`${id}_s`, id, { x: 0.8, y: 3.75, w, h: 0.6 }, 'TEXT_BOX', null, s.sub, { size: 16, color: fg });
      return;
    }
    titled(id, s.title);
    const area = s.takeaway ? { ...content, h: 3.15 } : content;
    if (drawInfographic(g, s, id, area)) {
      // 図のレイアウト（第9.4.2節「プレゼンテーションの表現」）
    } else if (s.layout === 'BULLET') {
      box(`${id}_b`, id, area, s.body ?? '', { size: 20, bullets: true });
    } else if (s.layout === 'TABLE' || s.layout === 'CHART') {
      const cats = s.chartCategories ?? [];
      const rows = Math.min(cats.length, TABLE_ROWS_MAX);
      requests.push(...tableRequests(`${id}_tbl`, at(id, { ...area, h: Math.min(area.h, 0.4 * (rows + 1)) }), s, `${i + 1} 枚目`, warnings, d));
    } else if (s.layout === 'IMAGE') {
      // 画像（16:9）を大きく、説明を下に。画像が用意できなければ説明だけ（第9.4.2節「段 2」）
      if (image(id, id, { x: 1.8, y: 1.35, w: 6.4, h: 3.6 })) {
        if (s.caption ?? s.body) box(`${id}_c`, id, { x: 0.5, y: 4.98, w: 9, h: 0.35 }, s.caption ?? s.body ?? '', { size: 14, center: true, color: COLOR.muted });
      } else {
        box(`${id}_c`, id, area, s.caption ?? s.body ?? '', { size: 20, center: true, color: COLOR.muted });
      }
    } else {
      // 会社のテンプレートの見本の名前で構成されたが、テンプレートを使えなかった。値を箇条書きにして失わない
      box(`${id}_b`, id, area, Object.values(s.values ?? {}).filter(Boolean).join('\n'), { size: 16, bullets: true });
    }
    if (s.takeaway) {
      box(`${id}_w`, id, { x: 0.5, y: 4.7, w: 9, h: 0.5 }, s.takeaway, { size: 14, bold: true, color: COLOR.accent, fill: COLOR.accentLight });
    }
  });

  // 出典のページ（出典が無ければ足さない）
  const sources = plan.sources ?? [];
  let pages = plan.slides.length + 1;
  if (sources.length > 0) {
    if (sources.length > SOURCES_MAX) warnings.push(`出典のページには ${SOURCES_MAX} 件まで載せました（${sources.length} 件）`);
    const shown = sources.slice(0, SOURCES_MAX);
    const lines = shown.map((x, k) => `${k + 1}. ${x.title}`);
    titled('m2src', '出典');
    box('m2src_b', 'm2src', { x: 0.5, y: 1.35, w: 9, h: 3.9 }, lines.join('\n'), { size: 11, color: COLOR.muted });
    // 題名に、出典のリンクを付ける。http・https のものだけ（ほかの形のリンクは作らない）
    let start = 0;
    shown.forEach((x, k) => {
      const line = lines[k]!;
      if (x.url && /^https?:\/\//i.test(x.url)) {
        requests.push({ updateTextStyle: { objectId: 'm2src_b', textRange: { type: 'FIXED_RANGE', startIndex: start, endIndex: start + line.length }, style: { link: { url: x.url } }, fields: 'link' } });
      }
      start += line.length + 1;
    });
    pages += 1;
  }
  if (initialSlide) requests.push({ deleteObject: { objectId: initialSlide } });
  return { requests, pages, warnings, notes, placements };
}

/**
 * 表（`CHART` の代わり）を置く要求。項目は {@link TABLE_ROWS_MAX} 行まで。
 *
 * @param elementProperties 置く場所（Slides API の形）
 * @param where 注意に書く場所（例: 3 枚目）
 */
function tableRequests(
  tid: string, elementProperties: Record<string, unknown>, s: SlideSpec, where: string, warnings: string[], design: SlideDesign = DEFAULT_DESIGN,
): Request[] {
  const COLOR = { accent: design.accent, accentLight: design.accentLight, text: design.text };
  const cats = s.chartCategories ?? [];
  const series = s.chartSeries ?? [];
  if (cats.length === 0 || series.length === 0) return [];
  if (cats.length > TABLE_ROWS_MAX) warnings.push(`${where}の表は ${TABLE_ROWS_MAX} 行までにしました（${cats.length} 項目）`);
  const rows = Math.min(cats.length, TABLE_ROWS_MAX);
  const out: Request[] = [{ createTable: { objectId: tid, elementProperties, rows: rows + 1, columns: series.length + 1 } }];
  const cell = (r: number, c: number, v: string, head: boolean) => {
    if (!v) return;
    out.push({ insertText: { objectId: tid, cellLocation: { rowIndex: r, columnIndex: c }, text: v, insertionIndex: 0 } });
    out.push({
      updateTextStyle: {
        objectId: tid, cellLocation: { rowIndex: r, columnIndex: c }, textRange: { type: 'ALL' },
        style: { fontSize: { magnitude: 12, unit: 'PT' }, bold: head, fontFamily: design.font.body, foregroundColor: { opaqueColor: { rgbColor: head ? COLOR.accent : COLOR.text } } },
        fields: 'fontSize,bold,fontFamily,foregroundColor',
      },
    });
  };
  series.forEach((se, c) => cell(0, c + 1, se.name, true));
  cats.slice(0, rows).forEach((cat, r) => {
    cell(r + 1, 0, cat, true);
    series.forEach((se, c) => cell(r + 1, c + 1, (se.values[r] ?? 0).toLocaleString('ja-JP'), false));
  });
  out.push({
    updateTableCellProperties: {
      objectId: tid, tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: series.length + 1 },
      tableCellProperties: { tableCellBackgroundFill: { solidFill: { color: { rgbColor: COLOR.accentLight } } } },
      fields: 'tableCellBackgroundFill.solidFill.color',
    },
  });
  return out;
}

/**
 * 会社のテンプレートで組み立てる要求（仕様書 第9.4.2節「スライドのテンプレート」）。
 *
 * @param plan 検証済みの構成。すべてのスライドが見本の名前で書かれていること（{@link checkTemplatePlan}）
 * @param manifest 複製したデッキから読み取ったもの（ID は複製したデッキのもの）
 * @param deckValues マスターの変数の値（構成の `deck` と、会社名などの既定の値を合わせたもの）
 * @returns 要求の並びと注意
 *
 * @remarks
 * 見本のスライドを複製するとき、名前の目印・図の置き場所の要素に ID を決めて渡す（あとで消す・置き換えるため）。
 * 複製したスライドは複製元のすぐ後ろに入るため、構成の順に 1 枚ずつ先頭から並べ直し、最後に元のスライドをすべて消す。
 */
export function templateRequests(
  plan: SlidePlan, manifest: TemplateManifest, deckValues: Record<string, string>,
): { requests: Request[]; warnings: string[] } {
  const requests: Request[] = [];
  const warnings: string[] = [];
  const ids: string[] = [];
  plan.slides.forEach((s, i) => {
    const layout = manifest.layouts.find((l) => l.name === s.layout)!;
    const sid = `m2tpl${i + 1}`;
    ids.push(sid);
    const mapped = (orig: string) => `${sid}_e${layout.elementIds.indexOf(orig) + 1}`;
    requests.push({
      duplicateObject: { objectId: layout.id, objectIds: { [layout.id]: sid, ...Object.fromEntries(layout.elementIds.map((e) => [e, mapped(e)])) } },
    });
    const values = s.values ?? {};
    for (const slot of layout.slots) {
      for (const token of slot.tokens) {
        requests.push({ replaceAllText: { containsText: { text: token, matchCase: true }, replaceText: values[slot.key] ?? '', pageObjectIds: [sid] } });
      }
    }
    const unused = Object.keys(values).filter((k) => values[k] && !layout.slots.some((sl) => sl.key === k));
    if (unused.length > 0) warnings.push(`${i + 1} 枚目（${layout.name}）に差し込み口の無い値がありました: ${unused.join('・')}`);
    if (layout.nameMarkerId) requests.push({ deleteObject: { objectId: mapped(layout.nameMarkerId) } });
    if (layout.chartArea) {
      const a = layout.chartArea;
      if (s.chartSeries?.length) {
        for (const d of a.deleteIds) requests.push({ deleteObject: { objectId: mapped(d) } });
        requests.push(...tableRequests(`${sid}_tbl`, {
          pageObjectId: sid,
          size: { width: { magnitude: Math.round(a.w), unit: 'EMU' }, height: { magnitude: Math.round(a.h), unit: 'EMU' } },
          transform: { scaleX: 1, scaleY: 1, translateX: Math.round(a.x), translateY: Math.round(a.y), unit: 'EMU' },
        }, s, `${i + 1} 枚目`, warnings));
      } else {
        requests.push({ deleteObject: { objectId: mapped(a.deleteIds[0]!) } });
      }
    }
    // 画像の生成は後の段階。目印だけを消し、枠は飾りとして残す
    if (layout.imageArea) requests.push({ deleteObject: { objectId: mapped(layout.imageArea.deleteIds[0]!) } });
  });
  ids.forEach((sid, i) => requests.push({ updateSlidesPosition: { slideObjectIds: [sid], insertionIndex: i } }));
  for (const orig of manifest.slideIds) requests.push({ deleteObject: { objectId: orig } });
  for (const [key, tokens] of Object.entries(manifest.deckTokens)) {
    for (const token of tokens) requests.push({ replaceAllText: { containsText: { text: token, matchCase: true }, replaceText: deckValues[key] ?? '' } });
  }
  return { requests, warnings };
}

/**
 * 構成が会社のテンプレートで作れるかを確かめる。
 *
 * @returns `template` なら見本で作れる。`standard` なら標準のレイアウトだけで書かれている（標準の見た目で作る）
 * @throws {SlidePlanError} 見本に無い名前がある・標準のレイアウトと混ざっている
 */
export function checkTemplatePlan(plan: SlidePlan, manifest: TemplateManifest): 'template' | 'standard' {
  if (plan.slides.every((s) => isStandardLayout(s.layout))) return 'standard';
  const names = manifest.layouts.map((l) => l.name);
  const wrong = plan.slides.filter((s) => !names.includes(s.layout)).map((s) => s.layout);
  if (wrong.length > 0) {
    throw new SlidePlanError(`会社のテンプレートの見本に無いレイアウトです: ${[...new Set(wrong)].join('・')}。使える名前: ${names.join('・')}（標準のレイアウトと混ぜずに、見本の名前だけで構成してください）`);
  }
  return 'template';
}

/**
 * スライドの接続口を作る。
 *
 * @param ctx トークンと呼び先を返す
 */
export function googleSlides(ctx: Ctx): SlidesConnector {
  const slides = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'スライド', `${ctx().endpoints.slides}${path}`, init);
  const drive = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}${path}`, init);
  const links = (id: string) => ({
    url: `https://docs.google.com/presentation/d/${id}/edit`, pptxUrl: `https://docs.google.com/presentation/d/${id}/export/pptx`,
  });
  /** 作りかけを残さない。ごみ箱に移すだけで、消しはしない（本人が戻せる）。 */
  const discard = (p: ConnectorPrincipal, id: string) =>
    drive(p, `/files/${encodeURIComponent(id)}`, { method: 'PATCH', body: { trashed: true } }).catch(() => null);

  /**
   * テンプレートを読む。開けなければ、標準の見た目に切り替える理由を返す。
   *
   * @throws {ConnectorUnavailableError} 接続が無い・取り消されたなど（許可が足りないときを除く）
   */
  const read = async (p: ConnectorPrincipal, presentationId: string, name: string): Promise<TemplateManifest | { reason: string }> => {
    try {
      const pres = await slides(p, `/presentations/${encodeURIComponent(presentationId)}?fields=${encodeURIComponent(TEMPLATE_FIELDS)}`);
      if (!pres) return { reason: `会社のテンプレート「${name}」が見つかりませんでした。管理者に、登録した URL を確かめてもらってください` };
      return describeTemplate(pres as SlidesPresentation);
    } catch (err) {
      if (err instanceof ConnectorUnavailableError) {
        if (err.kind !== 'insufficient-scope') throw err;
        return { reason: `会社のテンプレート「${name}」を使う Google の許可がありません。個人設定の「Google 連携」で接続し直すと、次から会社のテンプレートで作ります` };
      }
      if (/HTTP 403/.test(err instanceof Error ? err.message : '')) {
        return { reason: `会社のテンプレート「${name}」を開けませんでした。ファイルが会社の中で共有されているかを、管理者に確かめてもらってください` };
      }
      throw err;
    }
  };

  /**
   * 画像を、本人のドライブに置いて一時的にリンクで読めるようにする（ローカルの形。Google から M2Office に届かないため。第9.4.2節「段 2」）。
   * 貼り終えたら `done` でファイルごと消す。会社がリンクでの共有を禁じていれば、Google が断る（呼ぶ側が注意にする）。
   */
  const driveTempImage = (p: ConnectorPrincipal): PublishImage => async (bytes, mimeType) => {
    const boundary = `m2office-${Math.random().toString(36).slice(2)}`;
    const head = new TextEncoder().encode([
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name: 'M2Office のスライドの画像（自動で消えます）', mimeType }),
      `--${boundary}`, `Content-Type: ${mimeType}`, '', '',
    ].join('\r\n'));
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const data = new Uint8Array(head.length + bytes.length + tail.length);
    data.set(head, 0);
    data.set(bytes, head.length);
    data.set(tail, head.length + bytes.length);
    const made = await callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.driveUpload}/files?uploadType=multipart&fields=id`, {
      method: 'POST', raw: { contentType: `multipart/related; boundary=${boundary}`, data },
    });
    const fileId = String(made?.['id'] ?? '');
    if (!fileId) throw new Error('画像をドライブに置けませんでした');
    const remove = () => drive(p, `/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).then(() => undefined).catch(() => undefined);
    try {
      await drive(p, `/files/${encodeURIComponent(fileId)}/permissions`, { method: 'POST', body: { type: 'anyone', role: 'reader' } });
    } catch (err) {
      await remove();
      throw err;
    }
    return { url: `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`, done: remove };
  };

  /**
   * 画像を貼る（組み立ての後。1 枚ずつ。貼れなかった画像は注意にして、スライドは残す）。
   *
   * @returns 注意
   */
  const placeImages = async (
    p: ConnectorPrincipal, id: string, placements: ImagePlacement[], images: Record<string, { bytes: Uint8Array; mimeType: string }>, publish: PublishImage | undefined,
  ): Promise<string[]> => {
    const warnings: string[] = [];
    for (const pl of placements) {
      const img = images[pl.key];
      if (!img) continue;
      let handle: Awaited<ReturnType<PublishImage>> | null = null;
      try {
        handle = await (publish ?? driveTempImage(p))(img.bytes, img.mimeType);
        await slides(p, `/presentations/${encodeURIComponent(id)}:batchUpdate`, {
          method: 'POST', body: { requests: [{ createImage: { objectId: pl.objectId, url: handle.url, elementProperties: pl.elementProperties } }] },
        });
      } catch (err) {
        warnings.push(`${pl.key === 'cover' ? '表紙' : pl.key.endsWith('_pie') ? '円グラフ' : 'ページ'}の画像を置けませんでした（${err instanceof Error ? err.message : String(err)}）`);
      } finally {
        await handle?.done().catch(() => undefined);
      }
    }
    return warnings;
  };

  /** 発表者のメモを入れる（ページの ID → 文）。メモの枠の ID は作った後にしか分からないため、読み直してから入れる。 */
  const writeNotes = async (p: ConnectorPrincipal, id: string, notes: Record<string, string>): Promise<string[]> => {
    if (Object.keys(notes).length === 0) return [];
    try {
      const read = await slides(p, `/presentations/${encodeURIComponent(id)}?fields=${encodeURIComponent('slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))')}`);
      const list = (read?.['slides'] as { objectId?: string; slideProperties?: { notesPage?: { notesProperties?: { speakerNotesObjectId?: string } } } }[] | undefined) ?? [];
      const inserts = list.flatMap((sl) => {
        const notesId = sl.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
        const text = sl.objectId ? notes[sl.objectId] : undefined;
        return notesId && text ? [{ insertText: { objectId: notesId, text, insertionIndex: 0 } }] : [];
      });
      if (inserts.length) await slides(p, `/presentations/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: { requests: inserts } });
      return [];
    } catch (err) {
      return [`発表者のメモを入れられませんでした（${err instanceof Error ? err.message : String(err)}）`];
    }
  };

  /** 標準の見た目で作る（第9.4.2節「標準の見た目」）。組み込みのデザインがあれば、その色・字体・飾りで。 */
  const standard = async (p: ConnectorPrincipal, input: {
    title: string; plan: SlidePlan; design?: SlideDesign | null; footer?: string;
    images?: Record<string, { bytes: Uint8Array; mimeType: string }>; publishImage?: PublishImage;
  }) => {
    const made = await slides(p, '/presentations', { method: 'POST', body: { title: input.title } });
    const id = String(made?.['presentationId'] ?? '');
    if (!id) throw new Error('スライドを作れませんでした');
    const size = made?.['pageSize'] as { width?: { magnitude?: number }; height?: { magnitude?: number } } | undefined;
    const page = { width: size?.width?.magnitude || BASE.width, height: size?.height?.magnitude || BASE.height };
    const first = (made?.['slides'] as { objectId?: string }[] | undefined)?.[0]?.objectId ?? null;
    const { requests, pages, warnings, notes, placements } = slideRequests(input.plan, page, first, {
      ...(input.design ? { design: input.design } : {}), ...(input.footer ? { footer: input.footer } : {}), images: new Set(Object.keys(input.images ?? {})),
    });
    try {
      await slides(p, `/presentations/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: { requests } });
    } catch (err) {
      await discard(p, id);
      throw new Error(`スライドを組み立てられませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 発表者のメモと画像（第9.4.2節「段 2」）。入れられなくてもスライドは残す
    warnings.push(...await writeNotes(p, id, notes));
    if (placements.length) warnings.push(...await placeImages(p, id, placements, input.images ?? {}, input.publishImage));
    return { presentationId: id, ...links(id), templateApplied: false, pages, warnings };
  };

  return {
    readTemplate: async (p, t) => {
      const got = await read(p, t.presentationId, t.name);
      return 'reason' in got ? { unavailable: got.reason } : got;
    },

    createPresentation: async (p, input) => {
      if (!input.template) return { ...(await standard(p, input)), ...(input.design ? { design: input.design.name } : {}) };
      const t = input.template;
      const got = await read(p, t.presentationId, t.name);
      const fallback = async (reason: string) => {
        const r = await standard(p, input);
        return { ...r, warnings: [reason, ...r.warnings] };
      };
      if ('reason' in got) return fallback(got.reason);
      if (got.layouts.length === 0) return fallback(`会社のテンプレート「${t.name}」に見本のスライドが無いため、標準の見た目で作りました`);
      if (checkTemplatePlan(input.plan, got) === 'standard') {
        return fallback(`会社のテンプレート「${t.name}」の見本で構成されていなかったため、標準の見た目で作りました`);
      }

      // 本人のドライブにテンプレートを複製し、複製したものを読み直す（ID は複製先のものを使う）
      const copied = await drive(p, `/files/${encodeURIComponent(t.presentationId)}/copy?fields=id`, { method: 'POST', body: { name: input.title } });
      const id = String(copied?.['id'] ?? '');
      if (!id) return fallback(`会社のテンプレート「${t.name}」を複製できなかったため、標準の見た目で作りました`);
      try {
        const deck = describeTemplate((await slides(p, `/presentations/${encodeURIComponent(id)}?fields=${encodeURIComponent(TEMPLATE_FIELDS)}`)) as SlidesPresentation);
        checkTemplatePlan(input.plan, deck);
        const { requests, warnings } = templateRequests(input.plan, deck, { ...input.deckDefaults, ...input.plan.deck });
        await slides(p, `/presentations/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: { requests } });
        // 発表者のメモ（各ページの話す内容）と、出典（見た目を崩さないよう最後のページのメモの後ろに書く。第9.4.2節「段 2」）
        const tplNotes: Record<string, string> = {};
        input.plan.slides.forEach((sl, i) => { if (sl.notes) tplNotes[`m2tpl${i + 1}`] = sl.notes; });
        const sources = input.plan.sources ?? [];
        if (sources.length > 0) {
          const lastId = `m2tpl${input.plan.slides.length}`;
          const list = ['出典', ...sources.map((x, k) => `${k + 1}. ${x.title}${x.url ? ` ${x.url}` : ''}`)].join('\n');
          tplNotes[lastId] = tplNotes[lastId] ? `${tplNotes[lastId]}\n\n${list}` : list;
        }
        const noteWarnings = await writeNotes(p, id, tplNotes);
        return { presentationId: id, ...links(id), templateApplied: true, pages: input.plan.slides.length, warnings: [...got.warnings, ...warnings, ...noteWarnings] };
      } catch (err) {
        await discard(p, id);
        if (err instanceof SlidePlanError) throw err;
        throw new Error(`スライドを組み立てられませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
