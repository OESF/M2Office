/**
 * @file 会話で記憶を直すことの単体テスト。本人の指摘だけで、秘書が記憶と会社の知識を直すことを確かめる。
 *
 * @see 仕様書 第11.5.3節、ADR-0028
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AuditEvent } from '@m2office/shared';
import { CORRECTION, correctMemory, parseCorrection, type LlmProvider, type Repository } from '../src/index.js';
import type { KnowledgeItem, Memory, MemoryCandidate, Promotion } from '../src/repository/types.js';

class Repo {
  memories: Memory[] = [
    { id: 'm1', tenantId: 't', userId: 'u', text: '山田さんは経理の担当', source: 'learned', createdAt: '2026-09-20T00:00:00.000Z' },
    { id: 'm2', tenantId: 't', userId: 'u', text: '見積は税抜きで出す', source: 'secretary', createdAt: '2026-09-19T00:00:00.000Z' },
  ];
  knowledge: KnowledgeItem[] = [
    { id: 'k1', tenantId: 't', kind: 'promoted', title: '締め', body: '締めは毎月 20 日', source: '秘書が会話から学んだこと', compartment: null, updatedAt: '' } as KnowledgeItem,
    { id: 'k2', tenantId: 't', kind: 'regulation', title: '就業規則', body: '始業は 9 時', source: '就業規則', compartment: null, updatedAt: '' } as KnowledgeItem,
  ];
  promotions: Partial<Promotion>[] = [{ userId: 'u', status: 'approved', knowledgeId: 'k1' }];
  candidates: MemoryCandidate[] = [];
  audits: AuditEvent[] = [];
  async listMemories() { return this.memories; }
  async listPromotions() { return this.promotions; }
  async listKnowledge() { return this.knowledge; }
  async getUserSettings() { return structuredClone(DEFAULT_USER_SETTINGS); }
  async updateMemory(_t: string, _u: string, id: string, text: string) {
    this.memories = this.memories.map((m) => (m.id === id ? { ...m, text, source: 'secretary' } : m)); return true;
  }
  async deleteMemory(_t: string, _u: string, id: string) { this.memories = this.memories.filter((m) => m.id !== id); return true; }
  async createMemory(m: Memory) { this.memories.push(m); }
  async createMemoryCandidate(c: MemoryCandidate) { this.candidates.push(c); }
  async saveKnowledge(k: KnowledgeItem) { this.knowledge = this.knowledge.map((x) => (x.id === k.id ? k : x)); }
  async deleteKnowledge(_t: string, id: string) { this.knowledge = this.knowledge.filter((k) => k.id !== id); return true; }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
}

const llmOf = (text: string): LlmProvider & { prompts: string[] } => {
  const prompts: string[] = [];
  return { name: 'test', prompts, complete: async (r: { messages: { content: string }[] }) => { prompts.push(r.messages.at(-1)!.content); return { text, tokensUsed: 5 }; } } as never;
};

test('訂正らしい言い方を拾う', () => {
  for (const q of ['それは違う、山田さんは総務だよ', '覚えたことを直しておいて', '見積の話は忘れて', '間違ってるよ']) assert.ok(CORRECTION.test(q), q);
  assert.ok(!CORRECTION.test('明日の予定は？'));
});

test('推論の応答から操作を取り出す。決められないときは聞き返す', () => {
  assert.deepEqual(parseCorrection('- 直す M1 → 山田さんは総務の担当\n- 消す K1\n- 覚える → 締めは 25 日'), [
    { op: 'update', target: 'M1', text: '山田さんは総務の担当' },
    { op: 'delete', target: 'K1' },
    { op: 'add', text: '締めは 25 日' },
  ]);
  assert.deepEqual(parseCorrection('無し'), []);
  assert.equal(parseCorrection('不明'), null);
});

test('指摘だけで、秘書が記憶を直す。秘書が覚えた文は再び覚えない', async () => {
  const repo = new Repo();
  const llm = llmOf('直す M1 → 山田さんは総務の担当');
  const r = await correctMemory({ repo: repo as unknown as Repository, llm }, 't', 'u', 'それは違う、山田さんは総務だよ');
  assert.match(r.text ?? '', /「山田さんは経理の担当」→「山田さんは総務の担当」/);
  assert.equal(repo.memories.find((m) => m.id === 'm1')!.text, '山田さんは総務の担当');
  assert.deepEqual(repo.candidates.map((c) => [c.text, c.status]), [['山田さんは経理の担当', 'dismissed']]);
  assert.ok(llm.prompts[0]!.includes('M1. 山田さんは経理の担当'));
  assert.ok(!llm.prompts[0]!.includes('始業は 9 時'), '管理者が登録した規程は直す候補にしない');
  assert.equal(JSON.stringify(repo.audits).includes('総務'), false, '監査ログに中身を入れない');
});

test('秘書が会社の知識にしたものも、会話で直せる', async () => {
  const repo = new Repo();
  const r = await correctMemory({ repo: repo as unknown as Repository, llm: llmOf('直す K1 → 締めは毎月 25 日') }, 't', 'u', '締めは 20 日じゃなくて 25 日だよ、違う');
  assert.ok(r.text);
  assert.equal(repo.knowledge.find((k) => k.id === 'k1')!.body, '締めは毎月 25 日');
  assert.match(repo.knowledge.find((k) => k.id === 'k1')!.source, /会話での訂正/);
  assert.ok(repo.audits.some((a) => a.action === 'knowledge.correct'));
});

test('記憶の話でなければ何もしない。決められなければ推測で直さない', async () => {
  const repo = new Repo();
  assert.equal((await correctMemory({ repo: repo as unknown as Repository, llm: llmOf('無し') }, 't', 'u', '違う日にして')).text, null);
  const unsure = await correctMemory({ repo: repo as unknown as Repository, llm: llmOf('不明') }, 't', 'u', 'それ違うよ');
  assert.match(unsure.text ?? '', /決められませんでした/);
  assert.equal(repo.memories.length, 2, '何も変えない');
});
