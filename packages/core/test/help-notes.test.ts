/**
 * @file ヘルプの会社の補足の単体テスト（仕様書 第6.10.7節）。補足の文の整え方・置き場（空なら消す・会社をまたがない）・秘書の使い方の答えに添えること・
 * 秘書に頼んで補足を書く・消す（管理者だけ。業務の名前か記事の題名から記事を選ぶ）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import {
  BUILTIN_TOOLS, HELP_NOTE_MAX, HelpCatalog, MemoryHelpNoteStore, OFFICIAL_AGENTS, Secretary, ToolRegistry, noteText, parseArticle, readNoteRequest,
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

test('補足の頼みを言い回しから読む（どの記事か・補足の文）', () => {
  assert.deepEqual(readNoteRequest('議事録の作成・共有の説明に「共有先は必ず部署のスペースにする」と補足して'), { topic: '議事録の作成・共有', text: '共有先は必ず部署のスペースにする' });
  assert.deepEqual(readNoteRequest('承認のしかたのヘルプに、5 万円を超えるものは部長が承認すると補足しておいて'), { topic: '承認のしかた', text: '5 万円を超えるものは部長が承認する' });
  assert.deepEqual(readNoteRequest('承認のしかたの補足を消して'), { topic: '承認のしかた', text: '' });
});

test('秘書に頼んで補足を書く・消す: 管理者だけ。業務の名前ならその業務の説明、ほかはヘルプの記事', async () => {
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const minutes = OFFICIAL_AGENTS.find((a) => a.id === 'minutes')!;
  const help = new HelpCatalog([
    parseArticle('---\nid: start-approvals\ntitle: 承認のしかた\naudience: all\ncategory: start\n---\n承認トレイで承認します。'),
  ], [minutes], registry);
  let roles = ['admin'];
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, agents: { disabled: [] } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦', roles }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }), appendAudit: async () => undefined, appendConversation: async () => undefined,
  } as unknown as Repository;
  const llm = { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  const notes = new MemoryHelpNoteStore();
  const secretary = new Secretary({
    repo, llm, connector: {} as never, agents: [minutes], help,
    helpNote: async (t, id) => (await notes.get(t, id))?.text ?? null,
    helpNoteSet: async (t, u, id, text) => notes.set(t, id, text, u),
  });
  const r1 = await secretary.respond('t1', 'u1', '議事録の作成・共有の説明に「共有先は必ず部署のスペースにする」と補足して');
  assert.match(r1.text, /「議事録の作成・共有」に当社の補足を書きました/);
  assert.equal((await notes.get('t1', 'agent-minutes'))?.text, '共有先は必ず部署のスペースにする');
  assert.deepEqual(r1.helpArticles, [{ id: 'agent-minutes', title: '議事録の作成・共有' }]);
  await secretary.respond('t1', 'u1', '承認のしかたのヘルプに「5 万円を超えるものは部長が承認する」と補足して');
  assert.equal((await notes.get('t1', 'start-approvals'))?.text, '5 万円を超えるものは部長が承認する');
  const r3 = await secretary.respond('t1', 'u1', '承認のしかたの補足を消して');
  assert.match(r3.text, /当社の補足を消しました/);
  assert.equal(await notes.get('t1', 'start-approvals'), null);
  // 答えへの「もう少し補足して」は、ヘルプの補足の頼みにしない
  const casual = await secretary.respond('t1', 'u1', 'さっきの答えをもう少し補足して');
  assert.doesNotMatch(casual.text, /当社の補足/);
  assert.equal(notes.rows.size, 1);
  const unknown = await secretary.respond('t1', 'u1', '宇宙旅行の説明に「月に行く」と補足して');
  assert.match(unknown.text, /見つかりませんでした/);
  roles = ['member'];
  const denied = await secretary.respond('t1', 'u1', '承認のしかたのヘルプに「x」と補足して');
  assert.match(denied.text, /管理者だけ/);
  assert.equal(await notes.get('t1', 'start-approvals'), null);
});
