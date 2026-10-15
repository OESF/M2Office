/**
 * @file 秘書の成長の段 3 の単体テスト（仕様書 第11.13.5節・第11.13.6節、ADR-0095）。案件ノート（作る時・書き足し・終える・本人の材料だけ）、
 * 会社の知識の確かさ（同じ事柄なら確かめた人を増やす・同じ人では増やさない・検索で上に出す）、答えられなかった問い（残す・まとめる・探し直す・知らせる）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type Notification } from '@m2office/shared';
import {
  CaseNoteBuilder, KnowledgeGaps, MemoryKnowledgeGapStore, MemoryLearning, OFFICIAL_AGENTS, confirmationWeight, gapKey, orderSections,
  parseCasePlan, parseSameAsKnown, recall, type LlmProvider, type LlmRequest, type Repository,
} from '../src/index.js';
import type { CaseNote, Memory } from '../src/repository/types.js';

const NOW = new Date('2026-10-15T00:00:00.000Z'); // 日本時間 9 時

test('案件ノートを作る時: 日本時間の 4 時を過ぎていて、今日まだ作っていない', () => {
  assert.equal(CaseNoteBuilder.due(null, new Date('2026-10-14T18:00:00.000Z')), false, '日本時間 3 時');
  assert.equal(CaseNoteBuilder.due(null, NOW), true);
  assert.equal(CaseNoteBuilder.due('2026-10-14T23:00:00.000Z', NOW), false, '今日（日本時間）すでに作った');
  assert.equal(CaseNoteBuilder.due('2026-10-13T23:00:00.000Z', NOW), true);
});

test('案件の書き足しの答えから、範囲の外の番号・空の題名・形の違う日付を捨てる', () => {
  const p = parseCasePlan(JSON.stringify({
    update: [{ n: 1, state: '見積を送った', next: '返事を待つ', due: '2026-10-20', lastDay: '2026-10-14' }, { n: 5, state: 'x' }, { n: 1, state: '重なり' }],
    create: [{ title: 'B 社の保守契約', state: '更新の相談', next: '', due: 'いつか', lastDay: '2026-10-14' }, { title: '', lastDay: '2026-10-14' }, { title: '日付なし' }],
  }), 2);
  assert.deepEqual(p.update, [{ n: 1, state: '見積を送った', next: '返事を待つ', due: '2026-10-20', lastDay: '2026-10-14' }]);
  assert.deepEqual(p.create, [{ title: 'B 社の保守契約', state: '更新の相談', next: '', due: null, lastDay: '2026-10-14' }]);
});

function caseRepo() {
  const notes: CaseNote[] = [{ id: 'c1', tenantId: 't', userId: 'u', title: 'A 社の見積', state: '作っている', nextStep: '送る', dueOn: null, status: 'open', lastDay: '2026-10-10', createdAt: '', updatedAt: '' }];
  const runs: string[] = [];
  const repo = {
    listTenantIds: async () => ['t'], listMemoryOwners: async () => ['u'],
    getUserSettings: async () => DEFAULT_USER_SETTINGS,
    getCaseNoteRun: async () => null, setCaseNoteRun: async (_t: string, u: string) => { runs.push(u); },
    listConversationDigests: async () => [
      { tenantId: 't', userId: 'u', day: '2026-10-14', summary: 'A 社に見積を送った。B 社から保守の相談', compartment: null, createdAt: '' },
      { tenantId: 't', userId: 'u', day: '2026-10-13', summary: '人事の評価面談', compartment: 'hr', createdAt: '' },
    ],
    listRunsWithJobs: async () => [],
    closeIdleCaseNotes: async () => 0,
    listCaseNotes: async () => notes.filter((n) => n.status === 'open'),
    saveCaseNote: async (n: CaseNote) => { const i = notes.findIndex((x) => x.id === n.id); if (i >= 0) notes[i] = n; else notes.push(n); },
    purgeClosedCaseNotes: async () => 0, appendAudit: async () => undefined,
  } as unknown as Repository;
  return { repo, notes, runs };
}

test('案件ノートを本人の材料から書き足し、区画の要約を使わない', async () => {
  const prompts: string[] = [];
  const llm: LlmProvider = {
    name: 'test', complete: async (req: LlmRequest) => {
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      return { text: JSON.stringify({ update: [{ n: 1, state: '見積を送った', next: '返事を待つ', lastDay: '2026-10-14' }], create: [{ title: 'B 社の保守契約', state: '更新の相談を受けた', next: '見積を作る', due: null, lastDay: '2026-10-14' }] }), tokensUsed: 1 };
    },
  };
  const { repo, notes, runs } = caseRepo();
  const b = new CaseNoteBuilder({ repo, llmFor: async () => llm, agentName: async () => '' });
  assert.deepEqual(await b.tick(NOW), { users: 1, created: 1, updated: 1, closed: 0 });
  assert.deepEqual(runs, ['u']);
  assert.ok(!prompts[0]!.includes('評価面談'), '権限区画の印の付いた要約は使わない');
  assert.match(prompts[0]!, /1\. 〔A 社の見積〕/);
  assert.equal(notes.find((n) => n.id === 'c1')!.state, '見積を送った');
  assert.equal(notes.find((n) => n.id === 'c1')!.lastDay, '2026-10-14');
  assert.ok(notes.some((n) => n.title === 'B 社の保守契約' && n.status === 'open'));
});

test('秘書が答えるときに、進んでいる案件を渡す', async () => {
  const repo = {
    listConversationsOfDay: async () => [], listConversationDigests: async () => [], listRunsWithJobs: async () => [], listMemories: async () => [],
    getUserProfile: async () => null, getUserSettings: async () => DEFAULT_USER_SETTINGS, touchMemories: async () => undefined,
    listCaseNotes: async () => [{ id: 'c1', title: 'A 社の見積', state: '見積を送った', nextStep: '返事を待つ', dueOn: '2026-10-20', lastDay: '2026-10-14' }],
  } as unknown as Repository;
  const r = await recall(repo, 't', 'u', 'あの見積どうなった？', OFFICIAL_AGENTS, NOW);
  assert.match(r.text, /## 進んでいる案件（あなたがまとめたもの。新しい順）\n- 〔A 社の見積〕見積を送った／次: 返事を待つ／期限: 2026-10-20（最後に動いた日 2026-10-14）/);
  assert.match(r.evidence[0]!.value, /進んでいる案件 1 件/);
});

test('同じ事柄を別の人の秘書が学んだら、新しく登録せず確かめた人を増やす（同じ人では増やさない）', async () => {
  assert.deepEqual([...parseSameAsKnown('- 1\n- 2=K1\n- 3 ＝ k2\n- 9=K1\n- 2=K2', 3, 2)], [[2, 1], [3, 2]]);
  const memories: Memory[] = [{ id: 'm1', tenantId: 't', userId: 'u2', text: '経費の締めは 25 日', source: 'learned', kind: 'fact', createdAt: '' }];
  const confirmed: string[] = [];
  const promotions: { status: string; knowledgeId: string | null; memoryId: string }[] = [];
  const repo = {
    getUserSettings: async () => DEFAULT_USER_SETTINGS, listConversationDigests: async () => [], saveConversationDigest: async () => undefined,
    listMemoryCandidates: async () => [], listMemories: async () => memories, createMemory: async (m: Memory) => { memories.unshift(m); },
    appendAudit: async () => undefined, listPromotions: async () => promotions,
    createPromotion: async (p: { status: string; knowledgeId: string | null; memoryId: string }) => { promotions.push(p); },
    listKnowledge: async () => [{ id: 'k1', kind: 'promoted', body: '経費の締めは毎月 25 日' }],
    saveKnowledge: async () => assert.fail('新しく登録しない'),
    confirmKnowledge: async (_t: string, id: string) => { confirmed.push(id); },
  } as unknown as Repository;
  const llm: LlmProvider = { name: 'test', complete: async (req: LlmRequest) => {
    const t = req.messages.map((m) => m.content).join('\n');
    if (t.includes('会社のほかの人にも役立つ')) {
      assert.match(t, /K1\. 経費の締めは毎月 25 日/);
      return { text: '- 1=K1', tokensUsed: 1 };
    }
    return { text: '要約: 経費の話\n- 経費の締めは 25 日です', tokensUsed: 1 };
  } };
  const learning = new MemoryLearning({ repo, llmFor: async () => llm });
  const conv = { id: 'c', tenantId: 't', userId: 'u2', message: '経費の締めは？', reply: '25 日です', layer: 'full', agentId: null, runId: null, createdAt: '' };
  await learning.learnNow('t', 'u2', { conversations: [conv as never] }, NOW);
  assert.deepEqual(confirmed, ['k1']);
  assert.ok(promotions.some((p) => p.status === 'approved' && p.knowledgeId === 'k1'));
  // 同じ人がもう一度同じ事柄を覚えても、増やさない
  memories.unshift({ id: 'm2', tenantId: 't', userId: 'u2', text: '締めは月末の 5 日前', source: 'learned', kind: 'fact', createdAt: '' });
  await learning.learnNow('t', 'u2', { conversations: [conv as never] }, NOW);
  assert.deepEqual(confirmed, ['k1']);
});

test('検索では、秘書が学んだことの中でだけ確かめた人の多いものを上に出す', () => {
  assert.equal(confirmationWeight({ category: 'rule', confirmations: 9 }), 1);
  assert.equal(confirmationWeight({ category: 'learned', confirmations: 3 }), 1.3);
  const rows = [
    { heading: '', path: [], body: '経費の締め 締め', updatedAt: '2026-10-02', category: 'learned' as const, confirmations: 1, id: 'a' },
    { heading: '', path: [], body: '経費の締め', updatedAt: '2026-10-01', category: 'learned' as const, confirmations: 4, id: 'b' },
    { heading: '', path: [], body: '経費', updatedAt: '2026-09-01', category: 'rule' as const, confirmations: 1, id: 'r' },
  ];
  const ordered = orderSections(['経費', '締め'], rows).map((r) => r.id);
  assert.equal(ordered[0], 'r', '社内規程はいつも先');
  assert.deepEqual(ordered.slice(1), ['b', 'a'], '確かめた人の多いほうを上に');
});

test('答えられなかった問いを、誰が聞いたかを残さずに残し、まとめ、探し直して知らせる', async () => {
  const store = new MemoryKnowledgeGapStore();
  const notes: Notification[] = [];
  const audits: string[] = [];
  let found = false;
  const repo = {
    listKnowledge: async () => [{ id: 'k9', title: '慶弔休暇' }],
    searchKnowledge: async () => ({ hits: found ? [{ id: 'k9' }] : [], rewrites: [] }),
    listUsers: async () => [{ id: 'boss', roles: ['admin'], status: 'active' }, { id: 'u1', roles: ['member'], status: 'active' }],
    createNotification: async (n: Notification) => { notes.push(n); },
    listAuditSince: async () => [], appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Repository;
  const gaps = new KnowledgeGaps({ store, repo });
  await gaps.record('t', '慶弔休暇は何日？', 'secretary');
  await gaps.record('t', ' 慶弔休暇は 何日 ', 'knowledge-qa');
  await gaps.record('t', '駐車場の申し込みは？', 'secretary');
  assert.ok(store.rows.every((r) => !('userId' in r)), '誰が聞いたかは持たない');
  assert.equal(gapKey('慶弔休暇は何日？'), gapKey(' 慶弔休暇は 何日 '));
  const s1 = await gaps.summary('t');
  assert.deepEqual(s1.items.map((x) => x.count), [2, 1], '同じ問いをまとめ、回数の多い順');
  assert.equal(await gaps.due('t', new Date('2026-10-11T12:00:00.000Z')), true, '前の月曜を過ぎていて、まだ行っていない');
  // 答えが無ければ、管理者にだけ知らせる
  const r0 = await gaps.weekly('t', NOW);
  assert.deepEqual(r0, { answered: 0, open: 3 });
  assert.deepEqual(notes.map((n) => [n.userId, n.kind]), [['boss', 'knowledgeGap']]);
  assert.match(notes[0]!.body, /慶弔休暇は ?何日/);
  // 会社の知識に答えが入ったら、探し直して印を付ける
  found = true;
  const r = await gaps.weekly('t', NOW);
  assert.equal(r.answered, 3);
  const s2 = await gaps.summary('t');
  assert.ok(s2.items.every((x) => x.answered?.knowledgeId === 'k9' && x.answered.title === '慶弔休暇'));
  assert.deepEqual(audits, ['knowledge.gaps', 'knowledge.gaps']);
  await gaps.dismiss('t', '慶弔休暇は何日？');
  assert.equal((await gaps.summary('t')).items.length, 1);
});
