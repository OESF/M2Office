/**
 * @file 本人が直接使った業務から秘書が学ぶことの単体テスト。
 *
 * 1 日 1 回の学習の材料に業務の依頼と答えが入ること、秘書が答えるときに今日の答えの要点が渡ること、
 * 秘書が伝えた業務・権限区画の業務・「会話を残す」を切った人のものは使わないことを確かめる。
 *
 * @see 仕様書 第10.7.3節・第11.5.2節、ADR-0038
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AgentDefinition, type UserSettings } from '@m2office/shared';
import {
  MemoryLearning, OFFICIAL_AGENTS, deliveredBySecretary, learningPrompt, recall, type LlmProvider, type Repository,
} from '../src/index.js';

/** 前日（日本時間 9/22）の昼に終わった実行。 */
const YESTERDAY = '2026-09-22T03:00:00.000Z';
const SWEEP_AT = new Date('2026-09-23T02:00:00.000Z');

type Row = { run: Record<string, unknown>; job: Record<string, unknown>; answer: string };

const row = (id: string, agentId: string, input: Record<string, unknown>, answer: string, over: Partial<{ origin: string; status: string; endedAt: string }> = {}): Row => ({
  run: { id, status: over.status ?? 'completed', startedAt: over.endedAt ?? YESTERDAY, endedAt: over.endedAt ?? YESTERDAY, failureReason: null },
  job: { agentId, input, origin: over.origin ?? 'menu' },
  answer,
});

/** 学習と記憶の呼び出しが使う操作だけを持つ、記憶上の永続化層。 */
function repoOf(rows: Row[], settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS)) {
  const prompts: string[] = [];
  const digests: { summary: string }[] = [];
  const repo = {
    listTenantIds: async () => ['t'],
    getUserSettings: async () => settings,
    listConversationUserIds: async () => [],
    listConversationsOfDay: async () => [],
    listConversationDigests: async () => [],
    listUsers: async () => [{ id: 'u', tenantId: 't', email: 'u@x', displayName: '一般', roles: ['member'], status: 'active' }],
    listMemoryCandidates: async () => [],
    listMemories: async () => [],
    createMemory: async () => undefined,
    saveConversationDigest: async (d: { summary: string }) => { digests.push(d); },
    appendAudit: async () => undefined,
    listPromotions: async () => [],
    listKnowledge: async () => [],
    listRunsWithJobs: async () => rows.map(({ run, job }) => ({ run, job })),
    listRunSteps: async (_t: string, runId: string) => [
      { stepId: 'search', output: { text: '（道具の結果）' } },
      { stepId: 'answer', output: { text: rows.find((r) => r.run['id'] === runId)?.answer ?? '' } },
    ],
  } as unknown as Repository;
  return { repo, prompts, digests };
}

const llmRecording = (prompts: string[]): LlmProvider => ({
  name: 'test',
  complete: async (req) => {
    prompts.push(req.messages.map((m) => m.content).join('\n'));
    return { text: '要約: 夏季休暇の日数を社内ナレッジ Q&A で調べた。\n- 夏季休暇は 3 日', tokensUsed: 10 };
  },
});

/** 権限区画に属する業務（人事）。 */
const HR_AGENT = { ...OFFICIAL_AGENTS.find((a) => a.id === 'knowledge-qa')!, id: 'hr-qa', name: '人事の照会', compartment: 'hr' } as AgentDefinition;
const AGENTS = [...OFFICIAL_AGENTS, HR_AGENT];

