/**
 * @file マスター管理画面の API（仕様書 第23.8.15節）の確かめ。データベースの代わりに手元の見本の口を使う。
 *
 * `ops.` の名前の要求だけを受けること、ログインと CSRF が要ること、ロールでできることが分かれること、
 * 会社を作ったらログインの URL と案内の文を返すこと、稼働の知らせを機械の鍵で受けることを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, type MachineReport, type NewTenantInput, type Operator, type OpsStore } from '@m2office/core';
import { opsApp, isOpsHost, tenantLoginUrl, OPS_COOKIE } from '../src/ops/app.js';

/** 手元の見本の口（運営の表の代わり）。 */
function fakeStore() {
  const ops: Operator[] = [
    { id: 'op-admin', email: 'admin@ops.example', displayName: '管理', role: 'admin', status: 'active', createdAt: '', lastLoginAt: null },
    { id: 'op-mon', email: 'mon@ops.example', displayName: '監視', role: 'monitor', status: 'active', createdAt: '', lastLoginAt: null },
  ];
  const sessions = new Map<string, { operatorId: string; verified: boolean }>();
  const passkeys: { id: string; operatorId: string; publicKey: string; counter: number; transports: string[]; name: string }[] = [];
  const codes = new Map<string, string>([['op-mon', 'GOOD-CODE-0001']]);
  const created: NewTenantInput[] = [];
  const audits: string[] = [];
  const reports: MachineReport[] = [];
  let n = 0;
  const store = {
    listOperators: async () => ops,
    findOperatorByEmail: async (e: string) => ops.find((o) => o.email === e) ?? null,
    findOperator: async (id: string) => ops.find((o) => o.id === id) ?? null,
    createSession: async (operatorId: string, _p: string, _ua: string | null, _ttl: number, verified = false) => {
      const token = `tok-${++n}`; sessions.set(token, { operatorId, verified });
      return { token, session: { id: token, operatorId, csrfToken: `csrf-${n}`, expiresAt: '', verified } };
    },
    findSession: async (token: string) => {
      const s = sessions.get(token);
      const op = ops.find((o) => o.id === s?.operatorId);
      return op && s ? { session: { id: token, operatorId: op.id, csrfToken: `csrf-${token.slice(4)}`, expiresAt: '', verified: s.verified }, operator: { ...op, passkeyCount: passkeys.filter((k) => k.operatorId === op.id).length } } : null;
    },
    markSessionVerified: async (id: string) => { const s = sessions.get(id); if (s) s.verified = true; },
    listPasskeys: async (operatorId: string) => passkeys.filter((k) => k.operatorId === operatorId).map((k) => ({ ...k, createdAt: '', lastUsedAt: null })),
    addPasskey: async (operatorId: string, p: { id: string; publicKey: string; counter: number; transports: string[]; name: string }) => { passkeys.push({ ...p, operatorId }); },
    touchPasskey: async () => undefined,
    checkEnrollCode: async (operatorId: string, code: string, consume: boolean) => { const ok = codes.get(operatorId) === code; if (ok && consume) codes.delete(operatorId); return ok; },
    revokeSession: async () => undefined,
    audit: async (_op: string, action: string) => { audits.push(action); },
    createTenant: async (input: NewTenantInput) => { created.push(input); return `t-${input.subdomain}`; },
    tenantDetail: async (id: string) => (id === 't-acme' ? { tenant: { id, subdomain: 'acme' } } : null),
    listAuditFor: async () => [],
    tenantOverview: async () => [{ name: '=cmd', subdomain: 'acme', workspaceDomain: null, status: 'trial', createdAt: '', usersActive: 0, usersInvited: 0, users30d: 0, lastUsedAt: null,
      runsToday: 0, runs30d: 0, runsFailed30d: 0, conversations30d: 0, aiCostMonth: 0, filesBytes: 0, extensions: 0, googleConnections: 0 }],
    setOperatorProfile: async () => undefined,
    requestStatus: async (_t: string, kind: string) => { audits.push(`store:${kind}`); return 'req-1'; },
    listStatusRequests: async () => [{ id: 'req-1', tenantId: 't-acme', tenantName: 'アクメ', kind: 'lock', reasonCode: 'abuse', reason: 'x', state: 'done', effectiveAt: null }],
    receiveReport: async (token: string, r: MachineReport) => { if (token !== 'machine-key') return null; reports.push(r); return 'm-1'; },
  } as unknown as OpsStore;
  return { store, created, audits, reports, sessions, passkeys, codes };
}

const config = { login: null, googleDomain: null, devLogin: true, cookieSecure: false, sessionTtlHours: 12 };
const log = createLogger({ service: 'test', level: 'error', format: 'json', write: () => undefined });
const OPS = { host: 'ops.lvh.me:3100' };

