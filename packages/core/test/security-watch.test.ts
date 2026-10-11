/**
 * @file 不正の兆しの見張り（仕様書 第16.8節、ADR-0091）の確かめ。
 *
 * 大量の持ち出し・ログインの攻撃と締め出し・止めたアカウント・権限の変化・ありえない並び・ふだんと違う時間の重さの上げ方・
 * 自動のログアウト（まとまりの違う重さ高が 2 つのときだけ）・「これは大丈夫」・秘書の受け口を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type AuditEvent, type User } from '@m2office/shared';
import { MemorySecurityStore, SecurityWatch, securityRequest, answerSecurity, type Repository } from '../src/index.js';

/** 平日の昼（2026-10-14 水曜 12 時 日本時間）。 */
const NOON = new Date('2026-10-14T03:00:00Z');
/** 同じ日の深夜（23 時 日本時間）。 */
const NIGHT = new Date('2026-10-14T14:00:00Z');

const users: User[] = [
  { id: 'u-admin', tenantId: 't1', email: 'boss@example.com', displayName: '社長', roles: ['admin'], status: 'active' },
  { id: 'u-admin2', tenantId: 't1', email: 'sub@example.com', displayName: '副社長', roles: ['admin'], status: 'active' },
  { id: 'u-staff', tenantId: 't1', email: 'staff@example.com', displayName: '山田 太郎', roles: ['member'], status: 'active' },
  { id: 'u-gone', tenantId: 't1', email: 'gone@example.com', displayName: '辞めた人', roles: ['member'], status: 'disabled' },
];

function setup() {
  const audits: AuditEvent[] = [];
  const notes: { userId: string; title: string; body: string }[] = [];
  const revoked: string[] = [];
  const sessions = new Map<string, { id: string }[]>();
  const repo = {
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    listUsers: async () => users,
    searchAudit: async (_t: string, q: { from?: string; to?: string; actions?: string[] }) => audits.filter((e) =>
      (!q.from || e.occurredAt >= q.from) && (!q.to || e.occurredAt < q.to) && (!q.actions || q.actions.some((p) => e.action.startsWith(p)))),
    appendAudit: async (e: AuditEvent) => { audits.push(e); },
    createNotification: async (n: { userId: string; title: string; body: string }) => { notes.push(n); },
    listSessions: async (_t: string, userId: string) => sessions.get(userId) ?? [],
    revokeSession: async (_t: string, id: string) => { revoked.push(id); },
  } as unknown as Repository;
  const store = new MemorySecurityStore();
  const watch = new SecurityWatch({ repo, store });
  let seq = 0;
  const ev = (action: string, at: Date, p: Partial<AuditEvent> = {}): AuditEvent => {
    const e: AuditEvent = { id: `e${++seq}`, tenantId: 't1', actorType: 'user', actorId: 'u-staff', action, targetType: 'x', targetId: '', detail: {}, occurredAt: at.toISOString(), ...p };
    audits.push(e);
    store.audits.push({ tenantId: 't1', action: e.action, targetId: e.targetId, occurredAt: e.occurredAt });
    return e;
  };
  const ago = (base: Date, min: number) => new Date(base.getTime() - min * 60_000);
  return { watch, store, audits, notes, revoked, sessions, ev, ago };
}

test('大量の持ち出し: 500 件以上の書き出しは重さ高で管理者全員に知らせ、二度は知らせない', async () => {
  const { watch, notes, audits, ev, ago } = setup();
  ev('contact.export', ago(NOON, 3), { detail: { count: 800, format: 'csv' } });
  ev('inventory.export', ago(NOON, 2), { detail: { rows: 20 } });
  const r = await watch.scan('t1', NOON);
  assert.deepEqual(r.found.map((s) => [s.type, s.severity]), [['export', 'high']]);
  assert.deepEqual(notes.map((n) => n.userId).sort(), ['u-admin', 'u-admin2']);
  assert.match(notes[0]!.body, /山田 太郎さんが 800 件を書き出しました/);
  assert.ok(audits.some((a) => a.action === 'security.signal' && a.detail['type'] === 'export'));
  assert.equal((await watch.scan('t1', new Date(NOON.getTime() + 5 * 60_000))).found.length, 0, '同じ書き出しは二度知らせない');
});

