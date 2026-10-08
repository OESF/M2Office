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
  const sessions = new Map<string, string>();
  const created: NewTenantInput[] = [];
  const audits: string[] = [];
  const reports: MachineReport[] = [];
  let n = 0;
  const store = {
    listOperators: async () => ops,
    findOperatorByEmail: async (e: string) => ops.find((o) => o.email === e) ?? null,
    findOperator: async (id: string) => ops.find((o) => o.id === id) ?? null,
    createSession: async (operatorId: string) => { const token = `tok-${++n}`; sessions.set(token, operatorId); return { token, session: { id: `s-${n}`, operatorId, csrfToken: `csrf-${n}`, expiresAt: '' } }; },
    findSession: async (token: string) => {
      const id = sessions.get(token);
      const op = ops.find((o) => o.id === id);
      return op ? { session: { id: token, operatorId: op.id, csrfToken: `csrf-${token.slice(4)}`, expiresAt: '' }, operator: op } : null;
    },
    revokeSession: async () => undefined,
    audit: async (_op: string, action: string) => { audits.push(action); },
    tenantOverview: async () => [],
    createTenant: async (input: NewTenantInput) => { created.push(input); return `t-${input.subdomain}`; },
    receiveReport: async (token: string, r: MachineReport) => { if (token !== 'machine-key') return null; reports.push(r); return 'm-1'; },
  } as unknown as OpsStore;
  return { store, created, audits, reports };
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
