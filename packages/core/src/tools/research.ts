/**
 * @file 調べてスライドにまとめる共通ツール（`web.research`・`slides.template`・`slides.create`）。
 *
 * 1. 調べる（`web.research`）→ 2. 構成を決める（推論のステップ）→ 3. 組み立てる（`slides.create`）の 3 段の、
 * 1 と 3 を担う。AI Radio の秘書の `create_presentation` を移植した（ADR-0006）。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_SLIDE_DESIGN_ID, SLIDE_DESIGNS, findSlideDesign, type SlideDesign } from '@m2office/shared';
import type { Tool } from './registry.js';
import { SlidePlanError, normalizeSlidePlan, planOutline, type SlidePlan } from '../slides/plan.js';
import { pieChartPng } from '../slides/pie.js';
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

/**
 * 使う見た目を決める（第9.4.2節「組み込みのデザイン」）。
 * 指定（組み込みのデザインの ID か名前、または会社のテンプレートの名前）があればそれ。
 * 無ければ会社の既定（組み込みのデザイン → 会社のテンプレートの既定 → 組み込みの「ビジネス」の順）。
 *
 * @returns 会社のテンプレート（使うなら）か組み込みのデザインのどちらか一方と、指定が見つからなかったときの注意
 */
async function chooseLook(ctx: Parameters<Tool['invoke']>[1], wanted: string): Promise<{
  template: { presentationId: string; name: string } | null; design: SlideDesign | null; warning: string | null;
}> {
  const slides = (await ctx.repo.getTenantSettings(ctx.tenantId)).slides;
  const builtIn = wanted ? findSlideDesign(wanted) : null;
  if (builtIn) return { template: null, design: builtIn, warning: null };
  const named = wanted ? slides.templates.find((t) => t.name === wanted) : undefined;
  if (named) return { template: { presentationId: named.presentationId, name: named.name }, design: null, warning: null };
  const warning = wanted ? `デザイン「${wanted}」が見つからないため、会社の既定で作りました` : null;
  const defaultDesign = slides.defaultDesign ? findSlideDesign(slides.defaultDesign) : null;
  if (defaultDesign) return { template: null, design: defaultDesign, warning };
  const def = slides.templates.find((t) => t.isDefault);
  if (def) return { template: { presentationId: def.presentationId, name: def.name }, design: null, warning };
  return { template: null, design: findSlideDesign(DEFAULT_SLIDE_DESIGN_ID), warning };
}

/** 1 つの資料に入れる象徴的な画像の上限（表紙を含む。第9.4.2節「段 2」）。 */
export const SLIDE_IMAGES_MAX = 4;

/**
 * 象徴的な画像と円グラフの画像を用意する（第9.4.2節「段 2」）。象徴的な画像は表紙・区切り・画像のページに 4 枚まで、デザインの作風で作る。
 * 円グラフは数値から M2Office が描く（AI は使わない）。作れなかった画像は注意にして、スライドは作る。
 *
 * @returns 場所の名前（`cover`・`m2slide<n>`・`m2slide<n>_pie`）ごとの画像と、AI の画像を作れた数
 */
