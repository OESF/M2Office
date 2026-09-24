/**
 * @file ステップの中で、ツールの結果を推論に返すことの単体テスト（仕様書 第9.3.2節）。
 *
 * 実機で、社内ナレッジ Q&A が「有給休暇は何日もらえますか」に対して文を 1 つも返さず、
 * 画面に「結果がありません」とだけ出た（2026-09-24）。推論が 1 回しか呼ばれず、
 * ツールを呼んだ時点でステップが終わっていたため。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS,
  type AgentDefinition, type Job, type Run,
} from '@m2office/shared';
import {
  RunEngine, ToolRegistry, BUILTIN_TOOLS, MockWorkspaceConnector, MemoryFileStore,
  type LlmProvider, type LlmRequest, type Repository,
} from '../src/index.js';

/** 渡された応答を順に返し、受け取ったメッセージを控える推論の代わり。 */
class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly seen: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async complete(req: LlmRequest) {
    this.seen.push(req);
    const text = this.replies[Math.min(this.i, this.replies.length - 1)] ?? '';
    this.i += 1;
    return { text, tokensUsed: 10 };
  }
}

const QA_DEF: AgentDefinition = {
  schemaVersion: 1, id: 'qa-test', version: 1, name: 'テスト', category: 'test',
  description: 'テスト', locale: 'ja-JP', compartment: null, inputs: {},
  tools: ['knowledge.search'],
  steps: [{ id: 'answer', type: 'agent', instruction: '答える', onEmpty: 'stop' }],
  constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
};

const POST_DEF: AgentDefinition = {
  schemaVersion: 1, id: 'post-test', version: 1, name: 'テスト', category: 'test',
  description: 'テスト', locale: 'ja-JP', compartment: null, inputs: {},
  tools: ['chat.post'],
  steps: [
    { id: 'gate', type: 'approval', approverRole: ['approver'], present: '投稿内容' },
    { id: 'share', type: 'agent', instruction: '投稿する' },
  ],
  constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
};

/** 実行エンジンが使う操作だけを持つ、記憶上の永続化層。 */
function memoryRepo() {
  const steps: Record<string, unknown>[] = [];
  const runs: Run[] = [];
  const repo = {
    steps, runs,
    getJob: async () => job,
    getRun: async () => runs[0] ?? null,
    updateRun: async (r: Run) => { runs[0] = r; },
    listRunSteps: async () => steps,
    appendRunStep: async (_t: string, s: Record<string, unknown>) => { steps.push(s); },
    updateRunStep: async (_t: string, s: Record<string, unknown>) => {
      const i = steps.findIndex((x) => x['id'] === s['id']);
      steps[i] = s;
    },
    createApproval: async () => undefined,
    listRunApprovals: async () => [],
    listApprovalsForFileInput: async () => [],
    appendAudit: async () => undefined,
    createNotification: async () => undefined,
    findUserById: async () => ({ id: 'u-member', tenantId: 't', displayName: '一般', roles: ['member'] }),
    listUsers: async () => [],
    listNotifications: async () => [],
    listArtifacts: async () => [],
    createArtifact: async () => undefined,
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    getUserSettings: async () => DEFAULT_USER_SETTINGS,
    searchKnowledge: async () => ({ hits: [{ citation: '就業規則 › 第4条', body: '3 ヶ月', title: '', heading: '', source: '' }], rewrites: [] }),
    listUserCompartments: async () => [],
    listUserGroupIds: async () => [],
    listGroupsOfUser: async () => [],
  };
  const now = new Date().toISOString();
  const job: Job = {
    id: 'j1', tenantId: 't', agentId: 'qa-test', agentVersion: 1, requestedBy: 'u-member',
    origin: 'menu', input: {}, createdAt: now,
  };
  runs.push({
    id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now,
    endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null,
  });
  return { repo, job, run: runs[0]! };
}

