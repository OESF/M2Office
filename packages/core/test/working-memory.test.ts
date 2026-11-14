/**
 * @file 秘書の作業の記憶（いまの状況と 1 週間の記憶）の単体テスト（仕様書 第10.7.4節、ADR-0147）。
 *
 * 日付で振り返ること・道具の結果から話に出たものを拾うこと・使った日の 7 日分・長さの上限・
 * 続きの頼みを決め打ちの照会に当てないこと・業務を選ぶ推論と業務への依頼に状況を渡すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DAY_RECORD_MAX, MEMORY_BUDGET, OFFICIAL_AGENTS, Secretary, delegateContext, followsUp, loadWorkingMemory, mentionsFromTools,
  referredDays, routeSituation, situationText, weekText, type Conversation, type LlmProvider, type Repository,
} from '../src/index.js';

// 2026-11-16 は月曜日。日本時間の 15 時
const MONDAY = new Date('2026-11-16T06:00:00Z');
const WEDNESDAY = new Date('2026-11-18T06:00:00Z');

test('referredDays: 曜日・昨日・先週の金曜・〇日前・月日を日付に直す。これからの日は含めない', () => {
  assert.deepEqual(referredDays('月曜日に頼んだ仕事はどうなった', WEDNESDAY), ['2026-11-16']);
  assert.deepEqual(referredDays('月曜日に頼んだ仕事', MONDAY), ['2026-11-16'], '月曜日に言えば今日');
  assert.deepEqual(referredDays('昨日の午後の見積の件', WEDNESDAY), ['2026-11-17']);
  assert.deepEqual(referredDays('おとといのメール', WEDNESDAY), ['2026-11-16']);
  assert.deepEqual(referredDays('先週の金曜に話した件', WEDNESDAY), ['2026-11-13']);
  assert.deepEqual(referredDays('3日前に探した資料', WEDNESDAY), ['2026-11-15']);
  assert.deepEqual(referredDays('11月10日の打ち合わせのメモ', WEDNESDAY), ['2026-11-10']);
  assert.deepEqual(referredDays('12月20日の件', WEDNESDAY), ['2025-12-20'], 'これからの月日は去年のものとして読む');
  assert.deepEqual(referredDays('来週の月曜に会議を入れて', WEDNESDAY), []);
  assert.deepEqual(referredDays('次の金曜までに出して', WEDNESDAY), []);
  assert.deepEqual(referredDays('見積を作って', WEDNESDAY), []);
});

test('followsUp: 続きの頼みを見分ける。「それぞれ」や、ふつうの照会は続きにしない', () => {
  for (const m of ['それも探して', 'さっきのメールを開いて', '先ほどの資料をもう一度', 'あの件どうなった', 'この資料の要点は？', '同じように〇〇社のも',
    '月曜日に頼んだ仕事は', '昨日の見積はどうなった', 'もう1件探して', 'ほかにもある？', '〇〇社のも探して', 'そのメールを開きたい']) {
    assert.equal(followsUp(m), true, m);
  }
  for (const m of ['今日の予定は？', '未読のメールは？', 'それぞれ頼んで', '来週の月曜に会議を入れて', '見積を作って']) {
    assert.equal(followsUp(m), false, m);
  }
});

test('mentionsFromTools: メール・資料・ドライブの結果から、題名・ID・リンクを拾う。推論の文からは作らない', () => {
  const got = mentionsFromTools([
    { name: 'gmail.search', result: { items: [{ id: 'm1', threadId: 't1', subject: '見積のご確認', from: '見本商事 <a@example.com>', date: '2026-11-14T01:00:00Z', url: 'https://mail.google.com/mail/?authuser=x#all/t1' }] } },
    { name: 'library.search', result: { available: true, items: [{ id: 'L1', title: '保守契約書', path: '/library/L1', url: 'https://drive.example/1' }] } },
    { name: 'drive.search', result: { items: [{ id: 'd1', name: '議事録', url: 'https://docs.example/d1' }] } },
    { name: 'web.research', result: { text: '外の情報' } },
    { name: 'gmail.search', error: '失敗' },
  ]);
  assert.deepEqual(got, [
    { kind: 'mail', title: '見積のご確認（見本商事 <a@example.com>、2026-11-14）', id: 't1', url: 'https://mail.google.com/mail/?authuser=x#all/t1' },
    { kind: 'library', title: '保守契約書', id: 'L1', url: '/library/L1' },
    { kind: 'drive', title: '議事録', id: 'd1', url: 'https://docs.example/d1' },
  ]);
});

/** 会話ログと要約と実行の記録を持つ、見本の永続化層。 */
function memoryRepo(rows: Conversation[], digests: { day: string; summary: string }[] = [], runs: { id: string; agentId: string; startedAt: string; request: string }[] = []) {
  const dayOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
  return {
    listConversationsOfDay: async (_t: string, _u: string, d: { from: string; to: string }) => rows.filter((c) => c.createdAt >= d.from && c.createdAt < d.to),
    listConversationDays: async (_t: string, _u: string, since: string) => [...new Set(rows.filter((c) => c.createdAt >= since).map((c) => dayOf(c.createdAt)))].sort().reverse(),
    listConversationsBetween: async (_t: string, _u: string, from: string, to: string) => rows.filter((c) => c.createdAt >= from && c.createdAt < to),
    listConversationDigests: async () => digests.map((d) => ({ ...d, tenantId: 't', userId: 'u', compartment: null, createdAt: '' })),
    listRunsWithJobs: async () => runs.map((r) => ({
      run: { id: r.id, status: 'completed', startedAt: r.startedAt, endedAt: r.startedAt },
      job: { agentId: r.agentId, input: { request: r.request } },
    })).reverse(),
  } as unknown as Repository;
}

