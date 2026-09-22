/**
 * @file Google から取得したデータの保持（中身を消して目印を残す、承認待ちの期限切れ）の単体テスト。
 *
 * @see 仕様書 第14.3.2節 Google から取得したデータの保持（Q-78）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, Job, Notification, Run, RunStep } from '@m2office/shared';
import {
  GoogleDataRetention, REDACTED_PRESENT, redactStep, retentionDays, silentLogger, usesGoogleData, type Repository,
} from '../src/index.js';

const isGoogleTool = (name: string) => name.startsWith('gmail.') || name.startsWith('drive.');
const step = (over: Partial<RunStep>): RunStep => ({
  id: 's1', runId: 'r1', seq: 0, stepId: 'fetch', kind: 'llm', status: 'succeeded',
  input: { prompt: '受信箱を整理して' }, output: null, startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T00:00:01.000Z', ...over,
} as RunStep);
const MAIL_STEP = step({
  output: {
    text: '山田様から見積の依頼が来ています',
    tools: [{ name: 'gmail.list', risk: 'read', result: { messages: [
      { id: 'm-1', from: 'yamada@example.jp', subject: '見積のお願い', snippet: '至急' },
      { id: 'm-2', from: 'sato@example.jp', subject: '請求書', snippet: '添付' },
    ] } }],
  },
});

test('中身を消し、ツール名・危険度・ID・件数だけを残す（件名と差出人は残さない）', () => {
  const r = redactStep(MAIL_STEP, 'retention', '2026-09-10T00:00:00.000Z');
  assert.equal(r.input, null);
  assert.deepEqual(r.output, {
    redacted: true, redactedAt: '2026-09-10T00:00:00.000Z', reason: 'retention',
    tools: [{ name: 'gmail.list', risk: 'read', ids: ['m-1', 'm-2'], count: 2 }],
  });
  const text = JSON.stringify(r);
  for (const leaked of ['見積', 'yamada', '請求書', '山田様', '受信箱']) assert.ok(!text.includes(leaked), leaked);
});

test('Google のツールを使った実行だけを、中身を消す対象にする', () => {
  assert.equal(usesGoogleData([MAIL_STEP], isGoogleTool), true);
  const kb = step({ output: { tools: [{ name: 'knowledge.search', result: { hits: [] } }] } });
  assert.equal(usesGoogleData([kb, step({})], isGoogleTool), false);
});

test('残す日数は 0〜7 日に収める（長くはできない）', () => {
  assert.equal(retentionDays(undefined), 7);
  assert.equal(retentionDays(30), 7);
  assert.equal(retentionDays(-1), 0);
  assert.equal(retentionDays(3), 3);
});

/** 見回りを確かめるための、最小限の保存先。 */
function fakeRepo() {
  const at = '2026-09-01T00:00:00.000Z';
  const state = {
    runs: [
      { id: 'r-done', jobId: 'j1', tenantId: 't', status: 'completed', cursor: 1, startedAt: at, endedAt: at, tokensUsed: 0, costJpy: 0, failureReason: null },
      { id: 'r-wait', jobId: 'j1', tenantId: 't', status: 'awaiting_approval', cursor: 1, startedAt: at, endedAt: null, tokensUsed: 0, costJpy: 0, failureReason: null },
    ] as Run[],
    steps: {
      'r-done': [{ ...MAIL_STEP, id: 'sd', runId: 'r-done' }],
      'r-wait': [{ ...MAIL_STEP, id: 'sw', runId: 'r-wait' }, step({ id: 'sa', runId: 'r-wait', kind: 'approval', status: 'awaiting' })],
    } as Record<string, RunStep[]>,
    approvals: [{ id: 'a1', runStepId: 'sa', tenantId: 't', approverRole: ['approver'], approverUserId: null, present: '山田様への返信: …', decision: null, decidedBy: null, comment: null, decidedAt: null, createdAt: at }] as Approval[],
    marked: [] as { runId: string; steps: RunStep[] | null }[],
    notifications: [] as Notification[],
  };
  const repo = {
    listTenantIds: async () => ['t'],
    getTenantSettings: async () => ({ privacy: { googleDataRetentionDays: 7 } }),
    listRunsForRetention: async (_t: string, before: string) =>
      state.runs.filter((r) => ['completed', 'failed', 'cancelled', 'expired'].includes(r.status) && r.endedAt! < before
        && !state.marked.some((m) => m.runId === r.id)),
    listRunSteps: async (_t: string, runId: string) => state.steps[runId] ?? [],
    markRunRetention: async (_t: string, runId: string, steps: RunStep[] | null) => { state.marked.push({ runId, steps }); },
    listStaleApprovals: async (_t: string, before: string) => state.approvals.filter((a) => !a.decision && a.createdAt < before),
    getRunStepById: async (_t: string, id: string) => Object.values(state.steps).flat().find((s) => s.id === id) ?? null,
    getRun: async (_t: string, id: string) => state.runs.find((r) => r.id === id) ?? null,
    getJob: async () => ({ id: 'j1', requestedBy: 'u-member' } as Job),
    updateApproval: async (a: Approval) => { state.approvals = state.approvals.map((x) => (x.id === a.id ? a : x)); },
    updateRunStep: async () => undefined,
    updateRun: async (r: Run) => { state.runs = state.runs.map((x) => (x.id === r.id ? r : x)); },
    appendAudit: async () => undefined,
    createNotification: async (n: Notification) => { state.notifications.push(n); },
  } as unknown as Repository;
  return { repo, state };
}

test('7 日を過ぎた終わった実行だけ中身を消し、承認待ちの実行は 30 日までは消さない', async () => {
  const { repo, state } = fakeRepo();
  const r = new GoogleDataRetention({ repo, isGoogleTool, logger: silentLogger });
  const sixDays = await r.sweep(new Date('2026-09-07T00:00:00.000Z'));
  assert.deepEqual(sixDays, { expired: 0, redacted: 0 }, '6 日目はまだ残す');
  const eightDays = await r.sweep(new Date('2026-09-09T00:00:00.000Z'));
  assert.deepEqual(eightDays, { expired: 0, redacted: 1 });
  assert.deepEqual(state.marked.map((m) => m.runId), ['r-done'], '承認待ちの実行は消さない');
  assert.equal((state.marked[0]!.steps![0]!.output as { redacted: boolean }).redacted, true);
});

test('承認待ちのまま 30 日たった実行は期限切れにして止め、依頼者に知らせ、中身を消す', async () => {
  const { repo, state } = fakeRepo();
  const r = new GoogleDataRetention({ repo, isGoogleTool, logger: silentLogger });
  const result = await r.sweep(new Date('2026-10-02T00:00:00.000Z'));
  assert.equal(result.expired, 1);
  assert.equal(state.runs.find((x) => x.id === 'r-wait')!.status, 'expired');
  assert.equal(state.approvals[0]!.decision, 'expired');
  assert.equal(state.notifications[0]?.userId, 'u-member');
  assert.ok(state.marked.some((m) => m.runId === 'r-wait' && m.steps !== null), '期限切れの実行の中身もすぐに消す');
  assert.ok(REDACTED_PRESENT.includes('消しました'));
});
