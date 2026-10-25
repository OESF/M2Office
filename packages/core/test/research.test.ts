/**
 * @file 調べてスライドにまとめる共通ツールの単体テスト。構成の検証、ツールの動き、区画での制限、Gemini の応答の読み取りを確かめる。
 *
 * @see 仕様書 第9.4.2節 調べてスライドにまとめる共通ツール
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentDefinition } from '@m2office/shared';
import {
  BUILTIN_TOOLS, GeminiResearchProvider, MockResearchProvider, MockWorkspaceConnector, ToolRegistry,
  normalizeSlidePlan, planOutline, validateDefinition, pieChartPng, pieChartSvg, type ToolContext,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const SAMPLE_PLAN = JSON.parse(readFileSync(
  new URL('../../../extensions/research-slides/evals/research-slides.json', import.meta.url), 'utf8',
)).cases[0].stub.work.find((c: { name: string }) => c.name === 'slides.create').args;

test('サンプルの構成（表紙を含む 8 ページ）は検証を通る', () => {
  const r = normalizeSlidePlan(SAMPLE_PLAN);
  assert.ok(!('error' in r), JSON.stringify(r));
  if ('error' in r) return;
  assert.equal(r.plan.slides.length + 1, 8);
  assert.deepEqual(r.warnings, []);
  assert.match(planOutline(r.plan), /## 3\. 見本では A が最も多い（BAR）/);
  assert.match(planOutline(r.plan), /（発表者のメモ）/);
});

test('構成の誤りは作らずに理由を返す', () => {
  const bad = (p: unknown) => { const r = normalizeSlidePlan(p); return 'error' in r ? r.error : ''; };
  assert.match(bad({ slides: [{ layout: 'BULLET', title: 'x' }] }), /表紙の題名/);
  assert.match(bad({ title: 't', slides: [{ layout: 'TEXT', title: 'x' }] }), /layout/);
  assert.match(bad({ title: 't', slides: Array.from({ length: 13 }, () => ({ layout: 'BULLET', title: 'x' })) }), /12 枚まで/);
  assert.match(bad({ title: 't', slides: [{ layout: 'CHART', title: 'g', chartType: 'LINE', chartCategories: ['a', 'b'], chartSeries: [{ name: 's', values: [1] }] }] }), /値の数/);
});

test('上限を超えた文字は切り詰め、そのことを注意として残す（黙って捨てない）', () => {
  const r = normalizeSlidePlan({
    title: 't', slides: [{ layout: 'BULLET', title: 'あ'.repeat(40), body: ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n') }],
  });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.plan.slides[0]!.title.length, 30, '見出しは言い切りの 1 文で 30 文字まで');
  assert.equal(r.plan.slides[0]!.body!.split('\n').length, 3, '箇条書きは 3 行まで');
  assert.ok(r.warnings.some((w) => w.includes('題名')) && r.warnings.some((w) => w.includes('3 行')));
});

test('箇条書きの行頭の印は外す（組み立てで付く印と二重にしない）。数の - は残す', () => {
  const r = normalizeSlidePlan({ title: 't', slides: [{ layout: 'BULLET', title: 'b', body: '・MoE の主流化\n• 量子化\n-3% の低下' }] });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.plan.slides[0]!.body, 'MoE の主流化\n量子化\n-3% の低下');
});

test('発表の決まり: 箇条書きは 2 枚まで・同じレイアウトを続けない・文字だけのページは半分まで。合わなければ直し方を返す', () => {
  const bad = (slides: unknown[]) => { const r = normalizeSlidePlan({ title: 't', slides }); return 'error' in r ? r.error : ''; };
  const b = (t: string) => ({ layout: 'BULLET', title: t, body: 'a' });
  const kpi = { layout: 'KPI', title: 'k', stats: [{ value: '1', label: 'x' }] };
  const table = { layout: 'TABLE', title: 't', chartCategories: ['a'], chartSeries: [{ name: 's', values: [1] }] };
  assert.match(bad([b('1'), kpi, b('2'), kpi, b('3')]), /BULLET.*2 枚まで/);
  assert.match(bad([kpi, kpi]), /同じレイアウト/);
  assert.match(bad([b('1'), table, kpi, b('2'), table]), /文字だけのページ.*多すぎます/);
  const n = (x: Record<string, unknown>) => ({ ...x, notes: '話すこと' });
  assert.equal(bad([n(b('1')), n(kpi), n(b('2')), n({ layout: 'STATEMENT', title: '', message: 'まとめ' })]), '');
  assert.match(bad([n(b('1')), kpi, n(b('2'))]), /発表者のメモ.*2 枚目/, '3 枚以上ならすべてのページに発表者のメモを求める');
  // 会社のテンプレートの見本で書いた構成には当てない
  const r = normalizeSlidePlan({ title: 't', slides: [{ layout: '箇条書き', values: { 本文: 'a' } }, { layout: '箇条書き', values: { 本文: 'b' } }] });
  assert.ok(!('error' in r));
});

test('図のレイアウト: 項目の数・数の値・アイコンを確かめる。前の版の CHART は棒グラフ・割合・表に読み替える', () => {
  const one = (s: Record<string, unknown>) => normalizeSlidePlan({ title: 't', slides: [s] });
  const err = (s: Record<string, unknown>) => { const r = one(s); return 'error' in r ? r.error : ''; };
  assert.match(err({ layout: 'STEPS', title: 's', items: [{ title: 'a' }, { title: 'b' }] }), /3 つ以上/);
  assert.match(err({ layout: 'BAR', title: 'b', items: [{ label: 'a', value: 'x' }, { label: 'b', value: 2 }] }), /value/);
  assert.match(err({ layout: 'PROGRESS', title: 'p', items: [{ label: 'a', value: 120 }] }), /0〜100/);
  assert.match(err({ layout: 'BIG_NUMBER', title: 'n' }), /stats/);
  const cards = one({ layout: 'CARDS', title: 'c', items: [{ icon: '🎯', title: 'a', text: 'x' }, { icon: '長すぎるアイコンの文字', title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }] });
  if ('error' in cards) assert.fail(cards.error);
  assert.equal(cards.plan.slides[0]!.items!.length, 4, 'カードは 4 つまで');
  assert.equal(cards.plan.slides[0]!.items![0]!.icon, '🎯');
  assert.equal(cards.plan.slides[0]!.items![1]!.icon, undefined, 'アイコンは絵文字 1 つだけ');
  const pie = one({ layout: 'CHART', title: 'p', chartType: 'PIE', chartCategories: ['a', 'b'], chartSeries: [{ name: 's', values: [70, 30] }] });
  const col = one({ layout: 'CHART', title: 'c', chartType: 'COLUMN', chartCategories: ['a', 'b'], chartSeries: [{ name: 's', values: [1, 2] }] });
  const two = one({ layout: 'CHART', title: 't', chartType: 'LINE', chartCategories: ['a', 'b'], chartSeries: [{ name: 's', values: [1, 2] }, { name: 'u', values: [3, 4] }] });
  if ('error' in pie || 'error' in col || 'error' in two) assert.fail('前の版の CHART を受け付ける');
  assert.equal(pie.plan.slides[0]!.layout, 'SHARE');
  assert.deepEqual([col.plan.slides[0]!.layout, col.plan.slides[0]!.orientation], ['BAR', 'vertical']);
  assert.equal(two.plan.slides[0]!.layout, 'TABLE');
  const statement = one({ layout: 'STATEMENT', title: '', message: '伝えたい一文', notes: '話すこと' });
  if ('error' in statement) assert.fail(statement.error);
  assert.equal(statement.plan.slides[0]!.notes, '話すこと');
});

test('象徴的な画像と円グラフ: デザインの作風で 4 枚まで作り、円グラフは数値から描く。使い捨ての URL の手段を渡す。画像なしも頼める（第9.4.2節「段 2」）', async () => {
  const prompts: { prompt: string; aspect: string }[] = [];
  const png = { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' };
  const withImages = (c: ReturnType<typeof ctx>, fail = false) => Object.assign(c, {
    slideImages: {
      generate: async (prompt: string, aspect: '16:9' | '3:4') => { prompts.push({ prompt, aspect }); if (fail && prompts.length === 2) throw new Error('上限'); return png; },
      publish: async () => ({ url: 'https://example.com/x', done: async () => {} }),
    },
  });
  const plan = {
    title: '見本', notes: '表紙で話すこと', imagePrompt: '朝の港に光が差す情景',
    slides: [
      { layout: 'SECTION', title: '背景', number: '01', imagePrompt: '霧の中の灯台', notes: 'n' },
      { layout: 'SHARE', title: '半分はメール', shareStyle: 'pie', items: [{ label: 'メール', value: 50 }, { label: '電話', value: 50 }], notes: 'n' },
      { layout: 'IMAGE', title: '現場の様子', imagePrompt: '整った作業台', caption: '説明', notes: 'n' },
      { layout: 'SECTION', title: 'まとめ', imagePrompt: '夕焼けの道', notes: 'n' },
      { layout: 'STATEMENT', title: '', message: '小さく始める', imagePrompt: '描かない（図のページ）', notes: 'n' },
    ],
  };
  const c = withImages(ctx(), true);
  const out = await registry.get('slides.create')!.invoke({ ...plan, design: 'ポップ' }, c) as { warnings: string[] };
  assert.equal(prompts.length, 4, '表紙・区切り・画像のページで 4 枚まで（図のページには作らない）');
  assert.deepEqual(prompts.map((x) => x.aspect), ['3:4', '3:4', '16:9', '3:4']);
  assert.ok(prompts.every((x) => x.prompt.includes('明るい平面のイラスト') && x.prompt.includes('文字・数字・ロゴ')), 'デザインの作風と描かないもの');
  assert.ok(out.warnings.some((w) => w.includes('画像を作れませんでした')), '作れなかった画像は注意にする');
  const body = c.connector.outbox.at(-1)!.body as { images: Record<string, unknown>; publishImage?: unknown; plan: { notes?: string; sources?: { title: string }[] } };
  assert.deepEqual(Object.keys(body.images).sort(), ['cover', 'm2slide2_pie', 'm2slide3', 'm2slide4'], '作れた画像と円グラフ');
  assert.ok(body.publishImage, '使い捨ての URL の手段を渡す');
  assert.equal(body.plan.notes, '表紙で話すこと');
  assert.match(body.plan.sources![0]!.title, /AI.*作ったもの/, 'AI の画像を使ったら出典の先頭に書く');
  prompts.length = 0;
  const none = withImages(ctx());
  await registry.get('slides.create')!.invoke({ ...plan, images: false }, none);
  assert.equal(prompts.length, 0, '画像なしで頼めば作らない');
  assert.deepEqual(Object.keys((none.connector.outbox.at(-1)!.body as { images: Record<string, unknown> }).images), ['m2slide2_pie'], '円グラフは AI を使わないので描く');
});

test('円グラフの画像: 値の割合でドーナツ型に描き、すき間は背景の色', () => {
  const svg = pieChartSvg([30, 70], [{ red: 1, green: 0, blue: 0 }, { red: 0, green: 0, blue: 1 }], { red: 0, green: 0, blue: 0 });
  assert.equal((svg.match(/<path/g) ?? []).length, 2);
  assert.ok(svg.includes('#ff0000') && svg.includes('#0000ff') && svg.includes('stroke="#000000"'));
  assert.match(pieChartSvg([5], [{ red: 0, green: 1, blue: 0 }]), /<circle/, '1 つで全体なら輪');
  const png = pieChartPng([1, 2, 3], [{ red: 0.5, green: 0.5, blue: 0.5 }]);
  assert.deepEqual([...png.slice(1, 4)].map((x) => String.fromCharCode(x)).join(''), 'PNG');
});

test('本文を配列で渡されても 1 行ずつの箇条書きとして読む（比較の本文も）', () => {
  const r = normalizeSlidePlan({ title: 't', slides: [
    { layout: 'BULLET', title: 'b', body: ['導入率は 20.4%', '・利用率は 82.6%'] },
    { layout: 'COMPARISON', title: 'c', compareLeftTitle: '事務', compareLeftBody: ['請求書', '議事録'], compareRightTitle: '営業', compareRightBody: '提案書' },
  ] });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.plan.slides[0]!.body, '導入率は 20.4%\n利用率は 82.6%');
  assert.equal(r.plan.slides[1]!.compareLeftBody, '請求書\n議事録');
});

let settingsTemplates: { id: string; name: string; presentationId: string; description: string; isDefault: boolean }[] = [];
let settingsDesign: string | null = null;

function ctx(): ToolContext & { artifacts: { title: string; body: string; kind: string }[]; connector: MockWorkspaceConnector } {
  const artifacts: { title: string; body: string; kind: string }[] = [];
  return {
    tenantId: 't', userId: 'u', runId: 'r', compartment: null, artifacts,
    repo: {
      createArtifact: async (a: { title: string; body: string; kind: string }) => { artifacts.push(a); },
      getTenantSettings: async () => ({ slides: { templates: settingsTemplates, defaultDesign: settingsDesign }, company: { legalName: '株式会社見本', shortName: '見本' } }),
    } as never,
    connector: new MockWorkspaceConnector(), files: {} as never, research: new MockResearchProvider(),
  };
}

test('slides.create: 見本の接続口では、スライドを作らず構成をアウトラインとして成果物に残す', async () => {
  const c = ctx();
  const out = await registry.get('slides.create')!.invoke(SAMPLE_PLAN, c) as Record<string, unknown>;
  assert.equal(out['source'], 'mock');
  assert.equal(out['slideCount'], 8);
  assert.equal(out['url'], null);
  assert.equal(c.artifacts[0]!.kind, 'slides');
  assert.match(c.artifacts[0]!.body, /Google スライドは作っていません/);
  assert.equal(c.connector.outbox.filter((o) => o.kind === 'slides').length, 1);
});

test('slides.create: 会社が登録したテンプレートを使う。名前の指定が無ければ既定、見つからなければ既定にして注意を残す', async () => {
  settingsTemplates = [
    { id: 'a', name: '社内向け', presentationId: 'p-inner-0000000000000000', description: '', isDefault: true },
    { id: 'b', name: '提案書', presentationId: 'p-proposal-00000000000000', description: '', isDefault: false },
  ];
  try {
    const c = ctx();
    const tool = registry.get('slides.create')!;
    await tool.invoke({ ...SAMPLE_PLAN, template: '提案書' }, c);
    await tool.invoke(SAMPLE_PLAN, c);
    const out = await tool.invoke({ ...SAMPLE_PLAN, template: '無い名前' }, c) as { warnings: string[] };
    const used = c.connector.outbox.map((o) => (o.body as { template: { name: string } | null }).template?.name);
    assert.deepEqual(used, ['提案書', '社内向け', '社内向け']);
    assert.ok(out.warnings.some((w) => w.includes('無い名前')));
    assert.match(c.artifacts[0]!.body, /テンプレート: 提案書/);
  } finally {
    settingsTemplates = [];
  }
});

test('組み込みのデザイン: 名前か ID で選び、指定が無ければ会社の既定（デザイン → テンプレートの既定 → ビジネス）。会社名を下の隅に渡す', async () => {
  const tool = registry.get('slides.create')!;
  const designOf = (c: ReturnType<typeof ctx>) => c.connector.outbox.map((o) => {
    const b = o.body as { template: { name: string } | null; design?: { id: string } | null; footer?: string };
    return b.template ? `t:${b.template.name}` : `d:${b.design?.id}:${b.footer}`;
  });
  const c = ctx();
  await tool.invoke({ ...SAMPLE_PLAN, design: 'ナチュラル' }, c);
  await tool.invoke({ ...SAMPLE_PLAN, design: 'dark' }, c);
  const out = await tool.invoke(SAMPLE_PLAN, c) as { design: string; template: string | null };
  assert.deepEqual(designOf(c), ['d:natural:見本', 'd:dark:見本', 'd:business:見本'], '指定が無く登録も無ければビジネス');
  assert.equal(out.design, 'ビジネス');
  assert.equal(out.template, null);
  assert.match(c.artifacts[0]!.body, /デザイン: ナチュラル/);
  settingsTemplates = [{ id: 'a', name: '社内向け', presentationId: 'p-inner-0000000000000000', description: '', isDefault: true }];
  try {
    const c2 = ctx();
    await tool.invoke(SAMPLE_PLAN, c2);
    settingsDesign = 'pop';
    await tool.invoke(SAMPLE_PLAN, c2);
    await tool.invoke({ ...SAMPLE_PLAN, design: '社内向け' }, c2);
    await tool.invoke({ ...SAMPLE_PLAN, template: '社内向け' }, c2);
    assert.deepEqual(designOf(c2), ['t:社内向け', 'd:pop:見本', 't:社内向け', 't:社内向け'], '会社の既定のデザインはテンプレートの既定より先。名前を指せばテンプレート');
    const tpl = await registry.get('slides.template')!.invoke({}, ctx()) as Record<string, unknown>;
    assert.equal(tpl['design'], 'ポップ');
    assert.ok((tpl['choices'] as string[]).includes('クリーン') && (tpl['choices'] as string[]).includes('社内向け'), '選べる名前を推論に渡す');
  } finally {
    settingsTemplates = [];
    settingsDesign = null;
  }
});

test('slides.template: 登録が無ければ標準で構成するよう返す。見本の接続口では読めないことを返す', async () => {
  const tool = registry.get('slides.template')!;
  assert.equal(tool.risk, 'read');
  assert.equal(tool.google?.scope, 'drive');
  const none = await tool.invoke({}, ctx()) as Record<string, unknown>;
  assert.equal(none['template'], null);
  assert.match(String(none['message']), /標準のレイアウト/);
  settingsTemplates = [{ id: 'a', name: '社内向け', presentationId: 'p-inner-0000000000000000', description: '', isDefault: true }];
  try {
    const mock = await tool.invoke({}, ctx()) as Record<string, unknown>;
    assert.equal(mock['template'], '社内向け');
    assert.match(String(mock['message']), /見本の接続口.*標準のレイアウト/);
  } finally {
    settingsTemplates = [];
  }
});

test('構成: 会社のテンプレートの見本の名前は values と一緒なら受け付ける。題名は最初の値から。deck も読む', () => {
  const r = normalizeSlidePlan({
    title: 't', deck: { '{{部署}}': '営業部' },
    slides: [{ layout: '3カード比較', values: { '{{見出し}}': '比べる', 本文: ['a', 'b'] } }],
  });
  if ('error' in r) assert.fail(r.error);
  assert.deepEqual(r.plan.slides[0]!.values, { 見出し: '比べる', 本文: 'a\nb' }, '目印の括弧は外し、配列は行にする');
  assert.equal(r.plan.slides[0]!.title, '比べる');
  assert.deepEqual(r.plan.deck, { 部署: '営業部' });
  const bad = normalizeSlidePlan({ title: 't', slides: [{ layout: '3カード比較' }] });
  assert.ok('error' in bad && /values/.test(bad.error), '見本の名前だけで値が無いものは誤り');
});

test('Google スライドの URL からファイルの ID を取り出す', async () => {
  const { parsePresentationId } = await import('@m2office/shared');
  assert.equal(parsePresentationId('https://docs.google.com/presentation/d/1EVrKerODrfy5b3iKJDfLUCi4pvJZbal0l8uM-0uKqUc/edit#slide=id.p'), '1EVrKerODrfy5b3iKJDfLUCi4pvJZbal0l8uM-0uKqUc');
  assert.equal(parsePresentationId('1EVrKerODrfy5b3iKJDfLUCi4pvJZbal0l8uM-0uKqUc'), '1EVrKerODrfy5b3iKJDfLUCi4pvJZbal0l8uM-0uKqUc');
  assert.equal(parsePresentationId('https://example.com/slides'), null);
});

test('web.research: 見本の調査は、見本であることを明示して返す', async () => {
  const out = await registry.get('web.research')!.invoke({ topic: 'ローカル LLM' }, ctx()) as Record<string, unknown>;
  assert.equal(out['source'], 'mock');
  assert.match(String(out['text']), /実際には調べていません/);
  const none = await registry.get('web.research')!.invoke({ topic: 'x' }, { ...ctx(), research: undefined }) as Record<string, unknown>;
  assert.match(String(none['error']), /^取得できませんでした/);
});

test('権限区画に属する業務では web.research を使えない', () => {
  const def: AgentDefinition = {
    schemaVersion: 1, id: 'hr-research', version: 1, name: 'x', category: 'hr', description: 'x', locale: 'ja-JP',
    compartment: 'hr', inputs: {}, tools: ['web.research'], steps: [{ id: 's', type: 'agent', instruction: 'x' }],
    constraints: [], limits: { maxSteps: 3, maxTokens: 1000, timeoutSec: 60 },
  };
  assert.throws(() => validateDefinition(def, registry), /権限区画に属する業務では web.research/);
  assert.doesNotThrow(() => validateDefinition({ ...def, compartment: null }, registry));
});

test('Gemini の調査: Google 検索を有効にして呼び、本文・出典・検索の言葉を取り出す（思考のパーツは除く）', async () => {
  let seen: Record<string, unknown> = {};
  let key = '';
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const ch of req) body += ch;
    seen = JSON.parse(body);
    key = String(req.headers['x-goog-api-key'] ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '考え中', thought: true }, { text: '調べた結果の文章' }] },
        groundingMetadata: {
          webSearchQueries: ['ローカル LLM 製品'],
          groundingChunks: [{ web: { uri: 'https://example.com/a', title: '記事 A' } }],
        },
      }],
      usageMetadata: { totalTokenCount: 123 },
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const p = new GeminiResearchProvider('k-test', 'm', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const r = await p.research('ローカル LLM');
    assert.equal(key, 'k-test');
    assert.deepEqual(seen['tools'], [{ googleSearch: {} }]);
    assert.equal(r.text, '調べた結果の文章');
    assert.deepEqual(r.sources, [{ title: '記事 A', url: 'https://example.com/a' }]);
    assert.deepEqual(r.queries, ['ローカル LLM 製品']);
    assert.equal(r.tokensUsed, 123);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