const turn = (createdAt: string, message: string, reply: string, mentions?: Conversation['mentions']): Conversation => ({
  id: createdAt, tenantId: 't', userId: 'u', message, reply, layer: 'full', agentId: null, runId: null, createdAt, ...(mentions ? { mentions } : {}),
});

test('loadWorkingMemory: 使った日の 7 日分を持ち、休みの日は数えない。指している日を先に渡す', async () => {
  // 使った日は 9 日（11/2〜11/14 のうち、土日を除く）。今日は 11/18（水）
  const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
  const rows = days.map((d) => turn(`${d}T01:00:00.000Z`, `${d} の依頼`, `${d} の答え`));
  const repo = memoryRepo(rows, [{ day: '2026-11-16', summary: '月曜日: 見本商事への見積を調べものに頼んだ' }],
    [{ id: 'r1', agentId: 'secretary-lookup', startedAt: '2026-11-16T02:00:00.000Z', request: '見本商事の見積を探して' }]);
  const agents = OFFICIAL_AGENTS.filter((a) => a.id === 'secretary-lookup');
  const m = await loadWorkingMemory(repo, 't', 'u', '月曜日に頼んだ仕事はどうなった？', agents, { now: WEDNESDAY, keep: true });
  assert.deepEqual(m.week.map((d) => d.day), ['2026-11-17', '2026-11-16', '2026-11-13', '2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09']);
  assert.deepEqual(m.referred, ['2026-11-16']);
  const monday = m.week.find((d) => d.day === '2026-11-16')!;
  assert.match(monday.runs[0]!, /調べもの「見本商事の見積を探して」 — 完了/);
  const text = weekText(m, 9_000);
  assert.ok(text.indexOf('2026-11-16（月）← 依頼が指している日') < text.indexOf('2026-11-17（火）'), '指している日を先に');
  assert.match(text, /月曜日: 見本商事への見積を調べものに頼んだ/);
  // 今日のやり取りが無いので、前に使った日（11/17）の終わりを続きとして持つ
  assert.equal(m.continuedFrom, '2026-11-17');
  assert.match(situationText(m, 7_000), /前に使った日 2026-11-17 の続き/);
});

