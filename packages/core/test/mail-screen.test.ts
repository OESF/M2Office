/**
 * @file メールを M2Office の中で片付ける（仕様書 第9.5.1.1節、ADR-0131）の単体テスト。
 *
 * 見回り（振り分け・下書き・返信したら片付く・アーカイブしたら片付く・返事待ち・急ぎの知らせ）、画面の処理（送る前の控え・開いたら片付く）、
 * 送るツール（確かめた後に控えが変わったら送らない）、秘書の言い回しの見分けを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS, type UserSettings } from '@m2office/shared';
import {
  MailService, MailWatch, MemoryMailStore, MockWorkspaceConnector, StubLlmProvider, businessDaysSince, mailCommand, mailReplySend, outgoingDigest,
  parseInbound, waitDaysFor, type MailHead, type Repository, type ToolContext,
} from '../src/index.js';

const T = 't-mail';
const U = 'u-mail';
const o = { tenantId: T, userId: U };

/** 見回りが使う分だけの偽の置き場。 */
function fakeRepo(opts: { proactivity?: UserSettings['secretary']['proactivity']; mailNotice?: boolean } = {}) {
  const notices: { kind: string; title: string }[] = [];
  const user = { id: U, tenantId: T, email: 'me@example.jp', displayName: '三浦', status: 'active', roles: ['member'] };
  const repo = {
    notices,
    findUserById: async () => user,
    listUsers: async () => [user],
    getUserSettings: async () => ({
      ...DEFAULT_USER_SETTINGS,
      secretary: { ...DEFAULT_USER_SETTINGS.secretary, proactivity: opts.proactivity ?? 'normal' },
      notifications: { ...DEFAULT_USER_SETTINGS.notifications, kinds: { ...DEFAULT_USER_SETTINGS.notifications.kinds, mail: opts.mailNotice ?? true } },
    }),
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    getGoogleConnection: async () => null,
    createNotification: async (n: { kind: string; title: string }) => { notices.push(n); },
    getRun: async () => null,
    listRunApprovals: async () => [],
  };
  return repo as typeof repo & Repository;
}

function setup(opts: Parameters<typeof fakeRepo>[0] = {}, now = new Date()) {
  const store = new MemoryMailStore();
  const repo = fakeRepo(opts);
  const connector = new MockWorkspaceConnector(() => now);
  const llm = new StubLlmProvider();
  const watch = new MailWatch({ store, repo, mail: connector.mail, llmFor: async () => llm, isMock: () => true });
  const service = new MailService({ store, repo, mail: connector.mail, watch, llmFor: async () => llm });
  return { store, repo, connector, watch, service };
}

test('最初の見回りで、届いたメールをスレッドごとに振り分け、返事が要るものに下書きを用意する（配信のメールは推論を呼ばずに宣伝）', async () => {
  const { watch, service } = setup();
  const r = await watch.runFor(o, new Date(), true);
  assert.ok(r && r.looked >= 4);
  const v = await service.overview(o);
  assert.equal(v.watch.state, 'ready');
  assert.deepEqual(v.reply.map((x) => x.subject).sort(), ['お打ち合わせの候補日について', '【ご確認】来月分の発注数量について'].sort());
  assert.equal(v.action.length, 1);
  assert.equal(v.promoCount, 1, 'ニュースレターは宣伝・お知らせ');
  assert.ok(v.reply.every((x) => x.draftReady), '返事が要るものには下書きがある');
  assert.equal(v.action[0]!.draftReady, false, '対応が要るものには下書きを作らない');
});

test('15 分たっていなければ見ない。本人が止めた・積極性が「控えめ」の人は見ない', async () => {
  const { watch, service } = setup();
  const now = new Date();
  assert.ok(await watch.runFor(o, now, true));
  assert.equal(await watch.runFor(o, new Date(now.getTime() + 5 * 60_000)), null, '5 分後は見ない');
  await service.setPrefs(o, (p) => ({ ...p, paused: true }));
  assert.equal(await watch.runFor(o, new Date(now.getTime() + 20 * 60_000)), null);
  assert.equal((await service.overview(o)).watch.state, 'paused');
  const low = setup({ proactivity: 'low' });
  assert.equal(await low.watch.runFor(o, now, true), null);
});

test('積極性が「控えめ」でも、「またメールを見て」と言えばメールは見る。「見なくていい」で止まる（第 0.543.0 版）', async () => {
  const low = setup({ proactivity: 'low' });
  const now = new Date();
  assert.equal(await low.watch.reasonNotToWatch(o), 'low');
  await low.service.setPrefs(o, (p) => ({ ...p, paused: false, keepWatching: true }));
  assert.equal(await low.watch.reasonNotToWatch(o), null);
  assert.ok(await low.watch.runFor(o, now, true));
  await low.service.setPrefs(o, ({ keepWatching: _, ...p }) => ({ ...p, paused: true }));
  assert.equal(await low.watch.reasonNotToWatch(o), 'paused');
});

