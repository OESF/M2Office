/**
 * @file 在庫の Web への公開の単体テスト（仕様書 第29.12節・第29.12.1節）。
 *
 * 承認した品目と項目だけを出すこと、状態の決め方、承認のあとに足した品目を出さないこと、鍵を変えないこと、
 * 止めた・公開を切った・鍵の違う公開を区別せずに出さないこと、在庫が変わったら作り直すこと、
 * 埋め込みのページが文字を逃がしスクリプトを持たないこと、監査ログに残すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type InventorySettings, type TenantSettings } from '@m2office/shared';
import { InventoryPublisher, InventoryService, MemoryInventoryStore, renderPublicPage, type Repository } from '../src/index.js';

function setup(inventory: Partial<InventorySettings> = {}) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    inventory: {
      ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, lowDefault: 3, ...inventory,
      features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, publish: true, ...(inventory.features ?? {}) },
    },
  };
  const repo = {
    getTenantSettings: async () => settings,
    listUsers: async () => [{ id: 'u-admin', displayName: '管理 太郎' }],
    listTenantIds: async () => ['t1'],
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryInventoryStore();
  let touched = 0;
  const service = new InventoryService({ store, repo, onPublicChange: () => { touched++; } });
  const publisher = new InventoryPublisher({ store, service, repo });
  return {
    store, service, publisher, audits, touched: () => touched,
    set: (s: Partial<InventorySettings>) => { settings = { ...settings, inventory: { ...settings.inventory, ...s } }; },
  };
}

async function item(service: InventoryService, name: string, qty: number, extra: Record<string, unknown> = {}) {
  const r = await service.saveItem('t1', 'u1', { name, ...extra });
  assert.ok('item' in r, JSON.stringify(r));
  if (qty) await service.recordMove('t1', 'u1', { kind: 'in', itemId: r.item.id, qty });
  return r.item;
}

test('公開の中身: 承認した品目と項目だけ。状態は使える数で決まり、仕入れや内部のコードは出さない', async () => {
  const { service, publisher } = setup();
  const a = await item(service, 'ハンドクリーム', 10, { publicName: '保湿ハンドクリーム', category: '化粧品', price: 1200, sku: 'HC-01', note: '仕入れ 600 円' });
  const b = await item(service, '日焼け止め', 2, { category: '化粧品', price: 2400 });
  const c = await item(service, 'マスク', 0, { category: '衛生' });
  await item(service, '出さない品目', 5);
  const stateOnly = await publisher.preview('t1', { itemIds: [a.id, b.id, c.id], fields: ['category'], showCount: false });
  assert.ok(!('error' in stateOnly));
  assert.deepEqual(stateOnly.items, [
    { name: '保湿ハンドクリーム', category: '化粧品', status: 'in' },
    { name: '日焼け止め', category: '化粧品', status: 'low' },
    { name: 'マスク', category: '衛生', status: 'out' },
  ], '価格・数は選ばなければ出ない。公開する名前が優先');
  const all = await publisher.preview('t1', { itemIds: [a.id], fields: ['price'], showCount: true });
  assert.ok(!('error' in all));
  assert.deepEqual(all.items[0], { name: '保湿ハンドクリーム', price: 1200, priceTaxIncluded: true, available: 10, unit: '個', status: 'in' });
  assert.ok(!JSON.stringify(all).includes('HC-01') && !JSON.stringify(all).includes('仕入れ'), 'コードとメモは出さない');
  assert.deepEqual(await publisher.preview('t1', { itemIds: ['知らない'], fields: [], showCount: false }), { error: '公開する品目を選んでください' });
});

test('承認: 押した管理者が承認者になり、鍵は変えず、承認のあとに足した品目は承認し直すまで出さない', async () => {
  const { service, publisher, audits } = setup();
  const a = await item(service, 'ハンドクリーム', 10);
  const first = await publisher.approve('t1', 'u-admin', { itemIds: [a.id], fields: [], showCount: false });
  assert.ok(!('error' in first) && first.publication);
  assert.equal(first.publication.approvedByName, '管理 太郎');
  const key = first.publication.key;
  assert.match(key, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await publisher.byKey(key))?.items.length, 1);

  await item(service, '新しい品目', 4);
  await publisher.refresh('t1');
  assert.equal((await publisher.byKey(key))?.items.length, 1, '承認していない品目は出ない');

  const again = await publisher.approve('t1', 'u-admin', { itemIds: [a.id, ...(await service.list('t1')).map((i) => i.id)], fields: ['price'], showCount: true });
  assert.ok(!('error' in again));
  assert.equal(again.publication?.key, key, '承認し直しても鍵は変えない');
  assert.equal((await publisher.byKey(key))?.items.length, 2);
  assert.deepEqual(audits.map((x) => x.action), ['inventory.publication.approve', 'inventory.publication.approve']);
});

test('出さないとき: 止めた・公開を切った・鍵の違う公開は、どれも null。止めたら監査ログに残し、承認し直すと再開する', async () => {
  const { service, publisher, audits, set } = setup();
  const a = await item(service, 'ハンドクリーム', 10);
  const v = await publisher.approve('t1', 'u-admin', { itemIds: [a.id], fields: [], showCount: false });
  assert.ok(!('error' in v) && v.publication);
  const key = v.publication.key;
  assert.equal(await publisher.byKey('x'.repeat(32)), null);
  assert.equal(await publisher.byKey('短い'), null);
  await publisher.stop('t1', 'u-admin');
  assert.equal(await publisher.byKey(key), null);
  assert.equal(audits.at(-1)?.action, 'inventory.publication.stop');
  await publisher.approve('t1', 'u-admin', { itemIds: [a.id], fields: [], showCount: false });
  assert.ok(await publisher.byKey(key), '承認し直すと再開する');
  set({ features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, publish: false } });
  assert.equal(await publisher.byKey(key), null, '会社で公開を切ったら出さない');
  assert.deepEqual(await publisher.approve('t1', 'u-admin', { itemIds: [a.id], fields: [], showCount: false }), { error: '会社の設定で「Web への公開」が切られています' });
});

test('作り直し: 入出庫・品目の修正で知らせ、作り直すと使える数と状態が変わる。止めた品目は出さない', async () => {
  const { service, publisher, touched } = setup();
  const a = await item(service, 'ハンドクリーム', 10);
  const v = await publisher.approve('t1', 'u-admin', { itemIds: [a.id], fields: [], showCount: true });
  assert.ok(!('error' in v) && v.publication);
  const before = touched();
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 8 });
  await service.saveItem('t1', 'u1', { id: a.id, publicName: '保湿クリーム' });
  assert.ok(touched() >= before + 2, '入出庫と品目の修正で知らせる');
  await publisher.refresh('t1');
  assert.deepEqual((await publisher.byKey(v.publication.key))?.items, [{ name: '保湿クリーム', available: 2, unit: '個', status: 'low' }]);
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 2 });
  assert.ok('ok' in (await service.setItemStatus('t1', 'u-admin', a.id, 'stopped')));
  await publisher.refresh('t1');
  assert.deepEqual((await publisher.byKey(v.publication.key))?.items, [], '止めた品目は出さない');
  assert.equal((await publisher.view('t1')).stoppedInScope, 1);
});

test('埋め込みのページ: 文字を逃がし、スクリプトを持たず、分類で分けて状態と最終更新を出す。無ければ「表示できません」', () => {
  const html = renderPublicPage({
    generatedAt: '2026-10-01T05:05:00Z', showCount: true,
    items: [
      { name: '<script>alert(1)</script>', category: '化粧品', price: 1200, priceTaxIncluded: true, available: 3, unit: '本', status: 'low' },
      { name: 'マスク', category: '', status: 'out' },
    ],
  });
  assert.ok(!/<script/i.test(html), 'スクリプトの形のまま入れない');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h2>化粧品<\/h2>[\s\S]*1,200円（税込）[\s\S]*3本[\s\S]*残りわずか/);
  assert.match(html, /<h2>その他<\/h2>[\s\S]*終了/);
  assert.match(html, /最終更新: 2026年10月1日 14:05/);
  assert.match(renderPublicPage(null), /表示できません/);
});
