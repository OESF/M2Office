/**
 * @file 会社が登録したスライドのテンプレートの読み取り（使える見本のスライドと差し込み口の一覧）。
 *
 * 見た目はコードに書かず、会社が Google スライドの画面で作ったテンプレートに任せる（仕様書 第9.4.2節「スライドのテンプレート」）。
 * ここは Slides API が返すプレゼンテーションから、推論へ渡せる一覧（マニフェスト）を作るだけで、Google は呼ばない。
 * AI Radio の `presentation-template.js`（MIT、同じ作者）の見本のスライドの方式を移植した（ADR-0006・ADR-0032）。
 *
 * @see 仕様書 第9.4.2節「スライドのテンプレート」
 */

/** 差し込み口の書き方（`{{名前}}`）。 */
export const TEMPLATE_VARIABLE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** 見本のスライドの名前（`{{LAYOUT_NAME:3カード比較}}`）。画面の外に置く。 */
const LAYOUT_NAME = /\{\{\s*LAYOUT_NAME\s*:\s*([^}]+?)\s*\}\}/;

/** 図の置き場所を示す予約の名前。差し込み口には数えない。 */
const RESERVED = new Set(['CHART', 'IMAGE']);

const EMU_PER_INCH = 914_400;

/** 差し込み口 1 つ。入る量の目安は、枠の大きさと文字の大きさから求める。 */
export interface TemplateSlot {
  key: string;
  /** 入る行数の目安。 */
  lines: number;
  /** 1 行に入る字数の目安（全角）。 */
  charsPerLine: number;
  /** テンプレートに書かれたとおりの目印（`{{ 見出し }}` のような空白も含む）。置き換えに使う。 */
  tokens: string[];
}

/** 図の置き場所（EMU）。目印を囲む枠があれば枠の大きさ。 */
export interface TemplateArea {
  x: number; y: number; w: number; h: number;
  /** 置くときに消す要素（目印と、囲む枠）の、テンプレートの中の ID。 */
  deleteIds: string[];
}

/** 見本のスライド 1 枚（= レイアウト 1 つ）。 */
export interface TemplateLayout {
  /** テンプレートの中のスライドの ID。複製の元にする。 */
  id: string;
  name: string;
  /** `{{LAYOUT_NAME:…}}` で名前を付けてあるか。無ければ「見本N」。 */
  named: boolean;
  slots: TemplateSlot[];
  chart: boolean;
  image: boolean;
  /** 名前の目印を書いた要素の ID。組み立てたスライドから消す。 */
  nameMarkerId?: string;
  /** `{{CHART}}`・`{{IMAGE}}` の置き場所。 */
  chartArea?: TemplateArea;
  imageArea?: TemplateArea;
  /** 複製するときに ID を決めておく要素（名前の目印と置き場所の要素）。 */
  elementIds: string[];
}

/** テンプレートから読み取ったもの。 */
export interface TemplateManifest {
  title: string;
  layouts: TemplateLayout[];
  /** マスターに書いた変数（会社名など、デッキ全体で 1 回だけ差し替えるもの）。 */
  deckVariables: string[];
  /** マスターの変数ごとの、書かれたとおりの目印。 */
  deckTokens: Record<string, string[]>;
  /** テンプレートのスライドの ID のすべて。組み立ての最後に消す。 */
  slideIds: string[];
  /** 使い方の注意（名前が無い見本など）。 */
  warnings: string[];
}

/** Slides API のページの要素（使うところだけ）。 */
interface PageElement {
  objectId?: string;
  size?: { width?: { magnitude?: number }; height?: { magnitude?: number } };
  transform?: { scaleX?: number; scaleY?: number; translateX?: number; translateY?: number };
  shape?: { text?: { textElements?: { textRun?: { content?: string; style?: { fontSize?: { magnitude?: number } } } }[] } };
}

/** Slides API のプレゼンテーション（使うところだけ）。 */
export interface SlidesPresentation {
  title?: string;
  pageSize?: { width?: { magnitude?: number }; height?: { magnitude?: number } };
  slides?: { objectId?: string; pageElements?: PageElement[] }[];
  masters?: { pageElements?: PageElement[] }[];
}

/** 読み取りに要る項目（`fields`）。 */
export const TEMPLATE_FIELDS = 'title,'
  + 'pageSize,slides(objectId,pageElements(objectId,size,transform,shape(text(textElements(textRun(content,style(fontSize))))))),'
  + 'masters(pageElements(shape(text(textElements(textRun(content))))))';

/** 表示される位置と大きさ（EMU。size × scale）。 */
const rectOf = (el: PageElement) => ({
  x: el.transform?.translateX ?? 0, y: el.transform?.translateY ?? 0,
  w: (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1),
  h: (el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1),
});

/**
 * 目印（`{{CHART}}` など）の置き場所。目印を囲む、文字の無い図形のうち一番内側のものがあれば、その枠を使う。
 *
 * @remarks 目印は枠に重ねた細いラベルに書かれることがある。ラベルの大きさで置くと帯のように潰れる（AI Radio での知見）
 */