test('最後の取得から 30 分を過ぎたら、見回りが止まっているとみなす。止めている人は止まっているとみなさない', async () => {
  let clock = new Date();
  const s = setup();
  const service = new MailService({ store: s.store, repo: s.repo, mail: s.connector.mail, watch: s.watch, llmFor: async () => null, now: () => clock });
  await s.watch.runFor(o, clock, true);
  const first = (await service.overview(o)).watch;
  assert.equal(first.stale, false);
  assert.ok(first.checkedAt, '最後の取得の日時を返す');
  clock = new Date(clock.getTime() + 31 * 60_000);
  assert.equal((await service.overview(o)).watch.stale, true);
  await service.setPrefs(o, (p) => ({ ...p, paused: true }));
  const paused = (await service.overview(o)).watch;
  assert.equal(paused.state, 'paused');
  assert.equal(paused.stale, false);
  assert.ok(paused.checkedAt, '止めているときも最後の取得の日時を返す');
});

test('本人がそのスレッドに返信したら片付く（未読かどうかでは決めない）', async () => {
  const { watch, service, connector } = setup();
  const now = new Date();
  await watch.runFor(o, now, true);
  const target = (await service.overview(o)).reply.find((x) => x.subject.startsWith('お打ち合わせ'))!;
  // Gmail から返信した（見本の接続口は、受信箱のメールへの返信をスレッドに残す）
  await connector.mail.send(o, { to: ['tanaka@partner.example.jp'], cc: [], subject: 'Re: お打ち合わせの候補日について', body: '水曜の午後でお願いします。', replyTo: target.threadId });
  await watch.runFor(o, new Date(now.getTime() + 16 * 60_000));
  const after = await service.overview(o);
  assert.ok(!after.reply.some((x) => x.threadId === target.threadId), '返信したので一覧から外れる');
});

test('アーカイブしたスレッドは片付く。ラベルが変わっただけなら、済みにしたものを開き直さない', async () => {
  const { store, repo, service } = setup();
  const heads = new Map<string, MailHead[]>();
  const head = (labels: string[]): MailHead => ({
    id: 'm1', threadId: 'th1', from: '山田 <yamada@example.jp>', to: ['me@example.jp'], cc: [], subject: '見積のご依頼', snippet: '見積をご教示ください', receivedAt: new Date().toISOString(), labels, bulk: false,
  });
  heads.set('th1', [head(['INBOX'])]);
  let changed = ['th1'];
  const mail = {
    ...new MockWorkspaceConnector().mail,
    historyStart: async () => '1',
    historySince: async () => ({ historyId: '2', threadIds: changed }),
    threadIdsOf: async (_p: unknown, q: string) => (q.includes('in:sent') ? [] : ['th1']),
    threadHeads: async (_p: unknown, id: string) => heads.get(id) ?? [],
  };
  const watch = new MailWatch({ store, repo, mail, llmFor: async () => new StubLlmProvider(), isMock: () => true });
  const now = new Date();
  await watch.runFor(o, now, true);
  assert.equal((await store.thread(o, 'th1'))?.group, 'reply');
  // 済みにしてから、既読になった（ラベルが変わっただけ）
  await new MailService({ store, repo, mail, watch, llmFor: async () => null }).done(o, 'th1');
  await watch.runFor(o, new Date(now.getTime() + 16 * 60_000));
  assert.equal((await store.thread(o, 'th1'))?.state, 'done', '同じメールのままなら開き直さない');
  // 新しいメールが届いたら開き直し、アーカイブしたら片付く
  heads.set('th1', [{ ...head(['INBOX']), id: 'm2' }]);
  await watch.runFor(o, new Date(now.getTime() + 32 * 60_000));
  assert.equal((await store.thread(o, 'th1'))?.state, 'open');
  heads.set('th1', [{ ...head([]), id: 'm2' }]);
  await watch.runFor(o, new Date(now.getTime() + 48 * 60_000));
  const t = await store.thread(o, 'th1');
  assert.equal(t?.state, 'done');
  assert.equal(t?.doneReason, 'archived');
  changed = [];
  void service;
});

