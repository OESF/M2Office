/**
 * @file 在庫の品目の区分・消費税率・販売品の在庫額（仕様書 第29.6.1節、Q-242）の単体テスト。
 *
 * 区分は 4 つに固定し、作るときに省けば販売価格の有無で決めること、取り込みの区分と税率の読み方、
 * 販売品の在庫額（在庫 − 期限切れ × 販売価格。税込と税抜を税率ごとに直す。価格の無い品目は数えず数を返す）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventorySaleValue, type InventoryItemView } from '@m2office/shared';
import { kindOf, taxRateOf } from '../src/inventory/service.js';

const view = (o: Partial<InventoryItemView>): InventoryItemView => ({
  id: 'x', name: 'x', publicName: '', sku: '', category: '', kind: 'sale', taxRate: 10, unit: '個', packUnit: '', packSize: null, price: 1000,
  priceTaxIncluded: true, employeePrice: null, photoFileId: null, lowThreshold: null, supplierId: null, leadDays: null, note: '', status: 'active',
  codes: [], updatedAt: '', onHand: 10, reserved: 0, expired: 0, available: 10, low: false, nearestExpiry: null, ...o,
});

test('取り込みの区分は 4 つのどれかにし、どれでもなければその他。税率は 10・8 だけを読む', () => {
  assert.equal(kindOf('販売品'), 'sale');
  assert.equal(kindOf('商品'), 'sale');
  assert.equal(kindOf('消耗品'), 'supply');
  assert.equal(kindOf('原材料'), 'material');
  assert.equal(kindOf('材料'), 'material');
  assert.equal(kindOf('化粧品'), 'other');
  assert.equal(taxRateOf('8%'), 8);
  assert.equal(taxRateOf('軽減税率'), 8);
  assert.equal(taxRateOf('10'), 10);
  assert.equal(taxRateOf('0.08'), 8);
  assert.equal(taxRateOf('不明'), null);
});

test('販売品の在庫額: 在庫 − 期限切れ × 販売価格。税込と税抜を税率ごとに直し、販売品のほか・止めた品目・価格の無い品目は数えない', () => {
  const v = inventorySaleValue([
    view({ id: 'a', price: 1100, onHand: 10, expired: 2 }), // 税込 8,800
    view({ id: 'b', price: 1080, taxRate: 8, onHand: 5 }), // 税込 5,400（8%）
    view({ id: 'c', price: 1000, priceTaxIncluded: false, onHand: 3 }), // 税抜 3,000
    view({ id: 'd', kind: 'supply', price: 500, onHand: 100 }),
    view({ id: 'e', status: 'stopped', onHand: 1 }),
    view({ id: 'f', price: null }),
  ], 'floor');
  assert.equal(v.counted, 3);
  assert.equal(v.noPrice, 1);
  // 10% 税込 8,800 → 税 800、8% 税込 5,400 → 税 400、10% 税抜 3,000 → 税 300
  assert.equal(v.withTax, 8800 + 5400 + 3300);
  assert.equal(v.withoutTax, 8000 + 5000 + 3000);
});
