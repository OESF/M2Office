/**
 * @file メールの学び（仕様書 第9.5.1.1.2節、ADR-0133）の単体テスト。
 *
 * 本人の直し（1 回で覚え、分け先をそのとおりにする）、ふるまい（60 日に 3 回で傾向）、重さと弱め方、ドメインへのまとめ、
 * 「記憶とデータ」との関係（見る・消す・すべて削除・覚えることを許すを切る）、週ごとの数、書き方の向き、秘書の言い回しを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS } from '@m2office/shared';
import {
  MailService, MailWatch, MemoryMailStore, MockWorkspaceConnector, PERSONAL_DOMAINS, StubLlmProvider, groupLessonFor, lessonId, mailCommand, mailLearning,
  styleFor, subjectTag, weekOf, type MailLessonRow, type Repository, type ToolContext,
} from '../src/index.js';

const T = 't-learn';
const U = 'u-learn';
const o = { tenantId: T, userId: U };

function setup(opts: { learning?: boolean } = {}) {
  const user = { id: U, tenantId: T, email: 'me@example.jp', displayName: '三浦', status: 'active', roles: ['member'] };
  const repo = {
    findUserById: async () => user,
    listUsers: async () => [user],
    getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS, memory: { ...DEFAULT_USER_SETTINGS.memory, learning: opts.learning ?? true } }),
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    getGoogleConnection: async () => null,
    createNotification: async () => undefined,
    getRun: async () => null,
    listRunApprovals: async () => [],
  } as unknown as Repository;
  const store = new MemoryMailStore();
  const connector = new MockWorkspaceConnector(() => new Date());
  const llm = new StubLlmProvider();
  const watch = new MailWatch({ store, repo, mail: connector.mail, llmFor: async () => llm, isMock: () => true });
  const service = new MailService({ store, repo, mail: connector.mail, watch, llmFor: async () => llm });
  return { store, watch, service };
}

/** 本人の直しの行。 */
const told = (keyValue: string, target: string, keyType: MailLessonRow['keyType'] = 'from'): MailLessonRow => {
  const at = new Date().toISOString();
  return { id: lessonId('group', keyType, keyValue, target, 'told'), kind: 'group', keyType, keyValue, target, source: 'told', subject: '', hits: [], firstAt: at, lastAt: at, usedAt: at };
};

test('本人の直し: 「目を通すだけ」にした相手は、推論を呼ばずにそのとおりに分ける。「大事」にした配信のメールは宣伝にしない', async () => {
  const { store, watch, service } = setup();
  await store.saveLesson(o, told('sato@customer.example.jp', 'read'));
  await store.saveLesson(o, told('news@saas.example.com', 'important'));
  await watch.runFor(o, new Date(), true);
  const v = await service.overview(o);
  const sato = [...v.reply, ...v.action, ...v.read].find((t) => t.from.includes('sato@'))!;
  assert.equal(sato.group, 'read', '推論は「返事が要る」と言っても、本人の直しのとおりにする');
  assert.ok(v.read.some((t) => t.from.includes('news@')), '大事な相手の配信のメールは、宣伝・お知らせにしない');
  assert.equal(v.promoCount, 0);
});

