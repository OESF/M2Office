/**
 * @file 案件とメールのカテゴリーを結ぶ（仕様書 第11.13.8節、ADR-0135。秘書の成長 段 5）の単体テスト。
 *
 * 案件ノートの材料にするメールの動き（件名と一言だけ・宣伝は渡さない）、推論の答えの結び（1 つのカテゴリーは 1 つの案件だけ）、
 * メールだけで進む案件、秘書の答えに添えるいまのメールの数、会話での結びの直し、「〇〇の件は終わった」で両方を終えること、
 * カテゴリーの名前を案件の題名にそろえる決まり、頼みの見分けを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS } from '@m2office/shared';
import {
  CaseNoteBuilder, MailService, MailWatch, MemoryMailStore, MockWorkspaceConnector, caseMailLine, caseMailMaterial, categoryRule,
  mailCategoryText, mailCommand, parseCasePlan, recall, type CaseNote, type LlmProvider, type LlmRequest, type MailThreadRow, type Repository,
} from '../src/index.js';

const T = 't-case';
const U = 'u-case';
const o = { tenantId: T, userId: U };
const NOW = new Date('2026-11-11T01:00:00.000Z'); // 日本時間 10 時

const thread = (id: string, categoryId: string | null, over: Partial<MailThreadRow> = {}): MailThreadRow => ({
  threadId: id, group: 'reply', state: 'open', doneReason: null, doneAt: null, lastMessageId: id, replyToId: id,
  from: '山田 <yamada@mihon.example.jp>', subject: `見積の件 ${id}`, summary: '見積の金額を確かめたい', dueText: '', dueDate: null,
  lastAt: '2026-11-10T03:00:00.000Z', sentAt: null, sentTo: '', recipients: { to: [], cc: [] }, draftState: 'none', draft: '',
  outgoing: null, sendRunId: null, notifiedAt: null, categoryId, updatedAt: '', ...over,
});

const note = (id: string, title: string, over: Partial<CaseNote> = {}): CaseNote => ({
  id, tenantId: T, userId: U, title, state: '進めている', nextStep: '', dueOn: null, status: 'open', lastDay: '2026-11-01', createdAt: '', updatedAt: '', ...over,
});

/** 案件ノートを持つ偽の置き場。 */
function fakeRepo(notes: CaseNote[], material: { digests?: boolean } = {}) {
  const counts: string[] = [];
  const repo = {
    getUserSettings: async () => DEFAULT_USER_SETTINGS,
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    findUserById: async () => ({ id: U, tenantId: T, email: 'me@example.jp', displayName: '本人', status: 'active', roles: ['member'] }),
    getGoogleConnection: async () => null,
    getCaseNoteRun: async () => null, setCaseNoteRun: async () => undefined,
    listConversationDigests: async () => material.digests ? [{ tenantId: T, userId: U, day: '2026-11-10', summary: '見本商事の見積を作った', compartment: null, createdAt: '' }] : [],
    listRunsWithJobs: async () => [], closeIdleCaseNotes: async () => 0, appendAudit: async () => undefined,
    listCaseNotes: async () => notes.filter((n) => n.status === 'open'),
    saveCaseNote: async (n: CaseNote) => { const i = notes.findIndex((x) => x.id === n.id); if (i >= 0) notes[i] = n; else notes.push(n); },
    addLearningCount: async (_t: string, _u: string, _w: string, kind: string) => { counts.push(kind); },
  };
  return { repo: repo as unknown as Repository, counts };
}

/** 決まった答えを返す推論。 */
function llmOf(answer: unknown, prompts: string[] = []): LlmProvider {
  return { name: 'test', complete: async (req: LlmRequest) => { prompts.push(req.messages.map((m) => m.content).join('\n')); return { text: JSON.stringify(answer), tokensUsed: 1 }; } };
}