test('ログインの攻撃: 同じアドレスの拒否が 10 分に 5 回で知らせ、30 分締め出す。止めたアカウントは 1 回で重さ高', async () => {
  const { watch, ev, ago, store } = setup();
  for (let i = 0; i < 5; i++) ev('auth.login.denied', ago(NOON, 9 - i), { actorType: 'user', actorId: 'system', targetId: 'evil@other.example', detail: { kind: 'domain' } });
  assert.equal(await watch.afterDenial('t1', 'evil@other.example', NOON), true, '5 回に達したら締め出す');
  store.audits.push({ tenantId: 't1', action: 'auth.login.locked', targetId: 'evil@other.example', occurredAt: NOON.toISOString() });
  assert.equal(await watch.loginLocked('t1', 'EVIL@other.example', new Date(NOON.getTime() + 10 * 60_000)), true);
  assert.equal(await watch.loginLocked('t1', 'evil@other.example', new Date(NOON.getTime() + 31 * 60_000)), false, '30 分で解ける');
  ev('auth.login.denied', ago(NOON, 1), { actorId: 'system', targetId: 'gone@example.com', detail: { kind: 'disabled' } });
  const r = await watch.scan('t1', NOON);
  const types = r.found.map((s) => `${s.type}:${s.severity}`).sort();
  assert.deepEqual(types, ['login_burst:medium', 'login_disabled:high']);
  assert.equal(r.found.find((s) => s.type === 'login_disabled')!.userId, 'u-gone');
});

test('ふだんと違う時間: 単独では兆しにならず、ほかの兆しの重さを 1 段上げる', async () => {
  const { watch, ev, ago } = setup();
  for (let i = 0; i < 5; i++) ev('auth.login.denied', ago(NIGHT, 9 - i), { actorId: 'system', targetId: 'x@other.example', detail: { kind: 'domain' } });
  const r = await watch.scan('t1', NIGHT);
  assert.equal(r.found.length, 1);
  assert.equal(r.found[0]!.severity, 'high', '深夜なので中が高になる');
  assert.equal(r.found[0]!.detail['offHours'], true);
});

test('権限の変化: 管理者が増えたら必ず知らせる（変える前のロールが分からない古い記録は数えない）', async () => {
  const { watch, ev, ago } = setup();
  ev('user.update', ago(NOON, 4), { actorId: 'u-admin2', targetId: 'u-staff', detail: { roles: ['admin', 'member'], rolesBefore: ['member'], status: 'active' } });
  ev('user.update', ago(NOON, 3), { actorId: 'u-admin2', targetId: 'u-staff', detail: { roles: ['admin'], status: 'active' } });
  ev('user.invite', ago(NOON, 2), { actorId: 'u-admin2', targetId: 'u-new', detail: { roles: ['member'] } });
  const r = await watch.scan('t1', NOON);
  assert.deepEqual(r.found.map((s) => s.type), ['admin_added']);
  assert.equal(r.found[0]!.userId, 'u-admin2', '対象は追加した人');
});

