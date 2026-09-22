/**
 * @file 調べてスライドにまとめる共通ツール（`web.research`・`slides.create`）。
 *
 * 1. 調べる（`web.research`）→ 2. 構成を決める（推論のステップ）→ 3. 組み立てる（`slides.create`）の 3 段の、
 * 1 と 3 を担う。AI Radio の秘書の `create_presentation` を移植した（ADR-0006）。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

import { randomUUID } from 'node:crypto';
import type { Tool } from './registry.js';
import { normalizeSlidePlan, planOutline } from '../slides/plan.js';

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
 * スライドの構成から Google スライドを作り、成果物として記録する。
 *
 * @remarks
 * 危険度: `draft`。依頼した本人のドライブに作り、共有はしない。
 * 構成の形が違えば作らずに理由を返す。上限を超えた文字は切り詰め、そのことを結果に書く。
 * 接続口が見本のときは Google スライドを作らず、構成をアウトラインとして成果物に残す。
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
    + 'template に会社が登録したテンプレートの名前を渡せばそれを、無ければ既定のテンプレートを使う',
  args: { properties: { title: { type: 'string', description: '表紙の題名' }, subtitle: { type: 'string', description: '副題（任意）' }, slides: { type: 'array', description: '本文のスライドの配列（layout・title ほか。12 枚まで）' }, sources: { type: 'array', description: '出典（title・url）の配列' }, template: { type: 'string', description: '会社が登録したテンプレートの名前（任意）' } }, required: ['title', 'slides'] },
  google: { scope: 'drive.file', level: 'non-sensitive' },
  async invoke(args, ctx) {
    const checked = normalizeSlidePlan(args);
    if ('error' in checked) return { error: `スライドを作れませんでした: ${checked.error}` };
    const { plan, warnings } = checked;
    // 会社が登録したテンプレート（第9.4.2節）。名前の指定が無い・見つからなければ既定、登録が無ければ標準
    const { templates } = (await ctx.repo.getTenantSettings(ctx.tenantId)).slides;
    const wanted = typeof args['template'] === 'string' ? args['template'].trim() : '';
    const named = wanted ? templates.find((t) => t.name === wanted) : undefined;
    if (wanted && !named) warnings.push(`テンプレート「${wanted}」が登録されていないため、既定のテンプレートを使いました`);
    const chosen = named ?? templates.find((t) => t.isDefault) ?? null;
    const template = chosen ? { presentationId: chosen.presentationId, name: chosen.name } : null;
    const created = await ctx.connector.slides.createPresentation(
      { tenantId: ctx.tenantId, userId: ctx.userId }, { title: plan.title, plan, template },
    );
    const mock = ctx.connector.source === 'mock';
    const links = created.url
      ? [`開く: ${created.url}`, ...(created.pptxUrl ? [`PowerPoint 形式: ${created.pptxUrl}`] : [])]
      : ['（見本の接続口のため、Google スライドは作っていません。構成をアウトラインとして残しています）'];
    const id = randomUUID();
    await ctx.repo.createArtifact({
      id, runId: ctx.runId, tenantId: ctx.tenantId, kind: 'slides', title: plan.title,
      body: [...links, `テンプレート: ${template ? template.name : '標準のテンプレート'}`, '', planOutline(plan), ...(warnings.length ? ['', '---', ...warnings.map((w) => `注意: ${w}`)] : [])].join('\n'),
      createdAt: new Date().toISOString(),
    });
    return {
      artifactId: id, presentationId: created.presentationId, url: created.url, pptxUrl: created.pptxUrl,
      slideCount: plan.slides.length + 1, template: template?.name ?? '標準', warnings, ...(mock ? { source: 'mock' } : {}),
    };
  },
};

export const RESEARCH_TOOLS: Tool[] = [webResearch, slidesCreate];