async function prepareImages(
  ctx: Parameters<Tool['invoke']>[1], plan: SlidePlan, design: SlideDesign, wantAi: boolean, warnings: string[],
): Promise<{ images: Record<string, { bytes: Uint8Array; mimeType: string }>; aiCount: number }> {
  const images: Record<string, { bytes: Uint8Array; mimeType: string }> = {};
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
  if (!wantAi || !generate) return { images, aiCount: 0 };
  // 象徴的な画像。表紙を先に、区切りと画像のページを順に、上限まで
  const jobs: { key: string; prompt: string; aspect: '16:9' | '3:4' }[] = [];
  if (plan.imagePrompt) jobs.push({ key: 'cover', prompt: plan.imagePrompt, aspect: '3:4' });
  plan.slides.forEach((s, i) => {
    if (!s.imagePrompt || (s.layout !== 'SECTION' && s.layout !== 'IMAGE')) return;
    jobs.push({ key: `m2slide${i + 1}`, prompt: s.imagePrompt, aspect: s.layout === 'IMAGE' ? '16:9' : '3:4' });
  });
  if (jobs.length > SLIDE_IMAGES_MAX) warnings.push(`画像は 1 つの資料で ${SLIDE_IMAGES_MAX} 枚までにしました（${jobs.length} 枚の頼み）`);
  const chosen = jobs.slice(0, SLIDE_IMAGES_MAX);
  if (chosen.length === 0) return { images, aiCount: 0 };
  await ctx.progress?.('スライドの画像を作っています');
  // 頼みは外部のデータではなく推論が書いた文。作風をそろえ、文字・数字・ロゴ・実在の人物を描かせない
  const rules = `${design.imageStyle}。画像の中に文字・数字・ロゴ・商標・実在の人物を描かない。発表のスライドに置く、余白のある落ち着いた構図`;
  const done = await Promise.allSettled(chosen.map((j) => generate(`${j.prompt}。${rules}`, j.aspect)));
  let aiCount = 0;
  done.forEach((r, k) => {
    const j = chosen[k]!;
    if (r.status === 'fulfilled' && r.value) {
      images[j.key] = r.value;
      aiCount += 1;
    } else {
      warnings.push(`${j.key === 'cover' ? '表紙' : `${j.key.replace('m2slide', '')} 枚目`}の画像を作れませんでした${r.status === 'rejected' ? `（${r.reason instanceof Error ? r.reason.message : String(r.reason)}）` : ''}`);
    }
  });
  return { images, aiCount };
}

