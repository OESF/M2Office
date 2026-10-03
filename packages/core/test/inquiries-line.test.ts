/**
 * @file 問い合わせの記録の段 3 の単体テスト（仕様書 第33.19節）。LINE 公式アカウントをつなぐ・受け口の署名を確かめる・
 * メッセージを問い合わせにする（30 日のまとめ・重複・グループの除外）・LINE の返事を承認の後に送る・よくある質問。見本の口（MockLineClient）で確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  InquiryService, MemoryInquiryStore, MockLineClient, StubLlmProvider, INQUIRY_TOOLS, guessLine, verifyLineSignature,
  type Repository, type TenantCredential, type ToolContext,
} from '../src/index.js';

function setup() {
  MockLineClient.clear();
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inquiries: { enabled: true, mailbox: null, line: null } };
  const creds = new Map<string, TenantCredential>();
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
    getUserSettings: async () => ({ profile: { timezone: 'Asia/Tokyo' }, notifications: { kinds: { inquiry: true } } }),
    createNotification: async () => {},
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
    getRun: async () => null,
  } as unknown as Repository;
  const store = new MemoryInquiryStore();
  const box = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) } as never;
  const service = new InquiryService({
    store, repo, llmFor: async () => new StubLlmProvider(),
    line: { repo, box, sourceFor: () => 'mock' },
  });
  return { service, store, settings: () => settings, creds, audits };
}

const admin = { tenantId: 't1', userId: 'boss' };
const member = { tenantId: 't1', userId: 'u1' };
const SECRET = 'line-channel-secret';

const sign = (body: string) => createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
const message = (id: string, userId: string, text: string, timestamp: number, source: Record<string, unknown> = { type: 'user', userId }) =>
  ({ type: 'message', webhookEventId: id, timestamp, source, message: { type: 'text', id: `m-${id}`, text } });

test('署名: チャネルのシークレットで本文を HMAC-SHA256 にしたものだけを通す', () => {
  const body = '{"events":[]}';
  assert.equal(verifyLineSignature(SECRET, body, sign(body)), true);
  assert.equal(verifyLineSignature(SECRET, `${body} `, sign(body)), false, '本文が 1 文字でも違えば通さない');
  assert.equal(verifyLineSignature('other', body, sign(body)), false);
  assert.equal(verifyLineSignature(SECRET, body, ''), false);
});

test('つなぐ: 受け口の鍵は 1 度だけ返し、ハッシュで会社を引く。外すと受け口も止まる', async () => {
  const { service, settings, creds, audits } = setup();
  assert.ok('error' in await service.connectLine(admin, { secret: '', token: '', mock: true }));
  const r = await service.connectLine(admin, { secret: SECRET, token: '', mock: true });
  assert.ok('key' in r);
  if (!('key' in r)) return;
  assert.equal(settings().inquiries.line?.botName, '見本の公式アカウント');
  assert.equal(settings().inquiries.line?.connectedBy, 'boss');
  assert.ok(!JSON.stringify(settings()).includes(r.key), '鍵そのものは設定に残さない');
  assert.ok(creds.has('line'));
  const body = '{"events":[]}';
  assert.deepEqual(await service.verifyLineHook(r.key, body, sign(body)), { tenantId: 't1' });
  assert.deepEqual(await service.verifyLineHook(r.key, body, 'bad'), { reason: 'signature' });
  assert.deepEqual(await service.verifyLineHook('x'.repeat(32), body, sign(body)), { reason: 'unknown' });
  await service.disconnectLine(admin);
  assert.equal(settings().inquiries.line, null);
  assert.deepEqual(await service.verifyLineHook(r.key, body, sign(body)), { reason: 'unknown' });
  assert.ok(audits.some((a) => a.action === 'inquiry.line_connect') && audits.some((a) => a.action === 'inquiry.line_disconnect'));
});

test('メッセージ: 新しい相手は問い合わせを作り、30 日以内は同じ問い合わせに足す。同じ出来事・グループのメッセージは扱わない', async () => {
  const { service, store } = setup();
  await service.connectLine(admin, { secret: SECRET, token: '', mock: true });
  const t0 = Date.parse('2026-10-05T01:00:00Z');
  const first = await service.processLine('t1', { events: [message('e1', 'Uaaaa1111', '見積もりをお願いしたいです。明日までに', t0)] }, new Date(t0));
  assert.deepEqual(first, { created: 1, appended: 0, skipped: 0 });
  const [inq] = await service.list(member, { status: 'open' });
  assert.equal(inq?.channel, 'line');
  assert.equal(inq?.from.name, 'LINE の見本（1111）');
  assert.equal(inq?.nextTask?.assignee, 'boss', '次にやることは LINE をつないだ人');
  // 同じ出来事が 2 度届いても足さない（LINE の再送）
  assert.equal((await service.processLine('t1', { events: [message('e1', 'Uaaaa1111', '見積もりをお願いしたいです。明日までに', t0)] }, new Date(t0))).skipped, 1);
  const t1 = t0 + 3 * 86_400_000;
  assert.equal((await service.processLine('t1', { events: [message('e2', 'Uaaaa1111', '追加でもう 1 点', t1)] }, new Date(t1))).appended, 1);
  assert.equal((await store.events('t1', inq!.id)).length, 2);
  // グループのメッセージは扱わない
  assert.equal((await service.processLine('t1', { events: [message('e3', 'Ubbbb2222', 'こんにちは', t1, { type: 'group', groupId: 'G1', userId: 'Ubbbb2222' })] }, new Date(t1))).skipped, 1);
  // 30 日より後は新しい問い合わせ
  const t2 = t1 + 31 * 86_400_000;
  assert.equal((await service.processLine('t1', { events: [message('e4', 'Uaaaa1111', '別の件です', t2)] }, new Date(t2))).created, 1);
  assert.equal((await service.list(member, { status: 'all' })).length, 2);
});

test('メッセージ: 続けて同時に届いても、同じ相手のメッセージは 1 つの問い合わせにまとめる', async () => {
  const { service } = setup();
  await service.connectLine(admin, { secret: SECRET, token: '', mock: true });
  const t0 = Date.parse('2026-10-05T01:00:00Z');
  const [a, b] = await Promise.all([
    service.processLine('t1', { events: [message('e1', 'Ueeee5555', 'こんにちは', t0)] }, new Date(t0)),
    service.processLine('t1', { events: [message('e2', 'Ueeee5555', '予約したいです', t0 + 1000)] }, new Date(t0 + 1000)),
  ]);
  assert.deepEqual([a.created, b.appended], [1, 1]);
  assert.equal((await service.list(member, { status: 'all' })).length, 1);
});

test('メッセージ: 健康のことが書かれていれば、本文を残さない', async () => {
  const { service, store } = setup();
  await service.connectLine(admin, { secret: SECRET, token: '', mock: true });
  const t0 = Date.parse('2026-10-05T01:00:00Z');
  await service.processLine('t1', { events: [message('e1', 'Ucccc3333', '持病の薬を飲んでいるのですが、予約できますか', t0)] }, new Date(t0));
  const [inq] = await service.list(member, { status: 'open' });
  const [ev] = await store.events('t1', inq!.id);
  assert.equal(ev?.body, null);
  assert.ok(guessLine('通院中です', { date: '2026-10-05' }).sensitive);
});

test('返事: LINE の問い合わせは LINE で返し、承認した中身だけを送る。宛先は変えられない', async () => {
  const { service, store } = setup();
  await service.connectLine(admin, { secret: SECRET, token: '', mock: true });
  const t0 = Date.now();
  await service.processLine('t1', { events: [message('e1', 'Udddd4444', '予約はできますか', t0)] }, new Date(t0));
  const [inq] = await service.list(member, { status: 'open' });
  const d = await service.draftReply(member, inq!.id);
  assert.ok('reply' in d);
  if (!('reply' in d)) return;
  assert.deepEqual([d.reply.channel, d.reply.to, d.reply.from, d.reply.subject], ['line', 'Udddd4444', '見本の公式アカウント', '']);
  assert.match(await service.updateReply(member, d.reply.id, { to: 'Uother' }) ?? '', /LINE/);
  const preview = await service.previewReply(member, d.reply.id);
  assert.deepEqual(preview?.quota, { limit: 200, used: 0 });
  const sent = await service.sendReply(member, d.reply.id, preview!.digest);
  assert.ok('sent' in sent);
  assert.deepEqual(MockLineClient.pushed('t1').map((p) => p.to), ['Udddd4444']);
  assert.equal((await store.events('t1', inq!.id)).at(-1)?.channel, 'line');
  assert.equal((await store.get('t1', inq!.id))?.nextTask, null, '返事をするは済みにした');
  // ツールは承認の前に、宛先を表示名で見せる
  const d2 = await service.draftReply(member, inq!.id);
  if (!('reply' in d2)) throw new Error('下書きを書けない');
  const ctx = { tenantId: 't1', userId: 'boss', inquiries: { service, access: async () => ({ enabled: true, mailbox: null, line: null }) } } as unknown as ToolContext;
  const prepared = await INQUIRY_TOOLS.find((t) => t.name === 'inquiries.reply_send')!.prepare!({ replyId: d2.reply.id }, ctx);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind === 'ready') assert.match(prepared.shown ?? '', /LINE の見本（4444）/);
});

test('よくある質問: 2 件以上の話題を、誰が聞いたかを入れずに返す', async () => {
  const { service } = setup();
  await service.record(member, 'いま田中さんから電話。見積もりがほしい');
  await service.record(member, 'いま佐藤さんから電話。見積もりがほしいとのこと');
  await service.record(member, 'いま鈴木さんから電話。予約をしたい');
  const topics = await service.faq(member);
  assert.deepEqual(topics, [{ topic: '見積もり', count: 2 }]);
  assert.ok(!JSON.stringify(topics).match(/田中|佐藤/));
});
