/**
 * @file 画面の URL の単体テスト。URL と画面の対応、読めない URL の扱い、お知らせのリンクを確かめる。
 *
 * @see 仕様書 第6.1.6節 画面の URL
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationPath } from '@m2office/shared';
import { adminPath, parseAdminRoute, parseRoute, routePath, type Route } from '../src/route.js';

test('ワークスペースの画面と URL は行き来できる', () => {
  const routes: [string, Route][] = [
    ['/', { kind: 'home' }],
    ['/agents/minutes', { kind: 'agent', agentId: 'minutes' }],
    ['/runs/3c982953-a432-4011-bc8b-469c0f991e15', { kind: 'run', runId: '3c982953-a432-4011-bc8b-469c0f991e15' }],
    ['/approvals', { kind: 'approvals' }],
    ['/history', { kind: 'history' }],
    ['/notifications', { kind: 'notifications' }],
    ['/schedules', { kind: 'schedules' }],
    ['/inventory', { kind: 'inventory', itemId: null }],
    ['/inventory/3c982953-a432-4011-bc8b-469c0f991e15', { kind: 'inventory', itemId: '3c982953-a432-4011-bc8b-469c0f991e15' }],
    ['/settings/google', { kind: 'settings', section: 'google' }],
    ['/help', { kind: 'help', articleId: null }],
    ['/help/start-approvals', { kind: 'help', articleId: 'start-approvals' }],
  ];
  for (const [path, route] of routes) {
    assert.deepEqual(parseRoute(path), route, path);
    assert.equal(routePath(route), path, path);
  }
  assert.deepEqual(parseRoute('/runs/abc/'), { kind: 'run', runId: 'abc' }, '末尾の / は無視する');
});

test('知らない URL・読めない ID は、知らない画面として扱う（最初の画面に戻す）', () => {
  for (const path of ['/unknown', '/runs', '/runs/a/b', '/agents/%E0%A4%A', '/agents/<script>', '/approvals/x']) {
    assert.deepEqual(parseRoute(path), { kind: 'unknown' }, path);
  }
  assert.equal(routePath({ kind: 'unknown' }), '/');
  assert.deepEqual(parseRoute('/settings/<x>'), { kind: 'settings', section: null }, '区分が読めなければ、区分なしの個人設定');
});

test('管理者ページは /admin/{区分}/{小分け}', () => {
  assert.deepEqual(parseAdminRoute('/admin'), { tab: null, page: null });
  assert.deepEqual(parseAdminRoute('/admin/knowledge/synonyms'), { tab: 'knowledge', page: 'synonyms' });
  assert.deepEqual(parseAdminRoute('/admin/help/admin-audit'), { tab: 'help', page: 'admin-audit' });
  assert.deepEqual(parseAdminRoute('/admin/a/b/c'), { tab: null, page: null }, '深すぎる URL は最初の画面');
  assert.equal(parseAdminRoute('/runs/x'), null, '管理者ページでない');
  assert.equal(adminPath('knowledge', 'synonyms'), '/admin/knowledge/synonyms');
  assert.equal(adminPath('usage', ''), '/admin/usage');
});

test('お知らせのリンクは、承認の依頼なら承認トレイ、実行に結び付くものは実行の詳細', () => {
  assert.equal(notificationPath({ kind: 'approval', runId: 'r1' }), '/approvals');
  assert.equal(notificationPath({ kind: 'run', runId: 'r1' }), '/runs/r1');
  assert.equal(notificationPath({ kind: 'failure', runId: 'r1' }), '/runs/r1');
  assert.equal(notificationPath({ kind: 'brief', runId: null }), '/');
  assert.equal(notificationPath({ kind: 'run', runId: '../../x' }), '/', '読めない ID は載せない');
});
