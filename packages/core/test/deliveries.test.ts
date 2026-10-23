/**
 * @file 外部のアプリからの配信の依頼（仕様書 第13.4.4節、Q-254）の確かめ。
 *
 * 受け付けの確かめ（承認した機能・LINE は受けない・人数の上限・宛先の ID の形・差し込めない名前・窓口のアカウント）、
 * 承認の業務を始めること（社内のアドレス 1 人は承認なし）、承認の画面に宛先を出さないこと、差し込みと HTML・ロゴの埋め込み・
 * 宛先の ID 入りの停止の宛先、送り終えたら名前とアドレスを消すこと、結果と停止を取りに来る口（印・done）、
 * 却下の扱い、停止の返信（+stop・差出人のアドレス）と送れなかった知らせ、問い合わせにしないメールの見分け、1 日の上限、30 日で消すことを見る。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent, DeliveryResultsPage, DeliveryStopsPage, Run, User } from '@m2office/shared';
import {
  DeliveryService, MemoryDeliveryStore, MockMailbox, renderTemplate, isStopReply, isBounce, unsubscribeAddress, stopRecipientOf, bouncedRecipientOf,
  type AppRecord, type Mailbox, type MailItem, type Repository,
} from '../src/index.js';
import { buildRawMessage } from '../src/connectors/google/mime.js';

const NOW = new Date('2026-10-23T01:00:00Z');
const MAILBOX = 'info@clinic.example.jp';
const HOUR = 3_600_000;

const users: User[] = [{ id: 'u-admin', tenantId: 't1', email: 'boss@clinic.example.jp', displayName: '院長', roles: ['admin'], status: 'active' }];

function app(over: Partial<AppRecord> = {}): AppRecord {
  return {
    id: 'app1', name: 'M2Medical', keyHash: 'x', status: 'active', functions: ['deliveries.send'], settings: { deliveries: { maxRecipients: 500 } },
    catalogRemoved: [], approvedBy: 'u-admin', approvedAt: NOW.toISOString(), createdBy: 'u-admin', createdAt: NOW.toISOString(), lastUsedAt: null, ...over,
  };
}

function setup(o: { mailbox?: Mailbox | null; app?: AppRecord } = {}) {
  const audits: AuditEvent[] = [];
  const runs = new Map<string, Run>();
  const repo = {
    findTenantById: async () => ({ id: 't1', workspaceDomain: 'clinic.example.jp' }),
    listUsers: async () => users,
    getRun: async (_t: string, id: string) => runs.get(id) ?? null,
    appendAudit: async (e: AuditEvent) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryDeliveryStore();
  const started: string[] = [];
  const mailbox = o.mailbox === undefined ? new MockMailbox(MAILBOX) : o.mailbox;
  const svc = new DeliveryService({
    store, repo, box: { encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`, decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString() },
    apps: { get: async () => o.app ?? app() },
    mailbox: async () => mailbox,
    startApproval: async (_t, id) => { started.push(id); const runId = `run-${id}`; runs.set(runId, { id: runId, status: 'awaiting_approval' } as Run); return runId; },
  });
  return { svc, store, audits, runs, started };
}

const request = (over: Record<string, unknown> = {}) => ({
  requestId: 'rd-1', title: 'インフルリピート', channel: 'mail', sendAt: null,
  template: {
    subject: '{{clinic_name}} から予防接種のご案内',
    html: '<p>{{name}} 様</p><img src="cid:logo"><p><a href="{{unsubscribe_url}}">配信停止</a>（{{unsubscribe_address}}）</p>',
    text: '{{name}} 様\n予防接種のご案内です。\n配信停止: {{unsubscribe_url}}', line: null,
  },
  values: { clinic_name: '見本クリニック' },
  logo: { contentType: 'image/png', base64: Buffer.from('PNGDATA').toString('base64'), cid: 'logo' },
  recipients: [
    { recipientId: 'r1', name: '試験 花子', email: 'hanako@mail.example' },
    { recipientId: 'r2', name: '試験 <太郎>', email: 'taro@mail.example' },
    { recipientId: 'r3', name: '形の違う人', email: 'not-an-address' },
  ],
  ...over,
});

/** 承認して全員に送り終えるまで見回る。 */
async function sendAll(s: ReturnType<typeof setup>, id: string, from = NOW): Promise<number> {
  await s.svc.approved('t1', 'u-admin', id);
  let t = from.getTime();
  for (let i = 0; i < 5; i++) { await s.svc.tick('t1', new Date(t)); t += 4000; }
  return t;
}