test('自動のログアウト: まとまりの違う重さ高が 2 つ重なったときだけ。同じ行動の二重の兆しでは止めない', async () => {
  const one = setup();
  for (let i = 0; i < 3; i++) one.ev('contact.export', one.ago(NOON, 10 - i), { detail: { count: 600 } });
  one.sessions.set('u-staff', [{ id: 's1' }]);
  const r1 = await one.watch.scan('t1', NOON);
  assert.ok(r1.found.some((s) => s.type === 'export') && r1.found.some((s) => s.type === 'export_burst'));
  assert.deepEqual(r1.signedOut, [], '持ち出しだけなら止めない');

  const two = setup();
  two.ev('contact.export', two.ago(NOON, 5), { actorId: 'u-admin2', detail: { count: 900 } });
  two.ev('user.update', two.ago(NOON, 4), { actorId: 'u-admin2', targetId: 'u-staff', detail: { roles: ['admin'], rolesBefore: ['member'] } });
  two.sessions.set('u-admin2', [{ id: 's-a' }, { id: 's-b' }]);
  const r2 = await two.watch.scan('t1', NOON);
  assert.deepEqual(r2.signedOut, ['u-admin2']);
  assert.deepEqual(two.revoked.sort(), ['s-a', 's-b']);
  assert.ok(two.notes.some((n) => /自動でログアウトさせた/.test(n.title)));
  assert.ok(two.audits.some((a) => a.action === 'security.auto_signout'));
  assert.equal((await two.watch.scan('t1', new Date(NOON.getTime() + 5 * 60_000))).signedOut.length, 0, '同じ 1 時間に二度は止めない');
});

test('ありえない並び: 同じ種類の端末 2 つが同時に使われ、片方が新しければ本人に知らせる（パソコンとスマホは知らせない）', async () => {
  const { watch, store, notes } = setup();
  const pc = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile';
  store.sessions = [
    { tenantId: 't1', id: 'old', userId: 'u-staff', userAgent: pc, createdAt: '2026-10-01T00:00:00Z', lastSeenAt: new Date(NOON.getTime() - 60_000).toISOString() },
    { tenantId: 't1', id: 'new', userId: 'u-staff', userAgent: pc, createdAt: new Date(NOON.getTime() - 3_600_000).toISOString(), lastSeenAt: NOON.toISOString() },
    { tenantId: 't1', id: 'p1', userId: 'u-admin', userAgent: pc, createdAt: '2026-10-01T00:00:00Z', lastSeenAt: NOON.toISOString() },
    { tenantId: 't1', id: 'p2', userId: 'u-admin', userAgent: phone, createdAt: new Date(NOON.getTime() - 600_000).toISOString(), lastSeenAt: NOON.toISOString() },
  ];
  const r = await watch.scan('t1', NOON);
  assert.deepEqual(r.found.map((s) => [s.type, s.userId]), [['new_device', 'u-staff']]);
  assert.deepEqual(notes.map((n) => n.userId), ['u-staff'], '本人にだけ知らせる');
  assert.match(notes[0]!.title, /新しいパソコンでログインしました/);
});

test('これは大丈夫: 同じ人・同じ型を 30 日知らせない。秘書の受け口は管理者だけ', async () => {
  const { watch, ev, ago, notes, sessions } = setup();
  ev('contact.export', ago(NOON, 3), { detail: { count: 700 } });
  await watch.scan('t1', NOON);
  const deps = { watch, repo: (watch as unknown as { deps: { repo: Repository } }).deps.repo };
  assert.match(await answerSecurity(deps, 't1', 'u-staff', { kind: 'list' }, NOON) ?? '', /管理者だけ/);
  assert.match(await answerSecurity(deps, 't1', 'u-admin', { kind: 'list' }, NOON) ?? '', /大きな書き出し（山田 太郎さん）/);
  assert.match(await answerSecurity(deps, 't1', 'u-admin', { kind: 'dismiss', name: '山田' }, NOON) ?? '', /30 日のあいだ知らせません/);
  const before = notes.length;
  ev('contact.export', ago(NOON, -1), { detail: { count: 900 } });
  assert.equal((await watch.scan('t1', new Date(NOON.getTime() + 2 * 60_000))).found.length, 0);
  assert.equal(notes.length, before);
  sessions.set('u-staff', [{ id: 's9' }]);
  assert.match(await answerSecurity(deps, 't1', 'u-admin', { kind: 'signout', name: '山田' }, NOON) ?? '', /端末 1 つをすべてログアウト/);
  assert.match(await answerSecurity(deps, 't1', 'u-admin', { kind: 'stop', name: '山田' }, NOON) ?? '', /ユーザーと権限/);
  assert.equal(await answerSecurity(deps, 't1', 'u-admin', { kind: 'stop', name: '佐藤' }, NOON), null, '名前の人がいない「止めて」はふつうの会話に回す');
});

