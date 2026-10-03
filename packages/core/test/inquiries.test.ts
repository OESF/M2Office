/**
 * @file 問い合わせの記録の単体テスト（仕様書 第33.17節）。項目の取り出し・期限の読み方・要配慮個人情報の除き方・
 * 残す・続きを足す・候補・削除の権限・期限の知らせ・ツール。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Notification, type TenantSettings } from '@m2office/shared';
import {
  InquiryService, InquiryWatch, MemoryInquiryStore, StubLlmProvider, INQUIRY_TOOLS, businessDaysAgo, dueFrom, guessInquiry, readInquiry, sameParty, stripSensitive,
  type InquiryContactBook, type LlmProvider, type Repository, type ToolContext,
} from '../src/index.js';

/** 決まった答えを返す推論。 */
function fakeLlm(answer: (prompt: string) => string): LlmProvider {
  return { name: 'fake', complete: async (req) => ({ text: answer(String(req.messages.at(-1)?.content ?? '')), tokensUsed: 1 }) };
}

function setup(opts: { enabled?: boolean; llm?: LlmProvider; contacts?: InquiryContactBook } = {}) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const notes: Notification[] = [];
  const settings = (): TenantSettings => ({ ...DEFAULT_TENANT_SETTINGS, inquiries: { enabled: opts.enabled ?? true } });
  const users: Record<string, { roles: string[]; displayName: string }> = {
    u1: { roles: ['member'], displayName: '受付' }, u2: { roles: ['member'], displayName: '営業' }, boss: { roles: ['admin'], displayName: '責任者' },
  };
  let inquiryNotices = true;
  const repo = {
    findUserById: async (_t: string, id: string) => (users[id] ? { id, status: 'active', email: `${id}@example.jp`, ...users[id] } : null),
    getTenantSettings: async () => settings(),
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    listUsers: async () => Object.entries(users).map(([id, u]) => ({ id, email: `${id}@example.jp`, status: 'active', ...u })),
    getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS, notifications: { ...DEFAULT_USER_SETTINGS.notifications, kinds: { ...DEFAULT_USER_SETTINGS.notifications.kinds, inquiry: inquiryNotices } } }),
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryInquiryStore();
  const service = new InquiryService({ store, repo, llmFor: async () => opts.llm ?? new StubLlmProvider(), contacts: opts.contacts ?? null });
  return {
    service, store, audits, notes, repo,
    muteInquiry: () => { inquiryNotices = false; },
  };
}

// 個人設定の既定（テストの中だけで使う最小の形）
const DEFAULT_USER_SETTINGS = {
  profile: { timezone: 'Asia/Tokyo' },
  notifications: { kinds: { brief: true, run: true, approval: true, failure: true, inventory: true, attendance: true, signage: true, inquiry: true } },
};

const who = { tenantId: 't1', userId: 'u1' };
// 2026-10-07 は水曜日
const today = { date: '2026-10-07' };

test('期限の言い方を日付に直す（明日・曜日・来週・月日・今週中）', () => {
  assert.equal(dueFrom('明日までに送る', today), '2026-10-08');
  assert.equal(dueFrom('金曜日までに', today), '2026-10-09');
  assert.equal(dueFrom('水曜日まで', today), '2026-10-07', '今日の曜日なら今日');
  assert.equal(dueFrom('来週月曜に', today), '2026-10-12');
  assert.equal(dueFrom('来週の金曜', today), '2026-10-16');
  assert.equal(dueFrom('10月12日に', today), '2026-10-12');
  assert.equal(dueFrom('3/2 まで', today), '2027-03-02', '今日より前の月日は来年');
  assert.equal(dueFrom('今週中に', today), '2026-10-09');
  assert.equal(dueFrom('そのうち', today), null);
});

test('要配慮個人情報と番号を、要約と原文から除く', () => {
  const s = stripSensitive('予約を変えたい。持病で通院しているので午前がよい。カードは 4111 1111 1111 1111 です。');
  assert.equal(s.removed, true);
  assert.ok(!s.text.includes('通院') && !s.text.includes('4111'));
  assert.ok(s.text.includes('予約を変えたい'));
  assert.equal(stripSensitive('見積もりがほしい').removed, false);
});

test('決まった言葉で取り出す: 電話・名前・どこで知ったか・次にやることと期限。分からないことは「不明」', () => {
  const d = guessInquiry('いま田中さんから電話。来月の法人向けプランの見積もりがほしい。ホームページを見たって。金曜日までに送る', today);
  assert.equal(d.intent, 'new');
  assert.equal(d.from.name, '田中');
  assert.equal(d.channel, 'phone');
  assert.equal(d.category, '見積もり');
  assert.equal(d.source, 'Web サイト');
  assert.deepEqual(d.task, { what: '見積もりを送る', due: '2026-10-09' });
  assert.equal(guessInquiry('佐藤さんが来店。新しい商品について知りたいとのこと', today).source, '不明', '推し量って埋めない');
});

