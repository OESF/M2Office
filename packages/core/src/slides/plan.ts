/**
 * @file スライドの構成（JSON）の型・検証・アウトラインへの変換。
 *
 * 構成の形は AI Radio の `SLIDE_PLAN_SCHEMA`（server/lib/secretary-tools-presentation.js、MIT、同じ作者）を引き継ぐ。
 * LLM が決めるのは内容と構成（どのレイアウトに何を書くか）だけで、座標やデザインは決めさせない。
 * 見た目はテンプレートが決める（仕様書 第9.4.2節、ADR-0006）。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

/** スライドのレイアウト。テンプレートの見本のスライドに対応する。 */
export const SLIDE_LAYOUTS = ['BULLET', 'COMPARISON', 'KPI', 'CHART', 'IMAGE'] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** グラフの種類。 */
export const CHART_TYPES = ['COLUMN', 'BAR', 'LINE', 'AREA', 'SCATTER', 'PIE'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** 本文のスライド 1 枚。 */
export interface SlideSpec {
  layout: SlideLayout;
  title: string;
  /** 箇条書き。1 行ずつ改行で区切る。 */
  body?: string;
  compareLeftTitle?: string;
  compareLeftBody?: string;
  compareRightTitle?: string;
  compareRightBody?: string;
  /** 強調する数値（KPI）。3 件まで。 */
  stats?: { value: string; label: string }[];
  chartType?: ChartType;
  chartCategories?: string[];
  /** グラフの系列。2 つまで。 */
  chartSeries?: { name: string; values: number[] }[];
  /** そのスライドで伝えたいこと（1 文）。 */
  takeaway?: string;
  /** IMAGE のとき、入れる画像の説明（画像の生成は後の段階）。 */
  imagePrompt?: string;
  caption?: string;
}

/** スライドの構成の全体。 */
export interface SlidePlan {
  title: string;
  subtitle?: string;
  slides: SlideSpec[];
  /** 出典。最後のスライドに一覧として載せる。 */
  sources?: { title: string; url?: string }[];
}

/** 本文のスライドの枚数の上限（表紙を除く）。 */
export const MAX_SLIDES = 12;

/** 箇条書きの行頭の印。`-3%` のような数は印とみなさない（後ろに空白がある `-`・`*` だけ）。 */
const BULLET_MARK = /^(?:[・•●◦▪■□◆◇]|[-*](?=\s))\s*/;

/**
 * 文字の値を読む。推論は箇条書きを配列で渡すことがあるため、配列なら 1 行ずつにつなぐ。
 *
 * @remarks 2026-09-26 に oesf で、本文を配列で渡され、比較の本文が空になり、箇条書きがカンマでつながった
 */
function linesOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String).join('\n');
  return '';
}

/** 文字数の上限。AI Radio の構成の指示文の上限を引き継ぐ。 */
const LIMITS = { short: 20, body: 150, lines: 6, prompt: 100 };

/**
 * 推論が渡した構成を検証し、上限に合わせて整える。
 *
 * @returns 整えた構成と、切り詰めなどの注意。形が違えば誤り（作らずに理由を返す）
 *
 * @remarks 上限を超えた文字は切り詰め、切り詰めたことを `warnings` に書く。黙って捨てない。
 */
