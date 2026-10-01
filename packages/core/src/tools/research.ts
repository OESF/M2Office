/**
 * @file 調べてスライドにまとめる共通ツール（`web.research`・`slides.template`・`slides.create`）。
 *
 * 1. 調べる（`web.research`）→ 2. 構成を決める（推論のステップ）→ 3. 組み立てる（`slides.create`）の 3 段の、
 * 1 と 3 を担う。AI Radio の秘書の `create_presentation` を移植した（ADR-0006）。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

import { randomUUID } from 'node:crypto';
import type { Tool } from './registry.js';
import { SlidePlanError, normalizeSlidePlan, planOutline } from '../slides/plan.js';

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
 * 使うテンプレートを決める。名前の指定があればそれ、無ければ既定。登録が無ければ `null`（標準）。
 *
 * @returns 選んだテンプレートと、名前が見つからなかったときの注意
 */
async function chooseTemplate(ctx: Parameters<Tool['invoke']>[1], wanted: string) {
  const { templates } = (await ctx.repo.getTenantSettings(ctx.tenantId)).slides;
  const named = wanted ? templates.find((t) => t.name === wanted) : undefined;
  const chosen = named ?? templates.find((t) => t.isDefault) ?? null;
  return {
    template: chosen ? { presentationId: chosen.presentationId, name: chosen.name } : null,
    warning: wanted && !named ? `テンプレート「${wanted}」が登録されていないため、既定のテンプレートを使いました` : null,
  };
}

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
    + 'deck にマスターの変数の値を書き、表紙も見本の 1 枚として構成に入れる。引数: template（テンプレートの名前。任意。無ければ既定）',
  args: { properties: { template: { type: 'string', description: 'テンプレートの名前（任意）' } } },
  google: { scope: 'drive', level: 'restricted' },
  async invoke(args, ctx) {
    const { template, warning } = await chooseTemplate(ctx, typeof args['template'] === 'string' ? args['template'].trim() : '');
    if (!template) return { template: null, message: `会社のテンプレートは登録されていません。${USE_STANDARD}` };
    const blocked = await missingDriveGrant(ctx, template.name);
    if (blocked) return { template: template.name, message: `${blocked}。${USE_STANDARD}` };
    const got = await ctx.connector.slides.readTemplate({ tenantId: ctx.tenantId, userId: ctx.userId }, template);
    if (!got) return { template: template.name, source: 'mock', message: `見本の接続口のため、テンプレートを読めません。${USE_STANDARD}` };
    if ('unavailable' in got) return { template: template.name, message: `${got.unavailable}。${USE_STANDARD}` };
    if (got.layouts.length === 0) return { template: template.name, message: `テンプレートに見本のスライドがありません。${USE_STANDARD}` };
    return {
      template: template.name,
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
  description: 'スライドの構成（title・subtitle・slides[]・sources[]）から Google スライドを作る。'
    + 'slides[] の各要素は layout（BULLET・COMPARISON・KPI・CHART・IMAGE）と title（20 文字まで）、'
    + 'BULLET は body（改行区切りで 6 行まで）、COMPARISON は compareLeftTitle・compareLeftBody・compareRightTitle・compareRightBody、'
    + 'KPI は stats（value と label、3 件まで）、CHART は chartType・chartCategories・chartSeries（name と values、2 系列まで）、'
    + 'IMAGE は imagePrompt と caption。takeaway は伝えたいこと 1 文。本文のスライドは 12 枚まで。'
    + '会社のテンプレートがあるときは slides.template で見本を確かめ、layout に見本の名前、values に差し込み口ごとの値、deck にマスターの変数の値を書く。'
    + 'template に会社が登録したテンプレートの名前を渡せばそれを、無ければ既定のテンプレートを使う',
  args: { properties: { title: { type: 'string', description: '表紙の題名' }, subtitle: { type: 'string', description: '副題（任意）' }, slides: { type: 'array', description: '本文のスライドの配列（layout・title ほか。12 枚まで）' }, sources: { type: 'array', description: '出典（title・url）の配列' }, template: { type: 'string', description: '会社が登録したテンプレートの名前（任意）' } }, required: ['title', 'slides'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  // 会社のテンプレートを本人のドライブへ複製するため（仕様書 第9.4.2節、Q-88）
  googleAlso: [{ scope: 'drive', level: 'restricted' }],
  async invoke(args, ctx) {
    const checked = normalizeSlidePlan(args);
    if ('error' in checked) return { error: `スライドを作れませんでした: ${checked.error}` };
    const { plan, warnings } = checked;
    // 会社が登録したテンプレート（第9.4.2節）。名前の指定が無い・見つからなければ既定、登録が無ければ標準
    const chosen = await chooseTemplate(ctx, typeof args['template'] === 'string' ? args['template'].trim() : '');
    if (chosen.warning) warnings.push(chosen.warning);
    const blocked = chosen.template ? await missingDriveGrant(ctx, chosen.template.name) : null;
    if (blocked) warnings.push(blocked);
    const template = blocked ? null : chosen.template;
    // マスターの {{会社名}} などは、構成に値が無ければ会社情報で埋める（第9.4.2節）
    const { company } = await ctx.repo.getTenantSettings(ctx.tenantId);
    const deckDefaults = { 会社名: company.legalName, 会社の略称: company.shortName || company.legalName };
    let created;
    try {
      created = await ctx.connector.slides.createPresentation(
        { tenantId: ctx.tenantId, userId: ctx.userId }, { title: plan.title, plan, template, deckDefaults },
      );
    } catch (err) {
      // 見本に無い名前などは推論が直せる。段を失敗にせず、理由を返す
      if (err instanceof SlidePlanError) return { error: `スライドを作れませんでした: ${err.message}` };
      throw err;
    }
    const mock = ctx.connector.sourceFor(ctx.tenantId) === 'mock';
    // 接続口が会社のテンプレートを使えなかったときは、標準の見た目で作ったと書く（第9.4.2節）
    const used = created.templateApplied === false ? null : template;
    warnings.push(...(created.warnings ?? []));
    const links = created.url
      ? [`開く: ${created.url}`, ...(created.pptxUrl ? [`PowerPoint 形式: ${created.pptxUrl}`] : [])]
      : ['（見本の接続口のため、Google スライドは作っていません。構成をアウトラインとして残しています）'];
    const id = randomUUID();
    await ctx.repo.createArtifact({
      id, runId: ctx.runId, tenantId: ctx.tenantId, kind: 'slides', title: plan.title,
      body: [...links, `テンプレート: ${used ? used.name : '標準のテンプレート'}`, '', planOutline(plan), ...(warnings.length ? ['', '---', ...warnings.map((w) => `注意: ${w}`)] : [])].join('\n'),
      createdAt: new Date().toISOString(),
    });
    return {
      artifactId: id, presentationId: created.presentationId, url: created.url, pptxUrl: created.pptxUrl,
      slideCount: created.pages ?? plan.slides.length + 1, template: used?.name ?? '標準', warnings, ...(mock ? { source: 'mock' } : {}),
    };
  },
};

export const RESEARCH_TOOLS: Tool[] = [webResearch, slidesTemplate, slidesCreate];
