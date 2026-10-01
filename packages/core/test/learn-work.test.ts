/**
 * @file 秘書の受け手（指揮者）と、本人が直接使った業務から学ぶことの単体テスト。
 *
 * 業務の完了と会話のイベントを受けて、依頼した本人の秘書がその場で学ぶこと、
 * 秘書に頼まれた業務・権限区画の業務・失敗・「会話を残す」を切った人のものからは学ばないこと、
 * 失敗したイベントは処理済みにせず理由を残すこと、秘書が答えるときに今日の答えの要点が渡ることを確かめる。
 *
 * @see 仕様書 第10.13節・第10.7.3節・第11.5.2節、ADR-0038・ADR-0039
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AgentDefinition, type UserSettings } from '@m2office/shared';
import {
  MemoryLearning, OFFICIAL_AGENTS, SecretaryConductor, deliveredBySecretary, learningPrompt, recall,
  type AgentEvent, type LlmProvider, type Repository,
} from '../src/index.js';

const DONE_AT = '2026-09-27T03:00:00.000Z';
const NOW = new Date('2026-09-27T03:00:05.000Z');

type Row = { run: Record<string, unknown>; job: Record<string, unknown>; answer: string };

const row = (id: string, agentId: string, input: Record<string, unknown>, answer: string, over: Partial<{ origin: string; status: string; endedAt: string; requestedBy: string }> = {}): Row => ({
  run: { id, jobId: `j-${id}`, status: over.status ?? 'completed', startedAt: over.endedAt ?? DONE_AT, endedAt: over.endedAt ?? DONE_AT, failureReason: null },
  job: { id: `j-${id}`, agentId, input, origin: over.origin ?? 'menu', requestedBy: over.requestedBy ?? 'u' },
  answer,
});

/** 受け手と学習が使う操作だけを持つ、記憶上の永続化層。 */
function repoOf(rows: Row[], events: Partial<AgentEvent>[], settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS)) {
  const queue = events.map((e, i) => ({
    id: `e${i + 1}`, tenantId: 't', userId: 'u', kind: 'run.finished', runId: null, conversationId: null, status: null,
    createdAt: DONE_AT, attempts: 1, processedAt: null, lastError: null, ...e,
  }) as AgentEvent);
  const finished: { id: string; error: string | null }[] = [];
  const conversations = [{ id: 'c1', tenantId: 't', userId: 'u', message: '見積の締めは？', reply: '毎月 25 日です。', layer: 'full', agentId: null, runId: null, createdAt: DONE_AT }];
  const repo = {
    claimAgentEvent: async () => {
      const next = queue.find((e) => !finished.some((f) => f.id === e.id));
      return next ? { id: next.id, tenantId: next.tenantId } : null;
    },
    getAgentEvent: async (_t: string, id: string) => queue.find((e) => e.id === id) ?? null,
    finishAgentEvent: async (_t: string, id: string, error: string | null) => { finished.push({ id, error }); },
    getConversation: async (_t: string, id: string) => conversations.find((c) => c.id === id) ?? null,
    getRun: async (_t: string, id: string) => rows.find((r) => r.run['id'] === id)?.run ?? null,
    getJob: async (_t: string, id: string) => rows.find((r) => r.job['id'] === id)?.job ?? null,
    listRunsWithJobs: async () => rows.map(({ run, job }) => ({ run, job })),
    listRunSteps: async (_t: string, runId: string) => [
      { stepId: 'search', output: { text: '（ツールの結果）' } },
      { stepId: 'answer', output: { text: rows.find((r) => r.run['id'] === runId)?.answer ?? '' } },
    ],
    getUserSettings: async () => settings,
    listConversationsOfDay: async () => [],
    listConversationDigests: async () => [],
    listMemories: async () => [],
    listMemoryCandidates: async () => [],
  } as unknown as Repository;
  return { repo, finished };
}

/** 学習に渡されたものを記録する。 */
function spyLearning() {
  const calls: { userId: string; material: Parameters<MemoryLearning['learnNow']>[2] }[] = [];
  return {
    calls,
    learning: {
      learnNow: async (_t: string, userId: string, material: Parameters<MemoryLearning['learnNow']>[2]) => {
        calls.push({ userId, material });
        return { digest: true, learned: 1, promoted: 0 };
      },
    },
  };
}

