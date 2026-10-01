/**
 * @file 配備の形と、外部の AI に渡さない決まりの単体テスト（仕様書 第8.6節・第16.3.7.1節、ADR-0059）。
 *
 * ローカルの方針が効く条件、「外部の AI を使ってよい」印の確かめ、業務ごとの AI の選び方と途中で切り替えないこと、
 * 社外の接続に送ってよいか、音声の秘書と Web の調べものの扱い、ローカル AI の口、スキルの印の読み取りを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_TENANT_SETTINGS, type AgentDefinition, type AiPolicyMode } from '@m2office/shared';
import {
  AiPolicyBlockedError, BUILTIN_TOOLS, LocalLlmProvider, SecretBox, TenantAiResolver, ToolRegistry, UnconfiguredLlmProvider,
  deploymentFromEnv, effectiveAiPolicy, externalAiAllowed, loadExtensionFiles, localLlmFromEnv, platformAi,
  type LlmProvider, type Repository,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

const agent = (over: Partial<AgentDefinition>): AgentDefinition => ({
  schemaVersion: 1, id: 'a', version: 1, name: '業務', category: 'x', description: '', locale: 'ja-JP', compartment: null,
  inputs: { type: 'object', properties: {} }, tools: [], steps: [], constraints: [], limits: { maxSteps: 1, maxTokens: 1, timeoutSec: 1 },
  ...over,
} as AgentDefinition);

const fakeLlm = (name: string): LlmProvider => ({ name, complete: async () => ({ text: name, tokensUsed: 1 }) });

function resolver(mode: AiPolicyMode, deployment: 'cloud' | 'onsite', sendPolicy?: 'block' | 'deidentified') {
  const repo = {
    getTenantCredential: async () => null,
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, aiPolicy: { mode } }),
    listConnections: async () => [{ id: 'evidencemd', ...(sendPolicy ? { sendPolicy } : {}) }],
  } as unknown as Repository;
  return new TenantAiResolver({
    repo, box: new SecretBox('k'), fallbackLlm: fakeLlm('gemini'), fallbackResearch: platformAi({ LLM_PROVIDER: 'stub' }).research, platformKey: 'key',
    defaults: { fast: 'f', standard: 's', advanced: 'a', research: 'r', live: 'l' }, baseUrl: 'http://x',
    deployment, localLlm: fakeLlm('local'),
  });
}

test('配備の形とローカルの方針: ローカルの方針はローカルの形でだけ効く', () => {
  assert.equal(deploymentFromEnv({}), 'cloud');
  assert.equal(deploymentFromEnv({ M2O_DEPLOYMENT: 'onsite' }), 'onsite');
  const s = { aiPolicy: { mode: 'local-first' as const } };
  assert.equal(effectiveAiPolicy('cloud', s), 'cloud');
  assert.equal(effectiveAiPolicy('onsite', s), 'local-first');
});

test('外部の AI を使ってよい印: 会社のデータを読むツール・ファイルの欄・権限区画があれば効かない', () => {
  assert.deepEqual(externalAiAllowed(agent({ externalAi: true, tools: ['web.research', 'document.create'] }), registry), { ok: true });
  assert.equal(externalAiAllowed(agent({ tools: ['web.research'] }), registry).ok, false);
  const reads = externalAiAllowed(agent({ externalAi: true, tools: ['web.research', 'knowledge.search'] }), registry);
  assert.ok(!reads.ok && reads.reason.includes('knowledge.search'));
  assert.equal(externalAiAllowed(agent({ externalAi: true, tools: ['web.research'], inputs: { type: 'object', properties: { f: { type: 'string', format: 'file' } } } as never }), registry).ok, false);
  assert.equal(externalAiAllowed(agent({ externalAi: true, tools: ['web.research'], compartment: 'hr' }), registry).ok, false);
});

test('業務ごとの AI: ローカルを既定では印のある業務だけ外部。秘書などはローカル。クラウドの形では方針にかかわらずクラウド', async () => {
  const safe = agent({ externalAi: true, tools: ['web.research'] });
  const reads = agent({ externalAi: true, tools: ['knowledge.search'] });
  const local = resolver('local-first', 'onsite');
  assert.equal((await local.llmFor('t')).name, 'local');
  assert.deepEqual(await local.llmForRun('t', safe, registry).then((r) => [r.kind, r.llm.name]), ['external', 'gemini']);
  const fallback = await local.llmForRun('t', reads, registry);
  assert.equal(fallback.kind, 'local');
  assert.match(fallback.note ?? '', /knowledge\.search/);
  assert.equal((await resolver('local-only', 'onsite').llmForRun('t', safe, registry)).kind, 'local');
  const cloud = resolver('local-only', 'cloud');
  assert.equal((await cloud.llmFor('t')).name, 'gemini');
  assert.equal((await cloud.llmForRun('t', safe, registry)).kind, 'cloud');
});

test('途中で切り替えない: 前の段がローカルならローカルのまま。外部で始めた業務は、方針が厳しくなったら続けない', async () => {
  const safe = agent({ externalAi: true, tools: ['web.research'] });
  assert.equal((await resolver('cloud', 'onsite').llmForRun('t', safe, registry, 'local')).llm.name, 'local');
  const stopped = await resolver('local-only', 'onsite').llmForRun('t', safe, registry, 'external');
  await assert.rejects(stopped.llm.complete({ tier: 'fast', messages: [] }), AiPolicyBlockedError);
  assert.equal((await resolver('local-first', 'onsite').llmForRun('t', safe, registry, 'external')).llm.name, 'gemini');
});

test('社外の接続: ローカルの方針では、個人を特定する情報を除いて送ってよいと決めた接続にだけ送る', async () => {
  assert.equal(await resolver('cloud', 'onsite').connectionBlocked('t', 'evidencemd'), null);
  assert.match(await resolver('local-first', 'onsite').connectionBlocked('t', 'evidencemd') ?? '', /送りません/);
  assert.equal(await resolver('local-first', 'onsite', 'deidentified').connectionBlocked('t', 'evidencemd'), null);
});

test('音声の秘書と Web の調べもの: ローカルの方針では音声を始めない。ローカルだけでは Web の調べものも使わない', async () => {
  await assert.rejects(resolver('local-first', 'onsite').voiceFor('t'), AiPolicyBlockedError);
  await assert.rejects((await resolver('local-only', 'onsite').researchFor('t')).research('x'), AiPolicyBlockedError);
  assert.notEqual((await resolver('local-first', 'onsite').researchFor('t')).name, 'unconfigured');
});

test('ローカル AI の口: 設定が無ければ使えないと伝え、あれば OpenAI 互換の口を呼ぶ', async () => {
  assert.equal(localLlmFromEnv({}), null);
  const cfg = localLlmFromEnv({ LOCAL_LLM_URL: 'http://127.0.0.1:1/v1/', LOCAL_LLM_MODEL: 'gemma', LOCAL_LLM_MODEL_FAST: 'gemma-small' });
  assert.deepEqual(cfg?.models, { fast: 'gemma-small', standard: 'gemma', advanced: 'gemma' });
  assert.equal(cfg?.baseUrl, 'http://127.0.0.1:1/v1');
  const none = resolver('local-first', 'onsite');
  // 自動テスト用の差し替えを外すと、設定の無いローカル AI は使えないと伝える
  const bare = new TenantAiResolver({ ...(none as unknown as { deps: object }).deps, localLlm: undefined, local: null } as never);
  assert.equal(bare.localLlm().name, 'unconfigured');
  assert.equal((bare.localLlm() as UnconfiguredLlmProvider & { unavailableReason?: string }).unavailableReason?.includes('ローカル AI'), true);

  let seen: Record<string, unknown> | null = null;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const ch of req) body += ch;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gemma' }] }));
    seen = JSON.parse(body);
    res.end(JSON.stringify({ model: 'gemma', choices: [{ message: { content: 'こんにちは' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const llm = new LocalLlmProvider({ baseUrl: base, models: { fast: 'gemma', standard: 'gemma', advanced: 'gemma' } });
    const r = await llm.complete({ tier: 'fast', messages: [{ role: 'user', content: 'やあ' }] });
    assert.equal(r.text, 'こんにちは');
    assert.equal(r.tokensUsed, 5);
    assert.equal((seen as unknown as { model: string }).model, 'gemma');
    assert.deepEqual(await llm.check(), { ok: true, models: ['gemma'] });
    await assert.rejects(llm.readImage({ bytes: new Uint8Array([1]), mimeType: 'application/pdf' }), /PDF/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('スキルの印: metadata.m2office-external-ai で外部の AI を使ってよい業務になる', () => {
  const skill = ['---', 'name: sns-post', 'description: SNS の投稿の文案を作る', 'allowed-tools: web.research document.create', 'metadata:',
    '  m2office-external-ai: "true"', '---', '', '# SNS の投稿', '', '話題を Web で調べ、投稿の文案を資料にする。'].join('\n');
  const { pkg, problems } = loadExtensionFiles(new Map([['SKILL.md', new TextEncoder().encode(skill)]]), registry);
  assert.deepEqual(problems, []);
  assert.equal(pkg?.agents[0]?.externalAi, true);
});