async function mailSetup(notes: CaseNote[], llm: LlmProvider | null = null) {
  const { repo, counts } = fakeRepo(notes);
  const store = new MemoryMailStore();
  const connector = new MockWorkspaceConnector(() => NOW);
  const watch = new MailWatch({ store, repo, mail: connector.mail, llmFor: async () => llm!, isMock: () => true });
  const service = new MailService({ store, repo, mail: connector.mail, watch, llmFor: async () => llm });
  await store.saveCategory(o, { id: 'mc-mihon', name: '見本商事', note: '', lastAt: '2026-11-10T03:00:00.000Z', endedAt: null, seen: 3 });
  await store.saveCategory(o, { id: 'mc-shop', name: '新店舗', note: '', lastAt: '2026-11-09T03:00:00.000Z', endedAt: null, seen: 2 });
  return { store, service, counts };
}

test('案件ノートの材料: カテゴリーごとに数と件名・一言だけをまとめ、宣伝とカテゴリーの無いメールは渡さない', () => {
  const cats = [{ id: 'a', name: '見本商事', note: '', lastAt: '', endedAt: null, seen: 3 }, { id: 'b', name: '新店舗', note: '', lastAt: '', endedAt: null, seen: 2 }];
  const m = caseMailMaterial(cats, [
    thread('1', 'a'), thread('2', 'a', { group: 'waiting', lastAt: '2026-11-10T05:00:00.000Z' }), thread('3', 'a', { state: 'done' }),
    thread('4', 'b', { group: 'promo' }), thread('5', null),
  ]);
  assert.deepEqual(m.map((x) => [x.name, x.threads, x.counts]), [['見本商事', 3, { reply: 1, action: 0, waiting: 1, read: 0 }]]);
  assert.equal(m[0]!.samples[0]!.subject, '見積の件 2', '新しいものから');
  assert.ok(m[0]!.samples.every((s) => s.subject.length <= 60 && s.summary.length <= 60));
});

test('推論の答えの結び: 範囲の外の番号は捨て、同じカテゴリーは先に答えた案件だけに結ぶ', () => {
  const p = parseCasePlan(JSON.stringify({
    update: [{ n: 1, state: 'x', mail: 1 }, { n: 2, state: 'y', mail: 1 }],
    create: [{ title: '新店舗の内装', state: '', next: '', lastDay: '2026-11-10', mail: 2, onlyMail: true }, { title: 'Z', lastDay: '2026-11-10', mail: 9, onlyMail: true }],
  }), 2, 2);
  assert.equal(p.update[0]!.mail, 1);
  assert.equal(p.update[1]!.mail, undefined, '同じカテゴリーは 1 つの案件にだけ');
  assert.deepEqual(p.create.map((c) => [c.mail, c.onlyMail]), [[2, true], [null, false]], '範囲の外は結ばず、メールだけの印も付けない');
});

test('案件ノートを作る: メールの動きを材料に渡して結ぶ。会話の材料が無ければ、メールだけから作った印を付ける。結びを取られた案件は外す', async () => {
  const notes = [note('c1', '見本商事の見積', { mailCategoryId: 'mc-shop' }), note('c2', '値上げの検討')];
  const { repo } = fakeRepo(notes);
  const store = new MemoryMailStore();
  await store.saveCategory(o, { id: 'mc-mihon', name: '見本商事', note: '', lastAt: '', endedAt: null, seen: 3 });
  await store.saveCategory(o, { id: 'mc-shop', name: '新店舗', note: '', lastAt: '', endedAt: null, seen: 2 });
  await store.saveThread(o, thread('a1', 'mc-mihon'));
  await store.saveThread(o, thread('b1', 'mc-shop', { subject: '内装の見積', lastAt: '2026-11-10T04:00:00.000Z' }));
  const prompts: string[] = [];
  const llm = llmOf({
    update: [{ n: 1, state: '金額の確認を待つ', mail: 2 }],
    create: [{ title: '新店舗の内装', state: '内装の見積が届いた', next: '比べる', due: null, lastDay: '2026-11-10', mail: 1, onlyMail: true }],
  }, prompts);
  const b = new CaseNoteBuilder({ repo, llmFor: async () => llm, agentName: async () => '', mail: { store } });
  assert.deepEqual(await b.buildIfDue(T, U, llm, NOW), { created: 1, updated: 1, closed: 0 });
  assert.match(prompts[0]!, /M1\. 〔新店舗〕1 件/);
  assert.match(prompts[0]!, /件名: 見積の件 a1／一言: 見積の金額を確かめたい/);
  assert.match(prompts[0]!, /結んだメール: 〔新店舗〕/);
  assert.equal(notes.find((n) => n.id === 'c1')!.mailCategoryId, 'mc-mihon');
  const made = notes.find((n) => n.title === '新店舗の内装')!;
  assert.equal(made.mailCategoryId, 'mc-shop', '新店舗は新しい案件に結び直す');
  assert.equal(made.mailOnly, true);
});

