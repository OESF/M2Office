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
  normalizeSlidePlan, planOutline, validateDefinition, type ToolContext,
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
  assert.match(planOutline(r.plan), /## 5\. グラフの例（見本）（CHART）/);
});

test('構成の誤りは作らずに理由を返す', () => {
  const bad = (p: unknown) => { const r = normalizeSlidePlan(p); return 'error' in r ? r.error : ''; };
  assert.match(bad({ slides: [{ layout: 'BULLET', title: 'x' }] }), /表紙の題名/);
  assert.match(bad({ title: 't', slides: [{ layout: 'TABLE', title: 'x' }] }), /layout/);
  assert.match(bad({ title: 't', slides: Array.from({ length: 13 }, () => ({ layout: 'BULLET', title: 'x' })) }), /12 枚まで/);
  assert.match(bad({ title: 't', slides: [{ layout: 'CHART', title: 'g', chartType: 'LINE', chartCategories: ['a', 'b'], chartSeries: [{ name: 's', values: [1] }] }] }), /値の数/);
});

test('上限を超えた文字は切り詰め、そのことを注意として残す（黙って捨てない）', () => {
  const r = normalizeSlidePlan({
    title: 't', slides: [{ layout: 'BULLET', title: 'あ'.repeat(30), body: ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n') }],
  });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.plan.slides[0]!.title.length, 20);
  assert.equal(r.plan.slides[0]!.body!.split('\n').length, 6);
  assert.ok(r.warnings.some((w) => w.includes('題名')) && r.warnings.some((w) => w.includes('6 行')));
});

test('箇条書きの行頭の印は外す（組み立てで付く印と二重にしない）。数の - は残す', () => {
  const r = normalizeSlidePlan({ title: 't', slides: [{ layout: 'BULLET', title: 'b', body: '・MoE の主流化\n- 量子化\n• 小型化\n-3% の低下' }] });
  if ('error' in r) assert.fail(r.error);
  assert.equal(r.plan.slides[0]!.body, 'MoE の主流化\n量子化\n小型化\n-3% の低下');
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

function ctx(): ToolContext & { artifacts: { title: string; body: string; kind: string }[]; connector: MockWorkspaceConnector } {
  const artifacts: { title: string; body: string; kind: string }[] = [];
  return {
    tenantId: 't', userId: 'u', runId: 'r', compartment: null, artifacts,
    repo: {
      createArtifact: async (a: { title: string; body: string; kind: string }) => { artifacts.push(a); },
      getTenantSettings: async () => ({ slides: { templates: settingsTemplates } }),
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
