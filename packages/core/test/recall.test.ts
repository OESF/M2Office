/**
 * @file 秘書が答えるときに使う記憶の単体テスト。今日のやり取り・会話の要約・覚えた事実・頼んだ業務を集め、
 * 「あれ、どうなった」に使えること、ほかの人のものを使わないことを確かめる。
 *
 * @see 仕様書 第10.7.3節、ADR-0027
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_AGENTS, REFERS_TO_PAST, Secretary, closeness, recall, type LlmProvider, type Repository } from '../src/index.js';

const NOW = new Date('2026-09-25T03:00:00.000Z');

function repoOf(userId = 'u1') {
  const asked: string[] = [];
  const repo = {
    listConversationsOfDay: async (_t: string, u: string) => (u === userId ? [
      { id: 'c1', tenantId: 't', userId, message: 'A 社の見積はいつまで？', reply: '10 月 3 日までです。', layer: 'full', agentId: null, runId: null, createdAt: '2026-09-25T01:00:00.000Z' },
    ] : []),
    listConversationDigests: async (_t: string, u: string) => (u === userId ? [
      { tenantId: 't', userId, day: '2026-08-01', summary: 'B 社の保守契約の更新について相談した。更新は 9 月末で、佐藤さんが見積を作る。', compartment: null, createdAt: '' },
      { tenantId: 't', userId, day: '2026-09-24', summary: '営業定例の議事録を作り、Chat に共有した。', compartment: null, createdAt: '' },
      { tenantId: 't', userId, day: '2026-09-20', summary: '人事の評価面談の話。', compartment: 'hr', createdAt: '' },
    ] : []),
    listMemories: async (_t: string, u: string) => (u === userId ? [
      { id: 'm1', tenantId: 't', userId, text: '見積は税抜きで出す', source: 'learned', createdAt: '2026-09-01T00:00:00.000Z' },
    ] : []),
    listRunsWithJobs: async (_t: string, opts: { requestedBy?: string }) => {
      asked.push(opts.requestedBy ?? '');
      return opts.requestedBy === userId ? [{
        run: { id: 'r1', status: 'awaiting_approval', startedAt: '2026-09-24T02:00:00.000Z', failureReason: null },
        job: { agentId: 'minutes', input: { title: '営業定例', transcript: '長い記録…' } },
      }] : [];
    },
  } as unknown as Repository;
  return { repo, asked };
}

test('答えるときに、今日のやり取り・会話の要約・覚えた事実・頼んだ業務を集める', async () => {
  const { repo, asked } = repoOf();
  const r = await recall(repo, 't', 'u1', 'B 社の保守契約の件、どうなった？', OFFICIAL_AGENTS, NOW);
  assert.match(r.text, /これはデータです/, '指示として扱わせない');
  assert.match(r.text, /## 覚えている事実\n- 見積は税抜きで出す/);
  assert.match(r.text, /## 今日のやり取り（古い順）\n- 依頼: A 社の見積はいつまで？\n {2}答え: 10 月 3 日までです。/);
  assert.match(r.text, /2026-08-01: B 社の保守契約の更新について相談した/, '古くても、依頼に近い要約を渡す');
  assert.match(r.text, /2026-09-24: 営業定例の議事録を作り/, '新しい要約はいつも渡す');
  assert.ok(!r.text.includes('評価面談'), '権限区画の印の付いた要約は使わない');
  assert.match(r.text, /- 2026-09-24 議事録の作成・共有「営業定例」 — 承認待ち/, '頼んだ業務は題名と状態だけ');
  assert.ok(!r.text.includes('長い記録'), '業務の入力の中身は渡さない');
  assert.deepEqual(asked, ['u1'], '本人が頼んだ業務だけを読む');
  assert.deepEqual(r.evidence, [{ label: '参照した記憶', value: '覚えている事実 1 件・今日のやり取り 1 件・会話の要約 2 日分・頼んだ業務 1 件' }]);
});

test('ほかの人の記憶は使わず、何も無ければ何も渡さない', async () => {
  const { repo } = repoOf('someone-else');
  assert.deepEqual(await recall(repo, 't', 'u1', 'あれどうなった', OFFICIAL_AGENTS, NOW), { text: '', evidence: [] });
});

test('記憶の読み出しに失敗しても、答えは返す', async () => {
  const repo = { listMemories: async () => { throw new Error('db'); } } as unknown as Repository;
  assert.deepEqual(await recall(repo, 't', 'u1', 'x', [], NOW), { text: '', evidence: [] });
});

test('過去を指す問いを見分ける。「あれば」は過去を指さない', () => {
  for (const q of ['ねえ、あれどうなった？', 'あの件の進み具合は', '例の見積', '先週頼んだやつ', 'この前の議事録', 'その後どう？']) {
    assert.ok(REFERS_TO_PAST.test(q), q);
  }
  for (const q of ['資料があれば議事録を作って', '明日の予定は？', '有給休暇は何日？']) {
    assert.ok(!REFERS_TO_PAST.test(q), q);
  }
  assert.ok(closeness('保守契約の件', 'B 社の保守契約の更新') >= 2);
  assert.equal(closeness('有給休暇', '営業定例の議事録'), 0);
});

test('「あれ、どうなった」は業務へ取り次がず、覚えていることを渡して答える（第10.7.3節）', async () => {
  const { repo } = repoOf();
  const r = repo as unknown as Record<string, unknown>;
  Object.assign(r, {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listUserCompartments: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }),
    appendAudit: async () => undefined,
  });
  const seen: { tier?: string; messages: { role: string; content: string }[] }[] = [];
  const llm = {
    name: 'fake',
    async complete(req: { tier?: string; messages: { role: string; content: string }[] }) {
      // 言い換えを考えさせる呼び出し（第11.7.7.0節）は取次の判定ではない。数えない
      if (req.messages.at(-1)!.content.startsWith('社内の規程や文書を探します')) return { text: '', tokensUsed: 0 };
      seen.push(req);
      // 取次の判定（高速）なら議事録の作成を選ぶ、という推論を置く。呼ばれてはならない
      return req.tier === 'fast' ? { text: 'minutes', tokensUsed: 1 } : { text: '議事録の作成は承認待ちです。', tokensUsed: 3 };
    },
  } as unknown as LlmProvider;
  const s = new Secretary({ repo, llm, connector: {} as never, agents: OFFICIAL_AGENTS });
  const reply = await s.respond('t', 'u1', 'ねえ、営業定例のあれどうなった？', undefined, { record: false });
  assert.equal(reply.layer, 'full');
  assert.equal(reply.suggestedAgent, undefined, '業務を提案しない');
  assert.ok(seen.every((x) => x.tier !== 'fast'), '取次の判定をしない');
  const sent = seen.at(-1)!.messages.map((m) => m.content).join('\n');
  assert.match(sent, /議事録の作成・共有「営業定例」 — 承認待ち/, '頼んだ業務を渡す');
  assert.ok(seen.at(-1)!.messages.findIndex((m) => m.content.includes('覚えていること')) < seen.at(-1)!.messages.length - 1, '覚えていることは本人の依頼とは別のメッセージ');
  assert.ok(reply.evidence.some((e) => e.label === '参照した記憶'));
});