/** 選べる見た目の名前（推論が依頼の言葉から選ぶため）。 */
async function lookChoices(ctx: Parameters<Tool['invoke']>[1]): Promise<string[]> {
  const { templates } = (await ctx.repo.getTenantSettings(ctx.tenantId)).slides;
  return [...SLIDE_DESIGNS.map((d) => d.name), ...templates.map((t) => t.name)];
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
    const { template, design, warning } = await chooseLook(ctx, wantedLook(args));
    const choices = await lookChoices(ctx);
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
 * スライドの構成から Google スライドを作り、成果物として記録する。
 *
 * @remarks
 * 危険度: `draft`。依頼した本人のドライブに作り、共有はしない。
 * 構成の形が違えば作らずに理由を返す。上限を超えた文字は切り詰め、そのことを結果に書く。
 * 接続口が見本のときは Google スライドを作らず、構成をアウトラインとして成果物に残す。
 * Google では標準の見た目で組み立てる（会社のテンプレートは Q-88 の後）。
 */
export const slidesCreate: Tool = {
  name: 'slides.create',
  risk: 'draft',
  activityLabel: 'スライドを作成しています',
  helpText: '調べた内容をスライドにまとめ、あなたのドライブに作ります。PowerPoint 形式でも取り出せます。共有はしません',
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
    + 'design に組み込みのデザインの名前（ビジネス・ナチュラル・ポップ・モノトーン・クリーン・ダーク）か会社のテンプレートの名前を渡せばそれを、無ければ会社の既定を使う',
  args: { properties: {
    title: { type: 'string', description: '表紙の題名' }, subtitle: { type: 'string', description: '副題（任意）' },
    slides: { type: 'array', description: '本文のスライドの配列（layout・title・notes ほか。12 枚まで）' }, sources: { type: 'array', description: '出典（title・url）の配列' },
    notes: { type: 'string', description: '表紙で話す内容（発表者のメモ）' }, imagePrompt: { type: 'string', description: '表紙の象徴的な画像の頼み（何を描くか）' },
    images: { type: 'boolean', description: '象徴的な画像を作るか（既定は作る）' },
    design: { type: 'string', description: 'デザインの名前（組み込みのデザインか会社のテンプレート。任意）' },
  }, required: ['title', 'slides'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  // 会社のテンプレートを本人のドライブへ複製するため（仕様書 第9.4.2節、Q-88）
  googleAlso: [{ scope: 'drive', level: 'restricted' }],
  async invoke(args, ctx) {
    const checked = normalizeSlidePlan(args);
    if ('error' in checked) return { error: `スライドを作れませんでした: ${checked.error}` };
    const { plan, warnings } = checked;
    // 見た目（第9.4.2節）: 組み込みのデザインか会社のテンプレート。指定が無い・見つからなければ会社の既定
    const chosen = await chooseLook(ctx, wantedLook(args));
    if (chosen.warning) warnings.push(chosen.warning);
    const blocked = chosen.template ? await missingDriveGrant(ctx, chosen.template.name) : null;
    if (blocked) warnings.push(blocked);
    const template = blocked ? null : chosen.template;
    // マスターの {{会社名}} などは、構成に値が無ければ会社情報で埋める（第9.4.2節）
    const { company } = await ctx.repo.getTenantSettings(ctx.tenantId);
    const deckDefaults = { 会社名: company.legalName, 会社の略称: company.shortName || company.legalName };
    // 象徴的な画像と円グラフ（第9.4.2節「段 2」）。会社のテンプレートで作るときは使わない（見た目は見本に任せる）
    const look = chosen.design ?? findSlideDesign(DEFAULT_SLIDE_DESIGN_ID)!;
    const prepared = template ? { images: {}, aiCount: 0 } : await prepareImages(ctx, plan, look, args['images'] !== false, warnings);
    // AI が作った画像を使ったら、出典のページの先頭に 1 行書く（出典の数の上限で切られないように）
    if (prepared.aiCount > 0) plan.sources = [{ title: '表紙などの画像は、AI（画像を作るモデル）が作ったものです' }, ...(plan.sources ?? [])];
    let created;
    try {
      created = await ctx.connector.slides.createPresentation(
        { tenantId: ctx.tenantId, userId: ctx.userId },
        {
          title: plan.title, plan, template, deckDefaults, design: chosen.design, footer: company.shortName || company.legalName || '',
          ...(Object.keys(prepared.images).length ? { images: prepared.images } : {}),
          ...(ctx.slideImages?.publish ? { publishImage: ctx.slideImages.publish } : {}),
        },
      );
    } catch (err) {
      // 見本に無い名前などは推論が直せる。段を失敗にせず、理由を返す
      if (err instanceof SlidePlanError) return { error: `スライドを作れませんでした: ${err.message}` };
      throw err;
    }
    const mock = ctx.connector.sourceFor(ctx.tenantId) === 'mock';
    // 接続口が会社のテンプレートを使えなかったときは、標準の見た目で作ったと書く（第9.4.2節）
    const used = created.templateApplied === false ? null : template;
    // 標準の見た目で作ったときのデザインの名前（会社のテンプレートを開けずに標準にしたときは既定のデザイン）
    const designName = used ? null : (chosen.design ?? findSlideDesign(DEFAULT_SLIDE_DESIGN_ID))!.name;
    warnings.push(...(created.warnings ?? []));
    const links = created.url
      ? [`開く: ${created.url}`, ...(created.pptxUrl ? [`PowerPoint 形式: ${created.pptxUrl}`] : [])]
      : ['（見本の接続口のため、Google スライドは作っていません。構成をアウトラインとして残しています）'];
    const id = randomUUID();
    await ctx.repo.createArtifact({
      id, runId: ctx.runId, tenantId: ctx.tenantId, kind: 'slides', title: plan.title,
      body: [...links, used ? `テンプレート: ${used.name}` : `デザイン: ${designName}`, '', planOutline(plan), ...(warnings.length ? ['', '---', ...warnings.map((w) => `注意: ${w}`)] : [])].join('\n'),
      createdAt: new Date().toISOString(),
    });
    return {
      artifactId: id, presentationId: created.presentationId, url: created.url, pptxUrl: created.pptxUrl,
      slideCount: created.pages ?? plan.slides.length + 1, template: used?.name ?? null, design: designName, warnings, ...(mock ? { source: 'mock' } : {}),
    };
  },
};

export const RESEARCH_TOOLS: Tool[] = [webResearch, slidesTemplate, slidesCreate];
