/**
 * @file よく使う業務を決めることの単体テスト（仕様書 第6.1.1節「業務の並び」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FREQUENT, FREQUENT_MAX, pickFrequent } from '../src/index.js';

const NOW = new Date('2026-09-26T00:00:00Z');
const run = (agentId: string, daysAgo = 1) => ({ agentId, startedAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() });
const ALL = ['knowledge-qa', 'minutes', 'inbox-triage', 'scheduling', 'weekly-brief', 'morning-brief', 'meeting-prep', 'reply-followup', 'document-draft', 'sheet-builder', 'slides', 'x:hello'];

test('本人がよく使うものから選び、足りなければ会社、それでも足りなければ標準の組で埋める。最大 6 つ', () => {
  const mine = [run('x:hello'), run('x:hello'), run('sheet-builder')];
  const company = [run('meeting-prep'), run('meeting-prep'), run('minutes')];
  const got = pickFrequent(mine, company, ALL, NOW);
  assert.equal(got.length, FREQUENT_MAX);
  assert.deepEqual(got.slice(0, 4), ['x:hello', 'sheet-builder', 'meeting-prep', 'minutes']);
  assert.ok(got.slice(4).every((id) => DEFAULT_FREQUENT.includes(id)));
});

test('30 日より前の利用は数えない。メニューに出せない業務は選ばない', () => {
  const got = pickFrequent([run('reply-followup', 40), run('secretary-lookup'), run('secretary-lookup')], [], ALL, NOW);
  assert.ok(!got.includes('reply-followup'), '古い利用は数えない');
  assert.ok(!got.includes('secretary-lookup'), 'メニューに無いものは選ばない');
  assert.deepEqual(got, DEFAULT_FREQUENT.filter((id) => ALL.includes(id)));
});

test('使える業務が少なければ、あるものだけを返す', () => {
  assert.deepEqual(pickFrequent([], [], ['knowledge-qa', 'x:hello'], NOW), ['knowledge-qa', 'x:hello']);
});