export function normalizeSlidePlan(input: unknown): { plan: SlidePlan; warnings: string[] } | { error: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  const str = (v: unknown, max: number, where: string): string => {
    const s = linesOf(v).trim();
    if (s.length <= max) return s;
    warnings.push(`${where} を ${max} 文字に切り詰めました`);
    return `${s.slice(0, max - 1)}…`;
  };
  const title = str(o['title'], 40, '表紙の題名');
  if (!title) return { error: '表紙の題名（title）がありません' };
  if (!Array.isArray(o['slides']) || o['slides'].length === 0) return { error: 'スライド（slides）が 1 枚もありません' };
  if (o['slides'].length > MAX_SLIDES) return { error: `スライドは ${MAX_SLIDES} 枚までです（${o['slides'].length} 枚）` };

  const slides: SlideSpec[] = [];
  for (const [i, raw] of (o['slides'] as unknown[]).entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const at = `${i + 1} 枚目`;
    const layout = r['layout'] as SlideLayout;
    if (!SLIDE_LAYOUTS.includes(layout)) return { error: `${at}: layout は ${SLIDE_LAYOUTS.join('・')} のいずれかです` };
    const s: SlideSpec = { layout, title: str(r['title'], LIMITS.short, `${at}の題名`) };
    if (!s.title) return { error: `${at}: 題名（title）がありません` };
    if (r['body'] !== undefined) {
      // 行頭の印（・や -）は外す。箇条書きの印は組み立てで付くため、残すと二重になる（2026-09-26 に oesf で確認）
      const lines = linesOf(r['body']).split('\n').map((l) => l.trim().replace(BULLET_MARK, '').trim()).filter(Boolean);
      if (lines.length > LIMITS.lines) warnings.push(`${at}の箇条書きを ${LIMITS.lines} 行に切り詰めました`);
      s.body = str(lines.slice(0, LIMITS.lines).join('\n'), LIMITS.body, `${at}の本文`);
    }
    for (const k of ['compareLeftTitle', 'compareRightTitle', 'caption'] as const) {
      if (r[k] !== undefined) s[k] = str(r[k], LIMITS.short, `${at}の${k}`);
    }
    for (const k of ['compareLeftBody', 'compareRightBody', 'takeaway'] as const) {
      if (r[k] !== undefined) s[k] = str(r[k], LIMITS.body, `${at}の${k}`);
    }
    if (r['imagePrompt'] !== undefined) s.imagePrompt = str(r['imagePrompt'], LIMITS.prompt, `${at}の画像の説明`);
    if (Array.isArray(r['stats'])) {
      if (r['stats'].length > 3) warnings.push(`${at}の数値を 3 件に切り詰めました`);
      s.stats = r['stats'].slice(0, 3).map((x: Record<string, unknown>) => ({
        value: str(x?.['value'], LIMITS.short, `${at}の数値`), label: str(x?.['label'], LIMITS.short, `${at}の数値の説明`),
      }));
    }
    if (layout === 'CHART') {
      const chartType = r['chartType'] as ChartType;
      if (!CHART_TYPES.includes(chartType)) return { error: `${at}: chartType は ${CHART_TYPES.join('・')} のいずれかです` };
      const cats = Array.isArray(r['chartCategories']) ? r['chartCategories'].map(String) : [];
      const series = Array.isArray(r['chartSeries']) ? r['chartSeries'] : [];
      if (cats.length === 0 || series.length === 0) return { error: `${at}: グラフには chartCategories と chartSeries が要ります` };
      if (series.length > 2) warnings.push(`${at}のグラフの系列を 2 つに切り詰めました`);
      s.chartType = chartType;
      s.chartCategories = cats;
      s.chartSeries = series.slice(0, 2).map((x: Record<string, unknown>) => ({
        name: String(x?.['name'] ?? ''), values: Array.isArray(x?.['values']) ? (x['values'] as unknown[]).map(Number) : [],
      }));
      if (s.chartSeries.some((x) => x.values.length !== cats.length || x.values.some((v) => !Number.isFinite(v)))) {
        return { error: `${at}: グラフの値の数が項目の数と合わないか、数値でない値があります` };
      }
    }
    slides.push(s);
  }
  const sources = Array.isArray(o['sources'])
    ? (o['sources'] as Record<string, unknown>[]).slice(0, 20).map((x) => ({
      title: String(x?.['title'] ?? x?.['url'] ?? '').slice(0, 200),
      ...(typeof x?.['url'] === 'string' ? { url: x['url'] } : {}),
    })).filter((x) => x.title)
    : undefined;
  return { plan: { title, subtitle: str(o['subtitle'], 60, '副題') || undefined, slides, sources }, warnings };
}

/** 構成を、人が読めるアウトライン（Markdown）にする。成果物に残す。 */
export function planOutline(plan: SlidePlan): string {
  const out: string[] = [`# ${plan.title}`];
  if (plan.subtitle) out.push(plan.subtitle);
  plan.slides.forEach((s, i) => {
    out.push('', `## ${i + 1}. ${s.title}（${s.layout}）`);
    if (s.body) out.push(...s.body.split('\n').map((l) => `- ${l}`));
    if (s.compareLeftTitle || s.compareRightTitle) {
      out.push(`- ${s.compareLeftTitle ?? '左'}: ${s.compareLeftBody ?? ''}`, `- ${s.compareRightTitle ?? '右'}: ${s.compareRightBody ?? ''}`);
    }
    for (const st of s.stats ?? []) out.push(`- **${st.value}** ${st.label}`);
    if (s.chartType) {
      out.push(`- グラフ（${s.chartType}）: ${s.chartCategories?.join('・')}`);
      for (const se of s.chartSeries ?? []) out.push(`  - ${se.name}: ${se.values.join(', ')}`);
    }
    if (s.imagePrompt) out.push(`- 画像: ${s.imagePrompt}${s.caption ? `（${s.caption}）` : ''}`);
    if (s.takeaway) out.push('', `> ${s.takeaway}`);
  });
  if (plan.sources?.length) {
    out.push('', '## 出典');
    for (const src of plan.sources) out.push(src.url ? `- [${src.title}](${src.url})` : `- ${src.title}`);
  }
  return out.join('\n');
}
