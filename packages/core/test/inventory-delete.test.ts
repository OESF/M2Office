/**
 * @file 品目の削除（仕様書 第29.6.3節、Q-252）の単体テスト。
 *
 * 在庫・取り置き・入荷待ちの発注が残っていれば断ること、記録の無い品目は行ごと消し、記録のある品目は記録を残して
 * どこにも出さないこと、バーコードを外して新しい品目に付け直せること、取り消すと品目とバーコードが戻ること
 * （ほかの品目に付いたバーコードは戻さないこと）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';

function setup() {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true } };
  const audits: string[] = [];
  const repo = {
    getTenantSettings: async () => settings, listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Repository;
  const store = new MemoryInventoryStore();
  return { store, audits, service: new InventoryService({ store, repo }) };
}

async function item(service: InventoryService, name: string, codes: string[] = []) {
  const r = await service.saveItem('t1', 'u1', { name, codes });
  assert.ok('item' in r, JSON.stringify(r));
  return r.item.id;
}

test('記録の無い品目は行ごと消し、バーコードを付け直せる。取り消すと元に戻る', async () => {
  const { service, store, audits } = setup();
  const id = await item(service, '綿棒', ['4900000000001']);
  const res = await service.deleteItem('t1', 'u1', id);
  assert.ok('ok' in res);
  assert.equal(res.purged, true);
  assert.equal(store.items.has(id), false, '行ごと消す');
  assert.equal(await service.lookup('t1', '4900000000001').then((l) => l.item), null, 'バーコードを外す');
  assert.ok(audits.includes('inventory.item.delete'));
  const back = await service.restoreItem('t1', 'u1', res.item, res.purged);
  assert.deepEqual(back.codesTaken, []);
  assert.equal((await service.lookup('t1', '4900000000001')).item?.id, id, '品目とバーコードが戻る');
});

test('記録のある品目は記録を残し、一覧・探す・止めた品目にも出さない。履歴には品名が残る', async () => {
  const { service } = setup();
  const id = await item(service, 'ガーゼ', ['4900000000002']);
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: id, qty: 2 });
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: id, qty: 2 });
  const res = await service.deleteItem('t1', 'u1', id);
  assert.ok('ok' in res);
  assert.equal(res.purged, false, '記録があるので行は残す');
  assert.equal((await service.list('t1', { includeStopped: true })).some((i) => i.id === id), false, '止めた品目にも出さない');
  assert.equal((await service.lookup('t1', '4900000000002')).item, null);
  const moves = await service.history('t1', { itemId: id, limit: 10 });
  assert.equal(moves.length, 2, '記録は消さない');
  assert.equal(moves[0]?.itemName, 'ガーゼ', '過去の記録には品名を出す');
  // 同じバーコードを新しい品目に付けてから取り消すと、そのバーコードだけは戻さない
  const next = await item(service, 'ガーゼ（新）', ['4900000000002']);
  const back = await service.restoreItem('t1', 'u1', res.item, res.purged);
  assert.deepEqual(back.codesTaken, ['4900000000002']);
  assert.ok((await service.list('t1')).some((i) => i.id === id), '品目は戻る');
  assert.equal((await service.lookup('t1', '4900000000002')).item?.id, next);
});

test('在庫・取り置き・入荷待ちの発注が残っていれば削除しない', async () => {
  const { service } = setup();
  const id = await item(service, 'トナー');
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: id, qty: 1 });
  const left = await service.deleteItem('t1', 'u1', id);
  assert.ok('error' in left);
  assert.match(left.error, /在庫が 1 個 残っている/);
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: id, qty: 1 });
  const sup = await service.saveSupplier('t1', { name: '〇〇商事', method: 'web', contact: 'https://shop.example' });
  assert.ok('id' in sup);
  const o = await service.createOrder('t1', 'u1', { supplierId: sup.id, lines: [{ itemId: id, qty: 3 }], status: 'ordered' });
  assert.ok(!('error' in o));
  const ordered = await service.deleteItem('t1', 'u1', id);
  assert.ok('error' in ordered);
  assert.match(ordered.error, /入荷待ちの発注/);
});
