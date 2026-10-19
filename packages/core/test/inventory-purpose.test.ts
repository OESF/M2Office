/**
 * @file 出庫の用途（仕様書 第29.9.1節、Q-247）の単体テスト。
 *
 * 用途の既定（その品目で前に選んだ用途、無ければ区分から）、販売の通知と予約の決まった用途、知らない用途を断ること、
 * 取り消しが用途を引き継ぐこと、廃棄を「使う速さ」（減り具合・需要の予測）に入れないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, defaultOutPurpose, inventoryPurposeLabel, type InventoryOutPurpose, type TenantSettings } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';

function setup() {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true } };
  const repo = { getTenantSettings: async () => settings, listUserGroupIds: async () => [], appendAudit: async () => undefined } as unknown as Repository;
  const store = new MemoryInventoryStore();
  return { store, service: new InventoryService({ store, repo }) };
}

async function item(service: InventoryService, name: string, extra: Record<string, unknown> = {}) {
  const r = await service.saveItem('t1', 'u1', { name, ...extra });
  assert.ok('item' in r, JSON.stringify(r));
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: r.item.id, qty: 50 });
  return r.item;
}

test('用途の既定は、前に選んだ用途。無ければ販売品は販売、ほかは社内消費', async () => {
  assert.equal(defaultOutPurpose({ kind: 'sale' }), 'sale');
  assert.equal(defaultOutPurpose({ kind: 'supply' }), 'internal');
  assert.equal(defaultOutPurpose({ kind: 'supply' }, 'disposal'), 'disposal');
  assert.equal(inventoryPurposeLabel('internal'), '社内消費');
  assert.equal(inventoryPurposeLabel(null), '');

  const { service } = setup();
  const cream = await item(service, 'ハンドクリーム', { kind: 'sale', price: 1000 });
  const paper = await item(service, 'コピー用紙', { kind: 'supply' });
  const first = await service.recordMove('t1', 'u1', { kind: 'out', itemId: cream.id, qty: 1 });
  assert.ok(first.ok);
  assert.equal(first.moves[0]!.purpose, 'sale', '販売品は省けば販売');
  const used = await service.recordMove('t1', 'u1', { kind: 'out', itemId: cream.id, qty: 1, purpose: 'internal' });
  assert.ok(used.ok);
  assert.equal(used.item.outPurpose, 'internal', '次の既定は前に選んだ用途');
  const again = await service.recordMove('t1', 'u1', { kind: 'out', itemId: cream.id, qty: 1 });
  assert.ok(again.ok);
  assert.equal(again.moves[0]!.purpose, 'internal');
  const listed = await service.list('t1');
  assert.equal(listed.find((i) => i.id === paper.id)?.outPurpose, 'internal', '消耗品は社内消費');
  const inMove = await service.recordMove('t1', 'u1', { kind: 'in', itemId: paper.id, qty: 1, purpose: 'sale' });
  assert.ok(inMove.ok);
  assert.equal(inMove.moves[0]!.purpose, null, '入庫は用途を持たない');
});

test('販売の通知は販売、予約で使ったものは社内消費。知らない用途は断る', async () => {
  const { service } = setup();
  const paper = await item(service, 'コピー用紙', { kind: 'supply' });
  const sold = await service.recordMove('t1', 'app:x', { kind: 'out', itemId: paper.id, qty: 1, source: 'sales' });
  assert.ok(sold.ok);
  assert.equal(sold.moves[0]!.purpose, 'sale');
  const booked = await service.recordMove('t1', 'u1', { kind: 'out', itemId: paper.id, qty: 1, source: 'reservation' });
  assert.ok(booked.ok);
  assert.equal(booked.moves[0]!.purpose, 'internal');
  const bad = await service.recordMove('t1', 'u1', { kind: 'out', itemId: paper.id, qty: 1, purpose: 'gift' as InventoryOutPurpose });
  assert.equal(bad.ok, false);
});

test('取り消しは用途を引き継ぎ、廃棄は使う速さに入れない', async () => {
  const { service, store } = setup();
  const milk = await item(service, '乳液', { kind: 'sale', price: 2000 });
  const sold = await service.recordMove('t1', 'u1', { kind: 'out', itemId: milk.id, qty: 4, purpose: 'sale' });
  const thrown = await service.recordMove('t1', 'u1', { kind: 'out', itemId: milk.id, qty: 10, purpose: 'disposal' });
  assert.ok(sold.ok && thrown.ok);
  const undone = await service.undo('t1', 'u1', thrown.moves[0]!.id);
  assert.ok(undone.ok);
  assert.equal(undone.moves[0]!.purpose, 'disposal', '取り消しの記録も同じ用途');
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: milk.id, qty: 6, purpose: 'disposal' });
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const until = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await store.usageByItem('t1', since, until)).get(milk.id), 4, '販売の 4 だけを数え、廃棄（取り消しを含む）は数えない');
  const weekly = await store.weeklyUsage('t1', milk.id, since);
  assert.equal(weekly.reduce((a, w) => a + w.qty, 0), 4);
});
