/**
 * @file Google の認可の要求の state の単体テスト。使い捨てで、期限が切れること。
 *
 * @see 仕様書 第14.3.3節「戻り先の検証」
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthStateStore } from '../src/auth/oauth-state.js';

test('state: 1 回しか使えず、未知の値や期限切れは照合できない', () => {
  const store = new OAuthStateStore();
  const s = store.issue({ tenantId: 't', userId: 'u', codeVerifier: 'v', returnTo: '/' }, 1000);
  assert.ok(s.length >= 32);
  assert.equal(store.take(s, 2000)?.userId, 'u');
  assert.equal(store.take(s, 2000), null, '2 回目は使えない');
  assert.equal(store.take('guess', 2000), null);
  const late = store.issue({ tenantId: 't', userId: 'u', codeVerifier: 'v', returnTo: '/' }, 0);
  assert.equal(store.take(late, 11 * 60 * 1000), null, '10 分で失効する');
});
