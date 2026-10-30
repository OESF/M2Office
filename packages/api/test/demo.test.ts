/**
 * @file 体験版の入口（仕様書 第23.3.2節、ADR-0115）の確かめ。
 * 入口の名前の判定・証明書・ゲストのログイン（ID とパスワード・間違いの止め・見本のデータを最初に 1 度だけ入れる・ログイン状態の長さ）・
 * ログイン状態からの会社の決め方（Google のログインは受けない・体験用の会社しか決まらない）・止める操作・
 * 自分で申し込む口（ロボットよけ・1 度だけの問題・入力・断った理由・その場でのログイン。第23.3.2節「自分で申し込む」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { Session, Tenant } from '@m2office/shared';
import { hashMachinePassword, MemoryDemoStore } from '@m2office/core';
import { demoLoginRoute, DemoLoginThrottle, demoProviders, demoSignupRoute, isDemoHost } from '../src/demo.js';
import { tlsAllowed } from '../src/routes/tls-ask.js';
import { demoRestrictions, resolveTenant, type AppEnv } from '../src/middleware/tenant.js';
import { sessionIdOf } from '../src/auth/session.js';
import type { AppDeps } from '../src/context.js';

const BASE = 'm2office.net';

test('入口は demo.<親のドメイン> だけ（開発では demo.localhost も）', () => {
  assert.equal(isDemoHost('demo.m2office.net', 'demo', BASE), true);
  assert.equal(isDemoHost('DEMO.m2office.net:443', 'demo', BASE), true);
  assert.equal(isDemoHost('demo.localhost:3100', 'demo', BASE), true);
  assert.equal(isDemoHost('demo.attacker.example', 'demo', BASE), false);
  assert.equal(isDemoHost('x.demo.m2office.net', 'demo', BASE), false);
  assert.equal(isDemoHost('demo.m2office.net', null, BASE), false, '入口の名前が無ければ体験版を使わない');
});

test('証明書は、入口の名前を決めたときだけ取る', async () => {
  const repo = { findTenantBySubdomain: async () => null };
  assert.equal(await tlsAllowed(repo, 'demo.m2office.net', BASE, 'demo'), true);
  assert.equal(await tlsAllowed(repo, 'demo.m2office.net', BASE, null), false);
});

test('送り元ごとのログインの回数は 15 分に 20 回まで', () => {
  const t = new DemoLoginThrottle();
  for (let i = 0; i < 20; i++) assert.equal(t.allow('1.2.3.4', 0), true);
  assert.equal(t.allow('1.2.3.4', 0), false);
  assert.equal(t.allow('5.6.7.8', 0), true, 'ほかの送り元は止めない');
  assert.equal(t.allow('1.2.3.4', 16 * 60_000), true, '15 分たてば戻る');
});

/** 体験版の入口の確かめに要るものだけの依存。 */
function setup(opts: { seeded?: boolean; expiresInMs?: number } = {}) {
  const store = new MemoryDemoStore();
  const tenant: Tenant = { id: 'd-abc', subdomain: '_d-abc', name: '見本精工株式会社', workspaceDomain: null, status: 'trial' };
  store.add({
    loginId: 'guest-abc234', guestId: 'dg-abc', tenantId: tenant.id, userId: 'u-guest-abc234', passwordHash: hashMachinePassword('Secret-Pass-16ch'),
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 14 * 86_400_000)).toISOString(), seeded: opts.seeded ?? false,
  });
  const sessions: Session[] = [];
  const audits: string[] = [];
  let seeds = 0;
  const deps = {
    demo: { store, subdomain: 'demo', seed: async () => { seeds++; return { failed: [] }; } },
    repo: {
      createSession: async (s: Session) => { sessions.push(s); store.guests.get('guest-abc234')!.sessions.add(s.id); },
      appendAudit: async (a: { action: string }) => { audits.push(a.action); },
      findTenantById: async (id: string) => (id === tenant.id ? tenant : null),
      findTenantBySubdomain: async () => null,
    },
    auth: { cookieSecure: false, sessionTtlHours: 168, devHeaders: false },
    log: { warn: () => undefined, info: () => undefined },
    ai: { deployment: () => 'cloud' },
    onsiteTenant: null,
  } as unknown as AppDeps;
  const app = new Hono<AppEnv>();
  app.route('/v1/demo-login', demoLoginRoute(deps));
  app.use('/v1/*', resolveTenant(deps));
  app.get('/v1/auth/providers', (c) => c.json({ normal: true }));
  app.get('/v1/auth/google/start', (c) => c.json({ normal: true }));
  app.use('/v1/*', async (c, next) => { c.set('ctx', { tenant: c.get('tenant'), user: { id: 'u-guest-abc234', tenantId: 'd-abc', email: '', displayName: 'ゲスト', roles: ['admin'], status: 'active' } }); await next(); });
  app.use('/v1/*', demoRestrictions());
  app.get('/v1/whoami', (c) => c.json({ tenant: c.get('tenant').id }));
  app.post('/v1/admin/connections/mcp', (c) => c.json({ ok: true }));
  const login = (loginId: string, password: string, host = 'demo.m2office.net', addr = '1.1.1.1') => app.request('/v1/demo-login', {
    method: 'POST', headers: { host, 'content-type': 'application/json', 'x-forwarded-for': addr }, body: JSON.stringify({ loginId, password }),
  });
  return { app, store, sessions, audits, login, seeds: () => seeds };
}