test('推論の答えを読み、選んだ問い合わせが候補に無ければ使わない。読めなければ決まった言葉で取り出す', async () => {
  const llm = fakeLlm(() => '{"intent":"followup","inquiryId":"inq-x","from":{"name":"田中","company":"","phone":"","email":""},"channel":"mail","direction":"out","category":"見積もり","summary":"見積もりを送った","source":"不明","temperature":"normal","task":null,"closesTask":true,"sensitive":false}');
  const d = await readInquiry(llm, '田中さんに見積もりを送った', today, [{ id: 'inq-1', from: { name: '田中', company: '', phone: '', email: '' }, summary: '見積もり' }]);
  assert.equal(d.intent, 'followup');
  assert.equal(d.inquiryId, null, '候補に無い ID は使わない');
  assert.equal(d.closesTask, true);
  const broken = await readInquiry(fakeLlm(() => 'わかりません'), 'いま鈴木さんから電話。予約したい', today);
  assert.equal(broken.from.name, '鈴木');
});

test('残す: 項目に分け、会話の履歴と次にやることを作る。名刺管理とつなぎ、監査ログにお客様の名前を残さない', async () => {
  const linked: string[] = [];
  const contacts: InquiryContactBook = { link: async (_w, from) => { linked.push(from.name); return { contactId: 'ct-1', created: true }; } };
  const { service, store, audits } = setup({ contacts });
  const r = await service.record(who, 'いま田中さんから電話 03-1234-5678。見積もりがほしい。ホームページを見たって。明日までに送る');
  assert.equal(r.kind, 'created');
  if (r.kind !== 'created') return;
  assert.equal(r.inquiry.from.name, '田中');
  assert.equal(r.inquiry.from.phone, '03-1234-5678');
  assert.equal(r.inquiry.contactId, 'ct-1');
  assert.equal(r.contactCreated, true);
  assert.equal(r.inquiry.receivedByName, '受付');
  assert.equal(r.task?.what, '見積もりを送る');
  assert.ok(r.task?.due, '期限を日付にした');
  assert.equal((await store.events('t1', r.inquiry.id)).length, 1);
  assert.deepEqual(linked, ['田中']);
  const a = audits.find((x) => x.action === 'inquiry.create')!;
  assert.ok(!JSON.stringify(a.detail).includes('田中'), '監査ログに名前を残さない');
  assert.equal((await service.record(who, '   ')).kind, 'error');
});

test('続き: 「見積もりを送った」は同じ問い合わせに足し、次にやることを済みにする。同じ名前が 2 件なら候補を返す', async () => {
  const { service, store } = setup();
  const first = await service.record(who, 'いま田中さんから電話。見積もりがほしい。金曜日までに送る');
  assert.equal(first.kind, 'created');
  if (first.kind !== 'created') return;
  const next = await service.record(who, '田中さんに見積もりを送った');
  assert.equal(next.kind, 'appended');
  if (next.kind !== 'appended') return;
  assert.equal(next.inquiry.id, first.inquiry.id);
  assert.equal(next.closedTask?.what, '見積もりを送る');
  const events = await store.events('t1', first.inquiry.id);
  assert.deepEqual(events.map((e) => e.direction), ['in', 'out']);
  assert.equal((await store.get('t1', first.inquiry.id))?.nextTask, null, '次にやることは済んだ');

  // 名前がそのまま同じものがあれば、似た名前（田中一郎）があっても迷わない
  await service.record(who, 'いま田中一郎さんから電話。資料がほしい');
  const exact = await service.record(who, '田中さんに折り返した');
  assert.equal(exact.kind === 'appended' && exact.inquiry.id, first.inquiry.id);
  await service.record(who, 'いま田中さんから電話。別件で予約したい');
  const amb = await service.record(who, '田中さんに折り返した');
  assert.equal(amb.kind, 'ambiguous');
  // 画面から問い合わせを選べば、その問い合わせに足す
  const picked = await service.record(who, '田中さんに折り返した', { inquiryId: first.inquiry.id });
  assert.equal(picked.kind, 'appended');
});