test('loadWorkingMemory: 7 日より前でも、28 日の内で話した日を指せば、その日を入れる', async () => {
  const days = ['2026-10-30', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
  const rows = days.map((d) => turn(`${d}T01:00:00.000Z`, `${d} の依頼`, `${d} の答え`));
  const m = await loadWorkingMemory(memoryRepo(rows), 't', 'u', '10月30日に頼んだ件', [], { now: WEDNESDAY, keep: true });
  assert.ok(m.week.some((d) => d.day === '2026-10-30'));
  assert.equal(m.week.length, 8);
});

test('話に出たものは新しい順に持ち、最後に頼んだ業務が分かる。開いている 1 件も先頭に入る', async () => {
  const rows = [
    turn('2026-11-18T01:00:00.000Z', '見本商事のメールを探して', 'お調べします。', [{ kind: 'run', title: '調べもの「見本商事のメールを探して」', id: 'r1', url: '/runs/r1' }]),
    turn('2026-11-18T01:05:00.000Z', '（お調べした結果）見本商事のメールを探して', '2 通ありました', [{ kind: 'mail', title: '見積のご確認', id: 't1', url: 'https://mail.example/t1' }]),
  ];
  const m = await loadWorkingMemory(memoryRepo(rows), 't', 'u', 'さっきのメールを開いて', [], {
    now: WEDNESDAY, keep: true, screen: { view: 'library', label: 'ナレッジの整理', item: { kind: '資料', id: 'L9', title: '保守契約書' } },
  });
  assert.deepEqual(m.mentions.map((x) => x.kind), ['screen', 'mail', 'run']);
  assert.equal(m.lastWork?.id, 'r1');
  const text = situationText(m, 7_000);
  assert.match(text, /開いている画面: ナレッジの整理。開いている 1 件: 資料「保守契約書」（ID: L9）/);
  assert.match(text, /\[メール\] 見積のご確認（ID: t1） https:\/\/mail\.example\/t1/);
  assert.match(text, /最後に頼んだ業務: 調べもの「見本商事のメールを探して」/);
});

test('会話を残さない人は、その日のやり取りだけを持ち、1 週間の記憶は作らない（Q-366）', async () => {
  const repo = memoryRepo([turn('2026-11-17T01:00:00.000Z', '昨日の依頼', '昨日の答え')]);
  const m = await loadWorkingMemory(repo, 't', 'u', '昨日の件', [], {
    now: WEDNESDAY, keep: false, transient: [turn('2026-11-17T10:00:00.000Z', '前の日', 'x'), turn('2026-11-18T01:00:00.000Z', '今日の依頼', '今日の答え')],
  });
  assert.deepEqual(m.turns.map((c) => c.message), ['今日の依頼']);
  assert.deepEqual(m.week, []);
});

test('長さの上限: 層 2 は 2,000 字、業務への依頼は 6,000 字、1 日の記録は 4,000 字に収める。新しいやり取りは残す', async () => {
  const long = 'あ'.repeat(3_000);
  const today = Array.from({ length: 40 }, (_, i) => turn(`2026-11-18T0${Math.floor(i / 10)}:${String((i % 10) * 5).padStart(2, '0')}:00.000Z`, `依頼${i} ${long}`, `答え${i} ${long}`,
    [{ kind: 'mail', title: `メール${i}`, id: `t${i}`, url: `https://mail.example/${i}` }]));
  const monday = Array.from({ length: 60 }, (_, i) => turn(`2026-11-16T0${Math.floor(i / 10)}:${String((i % 10) * 5).padStart(2, '0')}:00.000Z`, `月曜の依頼${i} ${long}`, `月曜の答え${i} ${long}`));
  const m = await loadWorkingMemory(memoryRepo([...monday, ...today], [{ day: '2026-11-18', summary: long }]), 't', 'u', '月曜日の件の続き', [], { now: WEDNESDAY, keep: true });
  const route = routeSituation(m);
  assert.ok(route.length <= MEMORY_BUDGET.route, `層 2: ${route.length}`);
  assert.match(route, /依頼39/, '新しいやり取りは残す');
  const ctx = delegateContext(m);
  assert.ok(ctx.length <= MEMORY_BUDGET.delegate, `業務への依頼: ${ctx.length}`);
  assert.match(ctx, /2026-11-16（月）/, '指している日の記録も渡す');
  const week = weekText(m, 20_000);
  for (const part of week.split('\n### ').slice(1)) assert.ok(part.length <= DAY_RECORD_MAX + 4, `1 日: ${part.length}`);
  assert.ok(situationText(m, 7_000).length <= 7_000);
});

/** 推論の代わり。業務を選ぶ推論に渡したものを覚え、決めた答えを返す。 */
function llmSeeing(route: string) {
  const seen: { system: string; user: string[] }[] = [];
  return {
    name: 'fake', seen,
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? '';
      const last = String(req.messages.at(-1)?.content ?? '');
      if (last.startsWith('社内の規程や文書を探します')) return { text: '', tokensUsed: 0 };
      seen.push({ system, user: req.messages.slice(1).map((x) => String(x.content)) });
      if (system.startsWith('依頼に最も合う業務')) return { text: route, tokensUsed: 1 };
      return { text: 'わかりました', tokensUsed: 1 };
    },
  } as unknown as LlmProvider & { seen: { system: string; user: string[] }[] };
}

