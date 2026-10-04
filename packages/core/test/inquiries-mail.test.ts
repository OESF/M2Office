/**
 * @file 問い合わせの記録の段 2 の単体テスト（仕様書 第33.18節）。窓口のアカウントをつなぐ・メールを読んで問い合わせにする・
 * 問い合わせでないものと戻す・送信済みを履歴にする・返事の下書きと承認の後に送る・月の振り返り。見本の箱（MockMailbox）で確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Notification, type TenantSettings } from '@m2office/shared';
import {
  InquiryService, InquiryWatch, MemoryInquiryStore, MockMailbox, StubLlmProvider, INQUIRY_TOOLS, guessMail, monthStats, reviewText, sentSummary,
  type Repository, type TenantCredential, type ToolContext,
} from '../src/index.js';

function setup(opts: { closureOn?: (tenantId: string, day: string) => Promise<{ startDate: string; endDate: string } | null> } = {}) {
  MockMailbox.clear();
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inquiries: { enabled: true, mailbox: null } };
  const creds = new Map<string, TenantCredential>();
  const notes: Notification[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '受付', roles: ['member'], status: 'active' },
  ];
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    getTenantCredential: async (_t: string, kind: string) => creds.get(kind) ?? null,
    saveTenantCredential: async (c: TenantCredential) => { creds.set(c.kind, c); },
    deleteTenantCredential: async (_t: string, kind: string) => creds.delete(kind),
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    listUserGroupIds: async () => [],
    listTenantIds: async () => ['t1'],
    getUserSettings: async () => ({ profile: { timezone: 'Asia/Tokyo' }, notifications: { kinds: { inquiry: true } } }),
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
    getRun: async () => null,
  } as unknown as Repository;
  const store = new MemoryInquiryStore();
  const service = new InquiryService({
    store, repo, llmFor: async () => new StubLlmProvider(),
    mailbox: { repo, box: { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) } as never, sourceFor: () => 'mock' },
    ...(opts.closureOn ? { closureOn: opts.closureOn } : {}),
  });
  return { service, store, repo, notes, audits, settings: () => settings, creds };
}

const admin = { tenantId: 't1', userId: 'boss' };
const member = { tenantId: 't1', userId: 'u1' };

test('窓口のアカウント: 会社のドメインのアカウントだけをつなぎ、外すとすぐに読まなくなる', async () => {
  const { service, settings, creds, audits } = setup();
  assert.match((await service.connectMailbox(admin, { email: 'someone@gmail.example', refreshToken: null }))!, /会社のドメインのアカウントではありません/);
  assert.equal(await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null }), null);
  assert.equal(settings().inquiries.mailbox?.email, 'info@alpha.example.jp');
  assert.equal(settings().inquiries.mailbox?.connectedBy, 'boss');
  assert.ok(creds.has('inquiry_mailbox'));
  await service.disconnectMailbox(admin);
  assert.equal(settings().inquiries.mailbox, null);
  assert.equal((await service.ingest('t1')).created, 0, '外すと読まない');
  assert.ok(audits.some((a) => a.action === 'inquiry.mailbox_connect') && audits.some((a) => a.action === 'inquiry.mailbox_disconnect'));
});

test('決まった言葉で読む: メールマガジン・営業の売り込みは問い合わせにせず、フォームの通知はお客様の名前とメールを本文から取る', () => {
  const box = new MockMailbox('info@alpha.example.jp');
  const today = { date: '2026-10-07' };
  return (async () => {
    const ids = await box.list('inbox', new Date(0), 10);
    const mails = await Promise.all(ids.map((id) => box.get(id)));
    const read = mails.map((m) => guessMail(m!, today));
    const byId = Object.fromEntries(mails.map((m, i) => [m!.id.split('-').at(-1), read[i]!]));
    assert.equal(byId['news']!.isInquiry, false);
    assert.match(byId['news']!.reason, /メールマガジン/);
    assert.equal(byId['sales']!.isInquiry, false);
    assert.equal(byId['sales']!.reason, '営業の売り込み');
    assert.equal(byId['form']!.channel, 'form');
    assert.deepEqual([byId['form']!.from.name, byId['form']!.from.email, byId['form']!.from.phone, byId['form']!.source], ['山本 太郎', 'yamamoto@example.com', '03-5555-0101', '検索']);
    assert.equal(byId['direct']!.from.email, 'sasaki@example.net');
    assert.equal(byId['direct']!.source, '紹介');
  })();
});

test('読む: 問い合わせを作り、問い合わせでないものは一覧に残して戻せる。同じメールは 2 度読まない', async () => {
  const { service, store, audits } = setup();
  await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  const first = await service.ingest('t1');
  assert.deepEqual([first.created, first.skipped], [2, 2]);
  assert.deepEqual(await service.ingest('t1'), { created: 0, appended: 0, skipped: 0, sent: 0 }, '同じメールは 2 度読まない');
  const list = await service.list(member, { status: 'open' });
  const form = list.find((i) => i.channel === 'form')!;
  const direct = list.find((i) => i.channel === 'mail')!;
  assert.equal(form.from.name, '山本 太郎');
  assert.equal(form.receivedByName, '窓口のアカウント');
  assert.equal(form.nextTask?.assignee, 'boss', 'メールから生まれた次にやることは窓口の担当（つないだ管理者）');
  const ev = (await store.events('t1', direct.id))[0]!;
  assert.equal(ev.body, null, 'メールの本文は写さない');
  assert.equal(ev.mail?.to, 'sales@alpha.example.jp', '届いた宛先（別名）を残す');
  const opened = await service.mailOf(member, ev.id);
  assert.ok('body' in opened && opened.body.includes('見積もり'), 'メールは開いたときに窓口のアカウントから読む');
  const skipped = await service.skippedMails(member);
  assert.equal(skipped.length, 2);
  const promoted = await service.promoteMail(member, skipped.find((m) => /営業/.test(m.reason))!.messageId);
  assert.ok('id' in promoted);
  assert.equal((await service.skippedMails(member)).length, 1);
  assert.ok(audits.some((a) => a.action === 'inquiry.mail_create'));
  assert.ok(!JSON.stringify(audits).includes('山本'), '監査ログにお客様の名前を残さない');
});

test('返事: 下書きは届いた宛先（別名）から返す形にし、承認した中身だけを送る。送ったら履歴に足し、返事の次にやることを済みにする', async () => {
  const { service, store } = setup();
  await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  await service.ingest('t1');
  const direct = (await service.list(member, { status: 'open' })).find((i) => i.channel === 'mail')!;
  const d = await service.draftReply(member, direct.id);
  assert.ok('reply' in d);
  if (!('reply' in d)) return;
  assert.deepEqual([d.reply.to, d.reply.from, d.reply.subject], ['sasaki@example.net', 'sales@alpha.example.jp', 'Re: 見積もりのお願い']);
  assert.match(d.reply.body, /佐々木 花子 様/);
  assert.equal(await service.updateReply(member, d.reply.id, { to: 'あて先' }), '宛先のメールアドレスが読めません');
  const before = await service.previewReply(member, d.reply.id);
  assert.equal(await service.updateReply(member, d.reply.id, { body: `${d.reply.body}\n（直しました）` }), null);
  const stale = await service.sendReply(member, d.reply.id, before!.digest);
  assert.ok('error' in stale && /承認した後に返事が直された/.test(stale.error), '承認の後に直されたら送らない');
  const now = await service.previewReply(member, d.reply.id);
  const sent = await service.sendReply(member, d.reply.id, now!.digest);
  assert.ok('sent' in sent);
  const events = await store.events('t1', direct.id);
  assert.equal(events.at(-1)?.direction, 'out');
  assert.equal((await store.get('t1', direct.id))?.nextTask, null, '返事をするは済みにした');
  assert.equal((await store.replies('t1', direct.id))[0]?.status, 'sent');
  assert.equal(await service.updateReply(member, d.reply.id, { body: 'x' }), '送った返事は直せません');
  // 送信済みを読んでも 2 度足さない
  await service.ingest('t1');
  assert.equal((await store.events('t1', direct.id)).filter((e) => e.direction === 'out').length, 1);
});

test('返事: フォームの問い合わせは本文のメールアドレスに返し、窓口のアカウントをつないでいなければ下書きを書かない', async () => {
  const { service } = setup();
  await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  await service.ingest('t1');
  const form = (await service.list(member, { status: 'open' })).find((i) => i.channel === 'form')!;
  const d = await service.draftReply(member, form.id);
  assert.ok('reply' in d && d.reply.to === 'yamamoto@example.com' && d.reply.from === 'info@alpha.example.jp');
  await service.disconnectMailbox(admin);
  const none = await service.draftReply(member, form.id);
  assert.ok('error' in none && /窓口のアカウントをつないでいない/.test(none.error));
});

test('月の振り返り: 数はプログラムで数え、毎月 1 日の朝に管理者と窓口の担当へ 1 回だけ知らせる', async () => {
  const { service, store, repo, notes } = setup();
  await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  await service.ingest('t1');
  await service.record(member, 'いま田中さんから電話。見積もりがほしい');
  const month = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
  const stats = await monthStats(store, 't1', month);
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byChannel, { form: 1, mail: 1, phone: 1 });
  assert.equal(stats.byMailTo['sales@alpha.example.jp'], 1);
  assert.match(reviewText(stats), /問い合わせは 3 件でした/);
  // 翌月の 1 日の朝（日本時間 9 時）
  const [y, m] = month.split('-').map(Number) as [number, number];
  const firstDay = new Date(Date.UTC(y, m, 1, 0));
  const watch = new InquiryWatch({ store, repo });
  await watch.tick(firstDay);
  const review = notes.filter((n) => /問い合わせの振り返り/.test(n.title));
  assert.equal(review.length, 1, '管理者（窓口の担当と同じ人）に 1 回');
  assert.match(review[0]!.body, /3 件/);
  await watch.tick(firstDay);
  assert.equal(notes.filter((n) => /問い合わせの振り返り/.test(n.title)).length, 1, '同じ月は 2 度知らせない');
});

test('ツール: 朝のブリーフは本人が担当の期限と返事待ちを返し、振り返りは数を返す。送るツールは承認の前に中身を見せる', async () => {
  const { service } = setup();
  await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  await service.ingest('t1');
  const ctx = (userId: string) => ({ tenantId: 't1', userId, inquiries: { service, access: async () => ({ enabled: true, mailbox: null }) } } as unknown as ToolContext);
  const brief = INQUIRY_TOOLS.find((t) => t.name === 'inquiries.brief')!;
  const b = await brief.invoke({}, ctx('boss')) as { waitingReply: { count: number } };
  assert.equal(b.waitingReply.count, 2);
  const review = INQUIRY_TOOLS.find((t) => t.name === 'inquiries.review')!;
  const r = await review.invoke({ month: new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7) }, ctx('u1')) as { total: number };
  assert.equal(r.total, 2);
  const direct = (await service.list(member, { status: 'open' })).find((i) => i.channel === 'mail')!;
  const d = await service.draftReply(member, direct.id);
  if (!('reply' in d)) throw new Error('下書きを書けない');
  const send = INQUIRY_TOOLS.find((t) => t.name === 'inquiries.reply_send')!;
  const prepared = await send.prepare!({ replyId: d.reply.id }, ctx('boss'));
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') return;
  assert.match(prepared.shown ?? '', /宛先: sasaki@example.net/);
  assert.equal(prepared.audience, 'external');
  assert.equal(sentSummary({ subject: 's', body: 'お世話になります。\n> 前のメール' } as never), 'お世話になります。');
});

test('休業中に届いた問い合わせ: 「〇日から順にお返事します」の返事の下書きを用意する（送るのは承認の後。第35.7節）', async () => {
  const { service, store, audits } = setup({ closureOn: async () => ({ startDate: '2026-12-28', endDate: '2027-01-05' }) });
  await service.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  await service.ingest('t1');
  const direct = (await service.list(member, { status: 'open' })).find((i) => i.channel === 'mail')!;
  const replies = await store.replies('t1', direct.id);
  assert.equal(replies.length, 1, '下書きを 1 つ用意する');
  assert.equal(replies[0]!.status, 'draft', '送らない');
  assert.match(replies[0]!.body, /12 月 28 日（月）〜1 月 5 日（火）は休業/);
  assert.match(replies[0]!.body, /1 月 6 日（水）から順にお返事/);
  assert.ok(audits.some((a) => a.action === 'inquiry.closure_reply'));
  // 休業でなければ下書きを作らない
  const { service: s2, store: st2 } = setup({ closureOn: async () => null });
  await s2.connectMailbox(admin, { email: 'info@alpha.example.jp', refreshToken: null });
  await s2.ingest('t1');
  const d2 = (await s2.list(member, { status: 'open' })).find((i) => i.channel === 'mail')!;
  assert.equal((await st2.replies('t1', d2.id)).length, 0);
});

test('返事から会社の知識にする: ほかのお客様にも答えられる情報だけを、名前と連絡先を除いて登録し、重ねない（第33.20節）', async () => {
  const saved: { title: string; body: string; source: string; kind: string }[] = [];
  let answer = '{"knowledge":true,"title":"駐車場はありますか？","body":"問い: 駐車場はありますか？\\n答え: 建物の裏に 3 台分あります。電話 090-1234-5678 の佐藤様のように満車のときは近くのコインパーキングをご案内します"}';
  const llm = { name: 'fake', complete: async () => ({ text: answer, tokensUsed: 1 }) };
  const { service, store, repo } = setup();
  Object.assign(repo, {
    listKnowledge: async () => saved,
    saveKnowledge: async (k: { title: string; body: string; source: string; kind: string }) => { saved.push(k); },
  });
  (service as unknown as { deps: { llmFor: unknown } }).deps.llmFor = async () => llm;
  const id = await store.create('t1', { channel: 'phone', summary: '駐車場の有無', category: '問い合わせ', from: { name: '佐藤', email: '', phone: '' }, source: '検索', createdBy: 'u1' } as never);
  const k = await service.learnFromReply('t1', { inquiryId: id, body: '建物の裏に 3 台分あります。' });
  assert.ok(k);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.source, '問い合わせの返事から');
  assert.ok(!saved[0]!.body.includes('090-1234-5678'), '電話番号は除く');
  assert.equal(await service.learnFromReply('t1', { inquiryId: id, body: '同じ返事' }), null, '同じ題名は重ねない');
  answer = '{"knowledge":false}';
  assert.equal(await service.learnFromReply('t1', { inquiryId: id, body: '日程を調整します' }), null, '本人だけの返事は知識にしない');
  assert.equal(saved.length, 1);
});
