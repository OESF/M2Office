/**
 * @file 推論が一時的に失敗したときに、同じ鍵のまま別のモデルへ退避することの単体テスト。
 *
 * @see 仕様書 第20.2.5節 失敗したときに別のモデルへ退避する
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LlmRequestError, OpenAiCompatibleProvider, isFallbackStatus, modelCandidates } from '../src/llm/gemini.js';

/** 偽の窓口。モデルごとの状態を返し、呼ばれたモデルと鍵を覚える。 */
async function fakeApi(statusOf: (model: string) => number) {
  const seen: { model: string; auth: string }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req)) as { model: string };
    seen.push({ model: body.model, auth: String(req.headers['authorization'] ?? '') });
    const status = statusOf(body.model);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200
      ? JSON.stringify({ model: body.model, choices: [{ message: { content: `answer from ${body.model}` } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
      : JSON.stringify({ error: { code: status } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const MODELS = { fast: 'm-lite', standard: 'm-lite', advanced: 'm-big' };
const ask = { tier: 'standard' as const, messages: [{ role: 'user' as const, content: 'こんにちは' }] };

test('退避する失敗は、混雑・時間切れ・障害・届かない・モデルが無い。依頼の誤りと鍵の誤りは退避しない', () => {
  for (const s of [null, 404, 408, 429, 500, 502, 503, 504]) assert.equal(isFallbackStatus(s), true, String(s));
  for (const s of [400, 401, 403, 422]) assert.equal(isFallbackStatus(s), false, String(s));
});

test('退避先は設定にあるモデルだけ。退避先の設定を先に、次に高性能・標準・高速。同じ名前は 1 度、3 つまで', () => {
  assert.deepEqual(modelCandidates(MODELS, 'standard'), ['m-lite', 'm-big']);
  assert.deepEqual(modelCandidates(MODELS, 'advanced'), ['m-big', 'm-lite']);
  assert.deepEqual(modelCandidates({ ...MODELS, fallback: 'm-alt' }, 'fast'), ['m-lite', 'm-alt', 'm-big']);
  assert.deepEqual(modelCandidates({ fast: 'a', standard: 'b', advanced: 'c', fallback: 'd' }, 'fast'), ['a', 'd', 'c']);
});

test('混んでいたら、同じ鍵のまま別のモデルで答え、費用は答えたモデルで数える', async () => {
  const api = await fakeApi((m) => (m === 'm-lite' ? 503 : 200));
  const warned: Record<string, unknown>[] = [];
  try {
    const p = new OpenAiCompatibleProvider('key-1', MODELS, api.base, 'gemini', { warn: (_m: string, f?: Record<string, unknown>) => { warned.push(f ?? {}); } });
    const r = await p.complete(ask);
    assert.equal(r.text, 'answer from m-big');
    assert.equal(r.model, 'm-big');
    assert.deepEqual(api.seen.map((s) => s.model), ['m-lite', 'm-big']);
    assert.ok(api.seen.every((s) => s.auth === 'Bearer key-1'), 'ほかの鍵には切り替えない');
    assert.equal(warned.length, 1);
    assert.deepEqual(warned[0], { provider: 'gemini', from: 'm-lite', to: 'm-big', status: 503 });
    assert.ok(!JSON.stringify(warned).includes('こんにちは'), 'ログに依頼の中身を残さない');
  } finally {
    await api.close();
  }
});

test('鍵の誤りでは退避せず、そのまま断る', async () => {
  const api = await fakeApi(() => 401);
  try {
    const p = new OpenAiCompatibleProvider('bad', MODELS, api.base);
    await assert.rejects(p.complete(ask), (e: unknown) => e instanceof LlmRequestError && /401/.test(e.message));
    assert.equal(api.seen.length, 1);
  } finally {
    await api.close();
  }
});

test('すべてのモデルで失敗したら、最後の失敗で断る。呼ぶのは 3 回まで', async () => {
  const api = await fakeApi(() => 429);
  try {
    const p = new OpenAiCompatibleProvider('k', { fast: 'a', standard: 'b', advanced: 'c', fallback: 'd' }, api.base);
    await assert.rejects(p.complete(ask), (e: unknown) => e instanceof LlmRequestError && /429/.test(e.message));
    assert.deepEqual(api.seen.map((s) => s.model), ['b', 'd', 'c']);
  } finally {
    await api.close();
  }
});

test('窓口に届かなくても、別のモデルを試してから断る', async () => {
  const p = new OpenAiCompatibleProvider('k', MODELS, 'http://127.0.0.1:1');
  await assert.rejects(p.complete(ask), (e: unknown) => e instanceof LlmRequestError && /届きませんでした/.test(e.message));
});
