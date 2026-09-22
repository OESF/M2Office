/**
 * `@m2office/core` の単体テスト。
 *
 * データベースを使わず、必要な操作だけを持つ記憶上の永続化層で確かめる。
 * 通しの確認は `npm run smoke` が担う。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentDefinition, Approval, AuditEvent, Job, Notification, Run, RunStep,
} from '@m2office/shared';
import {
  RunEngine, ToolRegistry, BUILTIN_TOOLS, MockWorkspaceConnector, nextRunAt,
  ApprovalForbiddenError, type LlmProvider, type Repository,
} from '../src/index.js';

/** 実行エンジンが使う操作だけを持つ、記憶上の永続化層。 */
class MemoryRepo {
  jobs: Job[] = [];
  runs: Run[] = [];
  steps: RunStep[] = [];
  approvals: Approval[] = [];
  audits: AuditEvent[] = [];
  notifications: Notification[] = [];
  users = [
    { id: 'u-admin', tenantId: 't', email: 'a@x', displayName: '管理者', roles: ['admin', 'approver'], status: 'active' },
    { id: 'u-member', tenantId: 't', email: 'm@x', displayName: '一般', roles: ['member'], status: 'active' },
  ];
  async getJob(t: string, id: string) { return this.jobs.find((j) => j.tenantId === t && j.id === id) ?? null; }
  async getRun(t: string, id: string) { return this.runs.find((r) => r.tenantId === t && r.id === id) ?? null; }
  async updateRun(run: Run) { this.runs = this.runs.map((r) => (r.id === run.id ? run : r)); }
  async listRunSteps(_t: string, runId: string) { return this.steps.filter((s) => s.runId === runId); }
  async appendRunStep(s: RunStep) { this.steps.push(s); }
  async updateRunStep(s: RunStep) { this.steps = this.steps.map((x) => (x.id === s.id ? s : x)); }
  async getRunStepById(_t: string, id: string) { return this.steps.find((s) => s.id === id) ?? null; }
  async createApproval(a: Approval) { this.approvals.push(a); }
  async getApproval(t: string, id: string) { return this.approvals.find((a) => a.tenantId === t && a.id === id) ?? null; }
  async updateApproval(a: Approval) { this.approvals = this.approvals.map((x) => (x.id === a.id ? a : x)); }
  async listPendingApprovals(t: string) { return this.approvals.filter((a) => a.tenantId === t && !a.decision); }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
  async createNotification(n: Notification) { this.notifications.push(n); }
  async findUserById(t: string, id: string) { return this.users.find((u) => u.tenantId === t && u.id === id) ?? null; }
  async createArtifact() {}
}

/** 常に同じツール呼び出しを出力する推論。承認の手前で送信を試みる場合を再現する。 */
class AlwaysCallLlm implements LlmProvider {
  readonly name = 'always-call';
  constructor(private readonly call: { name: string; args: Record<string, unknown> }) {}
  async complete() {
    return { text: '```tool\n' + JSON.stringify(this.call) + '\n```', tokensUsed: 10 };
  }
}

function setup(def: AgentDefinition, call: { name: string; args: Record<string, unknown> }) {
  const repo = new MemoryRepo();
  const connector = new MockWorkspaceConnector();
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const engine = new RunEngine({
    repo: repo as unknown as Repository, llm: new AlwaysCallLlm(call), registry, connector,
    resolveDefinition: () => def,
  });
  const now = new Date().toISOString();
  repo.jobs.push({ id: 'j1', tenantId: 't', agentId: def.id, agentVersion: 1, requestedBy: 'u-member',
    origin: 'menu', input: {}, createdAt: now });
  const run: Run = { id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now,
    endedAt: null, tokensUsed: 0, costJpy: 0, failureReason: null };
  repo.runs.push(run);
  return { repo, connector, engine, run };
}