test('ふるまい: 同じ相手で 3 回そろったら傾向になる（2 回では当てない）。本人の直しより弱く、逆のふるまいが 3 回そろったら直しを弱める', async () => {
  const { store, watch } = setup();
  const now = new Date();
  for (let i = 0; i < 2; i++) await watch.learner.behavior(o, '田中 <tanaka@partner.example.jp>', 'お打ち合わせ', 'read', now);
  assert.equal(groupLessonFor(await store.lessons(o), 'tanaka@partner.example.jp', '', 'example.jp', now), null, '2 回では当てない');
  await watch.learner.behavior(o, '田中 <tanaka@partner.example.jp>', 'お打ち合わせ', 'read', now);
  const hit = groupLessonFor(await store.lessons(o), '田中 <tanaka@partner.example.jp>', '', 'example.jp', now)!;
  assert.equal(hit.target, 'read');
  assert.equal(hit.fixed, false, 'ふるまいは決めつけずに例として渡す');
  // 本人の直しのほうが重い
  const t = { ...told('tanaka@partner.example.jp', 'reply'), lastAt: new Date(now.getTime() - 60_000).toISOString() };
  await store.saveLesson(o, t);
  assert.equal(groupLessonFor(await store.lessons(o), 'tanaka@partner.example.jp', '', 'example.jp', now)?.target, 'reply');
  assert.equal(groupLessonFor(await store.lessons(o), 'tanaka@partner.example.jp', '', 'example.jp', now)?.fixed, false, '直しの後に逆のふるまいが 3 回そろったので弱める');
  // 60 日より前のふるまいは数えない
  const old = new Date(now.getTime() - 61 * 86_400_000).toISOString();
  await store.saveLesson(o, { ...told('x@y.example.jp', 'promo'), id: 'old', source: 'behavior', hits: [old, old, old] });
  assert.equal(groupLessonFor(await store.lessons(o), 'x@y.example.jp', '', 'example.jp', now), null);
});

test('ドメインにまとめる: 同じ会社の 2 つ以上のアドレスで同じ傾向なら、別のアドレスにも当てる。個人向けのドメインと本人の会社はまとめない', async () => {
  const { store, watch } = setup();
  const now = new Date();
  // 個人向けのドメインは、実際の決まりの一覧から取る（本物のアドレスをテストに書かない）
  const personal = [...PERSONAL_DOMAINS][0]!;
  for (const a of ['a@vendor.example.co.jp', 'b@vendor.example.co.jp', `p@${personal}`, `q@${personal}`, 'm1@example.jp', 'm2@example.jp']) {
    for (let i = 0; i < 3; i++) await watch.learner.behavior(o, a, '', 'promo', now);
  }
  const lessons = await store.lessons(o);
  assert.equal(groupLessonFor(lessons, 'c@vendor.example.co.jp', '', 'example.jp', now)?.target, 'promo');
  assert.equal(groupLessonFor(lessons, `r@${personal}`, '', 'example.jp', now), null, '個人向けのドメインはまとめない');
  assert.equal(groupLessonFor(lessons, 'm3@example.jp', '', 'example.jp', now), null, '本人の会社のドメインはまとめない');
  // 件名の頭の決まった形でも覚える
  assert.equal(subjectTag('Re: 【定例】週次の報告'), '【定例】');
  for (let i = 0; i < 3; i++) await watch.learner.behavior(o, `n${i}@other.example.org`, '【定例】週次の報告', 'read', now);
  assert.equal(groupLessonFor(await store.lessons(o), 'z@another.example.net', '【定例】来週の報告', 'example.jp', now)?.target, 'read');
});

test('ふるまいを数える: 「返事が要る」を返事せずに済みにした（外れ）・すぐ開いた。週ごとの数に足し、週次ブリーフの 1 行にする', async () => {
  const { store, watch, service } = setup();
  const now = new Date();
  await watch.runFor(o, now, true);
  const v = await service.overview(o);
  await service.done(o, v.reply[0]!.threadId, now);
  const lessons = await store.lessons(o);
  assert.ok(lessons.some((l) => l.source === 'behavior' && l.target === 'read' && l.hits.length === 1), '返事が要らないことが多い、を 1 回数える');
  assert.deepEqual((await service.learningProgress(o, now)).thisWeek, { corrections: 0, misses: 1 });
  const r = await mailLearning.invoke({}, { tenantId: T, userId: U, mail: { store } } as unknown as ToolContext) as { available: boolean; line: string };
  assert.equal(r.available, true);
  assert.match(r.line, /今週 1 回/);
  assert.equal(weekOf(new Date('2026-11-10T03:00:00Z')), '2026-11-09', '週は日本時間の月曜日から');
});