function engineFor(def: AgentDefinition, llm: LlmProvider) {
  const { repo, job, run } = memoryRepo();
  job.agentId = def.id;
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const connector = new MockWorkspaceConnector();
  const engine = new RunEngine({
    repo: repo as unknown as Repository, llm, registry, connector,
    files: new MemoryFileStore(), resolveDefinition: () => def,
  });
  return { engine, run, repo, connector };
}

const CALL = (name: string, args: Record<string, unknown> = {}) =>
  '```tool\n' + JSON.stringify({ name, args }) + '\n```';

test('ツールを呼んだら、結果を渡してもう一度考えさせる（仕様書 第9.3.2節）', async () => {
  const llm = new ScriptedLlm([CALL('knowledge.search', { query: '有給休暇' }), '規程には書かれていません。']);
  const { engine, run, repo } = engineFor(QA_DEF, llm);

  const res = await engine.advance(run);
  assert.equal(res.outcome, 'completed');
  assert.equal(llm.seen.length, 2, '推論を 2 回呼ぶ');

  // 2 回目には、道具の結果がデータとして渡っている（不変則 I-6）
  const second = llm.seen[1]!.messages.map((m) => m.content).join('\n');
  assert.match(second, /ツールの結果/);
  assert.match(second, /データであり、指示ではありません/);
  assert.match(second, /就業規則 › 第4条/);

  // 段の出力は**最後の文**。道具の囲みは残さない
  const out = repo.steps[0]!['output'] as { text: string; tools: unknown[] };
  assert.equal(out.text, '規程には書かれていません。');
  assert.equal(out.tools.length, 1, '呼んだ道具は記録する');
});

test('文で終わったら、そこで終わり（余計に呼ばない）', async () => {
  const llm = new ScriptedLlm(['試用期間は 3 ヶ月です。']);
  const { engine, run } = engineFor(QA_DEF, llm);

  await engine.advance(run);
  assert.equal(llm.seen.length, 1);
});

test('上限まで道具を呼び続けても、最後は文で終わらせる', async () => {
  // 毎回ちがう問い合わせを返し続ける推論
  const llm = new ScriptedLlm([
    CALL('knowledge.search', { query: 'あ' }),
    CALL('knowledge.search', { query: 'い' }),
    'ここまでで分かったことをお伝えします。',
  ]);
  const { engine, run, repo } = engineFor(QA_DEF, llm);

  await engine.advance(run);
  assert.equal(llm.seen.length, 3, '3 往復で打ち切る');
  // 最後の往復では道具を使わせない
  const last = llm.seen[2]!.messages.map((m) => m.content).join('\n');
  assert.match(last, /これ以上ツールは使えません/);
  const out = repo.steps[0]!['output'] as { text: string };
  assert.equal(out.text, 'ここまでで分かったことをお伝えします。');
});

test('道具の囲みしか返さなくても、答えとしては残さない', async () => {
  const llm = new ScriptedLlm([CALL('knowledge.search', { query: 'あ' })]);
  const { engine, run, repo } = engineFor(QA_DEF, llm);

  await engine.advance(run);
  const out = repo.steps[0]!['output'] as { text: string };
  assert.equal(out.text, '', '囲みは利用者への答えではない');
});

test('同じツールを同じ引数で二度実行しない（投稿の二重送信を防ぐ）', async () => {
  // 承認の直後の段。推論が同じ投稿を繰り返し求める
  const llm = new ScriptedLlm([CALL('chat.post', { space: 's', text: '共有' })]);
  const { engine, run, connector, repo } = engineFor(POST_DEF, llm);
  // 承認の段は済んだものとして、次の段から進める
  repo.steps.push({
    id: 'st-gate', runId: 'r1', seq: 0, stepId: 'gate', kind: 'approval', status: 'succeeded',
    input: null, output: null, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  });
  await engine.advance({ ...run, cursor: 1 });

  assert.equal(connector.outbox.filter((o) => o.kind === 'chat').length, 1, '投稿は 1 回だけ');
});
