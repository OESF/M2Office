/**
 * @file 実行の中止（状態の書き換え、承認の取り下げ、知らせる相手）の単体テスト。
 *
 * @see 仕様書 第9.3.1節 実行の中止
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, Audit, Job, Run, RunStep } from '@m2office/shared';
import { CANCELLABLE, cancelRun, createdDriveLinks, type Repository } from '../src/index.js';

const at = '2026-09-23T00:00:00.000Z';
const REASON = '依頼した人が止めました';

const makeRun = (status: Run['status']): Run =>
  ({ id: 'r1', jobId: 'j1', tenantId: 't', status, cursor: 1, startedAt: at, endedAt: null, tokensUsed: 5, costJpy: 1, savedMinutes: 0, failureReason: null } as Run);
const makeJob = (): Job =>
  ({ id: 'j1', tenantId: 't', agentId: 'minutes', agentVersion: 1, requestedBy: 'u-member', origin: 'menu', input: {}, createdAt: at });

function fake(status: Run['status'], approvals: Approval[] = []) {
  const state = {
    run: makeRun(status),
    approvals,
    audits: [] as Audit[],
    steps: [] as Partial<RunStep>[],
  };
  const repo = {
    getRun: async () => state.run,
    updateRun: async (r: Run) => { state.run = r; },
    listRunApprovals: async () => state.approvals,
    updateApproval: async (a: Approval) => { state.approvals = state.approvals.map((x) => (x.id === a.id ? a : x)); },
    listRunSteps: async () => state.steps,
    updateRunStep: async (_t: string, step: RunStep) => {
      state.steps = state.steps.map((x) => (x.id === step.id ? step : x));
    },
    listUsers: async () => [
      { id: 'u-member', roles: ['member'], status: 'active' },
      { id: 'u-approver', roles: ['approver'], status: 'active' },
      { id: 'u-gone', roles: ['approver'], status: 'disabled' },
    ],
    appendAudit: async (a: Audit) => { state.audits.push(a); },
  } as unknown as Repository;
  return { repo, state };
}

const pending = (id: string): Approval =>
  ({ id, runStepId: 's1', tenantId: 't', approverRole: ['approver'], approverUserId: null, present: '', decision: null, decidedBy: null, comment: null, decidedAt: null, createdAt: at });

test('動いている途中の実行を止め、理由を記録する', async () => {
  const { repo, state } = fake('running');
  const out = await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' });

  assert.equal(out.stopped, true);
  assert.equal(state.run.status, 'cancelled');
  assert.equal(state.run.failureReason, REASON);
  assert.equal(state.run.endedAt !== null, true);
});

test('止めた人を監査ログに残す', async () => {
  const { repo, state } = fake('queued');
  await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' }, { via: 'api' });

  assert.equal(state.audits.length, 1);
  const a = state.audits[0]!;
  assert.equal(a.action, 'run.cancel');
  assert.equal(a.actorType, 'user');
  assert.equal(a.actorId, 'u-member');
  assert.equal(a.targetId, 'r1');
  assert.deepEqual(a.detail, { agentId: 'minutes', via: 'api' });
});

test('終わった実行は止めず、状態も書き換えない', async () => {
  for (const status of ['completed', 'failed', 'cancelled', 'expired'] as Run['status'][]) {
    const { repo, state } = fake(status);
    const out = await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' });
    assert.equal(out.stopped, false, status);
    assert.equal(state.run.status, status, status);
    assert.equal(state.run.failureReason, null, status);
  }
});

test('止められる状態は、待ち行列・実行中・承認待ちの 3 つだけ', () => {
  assert.deepEqual([...CANCELLABLE].sort(), ['awaiting_approval', 'queued', 'running']);
});

test('承認待ちの承認を承認トレイから外し、判断できた人を返す', async () => {
  const { repo, state } = fake('awaiting_approval', [pending('a1')]);
  const out = await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' });

  assert.equal(state.approvals[0]!.decision, 'cancelled');
  assert.equal(state.approvals[0]!.comment, REASON);
  // 停止中の利用者（u-gone）には知らせない
  assert.deepEqual(out.approvers, ['u-approver']);
});

test('止めた本人には知らせない', async () => {
  // 依頼した本人が承認者でもある場合（approver: requester）
  const self: Approval = { ...pending('a1'), approverRole: [], approverUserId: 'u-member' };
  const { repo, state } = fake('awaiting_approval', [self]);
  const out = await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' });

  assert.equal(state.approvals[0]!.decision, 'cancelled');
  assert.deepEqual(out.approvers, []);
});

test('すでに判断済みの承認は触らない', async () => {
  const decided: Approval = { ...pending('a1'), decision: 'approved', decidedBy: 'u-approver', decidedAt: at };
  const { repo, state } = fake('running', [decided]);
  await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' });

  assert.equal(state.approvals[0]!.decision, 'approved');
  assert.equal(state.approvals[0]!.comment, null);
});

test('承認を待っていたステップも「中止」にする', async () => {
  const { repo, state } = fake('awaiting_approval', [pending('a1')]);
  state.steps = [
    { id: 's0', status: 'succeeded', endedAt: at },
    { id: 's1', status: 'awaiting', endedAt: null },
  ] as Partial<RunStep>[];

  await cancelRun(repo, makeJob(), state.run, REASON, { actorType: 'user', actorId: 'u-member' });

  // 承認待ちのままに見えると、まだ判断が要ると誤解される
  assert.equal(state.steps[1]!.status, 'cancelled');
  assert.equal(state.steps[1]!.endedAt !== null, true);
  // 終わったステップは触らない
  assert.equal(state.steps[0]!.status, 'succeeded');
});

test('作りかけの文書のリンクを、3 件まで拾う', async () => {
  const { repo, state } = fake('running');
  state.steps = [{
    output: {
      tools: [
        { name: 'document.create', result: { url: 'https://docs.google.com/document/d/a/edit' } },
        { name: 'drive.save', result: { url: 'https://drive.google.com/file/d/b/view' } },
        { name: 'web.research', result: { url: 'https://example.com/not-google' } },
        { name: 'document.create', result: { url: 'https://docs.google.com/document/d/c/edit' } },
        { name: 'document.create', result: { url: 'https://docs.google.com/document/d/d/edit' } },
      ],
    },
  }] as Partial<RunStep>[];

  const links = await createdDriveLinks(repo, 't', 'r1');
  assert.deepEqual(links, [
    'https://docs.google.com/document/d/a/edit',
    'https://drive.google.com/file/d/b/view',
    'https://docs.google.com/document/d/c/edit',
  ]);
});
