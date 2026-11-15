/**
 * @file 会話の中の承認への、言葉での取りやめと直しの単体テスト（仕様書 第47.5節、ADR-0148）。
 *
 * 秘書に頼んだ業務が承認を待っている間に「やめて」と言えば却下し、「期限は来週にして」と言えば却下して直しを入れてやり直す。
 * 言葉では承認しないこと（Q-369）、関係の無い頼みを直しと取り違えないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_MODIFY, APPROVAL_STOP, OFFICIAL_AGENTS, Secretary, correctedRequest, type LlmProvider, type PendingTalkApproval, type Repository } from '../src/index.js';

const agent = OFFICIAL_AGENTS.find((a) => a.id === 'scheduling')!;

function world(opts: { correction?: boolean; route?: string; pendingAt?: string } = {}) {
  const rejected: { approvalId: string; comment: string }[] = [];
  const started: { agentId: string; input: Record<string, unknown> }[] = [];
  const pending: PendingTalkApproval[] = [{
    approvalId: 'ap1', runId: 'r1', agentId: agent.id, agentVersion: agent.version, agentName: agent.name,
    input: { request: '休診のお知らせを出して', title: '休診' }, summary: 'お知らせを公開します', createdAt: opts.pendingAt ?? new Date().toISOString(),
  }];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: false } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦' }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }), appendAudit: async () => undefined, appendConversation: async () => undefined,
  } as unknown as Repository;
  const llm = {
    name: 'fake',
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? '';
      if (system.includes('承認を待っています')) return { text: JSON.stringify({ correction: opts.correction ?? false }), tokensUsed: 1 };
      if (system.startsWith('依頼に最も合う業務')) return { text: opts.route ?? 'none', tokensUsed: 1 };
      return { text: 'わかりました', tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const s = new Secretary({
    repo, llm, connector: {} as never, agents: [agent],
    startAgent: async (_t, _u, a, input) => { started.push({ agentId: a.id, input }); return { runId: 'r2', already: false }; },
    approvals: {
      pending: async () => pending,
      reject: async (_t, _u, approvalId, comment) => { rejected.push({ approvalId, comment }); },
    },
  });
  return { s, rejected, started };
}

test('取りやめと直しの言い方', () => {
  for (const t of ['やめて', 'やっぱりやめて', '公開しないで', '中止して', 'キャンセルしてください']) assert.ok(APPROVAL_STOP.test(t), t);
  for (const t of ['会議をやめてもいいか教えて', 'やめておく理由は？']) assert.ok(!APPROVAL_STOP.test(t), t);
  for (const t of ['期限は来週にして', '題名を「休診のご案内」に変えて', 'ポップアップは外して']) assert.ok(APPROVAL_MODIFY.test(t), t);
  assert.deepEqual(correctedRequest({ request: 'お知らせを出して', title: 'x' }, '期限は来週にして'), { request: 'お知らせを出して\n\n直し: 期限は来週にして', title: 'x' });
});

test('「やめて」は、本人が判断する承認待ちを却下する（言葉の理由を残す）', async () => {
  const w = world();
  const reply = await w.s.respond('t', 'u1', 'やめて');
  assert.deepEqual(w.rejected, [{ approvalId: 'ap1', comment: 'やめて' }]);
  assert.match(reply.text, /取りやめました/);
  assert.equal(w.started.length, 0);
});

test('直しの頼みは、承認を却下して、もとの依頼に直しを足して同じ業務をやり直す', async () => {
  const w = world({ correction: true });
  const reply = await w.s.respond('t', 'u1', '期限は来週にして');
  assert.deepEqual(w.rejected, [{ approvalId: 'ap1', comment: '期限は来週にして' }]);
  assert.equal(w.started[0]?.agentId, agent.id);
  assert.equal(w.started[0]?.input['request'], '休診のお知らせを出して\n\n直し: 期限は来週にして');
  assert.match(reply.text, /もう一度/);
  assert.match(reply.text, /承認をお願いします/);
});

test('承認を待っている業務への直しでなければ、承認には触れず、ふだんの振り分けへ回す', async () => {
  const w = world({ correction: false });
  await w.s.respond('t', 'u1', '会議室を明日にして');
  assert.deepEqual(w.rejected, []);
});

test('言葉では承認しない（「お願い」「いいよ」では何も判断しない）', async () => {
  const w = world({ correction: false });
  await w.s.respond('t', 'u1', 'いいよ、お願い');
  assert.deepEqual(w.rejected, []);
  assert.equal(w.started.length, 0);
});

test('古い承認待ち（12 時間より前）は、会話の続きとはみなさない', async () => {
  const w = world({ pendingAt: new Date(Date.now() - 13 * 3_600_000).toISOString() });
  await w.s.respond('t', 'u1', 'やめて');
  assert.deepEqual(w.rejected, []);
});
