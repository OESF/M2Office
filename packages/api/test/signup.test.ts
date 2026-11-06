/**
 * @file 申し込みの口（仕様書 第23.3.1節）の確かめ。signup. のホストだけで受けること、個人のアカウントを断ること、
 * 受付を閉じている間は作らないこと、1 ドメインに 1 社、1 回限りの札、ダミーのカードの登録、課金の知らせの記録を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoChallenge, MockPaymentProvider, silentLogger, type PaymentProvider, type SignupStore, type SignupStatus } from '@m2office/core';
import { createHash } from 'node:crypto';
import { applyPaymentEvent, chargeDueInvoices, companyUrl, isSignupHost, signupApp, type SignupConfig } from '../src/signup/app.js';
import { signupOrigin } from '../src/routes/billing.js';

const SECRET = 'secret-for-test';
const HOST = 'signup.example.jp';

function fakeStore(over: Partial<SignupStatus> = {}) {
  const calls: Record<string, unknown[]> = { provision: [], cardDone: [], chargeResult: [] };
  const taken = new Set(['taken']);
  const domains = new Map<string, string>();
  const tickets = new Map<string, { tenantId: string; returnUrl: string; customerId: string | null }>();
  const store = {
    status: async () => ({ open: true, monthlyPriceJpy: 1800, annualPriceJpy: 1500, taxPercent: 10, termsVersion: 'v1', ...over }),
    subdomainFree: async (s: string) => !taken.has(s),
    domainTenant: async (d: string) => domains.get(d) ?? null,
    provision: async (v: unknown) => { calls['provision']!.push(v); return 't-new'; },
    takeCardTicket: async (h: string) => { const t = tickets.get(h) ?? null; tickets.delete(h); return t; },
    cardDone: async (t: string, c: string) => { calls['cardDone']!.push([t, c]); },
    chargesDue: async () => [],
    chargeResult: async (...a: unknown[]) => { calls['chargeResult']!.push(a); return true; },
  } as unknown as SignupStore;
  return { store, calls, domains, tickets };
}

function make(s: ReturnType<typeof fakeStore>, provider: PaymentProvider | null = new MockPaymentProvider(SECRET, '/billing/mock-card'), config: Partial<SignupConfig> = {}) {
  return signupApp({ store: s.store, provider, log: silentLogger, config: { login: null, devLogin: true, cookieSecure: false, secret: SECRET, ...config } });
}

const send = (path: string, body: unknown, cookie?: string, host = HOST) => new Request(`http://${host}${path}`, {
  method: 'POST', headers: { host, origin: `https://${host}`, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});

async function login(app: ReturnType<typeof make>, email = 'kanri@acme.example'): Promise<string> {
  const res = await app.fetch(send('/v1/signup/auth/dev-login', { email }));
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

/** ロボットよけの問題を解く。 */
function solved() {
  const c = createDemoChallenge(SECRET, Date.now(), 50) as { challenge: string; salt: string };
  for (let n = 0; n <= 50; n++) {
    if (createHash('sha256').update(`${c.salt}${n}`).digest('hex') === c.challenge) return { ...c, number: n };
  }
  throw new Error('解けませんでした');
}

const form = (over: Record<string, unknown> = {}) => ({ subdomain: 'acme', name: 'アクメ', termsVersion: 'v1', challenge: solved(), ...over });

test('名前が signup. で始まる要求だけを受ける', async () => {
  const app = make(fakeStore());
  assert.equal(isSignupHost('signup.example.jp'), true);
  assert.equal(isSignupHost('acme.example.jp'), false);
  assert.equal((await app.fetch(new Request('http://acme.example.jp/v1/signup/status', { headers: { host: 'acme.example.jp' } }))).status, 404);
  assert.equal((await app.fetch(new Request(`http://${HOST}/v1/signup/status`, { headers: { host: HOST } }))).status, 200);
});

