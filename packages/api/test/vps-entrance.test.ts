/**
 * @file VPS だけで守る形の入口の確かめ（仕様書 第20.4.6節、ADR-0113）。
 *
 * 待ち受け先の既定が 127.0.0.1 であること、証明書を取ってよい名前（払い出した会社のサブドメインと運営の決まった名前だけ）、
 * 証明書の問い合わせの口が機械の外からの要求を断ることを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tenant } from '@m2office/shared';
import { listenHost } from '../src/listen.js';
import { tlsAllowed, tlsAskRoute } from '../src/routes/tls-ask.js';
import { extractSubdomain } from '../src/middleware/tenant.js';

const tenants: Tenant[] = [
  { id: 't1', subdomain: 'alpha', name: 'アルファ', workspaceDomain: null, status: 'active' },
  { id: 't2', subdomain: 'stopped', name: '停止中', workspaceDomain: null, status: 'suspended' },
  { id: 't3', subdomain: 'gone', name: '解約', workspaceDomain: null, status: 'cancelled' },
];
const repo = { findTenantBySubdomain: async (s: string) => tenants.find((t) => t.subdomain === s) ?? null };
const BASE = 'm2office.net';

test('待ち受け先の既定は 127.0.0.1。M2O_LISTEN_HOST で変えられる', () => {
  assert.equal(listenHost({}), '127.0.0.1');
  assert.equal(listenHost({ M2O_LISTEN_HOST: ' ' }), '127.0.0.1');
  assert.equal(listenHost({ M2O_LISTEN_HOST: '0.0.0.0' }), '0.0.0.0');
});

test('証明書は、払い出した会社のサブドメインと運営の決まった名前だけに取る', async () => {
  for (const name of ['m2office.net', 'www.m2office.net', 'ops.m2office.net', 'signup.m2office.net', 'alpha.m2office.net', 'ALPHA.m2office.net.', 'stopped.m2office.net']) {
    assert.equal(await tlsAllowed(repo, name, BASE), true, name);
  }
  for (const name of ['nobody.m2office.net', 'gone.m2office.net', 'a.b.m2office.net', 'alpha.attacker.example', 'm2office.net.attacker.example', '', 'x.m2office.net', '-bad.m2office.net']) {
    assert.equal(await tlsAllowed(repo, name, BASE), false, name);
  }
  assert.equal(await tlsAllowed(repo, 'alpha.m2office.net', ''), false, '親のドメインが無ければ取らない');
});

test('証明書の問い合わせの口は、機械の外からの要求を断る', async () => {
  const app = tlsAskRoute(repo, () => BASE);
  // テストの要求には相手のアドレスが無い（機械の外と同じ扱い）
  const res = await app.request('/?domain=alpha.m2office.net');
  assert.equal(res.status, 403);
});

test('signup は会社のサブドメインとして通さない', () => {
  assert.equal(extractSubdomain('signup.m2office.net', BASE), null);
  assert.equal(extractSubdomain('alpha.m2office.net', BASE), 'alpha');
});
