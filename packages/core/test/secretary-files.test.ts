/**
 * @file 秘書にいくつものファイルを渡すことの単体テスト（仕様書 第10.10.7節）。ファイルの欄が 2 つの業務には 2 つを名前から振り分けて 1 回頼む・
 * 1 つずつに同じことをする依頼はファイルごとに頼む・まとめる依頼と取り次ぐ先が無いときは全部を調べものに渡す・見つからないファイル・5 つまで。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition } from '@m2office/shared';
import { Secretary, type LlmProvider, type Repository } from '../src/index.js';

const agent = (id: string, fields: string[]) => ({
  schemaVersion: 1, id, version: 1, name: id === 'review' ? '契約書チェック' : '見積もりの読み取り', category: 'skill', description: '書類を読む', locale: 'ja-JP', compartment: null,
  inputs: { type: 'object', required: [fields[0]], properties: Object.fromEntries(fields.map((f) => [f, { type: 'string', title: f, format: 'file' }])) },
  tools: [], steps: [], constraints: [], limits: { maxSteps: 1, maxTokens: 1, timeoutSec: 1 }, evals: [],
}) as unknown as AgentDefinition;
const REVIEW = agent('review', ['契約書', '前の版']);
const QUOTE = agent('quote', ['見積書']);

const NAMES: Record<string, string> = { f1: '取引基本契約書_前回.pdf', f2: '取引基本契約書_修正版.pdf', f3: '見積書_C社.pdf', f4: '見積書_D社.pdf' };

function setup(route: string, fill: Record<string, unknown>, agents: AgentDefinition[] = [REVIEW, QUOTE]) {
  const started: { agent: string; input: Record<string, unknown> }[] = [];
  const lookups: { request: string; files: unknown }[] = [];
  const prompts: string[] = [];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }), appendAudit: async () => undefined, appendConversation: async () => undefined,
  } as unknown as Repository;
  const llm = {
    name: 'fake',
    complete: async (req: { messages: { content: string }[] }) => {
      const system = req.messages[0]!.content;
      if (system.startsWith('依頼に最も合う業務')) return { text: route, tokensUsed: 1 };
      if (system.includes('入力を JSON のオブジェクトで返して')) { prompts.push(system); return { text: JSON.stringify(fill), tokensUsed: 1 }; }
      return { text: '', tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const secretary = new Secretary({
    repo, llm, connector: {} as never, agents,
    fileName: async (_t, _u, id) => NAMES[id] ?? null,
    startAgent: async (_t, _u, a, input) => { started.push({ agent: a.id, input }); return { runId: `run-${started.length}`, already: false }; },
    startLookup: async (_t, _u, request, files) => { lookups.push({ request, files }); return { runId: 'run-lookup', already: false }; },
  });
  return { secretary, started, lookups, prompts };
}

test('ファイルの欄が 2 つの業務に 2 つ: 名前から新しい版を 1 つ目の欄に入れて 1 回頼む', async () => {
  const s = setup('review', { __firstFile: 2 });
  const reply = await s.secretary.respond('t', 'u1', '修正版が戻ってきたので前回と比べて', ['f1', 'f2']);
  assert.deepEqual(s.started, [{ agent: 'review', input: { 契約書: 'f2', 前の版: 'f1' } }]);
  assert.match(reply.text, /2 つのファイルを渡して頼みました/);
  assert.equal(reply.file?.name, '取引基本契約書_前回.pdf、取引基本契約書_修正版.pdf');
  assert.match(s.prompts[0]!, /1\. 取引基本契約書_前回\.pdf\n2\. 取引基本契約書_修正版\.pdf/);
  assert.doesNotMatch(s.prompts[0]!, /__comparePrevious/);
});

test('推論が振り分けを答えなければ、渡した順に入れる', async () => {
  const s = setup('review', {});
  await s.secretary.respond('t', 'u1', 'この 2 つを比べて', ['f2', 'f1']);
  assert.deepEqual(s.started[0]!.input, { 契約書: 'f2', 前の版: 'f1' });
});

test('1 つずつに同じことをする依頼は、ファイルごとに頼む', async () => {
  const s = setup('quote', { __each: true });
  const reply = await s.secretary.respond('t', 'u1', 'この見積書をそれぞれ読み取って', ['f3', 'f4']);
  assert.deepEqual(s.started, [{ agent: 'quote', input: { 見積書: 'f3' } }, { agent: 'quote', input: { 見積書: 'f4' } }]);
  assert.match(reply.text, /2 件に分けて頼みました/);
  assert.equal(s.lookups.length, 0);
});

test('まとめる・比べる依頼で、1 つの欄の業務しか無ければ、全部を調べものに渡す', async () => {
  const s = setup('quote', { __each: false });
  const reply = await s.secretary.respond('t', 'u1', 'C 社と D 社の見積書を比べて安いほうを教えて', ['f3', 'f4']);
  assert.equal(s.started.length, 0);
  assert.deepEqual(s.lookups, [{ request: 'C 社と D 社の見積書を比べて安いほうを教えて', files: ['f3', 'f4'] }]);
  assert.match(reply.text, /2 つのファイル（見積書_C社\.pdf、見積書_D社\.pdf）をお預かりしました/);
});

test('取り次ぐ先が無ければ全部を調べものに渡す。見つからないファイルがあれば頼まない。5 つまで', async () => {
  const none = setup('none', {});
  await none.secretary.respond('t', 'u1', 'この 3 つの要点を', ['f1', 'f3', 'f4']);
  assert.deepEqual(none.lookups[0]!.files, ['f1', 'f3', 'f4']);
  const missing = setup('quote', { __each: true });
  const r = await missing.secretary.respond('t', 'u1', 'それぞれ読んで', ['f3', 'other']);
  assert.match(r.text, /見つからないもの/);
  assert.equal(missing.started.length, 0);
  const many = setup('none', {});
  await many.secretary.respond('t', 'u1', '要点を', ['f1', 'f2', 'f3', 'f4', 'f1', 'x5', 'x6']);
  assert.equal(many.lookups.length, 0, '見つからないファイルが入っているので頼まない');
  const five = setup('none', {});
  Object.assign(NAMES, { x5: 'x5.pdf', x6: 'x6.pdf', x7: 'x7.pdf' });
  await five.secretary.respond('t', 'u1', '要点を', ['f1', 'f2', 'f3', 'f4', 'x5', 'x6', 'x7']);
  assert.deepEqual(five.lookups[0]!.files, ['f1', 'f2', 'f3', 'f4', 'x5']);
});