const SHARE_DEF: AgentDefinition = {
  schemaVersion: 1, id: 'share-test', version: 1, name: 'テスト', category: 'test',
  description: 'テスト', locale: 'ja-JP', compartment: null, inputs: {},
  tools: ['chat.post'],
  steps: [
    { id: 'before', type: 'agent', instruction: '準備する' },
    { id: 'gate', type: 'approval', approverRole: ['approver'], present: '投稿内容' },
    { id: 'share', type: 'agent', instruction: '投稿する' },
  ],
  constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
};

test('承認の手前のステップでは、対外送信のツールを呼べない', async () => {
  const { repo, connector, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { text: '漏えい' } });
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'awaiting_approval');
  assert.equal(connector.outbox.length, 0, '承認前に投稿されてはならない');
  assert.ok(repo.audits.some((a) => a.action === 'tool.blocked' && a.targetId === 'chat.post'));
});

test('承認の直後のステップでは、対外送信のツールを呼べる', async () => {
  const { repo, connector, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有' } });
  const first = await engine.advance(run);
  assert.equal(first.outcome, 'awaiting_approval');
  if (first.outcome !== 'awaiting_approval') return;
  await engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
  const resumed = (await repo.getRun('t', 'r1'))!;
  const second = await engine.advance({ ...resumed, status: 'running' });
  assert.equal(second.outcome, 'completed');
  assert.equal(connector.outbox.filter((o) => o.kind === 'chat').length, 1);
});

test('承認者のロールを持たない利用者は、承認も却下もできない', async () => {
  const { engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: {} });
  const first = await engine.advance(run);
  if (first.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  for (const decision of ['approved', 'rejected'] as const) {
    await assert.rejects(
      engine.decideApproval('t', first.approvalId, decision, { id: 'u-member', roles: ['member'] }, null),
      ApprovalForbiddenError,
    );
  }
});

test('notification.send は依頼者本人にだけ届き、宛先の指定を拒む', async () => {
  const def: AgentDefinition = { ...SHARE_DEF, id: 'notify-test', tools: ['notification.send'],
    steps: [{ id: 'n', type: 'agent', instruction: '通知する' }] };

  const ok = setup(def, { name: 'notification.send', args: { title: '週次', body: '本文' } });
  await ok.engine.advance(ok.run);
  assert.equal(ok.repo.notifications.length, 1);
  assert.equal(ok.repo.notifications[0]!.userId, 'u-member', '依頼者本人に届く');

  const ng = setup(def, { name: 'notification.send', args: { to: 'u-admin', title: '他人宛' } });
  await ng.engine.advance(ng.run);
  assert.equal(ng.repo.notifications.length, 0, '宛先を指定した通知は送らない');
});

test('ダミー接続は、テナントと利用者ごとに書き込みを分ける', async () => {
  const c = new MockWorkspaceConnector();
  await c.tasks.create({ tenantId: 'a', userId: 'u1' }, { title: 'A 社のタスク', due: null });
  const other = await c.tasks.list({ tenantId: 'b', userId: 'u1' }, {});
  assert.ok(other.every((t) => t.title !== 'A 社のタスク'));
});

test('定時実行の次回時刻は、日本時間の壁時計で求める', () => {
  // 2026-09-22（火）10:00 JST
  const tue = new Date('2026-09-22T01:00:00Z');
  const weekly = nextRunAt({ kind: 'weekly', weekday: 1, hour: 8, minute: 0 }, 'Asia/Tokyo', tue);
  assert.equal(weekly, '2026-09-27T23:00:00.000Z', '次の月曜 8:00 JST');

  const daily = nextRunAt({ kind: 'daily', hour: 8, minute: 30 }, 'Asia/Tokyo', tue);
  assert.equal(daily, '2026-09-22T23:30:00.000Z', '今日の 8:30 は過ぎているので翌日');

  const exact = nextRunAt({ kind: 'daily', hour: 10, minute: 0 }, 'Asia/Tokyo', tue);
  assert.equal(exact, '2026-09-23T01:00:00.000Z', 'ちょうどの時刻は含めず次の回');
});
