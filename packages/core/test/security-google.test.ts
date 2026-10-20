/**
 * @file 不正の兆しの見張りの段 3（Google Workspace のログインの記録の取り込み。仕様書 第16.8.6節、ADR-0092）の確かめ。
 *
 * Reports API の答えから IP を捨てて読むこと、取り込むできごとと重さ（第16.8.6.2節）、M2Office の利用者だけを見ること、
 * Google が乗っ取り・パスワードの漏洩で止めたらすぐにログアウトさせること、Google の異変と M2Office の中の持ち出しの重なり、
 * ログインの失敗は 10 分に 5 回からだけ、同じ記録を二重に数えないこと、読めないときは兆しにせず 1 日 1 回まで知らせること、
 * ダッシュボードの状態と秘書の一言を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type AuditEvent, type User } from '@m2office/shared';
import {
  MemorySecurityStore, MockGoogleLoginSource, SecurityWatch, answerSecurity, parseLoginActivities, GoogleLoginError,
  type GoogleLoginAccess, type GoogleLoginEvent, type GoogleLoginSource, type Repository,
} from '../src/index.js';

/** 平日の昼（2026-10-14 水曜 12 時 日本時間）。 */
const NOON = new Date('2026-10-14T03:00:00Z');

const users: User[] = [
  { id: 'u-admin', tenantId: 't1', email: 'boss@example.com', displayName: '社長', roles: ['admin'], status: 'active' },
  { id: 'u-admin2', tenantId: 't1', email: 'sub@example.com', displayName: '副社長', roles: ['admin'], status: 'active' },
  { id: 'u-staff', tenantId: 't1', email: 'staff@example.com', displayName: '山田 太郎', roles: ['member'], status: 'active' },
];

function setup(access: () => GoogleLoginAccess) {
  const audits: AuditEvent[] = [];
  const notes: { userId: string; title: string; body: string }[] = [];
  const revoked: string[] = [];
  const sessions = new Map<string, { id: string }[]>([['u-staff', [{ id: 's1' }, { id: 's2' }]]]);
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
  const watch = new SecurityWatch({ repo, store, google: async () => access() });
  return { watch, store, audits, notes, revoked, repo };
}

const at = (min: number) => new Date(NOON.getTime() - min * 60_000).toISOString();
const ev = (id: string, name: string, min: number, email = 'staff@example.com', suspicious = false): GoogleLoginEvent => ({ id, name, at: at(min), email, suspicious });
const connected = (source: GoogleLoginSource): GoogleLoginAccess => ({ state: 'connected', source, email: 'boss@example.com', assigneeId: 'u-admin' });

test('Reports API の答えから、できごと・人・時刻・番号だけを読み、IP やほかの値は持たない', () => {
  const parsed = parseLoginActivities([{
    id: { time: '2026-10-14T02:50:00.000Z', uniqueQualifier: '-123', applicationName: 'login' },
    actor: { email: 'Staff@Example.com', profileId: '999' }, ipAddress: '203.0.113.5',
    events: [{ type: 'login', name: 'login_success', parameters: [{ name: 'is_suspicious', boolValue: true }, { name: 'login_type', value: 'google_password' }] }],
  }]);
  assert.deepEqual(parsed, [{ id: '-123:login_success', at: '2026-10-14T02:50:00.000Z', email: 'staff@example.com', name: 'login_success', suspicious: true }]);
  assert.ok(!JSON.stringify(parsed).includes('203.0.113.5'), 'IP は読まない');
});

test('取り込むできごとだけを重さつきで兆しにし、M2Office の利用者だけを見る。ふだんのログインの成功は取り込まない', async () => {
  const source = new MockGoogleLoginSource([
    ev('a:login_success', 'login_success', 10, 'staff@example.com', true),
    ev('b:login_success', 'login_success', 9),
    ev('c:email_forwarding_out_of_domain', 'email_forwarding_out_of_domain', 8, 'sub@example.com'),
    ev('d:2sv_disable', '2sv_disable', 7, 'boss@example.com'),
    ev('e:account_disabled_hijacked', 'account_disabled_hijacked', 6, 'outsider@example.com'),
    ev('f:logout', 'logout', 5),
  ]);
  const { watch, notes } = setup(() => connected(source));
  const r = await watch.scan('t1', NOON);
  assert.deepEqual(r.found.map((s) => [s.type, s.severity, s.userId]).sort(), [
    ['google_2sv_off', 'medium', 'u-admin'], ['google_forwarding', 'high', 'u-admin2'], ['google_suspicious_login', 'high', 'u-staff'],
  ]);
  assert.ok(notes.some((n) => /管理コンソール/.test(n.body)), '勧める対応に管理コンソールでの確かめを入れる');
  assert.equal((await watch.scan('t1', new Date(NOON.getTime() + 5 * 60_000))).found.length, 0, '重ねて読んだ同じ記録は二重に数えない');
});