const page = async (s: ReturnType<typeof setup>, after: string | null, now: Date) => (await s.svc.results('t1', 'app1', 'rd-1', after, now)) as DeliveryResultsPage;

beforeEach(() => MockMailbox.clear());

test('差し込み・停止の宛先・停止の返信と送れなかった知らせの見分け', () => {
  assert.equal(renderTemplate('{{name}} 様 {{x}}', { name: 'A&<B>' }, true), 'A&amp;&lt;B&gt; 様 {{x}}', 'HTML の値は文字に直し、知らない名前は残す');
  assert.equal(renderTemplate('{{ name }}', { name: '{{clinic_name}}' }, false), '{{clinic_name}}', '値の中は差し込み直さない');
  assert.ok(isStopReply('Re: ご案内', '配信停止をお願いします') && isStopReply('配信停止', '') && !isStopReply('Re: ご案内', 'ありがとうございました'));
  assert.ok(isBounce('mailer-daemon@mail.example', 'Delivery Status Notification (Failure)') && !isBounce('hanako@mail.example', 'Re: ご案内'));
  assert.equal(unsubscribeAddress(MAILBOX, '3f9a'), 'mailto:info+stop-3f9a@clinic.example.jp?subject=%E9%85%8D%E4%BF%A1%E5%81%9C%E6%AD%A2');
  assert.equal(unsubscribeAddress(MAILBOX, 'x'.repeat(64)), `mailto:${MAILBOX}?subject=%E9%85%8D%E4%BF%A1%E5%81%9C%E6%AD%A2`, '@ の前が 64 文字を超えるなら + を付けない');
  assert.equal(stopRecipientOf(['Info+Stop-3f9a@clinic.example.jp'], MAILBOX), '3f9a');
  assert.equal(stopRecipientOf(['other+stop-3f9a@clinic.example.jp', MAILBOX], MAILBOX), null, 'ほかのアドレスの +stop は読まない');
  assert.equal(bouncedRecipientOf('...\nX-M2O-Recipient: r2\nSubject: x'), 'r2');
});

test('受け付けない: LINE・人数の上限・宛先の ID の形・差し込めない名前・窓口のアカウントが無い・承認していない', async () => {
  const s = setup();
  const code = async (over: Record<string, unknown>) => ((await s.svc.accept('t1', 'app1', request(over), NOW)) as { code?: string }).code;
  assert.equal(await code({ channel: 'line' }), 'channel-unsupported');
  assert.equal(await code({ requestId: 'big', recipients: Array.from({ length: 501 }, (_, i) => ({ recipientId: `r${i}`, name: 'x', email: `x${i}@mail.example` })) }), 'too-many');
  assert.equal(await code({ recipients: [{ recipientId: 'a b', name: 'x', email: 'x@mail.example' }] }), 'invalid');
  assert.equal(await code({ recipients: [{ recipientId: 'x'.repeat(65), name: 'x', email: 'x@mail.example' }] }), 'invalid');
  assert.equal(await code({ template: { subject: '{{unknown}}', html: '', text: 'x', line: null } }), 'unknown-placeholder');
  assert.equal(await code({ values: { unsubscribe_address: 'x' } }), 'invalid');
  assert.equal(((await setup({ mailbox: null }).svc.accept('t1', 'app1', request(), NOW)) as { code: string }).code, 'no-mailbox');
  assert.equal(((await setup({ app: app({ functions: [] }) }).svc.accept('t1', 'app1', request(), NOW)) as { status: number }).status, 404);
  assert.equal(s.started.length, 0, '受け付けなければ承認も始めない');
});

