/**
 * @file 秘書が「カテゴリー」がどの機能のものかを見分ける単体テスト（仕様書 第45.17.1節、ADR-0142）。
 *
 * 手がかりがあればそのまま取り次ぐ。手がかりが無く、メールとサイトのどちらもあり得るときは 1 度だけ聞き返し、
 * 答えを取り次ぎの好みとして覚えて、次からは聞かない（三浦さん「わからないときは聞き返して欲しい」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_UPDATE_EDIT, Secretary, type LlmProvider, type Memory, type Repository } from '../src/index.js';

function setup() {
  const memories: Memory[] = [];
  const started: { agentId: string; input: Record<string, unknown> }[] = [];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false, learning: true, excludes: [] } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => memories,
    listRoutingMemories: async () => memories.filter((m) => m.kind === 'routing'),
    createMemory: async (m: Memory) => { memories.push(m); },
    deleteMemory: async (_t: string, _u: string, id: string) => { const i = memories.findIndex((m) => m.id === id); if (i >= 0) memories.splice(i, 1); },
    listUserCompartments: async () => [],
    listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }),
    appendAudit: async () => undefined,
    appendConversation: async () => undefined,
    addLearningCount: async () => undefined,
  } as unknown as Repository;
  const llm = {
    name: 'fake',
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? '';
      if (system.includes('入力を JSON のオブジェクトで返して')) return { text: '{}', tokensUsed: 1 };
      return { text: 'none', tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const s = new Secretary({
    repo, llm, connector: {} as never, agents: [SITE_UPDATE_EDIT],
    startAgent: async (_t: string, _u: string, a: { id: string }, input: Record<string, unknown>) => { started.push({ agentId: a.id, input }); return { runId: `run-${started.length}`, already: false }; },
    startLookup: async () => ({ runId: 'run-lookup', already: false }),
    // メールの画面を使える人（カテゴリーの頼みを、メールのものとしても拾う）
    mail: { store: { categories: async () => [] } } as never,
  });
  return { s, started, memories };
}

test('手がかりのある「カテゴリー」はサイトの更新に取り次ぎ、聞き返さない', async () => {
  const { s, started } = setup();
  const reply = await s.respond('t', 'u1', 'ブログに「旅行」というカテゴリーを作って');
  assert.deepEqual(started.map((x) => x.agentId), [SITE_UPDATE_EDIT.id]);
  assert.doesNotMatch(reply.text, /ですか/);
});

test('手がかりの無い「カテゴリー」は 1 度だけ聞き返し、答えを覚えて、次からは聞かない', async () => {
  const { s, started, memories } = setup();
  const ask = await s.respond('t', 'u1', '採用というカテゴリーを作って');
  assert.equal(ask.text, 'メールのカテゴリーですか、サイト（WordPress）のカテゴリーですか。');
  assert.equal(started.length, 0, '聞き返すあいだは何もしない');
  await s.respond('t', 'u1', 'サイトのほう');
  assert.deepEqual(started.map((x) => x.agentId), [SITE_UPDATE_EDIT.id], '答えを受けて、聞き返した頼みを続ける');
  assert.equal(memories.filter((m) => m.kind === 'routing' && m.agentId === SITE_UPDATE_EDIT.id).length, 1, '答えを取り次ぎの好みとして覚える');
  const again = await s.respond('t', 'u1', 'イベントというカテゴリーを作って');
  assert.doesNotMatch(again.text, /メールのカテゴリーですか/, '2 度目は聞かない');
  assert.equal(started.length, 2);
});