test('「メイン」かどうかは Gmail の検索で決める（新着の印が付いていても、検索で「メイン」に出れば並べる。出なければ並べない）', async () => {
  const { store, repo } = setup();
  const head = (id: string, labels: string[]): MailHead => ({
    id: `m-${id}`, threadId: id, from: '山田 <yamada@example.jp>', to: ['me@example.jp'], cc: [], subject: `件名 ${id}`, snippet: 'ご教示ください',
    receivedAt: new Date().toISOString(), labels, bulk: false,
  });
  const heads: Record<string, MailHead[]> = {
    upd: [head('upd', ['INBOX', 'CATEGORY_UPDATES'])], // 新着のタブを使っていない人の「メイン」
    soc: [head('soc', ['INBOX', 'CATEGORY_SOCIAL'])], // ソーシャルのタブに入ったもの
  };
  const mail = {
    ...new MockWorkspaceConnector().mail,
    historyStart: async () => '1',
    historySince: async () => ({ historyId: '2', threadIds: ['upd', 'soc'] }),
    threadIdsOf: async (_p: unknown, q: string) => (q.includes('category:primary') ? ['upd'] : []),
    threadHeads: async (_p: unknown, id: string) => heads[id] ?? [],
  };
  const watch = new MailWatch({ store, repo, mail, llmFor: async () => new StubLlmProvider(), isMock: () => true });
  const now = new Date();
  await watch.runFor(o, now, true);
  assert.equal((await store.thread(o, 'upd'))?.group, 'reply', '検索で「メイン」に出るものは、印に関わらず並べる');
  await watch.runFor(o, new Date(now.getTime() + 16 * 60_000));
  assert.equal(await store.thread(o, 'soc'), null, '「メイン」に出ないものは並べない');
});

test('本人が送って返事を待っているものは、3 営業日たってから返事待ちに並べる。相手ごとに日数を変えられる', async () => {
  const { store, repo } = setup();
  const sentAt = new Date('2026-11-04T01:00:00Z'); // 水曜（日本時間 10 時。11 月 3 日の祝日の後）
  const mine: MailHead = {
    id: 's1', threadId: 'ts1', from: '三浦 <me@example.jp>', to: ['佐藤 <sato@customer.example.jp>'], cc: [], subject: '見積のご確認',
    snippet: 'ご確認のうえ、ご返信ください', receivedAt: sentAt.toISOString(), labels: ['SENT'], bulk: false,
  };
  const mail = {
    ...new MockWorkspaceConnector().mail,
    historyStart: async () => '1', historySince: async () => ({ historyId: '1', threadIds: [] }),
    threadIdsOf: async (_p: unknown, q: string) => (q.includes('in:sent') ? ['ts1'] : []),
    threadHeads: async () => [mine],
  };
  const watch = new MailWatch({ store, repo, mail, llmFor: async () => new StubLlmProvider(), isMock: () => true });
  const service = new MailService({ store, repo, mail, watch, llmFor: async () => new StubLlmProvider() });
  await watch.runFor(o, sentAt, true);
  assert.equal((await store.thread(o, 'ts1'))?.group, 'waiting');
  assert.equal((await service.overview(o, new Date('2026-11-06T03:00:00Z'))).waiting.length, 0, '金曜はまだ 2 営業日');
  assert.equal((await service.overview(o, new Date('2026-11-09T03:00:00Z'))).waiting.length, 1, '土日を飛ばして月曜で 3 営業日');
  await service.setPrefs(o, (p) => ({ ...p, waitDays: { 佐藤: 5 } }));
  assert.equal((await service.overview(o, new Date('2026-11-09T03:00:00Z'))).waiting.length, 0, '佐藤さんは 5 営業日待つ');
  assert.equal(businessDaysSince(DEFAULT_TENANT_SETTINGS.company, '2026-11-02T01:00:00Z', new Date('2026-11-04T03:00:00Z')), 1, '祝日（11 月 3 日）は数えない');
  assert.equal(waitDaysFor({ waitDays: { 佐藤: 5 } }, '佐藤 <sato@customer.example.jp>'), 5);
  assert.equal(businessDaysSince(DEFAULT_TENANT_SETTINGS.company, '2026-11-06T01:00:00Z', new Date('2026-11-09T03:00:00Z')), 1, '金曜から月曜は 1 営業日（土日を数えない）');
});

test('急ぎのもの（すぐ知らせる相手）は 1 回だけ知らせる。本人が「メール」の知らせを切っていれば作らない', async () => {
  const a = setup();
  await a.service.setPrefs(o, (p) => ({ ...p, urgentFrom: ['田中'] }));
  const now = new Date();
  await a.watch.runFor(o, now, true);
  assert.equal(a.repo.notices.filter((n) => n.kind === 'mail').length, 1);
  await a.watch.runFor(o, new Date(now.getTime() + 16 * 60_000));
  assert.equal(a.repo.notices.filter((n) => n.kind === 'mail').length, 1, '同じものを 2 度知らせない');
  const b = setup({ mailNotice: false });
  await b.service.setPrefs(o, (p) => ({ ...p, urgentFrom: ['田中'] }));
  await b.watch.runFor(o, now, true);
  assert.equal(b.repo.notices.length, 0);
});