test('受けたら承認の業務を始め、承認の画面には人数と見本だけを出す（宛先の名前とアドレスは出さない）', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok && r.status === 'awaiting_approval');
  assert.equal(s.started.length, 1);
  const p = await s.svc.preview('t1', r.deliveryId);
  assert.ok('shown' in p);
  assert.match(p.shown, /宛先: 2 人（ほかにアドレスの形が違う 1 人は送りません）/);
  assert.match(p.shown, /見本クリニック から予防接種のご案内/);
  assert.match(p.shown, /（宛先の名前） 様/);
  assert.ok(!/花子|太郎|hanako|taro/.test(p.shown), '宛先の名前とアドレスは承認の画面に出さない');
  assert.ok(!JSON.stringify(s.audits).match(/花子|hanako/), '監査ログにも宛先を出さない');
  assert.ok(s.store.recipients.every((x) => x.contactEnc === null || (x.contactEnc.startsWith('enc:') && !x.contactEnc.includes('hanako'))), '宛先は暗号化して持つ');
  assert.equal(s.store.recipients.find((x) => x.recipientId === 'r3')!.contactEnc, null, '形の違うアドレスは持たない');
  assert.equal(((await s.svc.accept('t1', 'app1', request(), NOW)) as { status: number }).status, 409, '同じ requestId は受けない');
});

test('承認の後に 1 人 1 通ずつ送り（HTML・文字・ロゴ・宛先の ID 入りの停止の宛先）、送り終えたら名前とアドレスを消す', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  await sendAll(s, r.deliveryId);
  const sent = MockMailbox.sent(MAILBOX) as (MailItem & { html?: string; headers?: Record<string, string>; listUnsubscribe?: string })[];
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), ['hanako@mail.example', 'taro@mail.example'], '形の違うアドレスには送らない');
  const taro = sent.find((m) => m.to[0] === 'taro@mail.example')!;
  assert.equal(taro.subject, '見本クリニック から予防接種のご案内');
  assert.match(taro.body, /^試験 <太郎> 様/);
  assert.match(taro.html ?? '', /試験 &lt;太郎&gt; 様/);
  assert.ok((taro.html ?? '').includes('mailto:info+stop-r2@clinic.example.jp?subject='), '宛先の ID 入りの停止の宛先を差し込む');
  assert.ok((taro.html ?? '').includes(`（${MAILBOX}）`), '窓口のアドレスを差し込む');
  assert.equal(taro.listUnsubscribe, 'mailto:info+stop-r2@clinic.example.jp?subject=%E9%85%8D%E4%BF%A1%E5%81%9C%E6%AD%A2');
  assert.deepEqual(taro.headers, { 'X-M2O-Recipient': 'r2' });
  assert.equal((await s.store.get('t1', r.deliveryId))!.status, 'done');
  assert.ok(s.store.recipients.every((x) => x.contactEnc === null), '送り終えたら名前とアドレスを消す');
  assert.ok(s.store.recipients.filter((x) => x.status === 'sent').every((x) => x.emailHash && x.hashUntil), '照合の値は期限つきで残す');
});

test('結果を取りに来る口: 印で続きだけを渡し、送り終えて 24 時間たつまで done にしない', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  const before = await page(s, null, NOW);
  assert.deepEqual(before.results.map((x) => `${x.recipientId}:${x.status}:${x.reason}`), ['r3:failed:invalid-address'], '形の違うアドレスはすぐ結果にする');
  assert.equal(before.done, false);
  const t = await sendAll(s, r.deliveryId);
  const next = await page(s, before.next, new Date(t));
  assert.deepEqual(next.results.map((x) => `${x.recipientId}:${x.status}`).sort(), ['r1:sent', 'r2:sent'], '印より後だけを渡す');
  assert.equal(next.done, false, '送り終えてすぐは done にしない（送れなかった知らせを待つ）');
  const again = await page(s, next.next, new Date(t + 1000));
  assert.deepEqual(again.results, []);
  assert.equal(again.next, next.next, '新しい結果が無ければ印はそのまま');
  assert.equal((await page(s, next.next, new Date(t + 25 * HOUR))).done, true);
  assert.equal((await page(s, null, new Date(t + 25 * HOUR))).results.length, 3, '最初から取り直せる');
  assert.equal(((await s.svc.results('t1', 'app1', 'rd-1', 'x', NOW)) as { status: number }).status, 400, '形の違う印は断る');
  assert.equal(((await s.svc.results('t1', 'app1', 'nope', null, NOW)) as { status: number }).status, 404);
  assert.equal(((await s.svc.results('t1', 'app2', 'rd-1', null, NOW)) as { status: number }).status, 404, 'ほかのアプリの配信は渡さない');
});