test('ゲスト ID とパスワードでログインし、最初の 1 回だけ見本のデータを入れる。ログイン状態は 12 時間', async () => {
  process.env['BASE_DOMAIN'] = BASE;
  const s = setup();
  const r = await s.login('GUEST-ABC234 ', 'Secret-Pass-16ch');
  assert.equal(r.status, 200);
  assert.ok((await r.json() as { csrfToken: string }).csrfToken);
  assert.equal(s.seeds(), 1);
  assert.equal(s.sessions[0]!.provider, 'demo');
  assert.equal(s.sessions[0]!.tenantId, 'd-abc');
  const hours = (Date.parse(s.sessions[0]!.expiresAt) - Date.now()) / 3_600_000;
  assert.ok(hours > 11.9 && hours <= 12, `${hours}`);
  assert.match(r.headers.get('set-cookie') ?? '', /m2o_session=.*HttpOnly/);
  assert.ok(s.audits.includes('auth.login'));
  // 2 回目は入れない
  assert.equal((await s.login('guest-abc234', 'Secret-Pass-16ch')).status, 200);
  assert.equal(s.seeds(), 1);
});

test('ログイン状態は体験の期限を越えない', async () => {
  const s = setup({ seeded: true, expiresInMs: 2 * 3_600_000 });
  assert.equal((await s.login('guest-abc234', 'Secret-Pass-16ch')).status, 200);
  const hours = (Date.parse(s.sessions[0]!.expiresAt) - Date.now()) / 3_600_000;
  assert.ok(hours <= 2.01, `${hours}`);
});

test('ID が無い・パスワードが違う・期限が過ぎたを分けずに断り、5 回続けて間違えたら止める', async () => {
  const s = setup({ seeded: true });
  const nobody = await s.login('guest-zzzzzz', 'x');
  assert.equal(nobody.status, 401);
  const wrong = await s.login('guest-abc234', 'wrong');
  assert.equal(wrong.status, 401);
  assert.equal((await nobody.json() as { error: string }).error, (await wrong.json() as { error: string }).error);
  for (let i = 0; i < 4; i++) await s.login('guest-abc234', 'wrong', 'demo.m2office.net', `2.2.2.${i}`);
  const locked = await s.login('guest-abc234', 'Secret-Pass-16ch', 'demo.m2office.net', '3.3.3.3');
  assert.equal(locked.status, 429, '正しいパスワードでも 15 分は入れない');
  const expired = setup({ seeded: true, expiresInMs: -1000 });
  assert.equal((await expired.login('guest-abc234', 'Secret-Pass-16ch')).status, 401);
});