test('Google が乗っ取り・パスワードの漏洩でアカウントを止めたら、重なりを待たずに M2Office の端末をすべてログアウトさせる', async () => {
  const { watch, revoked, audits, notes } = setup(() => connected(new MockGoogleLoginSource([ev('h:account_disabled_hijacked', 'account_disabled_hijacked', 3)])));
  const r = await watch.scan('t1', NOON);
  assert.deepEqual(r.signedOut, ['u-staff']);
  assert.deepEqual(revoked.sort(), ['s1', 's2']);
  assert.ok(r.found.some((s) => s.type === 'google_hijacked' && s.severity === 'high'));
  assert.ok(audits.some((a) => a.action === 'security.auto_signout' && (a.detail['because'] as string[]).includes('google_hijacked')));
  assert.ok(notes.some((n) => /Google が山田 太郎さんのアカウントを止めたため/.test(n.body)));
});

test('Google の異変と M2Office の中の大きな書き出しが同じ人に重なれば、自動でログアウトさせる', async () => {
  const { watch, audits, revoked } = setup(() => connected(new MockGoogleLoginSource([ev('s:login_success', 'login_success', 20, 'staff@example.com', true)])));
  audits.push({ id: 'x1', tenantId: 't1', actorType: 'user', actorId: 'u-staff', action: 'contact.export', targetType: 'x', targetId: '', detail: { count: 900 }, occurredAt: at(5) });
  const r = await watch.scan('t1', NOON);
  assert.deepEqual(r.signedOut, ['u-staff']);
  assert.equal(revoked.length, 2);
});

test('ログインの失敗は、同じ人が 10 分に 5 回以上のときだけ', async () => {
  const four = [1, 2, 3, 4].map((i) => ev(`f${i}:login_failure`, 'login_failure', 10 - i));
  const a = setup(() => connected(new MockGoogleLoginSource(four)));
  assert.equal((await a.watch.scan('t1', NOON)).found.length, 0);
  const b = setup(() => connected(new MockGoogleLoginSource([...four, ev('f5:login_failure', 'login_failure', 5)])));
  assert.deepEqual((await b.watch.scan('t1', NOON)).found.map((s) => [s.type, s.severity]), [['google_login_failures', 'medium']]);
});

test('読めないときは兆しにせず、担当と管理者に 1 日 1 回まで知らせ、状態を「読めていません」にする。読めたら戻る', async () => {
  let fail = true;
  const source: GoogleLoginSource = { list: async () => { if (fail) throw new GoogleLoginError('担当の Google の許可が切れています', 'auth'); return []; } };
  const { watch, notes, repo } = setup(() => connected(source));
  assert.equal((await watch.scan('t1', NOON)).found.length, 0);
  assert.deepEqual(notes.filter((n) => n.title === 'Google のログインの記録を読めていません').map((n) => n.userId).sort(), ['u-admin', 'u-admin2']);
  await watch.scan('t1', new Date(NOON.getTime() + 5 * 60_000));
  assert.equal(notes.filter((n) => n.title === 'Google のログインの記録を読めていません').length, 2, '同じ日には二度知らせない');
  assert.equal((await watch.status('t1', NOON)).google, 'error');
  assert.match(await answerSecurity({ watch, repo }, 't1', 'u-admin', { kind: 'list' }) ?? '', /読めていません/);
  fail = false;
  await watch.scan('t1', new Date(NOON.getTime() + 10 * 60_000));
  assert.equal((await watch.status('t1', NOON)).google, 'connected');
});

test('使えない会社は状態を出さず、担当がいなければ秘書が Google の管理者に接続してもらうよう伝える', async () => {
  const na = setup(() => ({ state: 'na' }));
  assert.equal((await na.watch.status('t1', NOON)).google, null);
  const none = setup(() => ({ state: 'disconnected' }));
  assert.equal((await none.watch.status('t1', NOON)).google, 'disconnected');
  assert.match(await answerSecurity({ watch: none.watch, repo: none.repo }, 't1', 'u-admin', { kind: 'list' }) ?? '', /Google の管理者の人に/);
});
