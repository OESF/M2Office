/**
 * @file マスター管理画面の API（仕様書 第23.8.15節）の確かめ。データベースの代わりに手元の見本の口を使う。
 *
 * `ops.` の名前の要求だけを受けること、ログインと CSRF が要ること、ロールでできることが分かれること、
 * 会社を作ったらログインの URL と案内の文を返すことを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, type NewTenantInput, type Operator, type OpsStore } from '@m2office/core';
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
  let n = 0;
  // 運営の税率の表（第15.1.1.1節）。はじめは空（同梱の表を出す）
  let taxRows: { id: string; category: string; rate: number; from: string; to?: string; planned?: boolean; sourceUrl: string; checkedOn: string | null; updatedBy: string; updatedAt: string }[] = [];
  const notices: string[] = [];
  const store = {
    listOperators: async () => ops,
    addOperator: async (o: { email: string; displayName: string; role: string }) => (ops.some((x) => x.email === o.email) ? null : { id: `op-${o.email}`, ...o, status: 'active' }),
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
    listTaxRates: async () => taxRows,
    saveTaxRates: async (rows: typeof taxRows) => { taxRows = rows.map((r) => ({ ...r, updatedBy: 'op', updatedAt: '' })); },
    salesDraftCount: async () => 3,
    taxRateNotice: async (title: string) => { notices.push(title); return 2; },
  } as unknown as OpsStore;
  return { store, created, audits, sessions, passkeys, codes, notices, taxRows: () => taxRows };
}

const config = { login: null, googleDomains: [] as string[], devLogin: true, cookieSecure: false, sessionTtlHours: 12 };
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

test('消費税の税率の表: はじめは同梱の表。直す・確定には出典が要り、監視は直せない。予定を確定したら会社の管理者に知らせる（第15.1.1.1節）', async () => {
  const { store, audits, notices, taxRows } = fakeStore();
  const app = opsApp({ store, config, log });
  const admin = await login(app, 'admin@ops.example');
  const got = await app.request('/v1/ops/tax-rates', { headers: { ...OPS, cookie: admin.cookie } });
  const first = await got.json() as { rows: { id: string; category: string; rate: number; from: string; to?: string; planned?: boolean; sourceUrl: string; checkedOn: string | null }[]; bundled: boolean; drafts: number };
  assert.equal(first.bundled, true);
  assert.equal(first.drafts, 3);
  assert.ok(first.rows.some((r) => r.category === 'food' && r.rate === 1 && r.planned));
  const put = (who: { cookie: string; csrfToken: string }, rows: unknown) => app.request('/v1/ops/tax-rates', {
    method: 'PUT', headers: { ...OPS, cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ rows }),
  });
  const confirmed = first.rows.map((r) => (r.planned ? { ...r, planned: false } : r));
  assert.equal((await put(admin, confirmed)).status, 400, '出典が無ければ確定できない');
  const withSource = first.rows.map((r) => (r.planned ? { ...r, planned: false, sourceUrl: 'https://www.mof.go.jp/', checkedOn: '2026-12-15' } : r));
  const mon = await login(app, 'mon@ops.example');
  assert.equal((await put(mon, withSource)).status, 403);
  const ok = await put(admin, withSource);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { notified: number }).notified, 2);
  assert.ok(notices.some((t) => t.includes('食料品の消費税率が 1% に確定しました')));
  assert.ok(audits.includes('law.tax_rates'));
  assert.ok(taxRows().some((r) => r.category === 'food' && r.rate === 1 && !r.planned));
  // 区分の確定した行を消すと、確かめで断る
  assert.equal((await put(admin, withSource.filter((r) => r.category !== 'news'))).status, 400);
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

test('システムログ: 運営者は見られ、会社で絞ったら会社の詳細の履歴に残る。証拠保全は誰でも始められ、消すのは運営管理者だけで 1 年は消せない（第16.10節）', async () => {
  const { store, audits } = fakeStore();
  const seen: { tenantId: string | null; system: boolean }[] = [];
  const evidence = [{ id: 'ev-1', scope: 'tenant', tenantId: 't-acme', reason: 'x', createdKind: 'operator', createdBy: 'op-admin', rangeFrom: '', rangeTo: '', status: 'ready', size: 3, sha256: 'abc', failure: null, createdAt: new Date().toISOString(), readyAt: null, deletedAt: null }];
  const requested: (string | null)[] = [];
  Object.assign(store, {
    readSystemLogs: async (tenantId: string | null, system: boolean) => { seen.push({ tenantId, system }); return [{ id: '1', at: new Date().toISOString(), level: 'info', service: 'api', msg: '要求', tenantId, userId: null, requestId: null, runId: null, fields: {} }]; },
    systemLogDigests: async () => [],
    listEvidence: async () => evidence,
    requestEvidence: async (_id: string, tenantId: string | null) => { requested.push(tenantId); },
    evidenceChunk: async (_id: string, seq: number) => (seq === 0 ? new Uint8Array([1, 2, 3]) : null),
    deleteEvidence: async () => true,
  });
  const app = opsApp({ store, config, log });
  const admin = await login(app, 'admin@ops.example');
  const list = await app.request('/v1/ops/logs?tenant=t-acme', { headers: { ...OPS, cookie: admin.cookie } });
  assert.equal(list.status, 200);
  assert.deepEqual(seen[0], { tenantId: 't-acme', system: false });
  assert.ok(audits.includes('log.view'));
  await app.request('/v1/ops/logs?tenant=system', { headers: { ...OPS, cookie: admin.cookie } });
  assert.deepEqual(seen[1], { tenantId: null, system: true });
  const zip = await app.request('/v1/ops/logs/export?format=csv', { headers: { ...OPS, cookie: admin.cookie } });
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.ok(audits.includes('log.download'));
  const post = (who: { cookie: string; csrfToken: string }, body: unknown) => app.request('/v1/ops/evidence', {
    method: 'POST', headers: { ...OPS, cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post(admin, { reason: '' })).status, 400, '理由が要る');
  assert.equal((await post(admin, { reason: '不審なログイン', tenantId: 't-none' })).status, 404);
  assert.equal((await post(admin, { reason: '不審なログイン' })).status, 202);
  assert.deepEqual(requested, [null], '会社を選ばなければ全体');
  const dl = await app.request('/v1/ops/evidence/ev-1/download', { headers: { ...OPS, cookie: admin.cookie } });
  assert.deepEqual([...new Uint8Array(await dl.arrayBuffer())], [1, 2, 3]);
  const del = (who: { cookie: string; csrfToken: string }) => app.request('/v1/ops/evidence/ev-1', {
    method: 'DELETE', headers: { ...OPS, cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ reason: '期限' }),
  });
  assert.equal((await del(admin)).status, 409, '1 年は消せない');
  evidence[0]!.createdAt = new Date(Date.now() - 400 * 86_400_000).toISOString();
  assert.equal((await del(admin)).status, 200);
});

test('障害の知らせ: 影響の種類を確かめ、起こす・経過・終えるを運営の操作履歴に残す。運営者なら誰でも出せる（第16.11.3節 G-9）', async () => {
  const { store, audits } = fakeStore();
  const calls: unknown[][] = [];
  Object.assign(store, {
    openIncident: async (...a: unknown[]) => { calls.push(['open', ...a]); return { id: 'inc-1', notified: 3 }; },
    updateIncident: async (...a: unknown[]) => { calls.push(['update', ...a]); return 3; },
    closeIncident: async (...a: unknown[]) => { calls.push(['close', ...a]); return 3; },
    listIncidents: async () => [],
  });
  const app = opsApp({ store, config, log });
  const admin = await login(app, 'admin@ops.example');
  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { ...OPS, cookie: admin.cookie, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('/v1/ops/incidents', { title: 'x', impact: 'other' })).status, 400, '影響の種類が要る');
  const r = await post('/v1/ops/incidents', { title: '実行が止まっています', impact: 'down', body: '調べています', tenants: ['t-acme', 3] });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id: 'inc-1', notified: 3 });
  assert.deepEqual((calls[0]![1] as { tenants: string[] }).tenants, ['t-acme'], '会社の ID だけを渡す');
  assert.equal((await post('/v1/ops/incidents/inc-1/update', { body: '直しています' })).status, 200);
  assert.equal((await post('/v1/ops/incidents/inc-1/close', { body: '' })).status, 200);
  assert.deepEqual(audits.filter((a) => a.startsWith('incident.')), ['incident.open', 'incident.update', 'incident.close']);
  const { operatorCan } = await import('@m2office/core');
  assert.equal(operatorCan('monitor', 'incident.manage'), true, '監視の人も急いで出せる');
});

test('提携会社の運営者: 許すドメインが複数なら、どれかのドメインのアドレスだけを足せる。個人の Gmail は断る（第23.8.9節）', async () => {
  const { store } = fakeStore();
  const app = opsApp({ store, config: { ...config, googleDomains: ['ops.example', 'partner.example.co.jp'] }, log });
  const { cookie, csrfToken } = await login(app, 'admin@ops.example');
  const add = (email: string) => app.request('/v1/ops/operators', {
    method: 'POST', headers: { ...OPS, cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ email, role: 'support' }),
  });
  assert.equal((await add('someone@partner.example.co.jp')).status, 201);
  const gmail = await add('someone@gmail.com');
  assert.equal(gmail.status, 400);
  assert.match((await gmail.json() as { error: string }).error, /ops\.example・partner\.example\.co\.jp/);
  assert.equal((await add('someone@x.partner.example.co.jp')).status, 400, 'サブドメインは別のドメイン');
});

test('提携会社の運営者: Google の画面で絞るのは許すドメインが 1 つのときだけ（Google が絞れるのは 1 つのため）', async () => {
  const { store } = fakeStore();
  const login = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://ops.example/v1/ops/auth/callback' };
  const start = async (googleDomains: string[]) => {
    const res = await opsApp({ store, config: { ...config, login, googleDomains }, log }).request('/v1/ops/auth/google/start', { headers: OPS });
    return new URL((await res.json() as { url: string }).url).searchParams.get('hd');
  };
  assert.equal(await start(['ops.example']), 'ops.example');
  assert.equal(await start(['ops.example', 'partner.example.co.jp']), null);
  assert.equal(await start([]), null);
});

test('運営の AI の設定: 鍵は試して通ったときだけ暗号化して保存し、値は返さない。変えられるのは運営管理者だけ（第23.8.14節）', async () => {
  const { store, audits } = fakeStore();
  const saved: { enc: string | null; tail: string | null; tenantCap: number | null; platformCap: number | null } = { enc: null, tail: null, tenantCap: null, platformCap: null };
  Object.assign(store, {
    platformAiSettings: async () => ({ keySet: !!saved.enc, keyTail: saved.tail, keySetAt: saved.enc ? '2026-10-29T00:00:00Z' : null, keySetBy: saved.enc ? 'admin@ops.example' : null, tenantCapJpy: saved.tenantCap, platformCapJpy: saved.platformCap }),
    platformAiTotal: async () => 1234.4,
    platformAiKeyEnc: async () => saved.enc,
    setPlatformAiKey: async (enc: string | null, tail: string | null) => { saved.enc = enc; saved.tail = tail; },
    setPlatformAiCaps: async (t: number | null, p: number | null) => { saved.tenantCap = t; saved.platformCap = p; },
    audit: async (_o: string, action: string) => { audits.push(action); },
  });
  const checked: string[] = [];
  const platformAi = {
    box: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, '') },
    env: { key: 'AIzaEnvKey000000000000wxyz', tenantCapJpy: 3000 },
    check: async (k: string) => { checked.push(k); return k.endsWith('GOOD') ? { ok: true as const, ms: 12 } : { ok: false as const, ms: 5, error: 'API key not valid' }; },
  };
  const app = opsApp({ store, config, log, platformAi });
  const admin = await login(app, 'admin@ops.example');
  const mon = await login(app, 'mon@ops.example');
  const call = (who: { cookie: string; csrfToken: string }, method: string, path: string, body?: unknown) => app.request(`/v1/ops/settings/ai${path}`, {
    method, headers: { ...OPS, cookie: who.cookie, 'x-csrf-token': who.csrfToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let view = await (await call(admin, 'GET', '')).json() as { key: { source: string; tail: string }; month: { usedJpy: number }; envTenantCapJpy: number };
  assert.deepEqual([view.key.source, view.key.tail, view.month.usedJpy, view.envTenantCapJpy], ['env', 'wxyz', 1234, 3000], '画面に無ければ配備の設定の鍵の末尾だけ');
  assert.equal((await call(mon, 'PUT', '/key', { apiKey: 'AIzaScreenKey00000000GOOD' })).status, 403, '監視は変えられない');
  const bad = await call(admin, 'PUT', '/key', { apiKey: 'AIzaScreenKey000000000BAD' });
  assert.equal(bad.status, 400);
  assert.equal(saved.enc, null, '試して通らなければ保存しない');
  assert.equal((await call(admin, 'PUT', '/key', { apiKey: 'short' })).status, 400, '形の違う鍵は試さずに断る');
  assert.equal((await call(admin, 'PUT', '/key', { apiKey: 'AIzaScreenKey00000000GOOD' })).status, 200);
  assert.equal(saved.enc, 'enc:AIzaScreenKey00000000GOOD', '暗号化して保存する');
  const text = await (await call(admin, 'GET', '')).text();
  assert.ok(!text.includes('AIzaScreenKey') && !text.includes('AIzaEnvKey'), '鍵の値は返さない');
  view = JSON.parse(text);
  assert.deepEqual([view.key.source, view.key.tail], ['screen', 'GOOD']);
  // いま効いている鍵で試す（運営者なら誰でも）
  const tested = await (await call(mon, 'POST', '/test')).json() as { ok: boolean; source: string };
  assert.deepEqual([tested.ok, tested.source, checked.at(-1)], [true, 'screen', 'AIzaScreenKey00000000GOOD']);
  // 上限
  assert.equal((await call(admin, 'PUT', '/limits', { tenantCapJpy: 5000, platformCapJpy: -1 })).status, 400);
  assert.equal((await call(admin, 'PUT', '/limits', { tenantCapJpy: 5000, platformCapJpy: '' })).status, 200);
  assert.deepEqual([saved.tenantCap, saved.platformCap], [5000, null]);
  assert.equal((await call(admin, 'DELETE', '/key')).status, 200);
  assert.equal(saved.enc, null);
  for (const a of ['settings.ai_key_rejected', 'settings.ai_key', 'settings.ai_test', 'settings.ai_limits', 'settings.ai_key_delete']) assert.ok(audits.includes(a), `${a} を記録する`);
});
