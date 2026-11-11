/**
 * @file 機能ごとの学びを秘書の目に入れる（仕様書 第11.13.9節、ADR-0136。秘書の成長 段 6）の単体テスト。
 *
 * 本人の像の材料（メールで覚えた相手・よくやり取りする相手・カテゴリー・進んでいる案件・関心の分野。件名は渡さない）、
 * メールで直したときの作り直し、答えるときに渡す相手（依頼に出てくる相手と「大事」と直した相手）、覚えることを止めた人を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type UserSettings } from '@m2office/shared';
import {
  MemoryMailStore, ProfileBuilder, lessonId, mailDisplayName, mailPeopleFor, profileMailMaterial, recall,
  type LlmProvider, type LlmRequest, type MailLessonRow, type MailThreadRow, type Memory, type Repository, type UserProfile,
} from '../src/index.js';

const T = 't-feat';
const U = 'u-feat';
const o = { tenantId: T, userId: U };
const NOW = new Date('2026-11-11T01:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const thread = (id: string, from: string, over: Partial<MailThreadRow> = {}): MailThreadRow => ({
  threadId: id, group: 'reply', state: 'open', doneReason: null, doneAt: null, lastMessageId: id, replyToId: id,
  from, subject: `秘密の件名 ${id}`, summary: '秘密の一言', dueText: '', dueDate: null,
  lastAt: day(1), sentAt: null, sentTo: '', recipients: { to: [], cc: [] }, draftState: 'none', draft: '',
  outgoing: null, sendRunId: null, notifiedAt: null, categoryId: null, updatedAt: '', ...over,
});

const lesson = (keyValue: string, target: string, source: 'told' | 'behavior', over: Partial<MailLessonRow> = {}): MailLessonRow => ({
  id: lessonId('group', 'from', keyValue, target, source), kind: 'group', keyType: 'from', keyValue, target, source, subject: '',
  hits: source === 'behavior' ? [day(1), day(2), day(3)] : [], firstAt: day(5), lastAt: day(5), usedAt: day(5), ...over,
});

/** 山田さん（大事と直した）・佐藤さん（ふだんの扱いで返事は要らない）・鈴木さん（1 回だけ。まだ傾向でない）の置き場。 */
async function mailStore() {
  const store = new MemoryMailStore();
  await store.saveThread(o, thread('a1', '山田 太郎 <yamada@client.example.jp>'));
  await store.saveThread(o, thread('a2', '山田 太郎 <yamada@client.example.jp>', { state: 'done' }));
  await store.saveThread(o, thread('a3', '佐藤 花子 <sato@shop.example.jp>', { group: 'read' }));
  await store.saveThread(o, thread('a4', 'news@ads.example.com', { group: 'promo' }));
  await store.saveThread(o, thread('a5', '昔の人 <old@x.example.jp>', { lastAt: day(40) }));
  await store.saveLesson(o, lesson('yamada@client.example.jp', 'important', 'told'));
  await store.saveLesson(o, lesson('sato@shop.example.jp', 'read', 'behavior'));
  await store.saveLesson(o, lesson('suzuki@x.example.jp', 'reply', 'behavior', { hits: [day(1)] }));
  await store.saveLesson(o, { ...lesson('yamada@client.example.jp', '採用', 'told'), id: 'cat', kind: 'category' });
  await store.saveCategory(o, { id: 'mc-1', name: '店舗の改装', note: '', lastAt: day(2), endedAt: null, seen: 3 });
  await store.saveCategory(o, { id: 'mc-2', name: '1 通だけ', note: '', lastAt: day(2), endedAt: null, seen: 1 });
  return store;
}

test('差出人の表示名を取り出す', () => {
  assert.equal(mailDisplayName('"山田 太郎" <yamada@client.example.jp>'), '山田 太郎');
  assert.equal(mailDisplayName('yamada@client.example.jp'), '');
});

test('本人の像の材料: 当てている相手の学び・2 通以上やり取りした相手・並べているカテゴリーだけ。件名と一言は渡さない', async () => {
  const m = (await profileMailMaterial(await mailStore(), o, NOW))!;
  assert.deepEqual(m.people, [
    '山田 太郎（yamada@client.example.jp）からのメールは「大事な相手」（本人の直し）',
    '佐藤 花子（sato@shop.example.jp）からのメールは「返事は要らない（目を通すだけ）」（ふだんの扱いから）',
  ], '本人の直しを先に。1 回だけのふるまいとカテゴリーの学びは入れない');
  assert.deepEqual(m.frequent, [{ name: '山田 太郎（yamada@client.example.jp）', count: 2 }], '宣伝・30 日より前・1 通だけの相手は数えない');
  assert.deepEqual(m.categories, ['店舗の改装']);
  assert.ok(!JSON.stringify(m).includes('秘密'), '件名と一言は渡さない');
  assert.equal(await profileMailMaterial(new MemoryMailStore(), o, NOW), null, '何も無ければ印を付けない');
});

