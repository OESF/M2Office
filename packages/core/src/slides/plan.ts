/**
 * @file スライドの構成（JSON）の型・検証・アウトラインへの変換。
 *
 * 構成の形は AI Radio の `SLIDE_PLAN_SCHEMA`（server/lib/secretary-tools-presentation.js、MIT、同じ作者）を引き継ぐ。
 * LLM が決めるのは内容と構成（どのレイアウトに何を書くか）だけで、座標やデザインは決めさせない。
 * 見た目はテンプレートが決める（仕様書 第9.4.2節、ADR-0006）。
 *
 * 第 0.435.0 版（Q-262）で、発表を意識した構成にした: 1 枚 1 メッセージ（見出しは言い切りの 1 文）・文字を減らす・
 * 本文の半分以上を図のレイアウトにする・同じレイアウトを続けない・話す内容は発表者のメモ（`notes`）に書く。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

/**
 * 標準のレイアウト（図形で描く。第9.4.2節「プレゼンテーションの表現」）。
 * `CHART`・`IMAGE` は前の版の構成のために受け付ける（`CHART` は棒グラフ・割合・表に読み替える）。
 */
export const SLIDE_LAYOUTS = [
  'STATEMENT', 'SECTION', 'BIG_NUMBER', 'KPI', 'BAR', 'SHARE', 'PROGRESS', 'STEPS', 'TIMELINE', 'CARDS', 'COMPARISON', 'MATRIX', 'PYRAMID',
  'CHECKLIST', 'TABLE', 'BULLET', 'CHART', 'IMAGE',
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** 文字だけのレイアウト（図の割合に数えない）。 */
export const TEXT_LAYOUTS: readonly SlideLayout[] = ['BULLET', 'TABLE'];

/** 図の中の 1 項目（レイアウトごとに使う項目が違う）。 */
export interface SlideItem {
  /** 項目の名前（棒グラフ・割合・進み具合）。 */
  label?: string;
  /** 値（棒グラフ・割合・進み具合は数）。 */
  value?: number;
  /** 見出し（手順・時の流れ・カード・ます・積み上げ・チェック）。 */
  title?: string;
  /** 補う 1 行。 */
  text?: string;
  /** アイコン（絵文字 1 つ）。 */
  icon?: string;
  /** 日付（時の流れ）。 */
  date?: string;
}

/** グラフの種類。 */
export const CHART_TYPES = ['COLUMN', 'BAR', 'LINE', 'AREA', 'SCATTER', 'PIE'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/**
 * 本文のスライド 1 枚。
 *
 * @remarks
 * `layout` は標準の 5 つ（{@link SLIDE_LAYOUTS}）か、会社のテンプレートの見本の名前。
 * 見本の名前のときは、差し込み口ごとの値を `values` に持つ（仕様書 第9.4.2節「スライドのテンプレート」）
 */
export interface SlideSpec {
  layout: SlideLayout | string;
  /** 題名。見本のスライドでは省けて、そのときは最初の値か見本の名前（アウトラインにだけ使う）。 */
  title: string;
  /** 見本のスライドの差し込み口ごとの値（キーは `{{…}}` の中の名前）。 */
  values?: Record<string, string>;
  /** 箇条書き。1 行ずつ改行で区切る。 */
  body?: string;
  compareLeftTitle?: string;
  compareLeftBody?: string;
  compareRightTitle?: string;
  compareRightBody?: string;
  /** 強調する数値（KPI は 4 件まで、BIG_NUMBER は 1 件）。 */
  stats?: { value: string; label: string; unit?: string; icon?: string }[];
  /** 図の項目（BAR・SHARE・PROGRESS・STEPS・TIMELINE・CARDS・MATRIX・PYRAMID・CHECKLIST）。 */
  items?: SlideItem[];
  /** 大きな一文（STATEMENT）。 */
  message?: string;
  /** 補う 1 行（STATEMENT・BIG_NUMBER の比べる値など）。 */
  sub?: string;
  /** 区切りの番号（SECTION）。 */
  number?: string;
  /** 強調する項目の名前（BAR）。 */
  highlight?: string;
  /** 単位（BAR・SHARE）。 */
  unit?: string;
  /** 棒の向き（BAR）。 */
  orientation?: 'horizontal' | 'vertical';
  /** 割合の見せ方（SHARE）。帯か 10×10 のます目。 */
  shareStyle?: 'band' | 'grid';
  /** 対比の見せ方（COMPARISON）。並べて比べるか、前後か。 */
  mode?: 'vs' | 'before-after';
  /** 2×2 の軸の名前（MATRIX）。 */
  xAxis?: string;
  yAxis?: string;
  /** 発表者のメモ（話す内容）。 */
  notes?: string;
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
  /** 出典。標準の見た目では最後に出典のページを足し、テンプレートでは最後のスライドの発表者のメモに書く。 */
  sources?: { title: string; url?: string }[];
  /** テンプレートのマスターの変数の値（会社名など）。 */
  deck?: Record<string, string>;
}

/**
 * 構成の誤り（テンプレートの見本に無い名前など）。接続口が投げ、ツールは作らずに理由を推論へ返す。
 *
 * @remarks 推論が直せる誤りなので、段を失敗にしない
 */
export class SlidePlanError extends Error {}

/** 標準のレイアウトか。 */
export const isStandardLayout = (layout: string): layout is SlideLayout => (SLIDE_LAYOUTS as readonly string[]).includes(layout);

/** 見本のスライドの差し込み口 1 つに入れてよい字数（テンプレートの枠の大きさは会社ごとに違うため、明らかに多すぎるものだけを切る）。 */
const VALUE_MAX = 600;

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

/** 文字数の上限（第9.4.2節「プレゼンテーションの表現」）。ページに置く文字を減らし、説明は発表者のメモへ。 */
const LIMITS = { headline: 30, short: 20, item: 15, line: 40, body: 150, lines: 3, message: 60, notes: 600, prompt: 100 };

/** レイアウトごとの項目の数（最少・最多）。 */
const ITEM_RANGE: Partial<Record<SlideLayout, [number, number]>> = {
  BAR: [2, 8], SHARE: [2, 5], PROGRESS: [1, 5], STEPS: [3, 5], TIMELINE: [3, 6], CARDS: [3, 4], MATRIX: [4, 4], PYRAMID: [3, 4], CHECKLIST: [3, 5],
};

/** 数の項目が要るレイアウト。 */
const NUMERIC_ITEMS: readonly SlideLayout[] = ['BAR', 'SHARE', 'PROGRESS'];

/** 1 つの資料で使ってよい箇条書きの枚数。 */
export const BULLET_MAX = 2;

/** アイコン（絵文字 1 つ）。長すぎるものは捨てる。 */
const iconOf = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && [...s].length <= 4 ? s : undefined;
};

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
    const layout = typeof r['layout'] === 'string' ? r['layout'].trim() : '';
    // 会社のテンプレートの見本のスライド。名前が見本にあるかは組み立てで確かめる（テンプレートを読むのは接続口）
    const hasValues = !!r['values'] && typeof r['values'] === 'object' && !Array.isArray(r['values']);
    if (!isStandardLayout(layout) && !(layout && hasValues)) {
      return { error: `${at}: layout は ${SLIDE_LAYOUTS.join('・')} のいずれか、または会社のテンプレートの見本の名前（values と一緒に）です` };
    }
    let s: SlideSpec;
    if (!isStandardLayout(layout)) {
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(r['values'] as Record<string, unknown>)) {
        values[k.replace(/^\{\{\s*|\s*\}\}$/g, '').trim()] = str(v, VALUE_MAX, `${at}の「${k}」`);
      }
      const first = Object.values(values).find(Boolean) ?? '';
      s = { layout, title: str(r['title'], 40, `${at}の題名`) || first.split('\n')[0]!.slice(0, 40) || layout, values };
    } else {
      // 見出しは言い切りの 1 文（第9.4.2節「プレゼンテーションの表現」）。区切りと大きな一文は題名が無くてもよい
      s = { layout, title: str(r['title'], LIMITS.headline, `${at}の題名`) };
      if (!s.title && layout !== 'STATEMENT' && layout !== 'SECTION') return { error: `${at}: 題名（title。言い切りの 1 文）がありません` };
    }
    if (r['notes'] !== undefined) s.notes = str(r['notes'], LIMITS.notes, `${at}の発表者のメモ`);
    if (r['body'] !== undefined) {
      // 行頭の印（・や -）は外す。箇条書きの印は組み立てで付くため、残すと二重になる（2026-09-26 に oesf で確認）
      const lines = linesOf(r['body']).split('\n').map((l) => l.trim().replace(BULLET_MARK, '').trim()).filter(Boolean);
      const max = isStandardLayout(layout) ? LIMITS.lines : 6;
      if (lines.length > max) warnings.push(`${at}の箇条書きを ${max} 行に切り詰めました`);
      s.body = str(lines.slice(0, max).join('\n'), LIMITS.body, `${at}の本文`);
    }
    for (const k of ['compareLeftTitle', 'compareRightTitle', 'caption', 'xAxis', 'yAxis', 'unit'] as const) {
      if (r[k] !== undefined) s[k] = str(r[k], LIMITS.short, `${at}の${k}`);
    }
    for (const k of ['compareLeftBody', 'compareRightBody', 'takeaway'] as const) {
      if (r[k] !== undefined) {
        const v = str(r[k], LIMITS.body, `${at}の${k}`);
        // 対比の本文は 3 行まで（行頭の印は外す）
        s[k] = k === 'takeaway' ? v : v.split('\n').map((l) => l.trim().replace(BULLET_MARK, '').trim()).filter(Boolean).slice(0, LIMITS.lines).join('\n');
      }
    }
    if (r['message'] !== undefined) s.message = str(r['message'], LIMITS.message, `${at}の一文`);
    if (r['sub'] !== undefined) s.sub = str(r['sub'], LIMITS.line, `${at}の補う 1 行`);
    if (r['number'] !== undefined) s.number = str(r['number'], 4, `${at}の番号`);
    if (r['highlight'] !== undefined) s.highlight = str(r['highlight'], LIMITS.item, `${at}の強調する項目`);
    if (r['orientation'] === 'vertical' || r['orientation'] === 'horizontal') s.orientation = r['orientation'];
    if (r['shareStyle'] === 'grid' || r['shareStyle'] === 'band') s.shareStyle = r['shareStyle'];
    if (r['mode'] === 'before-after' || r['mode'] === 'vs') s.mode = r['mode'];
    if (layout === 'STATEMENT' && !s.message) {
      if (!s.title) return { error: `${at}: STATEMENT には message（大きな一文）が要ります` };
      s.message = s.title;
    }
    if (layout === 'SECTION' && !s.title) return { error: `${at}: SECTION には title（章の名前）が要ります` };
    if (r['imagePrompt'] !== undefined) s.imagePrompt = str(r['imagePrompt'], LIMITS.prompt, `${at}の画像の説明`);
    if (Array.isArray(r['stats'])) {
      const max = layout === 'BIG_NUMBER' ? 1 : 4;
      if (r['stats'].length > max) warnings.push(`${at}の数値を ${max} 件に切り詰めました`);
      s.stats = r['stats'].slice(0, max).map((x: Record<string, unknown>) => {
        const icon = iconOf(x?.['icon']);
        const unit = str(x?.['unit'], 8, `${at}の数値の単位`);
        return {
          value: str(x?.['value'], 12, `${at}の数値`), label: str(x?.['label'], LIMITS.short, `${at}の数値の説明`),
          ...(unit ? { unit } : {}), ...(icon ? { icon } : {}),
        };
      });
    }
    if ((layout === 'BIG_NUMBER' || layout === 'KPI') && !(s.stats?.length)) return { error: `${at}: ${layout} には stats（value・label）が要ります` };
    // 図の項目（第9.4.2節「プレゼンテーションの表現」）
    const range = isStandardLayout(layout) ? ITEM_RANGE[layout] : undefined;
    if (range) {
      const list = Array.isArray(r['items']) ? (r['items'] as Record<string, unknown>[]) : [];
      if (list.length < range[0]) return { error: `${at}: ${layout} には items が ${range[0]} つ以上要ります（${list.length} つ）` };
      if (list.length > range[1]) warnings.push(`${at}の項目を ${range[1]} つに切り詰めました`);
      s.items = list.slice(0, range[1]).map((x, k) => {
        const it: SlideItem = {};
        const where = `${at}の ${k + 1} つ目`;
        if (x?.['label'] !== undefined) it.label = str(x['label'], LIMITS.item, `${where}の名前`);
        if (x?.['title'] !== undefined) it.title = str(x['title'], LIMITS.item, `${where}の見出し`);
        if (x?.['text'] !== undefined) it.text = str(x['text'], LIMITS.line, `${where}の 1 行`);
        if (x?.['date'] !== undefined) it.date = str(x['date'], 12, `${where}の日付`);
        const icon = iconOf(x?.['icon']);
        if (icon) it.icon = icon;
        if (x?.['value'] !== undefined) it.value = Number(x['value']);
        return it;
      });
      if (NUMERIC_ITEMS.includes(layout as SlideLayout) && s.items.some((it) => !Number.isFinite(it.value) || (it.value ?? 0) < 0 || !(it.label || it.title))) {
        return { error: `${at}: ${layout} の items には label と 0 以上の数の value が要ります` };
      }
      if (layout === 'PROGRESS' && s.items.some((it) => (it.value ?? 0) > 100)) return { error: `${at}: PROGRESS の value は 0〜100（割合）です` };
      if (!NUMERIC_ITEMS.includes(layout as SlideLayout) && s.items.some((it) => !(it.title || it.label))) return { error: `${at}: ${layout} の items には title が要ります` };
    }
    // 見本のスライドでは、{{CHART}} に置く表のために、系列があるときだけ読む（種類は問わない）
    if (layout === 'CHART' || layout === 'TABLE' || (!isStandardLayout(layout) && Array.isArray(r['chartSeries']))) {
      const chartType = (r['chartType'] ?? (layout === 'CHART' ? undefined : 'COLUMN')) as ChartType;
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
    slides.push(layout === 'CHART' ? fromChart(s) : s);
  }
  // 資料全体の決まり（標準のレイアウトだけで書いたとき。会社のテンプレートは見本に合わせる）
  if (slides.every((x) => isStandardLayout(x.layout))) {
    const problem = deckProblem(slides);
    if (problem) return { error: problem };
  }
  const sources = Array.isArray(o['sources'])
    ? (o['sources'] as Record<string, unknown>[]).slice(0, 20).map((x) => ({
      title: String(x?.['title'] ?? x?.['url'] ?? '').slice(0, 200),
      ...(typeof x?.['url'] === 'string' ? { url: x['url'] } : {}),
    })).filter((x) => x.title)
    : undefined;
  const deck: Record<string, string> = {};
  if (o['deck'] && typeof o['deck'] === 'object' && !Array.isArray(o['deck'])) {
    for (const [k, v] of Object.entries(o['deck'] as Record<string, unknown>)) deck[k.replace(/^\{\{\s*|\s*\}\}$/g, '').trim()] = str(v, 200, `「${k}」`);
  }
  return {
    plan: { title, subtitle: str(o['subtitle'], 60, '副題') || undefined, slides, sources, ...(Object.keys(deck).length ? { deck } : {}) },
    warnings,
  };
}

