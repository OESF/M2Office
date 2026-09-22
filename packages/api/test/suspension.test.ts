/**
 * @file 通常の停止の間に受け付ける要求の単体テスト。閲覧と、決めた書き込みだけを通すこと。
 *
 * @see 仕様書 第23.8.6節「通常の停止で受け付ける書き込み」
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedWhileSuspended, isOperational } from '../src/middleware/tenant.js';

test('停止中: 閲覧は受け付ける。Google のログインの開始は GET でも断る', () => {
  assert.equal(allowedWhileSuspended('GET', '/v1/runs/r1'), true);
  assert.equal(allowedWhileSuspended('GET', '/v1/files/f1/content'), true, 'ファイルの取り出しは閲覧に含める');
  assert.equal(allowedWhileSuspended('HEAD', '/v1/me'), true);
  assert.equal(allowedWhileSuspended('GET', '/v1/auth/google/start'), false);
});

test('停止中: ログイン・ログアウト・既読・端末のログアウトだけを受け付ける', () => {
  assert.equal(allowedWhileSuspended('POST', '/v1/auth/dev-login'), true);
  assert.equal(allowedWhileSuspended('POST', '/v1/auth/logout'), true);
  assert.equal(allowedWhileSuspended('POST', '/v1/notifications/n1/read'), true);
  assert.equal(allowedWhileSuspended('DELETE', '/v1/me/sessions/s1'), true);
});

test('停止中: 業務の依頼・秘書・承認・設定・ファイル・接続は断る', () => {
  for (const [method, path] of [
    ['POST', '/v1/jobs'],
    ['POST', '/v1/secretary'],
    ['POST', '/v1/approvals/a1'],
    ['PUT', '/v1/me/settings/theme'],
    ['PATCH', '/v1/me/profile'],
    ['POST', '/v1/files'],
    ['PUT', '/v1/admin/knowledge/new'],
    ['POST', '/v1/me/google/connect'],
    ['DELETE', '/v1/me/sessions/s1/extra'],
    ['POST', '/v1/notifications/n1/read/x'],
  ] as const) {
    assert.equal(allowedWhileSuspended(method, path), false, `${method} ${path}`);
  }
});

test('業務を受け付けるのは試用と稼働中だけ', () => {
  assert.equal(isOperational({ status: 'trial' }), true);
  assert.equal(isOperational({ status: 'active' }), true);
  for (const status of ['suspended', 'locked', 'cancelled'] as const) assert.equal(isOperational({ status }), false);
});