/** 権限区画に属する業務（人事）。 */
const HR_AGENT = { ...OFFICIAL_AGENTS.find((a) => a.id === 'knowledge-qa')!, id: 'hr-qa', name: '人事の照会', compartment: 'hr' } as AgentDefinition;
const AGENTS = [...OFFICIAL_AGENTS, HR_AGENT];

test('業務が完了したら、依頼した本人の秘書がその場で依頼と答えから学ぶ', async () => {
  const { repo, finished } = repoOf(
    [row('r1', 'knowledge-qa', { question: '夏季休暇は何日ありますか' }, '夏季休暇は 3 日です（就業規則 第30条）。')],
    [{ kind: 'run.finished', runId: 'r1', status: 'completed' }],
  );
  const { calls, learning } = spyLearning();
  const conductor = new SecretaryConductor({ repo, learning, agentsFor: async () => AGENTS });
  const outcome = await conductor.tick(NOW);
  assert.equal(outcome?.action, 'learned');
  assert.equal(calls[0]?.userId, 'u');
  assert.deepEqual(calls[0]?.material.work?.map((w) => [w.agentName, w.label, w.answer]),
    [['社内ナレッジ Q&A', '夏季休暇は何日ありますか', '夏季休暇は 3 日です（就業規則 第30条）。']], '途中の段の文は使わない');
  assert.deepEqual(finished, [{ id: 'e1', error: null }], '処理済みにする');
  assert.equal(await conductor.tick(NOW), null, '待っているイベントが無ければ何もしない');
});

test('会話を 1 往復残したら、その往復から学ぶ。消された会話からは学ばない', async () => {
  const { repo } = repoOf([], [{ kind: 'conversation.turn', conversationId: 'c1' }, { kind: 'conversation.turn', conversationId: 'gone' }]);
  const { calls, learning } = spyLearning();
  const conductor = new SecretaryConductor({ repo, learning });
  assert.equal((await conductor.tick(NOW))?.action, 'learned');
  assert.equal(calls[0]?.material.conversations?.[0]?.message, '見積の締めは？');
  const second = await conductor.tick(NOW);
  assert.equal(second?.action, 'skipped');
  assert.equal(calls.length, 1);
});