/**
 * 前の版の `CHART` を、図のレイアウトに読み替える。円グラフ（`PIE`）は割合（`SHARE`）に、系列が 1 つなら棒グラフ（`BAR`）に、ほかは表（`TABLE`）に。
 */
function fromChart(s: SlideSpec): SlideSpec {
  const cats = s.chartCategories ?? [];
  const series = s.chartSeries ?? [];
  if (series.length !== 1 || cats.length < 2 || cats.length > 8 || series[0]!.values.some((v) => v < 0)) return { ...s, layout: 'TABLE' };
  const items = cats.map((label, k) => ({ label: label.slice(0, LIMITS.item), value: series[0]!.values[k]! }));
  if (s.chartType === 'PIE' && cats.length <= 5) return { ...s, layout: 'SHARE', items };
  return { ...s, layout: 'BAR', items, ...(s.chartType === 'COLUMN' ? { orientation: 'vertical' as const } : {}) };
}

/**
 * 資料全体の決まりを確かめる（第9.4.2節「プレゼンテーションの表現」）。合わなければ推論が直せる言葉で返す。
 *
 * @returns 合わないときの理由。合えば `null`
 */
function deckProblem(slides: SlideSpec[]): string | null {
  const bullets = slides.filter((x) => x.layout === 'BULLET').length;
  if (bullets > BULLET_MAX) return `箇条書き（BULLET）は 1 つの資料で ${BULLET_MAX} 枚までです（${bullets} 枚）。数字は BIG_NUMBER・KPI・BAR、流れは STEPS・TIMELINE、項目は CARDS・CHECKLIST などの図に替えてください`;
  for (let i = 1; i < slides.length; i++) {
    if (slides[i]!.layout === slides[i - 1]!.layout) return `${i} 枚目と ${i + 1} 枚目が同じレイアウト（${slides[i]!.layout}）です。続けて同じレイアウトを使わず、別の図に替えてください`;
  }
  if (slides.length >= 4) {
    const text = slides.filter((x) => TEXT_LAYOUTS.includes(x.layout as SlideLayout)).length;
    if (text * 2 > slides.length) return `文字だけのページ（BULLET・TABLE）が多すぎます（${slides.length} 枚中 ${text} 枚）。本文の半分以上を図のレイアウトにしてください`;
  }
  return null;
}

