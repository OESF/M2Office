/**
 * @file 在庫の品目を区分と分類で選ぶ条件（仕様書 第29.12.3節、Q-245）の単体テスト。
 *
 * 区分と分類を「かつ」で絞ること、1 つずつ外した品目は条件に当たっても外したままにすること、
 * API の本文から条件を整える（知らない区分を捨て、区分も分類も無ければ条件なし）ことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRuleItemIds, inventoryRuleMatches, inventoryRuleOf, type InventoryItemKind } from '@m2office/shared';

const item = (id: string, kind: InventoryItemKind, category: string) => ({ id, kind, category });
const items = [
  item('a', 'sale', '化粧品'), item('b', 'sale', '日用品'), item('c', 'sale', '飲料'),
  item('d', 'supply', '化粧品'), item('e', 'material', ''),
];

test('区分と分類は「かつ」で絞り、片方だけならその片方で絞る', () => {
  assert.deepEqual(inventoryRuleItemIds({ kinds: ['sale'], categories: ['化粧品', '日用品'], excluded: [] }, items), ['a', 'b']);
  assert.deepEqual(inventoryRuleItemIds({ kinds: ['sale'], categories: [], excluded: [] }, items), ['a', 'b', 'c']);
  assert.deepEqual(inventoryRuleItemIds({ kinds: [], categories: ['化粧品'], excluded: [] }, items), ['a', 'd']);
  assert.equal(inventoryRuleMatches({ kinds: ['sale', 'supply'], categories: ['化粧品'] }, items[3]!), true);
});

test('1 つずつ外した品目は、条件に当たっても選ばない', () => {
  assert.deepEqual(inventoryRuleItemIds({ kinds: ['sale'], categories: [], excluded: ['b'] }, items), ['a', 'c']);
});

test('本文の条件は、知らない区分と空の分類を捨て、区分も分類も無ければ条件なしにする', () => {
  assert.deepEqual(inventoryRuleOf({ kinds: ['sale', 'bogus', 'sale'], categories: ['化粧品', '', 3], excluded: ['x'] }), { kinds: ['sale'], categories: ['化粧品'], excluded: ['x'] });
  assert.equal(inventoryRuleOf({ kinds: ['bogus'], categories: [] }), null);
  assert.equal(inventoryRuleOf(null), null);
  assert.equal(inventoryRuleOf('sale'), null);
});