function areaOf(label: PageElement, all: PageElement[]): TemplateArea {
  const tol = EMU_PER_INCH * 0.05;
  const l = rectOf(label);
  let frame: PageElement | null = null;
  for (const el of all) {
    if (el === label || !el.objectId || textOf(el).trim()) continue;
    const r = rectOf(el);
    const contains = r.x <= l.x + tol && r.y <= l.y + tol && r.x + r.w >= l.x + l.w - tol && r.y + r.h >= l.y + l.h - tol;
    if (!contains || r.w * r.h <= l.w * l.h * 1.5) continue;
    if (!frame || r.w * r.h < rectOf(frame).w * rectOf(frame).h) frame = el;
  }
  const r = rectOf(frame ?? label);
  return { ...r, deleteIds: [label.objectId!, ...(frame ? [frame.objectId!] : [])] };
}

const textOf = (el: PageElement) => (el.shape?.text?.textElements ?? []).map((t) => t.textRun?.content ?? '').join('');

/**
 * 枠に入る量の目安。行間 1.45、全角 1 字は文字の大きさと同じ幅とみなす。
 *
 * @remarks Slides は入りきらない文字を縮めることがあり、正確ではない。明らかな入れすぎを避けるための目安
 */
function capacity(el: PageElement): { lines: number; charsPerLine: number } {
  const w = ((el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1)) / EMU_PER_INCH;
  const h = ((el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1)) / EMU_PER_INCH;
  const pt = (el.shape?.text?.textElements ?? []).map((t) => t.textRun?.style?.fontSize?.magnitude).find((x) => !!x) ?? 18;
  return {
    lines: Math.max(1, Math.floor(h / ((pt * 1.45) / 72))),
    charsPerLine: Math.max(4, Math.floor(w / (pt / 72))),
  };
}

/**
 * プレゼンテーションから、使える見本のスライドと差し込み口の一覧を作る。
 *
 * @remarks
 * 差し込み口（`{{名前}}`）も図の置き場所も無いスライドは見本にしない（表紙の飾りや説明のページのため）。
 * マスターの変数は、スライドごとの差し込み口と混ぜない（混ぜると全スライドに同じ値が入る）。
 */
export function describeTemplate(pres: SlidesPresentation): TemplateManifest {
  const layouts: TemplateLayout[] = [];
  (pres.slides ?? []).forEach((slide, i) => {
    let name: string | null = null;
    let nameMarkerId: string | undefined;
    const slots: TemplateSlot[] = [];
    let chartArea: TemplateArea | undefined;
    let imageArea: TemplateArea | undefined;
    const elements = slide.pageElements ?? [];
    for (const el of elements) {
      const text = textOf(el);
      if (!text || !el.objectId) continue;
      const hit = LAYOUT_NAME.exec(text);
      if (hit) { name = hit[1]!.trim(); nameMarkerId = el.objectId; continue; }
      for (const m of text.matchAll(TEMPLATE_VARIABLE)) {
        const key = m[1]!.trim();
        if (!key || /^LAYOUT_NAME\s*:/i.test(key)) continue;
        if (key.toUpperCase() === 'CHART') { chartArea ??= areaOf(el, elements); continue; }
        if (key.toUpperCase() === 'IMAGE') { imageArea ??= areaOf(el, elements); continue; }
        const found = slots.find((s) => s.key === key);
        if (found) { if (!found.tokens.includes(m[0])) found.tokens.push(m[0]); } else slots.push({ key, ...capacity(el), tokens: [m[0]] });
      }
    }
    if (!slide.objectId || (slots.length === 0 && !chartArea && !imageArea)) return;
    const elementIds = [...new Set([nameMarkerId, ...(chartArea?.deleteIds ?? []), ...(imageArea?.deleteIds ?? [])].filter((x): x is string => !!x))];
    layouts.push({
      id: slide.objectId, name: name ?? `見本${i + 1}`, named: name !== null, slots, chart: !!chartArea, image: !!imageArea,
      ...(nameMarkerId ? { nameMarkerId } : {}), ...(chartArea ? { chartArea } : {}), ...(imageArea ? { imageArea } : {}), elementIds,
    });
  });

  const deckTokens: Record<string, string[]> = {};
  for (const master of pres.masters ?? []) {
    for (const el of master.pageElements ?? []) {
      for (const m of textOf(el).matchAll(TEMPLATE_VARIABLE)) {
        const v = m[1]!.trim();
        if (!v || RESERVED.has(v.toUpperCase())) continue;
        const list = (deckTokens[v] ??= []);
        if (!list.includes(m[0])) list.push(m[0]);
      }
    }
  }

  const warnings: string[] = [];
  if (layouts.length === 0) warnings.push('差し込み口（{{見出し}} のような書き方）を持つ見本のスライドが 1 枚もありません');
  const unnamed = layouts.filter((l) => !l.named);
  if (unnamed.length > 0) warnings.push(`名前の無い見本が ${unnamed.length} 枚あります。画面の外に {{LAYOUT_NAME:3カード比較}} のように名前を書くと、使い分けやすくなります`);
  // 同じ名前の見本は、あとのものを「名前（2）」にして区別する
  const seen = new Map<string, number>();
  for (const l of layouts) {
    const n = (seen.get(l.name) ?? 0) + 1;
    seen.set(l.name, n);
    if (n > 1) l.name = `${l.name}（${n}）`;
  }
  return {
    title: pres.title ?? '', layouts, deckVariables: Object.keys(deckTokens), deckTokens,
    slideIds: (pres.slides ?? []).map((s) => s.objectId).filter((x): x is string => !!x), warnings,
  };
}
