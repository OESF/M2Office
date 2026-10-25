/**
 * @file 調べてスライドにまとめる共通ツール（`web.research`・`slides.template`・`slides.create`）。
 *
 * 1. 調べる（`web.research`）→ 2. 構成を決める（推論のステップ）→ 3. 組み立てる（`slides.create`）の 3 段の、
 * 1 と 3 を担う。AI Radio の秘書の `create_presentation` を移植した（ADR-0006）。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_SLIDE_DESIGN_ID, SLIDE_DECK_SHARING_LABEL, SLIDE_DESIGNS, SLIDE_THEME_PREFIX, findSlideDesign, type SlideDeckSummary, type SlideDesign } from '@m2office/shared';
import type { Tool } from './registry.js';
import { SlidePlanError, normalizeSlidePlan, planOutline, type SlidePlan } from '../slides/plan.js';
import { pieChartPng } from '../slides/pie.js';
import { SlideThemeUnavailableError } from '../slides/theme.js';
import { HAND_EDIT_GRACE_MS } from '../slides/decks.js';
import { palette } from '../connectors/google/slide-infographics.js';

/**
 * テーマを Google 検索で調べ、出典つきの文章を返す。
 *
 * @remarks
 * 危険度: `read`。調べるだけで、どこにも書き込まない。ただし検索の言葉は Google に送られる。
 * 権限区画に属する業務では使えない（検証で拒否する。区画のデータを社外の検索に送らないため）。
 * 応答は外部のデータとして返す（不変則 I-6）。鍵が無い環境では見本（`source: mock`）を返す。
 */