/** 構成を、人が読めるアウトライン（Markdown）にする。成果物に残す。 */
export function planOutline(plan: SlidePlan): string {
  const out: string[] = [`# ${plan.title}`];
  if (plan.subtitle) out.push(plan.subtitle);
  plan.slides.forEach((s, i) => {
    out.push('', `## ${i + 1}. ${s.title || s.message || ''}（${s.layout}）`);
    if (s.message && s.message !== s.title) out.push(`**${s.message}**`);
    if (s.sub) out.push(s.sub);
    for (const it of s.items ?? []) {
      const head = [it.icon, it.date, it.title ?? it.label].filter(Boolean).join(' ');
      out.push(`- ${head}${it.value !== undefined ? `: ${it.value}${s.unit ?? ''}` : ''}${it.text ? ` — ${it.text}` : ''}`);
    }
    for (const [k, v] of Object.entries(s.values ?? {})) if (v) out.push(`- ${k}: ${v.replace(/\n/g, ' / ')}`);
    if (s.body) out.push(...s.body.split('\n').map((l) => `- ${l}`));
    if (s.compareLeftTitle || s.compareRightTitle) {
      out.push(`- ${s.compareLeftTitle ?? '左'}: ${s.compareLeftBody ?? ''}`, `- ${s.compareRightTitle ?? '右'}: ${s.compareRightBody ?? ''}`);
    }
    for (const st of s.stats ?? []) out.push(`- ${st.icon ? `${st.icon} ` : ''}**${st.value}${st.unit ?? ''}** ${st.label}`);
    if (s.chartType) {
      out.push(`- グラフ（${s.chartType}）: ${s.chartCategories?.join('・')}`);
      for (const se of s.chartSeries ?? []) out.push(`  - ${se.name}: ${se.values.join(', ')}`);
    }
    if (s.imagePrompt) out.push(`- 画像: ${s.imagePrompt}${s.caption ? `（${s.caption}）` : ''}`);
    if (s.takeaway) out.push('', `> ${s.takeaway}`);
    if (s.notes) out.push('', `（発表者のメモ）${s.notes}`);
  });
  if (plan.sources?.length) {
    out.push('', '## 出典');
    for (const src of plan.sources) out.push(src.url ? `- [${src.title}](${src.url})` : `- ${src.title}`);
  }
  return out.join('\n');
}