test('送る前の控え: 宛先と本文を確かめる。送っている最中は控えを変えさせない', async () => {
  const { watch, service } = setup();
  await watch.runFor(o, new Date(), true);
  const id = (await service.overview(o)).reply[0]!.threadId;
  assert.deepEqual(await service.prepareSend(o, id, { to: [], cc: [], body: 'x' }), { error: '宛先を入れてください', status: 400 });
  const bad = await service.prepareSend(o, id, { to: ['だれか'], cc: [], body: 'x' });
  assert.ok('error' in bad && bad.status === 400);
  const ok = await service.prepareSend(o, id, { to: ['佐藤 <sato@customer.example.jp>'], cc: [], body: '承知しました。' });
  assert.ok('row' in ok && ok.row.outgoing?.subject.startsWith('Re: '));
  await service.attachSendRun(o, id, 'run-1');
  const again = await service.prepareSend(o, id, { to: ['sato@customer.example.jp'], cc: [], body: '別の本文' });
  assert.ok('error' in again && again.status === 409);
});

test('送るツールは、確かめた後に控えが変わっていたら送らない。送ったら片付く', async () => {
  const { watch, service, store, connector } = setup();
  await watch.runFor(o, new Date(), true);
  const id = (await service.overview(o)).reply[0]!.threadId;
  const ok = await service.prepareSend(o, id, { to: ['sato@customer.example.jp'], cc: [], body: '承知しました。' });
  assert.ok('row' in ok);
  const ctx = { tenantId: T, userId: U, runId: 'r', compartment: null, connector, mail: { store } } as unknown as ToolContext;
  const prepared = await mailReplySend.prepare!({ threadId: id }, ctx);
  assert.equal(prepared.kind, 'ready');
  assert.ok(prepared.kind === 'ready' && prepared.shown?.includes('承知しました。') && prepared.audience === 'external');
  const refused = await mailReplySend.invoke({ threadId: id, digest: 'changed' }, ctx) as { available: boolean };
  assert.equal(refused.available, false);
  const sent = await mailReplySend.invoke({ threadId: id, digest: outgoingDigest(ok.row.outgoing!) }, ctx) as { sent: boolean };
  assert.equal(sent.sent, true);
  assert.equal((await store.thread(o, id))?.state, 'done');
  assert.ok(connector.outbox.some((x) => x.kind === 'mail'));
});

test('「目を通すだけ」は開いたら片付く。ほかの人のスレッドは開けない', async () => {
  const { store, service } = setup();
  await store.saveThread(o, {
    threadId: 'r1', group: 'read', state: 'open', doneReason: null, doneAt: null, lastMessageId: 'm', replyToId: 'm', from: 'a', subject: '共有', summary: '',
    dueText: '', dueDate: null, lastAt: new Date().toISOString(), sentAt: null, sentTo: '', recipients: { to: [], cc: [] }, draftState: 'none', draft: '',
    outgoing: null, sendRunId: null, notifiedAt: null, updatedAt: new Date().toISOString(),
  });
  assert.equal(await service.detail({ tenantId: T, userId: 'someone-else' }, 'r1'), null);
  const d = await service.detail(o, 'r1');
  assert.equal(d?.done, true);
});

test('推論の答えが読めなければ「目を通すだけ」にする（推測で「返事が要る」にしない）', () => {
  assert.deepEqual(parseInbound('読めない', 2).map((v) => v.group), ['read', 'read']);
  const v = parseInbound('{"items":[{"i":0,"group":"reply","summary":"見積の数量を回答してほしいと言われているので、急いで返事をする必要があります","dueDate":"来週"}]}', 1)[0]!;
  assert.equal(v.group, 'reply');
  assert.ok(v.summary.length <= 30);
  assert.equal(v.dueDate, null, '日付の形でなければ期限の日付にしない');
});

test('秘書の言い回し: 止める・戻す・すぐ知らせる・待つ日数・済んだ・返事を書く・返事待ち', () => {
  assert.deepEqual(mailCommand('メールは見なくていい'), { kind: 'pause' });
  assert.deepEqual(mailCommand('またメールを見て'), { kind: 'resume' });
  assert.deepEqual(mailCommand('佐藤さんからのメールはすぐ知らせて'), { kind: 'urgent', who: '佐藤' });
  assert.deepEqual(mailCommand('佐藤さんは1週間待って'), { kind: 'wait', who: '佐藤', days: 5 });
  assert.deepEqual(mailCommand('田中さんは三日待って'), { kind: 'wait', who: '田中', days: 3 });
  assert.deepEqual(mailCommand('見積の件は済んだ'), { kind: 'done', words: '見積' });
  assert.deepEqual(mailCommand('佐藤さんへの返事を書いて'), { kind: 'reply', words: '佐藤' });
  assert.deepEqual(mailCommand('返信待ちのメールは？'), { kind: 'waiting' });
  assert.equal(mailCommand('メールをチェックして'), null, 'メールの確認は別の見分け（一覧から答える）');
});
