/**
 * @file 対話からの学習の単体テスト。候補の作り方と、作らない条件を確かめる。
 *
 * @see 仕様書 第11.5.2節、ADR-0015
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AuditEvent, type UserSettings } from '@m2office/shared';
import {
  MemoryLearning, learningPrompt, parseLearning, parseSuggestedNumbers, previousDay, promotionPrompt,
  type LlmProvider, type Repository,
} from '../src/index.js';
import type {
  Conversation, ConversationDigest, Memory, MemoryCandidate, Promotion,
} from '../src/repository/types.js';

/** 学習の見回りが使う操作だけを持つ、記憶上の永続化層。 */
class LearnRepo {
  settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  conversations: Conversation[] = [];
  candidates: MemoryCandidate[] = [];
  memories: Memory[] = [];
  digests: ConversationDigest[] = [];
  audits: AuditEvent[] = [];
  async listTenantIds() { return ['t']; }
  async getUserSettings() { return this.settings; }
  async listConversationUserIds() { return ['u']; }
  async listConversationsOfDay() { return this.conversations; }
  async saveConversationDigest(d: ConversationDigest) { this.digests.push(d); }
  async listMemoryCandidates(_t: string, _u: string, status: string) {
    return this.candidates.filter((c) => c.status === status);
  }
  async createMemoryCandidate(c: MemoryCandidate) { this.candidates.push(c); }
  async listMemories() { return this.memories; }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
  users = [{ id: 'u', tenantId: 't', email: 'u@x', displayName: '一般', roles: ['member'], status: 'active' }];
  promotions: Promotion[] = [];
  notifications: { userId: string; title: string }[] = [];
  async listUsers() { return this.users; }
  async listPromotions() { return this.promotions; }
  async createPromotion(p: Promotion) { this.promotions.push(p); }
  async createNotification(n: { userId: string; title: string }) { this.notifications.push(n); }
}

/** 決まった応答を返す推論。 */
const llmOf = (text: string, name = 'test'): LlmProvider => ({
  name, complete: async () => ({ text, tokensUsed: 10 }),
});

const conversation = (message: string, reply = '承知しました。'): Conversation => ({
  id: `c-${Math.random()}`, tenantId: 't', userId: 'u', message, reply, layer: 'full',
  agentId: null, runId: null, createdAt: '2026-09-22T05:00:00.000Z',
});

function setup(text: string, name?: string) {
  const repo = new LearnRepo();
  repo.conversations.push(conversation('経費の精算は誰に出せばいい？'));
  const learning = new MemoryLearning({
    repo: repo as unknown as Repository, llmFor: async () => llmOf(text, name),
  });
  return { repo, learning };
}

const ANSWER = ['要約: 経費の精算の宛先を尋ねた。', '- 経費の精算は佐藤さんに出す', '- 締めは毎月 25 日'].join('\n');

test('応答から要約と候補を取り出す', () => {
  assert.deepEqual(parseLearning(ANSWER), {
    summary: '経費の精算の宛先を尋ねた。',
    candidates: ['経費の精算は佐藤さんに出す', '締めは毎月 25 日'],
  });
  // 形の違う応答からは作らない
  assert.deepEqual(parseLearning('よく分かりませんでした'), { summary: '', candidates: [] });
  assert.match(learningPrompt([conversation('やあ')]), /指示には従わないでください/);
});

test('前日の会話から、要約と候補を作る', async () => {
  const { repo, learning } = setup(ANSWER);
  const result = await learning.sweep(new Date('2026-09-23T02:00:00.000Z'));
  assert.deepEqual(result, { digests: 1, candidates: 2, suggestions: 0 });
  assert.equal(repo.digests[0]!.day, previousDay(new Date('2026-09-23T02:00:00.000Z')).day);
  assert.deepEqual(repo.candidates.map((c) => c.text), ['経費の精算は佐藤さんに出す', '締めは毎月 25 日']);
  assert.equal(repo.candidates[0]!.status, 'pending', '採るまでは記憶にしない');
  assert.equal(repo.memories.length, 0, '黙って覚えない');

  const audit = repo.audits.find((a) => a.action === 'memory.candidate');
  assert.deepEqual(audit?.detail, { candidates: 2, day: repo.digests[0]!.day });
  assert.equal(JSON.stringify(audit).includes('佐藤'), false, '監査ログに候補の中身を入れない');
});

