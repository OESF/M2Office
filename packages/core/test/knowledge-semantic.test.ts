/**
 * @file 知識の意味の検索の単体テスト（仕様書 第11.7.6節、ADR-0009）。
 *
 * 順位の融合（RRF）の並べ方と見つけ方の表示、見本の埋め込みが言い換えだけを近いとみなすこと、
 * Gemini とローカル AI の埋め込みの呼び方、質問を埋め込めないときに言葉の検索に戻ること、後から埋め込む見回りを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EMBEDDING_DIMENSIONS, KnowledgeEmbedder, LocalLlmProvider, OpenAiCompatibleProvider, SEMANTIC_THRESHOLD, StubLlmProvider,
  fuseRankings, queryEmbedder, semanticSearchEnabled, stubEmbedding, type LlmProvider, type Repository,
} from '../src/index.js';

const cos = (a: number[], b: number[]) => a.reduce((n, x, i) => n + x * b[i]!, 0);

test('順位の融合: 両方に出た節を上にし、社内規程を先にする。見つけ方を示す', () => {
  const s = (id: string, category: 'rule' | 'learned' = 'rule') => ({ id, category });
  const fused = fuseRankings([s('a'), s('b'), s('l', 'learned')], [s('c'), s('b'), s('l', 'learned')], (x) => x.id);
  assert.deepEqual(fused.map((x) => x.id), ['b', 'a', 'c', 'l']);
  assert.deepEqual(fused.map((x) => x.matchedBy), ['both', 'words', 'meaning', 'both']);
  // 片方だけなら、その片方の分だけ（1 ÷ (60 + 順位)）
  assert.equal(fused.find((x) => x.id === 'a')!.fused, 1 / 61);
  assert.deepEqual(fuseRankings([], [], (x: { id: string }) => x.id), []);
});

test('見本の埋め込み: 決まった言い換えだけを近いとみなし、関係のない文は遠い', () => {
  const q = stubEmbedding('出張の宿代はいくらまで？');
  const hit = stubEmbedding('出張旅費規程 › 第5条（宿泊費） | 宿泊費は 1 泊 12,000 円を上限とする。');
  const other = stubEmbedding('就業規則 › 第10条（服装） | 社員は清潔な服装で勤務しなければならない。');
  assert.equal(q.length, EMBEDDING_DIMENSIONS);
  assert.ok(cos(q, hit) >= SEMANTIC_THRESHOLD, `近い: ${cos(q, hit)}`);
  assert.ok(cos(q, other) < SEMANTIC_THRESHOLD, `遠い: ${cos(q, other)}`);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-9);
});

/** 埋め込みの口の見本のサーバー。 */
async function fakeServer(reply: (path: string, body: any) => unknown) {
  const seen: { path: string; body: any; headers: IncomingMessage['headers'] }[] = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      seen.push({ path: req.url ?? '', body, headers: req.headers });
      const out = reply(req.url ?? '', body);
      res.writeHead(out === null ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? { error: 'x' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('Gemini の埋め込み: batchEmbedContents に 768 次元で、節と質問を別の書き方で送る', async () => {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0.01);
  const srv = await fakeServer((_p, body) => ({ embeddings: body.requests.map(() => ({ values: v })) }));
  try {
    const llm = new OpenAiCompatibleProvider('key-1', { fast: 'f', standard: 's', advanced: 'a' }, `${srv.base}/v1beta/openai`);
    const doc = await llm.embed({ items: [{ title: '就業規則 › 第34条（育児休業）', text: '子を養育する従業員は' }], kind: 'document' });
    assert.equal(srv.seen[0]!.path, '/v1beta/models/gemini-embedding-2:batchEmbedContents');
    assert.equal(srv.seen[0]!.headers['x-goog-api-key'], 'key-1');
    const req = srv.seen[0]!.body.requests[0];
    assert.equal(req.outputDimensionality, EMBEDDING_DIMENSIONS);
    assert.equal(req.content.parts[0].text, 'title: 就業規則 › 第34条（育児休業） | text: 子を養育する従業員は');
    assert.equal(doc.model, 'gemini:gemini-embedding-2');
    await llm.embed({ items: [{ text: '育休はいつまで？' }], kind: 'query' });
    assert.equal(srv.seen[1]!.body.requests[0].content.parts[0].text, 'task: search result | query: 育休はいつまで？');
  } finally {
    await srv.close();
  }
});

test('ローカル AI の埋め込み: 埋め込みのモデルがあるときだけ /embeddings を呼ぶ。次元が違えば断る', async () => {
  let dims = EMBEDDING_DIMENSIONS;
  const srv = await fakeServer((_p, body) => ({ data: body.input.map((_: string, i: number) => ({ index: i, embedding: new Array(dims).fill(0.1) })), usage: { prompt_tokens: 7 } }));
  try {
    assert.equal(new LocalLlmProvider({ baseUrl: srv.base, models: { fast: 'm', standard: 'm', advanced: 'm' } }).embed, undefined);
    const local = new LocalLlmProvider({ baseUrl: srv.base, models: { fast: 'm', standard: 'm', advanced: 'm' }, embedModel: 'embeddinggemma' });
    const out = await local.embed!({ items: [{ text: '残業' }], kind: 'query' });
    assert.equal(srv.seen[0]!.path, '/embeddings');
    assert.deepEqual(srv.seen[0]!.body, { model: 'embeddinggemma', input: ['task: search result | query: 残業'] });
    assert.equal(out.model, 'local:embeddinggemma');
    assert.equal(out.inputTokens, 7);
    dims = 1024;
    await assert.rejects(local.embed!({ items: [{ text: '残業' }], kind: 'query' }), /768 次元/);
  } finally {
    await srv.close();
  }
});

test('質問を埋め込めなければ null（言葉の検索だけで答える）。埋め込みを持たない推論では使わない', async () => {
  const failing = { name: 'x', complete: async () => ({ text: '', tokensUsed: 0 }), embed: async () => { throw new Error('down'); } } as LlmProvider;
  const warned: string[] = [];
  assert.equal(await queryEmbedder(failing, { warn: (m: string) => { warned.push(m); } })!('育休'), null);
  assert.equal(warned.length, 1);
  assert.equal(queryEmbedder({ name: 'x', complete: async () => ({ text: '', tokensUsed: 0 }) }), undefined);
  assert.equal(queryEmbedder({ name: 'unconfigured', complete: async () => ({ text: '', tokensUsed: 0 }), embed: failing.embed }), undefined);
  const ok = await queryEmbedder(new StubLlmProvider())!('残業の上限');
  assert.equal(ok!.model, 'stub:concepts-1');
  // 本番では、評価で確かめてから入れる（既定は切り）
  assert.equal(queryEmbedder(new StubLlmProvider(), undefined, () => false), undefined);
  assert.equal(semanticSearchEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(semanticSearchEnabled({ NODE_ENV: 'production', KNOWLEDGE_SEMANTIC: 'on' }), true);
  assert.equal(semanticSearchEnabled({}), true);
  assert.equal(semanticSearchEnabled({ KNOWLEDGE_SEMANTIC: 'off' }), false);
});

test('後から埋め込む見回り: 待つ節を埋め込み、失敗したらやり直しの時刻を付け、モデルが替われば作り直しに戻す', async () => {
  const pending = [{ itemId: 'k1', ordinal: 0, title: '経費規程 › 第2条', body: '宿泊費は実費とする' }];
  const saved: { model: string; n: number }[] = [];
  const failed: string[] = [];
  const reset: string[] = [];
  let queue = [...pending];
  const repo = {
    listTenantIds: async () => ['t1', 't2'],
    knowledgeEmbedPending: async (t: string) => (t === 't1' ? queue : []),
    saveKnowledgeEmbeddings: async (_t: string, rows: unknown[], model: string) => { saved.push({ model, n: rows.length }); queue = []; },
    failKnowledgeEmbeddings: async (_t: string, _k: unknown, at: string) => { failed.push(at); },
    resetKnowledgeEmbeddings: async (t: string, model: string) => { reset.push(`${t}:${model}`); return 0; },
  } as unknown as Repository;
  let broken = true;
  const llm = new StubLlmProvider();
  const flaky = { name: 'stub', complete: llm.complete.bind(llm), embed: async (r: Parameters<StubLlmProvider['embed']>[0]) => { if (broken) throw new Error('down'); return llm.embed(r); } } as LlmProvider;
  const e = new KnowledgeEmbedder({ repo, llmFor: async (t) => (t === 't1' ? flaky : { name: 'unconfigured', complete: llm.complete.bind(llm) }) });
  assert.deepEqual(await e.tick(), { embedded: 0, failed: 1 });
  assert.equal(failed.length, 1);
  assert.ok(Date.parse(failed[0]!) > Date.now());
  broken = false;
  assert.deepEqual(await e.tick(), { embedded: 1, failed: 0 });
  assert.deepEqual(saved, [{ model: 'stub:concepts-1', n: 1 }]);
  // 待つ節が無くなったら、ほかのモデルの埋め込みを作り直しの待ちに戻す（埋め込みを持たない会社は何もしない）
  await e.tick();
  assert.deepEqual(reset, ['t1:stub:concepts-1']);
});
