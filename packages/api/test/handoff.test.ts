/**
 * @file ログインの引換券の単体テスト（仕様書 第16.1.2節）。
 *
 * 券は URL に載って運ばれる。一度きりであることと、短命であることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandoffStore } from '../src/auth/handoff.js';

const NOW = Date.now();

test('発行した券で、相手を引ける', () => {
  const store = new HandoffStore();
  const ticket = store.issue({ tenantId: 't-oesf', userId: 'u1' }, NOW);

  const hit = store.take(ticket, NOW);
  assert.equal(hit?.tenantId, 't-oesf');
  assert.equal(hit?.userId, 'u1');
});

test('券は 1 回しか使えない', () => {
  const store = new HandoffStore();
  const ticket = store.issue({ tenantId: 't-oesf', userId: 'u1' }, NOW);

  assert.ok(store.take(ticket, NOW));
  // 戻るボタンで同じ URL を開いても、二度はログインできない
  assert.equal(store.take(ticket, NOW), null);
});

test('2 分を過ぎた券は使えない', () => {
  const store = new HandoffStore();
  const ticket = store.issue({ tenantId: 't-oesf', userId: 'u1' }, NOW);

  assert.equal(store.take(ticket, NOW + 2 * 60 * 1000 + 1), null);
});

test('知らない券では引けない', () => {
  const store = new HandoffStore();
  assert.equal(store.take('でたらめ', NOW), null);
});

test('券は毎回違う', () => {
  const store = new HandoffStore();
  const a = store.issue({ tenantId: 't-oesf', userId: 'u1' }, NOW);
  const b = store.issue({ tenantId: 't-oesf', userId: 'u1' }, NOW);
  assert.notEqual(a, b);
  // 推測できない長さであること
  assert.ok(a.length >= 32, `券が短すぎます: ${a.length}`);
});

test('券が指すのは会社と利用者の ID だけ（名前もメールアドレスも入れない）', () => {
  const store = new HandoffStore();
  const ticket = store.issue({ tenantId: 't-oesf', userId: 'u1' }, NOW);
  const hit = store.take(ticket, NOW)!;

  // URL に個人の情報を載せない（仕様書 第16.1.2節）
  assert.deepEqual(Object.keys(hit).sort(), ['expiresAt', 'tenantId', 'userId']);
});