test('本人の直し（会話）: 「これは返事は要らない」で覚え、いま並んでいるその相手のメールも分け直す。見る・忘れる・すべて削除', async () => {
  const { store, watch, service } = setup();
  const now = new Date();
  await watch.runFor(o, now, true);
  const target = (await service.overview(o)).reply.find((t) => t.from.includes('tanaka@'))!;
  await service.detail(o, target.threadId, now);
  const r = await service.categoryRequest(o, 'これは返事は要らない', now);
  assert.match(r.text, /目を通すだけ/);
  assert.equal((await store.thread(o, target.threadId))?.group, 'read', 'いま並んでいるメールもすぐ分け直す');
  assert.equal((await service.learningProgress(o, now)).thisWeek.corrections, 1, '直した回数に足す');
  const view = await service.lessonsView(o, now);
  assert.ok(view.some((x) => x.source === 'told' && x.text.includes('tanaka@partner.example.jp') && x.text.includes('目を通すだけ')));
  assert.equal(await service.forgetLessonsAbout(o, '田中'), 1, '名前で言われたら、一覧の差出人からアドレスを探して消す');
  await store.saveLesson(o, told('a@b.example.jp', 'promo'));
  assert.equal(await service.clearLessons(o), 1, '「すべて削除」で消す');
  assert.equal((await service.learningProgress(o, now)).thisWeek.corrections, 0, '週ごとの数も消す');
});

test('「覚えることを許す」を切ると、新しく覚えない（覚えたものは使い続ける）', async () => {
  const { store, watch } = setup({ learning: false });
  await store.saveLesson(o, told('sato@customer.example.jp', 'read'));
  for (let i = 0; i < 3; i++) await watch.learner.behavior(o, 'tanaka@partner.example.jp', '', 'read', new Date());
  assert.equal((await store.lessons(o)).length, 1, 'ふるまいを覚えない');
  assert.equal(groupLessonFor(await store.lessons(o), 'sato@customer.example.jp', '', 'example.jp', new Date())?.target, 'read', '覚えたものは使う');
});

test('返事の書き方: 用意した下書きを大きく短くして送ったら、その相手の次の下書きは短めにする', async () => {
  const { store, watch, service } = setup();
  const now = new Date();
  await watch.runFor(o, now, true);
  const t = (await service.overview(o)).reply.find((x) => x.draftReady)!;
  const row = (await store.thread(o, t.threadId))!;
  const to = row.recipients.to[0]!;
  await store.saveThread(o, { ...row, draft: 'あ'.repeat(400) });
  const r = await service.prepareSend(o, t.threadId, { to: [to], cc: [], body: '承知しました。よろしくお願いいたします。' });
  assert.ok('row' in r);
  assert.equal(styleFor(await store.lessons(o), to, now), 'shorter');
});

test('秘書の言い回し: 振り分けの直し・覚えていること・忘れる・共有。「この手のメールは見なくていい」は見回りを止める頼みにしない', () => {
  for (const m of ['これは返事は要らない', '佐藤さんのメールは大事', 'ニュースレターからのは宣伝でいい', 'この手のメールは見なくていい', 'このメールは宣伝']) {
    assert.equal(mailCommand(m)?.kind, 'teach', m);
  }
  assert.equal(mailCommand('メールは見なくていい')?.kind, 'pause');
  assert.equal(mailCommand('メールについて何を覚えてる？')?.kind, 'lessons');
  assert.deepEqual(mailCommand('佐藤さんのことは忘れて'), { kind: 'forget', who: '佐藤' });
  assert.deepEqual(mailCommand('メールの学びの数を運営に共有して'), { kind: 'share', on: true });
  assert.deepEqual(mailCommand('メールの学びの共有をやめて'), { kind: 'share', on: false });
});
