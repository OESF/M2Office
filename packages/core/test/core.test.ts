/**
 * @file `@m2office/core` の単体テスト。承認ゲート・操作の確認・通知の宛先・ファイル処理などを確かめる。
 *
 * データベースを使わず、必要な操作だけを持つ記憶上の永続化層で確かめる。
 * 通しの確認は `npm run smoke` が担う。
 *
 * @see 開発規約 第8章 テスト
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS,
  type AgentDefinition, type Approval, type Artifact, type AuditEvent, type Job, type Notification, type Run,
  type RunStep, type TenantSettings,
} from '@m2office/shared';
import {
  RunEngine, ToolRegistry, BUILTIN_TOOLS, MockWorkspaceConnector, MemoryFileStore, nextRunAt, needsHuman, AUTO_PASS_REASON,
  saveFile, readSheet, renderSheet, parseCsv, extractPdfText,
  ApprovalForbiddenError, ConnectorUnavailableError, hideInternalIds, repeatsArtifact, DefinitionInvalidError, validateDefinition, OFFICIAL_AGENTS, todayJst, describeCall, jpDate,
  type LlmProvider, type LlmRequest, type Repository, type KnowledgeItem,
} from '../src/index.js';

/** 実行エンジンが使う操作だけを持つ、記憶上の永続化層。 */
/** 社内への書き込みにも承認を求める会社の設定（第 0.114.0 版までの既定）。 */
const STRICT_POLICY: TenantSettings['automation'] = { writeInternal: 'require', perAgent: { 'weekly-brief': 'allow' } };

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
  async appendRunStep(_t: string, s: RunStep) { this.steps.push(s); }
  async updateRunStep(_t: string, s: RunStep) { this.steps = this.steps.map((x) => (x.id === s.id ? s : x)); }
  async getRunStepById(_t: string, id: string) { return this.steps.find((s) => s.id === id) ?? null; }
  async createApproval(a: Approval) { this.approvals.push(a); }
  async getApproval(t: string, id: string) { return this.approvals.find((a) => a.tenantId === t && a.id === id) ?? null; }
  async updateApproval(a: Approval) { this.approvals = this.approvals.map((x) => (x.id === a.id ? a : x)); }
  async listPendingApprovals(t: string) { return this.approvals.filter((a) => a.tenantId === t && !a.decision); }
  async listRunApprovals(t: string, runId: string) {
    const ids = new Set(this.steps.filter((x) => x.runId === runId).map((x) => x.id));
    return this.approvals.filter((a) => a.tenantId === t && ids.has(a.runStepId));
  }
  // 見本の依頼の入力にはファイルを入れないため、承認は無い
  async listApprovalsForFileInput() { return []; }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
  async createNotification(n: Notification) { this.notifications.push(n); }
  async findUserById(t: string, id: string) { return this.users.find((u) => u.tenantId === t && u.id === id) ?? null; }
  async listUsers(t: string) { return this.users.filter((u) => u.tenantId === t); }
  async listNotifications(t: string, userId: string) {
    return this.notifications.filter((n) => n.tenantId === t && n.userId === userId);
  }
  artifacts: Artifact[] = [];
  async createArtifact(a: Artifact) { this.artifacts.push(a); }
  async listArtifacts(t: string, runId: string) { return this.artifacts.filter((a) => a.tenantId === t && a.runId === runId); }
  knowledge: KnowledgeItem[] = [];
  async saveKnowledge(k: KnowledgeItem) {
    const prev = this.knowledge.find((x) => x.id === k.id);
    // 由来は最初の登録のときだけ書く（postgres.ts と同じ）
    const next = prev ? { ...k, originRunId: prev.originRunId, googleDerived: prev.googleDerived } : k;
    this.knowledge = [...this.knowledge.filter((x) => x.id !== k.id), next];
  }
  fileRows: Record<string, unknown>[] = [];
  async createFile(f: Record<string, unknown>) { this.fileRows.push(f); }
  async getFile(t: string, id: string) { return this.fileRows.find((f) => f['tenantId'] === t && f['id'] === id) ?? null; }
  // 人の承認の流れを確かめるため、既定は「社内への書き込み: 承認が必要」にしている会社とする。
  // 新しい既定（承認なし。仕様書 第9.4.0節）での自動の通過は、個別のテストで確かめる
  settings: TenantSettings = structuredClone({ ...DEFAULT_TENANT_SETTINGS, automation: STRICT_POLICY });
  async getTenantSettings() { return this.settings; }
  groupsOf: Record<string, string[]> = {};
  compartmentsOf: Record<string, string[]> = {};
  async listUserCompartments(_t: string, u: string) { return this.compartmentsOf[u] ?? []; }
  async listUserGroupIds(_t: string, u: string) { return this.groupsOf[u] ?? []; }
  userSettings = structuredClone(DEFAULT_USER_SETTINGS);
  async getUserSettings() { return this.userSettings; }
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
  const files = new MemoryFileStore();
  const engine = new RunEngine({
    repo: repo as unknown as Repository, llm: new AlwaysCallLlm(call), registry, connector, files,
    resolveDefinition: () => def,
  });
  const now = new Date().toISOString();
  repo.jobs.push({ id: 'j1', tenantId: 't', agentId: def.id, agentVersion: 1, requestedBy: 'u-member',
    origin: 'menu', input: {}, createdAt: now });
  const run: Run = { id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now,
    endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null };
  repo.runs.push(run);
  return { repo, connector, engine, run, files };
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

test('依頼者が利用範囲の外なら、実行を進めずに止める（第16.7.4節）', async () => {
  const { repo, connector, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有します' } });
  repo.settings.access = { scopes: { 'share-test': { groups: ['g-dev'], users: [] } } };
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'failed');
  assert.match(res.outcome === 'failed' ? res.reason : '', /利用範囲の外/);
  assert.equal(connector.outbox.length, 0);
});

test('利用範囲のグループに所属していれば実行できる', async () => {
  const { repo, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有します' } });
  repo.settings.access = { scopes: { 'share-test': { groups: ['g-dev'], users: [] } } };
  repo.groupsOf['u-member'] = ['g-dev'];
  assert.equal((await engine.advance(run)).outcome, 'awaiting_approval');
});

test('権限区画に属する業務は、区画に入れない依頼者では実行しない（第16.3.6節）', async () => {
  const def = { ...SHARE_DEF, id: 'hr-test', compartment: 'hr' };
  const { repo, engine, run } = setup(def, { name: 'chat.post', args: { text: '共有します' } });
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'failed');
  assert.match(res.outcome === 'failed' ? res.reason : '', /権限区画/);
  repo.runs = repo.runs.map((r) => ({ ...r, status: 'running', endedAt: null, failureReason: null }));
  repo.compartmentsOf['u-member'] = ['hr'];
  assert.equal((await engine.advance((await repo.getRun('t', 'r1'))!)).outcome, 'awaiting_approval', '区画に入れる人なら進む');
});