test('秘書の依頼の見分け方: 決まった言い方だけを受ける', () => {
  assert.deepEqual(securityRequest('セキュリティの知らせは？'), { kind: 'list' });
  assert.deepEqual(securityRequest('不正の兆しを教えて'), { kind: 'list' });
  assert.deepEqual(securityRequest('山田さんの端末をすべてログアウトして'), { kind: 'signout', name: '山田' });
  assert.deepEqual(securityRequest('これは大丈夫です'), { kind: 'dismiss', name: null });
  assert.deepEqual(securityRequest('山田さんのは大丈夫'), { kind: 'dismiss', name: '山田' });
  assert.deepEqual(securityRequest('山田さんを止めて'), { kind: 'stop', name: '山田' });
  assert.equal(securityRequest('セキュリティの設定の方法は？'), null);
  assert.equal(securityRequest('大丈夫？'), null);
  assert.equal(securityRequest('明日の会議は大丈夫かな'), null);
});

test('ダッシュボードの様子: 見回るたびに時刻を残し、15 分を過ぎたら止まっているとする。数と種類だけを返す', async () => {
  const { watch, ev, ago } = setup();
  assert.equal((await watch.status('t1', NOON)).state, 'never');
  ev('contact.export', ago(NOON, 3), { detail: { count: 700 } });
  await watch.scan('t1', NOON);
  const s = await watch.status('t1', new Date(NOON.getTime() + 60_000));
  assert.equal(s.state, 'watching');
  assert.equal(s.lastScanAt, NOON.toISOString());
  assert.equal(s.signals24h, 1);
  assert.equal(s.high24h, 1);
  assert.deepEqual(s.last, { label: '大きな書き出し', at: NOON.toISOString(), severity: 'high' });
  assert.ok(!JSON.stringify(s).includes('u-staff'), '誰かは返さない');
  assert.equal((await watch.status('t1', new Date(NOON.getTime() + 16 * 60_000))).state, 'stale');
});

test('段 2 の大量に開く: 1 時間に 200 件以上で、会社のふだんの 5 倍以上のときだけ知らせる。数だけを持ち、7 日で消す', async () => {
  const { watch, store, notes } = setup();
  // ふだん: 人と 1 時間あたり 60 件ほど（5 倍は 300 件）
  for (let d = 1; d <= 3; d++) for (let i = 0; i < 60; i++) await watch.recordView('t1', 'u-admin', 'contact', new Date(NOON.getTime() - d * 86_400_000));
  for (let i = 0; i < 250; i++) await watch.recordView('t1', 'u-staff', 'contact', new Date(NOON.getTime() - 10 * 60_000));
  assert.equal((await watch.scan('t1', NOON)).found.length, 0, '200 件を超えても、ふだんの 5 倍に届かなければ知らせない');
  for (let i = 0; i < 100; i++) await watch.recordView('t1', 'u-staff', 'inquiry', new Date(NOON.getTime() - 5 * 60_000));
  const r = await watch.scan('t1', new Date(NOON.getTime() + 60_000));
  assert.deepEqual(r.found.map((s) => [s.type, s.userId, s.detail['count']]), [['mass_view', 'u-staff', 350]]);
  assert.match(notes.at(-1)!.body, /350 件の記録/);
  await watch.recordView('t1', 'app:x', 'contact', NOON);
  assert.ok(![...store.views.keys()].some((k) => k.includes('app:x')), '外部のアプリは数えない');
  await watch.scan('t1', new Date(NOON.getTime() + 8 * 86_400_000));
  assert.equal(store.views.size, 0, '7 日を過ぎた数は消す');
});
