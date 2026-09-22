/**
 * `@m2office/core` の単体テスト。
 *
 * データベースを使わず、必要な操作だけを持つ記憶上の永続化層で確かめる。
 * 通しの確認は `npm run smoke` が担う。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS,
  type AgentDefinition, type Approval, type AuditEvent, type Job, type Notification, type Run,
  type RunStep, type TenantSettings,
} from '@m2office/shared';
import {
  RunEngine, ToolRegistry, BUILTIN_TOOLS, MockWorkspaceConnector, MemoryFileStore, nextRunAt,
  saveFile, readSheet, renderSheet, parseCsv,
  ApprovalForbiddenError, DefinitionInvalidError, validateDefinition,
  type LlmProvider, type Repository,
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
  async appendRunStep(_t: string, s: RunStep) { this.steps.push(s); }
  async updateRunStep(_t: string, s: RunStep) { this.steps = this.steps.map((x) => (x.id === s.id ? s : x)); }
  async getRunStepById(_t: string, id: string) { return this.steps.find((s) => s.id === id) ?? null; }
  async createApproval(a: Approval) { this.approvals.push(a); }
  async getApproval(t: string, id: string) { return this.approvals.find((a) => a.tenantId === t && a.id === id) ?? null; }
  async updateApproval(a: Approval) { this.approvals = this.approvals.map((x) => (x.id === a.id ? a : x)); }
  async listPendingApprovals(t: string) { return this.approvals.filter((a) => a.tenantId === t && !a.decision); }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
  async createNotification(n: Notification) { this.notifications.push(n); }
  async findUserById(t: string, id: string) { return this.users.find((u) => u.tenantId === t && u.id === id) ?? null; }
  artifacts: { title: string; fileId?: string | null }[] = [];
  async createArtifact(a: { title: string; fileId?: string | null }) { this.artifacts.push(a); }
  fileRows: Record<string, unknown>[] = [];
  async createFile(f: Record<string, unknown>) { this.fileRows.push(f); }
  async getFile(t: string, id: string) { return this.fileRows.find((f) => f['tenantId'] === t && f['id'] === id) ?? null; }
  settings: TenantSettings = structuredClone(DEFAULT_TENANT_SETTINGS);
  async getTenantSettings() { return this.settings; }
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
    endedAt: null, tokensUsed: 0, costJpy: 0, failureReason: null };
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

test('approver: requester の承認は、依頼した本人だけが判断できる', async () => {
  const def: AgentDefinition = {
    ...SHARE_DEF, id: 'requester-test',
    steps: SHARE_DEF.steps.map((s) =>
      s.type === 'approval' ? { ...s, approver: 'requester' as const, approverRole: [] } : s),
  };
  const { repo, engine, run } = setup(def, { name: 'chat.post', args: {} });
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
  assert.equal(ng.repo.notifications.length, 0, '宛先を指定した通知は送らない');

  const off = setup(def, { name: 'notification.send', args: { kind: 'brief', title: '週次' } });
  off.repo.settings.automation.writeInternal = 'allow';
  off.repo.userSettings.notifications.kinds.brief = false;
  await off.engine.advance(off.run);
  assert.equal(off.repo.notifications.length, 0, '本人が受け取らないと決めた種類は届けない');
});

const TASK_DEF: AgentDefinition = {
  ...SHARE_DEF, id: 'task-test', tools: ['tasks.create'],
  steps: [
    { id: 'make', type: 'agent', instruction: '起票する' },
    { id: 'after', type: 'agent', instruction: '後片付け' },
  ],
};

test('社内への書き込みは、既定では実行前に本人の確認を求める', async () => {
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
  assert.equal(res.outcome, 'completed', '既定で weekly-brief は承認なし（Q-53）');
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