test('入口でない名前では、ゲストのログインを受けない', async () => {
  const s = setup({ seeded: true });
  assert.equal((await s.login('guest-abc234', 'Secret-Pass-16ch', 'alpha.m2office.net')).status, 404);
});

test('入口では、ログイン状態から体験用の会社を決める。Google のログインは受けない。止める操作は断る', async () => {
  const s = setup({ seeded: true });
  const host = { host: 'demo.m2office.net' };
  assert.equal((await s.app.request('/v1/whoami', { headers: host })).status, 401);
  const providers = await (await s.app.request('/v1/auth/providers', { headers: host })).json() as { demo?: boolean };
  assert.equal(providers.demo, true);
  assert.equal((await s.app.request('/v1/auth/google/start', { headers: host })).status, 404);
  const r = await s.login('guest-abc234', 'Secret-Pass-16ch');
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const who = await s.app.request('/v1/whoami', { headers: { ...host, cookie } });
  assert.equal(who.status, 200);
  assert.equal((await who.json() as { tenant: string }).tenant, 'd-abc');
  const token = cookie.split('=')[1]!;
  assert.ok(s.store.guests.get('guest-abc234')!.sessions.has(sessionIdOf(token)));
  const blocked = await s.app.request('/v1/admin/connections/mcp', { method: 'POST', headers: { ...host, cookie } });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json() as { error: string }).error, /体験版/);
  // 期限が過ぎたら、ログイン状態があっても会社は決まらない
  s.store.guests.get('guest-abc234')!.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await s.app.request('/v1/whoami', { headers: { ...host, cookie } })).status, 401);
});

/** 自分で申し込む口の確かめに要るものだけの依存。 */
function signupSetup() {
  const store = new MemoryDemoStore();
  const sessions: Session[] = [];
  let seeds = 0;
  const deps = {
    demo: { store, subdomain: 'demo', challengeSecret: 'test-secret', seed: async () => { seeds++; return { failed: [] }; } },
    repo: {
      createSession: async (x: Session) => { sessions.push(x); [...store.guests.values()].find((g) => g.tenantId === x.tenantId)?.sessions.add(x.id); },
      appendAudit: async () => undefined,
    },
    auth: { cookieSecure: false, sessionTtlHours: 168, devHeaders: false },
    log: { warn: () => undefined, info: () => undefined },
  } as unknown as AppDeps;
  const app = new Hono<AppEnv>();
  app.route('/v1/demo-signup', demoSignupRoute(deps));
  const challenge = async (host = 'demo.m2office.net') => {
    const r = await app.request('/v1/demo-signup/challenge', { headers: { host } });
    if (r.status !== 200) return null;
    const c = await r.json() as { challenge: string; salt: string; maxnumber: number };
    for (let n = 0; n <= c.maxnumber; n++) {
      if (createHash('sha256').update(c.salt + n).digest('hex') === c.challenge) return { ...c, number: n };
    }
    throw new Error('解けない');
  };
  const signup = (body: Record<string, unknown>, addr = '1.1.1.1', host = 'demo.m2office.net') => app.request('/v1/demo-signup', {
    method: 'POST', headers: { host, 'content-type': 'application/json', 'x-forwarded-for': addr }, body: JSON.stringify(body),
  });
  return { app, deps, store, sessions, challenge, signup, seeds: () => seeds };
}

const SIGNUP = { email: 'yamada@example.co.jp', agree: true };