test('書き換える要求は同じ所のページからだけ受ける', async () => {
  const app = make(fakeStore());
  const res = await app.fetch(new Request(`http://${HOST}/v1/signup/auth/dev-login`, { method: 'POST', headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"email":"a@acme.example"}' }));
  assert.equal(res.status, 403);
});

test('個人のアカウントは断り、ログインしていなければ作らない', async () => {
  const s = fakeStore();
  const app = make(s);
  assert.equal((await app.fetch(send('/v1/signup/auth/dev-login', { email: 'someone@gmail.com' }))).status, 400);
  assert.equal((await app.fetch(send('/v1/signup/provision', form()))).status, 401);
  assert.equal(s.calls['provision']!.length, 0);
});

test('入力とロボットよけを確かめて、スターターを作る。支払いの方法は聞かない', async () => {
  const s = fakeStore();
  const app = make(s);
  const cookie = await login(app);
  assert.equal((await app.fetch(send('/v1/signup/provision', form({ challenge: { bad: 1 } }), cookie))).status, 400);
  assert.equal((await app.fetch(send('/v1/signup/provision', form({ subdomain: 'ops' }), cookie))).status, 400);
  assert.equal((await app.fetch(send('/v1/signup/provision', form({ termsVersion: 'v0' }), cookie))).status, 409);
  const res = await app.fetch(send('/v1/signup/provision', form(), cookie));
  assert.equal(res.status, 201);
  const body = await res.json() as { url: string };
  assert.match(body.url, /^https:\/\/acme\.example\.jp\/$/);
  assert.deepEqual(s.calls['provision'], [{ subdomain: 'acme', name: 'アクメ', domain: 'acme.example', admin: 'kanri@acme.example', termsVersion: 'v1' }]);
});

test('受付を閉じている間は作らない', async () => {
  const s = fakeStore({ open: false });
  const app = make(s);
  const cookie = await login(app);
  assert.equal((await app.fetch(send('/v1/signup/provision', form(), cookie))).status, 403);
  assert.equal(s.calls['provision']!.length, 0);
});

test('1 つのドメインに 1 社。すでにあれば、その会社のアドレスを示す', async () => {
  const s = fakeStore();
  s.domains.set('acme.example', 'acme-old');
  const app = make(s);
  const res = await app.fetch(send('/v1/signup/provision', form(), await login(app)));
  assert.equal(res.status, 409);
  assert.match((await res.json() as { url: string }).url, /acme-old\.example\.jp/);
  assert.equal(s.calls['provision']!.length, 0);
});

test('同じ送り元から 1 時間に作れる数を抑える', async () => {
  const s = fakeStore();
  const app = make(s);
  const cookie = await login(app);
  for (let i = 0; i < 5; i++) assert.equal((await app.fetch(send('/v1/signup/provision', form(), cookie))).status, 201);
  assert.equal((await app.fetch(send('/v1/signup/provision', form(), cookie))).status, 429);
});

test('サブドメインの空きを確かめる', async () => {
  const app = make(fakeStore());
  const q = async (name: string) => (await app.fetch(new Request(`http://${HOST}/v1/signup/subdomain?name=${name}`, { headers: { host: HOST } }))).json() as Promise<{ available: boolean }>;
  assert.equal((await q('free-name')).available, true);
  assert.equal((await q('taken')).available, false);
  assert.equal((await q('ops')).available, false);
});

test('カードの登録: 札は 1 回限りで、ダミーの登録の結果を記録する', async () => {
  const s = fakeStore();
  const app = make(s);
  const ticket = 'ticket-value';
  s.tickets.set(createHash('sha256').update(ticket).digest('hex'), { tenantId: 't-a', returnUrl: 'https://a.example.jp/admin/billing', customerId: null });
  const first = await app.fetch(send('/v1/signup/billing/card', { ticket }));
  assert.equal(first.status, 200);
  const { url } = await first.json() as { url: string };
  assert.equal((await app.fetch(send('/v1/signup/billing/card', { ticket }))).status, 400);

  const session = new URL(url, `https://${HOST}`).searchParams.get('session')!;
  assert.equal((await app.fetch(send('/v1/signup/billing/mock-card', { session: 'にせ' }))).status, 400);
  const done = await app.fetch(send('/v1/signup/billing/mock-card', { session }));
  assert.equal(done.status, 200);
  assert.equal((await done.json() as { returnUrl: string }).returnUrl, 'https://a.example.jp/admin/billing');
  assert.equal((s.calls['cardDone']![0] as string[])[0], 't-a');
});

test('本物の支払いの口ではダミーの登録の口を開けない。口が無ければカードを登録できない', async () => {
  const notMock = { name: 'stripe' } as unknown as PaymentProvider;
  const app = make(fakeStore(), notMock);
  assert.equal((await app.fetch(send('/v1/signup/billing/mock-card', { session: 'x' }))).status, 404);
  assert.equal((await make(fakeStore(), null).fetch(send('/v1/signup/billing/card', { ticket: 'x' }))).status, 503);
});

test('支払いの口の知らせは署名を確かめてから記録する', async () => {
  const s = fakeStore();
  const provider = new MockPaymentProvider(SECRET, '/x');
  const app = make(s, provider);
  const body = JSON.stringify({ id: 'evt1', kind: 'charge.succeeded', invoiceId: 'inv', paymentId: 'pay' });
  const post = (sig: string) => new Request(`http://${HOST}/v1/signup/stripe/webhook`, { method: 'POST', headers: { host: HOST, 'stripe-signature': sig }, body });
  assert.equal((await app.fetch(post('fake'))).status, 400);
  assert.equal(s.calls['chargeResult']!.length, 0);
  assert.equal((await app.fetch(post(provider.signature(body)))).status, 200);
  assert.deepEqual(s.calls['chargeResult']![0], ['evt1', 'inv', true, 'pay', null]);
});

test('課金: 渡せなかった請求は次の回に残し、ほかの請求を続ける', async () => {
  const results: unknown[] = [];
  const store = {
    chargesDue: async () => [{ id: 'a', tenantId: 't', number: 'n1', totalJpy: 1, customerId: 'c' }, { id: 'b', tenantId: 't', number: 'n2', totalJpy: 1, customerId: 'c' }],
    cardDone: async () => undefined,
    chargeResult: async (...a: unknown[]) => { results.push(a); return true; },
  };
  const provider = {
    charge: async (i: { invoiceId: string }) => {
      if (i.invoiceId === 'a') throw new Error('つながらない');
      return { id: 'e', kind: 'charge.succeeded', invoiceId: i.invoiceId, paymentId: 'p' };
    },
  } as unknown as PaymentProvider;
  const warned: string[] = [];
  assert.equal(await chargeDueInvoices(store, provider, { warn: (m: string) => { warned.push(m); } }), 1);
  assert.equal(results.length, 1);
  assert.equal(warned.length, 1);
});

test('知らせの記録の振り分け', async () => {
  const calls: unknown[][] = [];
  const store = { cardDone: async (...a: unknown[]) => { calls.push(['card', ...a]); }, chargeResult: async (...a: unknown[]) => { calls.push(['charge', ...a]); return true; } };
  await applyPaymentEvent(store, { id: 'e', kind: 'card.registered', tenantId: 't', customerId: 'c', returnUrl: 'r' });
  await applyPaymentEvent(store, { id: 'f', kind: 'charge.failed', invoiceId: 'i', error: 'x' });
  assert.deepEqual(calls, [['card', 't', 'c'], ['charge', 'f', 'i', false, null, 'x']]);
});

test('オリジンの作り方', () => {
  assert.equal(companyUrl('https://signup.example.jp', 'acme'), 'https://acme.example.jp/');
  assert.equal(signupOrigin('https://acme.example.jp', 'acme'), 'https://signup.example.jp');
  assert.equal(signupOrigin('https://acme.localhost:3100', 'acme'), 'https://signup.localhost:3100');
});