test('社内のアドレス 1 人は承認なしで送る。テスト送信（test: true）は結果を持たない', async () => {
  const s = setup();
  const one = [{ recipientId: 'me', name: '職員', email: 'staff@clinic.example.jp' }];
  assert.equal(((await s.svc.accept('t1', 'app1', request({ requestId: 'test-x', test: true, recipients: [...one, { recipientId: 'b', name: 'b', email: 'b@clinic.example.jp' }] }), NOW)) as { code: string }).code, 'invalid');
  const r = await s.svc.accept('t1', 'app1', request({ requestId: 'test-2', test: true, recipients: one }), NOW);
  assert.ok(r.ok && r.status === 'scheduled');
  assert.equal(s.started.length, 0);
  await s.svc.tick('t1', NOW);
  assert.equal(MockMailbox.sent(MAILBOX).length, 1);
  const res = (await s.svc.results('t1', 'app1', 'test-2', null, new Date(NOW.getTime() + 1000))) as DeliveryResultsPage;
  assert.deepEqual(res.results, []);
  assert.equal(res.done, true);
});

test('却下されたら、全員を送れなかった（rejected）とし、すぐ done にする', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  s.runs.set(`run-${r.deliveryId}`, { id: `run-${r.deliveryId}`, status: 'cancelled' } as Run);
  await s.svc.tick('t1', NOW);
  assert.equal(MockMailbox.sent(MAILBOX).length, 0);
  const res = await page(s, null, NOW);
  assert.deepEqual(res.results.map((x) => x.reason).sort(), ['invalid-address', 'rejected', 'rejected']);
  assert.equal(res.done, true);
  assert.ok(s.store.recipients.every((x) => x.contactEnc === null && x.emailHash === null), '却下したら宛先を残さない');
});

test('配信の停止: +stop の返信は宛先の ID で、差出人のアドレスで照らせた返信もその ID で、照らせなければアドレスで渡す', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  const t = await sendAll(s, r.deliveryId);
  const later = new Date(t + 60_000);
  const mail = (id: string, from: string, to: string, subject: string, body = '') =>
    MockMailbox.deliver(MAILBOX, { id, from, fromAddress: from, to: [to], subject, body, date: later.toISOString() });
  mail('stop-1', 'someone@other.example', 'info+stop-r2@clinic.example.jp', 'Re: ご案内', 'よろしく');
  mail('stop-2', 'hanako@mail.example', MAILBOX, '配信停止');
  mail('stop-3', 'unknown@mail.example', MAILBOX, '配信停止');
  mail('chat', 'friend@mail.example', MAILBOX, 'こんにちは', '来週の件');
  MockMailbox.deliver(MAILBOX, { id: 'news', from: 'news@shop.example', fromAddress: 'news@shop.example', to: [MAILBOX], subject: '配信停止のご案内', body: '', date: later.toISOString(), bulk: true });
  assert.equal(await s.svc.readMail('t1', later), 3);
  assert.equal(await s.svc.readMail('t1', new Date(later.getTime() + 1000)), 0, '同じ返信を 2 度入れない');
  const stops = (await s.svc.stops('t1', 'app1', null)) as DeliveryStopsPage;
  assert.deepEqual(stops.stops.map((x) => ('recipientId' in x ? x.recipientId : x.email)).sort(), ['r1', 'r2', 'unknown@mail.example']);
  assert.deepEqual(((await s.svc.stops('t1', 'app1', stops.next)) as DeliveryStopsPage).stops, [], '印より後だけを渡す');
  assert.deepEqual(((await s.svc.stops('t1', 'app2', null)) as DeliveryStopsPage).stops, [], 'ほかのアプリには渡さない');
  const res = await page(s, null, later);
  assert.deepEqual(res.results.filter((x) => x.status === 'stopped').map((x) => `${x.recipientId}:${x.channel}`).sort(), ['r1:mail', 'r2:mail'], '結果にも停止を入れる');
  assert.ok(!s.store.stopRows.some((x) => x.emailEnc?.includes('unknown')), '差出人のアドレスは暗号化して持つ');
});