test('自分で申し込む: ロボットよけを解くと、その場で体験用の会社ができてログインした状態になる。ID とパスワードは応答で 1 度だけ', async () => {
  process.env['BASE_DOMAIN'] = BASE;
  const s = signupSetup();
  const r = await s.signup({ ...SIGNUP, challenge: await s.challenge() });
  assert.equal(r.status, 201);
  const body = await r.json() as { loginId: string; password: string; expiresAt: string; csrfToken: string };
  assert.match(body.loginId, /^guest-[a-z0-9]{6}$/);
  assert.match(body.password, /^[A-Za-z2-9]{16}$/);
  assert.ok(body.csrfToken);
  assert.match(r.headers.get('set-cookie') ?? '', /m2o_session=.*HttpOnly/);
  assert.equal(s.seeds(), 1, '見本のデータを入れてから始める');
  assert.equal(s.sessions[0]!.provider, 'demo');
  const g = s.store.guests.get(body.loginId)!;
  assert.ok(g.trial.termsAcceptedAt, '規約には申し込みで同意した');
  assert.ok(g.seeded);
});

test('自分で申し込む: ロボットよけの答えが無い・違う・使い回しは断る', async () => {
  process.env['BASE_DOMAIN'] = BASE;
  const s = signupSetup();
  assert.equal((await s.signup(SIGNUP)).status, 400);
  const c = (await s.challenge())!;
  assert.equal((await s.signup({ ...SIGNUP, challenge: { ...c, number: c.number + 1 } })).status, 400);
  assert.equal((await s.signup({ ...SIGNUP, challenge: c })).status, 201);
  const again = await s.signup({ ...SIGNUP, email: 'other@example.co.jp', challenge: c }, '9.9.9.9');
  assert.equal(again.status, 400, '同じ問題は 1 度だけ');
});

test('自分で申し込む: 入力の誤りと、データベースが断った理由を返す。入口でない名前では受けない', async () => {
  process.env['BASE_DOMAIN'] = BASE;
  const s = signupSetup();
  assert.equal((await s.signup({ ...SIGNUP, agree: false, challenge: await s.challenge() })).status, 400);
  assert.equal((await s.signup({ ...SIGNUP, challenge: await s.challenge() })).status, 201);
  const used = await s.signup({ ...SIGNUP, email: 'Yamada+2@example.co.jp', challenge: await s.challenge() }, '2.2.2.2');
  assert.equal(used.status, 409);
  const u = await used.json() as { error: string; code: string };
  assert.equal(u.code, 'signup_email_used');
  assert.match(u.error, /すでに体験版/);
  const sameSource = await s.signup({ ...SIGNUP, email: 'b@example.co.jp', challenge: await s.challenge() });
  assert.equal((await sameSource.json() as { code: string }).code, 'signup_source_used');
  s.store.signup.open = false;
  const closed = await s.signup({ ...SIGNUP, email: 'c@example.co.jp', challenge: await s.challenge() }, '3.3.3.3');
  assert.equal((await closed.json() as { code: string }).code, 'signup_closed');
  assert.equal(await s.challenge('alpha.m2office.net'), null);
  assert.equal((await s.signup(SIGNUP, '4.4.4.4', 'alpha.m2office.net')).status, 404);
});

test('自分で申し込む: 見本のデータでつまずいても、作った体験の ID とパスワードは返す', async () => {
  process.env['BASE_DOMAIN'] = BASE;
  const s = signupSetup();
  (s.deps.demo as { seed: () => Promise<never> }).seed = async () => { throw new Error('seed failed'); };
  const r = await s.signup({ ...SIGNUP, challenge: await s.challenge() });
  assert.equal(r.status, 201);
  const body = await r.json() as { loginId: string; password: string; csrfToken: string | null };
  assert.match(body.loginId, /^guest-/);
  assert.equal(body.csrfToken, null);
});

test('体験版の入口のログインの手段に、申し込みで同意を求める規約を付ける', () => {
  const p = demoProviders() as { demo: boolean; demoTerms: string[] };
  assert.equal(p.demo, true);
  assert.ok(p.demoTerms.length >= 4);
});
