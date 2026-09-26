/**
 * @file 秘書が業務に頼んで実行し、外の情報や予定の要る依頼を調べものに回すことの単体テスト（仕様書 第10.9.6節、ADR-0033）。
 *
 * 秘書はあらゆる依頼に応える窓口である。専門の業務は「実行してよろしいですか」と聞かずに頼み、足りない入力だけを聞く。
 * 出張の行程のような依頼は、秘書の調べもの（Web の調べものと予定の読み取り）に回す。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_AGENTS, Secretary, fillInputs, type LlmProvider, type Repository } from '../src/index.js';

const agent = (id: string) => OFFICIAL_AGENTS.find((a) => a.id === id)!;

/** 推論の代わり。取次の判定と入力の埋め方に、決めた答えを返す。 */
function llmWith(answers: { route?: string; fill?: string }) {
  const seen: string[] = [];
  return {
    name: 'fake',
    seen,
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? '';
      const last = String(req.messages.at(-1)?.content ?? '');
      if (last.startsWith('社内の規程や文書を探します')) return { text: '', tokensUsed: 0 };
      seen.push(system.slice(0, 40));
      if (system.startsWith('依頼に最も合う業務')) return { text: answers.route ?? 'none', tokensUsed: 1 };
      if (system.includes('入力を JSON のオブジェクトで返して')) { seen.push(last); return { text: answers.fill ?? '{}', tokensUsed: 1 }; }
      return { text: 'わかりました', tokensUsed: 1 };
    },
  } as unknown as LlmProvider & { seen: string[] };
}

function deps(conversations: { message: string; reply: string }[] = []) {
  const started: { agentId: string; input: Record<string, unknown> }[] = [];
  const lookups: { request: string; context?: string }[] = [];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => [],
    listUserCompartments: async () => [],
    listConversationsOfDay: async () => conversations,
    searchKnowledge: async () => ({ hits: [], rewrites: [] }),
    appendAudit: async () => undefined,
    appendConversation: async () => undefined,
  } as unknown as Repository;
  return {
    repo, started, lookups,
    startAgent: async (_t: string, _u: string, a: { id: string }, input: Record<string, unknown>) => {
      started.push({ agentId: a.id, input });
      return { runId: `run-${a.id}`, already: false };
    },
    startLookup: async (_t: string, _u: string, request: string, _f?: string, context?: string) => {
      lookups.push({ request, context });
      return { runId: 'run-lookup', already: false };
    },
  };
}

test('専門の業務は、入力を埋めて頼んで実行する。「実行してよろしいですか」と聞かない', async () => {
  const d = deps();
  const llm = llmWith({ route: 'scheduling', fill: '{"title":"企画会議","attendees":"yamada@example.jp","period":"来週"}' });
  const s = new Secretary({ repo: d.repo, llm, connector: {} as never, agents: [agent('scheduling')], startAgent: d.startAgent, startLookup: d.startLookup });
  const reply = await s.respond('t', 'u1', '来週、山田さん（yamada@example.jp）と企画会議を調整してください');
  assert.deepEqual(d.started, [{ agentId: 'scheduling', input: { title: '企画会議', attendees: 'yamada@example.jp', period: '来週' } }]);
  assert.match(reply.text, /「日程調整」に頼みました。終わりましたらお伝えします/);
  assert.doesNotMatch(reply.text, /よろしいですか/);
  assert.deepEqual(reply.lookup, { runId: 'run-scheduling', request: '来週、山田さん（yamada@example.jp）と企画会議を調整してください' }, '結果はあとで伝える');
  assert.equal(reply.suggestedAgent, undefined);
});

test('埋められない必須の入力だけを聞き、業務を開くボタンを添える。実行はしない', async () => {
  const d = deps();
  const llm = llmWith({ route: 'scheduling', fill: '{"title":"企画会議"}' });
  const s = new Secretary({ repo: d.repo, llm, connector: {} as never, agents: [agent('scheduling')], startAgent: d.startAgent, startLookup: d.startLookup });
  const reply = await s.respond('t', 'u1', '企画会議の日程を調整してください');
  assert.equal(d.started.length, 0);
  assert.match(reply.text, /参加者（社内のみ）が要ります。教えてください/);
  assert.equal(reply.suggestedAgent?.id, 'scheduling');
});