test('会話の材料があるときにできた案件は、推論が言わない限りメールだけの印を付けない。材料が何も無ければ作らない', async () => {
  const notes: CaseNote[] = [];
  const { repo } = fakeRepo(notes, { digests: true });
  const store = new MemoryMailStore();
  await store.saveCategory(o, { id: 'mc-mihon', name: '見本商事', note: '', lastAt: '', endedAt: null, seen: 3 });
  await store.saveThread(o, thread('a1', 'mc-mihon'));
  const llm = llmOf({ update: [], create: [{ title: '見本商事の見積', state: '', next: '', lastDay: '2026-11-10', mail: 1, onlyMail: false }] });
  await new CaseNoteBuilder({ repo, llmFor: async () => llm, agentName: async () => '', mail: { store } }).buildIfDue(T, U, llm, NOW);
  assert.equal(notes[0]!.mailOnly, false);
  const empty = fakeRepo([]);
  let called = false;
  const none: LlmProvider = { name: 'test', complete: async () => { called = true; return { text: '{}', tokensUsed: 0 }; } };
  await new CaseNoteBuilder({ repo: empty.repo, llmFor: async () => none, agentName: async () => '', mail: { store: new MemoryMailStore() } }).buildIfDue(T, U, none, NOW);
  assert.equal(called, false);
});

test('秘書の答え: 結んだ案件に、いまのメールの数を添える。「〇〇の件でメール来てる？」には案件の次にやることを添える', async () => {
  const notes = [note('c1', '見本商事の見積', { mailCategoryId: 'mc-mihon', nextStep: '金額を直して送る', dueOn: '2026-11-14' })];
  const { store, service } = await mailSetup(notes);
  await store.saveThread(o, thread('a1', 'mc-mihon'));
  await store.saveThread(o, thread('a2', 'mc-mihon', { group: 'waiting' }));
  await store.saveThread(o, thread('a3', 'mc-mihon', { state: 'done' }));
  const counts = await service.caseMail(o, ['mc-mihon']);
  assert.equal(caseMailLine(counts.get('mc-mihon')!), 'メール〔見本商事〕: 返事が要る 1・返事待ち 1／最後に動いた日 2026-11-10');
  const repo = {
    listConversationsOfDay: async () => [], listConversationDigests: async () => [], listRunsWithJobs: async () => [], listMemories: async () => [],
    getUserProfile: async () => null, getUserSettings: async () => DEFAULT_USER_SETTINGS, touchMemories: async () => undefined,
    listCaseNotes: async () => notes,
  } as unknown as Repository;
  const r = await recall(repo, T, U, '見本商事の件どうなった？', [], NOW, { caseMail: (ids) => service.caseMail(o, ids) });
  assert.match(r.text, /〔見本商事の見積〕[^\n]*\n {2}メール〔見本商事〕: 返事が要る 1・返事待ち 1/);
  const found = await service.findByCategory(o, '見本商事', NOW);
  assert.equal(found.case?.title, '見本商事の見積');
  assert.match(mailCategoryText('見本商事', found.category, found.items, found.case), /案件「見本商事の見積」の次にやること: 金額を直して送る（期限 2026-11-14）/);
});

