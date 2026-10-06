/**
 * @file ヘルプの会社の補足の単体テスト（仕様書 第6.10.7節）。補足の文の整え方・置き場（空なら消す・会社をまたがない）・秘書の使い方の答えに添えること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import {
  BUILTIN_TOOLS, HELP_NOTE_MAX, HelpCatalog, MemoryHelpNoteStore, Secretary, ToolRegistry, noteText, parseArticle,
  type LlmProvider, type Repository,
} from '../src/index.js';

test('補足の文は前後の空白を除いて 1000 字で切り、空なら消す。会社をまたがない', async () => {
  assert.equal(noteText('  部署のスペースに共有します \r\n'), '部署のスペースに共有します');
  assert.equal(noteText('あ'.repeat(1200)).length, HELP_NOTE_MAX);
  assert.equal(noteText(42), '');
  const store = new MemoryHelpNoteStore();
  await store.set('t1', 'agent-minutes', '当社では、議事録の共有先は必ず部署のスペースにします', 'boss');
  assert.equal((await store.get('t1', 'agent-minutes'))?.text, '当社では、議事録の共有先は必ず部署のスペースにします');
  assert.equal(await store.get('t2', 'agent-minutes'), null);
  await store.set('t1', 'agent-minutes', '', 'boss');
  assert.equal(await store.get('t1', 'agent-minutes'), null);
});

test('秘書: 使い方の答えに、いちばん上の記事の会社の補足を添える（無ければ添えない）', async () => {
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
  const notes = new MemoryHelpNoteStore();
  const secretary = new Secretary({
    repo, llm, connector: {} as never, agents: [], help, helpNote: async (t, id) => (await notes.get(t, id))?.text ?? null,
  });
  const plain = await secretary.respond('t1', 'u1', '承認のしかたは？ どうやって承認するの？');
  assert.doesNotMatch(plain.text, /当社の補足/);
  await notes.set('t1', 'start-approvals', '当社では、5 万円を超えるものは部長が承認します', 'boss');
  const withNote = await secretary.respond('t1', 'u1', '承認のしかたは？ どうやって承認するの？');
  assert.match(withNote.text, /当社の補足: 当社では、5 万円を超えるものは部長が承認します/);
  const other = await secretary.respond('t2', 'u1', '承認のしかたは？ どうやって承認するの？');
  assert.doesNotMatch(other.text, /当社の補足/);
});
