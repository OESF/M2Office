/**
 * @file 2 つの版の文書を条項ごとに比べることの単体テスト（仕様書 第28.13節）。条項の分け方・番号がずれても追うこと・
 * 足された・消された・変わった条項と文・番号だけ変わった条項・別の文書の見分け、契約書チェックの見本の修正版、
 * 秘書が「前の版と比べて」で前に渡したファイルを 2 つ目の欄に入れること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secondFileInputKey, type AgentDefinition } from '@m2office/shared';
import { Secretary, compareTexts, fillInputs, splitClauses, type LlmProvider, type Repository } from '../src/index.js';

const V1 = `業務委託契約書

甲と乙は、次のとおり契約する。

第1条（目的）
甲は乙に、システムの保守を委託する。

第2条（委託料）
甲は乙に、月額 50 万円を支払う。支払いは翌月末とする。

第3条（損害賠償）
乙の損害賠償の額は、委託料の 3 か月分を上限とする。

第4条（秘密保持）
甲と乙は、相手の秘密を守る。

第5条（競業）
乙は、契約の期間中、甲の競合と取引しない。
`;

const V2 = `業務委託契約書

甲と乙は、次のとおり契約する。

第1条（目的）
甲は乙に、システムの保守を委託する。

第2条（委託料）
甲は乙に、月額 50 万円を支払う。支払いは翌々月末とする。

第3条（再委託）
乙は、甲の書面の承諾なく再委託しない。

第4条（損害賠償）
乙は、甲に生じた一切の損害を賠償する。

第5条（秘密保持）
甲と乙は、相手の秘密を守る。
`;

test('条項に分ける: 前文と「第〇条（見出し）」。全角の数字と Article も読む', () => {
  assert.deepEqual(splitClauses(V1).map((c) => [c.number, c.title]), [['', '前文'], ['第1条', '目的'], ['第2条', '委託料'], ['第3条', '損害賠償'], ['第4条', '秘密保持'], ['第5条', '競業']]);
  assert.deepEqual(splitClauses('第１０条（解除）\n本文。\nArticle 2 (Term)\nThe term is one year.').map((c) => [c.number, c.title]), [['第10条', '解除'], ['Article2', 'Term']]);
});

test('比べる: 変わった文・足された条項・消された条項・番号だけ変わった条項を、新しい版の順に返す', () => {
  const r = compareTexts(V1, V2);
  assert.equal(r.beforeClauses, 6);
  assert.equal(r.afterClauses, 6);
  assert.deepEqual(r.renumbered, ['第4条 → 第5条']);
  assert.equal(r.unchanged, 3);
  assert.deepEqual(r.changes.map((c) => [c.kind, c.before?.number ?? null, c.after?.number ?? null]), [
    ['changed', '第2条', '第2条'], ['added', null, '第3条'], ['changed', '第3条', '第4条'], ['removed', '第5条', null],
  ]);
  const pay = r.changes[0]!;
  assert.deepEqual(pay.removed, ['支払いは翌月末とする。']);
  assert.deepEqual(pay.added, ['支払いは翌々月末とする。']);
  // 見出しの題名だけの行は文に数えない
  assert.deepEqual(r.changes[1]!.added, ['乙は、甲の書面の承諾なく再委託しない。']);
  assert.equal(r.changes[3]!.before!.title, '競業');
  assert.ok(r.similarity > 0.6);
  // 同じ文書なら変わったところは無い
  assert.deepEqual(compareTexts(V1, V1).changes, []);
  // 別の文書は重なりがわずか
  assert.ok(compareTexts(V1, '賃貸借契約書\n第1条（物件）\n貸主は借主に部屋を貸す。\n').similarity < 0.3);
});

test('契約書チェックの見本の修正版: 5 件の変更をすべて挙げ、番号だけ変わった条項を分ける', () => {
  const read = (n: string) => readFileSync(new URL(`../../../docs/evals/contract-review/${n}`, import.meta.url), 'utf8');
  const r = compareTexts(read('sales-basic.md'), read('sales-basic-revised.md'));
  assert.deepEqual(r.changes.map((c) => `${c.kind}:${c.after?.title}`), [
    'changed:個別契約の成立', 'added:検収', 'changed:契約不適合責任', 'changed:代金の支払', 'changed:準拠法及び管轄',
  ]);
  assert.deepEqual(r.renumbered, ['第4条 → 第5条', '第7条 → 第8条', '第8条 → 第9条']);
  assert.ok(r.changes[2]!.added.includes('この損害賠償には、甲の逸失利益を含む。'));
});

/** 契約書チェックの形の業務（ファイルの欄が 2 つ）。 */
const REVIEW = {
  schemaVersion: 1, id: 'contract-review', version: 1, name: '契約書チェック', category: 'skill', description: '契約書を読む', locale: 'ja-JP', compartment: null,
  inputs: {
    type: 'object', required: ['契約書'],
    properties: { 契約書: { type: 'string', title: '契約書', format: 'file' }, 前の版: { type: 'string', title: '前の版', format: 'file' }, '気になる点・背景': { type: 'string', title: '気になる点・背景', format: 'textarea' } },
  },
  tools: [], steps: [], constraints: [], limits: { maxSteps: 1, maxTokens: 1, timeoutSec: 1 }, evals: [],
} as unknown as AgentDefinition;