test('秘書に頼まれた業務・権限区画の業務・失敗・承認待ち・他人の業務からは、その場では学ばない', async () => {
  const { repo, finished } = repoOf([
    row('r2', 'knowledge-qa', { question: '秘書経由' }, '秘書に頼んだ答え', { origin: 'secretary' }),
    row('r3', 'hr-qa', { question: '評価面談' }, '人事の答え'),
    row('r4', 'knowledge-qa', { question: '失敗' }, '', { status: 'failed' }),
    row('r5', 'knowledge-qa', { question: 'ほかの人' }, 'ほかの人の答え', { requestedBy: 'u2' }),
  ], [
    { kind: 'run.finished', runId: 'r2', status: 'completed' },
    { kind: 'run.finished', runId: 'r3', status: 'completed' },
    { kind: 'run.finished', runId: 'r4', status: 'failed' },
    { kind: 'run.awaiting_approval', runId: 'r4', status: 'awaiting_approval' },
    { kind: 'run.finished', runId: 'r5', status: 'completed' },
  ]);
  const { calls, learning } = spyLearning();
  const conductor = new SecretaryConductor({ repo, learning, agentsFor: async () => AGENTS });
  const actions: string[] = [];
  for (let o = await conductor.tick(NOW); o; o = await conductor.tick(NOW)) actions.push(o.action);
  assert.deepEqual(actions, ['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  assert.equal(calls.length, 0);
  assert.equal(finished.length, 5, 'どれも処理済みにする（記録は残る）');
});

test('処理に失敗したイベントは、処理済みにせず理由を残す', async () => {
  const { repo, finished } = repoOf([], [{ kind: 'conversation.turn', conversationId: 'c1' }]);
  const conductor = new SecretaryConductor({
    repo, learning: { learnNow: async () => { throw new Error('推論が応答しません'); } },
  });
  const outcome = await conductor.tick(NOW);
  assert.equal(outcome?.action, 'failed');
  assert.deepEqual(finished, [{ id: 'e1', error: '推論が応答しません' }]);
});

test('業務の答えは、「会話を残す」を切っている人のものは使わない', async () => {
  const settings = structuredClone(DEFAULT_USER_SETTINGS);
  settings.memory.keepConversations = false;
  const { repo } = repoOf([], [], settings);
  const prompts: string[] = [];
  const llm: LlmProvider = { name: 'test', complete: async (req) => { prompts.push(req.messages.map((m) => m.content).join('\n')); return { text: '要約: x', tokensUsed: 1 }; } };
  const learning = new MemoryLearning({ repo, llmFor: async () => llm });
  const r = await learning.learnNow('t', 'u', { work: [{ runId: 'r1', agentName: '社内ナレッジ Q&A', label: '夏季休暇', answer: '3 日です', endedAt: DONE_AT }] }, NOW);
  assert.deepEqual(r, { digest: false, learned: 0, promoted: 0 });
  assert.equal(prompts.length, 0);
});

test('秘書が答えるとき、今日完了した業務には答えの要点を添える', async () => {
  const { repo } = repoOf([
    row('r1', 'knowledge-qa', { question: '夏季休暇は何日ありますか' }, '夏季休暇は 3 日です（就業規則 第30条）。'),
    row('r2', 'knowledge-qa', { question: '昨日の質問' }, '昨日の答え', { endedAt: '2026-09-26T01:00:00.000Z' }),
    row('r3', 'hr-qa', { question: '評価面談' }, '人事の答え'),
  ], []);
  const r = await recall(repo, 't', 'u', 'さっき調べた夏季休暇は？', AGENTS, NOW);
  assert.match(r.text, /社内ナレッジ Q&A「夏季休暇は何日ありますか」 — 完了\n {2}答えの要点: 夏季休暇は 3 日です（就業規則 第30条）。/);
  assert.ok(!r.text.includes('昨日の答え'), '今日より前の答えは添えない（覚えたことにある）');
  assert.ok(!r.text.includes('人事の答え'), '権限区画の業務の答えは添えない');
});

test('秘書が伝える業務を見分け、業務の答えを学習の指示に入れる', () => {
  assert.equal(deliveredBySecretary({ origin: 'secretary', agentId: 'slides' }), true);
  assert.equal(deliveredBySecretary({ origin: 'schedule', agentId: 'morning-brief' }), true);
  assert.equal(deliveredBySecretary({ origin: 'menu', agentId: 'knowledge-qa' }), false);
  const p = learningPrompt([], [{ runId: 'r', agentName: '社内ナレッジ Q&A', label: '夏季休暇', answer: '3 日', endedAt: DONE_AT }]);
  assert.match(p, /## 本人が業務を使って得た答え\n\n業務: 社内ナレッジ Q&A「夏季休暇」\n答え: 3 日/);
});

test('学ばない業務（m2office-private。契約書チェックなど）の結果からは学ばない（第12.12.3節）', async () => {
  const { learnableWork } = await import('../src/memory/work.js');
  const secret = { ...OFFICIAL_AGENTS[0]!, id: 'x:contract-review', private: true } as AgentDefinition;
  const normal = { ...OFFICIAL_AGENTS[0]!, id: 'x:normal' } as AgentDefinition;
  const item = (agentId: string) => ({
    run: { id: 'r', jobId: 'j', status: 'completed', startedAt: DONE_AT, endedAt: DONE_AT } as never,
    job: { id: 'j', agentId, origin: 'menu', input: {}, requestedBy: 'u' } as never,
  });
  assert.equal(learnableWork(item('x:contract-review'), [secret, normal]), false);
  assert.equal(learnableWork(item('x:normal'), [secret, normal]), true);
});

test('学ばない業務の結果を秘書が伝えた会話からは学ばない（会話ログには残る。第12.12.3節）', async () => {
  const secret = { ...OFFICIAL_AGENTS[0]!, id: 'x:contract-review', private: true } as AgentDefinition;
  const { repo } = repoOf([row('r9', 'x:contract-review', {}, '第6条に上限がありません', { origin: 'secretary' })], [{ kind: 'conversation.turn', conversationId: 'c9' }]);
  // 伝えた結果の会話（実行につながる）
  (repo as unknown as { getConversation: unknown }).getConversation = async () => ({
    id: 'c9', tenantId: 't', userId: 'u', message: '（「契約書チェック」に頼んだ結果）この NDA 大丈夫？', reply: '第6条に上限がありません',
    layer: 'full', agentId: null, runId: 'r9', createdAt: DONE_AT,
  });
  const { calls, learning } = spyLearning();
  const conductor = new SecretaryConductor({ repo, learning, agentsFor: async () => [...OFFICIAL_AGENTS, secret] });
  const outcome = await conductor.tick(NOW);
  assert.equal(outcome?.action, 'skipped');
  assert.equal(calls.length, 0, '契約書の中身を記憶に入れない');
});
