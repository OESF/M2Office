/**
 * @file 言い換えを秘書が考えることの単体テスト。
 *
 * @see 仕様書 第11.7.7.0節、ADR-0028
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPAND_TIMEOUT_MS, expandQuery, expandTerms, extractTerms, parseExpansion, type LlmProvider } from '../src/index.js';

test('応答を言葉の組にする。1 語だけ・長すぎる語は落とす', () => {
  assert.deepEqual(parseExpansion('育休 = 育児休業、育児休暇\n- 給与 = 給料、賃金\n思い付きません\n有給 ='), [
    ['育休', '育児休業', '育児休暇'], ['給与', '給料', '賃金'],
  ]);
});

test('秘書が考えた言い換えで、登録していない言葉でも規程の言葉にたどり着く', async () => {
  const llm: LlmProvider = { name: 'test', complete: async () => ({ text: '育休 = 育児休業', tokensUsed: 3 }) } as never;
  const groups = await expandQuery(llm, '育休中の給与は？');
  const concepts = expandTerms(extractTerms('育休中の給与は？'), groups);
  assert.ok(concepts.some((c) => c.alternatives.includes('育児休業')));
});

test('推論が使えない・遅い・失敗したときは、言い換えなしで探す（探すこと自体は止めない）', async () => {
  const stub: LlmProvider = { name: 'stub', complete: async () => ({ text: '育休 = 育児休業', tokensUsed: 0 }) } as never;
  assert.deepEqual(await expandQuery(stub, '育休'), []);
  const broken: LlmProvider = { name: 'x', complete: async () => { throw new Error('down'); } } as never;
  assert.deepEqual(await expandQuery(broken, '育休'), []);
  const slow: LlmProvider = { name: 'x', complete: () => new Promise(() => undefined) } as never;
  const started = Date.now();
  assert.deepEqual(await expandQuery(slow, '育休'), []);
  assert.ok(Date.now() - started < EXPAND_TIMEOUT_MS + 500);
});