test('2 つ目のファイルの欄: 推論に埋めさせず、「前の版と比べて」かどうかだけを読ませる', async () => {
  assert.equal(secondFileInputKey(REVIEW), '前の版');
  const prompts: string[] = [];
  const llm = {
    name: 'fake',
    complete: async (req: { messages: { content: string }[] }) => {
      prompts.push(req.messages[0]!.content);
      return { text: '{"前の版":"file-x","__comparePrevious":true,"気になる点・背景":"支払いが心配"}', tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const r = await fillInputs(REVIEW, '修正版が戻ってきた。前の版と比べて。支払いが心配', '', llm, 'file-2');
  assert.deepEqual(r.input, { '気になる点・背景': '支払いが心配', 契約書: 'file-2' });
  assert.equal(r.comparePrevious, true);
  assert.doesNotMatch(prompts[0]!, /- 前の版:/);
  assert.match(prompts[0]!, /__comparePrevious/);
});

test('秘書: 修正版を渡して「前の版と比べて」と頼まれたら、本人が前に渡した契約書を「前の版」に入れて頼む', async () => {
  const started: Record<string, unknown>[] = [];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }), appendAudit: async () => undefined, appendConversation: async () => undefined,
  } as unknown as Repository;
  const make = (compare: boolean) => ({
    name: 'fake',
    complete: async (req: { messages: { content: string }[] }) => {
      const system = req.messages[0]!.content;
      if (system.startsWith('依頼に最も合う業務')) return { text: 'contract-review', tokensUsed: 1 };
      if (system.includes('入力を JSON のオブジェクトで返して')) return { text: JSON.stringify({ __comparePrevious: compare }), tokensUsed: 1 };
      return { text: '', tokensUsed: 1 };
    },
  }) as unknown as LlmProvider;
  const asked: string[] = [];
  const secretary = (compare: boolean) => new Secretary({
    repo, llm: make(compare), connector: {} as never, agents: [REVIEW],
    fileName: async () => '取引基本契約書_修正版.pdf',
    previousFile: async (_t, _u, agentId) => { asked.push(agentId); return 'file-1'; },
    startAgent: async (_t, _u, _a, input) => { started.push(input); return { runId: 'run-1', already: false }; },
  });
  await secretary(true).respond('t', 'u1', '修正版が戻ってきました。前の版と比べて', 'file-2');
  assert.deepEqual(started[0], { 契約書: 'file-2', 前の版: 'file-1' });
  assert.deepEqual(asked, ['contract-review']);
  // 比べる依頼でなければ、前の版は入れない
  await secretary(false).respond('t', 'u1', 'この契約書をチェックして', 'file-3');
  assert.deepEqual(started[1], { 契約書: 'file-3' });
});
