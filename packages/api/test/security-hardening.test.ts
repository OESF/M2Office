/**
 * @file 2026-10-12 の点検で直した、会社のホストとログインの戻り先の確かめの単体テスト。
 *
 * ログインの戻り先は要求の Origin をそのまま使わず、Host と同じときだけ使う（引換券を外のサイトへ送らせない）。
 * 会社のサブドメインは `<サブドメイン>.<親>` の形のときだけ取り出す（外のホストから会社を名乗らせない）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantOrigin } from '../src/tenant-origin.js';
import { extractSubdomain } from '../src/middleware/tenant.js';

test('ログインの戻り先: Origin は Host と同じときだけ使い、外のサイトの Origin は使わない', () => {
  assert.equal(tenantOrigin('https://acme.m2office.net', 'acme.m2office.net'), 'https://acme.m2office.net');
  assert.equal(tenantOrigin('https://evil.example', 'acme.m2office.net'), 'https://acme.m2office.net', '外の Origin は捨てて Host から作る');
  assert.equal(tenantOrigin('https://acme.m2office.net.evil.example', 'acme.m2office.net'), 'https://acme.m2office.net');
  assert.equal(tenantOrigin('http://acme.m2office.net', 'acme.m2office.net'), 'https://acme.m2office.net', '本番では http の Origin を使わない');
  assert.equal(tenantOrigin('http://a.localhost:3104', 'a.localhost:3104'), 'http://a.localhost:3104', '開発は http のまま');
  assert.equal(tenantOrigin('not a url', 'acme.m2office.net'), 'https://acme.m2office.net');
  assert.equal(tenantOrigin(undefined, 'acme.m2office.net'), 'https://acme.m2office.net');
});

test('会社のサブドメイン: 親のドメインの直下だけを受け、外のホストや深い名前は受けない', () => {
  assert.equal(extractSubdomain('acme.m2office.net', 'm2office.net'), 'acme');
  assert.equal(extractSubdomain('acme.m2office.net:443', 'm2office.net'), 'acme');
  assert.equal(extractSubdomain('ACME.M2Office.net', 'm2office.net'), 'acme');
  assert.equal(extractSubdomain('acme.attacker.example', 'm2office.net'), null, '外のホストからは会社を名乗れない');
  assert.equal(extractSubdomain('acme.m2office.net.attacker.example', 'm2office.net'), null);
  assert.equal(extractSubdomain('x.acme.m2office.net', 'm2office.net'), null, '深い名前は受けない');
  assert.equal(extractSubdomain('m2office.net', 'm2office.net'), null);
  assert.equal(extractSubdomain('a.localhost:3104', 'm2office.net'), 'a', '開発の a.localhost は受ける');
  assert.equal(extractSubdomain('a.lvh.me:3101', 'lvh.me'), 'a');
});