test('送れなかった知らせは、元の見出しの宛先の ID か照合の値で探す。問い合わせにしないメールを見分ける', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  const t = await sendAll(s, r.deliveryId);
  const later = new Date(t + 60_000);
  const daemon = 'mailer-daemon@mail.example';
  MockMailbox.deliver(MAILBOX, { id: 'b1', from: daemon, fromAddress: daemon, to: [MAILBOX], subject: 'Delivery Status Notification (Failure)', body: 'X-M2O-Recipient: r2', date: later.toISOString() });
  MockMailbox.deliver(MAILBOX, { id: 'b2', from: daemon, fromAddress: daemon, to: [MAILBOX], subject: 'Undelivered Mail', body: 'Address not found: hanako@mail.example', date: later.toISOString() });
  assert.equal(await s.svc.readMail('t1', later), 2);
  const res = await page(s, null, later);
  assert.deepEqual(res.results.filter((x) => x.reason === 'bounced').map((x) => x.recipientId).sort(), ['r1', 'r2']);
  const item = (to: string, subject: string, body = '', from = 'a@mail.example') => ({ id: 'x', threadId: 'x', from, fromName: '', fromAddress: from, replyAddress: from, to: [to], subject, date: '', messageIdHeader: '', references: '', body, bulk: false });
  assert.equal(await s.svc.mailKind('t1', item('info+stop-r1@clinic.example.jp', 'Re: ご案内'), MAILBOX, later), '配信の停止の返信');
  assert.equal(await s.svc.mailKind('t1', item(MAILBOX, '配信停止'), MAILBOX, later), '配信の停止の返信');
  assert.equal(await s.svc.mailKind('t1', item(MAILBOX, 'Delivery Status Notification', 'X-M2O-Recipient: r1', daemon), MAILBOX, later), '配信の送れなかった知らせ');
  assert.equal(await s.svc.mailKind('t1', item(MAILBOX, '見積もりのお願い'), MAILBOX, later), null, 'ふつうの問い合わせは問い合わせにする');
});

test('照合の値は 3 日、結果は送り終えてから 30 日で消す', async () => {
  const s = setup();
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  const t = await sendAll(s, r.deliveryId);
  await s.svc.tick('t1', new Date(t + 4 * 86_400_000));
  assert.ok(s.store.recipients.every((x) => x.emailHash === null), '3 日で照合の値を消す');
  assert.equal(s.store.recipients.length, 3, '結果は残す');
  await s.svc.tick('t1', new Date(t + 31 * 86_400_000));
  assert.equal(s.store.recipients.length, 0, '30 日で結果を消す');
  assert.equal((await s.store.get('t1', r.deliveryId))!.purged, true);
  const gone = (await s.svc.results('t1', 'app1', 'rd-1', null, new Date(t + 31 * 86_400_000))) as DeliveryResultsPage;
  assert.deepEqual(gone, { results: [], next: null, done: true });
});

test('窓口のアカウントの 1 日の上限（1,000 通）に達していれば送らない', async () => {
  const full: Mailbox = Object.assign(new MockMailbox(MAILBOX), { countSent: async () => 1000 });
  const s = setup({ mailbox: full });
  const r = await s.svc.accept('t1', 'app1', request(), NOW);
  assert.ok(r.ok);
  await s.svc.approved('t1', 'u-admin', r.deliveryId);
  await s.svc.tick('t1', NOW);
  assert.equal(MockMailbox.sent(MAILBOX).length, 0);
  assert.equal((await s.store.get('t1', r.deliveryId))!.status, 'sending', '送る残りがあるまで待つ');
});

test('メールの組み立て: 文字と HTML の両方・ロゴの埋め込み（cid）・返信で止める見出し（mailto）・X- の見出しだけを足す', () => {
  const raw = Buffer.from(buildRawMessage({
    to: ['a@mail.example'], cc: [], subject: '件名', body: '本文', html: '<p>本文</p><img src="cid:logo">',
    inline: [{ cid: 'logo', mime: 'image/png', bytes: Buffer.from('PNG') }], listUnsubscribe: 'mailto:info+stop-r1@clinic.example.jp?subject=%E9%85%8D%E4%BF%A1%E5%81%9C%E6%AD%A2',
    headers: { 'X-M2O-Recipient': 'r1', 'Bcc': 'evil@mail.example' },
  }), 'base64url').toString('utf8');
  assert.match(raw, /Content-Type: multipart\/related; boundary=/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary=/);
  assert.match(raw, /Content-Type: text\/html; charset=UTF-8/);
  assert.match(raw, /Content-ID: <logo>/);
  assert.match(raw, /List-Unsubscribe: <mailto:info\+stop-r1@clinic\.example\.jp\?subject=/);
  assert.ok(!/List-Unsubscribe-Post/.test(raw), 'mailto には押すだけで止まる見出しを付けない');
  assert.match(raw, /X-M2O-Recipient: r1/);
  assert.ok(!/Bcc:/.test(raw), 'X- で始まらない見出しは足さない');
});
