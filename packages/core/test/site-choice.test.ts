/**
 * @file 秘書が対象のサイトを決めることの単体テスト（仕様書 第47.6節、ADR-0148）。
 *
 * サイトが 2 つ以上（REST API の WordPress と MCP のサイト）のとき、サイトの更新の頼みは、頼みの名前 → その日の答え → 聞き返す、
 * の順で決め、決まったサイトの業務に取り替えることを確かめる。お知らせの作成とコラムの作成は、入れるサイトを設定で決めるので取り替えない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition } from '@m2office/shared';
import { Secretary, answeredSite, namedSite, siteAliases, type LlmProvider, type Repository, type SiteOption } from '../src/index.js';

const sites: SiteOption[] = [
  { key: 'rest', name: '趣味のブログ', aliases: siteAliases('趣味のブログ', 'blog.example') },
  { key: 'mcp:clinic', name: 'みどり皮膚科クリニック', aliases: siteAliases('みどり皮膚科クリニック', '医院のサイトの接続', 'site.example') },
];

/** 業務の定義の形だけ（取り次ぎと入力の埋め方に使う）。 */
const def = (id: string, name: string): AgentDefinition => ({
  schemaVersion: 1, id, version: 1, name, category: 'sample', description: name, locale: 'ja-JP', compartment: null,
  inputs: { type: 'object', required: ['request'], properties: { request: { type: 'string', title: '頼みたいこと' } } },
  tools: [], steps: [], constraints: [], limits: { maxSteps: 1, maxTokens: 1, timeoutSec: 1 },
});
const restEdit = def('site-updates:edit', 'サイトの直し案');
const mcpEdit = def('site-updates:site-clinic', 'サイトの直し案（みどり皮膚科クリニック）');
const announce = def('announcements:draft', 'お知らせの作成');

function world(route = 'site-updates:edit') {
  const started: { agentId: string; input: Record<string, unknown> }[] = [];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    listRoutingMemories: async () => [], searchKnowledge: async () => ({ hits: [], rewrites: [] }),
    appendAudit: async () => undefined, appendConversation: async () => undefined,
  } as unknown as Repository;
  const llm = {
    name: 'fake',
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? '';
      // 取り次ぎの推論は、いつも REST API のサイトの業務を選ぶ（名前が無ければどちらか分からない）
      if (system.startsWith('依頼に最も合う業務')) return { text: route, tokensUsed: 1 };
      if (system.includes('入力を JSON のオブジェクトで返して')) return { text: '{}', tokensUsed: 1 };
      return { text: 'わかりました', tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const s = new Secretary({
    repo, llm, connector: {} as never, agents: [restEdit, mcpEdit, announce],
    startAgent: async (_t, _u, a, input) => { started.push({ agentId: a.id, input }); return { runId: `run-${started.length}`, already: false }; },
    sites: async () => ({ sites }),
  });
  return { s, started };
}

test('頼みの中のサイトの名前は、名前の終わりの一般的な言葉を外しても当たる。2 つ当たれば決めない', () => {
  assert.equal(namedSite('みどり皮膚科のサイトに休診のお知らせを出して', sites)?.key, 'mcp:clinic');
  assert.equal(namedSite('趣味のブログの記事を直して', sites)?.key, 'rest');
  assert.equal(namedSite('blog.example のトップを直して', sites)?.key, 'rest');
  assert.equal(namedSite('休診のお知らせを出して', sites), null);
  assert.equal(namedSite('趣味のブログとみどり皮膚科の両方', sites), null);
});

test('聞き返しへの答えは、名前か番号で受ける', () => {
  assert.equal(answeredSite('2', sites)?.key, 'mcp:clinic');
  assert.equal(answeredSite('1つ目', sites)?.key, 'rest');
  assert.equal(answeredSite('みどり皮膚科クリニック', sites)?.key, 'mcp:clinic');
  assert.equal(answeredSite('後のほう', sites)?.key, 'mcp:clinic');
  assert.equal(answeredSite('今日の予定は？', sites), null);
});

test('サイトの更新の頼みで名前が無ければ、どちらのサイトかを聞き返す。答えたら、そのサイトの業務に頼む', async () => {
  const w = world();
  const asked = await w.s.respond('t', 'u1', '年末年始の休診のお知らせを出して');
  assert.match(asked.text, /どちらのサイトですか: 1\. 趣味のブログ・2\. みどり皮膚科クリニック/);
  assert.equal(w.started.length, 0, '決まるまで頼まない（既定のサイトに入れて進めない）');
  await w.s.respond('t', 'u1', '2');
  assert.equal(w.started[0]?.agentId, 'site-updates:site-clinic', '取り次ぎの推論が REST を選んでも、答えたサイトの業務に取り替える');
  assert.match(String(w.started[0]?.input['request']), /年末年始の休診のお知らせを出して/);
  // その日の続きは、答えたサイトで頼む（聞き返さない）
  await w.s.respond('t', 'u1', 'トップの診療時間を直して');
  assert.equal(w.started[1]?.agentId, 'site-updates:site-clinic');
});

test('頼みにサイトの名前があれば、そのサイトの業務に取り替える', async () => {
  const w = world();
  await w.s.respond('t', 'u1', 'みどり皮膚科のサイトのトップの診療時間を直して');
  assert.equal(w.started[0]?.agentId, 'site-updates:site-clinic');
  const r = world('site-updates:site-clinic');
  await r.s.respond('t', 'u1', '趣味のブログの記事の題名を直して');
  assert.equal(r.started[0]?.agentId, 'site-updates:edit');
});

test('お知らせの作成は、サイトを聞き返さず、業務も取り替えない（入れるサイトは設定で決める。LINE やメールが抜けないように）', async () => {
  const w = world('announcements:draft');
  const reply = await w.s.respond('t', 'u1', 'みどり皮膚科の年末年始の休診のお知らせを出して');
  assert.equal(w.started[0]?.agentId, 'announcements:draft');
  assert.doesNotMatch(reply.text, /どちらのサイトですか/);
});

test('MCP のサイトに入れるときは、そのサイトの業務を、元の業務を頼んだ本人として秘書の業務と同じに起こす', async () => {
  const { mcpSiteOf, siteHandOff } = await import('../src/index.js');
  assert.equal(mcpSiteOf('mcp:clinic'), 'clinic');
  assert.equal(mcpSiteOf('rest'), null);
  assert.equal(mcpSiteOf(undefined), null);
  const jobs: { agentId: string; requestedBy: string; origin: string; input: Record<string, unknown> }[] = [];
  const repo = {
    createJob: async (j: { agentId: string; requestedBy: string; origin: string; input: Record<string, unknown> }) => { jobs.push(j); },
    createRun: async () => undefined, appendAudit: async () => undefined,
  } as unknown as Repository;
  const handOff = siteHandOff(repo, async () => [mcpEdit]);
  const r = await handOff({ tenantId: 't', userId: 'u1' }, 'clinic', '次のお知らせを公開してください');
  assert.ok('runId' in r && r.siteName === 'みどり皮膚科クリニック');
  assert.deepEqual(jobs.map((j) => [j.agentId, j.requestedBy, j.origin, j.input['request']]), [['site-updates:site-clinic', 'u1', 'secretary', '次のお知らせを公開してください']]);
  const none = await siteHandOff(repo, async () => [])({ tenantId: 't', userId: 'u1' }, 'clinic', 'x');
  assert.ok('error' in none, '業務が無ければ（役割を確かめていない・サイトの更新を入れていない）理由を返す');
});