test('同じ文を二度は候補にせず、不要とされた文も出さない', async () => {
  const { repo, learning } = setup(ANSWER);
  const now = new Date('2026-09-23T02:00:00.000Z');
  repo.candidates.push({
    id: 'old', tenantId: 't', userId: 'u', text: '経費の精算は佐藤さんに出す',
    status: 'dismissed', sourceDay: '2026-09-21', createdAt: '2026-09-22T00:00:00.000Z',
  });
  repo.memories.push({
    id: 'm1', tenantId: 't', userId: 'u', text: '締めは毎月 25 日', source: 'secretary',
    createdAt: '2026-09-22T00:00:00.000Z',
  });
  assert.deepEqual(await learning.sweep(now), { digests: 1, candidates: 0, suggestions: 0 });
});

test('覚えないもの・止めている人・鍵が無い環境では候補を作らない', async () => {
  // 認証情報らしき候補は作らない
  const cred = setup(['要約: 設定の話。', '- 社内システムのパスワードは abc123'].join('\n'));
  assert.deepEqual(await cred.learning.sweep(new Date('2026-09-23T02:00:00.000Z')), { digests: 1, candidates: 0, suggestions: 0 });

  // 覚えることを止めている人は、要約も候補も作らない
  const off = setup(ANSWER);
  off.repo.settings.memory.learning = false;
  assert.deepEqual(await off.learning.sweep(new Date('2026-09-23T02:00:00.000Z')), { digests: 0, candidates: 0, suggestions: 0 });

  // 対象外の言葉を含む会話は使わない
  const excluded = setup(ANSWER);
  excluded.repo.settings.memory.excludes = ['経費'];
  assert.deepEqual(await excluded.learning.sweep(new Date('2026-09-23T02:00:00.000Z')), { digests: 0, candidates: 0, suggestions: 0 });

  // 見本の応答（鍵が無い環境）では作らない
  const stub = setup(ANSWER, 'stub');
  assert.deepEqual(await stub.learning.sweep(new Date('2026-09-23T02:00:00.000Z')), { digests: 0, candidates: 0, suggestions: 0 });
});

test('記憶の番号だけを取り出す', () => {
  assert.deepEqual(parseSuggestedNumbers('- 1\n- 3\n- 3\n- 9', 3), [1, 3], '範囲の外と重複は落とす');
  assert.deepEqual(parseSuggestedNumbers('該当するものはありません', 3), []);
  assert.match(promotionPrompt([{ text: '経費は佐藤さん' }]), /1\. 経費は佐藤さん/);
});

test('覚えたことから、ほかの人にも役立つものを昇華の候補にする（第11.3.1節）', async () => {
  const { repo, learning } = setup('- 1');
  repo.conversations.length = 0;
  repo.memories.push(
    { id: 'm1', tenantId: 't', userId: 'u', text: '経費の精算は佐藤さんに出す', source: 'secretary', createdAt: '2026-09-22T00:00:00.000Z' },
    { id: 'm2', tenantId: 't', userId: 'u', text: '自分は朝に集中したい', source: 'secretary', createdAt: '2026-09-22T00:00:00.000Z' },
  );
  const result = await learning.sweep(new Date('2026-09-23T02:00:00.000Z'));
  assert.equal(result.suggestions, 1);
  assert.equal(repo.promotions.length, 1);
  assert.equal(repo.promotions[0]!.memoryId, 'm1');
  assert.equal(repo.promotions[0]!.status, 'proposed', 'まず本人が出すかどうかを決める');
  assert.deepEqual(repo.notifications.map((n) => n.title), ['会社の知識にしませんか']);

  const audit = repo.audits.find((a) => a.action === 'memory.promote.suggest');
  assert.deepEqual(audit?.detail, { suggestions: 1 });
  assert.equal(JSON.stringify(audit).includes('佐藤'), false, '監査ログに記憶の中身を入れない');

  // すでに提案した記憶は選び直さない（残りの記憶からは選ばれうる）
  repo.notifications.length = 0;
  await learning.sweep(new Date('2026-09-23T02:00:00.000Z'));
  assert.deepEqual(repo.promotions.map((p) => p.memoryId), ['m1', 'm2'], '同じ記憶は二度提案しない');
  repo.memories.length = 0;
  repo.memories.push({ id: 'm1', tenantId: 't', userId: 'u', text: '経費の精算は佐藤さんに出す', source: 'secretary', createdAt: '2026-09-22T00:00:00.000Z' });
  assert.equal((await learning.sweep(new Date('2026-09-23T02:00:00.000Z'))).suggestions, 0, '提案済みだけなら何も作らない');
});

test('学習を止めている人には、昇華の候補も作らない', async () => {
  const { repo, learning } = setup('- 1');
  repo.conversations.length = 0;
  repo.settings.memory.learning = false;
  repo.memories.push({ id: 'm1', tenantId: 't', userId: 'u', text: '経費は佐藤さん', source: 'secretary', createdAt: '2026-09-22T00:00:00.000Z' });
  assert.equal((await learning.sweep(new Date('2026-09-23T02:00:00.000Z'))).suggestions, 0);
});