test('承認者のロールを持たない利用者は、承認も却下もできない', async () => {
  const { engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有します' } });
  const first = await engine.advance(run);
  if (first.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  for (const decision of ['approved', 'rejected'] as const) {
    await assert.rejects(
      engine.decideApproval('t', first.approvalId, decision, { id: 'u-member', roles: ['member'] }, null),
      ApprovalForbiddenError,
    );
  }
});

test('approver: requester の承認は、依頼した本人だけが判断できる', async () => {
  const def: AgentDefinition = {
    ...SHARE_DEF, id: 'requester-test',
    steps: SHARE_DEF.steps.map((s) =>
      s.type === 'approval' ? { ...s, approver: 'requester' as const, approverRole: [] } : s),
  };
  const { repo, engine, run } = setup(def, { name: 'chat.post', args: { text: '共有します' } });
  const first = await engine.advance(run);
  if (first.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  assert.equal(repo.approvals[0]!.approverUserId, 'u-member', '依頼者が承認者として記録される');

  // 承認者・管理者のロールを持っていても、本人でなければ判断できない
  await assert.rejects(
    engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null),
    ApprovalForbiddenError,
  );
  await engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-member', roles: ['member'] }, null);
  assert.equal((await repo.getRun('t', 'r1'))!.status, 'queued', '本人の承認で再開できる');
});

test('adminAlsoWhen: 会社の設定が入なら、本人の承認のあとに同じ段で管理者の承認を加える（本人が管理者なら加えない）', async () => {
  const def: AgentDefinition = {
    ...SHARE_DEF, id: 'admin-also-test',
    steps: SHARE_DEF.steps.map((s) =>
      s.type === 'approval' ? { ...s, approver: 'requester' as const, approverRole: [], adminAlsoWhen: 'cards.bulkMailAdminApproval' as const } : s),
  };
  const { repo, engine, run } = setup(def, { name: 'chat.post', args: { text: '共有します' } });
  repo.users = [
    { id: 'u-member', tenantId: 't', email: 'm@x.example', displayName: '依頼 花子', roles: ['member'], status: 'active' },
    { id: 'u-admin', tenantId: 't', email: 'a@x.example', displayName: '管理 太郎', roles: ['admin'], status: 'active' },
  ] as never;
  repo.settings.cards = { ...repo.settings.cards, bulkMailAdminApproval: true };
  const first = await engine.advance(run);
  if (first.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  await engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-member', roles: ['member'] }, null);
  assert.equal((await repo.getRun('t', 'r1'))!.status, 'awaiting_approval', '本人の承認だけでは進まない');
  const admin = repo.approvals.find((a) => a.decision === null)!;
  assert.deepEqual([admin.approverRole, admin.approverUserId], [['admin'], null]);
  assert.equal(admin.runStepId, repo.approvals[0]!.runStepId, '同じ段の承認');
  assert.equal(admin.present.split('\n')[0], repo.approvals[0]!.present.split('\n')[0], '1 行目は定義の present のまま');
  assert.match(admin.present, /依頼 花子さん（依頼した人）が承認しました/);
  assert.ok(repo.notifications.some((n) => n.userId === 'u-admin'), '管理者に知らせる');
  await assert.rejects(engine.decideApproval('t', admin.id, 'approved', { id: 'u-member', roles: ['member'] }, null), ApprovalForbiddenError);
  await engine.decideApproval('t', admin.id, 'approved', { id: 'u-admin', roles: ['admin'] }, null);
  assert.equal((await repo.getRun('t', 'r1'))!.status, 'queued', '管理者が承認して初めて進む');

  // 依頼した本人が管理者なら、本人の承認で足りる（管理者が 1 人の会社で止まらない）
  const self = setup(def, { name: 'chat.post', args: { text: '共有します' } });
  self.repo.settings.cards = { ...self.repo.settings.cards, bulkMailAdminApproval: true };
  self.repo.jobs = self.repo.jobs.map((j) => ({ ...j, requestedBy: 'u-admin' }));
  const own = await self.engine.advance(self.run);
  if (own.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  await self.engine.decideApproval('t', own.approvalId, 'approved', { id: 'u-admin', roles: ['admin'] }, null);
  assert.equal((await self.repo.getRun('t', 'r1'))!.status, 'queued');
  assert.equal(self.repo.approvals.length, 1);

  // 設定が切りなら加えない
  const off = setup(def, { name: 'chat.post', args: { text: '共有します' } });
  const o = await off.engine.advance(off.run);
  if (o.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  await off.engine.decideApproval('t', o.approvalId, 'approved', { id: 'u-member', roles: ['member'] }, null);
  assert.equal((await off.repo.getRun('t', 'r1'))!.status, 'queued');
});

test('ロールで判断する承認に、ロールの指定が無い定義は拒否する', () => {
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const def: AgentDefinition = {
    ...SHARE_DEF,
    steps: SHARE_DEF.steps.map((s) => (s.type === 'approval' ? { ...s, approverRole: [] } : s)),
  };
  assert.throws(() => validateDefinition(def, registry), DefinitionInvalidError);
});

test('notification.send は依頼者本人にだけ届き、宛先の指定を拒む', async () => {
  const def: AgentDefinition = { ...SHARE_DEF, id: 'notify-test', tools: ['notification.send'],
    steps: [{ id: 'n', type: 'agent', instruction: '通知する' }] };

  // 宛先の扱いだけを確かめるため、操作の確認は省略する設定にする
  const ok = setup(def, { name: 'notification.send', args: { title: '週次', body: '本文' } });
  ok.repo.settings.automation.writeInternal = 'allow';
  await ok.engine.advance(ok.run);
  assert.equal(ok.repo.notifications.length, 1);
  assert.equal(ok.repo.notifications[0]!.userId, 'u-member', '依頼者本人に届く');

  const ng = setup(def, { name: 'notification.send', args: { to: 'u-admin', title: '他人宛' } });
  ng.repo.settings.automation.writeInternal = 'allow';
  await ng.engine.advance(ng.run);
  // 実行が終わったことの通知（第6.5.5.1節）とは別に、ツールの通知が作られていないことを見る
  assert.equal(ng.repo.notifications.filter((n) => n.title === '他人宛').length, 0, '宛先を指定した通知は送らない');
  assert.deepEqual(ng.repo.notifications.map((n) => n.userId), ['u-member'], '他人には届かない');

  const off = setup(def, { name: 'notification.send', args: { kind: 'brief', title: '週次' } });
  off.repo.settings.automation.writeInternal = 'allow';
  off.repo.userSettings.notifications.kinds.brief = false;
  await off.engine.advance(off.run);
  assert.equal(off.repo.notifications.filter((n) => n.kind === 'brief').length, 0, '本人が受け取らないと決めた種類は届けない');
});

const TASK_DEF: AgentDefinition = {
  ...SHARE_DEF, id: 'task-test', tools: ['tasks.create'],
  steps: [
    { id: 'make', type: 'agent', instruction: '起票する' },
    { id: 'after', type: 'agent', instruction: '後片付け' },
  ],
};

test('会社が「承認が必要」にしていれば、社内への書き込みの前に本人の確認を求める', async () => {
  const { repo, connector, engine, run } = setup(TASK_DEF, { name: 'tasks.create', args: { title: '確認後に起票' } });
  const first = await engine.advance(run);
  assert.equal(first.outcome, 'awaiting_approval');
  if (first.outcome !== 'awaiting_approval') return;
  const listed = async () => connector.tasks.list({ tenantId: 't', userId: 'u-member' }, {});
  assert.ok((await listed()).every((t) => t.title !== '確認後に起票'), '確認前は起票しない');
  assert.equal(repo.approvals[0]!.approverUserId, 'u-member', '確認するのは依頼した本人');

  await engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-member', roles: ['member'] }, null);
  const resumed = (await repo.getRun('t', 'r1'))!;
  // 再開後は推論の出力に関係なく、記録した操作を実行する
  await engine.advance({ ...resumed, status: 'running' });
  const created = (await listed()).filter((t) => t.title === '確認後に起票');
  assert.ok(created.length >= 1, '承認した操作が実行される');
});

test('会社の設定で「承認なし」にすると、社内への書き込みをそのまま実行する', async () => {
  const { repo, engine, run } = setup(TASK_DEF, { name: 'tasks.create', args: { title: 'すぐ起票' } });
  repo.settings.automation = { writeInternal: 'allow', perAgent: {} };
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'completed');
  assert.equal(repo.approvals.length, 0);
});

test('AG-05 の例外: エージェントごとの設定が全体の設定より優先される', async () => {
  const def = { ...TASK_DEF, id: 'weekly-brief' };
  const { repo, engine, run } = setup(def, { name: 'tasks.create', args: { title: '例外' } });
  assert.equal(repo.settings.automation.writeInternal, 'require');
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'completed', '業務ごとの「承認なし」が全体の「承認が必要」より優先される');
});

test('無効にされた業務は実行しない', async () => {
  const { repo, engine, run } = setup(TASK_DEF, { name: 'tasks.create', args: {} });
  repo.settings.agents.disabled = ['task-test'];
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'failed');
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

// ---- 文書を扱う共通ツール（仕様書 第9.4.1節）----

import { readFileSync } from 'node:fs';

const FILE_DEF = (tools: string[]): AgentDefinition => ({
  ...SHARE_DEF, id: 'file-test', tools, steps: [{ id: 'x', type: 'agent', instruction: '読む' }],
});

test('pdf.extract は日本語の PDF から文字を取り出し、部首の文字を通常の漢字に直す', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/invoice-ja.pdf', import.meta.url)));
  const probe = setup(FILE_DEF(['pdf.extract']), { name: 'noop', args: {} });
  const meta = await saveFile(probe.repo as unknown as Repository, probe.files, {
    tenantId: 't', ownerUserId: 'u-member', name: '請求書.pdf', kind: 'pdf', bytes, origin: 'upload', runId: null,
  });
  // 同じ永続化層とファイル置き場を使うため、呼び出しだけを差し替える
  const call = { name: 'pdf.extract', args: { fileId: meta.id } };
  (probe.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = new AlwaysCallLlm(call);
  await probe.engine.advance(probe.run);
  const out = (probe.repo.steps[0]!.output as { tools: { result: { pages: { text: string }[]; pageCount: number } }[] })
    .tools[0]!.result;
  assert.equal(out.pageCount, 2);
  assert.match(out.pages[0]!.text, /請求金額 110,000 円/);
  assert.match(out.pages[1]!.text, /銀行/);
});

test('他人がアップロードしたファイルは、ID を知っていても読めない', async () => {
  const probe = setup(FILE_DEF(['sheet.read']), { name: 'noop', args: {} });
  const meta = await saveFile(probe.repo as unknown as Repository, probe.files, {
    tenantId: 't', ownerUserId: 'u-admin', name: 'secret.csv', kind: 'csv',
    bytes: new TextEncoder().encode('a,b\n1,2\n'), origin: 'upload', runId: null,
  });
  (probe.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm =
    new AlwaysCallLlm({ name: 'sheet.read', args: { fileId: meta.id } });
  await probe.engine.advance(probe.run); // 依頼者は u-member
  const out = (probe.repo.steps[0]!.output as { tools: { result: { available: boolean } }[] }).tools[0]!.result;
  assert.equal(out.available, false);
});

test('Shift_JIS の CSV を読める', async () => {
  // 「取引先,金額」「株式会社サンプル,110000」を Shift_JIS で表したもの
  const sjis = new Uint8Array([
    0x8e, 0xe6, 0x88, 0xf8, 0x90, 0xe6, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a, 0x0d, 0x0a,
    0x8a, 0x94, 0x8e, 0xae, 0x89, 0xef, 0x8e, 0xd0, 0x83, 0x54, 0x83, 0x93, 0x83, 0x76, 0x83, 0x8b,
    0x2c, 0x31, 0x31, 0x30, 0x30, 0x30, 0x30, 0x0d, 0x0a,
  ]);
  const data = await readSheet(sjis, 'csv');
  assert.equal(data.encoding, 'shift_jis');
  assert.deepEqual(data.rows, [['取引先', '金額'], ['株式会社サンプル', '110000']]);
});

test('CSV の引用符・改行・カンマを正しく分ける', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n"改\n行",x\n'), [['a', 'b,c', 'd"e'], ['改\n行', 'x']]);
});

test('sheet.render の Excel を sheet.read で読み戻すと同じ表になる', async () => {
  const bytes = await renderSheet('入金一覧', ['取引先', '金額'], [['株式会社サンプル', 110000]], 'xlsx');
  const data = await readSheet(bytes, 'xlsx');
  assert.equal(data.sheet, '入金一覧');
  assert.deepEqual(data.rows, [['取引先', '金額'], ['株式会社サンプル', 110000]]);

  const csv = await renderSheet('入金一覧', ['取引先'], [['a,b']], 'csv');
  assert.deepEqual([...csv.slice(0, 3)], [0xef, 0xbb, 0xbf], 'CSV は BOM 付き UTF-8');
});

// ---- 削減時間の推計（仕様書 第6.7.12節）----

test('最後まで完了した実行に、標準所要時間を削減時間として記録する', async () => {
  const def = { ...TASK_DEF, id: 'weekly-brief' }; // 既定値 20 分、承認なし（Q-53）
  const { repo, engine, run } = setup(def, { name: 'tasks.create', args: { title: 'x' } });
  await engine.advance(run);
  assert.equal((await repo.getRun('t', 'r1'))!.savedMinutes, 20);
});

test('会社が標準所要時間を変えていれば、その値を使う', async () => {
  const def = { ...TASK_DEF, id: 'weekly-brief' };
  const { repo, engine, run } = setup(def, { name: 'tasks.create', args: { title: 'x' } });
  repo.settings.effect = { minutesPerRun: { 'weekly-brief': 45 } };
  await engine.advance(run);
  assert.equal((await repo.getRun('t', 'r1'))!.savedMinutes, 45);
});

test('途中で終了した実行は、削減時間を 0 とする', async () => {
  const def: AgentDefinition = {
    ...TASK_DEF, id: 'weekly-brief',
    steps: [{ id: 'x', type: 'agent', instruction: '何もしない', onEmpty: 'stop' }, ...TASK_DEF.steps],
  };
  // 空の応答を返す推論で、onEmpty: stop により終了させる
  const probe = setup(def, { name: 'noop', args: {} });
  (probe.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'empty', complete: async () => ({ text: '', tokensUsed: 1 }),
  };
  await probe.engine.advance(probe.run);
  const run = (await probe.repo.getRun('t', 'r1'))!;
  assert.equal(run.status, 'completed');
  assert.equal(run.savedMinutes, 0);
});

test('手順の途中で止められた実行は、次の手順を行わず、止めた状態を上書きしない（仕様書 第6.5.2.1節）', async () => {
  const { repo, engine, run } = setup(SHARE_DEF, { name: 'noop', args: {} });
  let cancelledSeen: Run | null = null;
  // 最初の手順の推論の間に、別の処理（連携の解除）が実行を止めたことにする
  (engine as unknown as { deps: { llm: LlmProvider; onCancelled: (r: Run) => Promise<void> } }).deps.llm = {
    name: 'stop-during', async complete() {
      await repo.updateRun({ ...repo.runs[0]!, status: 'cancelled', endedAt: new Date().toISOString(), failureReason: 'Google との連携を解除したため止めました' });
      return { text: '準備しました', tokensUsed: 7 };
    },
  };
  (engine as unknown as { deps: { onCancelled: (r: Run) => Promise<void> } }).deps.onCancelled = async (r) => { cancelledSeen = r; };
  const res = await engine.advance(run);
  assert.deepEqual(res, { outcome: 'cancelled', reason: 'Google との連携を解除したため止めました' });
  assert.equal(repo.runs[0]!.status, 'cancelled', '止めた状態のまま');
  assert.equal(repo.runs[0]!.tokensUsed, 7, '止められる前に使い終えたトークンは記録する');
  assert.equal(repo.approvals.length, 0, '次の手順（承認）へ進まない');
  assert.ok(cancelledSeen, '止められたことを知らせる（後から書き込まれた中身を消すため）');
});

const AG02_MINUTES = OFFICIAL_AGENTS.find((a) => a.id === 'minutes')!;

/**
 * AG-02 の手順ごとに決まったツールを呼ぶ推論。成果物の ID は記憶上の永続化層から拾う。
 *
 * @param extra 手順ごとに足すツール呼び出し（承認②の手前で登録を試みる場合など）
 */
function minutesLlm(repo: MemoryRepo, extra: Record<string, { name: string; args: Record<string, unknown> }[]> = {}): LlmProvider {
  return {
    name: 'minutes-script',
    async complete(req: LlmRequest) {
      const stepId = req.context?.stepId ?? '';
      const artifactId = repo.artifacts[0]?.id ?? 'none';
      const base: Record<string, { name: string; args: Record<string, unknown> }[]> = {
        fetch: [{ name: 'meeting.get_transcript', args: { transcript: '販促は A 案で進めることを決定。' } }],
        draft: [{ name: 'document.create', args: { kind: 'minutes', title: '営業定例の議事録', body: '## 決定事項\n販促は A 案で進める。' } }],
        tasks: [{ name: 'tasks.create', args: { title: 'A 案の準備' } }],
        share: [{ name: 'chat.post', args: { space: 'general', text: '議事録を共有します' } },
          { name: 'knowledge.register', args: { artifactId } }],
      };
      const calls = [...(base[stepId] ?? []), ...(extra[stepId] ?? [])];
      return { text: calls.map((c) => '```tool\n' + JSON.stringify(c) + '\n```').join('\n'), tokensUsed: 10 };
    },
  };
}

/** AG-02 を、承認を 2 回通して最後まで進める。`rejectShare` なら承認②を却下する。 */
async function runMinutes(opts: { rejectShare?: boolean; extra?: Parameters<typeof minutesLlm>[1]; def?: AgentDefinition } = {}) {
  const ctx = setup(opts.def ?? AG02_MINUTES, { name: 'noop', args: {} });
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = minutesLlm(ctx.repo, opts.extra);
  const admin = { id: 'u-admin', roles: ['admin', 'approver'] };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(`承認①で止まらない: ${first.outcome}`);
  await ctx.engine.decideApproval('t', first.approvalId, 'approved', admin, null);
  const second = await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' });
  if (second.outcome !== 'awaiting_approval') assert.fail(`承認②で止まらない: ${second.outcome}`);
  await ctx.engine.decideApproval('t', second.approvalId, opts.rejectShare ? 'rejected' : 'approved', admin, null);
  if (!opts.rejectShare) {
    assert.equal((await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' })).outcome, 'completed');
  }
  return ctx;
}

/** ステップの出力から、指定したツールの結果を集める。 */
function resultsOf(repo: MemoryRepo, stepId: string, tool: string): Record<string, unknown>[] {
  return repo.steps.filter((s) => s.stepId === stepId).flatMap((s) =>
    ((s.output as { tools?: { name: string; result?: Record<string, unknown> }[] } | null)?.tools ?? [])
      .filter((t) => t.name === tool).map((t) => t.result ?? {}));
}

test('AG-02 は承認②のあと、承認①で見た議事録をそのまま組織知識に登録する（第9.5.2節）', async () => {
  const { repo } = await runMinutes();
  assert.equal(repo.knowledge.length, 1);
  const k = repo.knowledge[0]!;
  assert.equal(k.id, 'run-r1', '知識の ID は実行から決める');
  assert.equal(k.body, repo.artifacts[0]!.body, '成果物の本文をそのまま登録する');
  assert.match(k.title, /^営業定例の議事録（\d{4}-\d{2}-\d{2}）$/, '題名に日付を添える');
  assert.equal(k.kind, 'minutes');
  assert.equal(k.compartment, null);
  assert.equal(k.originRunId, 'r1');
  assert.equal(k.googleDerived, false, '貼り付けた記録は Google 由来ではない（ToDo・投稿は数えない）');
  const audit = repo.audits.find((a) => a.action === 'knowledge.register');
  assert.equal(audit?.actorId, 'u-member', '登録者は依頼した本人');
  assert.deepEqual(audit?.detail, { runId: 'r1', artifactId: repo.artifacts[0]!.id, googleDerived: false });
});

test('承認②の手前（承認①の直後）では、知識に登録しない', async () => {
  const extra = { tasks: [{ name: 'knowledge.register', args: { artifactId: 'x' } }] };
  // 1. AG-02 の定義のまま: 「起票」の段では知識の登録を使えない（段ごとのツール。第9.2.7節）
  const scoped = await runMinutes({ rejectShare: true, extra });
  const blocked = scoped.repo.steps.filter((x) => x.stepId === 'tasks')
    .flatMap((x) => ((x.output as { tools?: { name: string; error?: string }[] }).tools ?? []).filter((t) => t.name === 'knowledge.register'));
  assert.match(String(blocked[0]?.error), /この段（起票）では使えないツールです/);
  assert.equal(scoped.repo.knowledge.length, 0);
  // 2. 段ごとのツールが無くても、ツールそのものが「すべての承認のあと」でなければ登録しない（二重の守り）
  const unscoped = { ...AG02_MINUTES, steps: AG02_MINUTES.steps.map((st) => (st.type === 'agent' ? { ...st, tools: undefined } : st)) };
  const { repo } = await runMinutes({ rejectShare: true, extra, def: unscoped });
  const early = resultsOf(repo, 'tasks', 'knowledge.register');
  assert.equal(early[0]?.['registered'], false);
  assert.match(String(early[0]?.['reason']), /すべての承認/);
  assert.equal(repo.knowledge.length, 0, '承認②を却下したら知識に入らない');
});

test('承認のあとに作り直した成果物は、知識に登録しない', async () => {
  // 承認の直後の段は承認の前に組み立てられ、そこで作った下書きは承認の画面に出る（第9.3.3節）。
  // そこで、承認の直後の段の**さらに次**（組み立ての対象でない段）で別の議事録を作り、登録させようとする
  const SWAP_DEF: AgentDefinition = {
    schemaVersion: 1, id: 'swap-test', version: 1, name: 'テスト', category: 'test', description: 'テスト',
    locale: 'ja-JP', compartment: null, inputs: {},
    tools: ['document.create', 'knowledge.register', 'chat.post'],
    steps: [
      { id: 'draft', type: 'agent', instruction: '作る' },
      { id: 'gate', type: 'approval', approverRole: ['approver'], present: '議事録の内容' },
      { id: 'share', type: 'agent', instruction: '共有する' },
      { id: 'late', type: 'agent', instruction: '登録する' },
    ],
    constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
  };
  const ctx = setup(SWAP_DEF, { name: 'noop', args: {} });
  ctx.repo.settings.automation.writeInternal = 'allow';
  const rounds: Record<string, number> = {};
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'swap',
    async complete(req: LlmRequest) {
      const id = req.context?.stepId ?? '';
      const n = (rounds[id] = (rounds[id] ?? 0) + 1);
      const call = (c: unknown) => ({ text: '```tool\n' + JSON.stringify(c) + '\n```', tokensUsed: 1 });
      if (id === 'draft' && n === 1) return call({ name: 'document.create', args: { kind: 'minutes', title: '承認する議事録', body: '決定事項' } });
      if (id === 'share' && n === 1) return call({ name: 'chat.post', args: { space: 'general', text: '共有します' } });
      if (id === 'late' && n === 1) return call({ name: 'document.create', args: { kind: 'minutes', title: '差し替え', body: '承認していない内容' } });
      if (id === 'late' && n === 2) {
        const swapped = ctx.repo.artifacts.find((a) => a.title === '差し替え')!.id;
        return call({ name: 'knowledge.register', args: { artifactId: swapped } });
      }
      return { text: '終わりました。', tokensUsed: 1 };
    },
  };
  const r = await ctx.engine.advance(ctx.run);
  if (r.outcome !== 'awaiting_approval') assert.fail(r.outcome);
  await ctx.engine.decideApproval('t', r.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
  assert.equal((await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' })).outcome, 'completed');
  const res = resultsOf(ctx.repo, 'late', 'knowledge.register')[0];
  assert.equal(ctx.repo.knowledge.length, 0, '承認で見ていない成果物は登録しない');
  assert.match(String(res?.['reason']), /承認で確かめた成果物ではありません/);
});

test('承認の画面に、確認すること・判断するもの・承認すると行うことを出す（第9.3.3節）', async () => {
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = minutesLlm(ctx.repo, {
    tasks: [{ name: 'tasks.create', args: { title: '資料を作る（担当: 山田）', due: '2026-09-29' } }],
  });
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  const a1 = ctx.repo.approvals.find((a) => a.id === first.approvalId)!;
  const lines = a1.present.split('\n');
  assert.equal(lines[0], '議事録の内容と、抽出した決定事項', '1 行目は定義の present（一覧・通知は 1 行目だけを出す）');
  assert.match(a1.present, /## 判断するもの[\s\S]*成果物「営業定例の議事録」[\s\S]*販促は A 案で進める/, '議事録の本文が出る');
  assert.match(a1.present, /## 承認すると[\s\S]*「起票」に進み/);
  assert.match(a1.present, /\*\*ToDo を登録します\*\*: A 案の準備（期限なし）/);
  assert.match(a1.present, /\*\*ToDo を登録します\*\*: 資料を作る（担当: 山田）（期限 2026年9月29日）/);
  assert.doesNotMatch(a1.present, /tasks\.create|\{"/, 'ツール名や JSON を出さない');
  assert.equal(ctx.repo.notifications.find((n) => n.kind === 'approval')?.body, '議事録の内容と、抽出した決定事項', '通知には中身を載せない');

  await ctx.engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
  const second = await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' });
  if (second.outcome !== 'awaiting_approval') assert.fail(second.outcome);
  const a2 = ctx.repo.approvals.find((a) => a.id === second.approvalId)!;
  assert.match(a2.present, /チャットのスペース「general」に投稿します\*\*:\n\s*> 議事録を共有します/, '投稿する本文そのものが出る');
  assert.match(a2.present, /社内の知識に登録します\*\*: 「営業定例の議事録」/, 'ID ではなく題名で出す');
  assert.doesNotMatch(a2.present, /成果物「営業定例の議事録」/, '前の承認で見せた成果物は繰り返さない');
  assert.match(a2.present, /### 起票（前の承認のあとに行ったこと）\n\n- \*\*ToDo を登録しました\*\*: A 案の準備/, '承認のあとに実行した段は、行ったことを出す');
  assert.doesNotMatch(a2.present, /### 起票\n/, '承認の前に書いた古い文は出さない');
});

test('承認の画面に出す推論の文から、内部の ID を取り除く。リンクは残す（2026-09-25 の表示の問題）', async () => {
  const text = [
    '作成された文書の成果物IDは以下の通りです。',
    '- `ce89528a-39bb-43ed-9016-5477965234ba`（営業定例の議事録）',
    '保存しました（ファイルID: `1fj5sWy8MjTdmlfBlz4F3ZFB50Wr7md_3Z7ReppMYPbY`）。',
    'リンク: https://docs.google.com/document/d/1fj5sWy8MjTdmlfBlz4F3ZFB50Wr7md_3Z7ReppMYPbY/edit',
    '実行 3c982953-a432-4011-bc8b-469c0f991e15 は終わりました。extraordinarily_long_identifier_name は語なので残す。',
  ].join('\n');
  assert.equal(hideInternalIds(text), [
    '- 営業定例の議事録',
    '保存しました。',
    'リンク: https://docs.google.com/document/d/1fj5sWy8MjTdmlfBlz4F3ZFB50Wr7md_3Z7ReppMYPbY/edit',
    '実行 は終わりました。extraordinarily_long_identifier_name は語なので残す。',
  ].join('\n'));

  // 推論が ID を書いても、承認の画面には出ない。推論への指示にも「ID を書かない」を入れる
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  const base = minutesLlm(ctx.repo);
  let system = '';
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'id-writer',
    async complete(req: LlmRequest) {
      system = String(req.messages[0]?.content ?? '');
      if (req.context?.stepId === 'draft' && ctx.repo.artifacts.length > 0) {
        return { text: `作りました。成果物 ID: \`${ctx.repo.artifacts[0]!.id}\``, tokensUsed: 1 };
      }
      return base.complete(req);
    },
  };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  const present = ctx.repo.approvals.find((a) => a.id === first.approvalId)!.present;
  assert.ok(!present.includes(ctx.repo.artifacts[0]!.id), '成果物の ID を出さない');
  assert.match(present, /### 作成\n\n作りました。/);
  assert.match(system, /利用者に見せる文には、成果物・ファイル・文書・実行などの ID を書かない/);
});

const REAL_MINUTES = `#### 議事録: M2Office 接続確認の打ち合わせ（テスト）

#### 会議情報
- 開催日: 2026年9月25日（金）
- 会議名: M2Office 接続確認の打ち合わせ（テスト）
- スペース: M2Office

#### 議事内容
- 三浦より、Google ドキュメントにも保存する機能の動作確認を行うことが述べられた。

#### 決定事項
- 確認終了後、結果を仕様書に記録する。
  - 期限: 2026-09-30
  - 担当: 三浦

#### 保留事項
- スプレッドシートの対応時期については、次回決定する。`;

test('段の文が成果物を繰り返すだけなら、承認の画面では省く（同じ議事録が 2 回並ばない。2026-09-25）', async () => {
  // 本物の推論が「取得」の段に書いた文（成果物と見出しの深さが違うだけ）
  const fetchText = `提供された入力に transcript が含まれているため、その内容を使用します。\n\n以下に議事録を作成いたします。\n\n---\n\n${REAL_MINUTES.replace(/^#### /gm, '### ')}\n\n---\n\n※タスクの起票は承認後に実施いたします。`;
  assert.equal(repeatsArtifact(fetchText, REAL_MINUTES), true);
  assert.equal(repeatsArtifact('記録は貼り付けられた文字起こしから取得しました（約 300 字）。', REAL_MINUTES), false, '短い報告は繰り返しではない');
  assert.equal(repeatsArtifact('決定事項\n確認終了後、結果を仕様書に記録する。', REAL_MINUTES), false, '一部を引いただけなら繰り返しではない');

  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  const base = minutesLlm(ctx.repo);
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'repeat',
    async complete(req: LlmRequest) {
      const id = String(req.context?.stepId ?? '');
      if (id === 'fetch') return { text: fetchText, tokensUsed: 1 };
      if (id === 'draft' && ctx.repo.artifacts.length === 0) {
        return { text: '```tool\n' + JSON.stringify({ name: 'document.create', args: { kind: 'minutes', title: '接続確認の議事録', body: REAL_MINUTES } }) + '\n```', tokensUsed: 1 };
      }
      if (id === 'draft') return { text: '作りました。', tokensUsed: 1 };
      return base.complete(req);
    },
  };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  const present = ctx.repo.approvals.find((a) => a.id === first.approvalId)!.present;
  assert.match(present, /### 取得\n\n（下の成果物「接続確認の議事録」と同じ内容のため、省きました）/);
  assert.equal(present.split('スプレッドシートの対応時期については').length - 1, 1, '議事録の本文は成果物として 1 回だけ出る');
  assert.match(present, /### 作成\n\n作りました。/, '繰り返しでない段の文は出す');
});

test('承認の前に組み立てた操作を、承認のあとそのまま実行する。推論をやり直さない（ADR-0023）', async () => {
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  const base = minutesLlm(ctx.repo);
  const calls: string[] = [];
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'count', async complete(req: LlmRequest) { calls.push(String(req.context?.stepId)); return base.complete(req); },
  };
  const admin = { id: 'u-admin', roles: ['admin', 'approver'] };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  assert.ok(calls.includes('tasks'), '承認①の前に「起票」を組み立てる');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'chat').length, 0);
  assert.equal(ctx.repo.steps.find((s) => s.stepId === 'tasks')?.output && (ctx.repo.steps.find((s) => s.stepId === 'tasks')!.output as { planned?: boolean }).planned, true);
  const before = calls.length;
  await ctx.engine.decideApproval('t', first.approvalId, 'approved', admin, null);
  const second = await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' });
  if (second.outcome !== 'awaiting_approval') assert.fail(second.outcome);
  assert.equal(calls.slice(before).filter((x) => x === 'tasks').length, 0, '承認のあとに「起票」を推論し直さない');
  assert.ok(resultsOf(ctx.repo, 'tasks', 'tasks.create').every((r) => r['created'] === true), '組み立てた ToDo を実行した（記録の印は結果に置き換わる）');
  const made = (await ctx.connector.tasks.list({ tenantId: 't', userId: 'u-member' }, {})).filter((t) => t.title === 'A 案の準備');
  assert.equal(made.length, 1, '推論が同じ ToDo を 2 度出しても、1 度だけ作る');
  await ctx.engine.decideApproval('t', second.approvalId, 'approved', admin, null);
  const n = calls.length;
  assert.equal((await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' })).outcome, 'completed');
  assert.equal(calls.length, n, '承認②のあとも推論し直さない');
  const posted = ctx.connector.outbox.filter((o) => o.kind === 'chat');
  assert.deepEqual(posted.map((o) => (o.body as { text: string }).text), ['議事録を共有します'], '承認の画面に出した本文をそのまま投稿した');
  assert.equal(ctx.repo.knowledge.length, 1);
});

test('組み立てた操作は、保存でキーの並びが変わっても結果と突き合わせられる', async () => {
  // PostgreSQL の jsonb はキーを「短い順、同じ長さなら文字の順」に並べ直す。記憶上の保存では起きないため、同じ並べ方をまねる。
  // 引数は space, text の順で渡す。jsonb は text（4 文字）を先にするので、保存の前後で並びが変わる
  const ctx = setup(SHARE_DEF, { name: 'chat.post', args: { space: 'general', text: '共有' } });
  const jsonbOrder = (v: unknown): unknown => (Array.isArray(v) ? v.map(jsonbOrder)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v)
      .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, jsonbOrder(x)])) : v);
  const repo = ctx.repo as unknown as { appendRunStep: (t: string, st: RunStepLike) => Promise<void>; updateRunStep: (t: string, st: RunStepLike) => Promise<void> };
  type RunStepLike = { input: unknown; output: unknown };
  const append = repo.appendRunStep.bind(ctx.repo);
  const update = repo.updateRunStep.bind(ctx.repo);
  repo.appendRunStep = (t, st) => append(t, { ...st, input: jsonbOrder(st.input), output: jsonbOrder(st.output) });
  repo.updateRunStep = (t, st) => update(t, { ...st, input: jsonbOrder(st.input), output: jsonbOrder(st.output) });
  const r = await ctx.engine.advance(ctx.run);
  if (r.outcome !== 'awaiting_approval') assert.fail(r.outcome);
  await ctx.engine.decideApproval('t', r.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
  assert.equal((await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' })).outcome, 'completed');
  const tools = (ctx.repo.steps.find((st) => st.stepId === 'share')!.output as { tools: { pending?: string; result?: { posted?: boolean } }[] }).tools;
  assert.ok(tools.length > 0 && tools.every((t) => !t.pending && t.result?.posted === true), '印がすべて実行の結果に置き換わる');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'chat').length, 1, '投稿は 1 回');
});

/** 投稿先の確かめを差し替えて、共有の業務を承認の段まで進める（ADR-0024）。 */
async function shareUntilGate(space: string, findSpace: (input: string) => Promise<{ space: string; displayName: string | null } | { reason: string }>) {
  const ctx = setup(SHARE_DEF, { name: 'chat.post', args: { space, text: '議事録を共有します' } });
  ctx.connector.chat.findSpace = async (_p, input) => findSpace(input);
  const r = await ctx.engine.advance(ctx.run);
  if (r.outcome !== 'awaiting_approval') assert.fail(r.outcome);
  const present = ctx.repo.approvals.find((a) => a.id === r.approvalId)!.present;
  const approveAndFinish = async () => {
    await ctx.engine.decideApproval('t', r.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
    return (await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' })).outcome;
  };
  return { ctx, present, approveAndFinish };
}

test('承認の前に投稿先を探し、見つかったスペースへ承認のあとで投稿する（探し直さない。ADR-0024）', async () => {
  let lookups = 0;
  const { ctx, present, approveAndFinish } = await shareUntilGate('技術部', async (input) => {
    lookups += 1;
    return input === '技術部' ? { space: 'spaces/TECH', displayName: '技術部' } : { reason: '見つかりません' };
  });
  assert.match(present, /チャットのスペース「技術部」に投稿します\*\*:\n\s*> 議事録を共有します/, '確かめた名前で出す');
  assert.doesNotMatch(present, /spaces\/TECH/, '内部の ID は出さない');
  assert.doesNotMatch(present, /行えません/);
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'chat').length, 0, '確かめるだけで投稿しない');
  const before = lookups;
  assert.equal(await approveAndFinish(), 'completed');
  const posted = ctx.connector.outbox.filter((o) => o.kind === 'chat').map((o) => (o.body as { space: string }).space);
  assert.deepEqual(posted, ['spaces/TECH'], '確かめたスペースの ID へ投稿した');
  assert.equal(lookups, before, '承認のあとに探し直さない');
  const tools = (ctx.repo.steps.find((st) => st.stepId === 'share')!.output as { tools: { pending?: string; result?: { posted?: boolean } }[] }).tools;
  assert.ok(tools.length > 0 && tools.every((t) => !t.pending && t.result?.posted === true), '引数を確かめた値に替えても、印は実行の結果に置き換わる');
});

test('投稿先が見つからなければ記録せず、承認の画面に「行えません」と理由を出す（ADR-0024）', async () => {
  const { ctx, present, approveAndFinish } = await shareUntilGate('技術部', async () => ({ reason: '「技術部」という名前のチャットのスペースが見つかりません' }));
  assert.match(present, /\*\*次のことは行えません（承認しても行いません）\*\*/);
  assert.match(present, /- \*\*チャットのスペース「技術部」に投稿します\*\*\n {2}- 理由: 「技術部」という名前のチャットのスペースが見つかりません/);
  assert.match(present, /却下して、依頼し直してください/);
  assert.doesNotMatch(present, /このとおりに行います/, '行えない投稿を「行うこと」に並べない');
  const share = ctx.repo.steps.find((st) => st.stepId === 'share')!.output as { tools: { error?: string }[] };
  assert.match(String(share.tools[0]?.error), /この操作は行えません/, '推論にも行えないと返す');
  assert.equal(await approveAndFinish(), 'completed', '承認すれば、行える分だけで進む');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'chat').length, 0, '投稿しない');
});

test('許可が足りないときは行えないと出し、Google に届かないときは記録して承認のあとで試す（ADR-0024）', async () => {
  const scope = await shareUntilGate('技術部', async () => {
    throw new ConnectorUnavailableError('insufficient-scope', 'この操作に要る Google の許可（Chat）がありません');
  });
  assert.match(scope.present, /行えません[\s\S]*理由: この操作に要る Google の許可（Chat）がありません/);

  const busy = await shareUntilGate('技術部', async () => {
    throw new ConnectorUnavailableError('unreachable', 'Chat（Google）が混み合っています');
  });
  assert.match(busy.present, /このとおりに行います[\s\S]*チャットのスペース「技術部」に投稿します/, '投稿は記録する');
  assert.match(busy.present, /承認の前に確かめられませんでした（Chat（Google）が混み合っています）。承認のあとで改めて試します/);
  assert.equal(await busy.approveAndFinish(), 'completed');
  assert.deepEqual(busy.ctx.connector.outbox.filter((o) => o.kind === 'chat').map((o) => (o.body as { space: string }).space), ['技術部'], '元の指定のまま投稿を試した');
});

/**
 * 議事録を Google ドキュメントにも保存する LLM（ADR-0025）。共有の段は、保存 → 結果の ID で社内に共有 → リンクを添えて投稿 → 知識に登録。
 *
 * @param connector 保存した文書の ID とリンクを引く（推論が結果を読んだものとして使う）
 */
function minutesDocsLlm(repo: MemoryRepo, connector: MockWorkspaceConnector): LlmProvider {
  const rounds: Record<string, number> = {};
  const base = minutesLlm(repo);
  return {
    name: 'minutes-docs',
    async complete(req: LlmRequest) {
      const id = String(req.context?.stepId ?? '');
      if (id !== 'share') return base.complete(req);
      const n = (rounds[id] = (rounds[id] ?? 0) + 1);
      const tool = (c: unknown[]) => ({ text: c.map((x) => '```tool\n' + JSON.stringify(x) + '\n```').join('\n'), tokensUsed: 1 });
      const artifactId = repo.artifacts[0]!.id;
      if (n === 1) return tool([{ name: 'docs.create', args: { artifactId, folderName: 'M2Office 議事録' } }]);
      if (n === 2) {
        const doc = (await connector.drive.search({ tenantId: 't', userId: 'u-member' }, { query: '営業定例の議事録' })).find((f) => f.kind === 'document');
        return tool([
          ...(doc ? [{ name: 'drive.share_company', args: { fileId: doc.id } }] : []),
          { name: 'chat.post', args: { space: 'general', text: `議事録を共有します${doc ? `\n議事録（Google ドキュメント）: ${doc.url ?? '（見本のためリンクなし）'}` : ''}` } },
          { name: 'knowledge.register', args: { artifactId } },
        ]);
      }
      return { text: '共有の準備ができました。', tokensUsed: 1 };
    },
  };
}

/** 議事録の作成を、Google ドキュメントに保存する形で承認②まで進める。 */
async function minutesWithDocs(user: { email?: string } = {}) {
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  if (user.email) ctx.repo.users = ctx.repo.users.map((u) => (u.id === 'u-member' ? { ...u, email: user.email! } : u));
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = minutesDocsLlm(ctx.repo, ctx.connector);
  const admin = { id: 'u-admin', roles: ['admin', 'approver'] };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  const docsBeforeFirst = (await ctx.connector.drive.search({ tenantId: 't', userId: 'u-member' }, { query: '議事録' })).length;
  await ctx.engine.decideApproval('t', first.approvalId, 'approved', admin, null);
  const second = await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' });
  if (second.outcome !== 'awaiting_approval') assert.fail(second.outcome);
  const present = ctx.repo.approvals.find((a) => a.id === second.approvalId)!.present;
  const decide = async (d: 'approved' | 'rejected') => {
    await ctx.engine.decideApproval('t', second.approvalId, d, admin, null);
    if (d === 'approved') assert.equal((await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' })).outcome, 'completed');
  };
  return { ctx, present, decide, docsBeforeFirst };
}

test('AG-02 は承認①で確かめた議事録を Google ドキュメントに保存し、承認②のあとに社内に共有する（ADR-0025）', async () => {
  const { ctx, present, decide, docsBeforeFirst } = await minutesWithDocs();
  const P = { tenantId: 't', userId: 'u-member' };
  assert.equal(docsBeforeFirst, 0, '承認①の前には保存しない');
  const files = await ctx.connector.drive.search(P, { query: '' });
  const folder = files.find((f) => f.kind === 'folder' && f.name === 'M2Office 議事録');
  const doc = files.find((f) => f.kind === 'document' && /^営業定例の議事録（\d{4}-\d{2}-\d{2}）$/.test(f.name));
  assert.ok(folder, '「M2Office 議事録」フォルダを作る');
  assert.ok(doc, '題名は成果物の題名に日付を添える');
  assert.equal((await ctx.connector.drive.read(P, doc.id))!.text, ctx.repo.artifacts[0]!.body, '成果物の本文をそのまま保存する');

  assert.match(present, /## 承認の前に済ませたこと\n\n- \*\*Google ドキュメントに保存しました\*\*: 「営業定例の議事録（\d{4}-\d{2}-\d{2}）」（あなたのドライブ。まだ誰にも共有していません）/);
  assert.match(present, /\*\*会社の全員が閲覧できるようにします\*\*: 「営業定例の議事録（\d{4}-\d{2}-\d{2}）」（社外の人は見られません/, '共有するファイルの名前を出す');
  assert.match(present, /議事録（Google ドキュメント）:/, '投稿の本文にリンクの行が入る');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'drive.share_company').length, 0, '承認②の前には共有しない');

  await decide('approved');
  const shared = ctx.connector.outbox.filter((o) => o.kind === 'drive.share_company');
  assert.deepEqual(shared.map((o) => o.body), [{ fileId: doc.id, domain: 'x' }], '承認②のあとに、会社のドメインへ閲覧で共有する');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'chat').length, 1);
  assert.equal(ctx.repo.knowledge.length, 1);
});

test('承認の前の組み立てでは、記録された操作のあとも、段の残りの操作をすべて出させる（2026-09-25 の不具合）', async () => {
  // 本物の推論は、社内への共有が「記録された」と見ると、承認待ちとして投稿と登録を出さずに終えた。
  // それをまねる推論: 段の指示に組み立ての説明が無ければ、記録を見た時点で止まる
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  const base = minutesLlm(ctx.repo);
  const rounds: Record<string, number> = {};
  const P = { tenantId: 't', userId: 'u-member' };
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'cautious',
    async complete(req: LlmRequest) {
      const id = String(req.context?.stepId ?? '');
      if (id !== 'share') return base.complete(req);
      const n = (rounds[id] = (rounds[id] ?? 0) + 1);
      const tool = (c: unknown[]) => ({ text: c.map((x) => '```tool\n' + JSON.stringify(x) + '\n```').join('\n'), tokensUsed: 1 });
      const artifactId = ctx.repo.artifacts[0]!.id;
      if (n === 1) return tool([{ name: 'docs.create', args: { artifactId, folderName: 'M2Office 議事録' } }]);
      const doc = (await ctx.connector.drive.search(P, { query: '営業定例の議事録' })).find((f) => f.kind === 'document')!;
      if (n === 2) return tool([{ name: 'drive.share_company', args: { fileId: doc.id } }]);
      const told = String(req.messages[1]?.content ?? '').includes('最後まですべて呼ぶこと');
      if (n === 3 && told) {
        return tool([{ name: 'chat.post', args: { space: 'general', text: '議事録を共有します' } }, { name: 'knowledge.register', args: { artifactId } }]);
      }
      return { text: '社内共有は承認待ちのため、投稿と登録はまだ行いません。', tokensUsed: 1 };
    },
  };
  const admin = { id: 'u-admin', roles: ['admin', 'approver'] };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  await ctx.engine.decideApproval('t', first.approvalId, 'approved', admin, null);
  const second = await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' });
  if (second.outcome !== 'awaiting_approval') assert.fail(second.outcome);
  const present = ctx.repo.approvals.find((a) => a.id === second.approvalId)!.present;
  assert.match(present, /会社の全員が閲覧できるようにします/);
  assert.match(present, /チャットのスペース「general」に投稿します/, '記録のあとも、投稿を出させる');
  assert.match(present, /社内の知識に登録します/, '記録のあとも、知識への登録を出させる');
});

test('承認②を却下したら、保存した文書は本人のドライブに残り、共有も投稿もしない', async () => {
  const { ctx, decide } = await minutesWithDocs();
  await decide('rejected');
  assert.equal((await ctx.connector.drive.search({ tenantId: 't', userId: 'u-member' }, { query: '営業定例の議事録' })).length, 1, '文書は残る');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'drive.share_company' || o.kind === 'chat').length, 0);
});

test('個人向けの Google アカウントでは、会社の全員への共有を行えないと出す', async () => {
  const { ctx, present, decide } = await minutesWithDocs({ email: 'someone@gmail.com' });
  assert.match(present, /次のことは行えません[\s\S]*会社の全員が閲覧できるようにします[\s\S]*理由: 個人向けの Google アカウントでは、会社の全員への共有はできません/);
  await decide('approved');
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'drive.share_company').length, 0);
  assert.equal(ctx.connector.outbox.filter((o) => o.kind === 'chat').length, 1, '行える分（投稿）は進める');
});

test('Google ドキュメントに保存できなくても業務は止めず、承認の画面に理由を出す', async () => {
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  ctx.connector.docs.create = async () => { throw new ConnectorUnavailableError('insufficient-scope', 'この操作に要る Google の許可（ドキュメント）がありません'); };
  (ctx.engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = minutesDocsLlm(ctx.repo, ctx.connector);
  const admin = { id: 'u-admin', roles: ['admin', 'approver'] };
  const first = await ctx.engine.advance(ctx.run);
  if (first.outcome !== 'awaiting_approval') assert.fail(first.outcome);
  await ctx.engine.decideApproval('t', first.approvalId, 'approved', admin, null);
  const second = await ctx.engine.advance({ ...(await ctx.repo.getRun('t', 'r1'))!, status: 'running' });
  if (second.outcome !== 'awaiting_approval') assert.fail(`保存に失敗しても承認②で止まる: ${second.outcome}`);
  const present = ctx.repo.approvals.find((a) => a.id === second.approvalId)!.present;
  assert.match(present, /\*\*Google ドキュメントに保存できませんでした\*\*: この操作に要る Google の許可（ドキュメント）がありません/);
  assert.doesNotMatch(present, /議事録（Google ドキュメント）:/, 'リンクを添えない');
});

test('docs.create の artifactId は、承認で確かめた成果物だけを保存する', async () => {
  const ctx = setup(AG02_MINUTES, { name: 'noop', args: {} });
  const res = await docsCreateTool().invoke({ artifactId: 'none' }, {
    tenantId: 't', userId: 'u-member', runId: 'r1', compartment: null,
    repo: ctx.repo as unknown as Repository, connector: ctx.connector, files: new MemoryFileStore(),
  }) as { created: boolean; reason: string };
  assert.equal(res.created, false);
  assert.match(res.reason, /この実行で作った成果物が見つかりません。Google ドキュメントに保存しませんでした/);
});

test('承認を却下したら、組み立てた送信は実行しない', async () => {
  const { connector, repo } = await runMinutes({ rejectShare: true });
  assert.equal(connector.outbox.filter((o) => o.kind === 'chat').length, 0);
  assert.equal(repo.knowledge.length, 0);
});

test('段がツールを宣言していれば、その段ではそれ以外を呼ばせない（第9.2.7節）', async () => {
  const DEF: AgentDefinition = {
    schemaVersion: 1, id: 'scoped', version: 1, name: 'テスト', category: 'test', description: 'テスト',
    locale: 'ja-JP', compartment: null, inputs: {}, tools: ['tasks.create', 'knowledge.search'],
    steps: [{ id: 'read', type: 'agent', instruction: '調べる', tools: ['knowledge.search'] }],
    constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
  };
  const { repo, engine, run } = setup(DEF, { name: 'tasks.create', args: { title: '先走り' } });
  repo.settings.automation.writeInternal = 'allow';
  await engine.advance(run);
  const r = (repo.steps[0]!.output as { tools: { error?: string }[] }).tools[0]!;
  assert.match(String(r.error), /この段（read）では使えないツールです/);
  assert.equal(repo.audits.filter((a) => a.action === 'tool.invoke' && a.targetId === 'tasks.create').length, 0, '実行していない');
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  assert.throws(() => validateDefinition({ ...DEF, steps: [{ id: 'x', type: 'agent', instruction: 'x', tools: ['chat.post'] }] }, registry),
    /定義のツールに無いもの/);
});

test('推論に今日の日付（日本時間）を渡す（第9.3.2節）', async () => {
  const seen: string[] = [];
  const { engine, run } = setup(SHARE_DEF, { name: 'noop', args: {} });
  (engine as unknown as { deps: { llm: LlmProvider } }).deps.llm = {
    name: 'see', async complete(req: LlmRequest) { seen.push(req.messages.map((m) => m.content).join('\n')); return { text: 'ok', tokensUsed: 1 }; },
  };
  await engine.advance(run);
  assert.ok(seen[0]!.includes(`今日は ${todayJst()}`));
  assert.match(todayJst(new Date('2026-09-25T20:00:00Z')), /^2026年9月26日（土）$/, '日本時間の日付と曜日');
});

test('操作の確認を、業務の言葉で出す（ツール名・JSON・ID を出さない）', async () => {
  const DEF: AgentDefinition = {
    schemaVersion: 1, id: 'confirm', version: 1, name: 'テスト', category: 'test', description: 'テスト',
    locale: 'ja-JP', compartment: null, inputs: {}, tools: ['tasks.create'],
    steps: [{ id: 'do', type: 'agent', instruction: '登録する' }],
    constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
  };
  const { repo, engine, run } = setup(DEF, { name: 'tasks.create', args: { title: '見積書を送る', due: '2026-09-29' } });
  const r = await engine.advance(run);
  if (r.outcome !== 'awaiting_approval') assert.fail(r.outcome);
  const present = repo.approvals.find((a) => a.id === r.approvalId)!.present;
  assert.match(present, /\*\*ToDo を登録します\*\*: 見積書を送る（期限 2026年9月29日）/);
  assert.doesNotMatch(present, /tasks\.create|\{"/);
});

test('ツールの呼び出しを業務の言葉にする（知らないツールは ID を出さない）', () => {
  assert.equal(jpDate('2026-09-29'), '2026年9月29日');
  assert.equal(jpDate('2026-09-30T10:00:00+09:00'), '2026年9月30日 10:00');
  assert.equal(describeCall({ name: 'tasks.complete', args: { taskId: 'abc' } }), '**ToDo を完了にします**');
  assert.equal(describeCall({ name: 'gmail.send', args: { to: ['a@x.example'], cc: [], subject: '件', body: '本文' } }),
    '**メールを送ります**: 宛先 a@x.example／件名「件」\n> 本文');
  const unknown = describeCall({ name: 'x.do', args: { fileId: 'secret-id', title: '報告' } }, { helpText: () => '報告を作ります。社外へは出しません' });
  assert.equal(unknown, '**報告を作ります**: 報告');
});

test('ほかの実行の成果物と、Google から読んだ記録で作った議事録の扱い', async () => {
  const { repo } = await runMinutes();
  // 同じ実行で呼び直しても増えない（ワーカーが落ちて手順をやり直した場合）
  const tool = BUILTIN_TOOLS.find((t) => t.name === 'knowledge.register')!;
  const base = {
    tenantId: 't', userId: 'u-member', runId: 'r1', compartment: null,
    repo: repo as unknown as Repository, connector: new MockWorkspaceConnector(), files: new MemoryFileStore(),
    approvalsAhead: 0,
  };
  await tool.invoke({ artifactId: repo.artifacts[0]!.id }, base);
  assert.equal(repo.knowledge.length, 1, '1 回の実行で 1 件');

  const other = await tool.invoke({ artifactId: repo.artifacts[0]!.id }, { ...base, runId: 'r2' }) as { registered: boolean; reason: string };
  assert.equal(other.registered, false, 'ほかの実行の成果物は登録しない');

  const noCtx = await tool.invoke({ artifactId: repo.artifacts[0]!.id }, { ...base, approvalsAhead: undefined }) as { registered: boolean };
  assert.equal(noCtx.registered, false, '実行エンジンの外からは登録しない');

  // Google の権限を持つ読み取りのツールを呼んでいれば、Google 由来として記録する
  repo.knowledge = [];
  repo.steps.push({ id: 'g', runId: 'r1', seq: 0, stepId: 'fetch', kind: 'agent', status: 'succeeded', input: null,
    output: { tools: [{ name: 'meet.transcript', risk: 'read', result: {} }] }, startedAt: '2026-01-01T00:00:00Z', endedAt: null });
  await tool.invoke({ artifactId: repo.artifacts[0]!.id }, { ...base, isGoogleTool: (n) => n === 'meet.transcript' });
  assert.equal(repo.knowledge[0]?.googleDerived, true);
});

test('承認待ちになったら、判断できる人に知らせる（仕様書 第6.5.5.1節）', async () => {
  const { repo, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有します' } });
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'awaiting_approval');
  const notes = repo.notifications.filter((n) => n.kind === 'approval');
  assert.deepEqual(notes.map((n) => n.userId), ['u-admin'], '承認のロールを持つ人だけに知らせる');
  assert.equal(notes[0]!.title, '承認をお願いします: テスト');
  assert.equal(notes[0]!.runId, 'r1');
});

test('実行が終わったら依頼した本人に知らせ、失敗も知らせる', async () => {
  const done = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有' } });
  const first = await done.engine.advance(done.run);
  if (first.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  await done.engine.decideApproval('t', first.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
  await done.engine.advance({ ...(await done.repo.getRun('t', 'r1'))!, status: 'running' });
  const finished = done.repo.notifications.filter((n) => n.userId === 'u-member');
  assert.deepEqual(finished.map((n) => n.kind), ['run']);
  assert.equal(finished[0]!.title, '業務が終わりました: テスト');

  // 失敗したときは種類 failure で知らせる
  const failed = setup({ ...SHARE_DEF, id: 'fail-test' }, { name: 'chat.post', args: { text: '共有します' } });
  failed.repo.settings.agents = { disabled: ['fail-test'] };
  assert.equal((await failed.engine.advance(failed.run)).outcome, 'failed');
  assert.deepEqual(failed.repo.notifications.map((n) => n.kind), ['failure']);
});

test('本人が受け取らない種類は作らず、業務自身が知らせた実行には完了を重ねない', async () => {
  const off = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有します' } });
  off.repo.userSettings.notifications.kinds.approval = false;
  await off.engine.advance(off.run);
  assert.equal(off.repo.notifications.length, 0, '切った種類は画面内にも作らない');

  const brief = setup(SHARE_DEF, { name: 'chat.post', args: { text: '共有します' } });
  brief.repo.notifications.push({
    id: 'n-brief', tenantId: 't', userId: 'u-member', kind: 'brief', title: '今週のブリーフ',
    body: '', runId: 'r1', readAt: null, createdAt: new Date().toISOString(),
  });
  const gate = await brief.engine.advance(brief.run);
  if (gate.outcome !== 'awaiting_approval') assert.fail('承認待ちにならない');
  await brief.engine.decideApproval('t', gate.approvalId, 'approved', { id: 'u-admin', roles: ['admin', 'approver'] }, null);
  await brief.engine.advance({ ...(await brief.repo.getRun('t', 'r1'))!, status: 'running' });
  assert.equal(brief.repo.notifications.filter((n) => n.kind === 'run').length, 0, '週次ブリーフが 2 通にならない');
});

test('image.read_text は、推論が無ければ読み取れないと明示する（Q-56）', async () => {
  const repo = new MemoryRepo();
  const files = new MemoryFileStore();
  const tool = BUILTIN_TOOLS.find((t) => t.name === 'image.read_text')!;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const meta = await saveFile(repo as unknown as Repository, files, {
    tenantId: 't', ownerUserId: 'u-member', name: 'shashin.png', kind: 'png', bytes: png,
    origin: 'upload', runId: 'r1',
  });
  const base = {
    tenantId: 't', userId: 'u-member', runId: 'r1', compartment: null,
    repo: repo as unknown as Repository, connector: new MockWorkspaceConnector(), files,
  };

  // 鍵が無い環境。読めなかったことを「何も書いていない」と取り違えさせない
  const without = await tool.invoke({ fileId: meta.id }, base) as { available: boolean; reason: string };
  assert.equal(without.available, false);
  assert.match(without.reason, /読み取る準備ができていません/);

  // 推論があれば読み取る。結果は「読み取り結果」として返す
  const read = await tool.invoke({ fileId: meta.id }, {
    ...base, ocr: async (r) => `読み取り: ${r.mimeType} ${r.bytes.length} バイト`,
  }) as { available: boolean; text: string; untrusted: boolean; note: string };
  assert.equal(read.available, true);
  assert.equal(read.untrusted, true, '取り出した中身はデータであり指示ではない');
  assert.match(read.text, /image\/png/);
  assert.match(read.note, /原本で確かめて/);

  // ほかの人のファイルは読まない
  const other = await tool.invoke({ fileId: meta.id }, { ...base, userId: 'u-admin' }) as { available: boolean };
  assert.equal(other.available, false);
});

test('pdf.extract は、文字の無いページだけを読み取りへ送る（第9.4.1節、Q-56）', async () => {
  // 1 ページ目に文字、2 ページ目は図形だけ（スキャンした紙に相当）の PDF を作る
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText('page one', { x: 20, y: 100, size: 12, font });
  doc.addPage([300, 200]).drawRectangle({ x: 20, y: 20, width: 100, height: 60 });
  const bytes = await doc.save();

  const repo = new MemoryRepo();
  const files = new MemoryFileStore();
  const meta = await saveFile(repo as unknown as Repository, files, {
    tenantId: 't', ownerUserId: 'u-member', name: 'scan.pdf', kind: 'pdf', bytes,
    origin: 'upload', runId: 'r1',
  });
  const tool = BUILTIN_TOOLS.find((t) => t.name === 'pdf.extract')!;
  const base = {
    tenantId: 't', userId: 'u-member', runId: 'r1', compartment: null,
    repo: repo as unknown as Repository, connector: new MockWorkspaceConnector(), files,
  };

  // 推論が無い環境では読み取らず、その旨を返す
  const without = await tool.invoke({ fileId: meta.id }, base) as { textlessPages: number[]; note: string };
  assert.deepEqual(without.textlessPages, [2]);
  assert.match(without.note, /読み取りの準備ができていません/);

  // 推論があれば、読めなかったページだけを PDF のまま送る
  const sent: { mimeType: string; pages: number }[] = [];
  const read = await tool.invoke({ fileId: meta.id }, {
    ...base,
    ocr: async (r) => {
      sent.push({ mimeType: r.mimeType, pages: (await extractPdfText(r.bytes)).pageCount });
      return '［読み取り］領収書 1,000 円';
    },
  }) as { readPages: number[]; readText: string; note: string; pages: { page: number; text: string }[] };

  assert.deepEqual(sent, [{ mimeType: 'application/pdf', pages: 1 }], '送るのは読めなかった 1 ページだけ');
  assert.deepEqual(read.readPages, [2]);
  assert.equal(read.readText, '［読み取り］領収書 1,000 円');
  assert.match(read.note, /原本で確かめて/);
  assert.match(read.pages[0]?.text ?? '', /page one/, '取り出せた文字はそのまま返す');
});

/** 登録簿から `docs.create` を引く。 */
function docsCreateTool() {
  return BUILTIN_TOOLS.find((t) => t.name === 'docs.create')!;
}

// ─── 人に判断を求めるのは社外とお金だけ（仕様書 第9.4.0節、ADR-0028） ─────────────

test('人の判断が要るかは、社外に出るか・お金の確定か・会社の設定で決まる', () => {
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  registry.register({ name: 'invoice.finalize', risk: 'financial', activityLabel: '', description: '', invoke: async () => null });
  const allow = { writeInternal: 'allow' as const, perAgent: {} };
  const strict = { writeInternal: 'require' as const, perAgent: {} };
  assert.equal(needsHuman([], registry, allow, 'x'), false, '行うことが無ければ通る');
  assert.equal(needsHuman([{ name: 'tasks.create' }], registry, allow, 'x'), false, '社内への書き込みは既定で通る');
  assert.equal(needsHuman([{ name: 'tasks.create' }], registry, strict, 'x'), true, '会社が「承認が必要」にしていれば人に回す');
  assert.equal(needsHuman([{ name: 'chat.post', internal: true }], registry, allow, 'x'), false, '社内だけと確かめた投稿は通る');
  assert.equal(needsHuman([{ name: 'chat.post' }], registry, allow, 'x'), true, '確かめられなかった投稿は社外とみなす');
  assert.equal(needsHuman([{ name: 'gmail.send', internal: true }], registry, allow, 'x'), true, 'メールは確かめる手段を持たず、常に人');
  assert.equal(needsHuman([{ name: 'invoice.finalize', internal: true }], registry, allow, 'x'), true, 'お金の確定は常に人');
  assert.equal(needsHuman([{ name: 'unknown.tool' }], registry, allow, 'x'), true, '知らないツールは人に回す');
});

test('社外の人が入れないスペースへの投稿は、承認の段を自動で通って投稿する（第9.3.3節）', async () => {
  const { repo, connector, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { space: '営業部', text: '共有します' } });
  repo.settings.automation = { writeInternal: 'allow', perAgent: {} };
  connector.chat.findSpace = async () => ({ space: 'spaces/SALES', displayName: '営業部', external: false });
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'completed');
  assert.equal(repo.approvals.length, 0, '承認トレイには出さない');
  assert.equal(connector.outbox.filter((m) => m.kind === 'chat').length, 1, '記録どおり 1 回だけ投稿する');
  const gate = repo.steps.find((s) => s.kind === 'approval')!;
  assert.equal(gate.status, 'succeeded');
  assert.equal((gate.output as { reason?: string }).reason, AUTO_PASS_REASON, '実行の詳細に「自動で通過」と残す');
  assert.ok(repo.audits.some((a) => a.action === 'approval.auto'));
});

test('社外の人が入れるスペースや、分からないスペースへの投稿は、人の承認を待つ', async () => {
  for (const external of [true, null]) {
    const { repo, connector, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { space: '取引先', text: '共有します' } });
    repo.settings.automation = { writeInternal: 'allow', perAgent: {} };
    connector.chat.findSpace = async () => ({ space: 'spaces/EXT', displayName: '取引先', external });
    assert.equal((await engine.advance(run)).outcome, 'awaiting_approval', `external: ${external}`);
    assert.equal(connector.outbox.length, 0);
  }
});

test('行えない操作があれば、社内だけでも自動で通さず人に回す（欠けたまま終わらせない）', async () => {
  const { repo, connector, engine, run } = setup(SHARE_DEF, { name: 'chat.post', args: { space: '無い部', text: '共有します' } });
  repo.settings.automation = { writeInternal: 'allow', perAgent: {} };
  connector.chat.findSpace = async () => ({ reason: '「無い部」という名前のチャットのスペースが見つかりません' });
  assert.equal((await engine.advance(run)).outcome, 'awaiting_approval');
});

/** 呼ばれた順に、決めた応答を返す推論（往復ごとに言い直す推論を再現する）。 */
function scriptedLlm(replies: { name: string; args: Record<string, unknown> }[][]): LlmProvider & { prompts: string[] } {
  let i = 0;
  const prompts: string[] = [];
  return {
    name: 'scripted',
    prompts,
    async complete(req: LlmRequest) {
      prompts.push(String(req.messages.at(-1)?.content ?? ''));
      const calls = replies[Math.min(i++, replies.length - 1)] ?? [];
      return { text: calls.length > 0 ? calls.map((c) => '```tool\n' + JSON.stringify(c) + '\n```').join('\n') : '終わりました。', tokensUsed: 5 };
    },
  };
}

/** 決めた応答の推論で、共有の業務を動かす。 */
function scriptedShare(def: AgentDefinition, replies: Parameters<typeof scriptedLlm>[0]) {
  const { repo, connector, run } = setup(def, { name: 'chat.post', args: {} });
  repo.settings.automation = { writeInternal: 'allow', perAgent: {} };
  connector.chat.findSpace = async (_p, input) => (input === '無い部'
    ? { reason: '「無い部」という名前のチャットのスペースが見つかりません' }
    : { space: 'spaces/SALES', displayName: '営業部', external: false });
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const llm = scriptedLlm(replies);
  const engine = new RunEngine({
    repo: repo as unknown as Repository, registry, connector, files: new MemoryFileStore(), resolveDefinition: () => def, llm,
  });
  return { repo, connector, run, engine, llm };
}

test('組み立てで同じスペースへの投稿を言い直したら、後のものだけを記録する（投稿を 2 重にしない。2026-09-26）', async () => {
  const { connector, run, engine } = scriptedShare(SHARE_DEF, [
    [], // 準備の段（ツールを使わない）
    // 組み立て 1 往復目: 見つからない先への投稿と、リンク無しの投稿
    [{ name: 'chat.post', args: { space: '無い部', text: 'x' } }, { name: 'chat.post', args: { space: '営業部', text: 'リンク無し' } }],
    // 2 往復目: リンク付きで言い直す
    [{ name: 'chat.post', args: { space: '営業部', text: 'リンク付き' } }],
    [],
  ]);
  assert.equal((await engine.advance(run)).outcome, 'completed', '言い直して行えるようになったので、自動で通る');
  const posts = connector.outbox.filter((m) => m.kind === 'chat');
  assert.equal(posts.length, 1, '1 回だけ投稿する');
  assert.equal((posts[0]!.body as { text: string }).text, 'リンク付き', '後の言い直しを使う');
});

test('段が必ず呼ぶツールを呼ばずに終えようとしたら、一度だけ促す（第9.2.7節。2026-09-26 の呼び忘れ）', async () => {
  const def: AgentDefinition = {
    ...SHARE_DEF, id: 'share-required', tools: ['chat.post', 'knowledge.register'],
    steps: SHARE_DEF.steps.map((s) => (s.id === 'share' ? { ...s, required: ['chat.post', 'knowledge.register'] } : s)),
  };
  const { repo, run, engine, llm } = scriptedShare(def, [
    [],
    [{ name: 'chat.post', args: { space: '営業部', text: '共有します' } }],
    [], // 登録を呼ばずに終えようとする
    [{ name: 'knowledge.register', args: { artifactId: 'none' } }],
    [],
  ]);
  await engine.advance(run);
  assert.ok(llm.prompts.some((p) => p.includes('必ず呼ぶツールを、まだ呼んでいません: knowledge.register')), '呼ぶよう促す');
  const gate = repo.steps.find((s) => s.stepId === 'gate')!;
  assert.deepEqual(((gate.input as { toolCalls: { name: string }[] }).toolCalls).map((c) => c.name), ['chat.post', 'knowledge.register']);
});

test('段が必ず呼ぶツールは、その段で使えるツールでなければ定義を拒む', () => {
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const bad: AgentDefinition = { ...SHARE_DEF, steps: SHARE_DEF.steps.map((s) => (s.id === 'share' ? { ...s, required: ['gmail.send'] } : s)) };
  assert.throws(() => validateDefinition(bad, registry), /必ず呼ぶツール/);
});
