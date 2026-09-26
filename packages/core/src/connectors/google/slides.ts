/**
 * @file Google スライドの接続口（仕様書 第9.4.2節「標準の見た目」、第14.3.4節）。
 *
 * テンプレートのファイルを使わず、Slides API で空のプレゼンテーションを作ってから、
 * レイアウトごとに決めた位置へ図形と文字を置く。M2Office が作ったファイルしか触らないため、権限は `drive.file` だけで足りる。
 * LLM は内容と構成だけを決め、位置や色はここで決める（ADR-0006）。共有はしない。
 */

import type { SlidePlan, SlideSpec } from '../../slides/plan.js';
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

/** 色（0〜1 の RGB）。落ち着いた紺を基調にする。 */
const COLOR = {
  accent: { red: 0.1, green: 0.3, blue: 0.55 },
  accentLight: { red: 0.91, green: 0.94, blue: 0.98 },
  text: { red: 0.2, green: 0.2, blue: 0.2 },
  muted: { red: 0.4, green: 0.4, blue: 0.4 },
};

type Rgb = (typeof COLOR)[keyof typeof COLOR];
type Request = Record<string, unknown>;
/** 置く場所（インチ。既定の大きさでの値）。 */
type Box = { x: number; y: number; w: number; h: number };

/**
 * 構成から、Slides API の一括更新の要求を作る。
 *
 * @param plan 検証済みの構成（`normalizeSlidePlan` を通したもの）
 * @param page 作ったプレゼンテーションの大きさ（EMU）
 * @param initialSlide 作ったときに入っている 1 枚目。最後に消す
 * @returns 要求の並び、ページ数、注意（切り詰めたことなど。黙って捨てない）
 */
