/**
 * @file システムログの表の「文」の要約の単体テスト。要求の記録は何の要求かが分かること（仕様書 第16.10.4節）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logSummary } from '../src/log-summary.js';

test('要求の記録は方法・道・結果・時間を並べ、ほかの記録は文と失敗の理由を出す', () => {
  assert.equal(logSummary({ msg: '要求', fields: { method: 'GET', path: '/v1/ops/tenants', status: 200, ms: 12 } }), '要求: GET /v1/ops/tenants → 200（12 ms）');
  assert.equal(logSummary({ msg: '要求', fields: { method: 'POST', path: '/v1/runs' } }), '要求: POST /v1/runs');
  assert.equal(logSummary({ msg: '取り込みに失敗しました', fields: { err: 'timeout' } }), '取り込みに失敗しました: timeout');
  assert.equal(logSummary({ msg: '待ち行列の監視を開始しました', fields: { connector: 'mock' } }), '待ち行列の監視を開始しました');
});