test('続き: 推論が選んでも、同じ人とはっきり分からなければ別の問い合わせにする（名前の無い別の電話を混ぜない）', async () => {
  // 2026-10-03 に、名前の無い「来週の水曜日は営業しているか」に、名前の無い「見積もりを送って」の電話が続きとして入った
  let firstId = '';
  const llm = fakeLlm((p) => p.includes('対応中の問い合わせ（データ）')
    ? `{"intent":"followup","inquiryId":"${firstId}","from":{"name":"","company":"","phone":"","email":""},"channel":"phone","direction":"in","category":"見積もり","summary":"見積もりを送ってほしい","source":"不明","temperature":"normal","task":{"what":"見積もりを送る","due":"2026-10-15"},"closesTask":false,"sensitive":false}`
    : '{"intent":"new","inquiryId":null,"from":{"name":"","company":"","phone":"","email":""},"channel":"phone","direction":"in","category":"質問","summary":"来週の水曜日に営業しているか","source":"不明","temperature":"normal","task":null,"closesTask":false,"sensitive":false}');
  const { service, store } = setup({ llm });
  const first = await service.record(who, '来週の水曜日に営業しているかという問い合わせ');
  if (first.kind !== 'created') throw new Error('残せない');
  firstId = first.inquiry.id;
  const second = await service.record(who, '来週の木曜日までに、お願いしていた見積もりを送ってくださいという電話を受けました');
  assert.equal(second.kind, 'created', '続きにしない');
  if (second.kind !== 'created') return;
  assert.notEqual(second.inquiry.id, firstId);
  assert.equal((await store.get('t1', firstId))?.nextTask, null, '前の問い合わせに次にやることを足さない');
  assert.equal(sameParty({ name: '田中', company: '', phone: '', email: '' }, { name: '田中さん', company: '', phone: '', email: '' }), true);
  assert.equal(sameParty({ name: '', company: '', phone: '03-1234-5678', email: '' }, { name: '', company: '', phone: '0312345678', email: '' }), true);
  assert.equal(sameParty({ name: '', company: '', phone: '', email: '' }, { name: '', company: '', phone: '', email: '' }), false);
});

test('分ける: 続きとして入った履歴を、その履歴から生まれた次にやることと一緒に、別の問い合わせにする', async () => {
  const { service, store, audits } = setup();
  const first = await service.record(who, 'いま田中さんから電話。営業日を知りたい');
  if (first.kind !== 'created') throw new Error('残せない');
  const appended = await service.record(who, '田中さんから電話。見積もりがほしい。明日までに送る', { inquiryId: first.inquiry.id });
  if (appended.kind !== 'appended') throw new Error('足せない');
  const events = await store.events('t1', first.inquiry.id);
  assert.equal((await service.split(who, events[0]!.id) as { error: string }).error, '最初の履歴は分けられません。後の履歴を分けてください');
  const res = await service.split(who, events[1]!.id);
  assert.ok('id' in res);
  if (!('id' in res)) return;
  assert.equal((await store.events('t1', first.inquiry.id)).length, 1);
  assert.equal((await store.events('t1', res.id)).length, 1);
  const moved = await store.get('t1', res.id);
  assert.equal(moved?.from.name, '田中', '原文から読み直す');
  assert.equal(moved?.nextTask?.what, appended.task?.what, '次にやることも移る');
  assert.equal((await store.get('t1', first.inquiry.id))?.nextTask, null);
  assert.ok(audits.some((a) => a.action === 'inquiry.split'));
});

test('要配慮個人情報: 話に出ても原文を残さず、要約からも除く', async () => {
  const { service, store, audits } = setup();
  const r = await service.record(who, 'いま山田さんから電話。持病で通院中なので、来店の時間を午前にしたい。予約を変えたい');
  assert.equal(r.kind, 'created');
  if (r.kind !== 'created') return;
  assert.equal(r.sensitive, true);
  assert.ok(!r.inquiry.summary.includes('通院') && !r.inquiry.summary.includes('持病'));
  const events = await store.events('t1', r.inquiry.id);
  assert.equal(events[0]!.body, null, '原文を残さない');
  assert.equal(audits.at(-1)?.detail['sensitiveRemoved'], true);
  // 人が直した用件でも残さない
  assert.equal(await service.update(who, r.inquiry.id, { summary: '予約を変えたい。うつで通院中' }), null);
  assert.ok(!(await store.get('t1', r.inquiry.id))!.summary.includes('通院'));
});