test('答えるときの材料: 依頼に出てくる相手を先に、本人が「大事」と直した相手はいつも', async () => {
  const store = await mailStore();
  assert.deepEqual(await mailPeopleFor(store, o, '佐藤さんのメールって返事要る？', NOW), [
    '佐藤 花子（sato@shop.example.jp）からのメールは「返事は要らない（目を通すだけ）」（ふだんの扱いから）',
    '山田 太郎（yamada@client.example.jp）からのメールは「大事な相手」（本人の直し）',
  ]);
  assert.deepEqual(await mailPeopleFor(store, o, '今日の予定は？', NOW), ['山田 太郎（yamada@client.example.jp）からのメールは「大事な相手」（本人の直し）']);
  assert.deepEqual(await mailPeopleFor(new MemoryMailStore(), o, '山田さん', NOW), []);
});

function profileRepo(opts: { learning?: boolean; profile?: UserProfile | null } = {}) {
  const settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  settings.memory.learning = opts.learning ?? true;
  settings.brief.topics = [{ label: '手づくりの市', query: 'クラフト マーケット' }];
  const saved: UserProfile[] = [];
  const memories: Memory[] = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, tenantId: T, userId: U, text: `覚えたこと ${i}`, source: 'learned', kind: 'fact', createdAt: day(30) }));
  const repo = {
    getUserSettings: async () => settings,
    getUserProfile: async () => opts.profile ?? null,
    listMemories: async () => memories,
    listConversationDigests: async () => [],
    listRunsWithJobs: async () => [],
    listCaseNotes: async () => [{ id: 'c1', tenantId: T, userId: U, title: '店舗の改装', state: '業者の見積を比べている', nextStep: '', dueOn: null, status: 'open', lastDay: '2026-11-10', createdAt: '', updatedAt: '' }],
    saveUserProfile: async (p: UserProfile) => { saved.push(p); },
    appendAudit: async () => undefined,
  } as unknown as Repository;
  return { repo, saved };
}

test('本人の像: 案件・メールの材料・関心の分野を渡し、メールを材料にした印を付ける', async () => {
  const prompts: string[] = [];
  const llm: LlmProvider = { name: 'test', complete: async (req: LlmRequest) => { prompts.push(req.messages.map((m) => m.content).join('\n')); return { text: '## 役割と担当\n- 手づくりの雑貨の店を営む店主', tokensUsed: 1 }; } };
  const { repo, saved } = profileRepo();
  const b = new ProfileBuilder({ repo, llmFor: async () => llm, agentName: async () => '', mail: { store: await mailStore() } });
  assert.equal(await b.buildIfDue(T, U, llm, NOW), true);
  assert.match(prompts[0]!, /# 進んでいる案件（あなたがまとめたもの）\n- 店舗の改装: 業者の見積を比べている/);
  assert.match(prompts[0]!, /# メールで覚えた相手[^\n]*\n- 山田 太郎（yamada@client\.example\.jp）からのメールは「大事な相手」/);
  assert.match(prompts[0]!, /# メールでよくやり取りする相手[^\n]*\n- 山田 太郎（yamada@client\.example\.jp）: 2 通/);
  assert.match(prompts[0]!, /# メールの仕事のまとまり（カテゴリー）\n- 店舗の改装/);
  assert.match(prompts[0]!, /# 朝のブリーフの関心の分野\n- 手づくりの市/);
  assert.ok(!prompts[0]!.includes('秘密'));
  assert.equal(saved[0]!.usedMail, true);
  // メールの画面を使っていなければ、印を付けない
  const plain = profileRepo();
  await new ProfileBuilder({ repo: plain.repo, llmFor: async () => llm, agentName: async () => '' }).buildIfDue(T, U, llm, NOW);
  assert.equal(plain.saved[0]!.usedMail, false);
});

test('作り直す時: 7 日を過ぎ、その後にメールで本人が直したことがあれば作り直す', () => {
  const profile = { stale: false, updatedAt: day(8) };
  const old = [{ createdAt: day(30) }];
  assert.equal(ProfileBuilder.due(profile, old, NOW), false);
  assert.equal(ProfileBuilder.due(profile, old, NOW, day(1)), true);
  assert.equal(ProfileBuilder.due(profile, old, NOW, day(9)), false, '作った後の直しだけを数える');
  assert.equal(ProfileBuilder.due({ stale: false, updatedAt: day(2) }, old, NOW, day(1)), false, '7 日たつまでは作り直さない');
});

test('秘書が答えるとき: メールで覚えている相手を渡す。覚えることを止めた人には渡さない', async () => {
  const store = await mailStore();
  const settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  const repo = {
    listConversationsOfDay: async () => [], listConversationDigests: async () => [], listRunsWithJobs: async () => [], listMemories: async () => [],
    getUserProfile: async () => null, getUserSettings: async () => settings, touchMemories: async () => undefined, listCaseNotes: async () => [],
  } as unknown as Repository;
  const mailPeople = (m: string) => mailPeopleFor(store, o, m, NOW);
  const r = await recall(repo, T, U, '佐藤さんから何か来てた？', [], NOW, { mailPeople });
  assert.match(r.text, /## メールで覚えている相手[^\n]*\n- 佐藤 花子（sato@shop\.example\.jp）からのメールは「返事は要らない/);
  settings.memory.learning = false;
  const off = await recall(repo, T, U, '佐藤さんから何か来てた？', [], NOW, { mailPeople });
  assert.ok(!off.text.includes('メールで覚えている相手'));
});
