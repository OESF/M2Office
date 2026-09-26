/**
 * @file 推論（Gemini）が使えない会社では動かさないことの単体テスト。
 *
 * 運営の鍵も会社の鍵も無い会社で、秘書・業務・音声・調べものが「設定されていません」と伝え、
 * 見本の応答で動いたように見せないことを確かめる。見本の応答（スタブ）は自動テストのときだけ使う。
 *
 * @see 仕様書 第20.2.4節、ADR-0030
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_NOT_CONFIGURED_MESSAGE, AiNotConfiguredError, OFFICIAL_AGENTS, RunEngine, SecretBox, Secretary, TenantAiResolver,
  ToolRegistry, BUILTIN_TOOLS, MockWorkspaceConnector, MemoryFileStore, UnconfiguredLlmProvider, platformAi,
  type Repository,
} from '../src/index.js';

test('運営の設定から推論を決める。鍵が無ければ「設定されていない」、スタブは LLM_PROVIDER=stub のときだけ', () => {
  assert.equal(platformAi({}).llm.name, 'unconfigured', '既定は gemini。鍵が無ければ設定されていない');
  assert.equal(platformAi({ LLM_PROVIDER: 'gemini' }).research.name, 'unconfigured');
  const withKey = platformAi({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIza-x' });
  assert.deepEqual([withKey.llm.name, withKey.research.name, withKey.platformKey, withKey.testMode], ['gemini', 'gemini', 'AIza-x', false]);
  const stub = platformAi({ LLM_PROVIDER: 'stub', GEMINI_API_KEY: 'AIza-x' });
  assert.deepEqual([stub.llm.name, stub.testMode, stub.platformKey], ['stub', true, null], 'スタブは自動テスト専用');
});

test('推論が使えない会社の秘書は、何を聞かれても設定されていないことだけを伝える', async () => {
  const repo = { appendConversation: async () => assert.fail('会話ログに残さない') } as unknown as Repository;
  const s = new Secretary({ repo, llm: new UnconfiguredLlmProvider(), connector: new MockWorkspaceConnector(), agents: OFFICIAL_AGENTS });
  const r = await s.respond('t', 'u', '今日の予定は？');
  assert.equal(r.text, AI_NOT_CONFIGURED_MESSAGE);
  assert.match(r.text, /管理者ページの「接続」/);
});

test('推論が使えない会社の業務は進めず、理由を残して失敗にする（定時実行も同じ）', async () => {
  const runs: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const run = { id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now, endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null };
  const repo = {
    getJob: async () => ({ id: 'j1', tenantId: 't', agentId: 'knowledge-qa', agentVersion: 1, requestedBy: 'u', origin: 'schedule', input: {}, createdAt: now }),
    updateRun: async (r: Record<string, unknown>) => { runs.push(r); },
    appendAudit: async () => undefined, getRun: async () => run, listUsers: async () => [], createNotification: async () => undefined,
    getUserSettings: async () => ({ notifications: { kinds: {} } }), listNotifications: async () => [],
  } as unknown as Repository;
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const engine = new RunEngine({
    repo, llm: new UnconfiguredLlmProvider(), registry, connector: new MockWorkspaceConnector(), files: new MemoryFileStore(),
    resolveDefinition: () => OFFICIAL_AGENTS.find((a) => a.id === 'knowledge-qa')!,
  });
  const res = await engine.advance(run as never);
  assert.equal(res.outcome, 'failed');
  assert.equal(res.outcome === 'failed' ? res.reason : '', AI_NOT_CONFIGURED_MESSAGE);
});

test('鍵の無い会社では音声を始めない。見本の音声は自動テストのときだけ', async () => {
  const repo = { getTenantCredential: async () => null } as unknown as Repository;
  const base = {
    repo, box: new SecretBox('k'), fallbackLlm: new UnconfiguredLlmProvider(), fallbackResearch: platformAi({}).research, platformKey: null,
    defaults: { fast: 'f', standard: 's', advanced: 'a', research: 'r', live: 'l' }, baseUrl: 'http://x',
  };
  await assert.rejects(new TenantAiResolver(base).voiceFor('t'), AiNotConfiguredError);
  assert.equal((await new TenantAiResolver({ ...base, testMode: true }).voiceFor('t')).name, 'mock');
});