test('直す・次にやること・削除: 項目の値を確かめ、削除は残した人と管理者だけ', async () => {
  const { service, store } = setup();
  const r = await service.record(who, 'いま佐藤さんが来店。商品について質問');
  if (r.kind !== 'created') throw new Error('残せない');
  assert.equal(await service.update(who, r.inquiry.id, { channel: 'fax' }), '経路が読めません');
  assert.equal(await service.update(who, r.inquiry.id, { temperature: 'high', status: 'done', source: '' }), null);
  const cur = (await store.get('t1', r.inquiry.id))!;
  assert.deepEqual([cur.temperature, cur.status, cur.source], ['high', 'done', '不明']);
  assert.equal(await service.addTask(who, r.inquiry.id, { what: 'カタログを送る', due: '10/9' }), '期限は日付で入れてください');
  assert.equal(await service.addTask(who, r.inquiry.id, { what: 'カタログを送る', due: '2026-10-09', assignee: 'nobody' }), '担当の人が見つかりません');
  assert.equal(await service.addTask(who, r.inquiry.id, { what: 'カタログを送る', due: '2026-10-09', assignee: 'u2' }), null);
  const task = (await store.tasks('t1', r.inquiry.id))[0]!;
  assert.equal(await service.updateTask(who, task.id, { done: true }), null);
  assert.ok((await store.task('t1', task.id))?.doneAt);
  assert.equal(await service.remove({ tenantId: 't1', userId: 'u2' }, r.inquiry.id), '削除できるのは、残した人と管理者だけです');
  assert.equal(await service.remove({ tenantId: 't1', userId: 'boss' }, r.inquiry.id), null);
  assert.equal(await store.get('t1', r.inquiry.id), null);
});

test('見張り: 期限の前の日と過ぎたときに 1 回ずつ知らせ、手つかずを知らせ、知らせを切った人には送らない', async () => {
  const { service, store, notes, repo, muteInquiry } = setup();
  const a = await service.record(who, 'いま田中さんから電話。見積もりがほしい');
  const b = await service.record(who, 'いま鈴木さんから電話。資料がほしい');
  if (a.kind !== 'created' || b.kind !== 'created') throw new Error('残せない');
  const now = new Date('2026-10-07T03:00:00Z');
  await store.updateTask('t1', a.task!.id, { due: '2026-10-08' });
  await store.updateTask('t1', b.task!.id, { due: '2026-10-05' });
  const watch = new InquiryWatch({ store, repo });
  const first = await watch.tick(now);
  assert.equal(first.notified, 2);
  assert.ok(notes.some((n) => n.title === '明日が期限の問い合わせ: 田中さん' && n.kind === 'inquiry'));
  assert.ok(notes.some((n) => n.title === '期限を過ぎた問い合わせ: 鈴木さん'));
  assert.ok(!notes.some((n) => n.body.includes('見積もりがほしい')), '用件の中身は知らせに入れない');
  assert.equal((await watch.tick(now)).notified, 0, '同じものは 2 回知らせない');

  // 次にやることが無く、3 営業日動いていない問い合わせ
  const c = await service.record(who, 'いま高橋さんが来店。様子を見に来ただけ');
  if (c.kind !== 'created') throw new Error('残せない');
  await store.update('t1', c.inquiry.id, { lastAt: '2026-09-30T00:00:00.000Z' });
  muteInquiry();
  assert.equal((await watch.tick(now)).notified, 0, '知らせを切った人には送らない');
  assert.equal(businessDaysAgo(new Date('2026-10-07T00:00:00Z'), 3).toISOString().slice(0, 10), '2026-10-02', '土日は数えない');
});

test('ツール: 使えない会社では断り、残す・一覧を読む。一覧はデータとして返す', async () => {
  const off = setup({ enabled: false });
  const ctxOf = (s: ReturnType<typeof setup>, enabled: boolean) => ({
    tenantId: 't1', userId: 'u1',
    inquiries: { service: s.service, access: async () => (enabled ? { enabled: true } : null) },
  } as unknown as ToolContext);
  const record = INQUIRY_TOOLS.find((t) => t.name === 'inquiries.record')!;
  const list = INQUIRY_TOOLS.find((t) => t.name === 'inquiries.list')!;
  assert.equal(((await record.invoke({ text: 'いま田中さんから電話' }, ctxOf(off, false))) as { available: boolean }).available, false);
  const on = setup();
  const res = await record.invoke({ text: 'いま田中さんから電話。見積もりがほしい。明日までに送る' }, ctxOf(on, true)) as Record<string, unknown>;
  assert.equal(res['available'], true);
  assert.equal(res['kind'], '新しい問い合わせ');
  assert.match(String(res['path']), /^\/inquiries\/inq-/);
  const got = await list.invoke({ waiting: true }, ctxOf(on, true)) as { count: number; untrusted: boolean; items: { from: string }[] };
  assert.equal(got.count, 1);
  assert.equal(got.untrusted, true);
  assert.equal(got.items[0]!.from, '田中さん');
});