function secretaryRepo(rows: Conversation[], keep = true) {
  const appended: Conversation[] = [];
  const base = memoryRepo(rows) as unknown as Record<string, unknown>;
  const repo = {
    ...base,
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' }, automation: {} }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite' }, memory: { keepConversations: keep, learning: true }, profile: { timezone: 'Asia/Tokyo' } }),
    findUserById: async () => ({ id: 'u1', displayName: '三浦', roles: [] }),
    listMemories: async () => [],
    listUserCompartments: async () => [],
    listRoutingMemories: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }),
    appendAudit: async () => undefined,
    appendConversation: async (c: Conversation) => { appended.push(c); },
    countRequest: async () => undefined,
  } as unknown as Repository;
  return { repo, appended };
}

test('続きの頼みは、決め打ちの照会（予定の件数）に当てず、いまの状況を添えて業務を選ぶ', async () => {
  const now = new Date();
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const rows = [
    turn(at(10), '見本商事のメールを探して', 'お調べします。', [{ kind: 'run', title: '調べもの「見本商事のメールを探して」', id: 'r1', url: '/runs/r1' }]),
    turn(at(8), '（お調べした結果）見本商事のメールを探して', '2 通ありました', [{ kind: 'mail', title: '見積のご確認', id: 't1', url: 'https://mail.example/t1' }]),
  ];
  const { repo } = secretaryRepo(rows);
  const lookups: { request: string; context?: string }[] = [];
  const llm = llmSeeing('secretary-lookup');
  const s = new Secretary({
    repo, llm, connector: {} as never, agents: OFFICIAL_AGENTS.filter((a) => a.id === 'secretary-lookup'),
    startLookup: async (_t, _u, request, _f, context) => { lookups.push({ request, ...(context ? { context } : {}) }); return { runId: 'r2', already: false }; },
  });
  // 「予定」は決め打ちの予定の照会に当たる言葉。続きの頼みなので、話の流れで読む（予定の接続口を呼ばない）
  const reply = await s.respond('t', 'u1', 'さっきの会社との予定も探して');
  assert.equal(reply.layer, 'light', '決め打ちの照会（層 1）に当てない');
  assert.equal(lookups.length, 1);
  assert.match(lookups[0]!.context ?? '', /見積のご確認（ID: t1） https:\/\/mail\.example\/t1/, '業務への依頼に、話に出たものを渡す');
  assert.match(lookups[0]!.context ?? '', /最後に頼んだ業務: 調べもの「見本商事のメールを探して」/);
});