test('会話が無くても、前日に直接使った業務の依頼と答えから学ぶ', async () => {
  const { repo, prompts, digests } = repoOf([
    row('r1', 'knowledge-qa', { question: '夏季休暇は何日ありますか' }, '夏季休暇は 3 日です（就業規則 第30条）。'),
  ]);
  const learning = new MemoryLearning({ repo, llmFor: async () => llmRecording(prompts), agentsFor: async () => AGENTS });
  const result = await learning.sweep(SWEEP_AT);
  assert.equal(result.digests, 1, '業務だけの日も要約を作る');
  assert.equal(digests[0]?.summary, '夏季休暇の日数を社内ナレッジ Q&A で調べた。');
  assert.match(prompts[0]!, /## 本人が業務を使って得た答え/);
  assert.match(prompts[0]!, /業務: 社内ナレッジ Q&A「夏季休暇は何日ありますか」\n答え: 夏季休暇は 3 日です（就業規則 第30条）。/);
  assert.ok(!prompts[0]!.includes('（道具の結果）'), '途中の段の文は使わない');
});

test('秘書が伝えた業務・権限区画の業務・前日以外・完了していないものは材料にしない', async () => {
  const { repo, prompts } = repoOf([
    row('r1', 'knowledge-qa', { question: '育休は？' }, '育休の答え'),
    row('r2', 'knowledge-qa', { question: '秘書経由' }, '秘書に頼んだ答え', { origin: 'secretary' }),
    row('r3', 'hr-qa', { question: '評価面談' }, '人事の答え'),
    row('r4', 'knowledge-qa', { question: '今日の分' }, '今日の答え', { endedAt: '2026-09-23T01:00:00.000Z' }),
    row('r5', 'knowledge-qa', { question: '失敗' }, '失敗の答え', { status: 'failed' }),
    row('r6', 'secretary-lookup', { request: '調べもの' }, '調べものの答え'),
  ]);
  const learning = new MemoryLearning({ repo, llmFor: async () => llmRecording(prompts), agentsFor: async () => AGENTS });
  await learning.sweep(SWEEP_AT);
  const p = prompts[0]!;
  assert.match(p, /育休の答え/);
  for (const t of ['秘書に頼んだ答え', '人事の答え', '今日の答え', '失敗の答え', '調べものの答え']) assert.ok(!p.includes(t), `${t} は使わない`);
});

test('「会話を残す」を切っている人・覚えることを止めている人の業務からは学ばない', async () => {
  for (const change of [{ keepConversations: false }, { learning: false }]) {
    const settings = structuredClone(DEFAULT_USER_SETTINGS);
    Object.assign(settings.memory, change);
    const { repo, prompts, digests } = repoOf([row('r1', 'knowledge-qa', { question: '夏季休暇' }, '3 日です')], settings);
    const learning = new MemoryLearning({ repo, llmFor: async () => llmRecording(prompts), agentsFor: async () => AGENTS });
    await learning.sweep(SWEEP_AT);
    assert.equal(prompts.length, 0, JSON.stringify(change));
    assert.equal(digests.length, 0);
  }
});

test('秘書が答えるとき、今日完了した業務には答えの要点を添える', async () => {
  const today = '2026-09-25T01:00:00.000Z';
  const { repo } = repoOf([
    row('r1', 'knowledge-qa', { question: '夏季休暇は何日ありますか' }, '夏季休暇は 3 日です（就業規則 第30条）。', { endedAt: today }),
    row('r2', 'knowledge-qa', { question: '昨日の質問' }, '昨日の答え', { endedAt: '2026-09-24T01:00:00.000Z' }),
    row('r3', 'hr-qa', { question: '評価面談' }, '人事の答え', { endedAt: today }),
  ]);
  const r = await recall(repo, 't', 'u', 'さっき調べた夏季休暇は？', AGENTS, new Date('2026-09-25T03:00:00.000Z'));
  assert.match(r.text, /社内ナレッジ Q&A「夏季休暇は何日ありますか」 — 完了\n {2}答えの要点: 夏季休暇は 3 日です（就業規則 第30条）。/);
  assert.ok(!r.text.includes('昨日の答え'), '今日より前の答えは添えない（学習で覚えている）');
  assert.ok(!r.text.includes('人事の答え'), '権限区画の業務の答えは添えない');
});

test('秘書が伝える業務を見分ける', () => {
  assert.equal(deliveredBySecretary({ origin: 'secretary', agentId: 'slides' }), true);
  assert.equal(deliveredBySecretary({ origin: 'schedule', agentId: 'morning-brief' }), true);
  assert.equal(deliveredBySecretary({ origin: 'menu', agentId: 'knowledge-qa' }), false);
  assert.match(learningPrompt([], []), /1 日ぶんのやり取りと、その人が業務を使って得た答え/);
});
