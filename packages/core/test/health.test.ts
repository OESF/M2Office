/**
 * @file 接続先の健全性（記録の足し込み・状態の決め方・推論と Google の記録）の単体テスト。
 *
 * @see 仕様書 第6.7.6節 接続先
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferedHealthSink, healthView, installHealthSink, llmHealthKind, observeLlm, recordHealth,
  type HealthBucket, type HealthStore, type HealthSummary, type LlmProvider,
} from '../src/index.js';
import { LlmRequestError } from '../src/llm/gemini.js';

const now = new Date('2026-10-05T10:00:30.000Z');
const summary = (o: Partial<HealthSummary>): HealthSummary => ({
  target: 'ai', ok: 0, fail: 0, totalMs: 0, lastMinute: '2026-10-05T10:00:00.000Z', lastOk: 0, lastFail: 0, lastError: null, ...o,
});

test('状態: つないでいなければ未接続、呼び出しが無ければ正常', () => {
  assert.equal(healthView(undefined, 'google', false, now).state, 'off');
  const idle = healthView(undefined, 'google', true, now);
  assert.equal(idle.state, 'ok');
  assert.equal(idle.calls, 0);
  assert.equal(idle.active, false);
});

test('状態: 失敗が半分以上か、最後の 1 分がすべて失敗なら失敗。平均が目安を超えれば遅延', () => {
  assert.equal(healthView(summary({ ok: 2, fail: 2, totalMs: 400, lastOk: 1, lastFail: 1, lastError: 'busy' }), 'ai', true, now).state, 'fail');
  assert.equal(healthView(summary({ ok: 9, fail: 1, totalMs: 1000, lastOk: 0, lastFail: 1 }), 'ai', true, now).state, 'fail');
  const slow = healthView(summary({ ok: 4, totalMs: 4 * 4000, lastOk: 1 }), 'google', true, now);
  assert.equal(slow.state, 'slow');
  assert.equal(slow.avgMs, 4000);
  assert.equal(healthView(summary({ ok: 4, totalMs: 4 * 4000, lastOk: 1 }), 'ai', true, now).state, 'ok', 'AI の目安は長い');
});

test('状態: 直近 2 分に呼び出しがあれば動いている表示。失敗の種類は業務の言葉にする', () => {
  const v = healthView(summary({ ok: 3, fail: 1, totalMs: 300, lastOk: 3, lastFail: 1, lastError: 'unreachable' }), 'mcp', true, now);
  assert.equal(v.active, true);
  assert.equal(v.lastError, '届かない');
  assert.equal(healthView(summary({ ok: 1, lastOk: 1, lastMinute: '2026-10-05T09:50:00.000Z' }), 'mcp', true, now).active, false);
});

test('記録は 1 分ごとに足し込み、まとめて置き場へ流す。最後の失敗の種類だけを持つ', async () => {
  const added: HealthBucket[] = [];
  const store: HealthStore = { add: async (b) => { added.push(b); }, summary: async () => [], prune: async () => 0 };
  let t = Date.parse('2026-10-05T10:00:10.000Z');
  const sink = new BufferedHealthSink(store, () => t);
  sink.record('t1', 'ai', true, 100);
  sink.record('t1', 'ai', false, 300, 'busy');
  sink.record('t2', 'ai', true, 50);
  t += 60_000;
  sink.record('t1', 'ai', true, 200);
  assert.equal(await sink.flush(), 3);
  const first = added.find((b) => b.tenantId === 't1' && b.minute === '2026-10-05T10:00:00.000Z')!;
  assert.deepEqual({ ok: first.ok, fail: first.fail, totalMs: first.totalMs, lastError: first.lastError }, { ok: 1, fail: 1, totalMs: 400, lastError: 'busy' });
  assert.equal(await sink.flush(), 0, '流した分は残さない');
});

test('推論の包み: 成否と時間だけを残し、失敗の種類を状態の符号から決める', async () => {
  const seen: { tenantId: string; target: string; ok: boolean; kind?: string }[] = [];
  installHealthSink({ record: (tenantId, target, ok, _ms, kind) => { seen.push({ tenantId, target, ok, ...(kind ? { kind } : {}) }); } });
  try {
    let fail = false;
    const inner: LlmProvider = {
      name: 'gemini',
      complete: async () => {
        if (fail) throw new LlmRequestError('LLM 呼び出しに失敗しました (503)', 'secret body');
        return { text: 'ok', tokensUsed: 1 };
      },
    };
    const llm = observeLlm('t1', inner);
    assert.equal(llm.name, 'gemini');
    assert.equal(llm.readImage, undefined, '持たない操作は持たないまま');
    await llm.complete({ tier: 'fast', messages: [{ role: 'user', content: 'x' }] });
    fail = true;
    await assert.rejects(llm.complete({ tier: 'fast', messages: [{ role: 'user', content: 'x' }] }));
    assert.deepEqual(seen, [{ tenantId: 't1', target: 'ai', ok: true }, { tenantId: 't1', target: 'ai', ok: false, kind: 'server' }]);
    // 設定されていない推論は包まない
    const off: LlmProvider = { name: 'unconfigured', complete: async () => ({ text: '', tokensUsed: 0 }) };
    assert.equal(observeLlm('t1', off), off);
  } finally {
    installHealthSink(null);
  }
});

test('推論の失敗の種類', () => {
  assert.equal(llmHealthKind(new LlmRequestError('x (429)', '')), 'busy');
  assert.equal(llmHealthKind(new LlmRequestError('x (401)', '')), 'auth');
  assert.equal(llmHealthKind(new LlmRequestError('x (404)', '')), 'not-found');
  assert.equal(llmHealthKind(new LlmRequestError('x（届きませんでした）', '')), 'unreachable');
  assert.equal(llmHealthKind(new Error('boom')), 'error');
});

test('受け口が無ければ何もしない。受け口が壊れていても呼び出し側に伝えない', () => {
  installHealthSink(null);
  recordHealth('t', 'ai', true, 1);
  installHealthSink({ record: () => { throw new Error('boom'); } });
  try {
    recordHealth('t', 'ai', true, 1);
  } finally {
    installHealthSink(null);
  }
});