test('業務を選ぶ推論に、いまの状況（最後に頼んだ業務・開いている画面）を、依頼とは別のメッセージで渡す', async () => {
  const now = new Date();
  const rows = [turn(new Date(now.getTime() - 300_000).toISOString(), '見本商事の資料を探して', 'お調べします。', [{ kind: 'run', title: '調べもの「見本商事の資料を探して」', id: 'r1' }])];
  const { repo, appended } = secretaryRepo(rows);
  const llm = llmSeeing('secretary-lookup');
  const s = new Secretary({
    repo, llm, connector: {} as never, agents: OFFICIAL_AGENTS.filter((a) => a.id === 'secretary-lookup'),
    startLookup: async () => ({ runId: 'r2', already: false }),
  });
  await s.respond('t', 'u1', '試作社のも同じように', undefined, { screen: { view: 'library', label: 'ナレッジの整理', item: { kind: '資料', id: 'L1', title: '保守契約書' } } });
  const routing = llm.seen.find((x) => x.system.startsWith('依頼に最も合う業務'))!;
  assert.match(routing.system, /最後に頼んだ業務と同じ業務を選んで/);
  assert.equal(routing.user.length, 2, '状況と依頼を分けて渡す');
  assert.match(routing.user[0]!, /最後に頼んだ業務: 調べもの「見本商事の資料を探して」/);
  assert.match(routing.user[0]!, /開いている画面: ナレッジの整理。開いている 1 件: 資料「保守契約書」/);
  assert.equal(routing.user[1], '試作社のも同じように');
  // 頼んだ業務と開いていた 1 件を、話に出たものとして会話ログに残す
  assert.deepEqual(appended.at(-1)?.mentions?.map((x) => x.kind), ['run', 'screen']);
});

test('会話を残さない人でも、その日のうちは前のやり取りを覚えている（Q-366）', async () => {
  const { repo, appended } = secretaryRepo([], false);
  const llm = llmSeeing('none');
  const s = new Secretary({ repo, llm, connector: {} as never, agents: [] });
  await s.respond('t', 'u1', '来月の展示会の準備の段取りを相談したい');
  await s.respond('t', 'u1', 'さっきの件、もう少し詳しく');
  assert.equal(appended.length, 0, '会話ログには残さない');
  const answer = llm.seen.filter((x) => !x.system.startsWith('依頼に最も合う業務')).at(-1)!;
  assert.ok(answer.user.some((u) => u.includes('来月の展示会の準備の段取りを相談したい')), '層 3 に今日のやり取りを渡す');
});

test('続きの頼みでも、本人の指図（「さっきの会話は残さないで」）は決め打ちのまま当てる', async () => {
  const now = new Date();
  const { repo } = secretaryRepo([turn(new Date(now.getTime() - 60_000).toISOString(), '給与の相談', '…')]);
  let cleared = 0;
  (repo as unknown as { clearConversations: () => Promise<number> }).clearConversations = async () => { cleared++; return 1; };
  const s = new Secretary({ repo, llm: llmSeeing('none'), connector: {} as never, agents: [] });
  const reply = await s.respond('t', 'u1', 'さっきの会話は残さないで');
  assert.equal(reply.layer, 'direct');
  assert.equal(cleared, 1);
});

test('問題集（docs/evals/secretary-follow-up）: 続きの頼みは続きと見分け、新しい頼みは見分けない。曜日を指す頼みは日付に直す', () => {
  const doc = JSON.parse(readFileSync(new URL('../../../docs/evals/secretary-follow-up/cases.json', import.meta.url), 'utf8')) as {
    cases: { id: string; category: string; message: string; screen?: unknown }[];
  };
  assert.equal(doc.cases.length, 100);
  for (const c of doc.cases) {
    if (['A', 'B', 'C', 'D'].includes(c.category)) assert.equal(followsUp(c.message), true, `${c.id}: ${c.message}`);
    if (c.category === 'F') assert.equal(followsUp(c.message), false, `${c.id}: ${c.message}`);
    if (c.category === 'C') assert.equal(referredDays(c.message, WEDNESDAY).length, 1, `${c.id}: ${c.message}`);
  }
});
