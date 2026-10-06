/**
 * @file ヘルプを育てることの単体テスト（仕様書 第6.10.10節）。見つからなかった質問をまとめて件数にし（質問した人を持たない）、90 日で消す・
 * 役に立ったかは 1 人 1 つで押し直せば置き換える・秘書がヘルプに見当たらなかった使い方の質問だけを残す。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import {
  BUILTIN_TOOLS, HelpCatalog, HelpFeedback, MemoryHelpFeedbackStore, Secretary, ToolRegistry, missKey, parseArticle, summarizeMisses, summarizeRatings,
  type LlmProvider, type Repository,
} from '../src/index.js';

test('見つからなかった質問: 言い方の小さな違いはまとめ、多い順・新しい順に並べる', () => {
  assert.equal(missKey('承認の取り消しはどうやるの？'), missKey('承認の取り消しは どうやるの?'));
  const rows = [
    { question: '承認の取り消しはどうやるの？', createdAt: '2026-10-01T00:00:00Z' },
    { question: '請求書の宛名を変えるには', createdAt: '2026-10-03T00:00:00Z' },
    { question: '承認の取り消しは どうやるの?', createdAt: '2026-10-02T00:00:00Z' },
  ];
  assert.deepEqual(summarizeMisses(rows), [
    { question: '承認の取り消しは どうやるの?', count: 2, lastAt: '2026-10-02T00:00:00Z' },
    { question: '請求書の宛名を変えるには', count: 1, lastAt: '2026-10-03T00:00:00Z' },
  ]);
  assert.deepEqual(summarizeRatings([
    { articleId: 'a', helpful: true }, { articleId: 'b', helpful: false }, { articleId: 'b', helpful: true }, { articleId: 'a', helpful: true },
  ]), [{ articleId: 'b', helpful: 1, notHelpful: 1 }, { articleId: 'a', helpful: 2, notHelpful: 0 }]);
});

test('残し方: 質問した人を持たず 200 字で切り、90 日で消す。役に立ったかは 1 人 1 つで押し直せば置き換える。会社をまたがない', async () => {
  let clock = new Date('2026-10-06T00:00:00Z');
  const store = new MemoryHelpFeedbackStore();
  store.now = () => clock;
  const fb = new HelpFeedback(store, () => clock);
  await fb.miss('t1', `  ${'あ'.repeat(250)}  `);
  await fb.miss('t1', '   ');
  assert.equal(store.missRows.length, 1);
  assert.equal(store.missRows[0]!.question.length, 200);
  assert.deepEqual(Object.keys(store.missRows[0]!).sort(), ['createdAt', 'question', 'tenantId']);
  clock = new Date('2027-01-05T00:00:00Z');
  await fb.miss('t1', '新しい質問');
  const s = await fb.summary('t1');
  assert.deepEqual(s.misses.map((m) => m.question), ['新しい質問']);
  await fb.rate('t1', 'u1', 'start-screen', 'article', false);
  await fb.rate('t1', 'u1', 'start-screen', 'article', true);
  await fb.rate('t1', 'u2', 'start-screen', 'secretary', false);
  await fb.rate('t2', 'u9', 'start-screen', 'article', false);
  assert.deepEqual((await fb.summary('t1')).ratings, [{ articleId: 'start-screen', helpful: 1, notHelpful: 1 }]);
  assert.deepEqual((await fb.summary('t2')).misses, []);
});

test('秘書: 使い方の質問でヘルプに当たる記事が無いときだけ、質問を残す（名前は渡さない）', async () => {
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const help = new HelpCatalog([
    parseArticle('---\nid: start-approvals\ntitle: 承認のしかた\naudience: all\ncategory: start\n---\n承認トレイで承認します。'),
  ], [], registry);
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, agents: { disabled: [] } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦', roles: ['member'] }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }), appendAudit: async () => undefined, appendConversation: async () => undefined,
  } as unknown as Repository;
  const llm = { name: 'fake', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  const missed: { tenantId: string; question: string }[] = [];
  const secretary = new Secretary({ repo, llm, connector: {} as never, agents: [], help, helpMiss: async (tenantId, question) => { missed.push({ tenantId, question }); } });
  const hit = await secretary.respond('t1', 'u1', '承認のしかたは？ どうやって承認するの？');
  assert.match(hit.text, /承認のしかた/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(missed.length, 0);
  const miss = await secretary.respond('t1', 'u1', '宇宙船の操縦はどうやってするの？');
  assert.match(miss.text, /見当たりませんでした/);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(missed, [{ tenantId: 't1', question: '宇宙船の操縦はどうやってするの？' }]);
});