/** 開発用ログインで入り、Cookie と CSRF の値を返す。 */
async function login(app: ReturnType<typeof opsApp>, email: string) {
  const res = await app.request('/v1/ops/auth/dev-login', { method: 'POST', headers: { ...OPS, 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  assert.ok(cookie.startsWith(`${OPS_COOKIE}=`));
  const { csrfToken } = await res.json() as { csrfToken: string };
  return { cookie, csrfToken };
}

test('名前: ops. のときだけ。会社のログインの URL は ops. を会社のサブドメインに替える', () => {
  assert.equal(isOpsHost('ops.lvh.me:3100'), true);
  assert.equal(isOpsHost('ops.example.online'), true);
  assert.equal(isOpsHost('a.lvh.me:3100'), false);
  assert.equal(isOpsHost('localhost:3102'), false);
  assert.equal(tenantLoginUrl('https://ops.lvh.me:3100', 'acme'), 'https://acme.lvh.me:3100/');
});

test('ops. 以外の名前とログインの無い要求は断る。書き換えには CSRF の値が要る', async () => {
  const { store } = fakeStore();
  const app = opsApp({ store, config, log });
  assert.equal((await app.request('/v1/ops/tenants', { headers: { host: 'a.lvh.me:3100' } })).status, 404);
  assert.equal((await app.request('/v1/ops/tenants', { headers: OPS })).status, 401);
  const { cookie } = await login(app, 'admin@ops.example');
  assert.equal((await app.request('/v1/ops/tenants', { headers: { ...OPS, cookie } })).status, 200);
  const res = await app.request('/v1/ops/tenants', { method: 'POST', headers: { ...OPS, cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('会社を作る: 入力を確かめ、ログインの URL と案内の文を返す。監視のロールは作れない', async () => {
  const { store, created, audits } = fakeStore();
  const app = opsApp({ store, config, log });
  const admin = await login(app, 'admin@ops.example');
  const post = (who: { cookie: string; csrfToken: string }, body: unknown) => app.request('/v1/ops/tenants', {
    method: 'POST', headers: { ...OPS, origin: 'https://ops.lvh.me:3100', cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(admin, { subdomain: 'ops', name: 'x', domain: 'x.example', admin: 'a@x.example' })).status, 400);
  assert.equal((await post(admin, { subdomain: 'acme', name: 'アクメ', domain: 'acme.example', admin: 'boss@other.example' })).status, 400);
  const res = await post(admin, { subdomain: 'Acme', name: 'アクメ', domain: 'acme.example', admin: 'Boss@acme.example', status: 'trial' });
  assert.equal(res.status, 201);
  const body = await res.json() as { loginUrl: string; welcome: string };
  assert.equal(body.loginUrl, 'https://acme.lvh.me:3100/');
  assert.match(body.welcome, /boss@acme\.example/);
  assert.equal(created[0]?.subdomain, 'acme');
  assert.ok(audits.includes('tenant.create'));
  const mon = await login(app, 'mon@ops.example');
  assert.equal((await post(mon, { subdomain: 'beta', name: 'b', domain: 'b.example', admin: 'a@b.example' })).status, 403);
});

test('稼働の知らせ: 機械の鍵で受け、形の違うもの・違う鍵・大きすぎるものは断る', async () => {
  const { store, reports } = fakeStore();
  const app = opsApp({ store, config, log });
  const report = {
    machineId: 'm-1', version: '0.18.0', at: '2026-10-08T01:00:00Z', parts: { database: true, worker: true, entrance: true, localAi: null },
    backup: { configured: true, lastAt: '2026-10-08T00:00:00Z', lastOk: true, restoreOk: null }, disk: { dataFree: 1, dataTotal: 2, backupFree: null },
    cert: { daysLeft: 60 }, update: { lastAt: null, lastResult: null, version: null }, injected: '指示として読まないこと',
  };
  const send = (key: string, body: string) => app.request('/v1/ops/heartbeat', { method: 'POST', headers: { ...OPS, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body });
  assert.equal((await send('wrong', JSON.stringify(report))).status, 401);
  assert.equal((await send('machine-key', '{"x":1}')).status, 400);
  assert.equal((await send('machine-key', 'x'.repeat(20_000))).status, 413);
  assert.equal((await send('machine-key', JSON.stringify(report))).status, 200);
  assert.equal(reports.length, 1);
  assert.equal('injected' in reports[0]!, false);
});

test('会社の詳細と CSV は開いたことを残す。運営主体の設定は運営管理者だけ', async () => {
  const { store, audits } = fakeStore();
  const app = opsApp({ store, config, log });
  const admin = await login(app, 'admin@ops.example');
  assert.equal((await app.request('/v1/ops/tenants/t-none', { headers: { ...OPS, cookie: admin.cookie } })).status, 404);
  assert.equal((await app.request('/v1/ops/tenants/t-acme', { headers: { ...OPS, cookie: admin.cookie } })).status, 200);
  const csv = await app.request('/v1/ops/tenants.csv', { headers: { ...OPS, cookie: admin.cookie } });
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(await csv.text(), /'=cmd/);
  assert.ok(audits.includes('tenant.view') && audits.includes('tenants.export'));
  const put = (who: { cookie: string; csrfToken: string }, body: unknown) => app.request('/v1/ops/settings/operator', {
    method: 'PUT', headers: { ...OPS, cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await put(admin, { nameJa: '運営', web: 'http://x' })).status, 400);
  assert.equal((await put(admin, { nameJa: '運営', web: 'https://ops.example' })).status, 200);
  const mon = await login(app, 'mon@ops.example');
  assert.equal((await put(mon, { nameJa: 'x' })).status, 403);
});

test('停止と再開: 監視は緊急停止だけ。理由の種類を確かめ、緊急停止は会社へ渡す案内の文を返す', async () => {
  const { store, audits } = fakeStore();
  const app = opsApp({ store, config, log });
  const mon = await login(app, 'mon@ops.example');
  const post = (who: { cookie: string; csrfToken: string }, body: unknown) => app.request('/v1/ops/tenants/t-acme/requests', {
    method: 'POST', headers: { ...OPS, cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(mon, { kind: 'suspend', reasonCode: 'unpaid', reason: 'x' })).status, 403);
  assert.equal((await post(mon, { kind: 'lock', reasonCode: 'unpaid', reason: 'x' })).status, 400);
  const res = await post(mon, { kind: 'lock', reasonCode: 'abuse', reason: '不審なログイン' });
  assert.equal(res.status, 201);
  assert.match((await res.json() as { notice: string }).notice, /アクメ ご担当者様[\s\S]*不正利用/);
  assert.ok(audits.includes('store:lock') && audits.includes('tenant.lock_request'));
});

/** パスキーの手続きの代わり（本物の端末を使わずに、登録と確かめの流れを見る）。 */
const fakeWebAuthn = {
  registrationOptions: async () => ({ challenge: 'reg-challenge' }),
  verifyRegistration: async (o: { expectedChallenge: string; expectedRPID?: string }) => {
    assert.equal(o.expectedChallenge, 'reg-challenge');
    assert.equal(o.expectedRPID, 'ops.lvh.me');
    return { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } };
  },
  authenticationOptions: async () => ({ challenge: 'auth-challenge' }),
  verifyAuthentication: async (o: { expectedChallenge: string }) => ({ verified: o.expectedChallenge === 'auth-challenge', authenticationInfo: { newCounter: 1 } }),
} as never;

test('パスキー: 確かめるまでは何もできず、登録の合言葉で登録し、次からはパスキーで確かめる', async () => {
  const f = fakeStore();
  const app = opsApp({ store: f.store, config, log, webauthn: fakeWebAuthn });
  // Google のあとの（確かめていない）ログイン状態を作る
  const { token } = await f.store.createSession('op-mon', 'google', null, 12, false);
  const h = { ...OPS, origin: 'https://ops.lvh.me:3100', cookie: `${OPS_COOKIE}=${token}`, 'x-csrf-token': `csrf-${token.slice(4)}`, 'content-type': 'application/json' };
  assert.equal((await app.request('/v1/ops/tenants', { headers: h })).status, 401);
  const me = await (await app.request('/v1/ops/me', { headers: h })).json() as { verified: boolean; passkeyCount: number };
  assert.deepEqual([me.verified, me.passkeyCount], [false, 0]);
  // 合言葉が違えば登録の問いかけを出さない
  assert.equal((await app.request('/v1/ops/passkey/register-options', { method: 'POST', headers: h, body: JSON.stringify({ code: 'BAD' }) })).status, 403);
  assert.equal((await app.request('/v1/ops/passkey/register-options', { method: 'POST', headers: h, body: JSON.stringify({ code: 'GOOD-CODE-0001' }) })).status, 200);
  const reg = await app.request('/v1/ops/passkey/register', { method: 'POST', headers: h, body: JSON.stringify({ response: { id: 'cred-1' }, name: '会社の端末', code: 'GOOD-CODE-0001' }) });
  assert.equal(reg.status, 200);
  assert.equal(f.passkeys.length, 1);
  assert.equal(f.codes.has('op-mon'), false);
  assert.equal((await app.request('/v1/ops/tenants', { headers: h })).status, 200);
  // 次のログインでは、パスキーで確かめる（合言葉では登録し直せない）
  const next = await f.store.createSession('op-mon', 'google', null, 12, false);
  const h2 = { ...h, cookie: `${OPS_COOKIE}=${next.token}`, 'x-csrf-token': `csrf-${next.token.slice(4)}` };
  assert.equal((await app.request('/v1/ops/passkey/register-options', { method: 'POST', headers: h2, body: JSON.stringify({ code: 'GOOD-CODE-0001' }) })).status, 409);
  assert.equal((await app.request('/v1/ops/passkey/verify', { method: 'POST', headers: h2, body: JSON.stringify({ response: { id: 'cred-1' } }) })).status, 400);
  assert.equal((await app.request('/v1/ops/passkey/options', { method: 'POST', headers: h2, body: '{}' })).status, 200);
  assert.equal((await app.request('/v1/ops/passkey/verify', { method: 'POST', headers: h2, body: JSON.stringify({ response: { id: 'cred-1' } }) })).status, 200);
  assert.equal((await app.request('/v1/ops/tenants', { headers: h2 })).status, 200);
  assert.ok(f.audits.includes('passkey.add') && f.audits.includes('passkey.verify'));
});