export function slideRequests(
  plan: SlidePlan, page: { width: number; height: number }, initialSlide: string | null,
): { requests: Request[]; pages: number; warnings: string[] } {
  const sx = page.width / BASE.width;
  const sy = page.height / BASE.height;
  const requests: Request[] = [];
  const warnings: string[] = [];

  const at = (pageObjectId: string, b: Box) => ({
    pageObjectId,
    size: { width: { magnitude: Math.round(b.w * EMU_PER_INCH * sx), unit: 'EMU' }, height: { magnitude: Math.round(b.h * EMU_PER_INCH * sy), unit: 'EMU' } },
    transform: { scaleX: 1, scaleY: 1, translateX: Math.round(b.x * EMU_PER_INCH * sx), translateY: Math.round(b.y * EMU_PER_INCH * sy), unit: 'EMU' },
  });
  const style = (objectId: string, s: { size?: number; bold?: boolean; color?: Rgb }, range: Request = { type: 'ALL' }) => {
    const st: Record<string, unknown> = {};
    const fields: string[] = [];
    if (s.size) { st['fontSize'] = { magnitude: s.size, unit: 'PT' }; fields.push('fontSize'); }
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
    style(id, { size: o.size, bold: o.bold ?? false, color: o.color ?? COLOR.text });
    if (o.center) requests.push({ updateParagraphStyle: { objectId: id, style: { alignment: 'CENTER' }, textRange: { type: 'ALL' }, fields: 'alignment' } });
    if (o.bullets) requests.push({ createParagraphBullets: { objectId: id, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
  };
  /** 見出しの 1 行目を太く大きく、残りを本文にした枠。 */
  const headed = (id: string, slide: string, b: Box, head: string, body: string, fill: Rgb) => {
    const value = [head, body].filter(Boolean).join('\n');
    box(id, slide, b, value, { size: 14, fill });
    if (head) style(id, { size: 18, bold: true, color: COLOR.accent }, { type: 'FIXED_RANGE', startIndex: 0, endIndex: head.length });
  };
  /** 題名だけの型のスライドを足し、題名を入れる。 */
  const titled = (id: string, title: string) => {
    requests.push({
      createSlide: {
        objectId: id, slideLayoutReference: { predefinedLayout: 'TITLE_ONLY' },
        placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: `${id}_t` }],
      },
    });
    text(`${id}_t`, title);
  };

  // 表紙
  requests.push({
    createSlide: {
      objectId: 'm2cover', slideLayoutReference: { predefinedLayout: 'TITLE' },
      placeholderIdMappings: [
        { layoutPlaceholder: { type: 'CENTERED_TITLE', index: 0 }, objectId: 'm2cover_t' },
        { layoutPlaceholder: { type: 'SUBTITLE', index: 0 }, objectId: 'm2cover_s' },
      ],
    },
  });
  text('m2cover_t', plan.title);
  if (plan.subtitle) text('m2cover_s', plan.subtitle);
  else requests.push({ deleteObject: { objectId: 'm2cover_s' } });

  // 本文のスライド。中身は題名の下から、伝えたいこと（takeaway）の帯の上まで
  const content: Box = { x: 0.5, y: 1.35, w: 9, h: 3.25 };
  plan.slides.forEach((s: SlideSpec, i) => {
    // Slides API はオブジェクトの ID に 5 文字以上を求める（短いと 400。AI Radio での知見）
    const id = `m2slide${i + 1}`;
    titled(id, s.title);
    const area = s.takeaway ? content : { ...content, h: 3.9 };
    if (s.layout === 'BULLET') {
      box(`${id}_b`, id, area, s.body ?? '', { size: 16, bullets: true });
    } else if (s.layout === 'COMPARISON') {
      const w = (area.w - 0.3) / 2;
      headed(`${id}_l`, id, { ...area, w }, s.compareLeftTitle ?? '', s.compareLeftBody ?? '', COLOR.accentLight);
      headed(`${id}_r`, id, { ...area, x: area.x + w + 0.3, w }, s.compareRightTitle ?? '', s.compareRightBody ?? '', COLOR.accentLight);
    } else if (s.layout === 'KPI') {
      const stats = s.stats ?? [];
      const w = stats.length > 0 ? (area.w - 0.3 * (stats.length - 1)) / stats.length : area.w;
      stats.forEach((st, k) => {
        const kid = `${id}_k${k + 1}`;
        box(kid, id, { x: area.x + k * (w + 0.3), y: area.y + 0.4, w, h: Math.min(2.2, area.h - 0.4) }, `${st.value}\n${st.label}`, { size: 14, fill: COLOR.accentLight, center: true, color: COLOR.muted });
        style(kid, { size: 32, bold: true, color: COLOR.accent }, { type: 'FIXED_RANGE', startIndex: 0, endIndex: st.value.length });
      });
    } else if (s.layout === 'CHART') {
      const cats = s.chartCategories ?? [];
      const series = s.chartSeries ?? [];
      if (cats.length > TABLE_ROWS_MAX) warnings.push(`${i + 1} 枚目の表は ${TABLE_ROWS_MAX} 行までにしました（${cats.length} 項目）`);
      const rows = Math.min(cats.length, TABLE_ROWS_MAX);
      const tid = `${id}_tbl`;
      requests.push({ createTable: { objectId: tid, elementProperties: at(id, { ...area, h: Math.min(area.h, 0.4 * (rows + 1)) }), rows: rows + 1, columns: series.length + 1 } });
      const cell = (r: number, c: number, v: string, head: boolean) => {
        if (!v) return;
        requests.push({ insertText: { objectId: tid, cellLocation: { rowIndex: r, columnIndex: c }, text: v, insertionIndex: 0 } });
        requests.push({
          updateTextStyle: {
            objectId: tid, cellLocation: { rowIndex: r, columnIndex: c }, textRange: { type: 'ALL' },
            style: { fontSize: { magnitude: 12, unit: 'PT' }, bold: head, foregroundColor: { opaqueColor: { rgbColor: head ? COLOR.accent : COLOR.text } } },
            fields: 'fontSize,bold,foregroundColor',
          },
        });
      };
      series.forEach((se, c) => cell(0, c + 1, se.name, true));
      cats.slice(0, rows).forEach((cat, r) => {
        cell(r + 1, 0, cat, true);
        series.forEach((se, c) => cell(r + 1, c + 1, (se.values[r] ?? 0).toLocaleString('ja-JP'), false));
      });
      requests.push({
        updateTableCellProperties: {
          objectId: tid, tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: series.length + 1 },
          tableCellProperties: { tableCellBackgroundFill: { solidFill: { color: { rgbColor: COLOR.accentLight } } } },
          fields: 'tableCellBackgroundFill.solidFill.color',
        },
      });
    } else if (s.layout === 'IMAGE') {
      // 画像の生成は後の段階（第9.4.2節）。説明だけを出す
      box(`${id}_c`, id, area, s.caption ?? s.body ?? '', { size: 18, center: true, color: COLOR.muted });
    }
    if (s.takeaway) {
      box(`${id}_w`, id, { x: 0.5, y: 4.75, w: 9, h: 0.55 }, s.takeaway, { size: 14, bold: true, color: COLOR.accent, fill: COLOR.accentLight });
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
  return { requests, pages, warnings };
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

  return {
    createPresentation: async (p, input) => {
      const made = await slides(p, '/presentations', { method: 'POST', body: { title: input.title } });
      const id = String(made?.['presentationId'] ?? '');
      if (!id) throw new Error('スライドを作れませんでした');
      const size = made?.['pageSize'] as { width?: { magnitude?: number }; height?: { magnitude?: number } } | undefined;
      const page = {
        width: size?.width?.magnitude || BASE.width,
        height: size?.height?.magnitude || BASE.height,
      };
      const first = (made?.['slides'] as { objectId?: string }[] | undefined)?.[0]?.objectId ?? null;
      const { requests, pages, warnings } = slideRequests(input.plan, page, first);
      try {
        await slides(p, `/presentations/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: { requests } });
      } catch (err) {
        // 空のスライドを残さない。ごみ箱に移すだけで、消しはしない（本人が戻せる）
        await drive(p, `/files/${encodeURIComponent(id)}`, { method: 'PATCH', body: { trashed: true } }).catch(() => null);
        throw new Error(`スライドを組み立てられませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
      // 会社のテンプレートは、読む権限を決めるまで使わない（第9.4.2節、Q-88）
      if (input.template) warnings.unshift(`会社のテンプレート「${input.template.name}」での組み立ては準備中のため、標準の見た目で作りました`);
      const url = `https://docs.google.com/presentation/d/${id}/edit`;
      return {
        presentationId: id, url, pptxUrl: `https://docs.google.com/presentation/d/${id}/export/pptx`,
        templateApplied: false, pages, warnings,
      };
    },
  };
}