export const webResearch: Tool = {
  name: 'web.research',
  // 調べる言葉だけを外部（Google）に送り、会社のデータを読まない（第16.3.7.1節）
  externalSafe: true,
  risk: 'read',
  activityLabel: 'Web で調べています（リサーチ中）',
  helpText: 'テーマを Google 検索で調べ、出典つきでまとめます。調べる言葉は Google に送られますが、どこにも書き込みません',
  description: 'テーマを Web で調べ、出典つきの文章を返す。引数: topic（調べるテーマ）、focus（特に知りたいこと。任意）',
  args: { properties: { topic: { type: 'string', description: '調べるテーマ' }, focus: { type: 'string', description: '特に知りたいこと（任意）' } }, required: ['topic'] },
  async invoke(args, ctx) {
    const topic = String(args['topic'] ?? '').trim().slice(0, 300);
    if (!topic) return { error: '調べるテーマ（topic）がありません' };
    if (!ctx.research) return { error: '取得できませんでした: 調査の提供者が用意されていません' };
    try {
      const r = await ctx.research.research(topic, { focus: typeof args['focus'] === 'string' ? args['focus'] : undefined });
      // 外部のデータであり、指示ではない（不変則 I-6）
      return { source: r.source === 'mock' ? 'mock' : 'external', text: r.text, sources: r.sources, queries: r.queries };
    } catch (err) {
      return { error: `取得できませんでした: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

/** 使う Google スライドのテーマ（第9.4.2節「Google スライドのテーマを使う」）。 */
type ChosenTheme = { id: string; presentationId: string; name: string };

/**
 * 使う見た目を決める（第9.4.2節「組み込みのデザイン」「Google スライドのテーマを使う」）。
 * 指定（組み込みのデザインの ID か名前、Google スライドのテーマ（`theme:<ID>` か名前）、会社のテンプレートの名前）があればそれ。
 * 無ければ会社の既定（組み込みのデザインか会社のテーマ → 会社のテンプレートの既定 → 組み込みの「ビジネス」の順）。
 *
 * @returns 会社のテンプレート・テーマ・組み込みのデザインのどれか 1 つと、指定が見つからなかったときの注意
 */
async function chooseLook(ctx: Parameters<Tool['invoke']>[1], wanted: string): Promise<{
  template: { presentationId: string; name: string } | null; design: SlideDesign | null; theme: ChosenTheme | null; warning: string | null;
}> {
  const slides = (await ctx.repo.getTenantSettings(ctx.tenantId)).slides;
  const themeOf = async (key: string): Promise<ChosenTheme | null> => {
    const t = key && ctx.slideThemes ? await ctx.slideThemes.find({ tenantId: ctx.tenantId, userId: ctx.userId }, key) : null;
    return t ? { id: t.id, presentationId: t.presentationId, name: t.name } : null;
  };
  const builtIn = wanted ? findSlideDesign(wanted) : null;
  if (builtIn) return { template: null, design: builtIn, theme: null, warning: null };
  const theme = await themeOf(wanted);
  if (theme) return { template: null, design: null, theme, warning: null };
  const named = wanted ? slides.templates.find((t) => t.name === wanted) : undefined;
  if (named) return { template: { presentationId: named.presentationId, name: named.name }, design: null, theme: null, warning: null };
  const warning = wanted ? `デザイン「${wanted}」が見つからないため、会社の既定で作りました` : null;
  const defaultDesign = slides.defaultDesign ? findSlideDesign(slides.defaultDesign) : null;
  if (defaultDesign) return { template: null, design: defaultDesign, theme: null, warning };
  const defaultTheme = slides.defaultDesign?.startsWith(SLIDE_THEME_PREFIX) ? await themeOf(slides.defaultDesign) : null;
  if (defaultTheme) return { template: null, design: null, theme: defaultTheme, warning };
  const def = slides.templates.find((t) => t.isDefault);
  if (def) return { template: { presentationId: def.presentationId, name: def.name }, design: null, theme: null, warning };
  return { template: null, design: findSlideDesign(DEFAULT_SLIDE_DESIGN_ID), theme: null, warning };
}

/** 1 つの資料に入れる象徴的な画像の上限（表紙を含む。第9.4.2節「段 2」）。 */
export const SLIDE_IMAGES_MAX = 4;

/**
 * 象徴的な画像と円グラフの画像を用意する（第9.4.2節「段 2」）。象徴的な画像は表紙・区切り・画像のページに 4 枚まで、デザインの作風で作る。
 * 円グラフは数値から M2Office が描く（AI は使わない）。作れなかった画像は注意にして、スライドは作る。
 *
 * 作り直すとき（`previous` に前の画像の頼みがあるとき）は、同じ頼みの画像を作らずに前の画像を使い回す（第9.4.2節「作ったスライドの扱い」）。
 *
 * @param previous 前の画像の頼み（前の場所の名前 → 頼み）
 * @returns 場所の名前（`cover`・`m2slide<n>`・`m2slide<n>_pie`）ごとの画像、AI の画像の数（使い回しを含む）、
 *   AI の画像の頼み（場所の名前 → 頼み）、使い回す画像（新しい場所の名前 → 前の場所の名前）
 */
async function prepareImages(
  ctx: Parameters<Tool['invoke']>[1], plan: SlidePlan, design: SlideDesign, wantAi: boolean, warnings: string[],
  previous: Record<string, string> = {}, themed = false,
): Promise<{ images: Record<string, { bytes: Uint8Array; mimeType: string }>; aiCount: number; prompts: Record<string, string>; reuse: Record<string, string> }> {
  const images: Record<string, { bytes: Uint8Array; mimeType: string }> = {};
  const prompts: Record<string, string> = {};
  const reuse: Record<string, string> = {};
  // 円グラフ（ドーナツ型）
  plan.slides.forEach((s, i) => {
    if (s.layout !== 'SHARE' || s.shareStyle !== 'pie' || !s.items?.length) return;
    try {
      images[`m2slide${i + 1}_pie`] = { bytes: pieChartPng(s.items.map((it) => it.value ?? 0), palette(design, s.items.length), design.background), mimeType: 'image/png' };
    } catch (err) {
      warnings.push(`${i + 1} 枚目の円グラフを描けなかったため、帯で示しました（${err instanceof Error ? err.message : String(err)}）`);
    }
  });
  const generate = ctx.slideImages?.generate;
  const hasPrevious = Object.keys(previous).length > 0;
  if (!wantAi || (!generate && !hasPrevious)) return { images, aiCount: 0, prompts, reuse };
  // 象徴的な画像。表紙を先に、区切りと画像のページを順に、上限まで
  const jobs: { key: string; prompt: string; aspect: '16:9' | '3:4' }[] = [];
  // テーマで作るときは、表紙と区切りはテーマの飾りに任せ、画像のページだけに置く（第9.4.2節「Google スライドのテーマを使う」）
  if (plan.imagePrompt && !themed) jobs.push({ key: 'cover', prompt: plan.imagePrompt, aspect: '3:4' });
  plan.slides.forEach((s, i) => {
    if (!s.imagePrompt || (s.layout !== 'SECTION' && s.layout !== 'IMAGE') || (themed && s.layout === 'SECTION')) return;
    jobs.push({ key: `m2slide${i + 1}`, prompt: s.imagePrompt, aspect: s.layout === 'IMAGE' ? '16:9' : '3:4' });
  });
  if (jobs.length > SLIDE_IMAGES_MAX) warnings.push(`画像は 1 つの資料で ${SLIDE_IMAGES_MAX} 枚までにしました（${jobs.length} 枚の頼み）`);
  let aiCount = 0;
  // 前と同じ頼みの画像は使い回す（作り直さない。費用と、絵が毎回変わることを避ける）
  const same = (a: string) => a.replace(/\s+/g, '');
  const byPrompt = new Map(Object.entries(previous).map(([key, prompt]) => [same(prompt), key]));
  const chosen = jobs.slice(0, SLIDE_IMAGES_MAX).filter((j) => {
    const old = byPrompt.get(same(j.prompt));
    if (!old) return true;
    reuse[j.key] = old;
    prompts[j.key] = j.prompt;
    aiCount += 1;
    return false;
  });
  if (chosen.length === 0 || !generate) return { images, aiCount, prompts, reuse };
  await ctx.progress?.('スライドの画像を作っています');
  // 頼みは外部のデータではなく推論が書いた文。作風をそろえ、文字・数字・ロゴ・実在の人物を描かせない
  const rules = `${design.imageStyle}。画像の中に文字・数字・ロゴ・商標・実在の人物を描かない。発表のスライドに置く、余白のある落ち着いた構図`;
  const done = await Promise.allSettled(chosen.map((j) => generate(`${j.prompt}。${rules}`, j.aspect)));
  done.forEach((r, k) => {
    const j = chosen[k]!;
    if (r.status === 'fulfilled' && r.value) {
      images[j.key] = r.value;
      prompts[j.key] = j.prompt;
      aiCount += 1;
    } else {
      warnings.push(`${j.key === 'cover' ? '表紙' : `${j.key.replace('m2slide', '')} 枚目`}の画像を作れませんでした${r.status === 'rejected' ? `（${r.reason instanceof Error ? r.reason.message : String(r.reason)}）` : ''}`);
    }
  });
  return { images, aiCount, prompts, reuse };
}

/** 選べる見た目の名前（推論が依頼の言葉から選ぶため）。 */
async function lookChoices(ctx: Parameters<Tool['invoke']>[1]): Promise<string[]> {
  const { templates } = (await ctx.repo.getTenantSettings(ctx.tenantId)).slides;
  const themes = ctx.slideThemes ? await ctx.slideThemes.list({ tenantId: ctx.tenantId, userId: ctx.userId }) : [];
  return [...SLIDE_DESIGNS.map((d) => d.name), ...themes.map((t) => t.name), ...templates.map((t) => t.name)];
}

/** ツールの引数から、見た目の指定（`design`。前の版の `template` も読む）を取り出す。 */
const wantedLook = (args: Record<string, unknown>) =>
  (typeof args['design'] === 'string' && args['design'].trim()) || (typeof args['template'] === 'string' ? args['template'].trim() : '');

/**
 * 会社のテンプレートを使えない理由。本人がドライブ全体の許可（`drive`）をまだ与えていなければ、接続し直すよう書く。
 *
 * @remarks
 * 許可が無いまま読むと、Google は「見つからない」と返し、管理者の登録の誤りと見分けられない。先に許可を確かめる。
 * 見本の接続口では確かめない（`null`）
 */
async function missingDriveGrant(ctx: Parameters<Tool['invoke']>[1], name: string): Promise<string | null> {
  if (ctx.connector.sourceFor(ctx.tenantId) !== 'google') return null;
  const conn = await ctx.repo.getGoogleConnection(ctx.tenantId, ctx.userId);
  if (!conn || conn.scopes.includes('drive')) return null;
  return `会社のテンプレート「${name}」を使う Google の許可がありません。個人設定の「Google 連携」で接続し直すと、次から会社のテンプレートで作ります`;
}

/** 標準のレイアウトで構成するときに推論へ返す言葉。 */
const USE_STANDARD = '標準のレイアウト（BULLET・COMPARISON・KPI・CHART・IMAGE）で構成してください';

/**
 * 会社が登録したスライドのテンプレートの、使える見本のスライドと差し込み口を読む。
 *
 * @remarks
 * 危険度: `read`。テンプレートを読むだけで、どこにも書き込まない。
 * 会社のテンプレートは M2Office が作ったファイルではないため、ドライブ全体の権限（`drive`）が要る（仕様書 第9.4.2節、Q-88）。
 * 開けないときも止めず、標準のレイアウトで構成するよう返す。
 */
export const slidesTemplate: Tool = {
  name: 'slides.template',
  risk: 'read',
  activityLabel: 'スライドのテンプレートを確かめています',
  helpText: '会社が登録したスライドのテンプレートの、使えるレイアウトを確かめます。どこにも書き込みません',
  description: '会社が登録したスライドのテンプレートの、使えるレイアウト（見本のスライド）の名前と差し込み口（入る行数と 1 行の字数の目安）、'
    + 'マスターの変数を返す。slides.create の前に呼ぶ。テンプレートがあれば、slides[] の layout に見本の名前、values に差し込み口ごとの値、'
    + 'deck にマスターの変数の値を書き、表紙も見本の 1 枚として構成に入れる。引数: design（組み込みのデザインの名前か、会社のテンプレートの名前。任意。無ければ会社の既定）。'
    + '組み込みのデザイン（ビジネス・ナチュラル・ポップ・モノトーン・クリーン・ダーク）なら、標準のレイアウトで構成する',
  args: { properties: { design: { type: 'string', description: 'デザインの名前（組み込みのデザインか会社のテンプレート。任意）' } } },
  google: { scope: 'drive', level: 'restricted' },
  async invoke(args, ctx) {
    const { template, design, theme, warning } = await chooseLook(ctx, wantedLook(args));
    const choices = await lookChoices(ctx);
    if (theme) return { template: null, design: theme.name, choices, ...(warning ? { warnings: [warning] } : {}), message: `Google スライドのテーマ「${theme.name}」で作ります。${USE_STANDARD}` };
    if (!template) return { template: null, design: design?.name ?? null, choices, ...(warning ? { warnings: [warning] } : {}), message: `組み込みのデザイン「${design?.name ?? 'ビジネス'}」で作ります。${USE_STANDARD}` };
    const blocked = await missingDriveGrant(ctx, template.name);
    if (blocked) return { template: template.name, message: `${blocked}。${USE_STANDARD}` };
    const got = await ctx.connector.slides.readTemplate({ tenantId: ctx.tenantId, userId: ctx.userId }, template);
    if (!got) return { template: template.name, source: 'mock', message: `見本の接続口のため、テンプレートを読めません。${USE_STANDARD}` };
    if ('unavailable' in got) return { template: template.name, message: `${got.unavailable}。${USE_STANDARD}` };
    if (got.layouts.length === 0) return { template: template.name, message: `テンプレートに見本のスライドがありません。${USE_STANDARD}` };
    return {
      template: template.name, choices,
      layouts: got.layouts.map((l) => ({
        name: l.name,
        slots: l.slots.map((x) => ({ key: x.key, lines: x.lines, charsPerLine: x.charsPerLine })),
        ...(l.chart ? { chart: '表を置ける（chartCategories と chartSeries を書く）' } : {}),
        ...(l.image ? { image: '画像の置き場所（いまは空になる）' } : {}),
      })),
      deckVariables: got.deckVariables,
      warnings: [...(warning ? [warning] : []), ...got.warnings],
      message: 'この見本の名前だけで構成してください（標準のレイアウトと混ぜない）。値は入る量の目安を超えないようにしてください',
    };
  },
};

/**
 * スライドの構成から Google スライドを作る（仕様書 第9.4.2節）。前に作ったスライドを直すときは、同じファイルを作り直す。
 *
 * @remarks
 * 危険度: `draft`。依頼した本人のドライブに作り、共有はしない（会社で共有するのは `slides.share`）。
 * 構成の形が違えば作らずに理由を返す。上限を超えた文字は切り詰め、そのことを結果に書く。
 * 接続口が見本のときは Google スライドを作らず、構成をアウトラインとして成果物に残す。
 * 直すとき（`deckId`）: 作った後に人が手を入れていれば上書きせず新しいファイルに作る。会社のテンプレートのものは新しいファイルに作り、前のファイルをごみ箱に移す（共有の範囲は引き継ぐ）。
 * 作ったものは作った人ごとに覚える（第9.4.2節「作ったスライドの扱い」）
 */
export const slidesCreate: Tool = {
  name: 'slides.create',
  risk: 'draft',
  activityLabel: 'スライドを作成しています',
  helpText: '調べた内容をスライドにまとめ、あなたのドライブに作ります。前に作ったスライドを直すこともできます。PowerPoint 形式でも取り出せます。共有はしません',
  description: 'スライドの構成（title・subtitle・slides[]・sources[]）から、発表で使う Google スライドを作る。'
    + 'slides[] の各要素は layout と title（言い切りの 1 文。30 文字まで）と notes（発表者のメモ。話す内容）。図のレイアウトで見せる: '
    + 'STATEMENT（message・sub）・SECTION（number・title）・BIG_NUMBER（stats 1 件に value・unit・label、sub）・KPI（stats 2〜4 に value・unit・label・icon）・'
    + 'BAR（items に label・value、highlight、unit、orientation）・SHARE（items に label・value、shareStyle は band か grid）・PROGRESS（items に label・value 0〜100）・'
    + 'STEPS（items に title・text）・TIMELINE（items に date・title・text）・CARDS（items に icon・title・text）・'
    + 'COMPARISON（compareLeftTitle・compareLeftBody・compareRightTitle・compareRightBody、mode は vs か before-after）・MATRIX（xAxis・yAxis・items 4 つ）・'
    + 'PYRAMID（items に title・text）・CHECKLIST（items に title・text）・TABLE（chartCategories・chartSeries）・BULLET（body。3 行まで）。'
    + '本文の半分以上を図にし、同じ layout を続けず、BULLET は 2 枚まで（合わなければ作らずに直し方を返す）。本文のスライドは 12 枚まで。'
    + '3 枚以上なら、すべてのページに notes（話す内容を 100〜300 文字）を書き、表紙で話す内容を全体の notes に書く。'
    + '象徴的な画像: 全体の imagePrompt（表紙の画像。何を描くか 100 文字まで）と、SECTION・IMAGE の imagePrompt（4 枚まで。文字や人物でなく情景や物で表す）。'
    + 'images に false を渡せば画像を作らない。SHARE の shareStyle は band・grid・pie（円グラフ）。'
    + '会社のテンプレートがあるときは slides.template で見本を確かめ、layout に見本の名前、values に差し込み口ごとの値、deck にマスターの変数の値を書く。'
    + 'design に組み込みのデザインの名前（ビジネス・ナチュラル・ポップ・モノトーン・クリーン・ダーク）、Google スライドのテーマ（theme:<ID> かテーマの名前）、会社のテンプレートの名前を渡せばそれを、無ければ会社の既定を使う。'
    + 'テーマのときは標準のレイアウトで構成する（表紙・区切りはテーマの見た目になり、画像は IMAGE のページだけに入る）。'
    + '前に作ったスライドを直すときは deckId（slides.get で読んだもの）を渡す。同じファイルが作り直され、前と同じ imagePrompt の画像は使い回される',
  args: { properties: {
    title: { type: 'string', description: '表紙の題名' }, subtitle: { type: 'string', description: '副題（任意）' },
    slides: { type: 'array', description: '本文のスライドの配列（layout・title・notes ほか。12 枚まで）' }, sources: { type: 'array', description: '出典（title・url）の配列' },
    notes: { type: 'string', description: '表紙で話す内容（発表者のメモ）' }, imagePrompt: { type: 'string', description: '表紙の象徴的な画像の頼み（何を描くか）' },
    images: { type: 'boolean', description: '象徴的な画像を作るか（既定は作る）' },
    design: { type: 'string', description: 'デザインの名前（組み込みのデザインか会社のテンプレート。任意）' },
    deckId: { type: 'string', description: '直す、前に作ったスライドの ID（直すときだけ）' },
    request: { type: 'string', description: '依頼の文（直す頼みも。覚えておき、次に直すときに読む）' },
  }, required: ['title', 'slides'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  // 会社のテンプレートを本人のドライブへ複製するため（仕様書 第9.4.2節、Q-88）
  googleAlso: [{ scope: 'drive', level: 'restricted' }],
  async invoke(args, ctx) {
    const checked = normalizeSlidePlan(args);
    if ('error' in checked) return { error: `スライドを作れませんでした: ${checked.error}` };
    const { plan, warnings } = checked;
    const who = { tenantId: ctx.tenantId, userId: ctx.userId };
    // 直す前のもの（作った人だけが直せる。第9.4.2節「作ったスライドの扱い」）
    const deckId = typeof args['deckId'] === 'string' ? args['deckId'].trim() : '';
    const prev = deckId && ctx.slideDecks ? await ctx.slideDecks.store.get(ctx.tenantId, deckId) : null;
    if (deckId && (!prev || prev.userId !== ctx.userId || prev.kind !== 'slides')) return { error: '直すスライドが見つかりません（作った人だけが直せます。slides.list で探してください）' };
    // 見た目（第9.4.2節）: 組み込みのデザインか会社のテンプレート。指定が無ければ前と同じ、前も無ければ会社の既定
    const chosen = await chooseLook(ctx, wantedLook(args) || (prev ? (prev.theme ? `${SLIDE_THEME_PREFIX}${prev.theme}` : null) ?? prev.template ?? prev.design ?? '' : ''));
    if (chosen.warning) warnings.push(chosen.warning);
    const blocked = chosen.template ? await missingDriveGrant(ctx, chosen.template.name) : null;
    if (blocked) warnings.push(blocked);
    const template = blocked ? null : chosen.template;
    // 作り直す先。人が手を入れた後なら上書きしない（手で直したものを消さない）
    let rebuild: string | undefined;
    let replaceOld = false;
    let asNew = false;
    if (prev) {
      const state = await ctx.connector.slides.fileState(who, prev.presentationId);
      const mock = prev.presentationId.startsWith('mock-');
      if (!mock && (!state || state.trashed)) {
        warnings.push('前のファイルがドライブに見つからなかったため、新しいファイルに作りました');
      } else if (state && Date.parse(state.modifiedTime) > Date.parse(prev.builtAt) + HAND_EDIT_GRACE_MS) {
        asNew = true;
        warnings.push('前のファイルに手で直した跡があったので、上書きせずに新しいファイルに作りました');
      } else if (template || (prev.theme ?? null) !== (chosen.theme?.id ?? null)) {
        // 会社のテンプレートと、テーマを変えたとき（テーマはファイルのマスターに入っているため）は新しいファイルにする
        replaceOld = true;
      } else if (!mock) {
        rebuild = prev.presentationId;
      }
    }
    // マスターの {{会社名}} などは、構成に値が無ければ会社情報で埋める（第9.4.2節）
    const { company } = await ctx.repo.getTenantSettings(ctx.tenantId);
    const deckDefaults = { 会社名: company.legalName, 会社の略称: company.shortName || company.legalName };
    // 象徴的な画像と円グラフ（第9.4.2節「段 2」）。会社のテンプレートで作るときは使わない（見た目は見本に任せる）
    const look = chosen.design ?? findSlideDesign(DEFAULT_SLIDE_DESIGN_ID)!;
    const prepared = template
      ? { images: {}, aiCount: 0, prompts: {}, reuse: {} }
      : await prepareImages(ctx, plan, look, args['images'] !== false, warnings, rebuild ? prev!.imagePrompts : {}, !!chosen.theme);
    // AI が作った画像を使ったら、出典のページの先頭に 1 行書く（出典の数の上限で切られないように）
    if (prepared.aiCount > 0) plan.sources = [{ title: '表紙などの画像は、AI（画像を作るモデル）が作ったものです' }, ...(plan.sources ?? [])];
    let created;
    let theme = chosen.theme;
    const build = (t: ChosenTheme | null) => ctx.connector.slides.createPresentation(who, {
      title: plan.title, plan, template, deckDefaults, design: chosen.design, footer: company.shortName || company.legalName || '',
      ...(t ? { theme: { presentationId: t.presentationId, name: t.name } } : {}),
      ...(Object.keys(prepared.images).length ? { images: prepared.images } : {}),
      ...(ctx.slideImages?.publish ? { publishImage: ctx.slideImages.publish } : {}),
      ...(rebuild ? { rebuild, reuseImages: prepared.reuse } : {}),
    });
    try {
      try {
        created = await build(theme);
      } catch (err) {
        // テーマのファイルを開けなければ、標準の見た目（既定のデザイン）で作り、理由を残す
        if (!(err instanceof SlideThemeUnavailableError) || rebuild) throw err;
        warnings.push(`${err.message}。標準のデザインで作りました`);
        theme = null;
        created = await build(null);
      }
    } catch (err) {
      // 見本に無い名前などは推論が直せる。段を失敗にせず、理由を返す
      if (err instanceof SlidePlanError) return { error: `スライドを作れませんでした: ${err.message}` };
      throw err;
    }
    const mock = ctx.connector.sourceFor(ctx.tenantId) === 'mock';
    // 接続口が会社のテンプレートを使えなかったときは、標準の見た目で作ったと書く（第9.4.2節）
    const used = created.templateApplied === false ? null : template;
    // 標準の見た目で作ったときのデザインの名前（会社のテンプレートを開けずに標準にしたときは既定のデザイン）
    const designName = used ? null : theme ? theme.name : (chosen.design ?? findSlideDesign(DEFAULT_SLIDE_DESIGN_ID))!.name;
    warnings.push(...(created.warnings ?? []));
    // 会社のテンプレートのものを新しいファイルに作り直したら、共有の範囲を引き継ぎ、前のファイルをごみ箱へ
    const sharing = prev && !asNew ? prev.sharing : 'private';
    if (prev && replaceOld && prev.presentationId !== created.presentationId) {
      if (sharing === 'company' && ctx.slideDecks) {
        const domain = await ctx.slideDecks.companyDomain(who);
        if ('domain' in domain) await ctx.connector.slides.share(who, created.presentationId, domain.domain);
        else warnings.push(domain.reason);
      }
      await ctx.connector.slides.trash(who, prev.presentationId).catch(() => false);
      warnings.push('会社のテンプレートで作り直すため新しいファイルにし、前のファイルはドライブのごみ箱に移しました');
    }
    // 作ったものを覚える（作り直すため。第9.4.2節「作ったスライドの扱い」）
    const now = new Date().toISOString();
    const builtAt = (await ctx.connector.slides.fileState(who, created.presentationId).catch(() => null))?.modifiedTime || now;
    const request = typeof args['request'] === 'string' ? args['request'].trim().slice(0, 2000) : '';
    const deck = ctx.slideDecks ? {
      id: prev && !asNew ? prev.id : randomUUID(), kind: 'slides' as const, body: null, tenantId: ctx.tenantId, userId: ctx.userId, presentationId: created.presentationId,
      title: plan.title, design: designName, template: used?.name ?? null, theme: theme?.id ?? null, sharing,
      request: [prev && !asNew ? prev.request : '', request].filter(Boolean).join('\n直す頼み: ').slice(-4000),
      plan, imagePrompts: prepared.prompts, runId: ctx.runId, builtAt,
      createdAt: prev && !asNew ? prev.createdAt : now, updatedAt: now,
    } : null;
    if (deck) await ctx.slideDecks!.store.save(deck);
    const id = randomUUID();
    // リンクは成果物の文に書かない（画面がボタンにする）。見本の接続口のときだけ、作っていないことを書く
    await ctx.repo.createArtifact({
      id, runId: ctx.runId, tenantId: ctx.tenantId, kind: 'slides', title: plan.title,
      body: [
        ...(created.url ? [] : ['（見本の接続口のため、Google スライドは作っていません。構成をアウトラインとして残しています）', '']),
        used ? `テンプレート: ${used.name}` : `デザイン: ${designName}`, '', planOutline(plan),
        ...(warnings.length ? ['', '---', ...warnings.map((w) => `注意: ${w}`)] : []),
      ].join('\n'),
      ...(deck ? { slideDeckId: deck.id } : {}),
      createdAt: now,
    });
    return {
      artifactId: id, deckId: deck?.id ?? null, presentationId: created.presentationId, url: created.url, pptxUrl: created.pptxUrl,
      slideCount: created.pages ?? plan.slides.length + 1, template: used?.name ?? null, design: designName, sharing, warnings,
      rebuilt: !!rebuild, ...(mock ? { source: 'mock' } : {}),
    };
  },
};

/**
 * 作ったスライドの一覧（本人のものと、会社で共有されたもの）。
 *
 * @remarks 危険度: `read`。M2Office が覚えている一覧を読むだけ
 */
export const slidesList: Tool = {
  name: 'slides.list',
  risk: 'read',
  activityLabel: '作ったスライドを探しています',
  helpText: 'あなたが作ったスライドと、会社で共有されたスライドの一覧を読みます',
  description: '作ったスライドの一覧を返す（新しい順。mine は本人が作ったもの、shared は会社で共有されたもの）。各項目は id・title・design・sharing・updatedAt。'
    + '前に作ったスライドを直す・共有する頼みで、どのスライドかを探すのに使う',
  args: { properties: {} },
  // M2Office が覚えている一覧を読むだけ。作ったスライドと同じ権限を宣言する（第14.3.2節 規定 1）
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(_args, ctx) {
    if (!ctx.slideDecks) return { error: '作ったスライドの一覧を使えません' };
    const { mine, shared } = await ctx.slideDecks.list({ tenantId: ctx.tenantId, userId: ctx.userId });
    const pick = (d: SlideDeckSummary) => ({ id: d.id, title: d.title, design: d.design, sharing: SLIDE_DECK_SHARING_LABEL[d.sharing], updatedAt: d.updatedAt, ...(d.ownerName ? { owner: d.ownerName } : {}) });
    return { mine: mine.slice(0, 30).map(pick), shared: shared.slice(0, 30).map(pick) };
  },
};

/**
 * 前に作ったスライドの構成と頼みを読む（直すため）。
 *
 * @remarks 危険度: `read`。本人のものと会社で共有されたものだけ読める
 */
export const slidesGet: Tool = {
  name: 'slides.get',
  risk: 'read',
  activityLabel: '前のスライドを読んでいます',
  helpText: '前に作ったスライドの構成を読みます（直すため）',
  description: '前に作ったスライドの構成（plan）・頼み（request）・デザイン・共有の範囲を返す。直す頼みのときは、この構成を頼みの分だけ変えて slides.create に deckId と一緒に渡す。'
    + '画像を変える頼みでなければ imagePrompt は前のまま書く（同じ画像が使い回される）',
  args: { properties: { deckId: { type: 'string', description: 'スライドの ID（slides.list の id）' } }, required: ['deckId'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    if (!ctx.slideDecks) return { error: '作ったスライドを読めません' };
    const d = await ctx.slideDecks.get({ tenantId: ctx.tenantId, userId: ctx.userId }, String(args['deckId'] ?? ''));
    if (!d || d.kind !== 'slides') return { error: 'スライドが見つかりません' };
    return {
      deckId: d.id, title: d.title, design: d.template ?? d.design, sharing: SLIDE_DECK_SHARING_LABEL[d.sharing], request: d.request,
      mine: d.userId === ctx.userId, plan: d.plan,
      ...(d.userId === ctx.userId ? {} : { note: 'ほかの人のスライドは直せません。直したいときは、この構成で新しく作ってください（deckId を渡さない）' }),
    };
  },
};

/**
 * 作ったスライドの共有の範囲を切り替える（自分だけ・会社で共有）。
 *
 * @remarks
 * 危険度: `write-internal`。会社の Google Workspace のドメインへの閲覧だけで、社外には出さない。
 * ドメインを確かめられなければ共有しない（仕様書 第9.4.2節「作ったスライドの扱い」、境界 2）
 */
export const slidesShare: Tool = {
  name: 'slides.share',
  risk: 'write-internal',
  activityLabel: 'スライドの共有を切り替えています',
  helpText: '作ったスライドを、会社の中で共有するか、自分だけにするかを切り替えます。社外には共有しません',
  description: '作ったスライドの共有の範囲を切り替える。sharing は「会社で共有」（会社の Google Workspace の人が見られる。編集はできない）か「自分だけ」。'
    + '作った人だけが切り替えられる。会社のドメインを確かめられないときは共有せず、理由を返す',
  args: { properties: {
    deckId: { type: 'string', description: 'スライドの ID（slides.create の deckId か slides.list の id）' },
    sharing: { type: 'string', description: '「会社で共有」か「自分だけ」' },
  }, required: ['deckId', 'sharing'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    if (!ctx.slideDecks) return { error: '作ったスライドの共有を切り替えられません' };
    const sharing = String(args['sharing'] ?? '').includes('会社') || args['sharing'] === 'company' ? 'company' : 'private';
    const got = await ctx.slideDecks.share({ tenantId: ctx.tenantId, userId: ctx.userId }, String(args['deckId'] ?? ''), sharing);
    if ('error' in got) return { error: got.error };
    return { deckId: got.id, title: got.title, sharing: SLIDE_DECK_SHARING_LABEL[got.sharing] };
  },
};

export const RESEARCH_TOOLS: Tool[] = [webResearch, slidesTemplate, slidesCreate, slidesList, slidesGet, slidesShare];