test('会話で結びを直す: 別の案件に入れる・外す。1 つのカテゴリーは 1 つの案件にだけ。直しとして数える', async () => {
  const notes = [note('c1', '見本商事の見積', { mailCategoryId: 'mc-mihon' }), note('c2', '見本商事の保守契約')];
  const llm = llmOf({ link: [{ case: '見本商事の保守契約', category: '見本商事' }], reply: '保守契約の案件に入れました。' });
  const { service, counts } = await mailSetup(notes, llm);
  const r = await service.categoryRequest(o, '見本商事のメールは保守契約の案件に入れて', NOW);
  assert.match(r.text, /保守契約の案件に入れました/);
  assert.equal(notes.find((n) => n.id === 'c2')!.mailCategoryId, 'mc-mihon');
  assert.equal(notes.find((n) => n.id === 'c1')!.mailCategoryId, null, '前の案件からは外す');
  assert.deepEqual(counts, ['conversation']);
  const off = await mailSetup(notes, llmOf({ link: [{ case: '見本商事の保守契約', category: '' }], reply: '外しました。' }));
  await off.service.categoryRequest(o, '見本商事のメールは保守契約の件とは別', NOW);
  assert.equal(notes.find((n) => n.id === 'c2')!.mailCategoryId, null);
});

test('「〇〇の件は終わった」: カテゴリーと結んだ案件の両方を終える。「返事した」では案件を終えない', async () => {
  const notes = [note('c1', '見本商事の見積', { mailCategoryId: 'mc-mihon' }), note('c2', '値上げの検討')];
  const { store, service } = await mailSetup(notes);
  assert.equal(await service.endCategory(o, '見本商事', NOW, true), '見本商事');
  assert.equal(notes.find((n) => n.id === 'c1')!.status, 'closed');
  assert.ok((await store.categories(o)).find((c) => c.id === 'mc-mihon')!.endedAt);
  assert.equal(await service.endCategory(o, '値上げ', NOW, false), null, '「返事した」では、題名だけで案件を終えない');
  assert.equal(await service.endCategory(o, '値上げ', NOW, true), '値上げの検討');
  assert.equal(notes.find((n) => n.id === 'c2')!.status, 'closed');
});

test('頼みの見分けと、カテゴリーの名前を案件の題名にそろえる決まり', () => {
  for (const m of ['見本商事のメールは見積の件とは別', '新店舗の件のメールは内装の案件に入れて']) assert.equal(mailCommand(m)?.kind, 'teach', m);
  assert.deepEqual(mailCommand('補助金の件はもう終わった'), { kind: 'done', words: '補助金', finished: true });
  assert.deepEqual(mailCommand('見本商事の件は返事した'), { kind: 'done', words: '見本商事', finished: false });
  const rule = categoryRule([], [], ['新店舗の内装']);
  assert.match(rule, /本人の進んでいる案件: 「新店舗の内装」/);
  assert.ok(!categoryRule([], []).includes('進んでいる案件'), '案件が無ければ足さない');
});

test('メールの一覧を消すと、案件ノートの結びを外し、メールだけから作った案件ノートを消す（置き場の決まり）', async () => {
  // PostgreSQL の置き場の SQL は移行の確かめ（npm run smoke）で通す。ここでは記憶の置き場が案件ノートを持たないことだけを確かめる
  const store = new MemoryMailStore();
  await store.saveThread(o, thread('a1', 'mc-mihon'));
  await store.purgeUser(o);
  assert.equal((await store.categorizedSince(o, '2000-01-01T00:00:00.000Z')).length, 0);
});