test('出張の行程のような、外の最新の情報と予定が要る依頼は、秘書の調べものに回す（照会の言い回しでも）', async () => {
  const d = deps();
  const llm = llmWith({ route: 'secretary-lookup' });
  const s = new Secretary({
    repo: d.repo, llm, connector: {} as never, agents: [agent('minutes'), agent('secretary-lookup')], startAgent: d.startAgent, startLookup: d.startLookup,
  });
  const msg = '10月1日の10時から15時まで大阪の道頓堀の近くで会議があります。東京から日帰りで、新幹線の時刻も含めて行程を教えてください';
  const reply = await s.respond('t', 'u1', msg);
  assert.deepEqual(d.lookups.map((x) => x.request), [msg]);
  assert.equal(d.started.length, 0, '照会は業務に取り次がない（調べものだけ）');
  assert.equal(reply.lookup?.runId, 'run-lookup');
  assert.match(reply.text, /お調べします/);
});

test('会社の決まりの照会は、調べものに回さずにその場で答える', async () => {
  const d = deps();
  const llm = llmWith({ route: 'none' });
  const s = new Secretary({ repo: d.repo, llm, connector: {} as never, agents: [agent('secretary-lookup')], startAgent: d.startAgent, startLookup: d.startLookup });
  const reply = await s.respond('t', 'u1', '会議費の上限はいくらですか');
  assert.equal(reply.layer, 'full');
  assert.equal(d.lookups.length, 0);
});

test('「さっきの行程をカレンダーに入れて」は、今日の会話を材料に予定の登録に頼む', async () => {
  const d = deps([{ message: '大阪出張の行程を教えて', reply: '| 7:30 | 東京 発 |\n| 9:57 | 新大阪 着 |' }]);
  const llm = llmWith({ route: 'calendar-register', fill: '{"request":"10/1 7:30〜9:57 東京→新大阪"}' });
  const s = new Secretary({ repo: d.repo, llm, connector: {} as never, agents: [agent('calendar-register')], startAgent: d.startAgent, startLookup: d.startLookup });
  const reply = await s.respond('t', 'u1', 'さっきの行程をカレンダーに入れておいて');
  assert.deepEqual(d.started, [{ agentId: 'calendar-register', input: { request: '10/1 7:30〜9:57 東京→新大阪' } }]);
  assert.ok(llm.seen.some((x) => x.includes('9:57 | 新大阪 着')), '入力を埋める推論に、今日の会話を渡す');
  assert.match(reply.text, /「予定の登録」に頼みました/);
});

test('fillInputs: 推論が JSON を返さなければ、依頼の文を request に入れる。ファイルは fileId に入れる', async () => {
  const llm = { name: 'stub', complete: async () => ({ text: '［スタブ応答］', tokensUsed: 0 }) } as unknown as LlmProvider;
  const r = await fillInputs(agent('secretary-lookup'), 'この表の品目は', '', llm, 'file-1');
  assert.deepEqual(r.input, { request: 'この表の品目は', fileId: 'file-1' });
  assert.deepEqual(r.missing, []);
  const m = await fillInputs(agent('scheduling'), '調整して', '', llm);
  assert.deepEqual(m.missing, ['目的・件名', '参加者（社内のみ）']);
});

test('日付を指定した長い依頼は、「スケジュール」の語があっても定型の予定の照会（層 1）にしない', async () => {
  const d = deps();
  const llm = llmWith({ route: 'secretary-lookup' });
  const s = new Secretary({ repo: d.repo, llm, connector: {} as never, agents: [agent('secretary-lookup')], startAgent: d.startAgent, startLookup: d.startLookup });
  const reply = await s.respond('t', 'u1', '10月1日の朝10時から夕方3時まで大阪でミーティングがあります。東京から日帰りで、新幹線の時間も含めて全体のスケジュールを教えてください');
  assert.notEqual(reply.layer, 'direct');
  assert.equal(d.lookups.length, 1);
});

test('段取りを頼む言い回しなら、業務の名前が入っていても 1 つの業務に決めず、段取りを作ってすぐ返す（第10.14節）', async () => {
  const d = deps();
  const plans: { request: string }[] = [];
  const repo = Object.assign(d.repo, { createPlan: async (p: { request: string }) => { plans.push(p); }, listSchedules: async () => [] });
  const llm = llmWith({ route: 'plan' });
  const s = new Secretary({ repo, llm, connector: {} as never, agents: [agent('meeting-prep'), agent('knowledge-qa')], startAgent: d.startAgent, startLookup: d.startLookup });
  const reply = await s.respond('t', 'u1', '次の会議の準備と、出張規程の確認を、それぞれの業務に頼んでまとめて報告して');
  assert.equal(d.started.length, 0, '語句の一致で「会議の準備」だけに取り次がない');
  assert.equal(plans.length, 1);
  assert.match(reply.text, /段取りを組みます/);
  assert.match(reply.lookup?.runId ?? '', /^plan:/);
});
