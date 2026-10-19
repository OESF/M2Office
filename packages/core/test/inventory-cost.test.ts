/**
 * @file 仕入価格・利益率（仕様書 第29.6.2節、Q-244）の単体テスト。
 *
 * 利益と利益率を税抜にそろえて出すこと（価格が無ければ出さない）、在庫額（仕入価格）、
 * 管理者でない人への答えから仕入価格を取り除くこと、納品書の単価で仕入価格を直すこと（入り数の換算・読めなければ直さない）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, inventoryCostValue, inventoryMargin, withoutPurchase } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';

test('利益と利益率: 税抜にそろえて、販売価格か仕入価格が無ければ出さない', () => {
  // 販売 1,100 円（税込 10%）→ 税抜 1,000 円。仕入 600 円（税抜）→ 利益 400 円・40%
  assert.deepEqual(inventoryMargin({ price: 1100, priceTaxIncluded: true, purchasePrice: 600, purchaseTaxIncluded: false, taxRate: 10 }), { profit: 400, rate: 40 });
  // 仕入も税込（648 円・8%）→ 税抜 600 円。販売 1,080 円（税込 8%）→ 税抜 1,000 円
  assert.deepEqual(inventoryMargin({ price: 1080, priceTaxIncluded: true, purchasePrice: 648, purchaseTaxIncluded: true, taxRate: 8 }), { profit: 400, rate: 40 });
  assert.equal(inventoryMargin({ price: null, priceTaxIncluded: true, purchasePrice: 600, purchaseTaxIncluded: false, taxRate: 10 }), null);
  assert.equal(inventoryMargin({ price: 1000, priceTaxIncluded: false, purchasePrice: null, purchaseTaxIncluded: false, taxRate: 10 }), null);
  assert.equal(inventoryCostValue({ purchasePrice: 600, purchaseTaxIncluded: false, taxRate: 10, onHand: 10, expired: 2 }), 4800);
});

test('管理者でない人への答えから、仕入価格の項目をどの深さからも取り除く', () => {
  const body = { items: [{ id: 'a', price: 100, purchasePrice: 60, purchaseTaxIncluded: false }], detail: { item: { purchasePrice: 1 } }, recorded: [{ text: 'x', purchasePrice: 2 }] };
  assert.equal(JSON.stringify(withoutPurchase(body)).includes('purchase'), false);
  assert.equal((withoutPurchase(body) as typeof body).items[0]!.price, 100);
});

test('納品書の単価で仕入価格を直す: 箱の単価は入り数で 1 つあたりにし、単価が読めなければ直さない', async () => {
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, units: true } } }),
    listUserGroupIds: async () => [], appendAudit: async () => undefined,
  } as unknown as Repository;
  const service = new InventoryService({ store: new MemoryInventoryStore(), repo });
  const a = await service.saveItem('t1', 'u1', { name: 'トナー 黒', unit: '本', packUnit: '箱', packSize: 4, sku: 'TN-1' });
  const b = await service.saveItem('t1', 'u1', { name: 'コピー用紙', unit: '束', purchasePrice: 300 });
  const line = (o: Record<string, unknown>) => ({ name: '', sku: '', code: '', qty: 1, unit: '', lot: '', expiresOn: '', ...o });
  const r = await service.receiveLines('t1', 'u1', [
    line({ sku: 'TN-1', unit: '箱', unitPrice: 10000, unitPriceTaxIncluded: false }),
    line({ name: 'コピー用紙', unit: '束', unitPrice: null }),
  ] as never);
  assert.equal(r.recorded.length, 2);
  assert.equal(r.recorded[0]!.purchasePrice, 2500, '1 箱 10,000 円 ÷ 4 本');
  assert.doesNotMatch(r.recorded[0]!.text, /円/, '金額は text に入れない（管理者でない人に見せない）');
  const items = await service.list('t1');
  assert.equal(items.find((i) => i.id === ('item' in a ? a.item.id : ''))?.purchasePrice, 2500);
  assert.equal(items.find((i) => i.id === ('item' in b ? b.item.id : ''))?.purchasePrice, 300, '単価が読めなければ直さない');
});
