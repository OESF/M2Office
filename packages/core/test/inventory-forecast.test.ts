/**
 * @file 在庫の見張りの計算の単体テスト（仕様書 第29.14節）。
 *
 * 使う速さ（過去 4 週の使用。取り消しは差し引き、調整は入れない）、あと何日で無くなるか、
 * 仕入れにかかる日数（品目・仕入先・会社の既定の順）、発注の数（届くまでと届いてから 2 週間分と目安。入り数で切り上げ）、
 * 使用期限の近いロット、急ぐ順の並びを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type InventoryItemView, type InventorySettings } from '@m2office/shared';
import { forecastItem, sortForecast, InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';

const settings: InventorySettings = { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, order: true } };

function item(over: Partial<InventoryItemView>): InventoryItemView {
  return {
    id: 'i1', name: 'トナー', publicName: '', sku: '', category: '', unit: '本', packUnit: '', packSize: null, price: null,
    priceTaxIncluded: true, photoFileId: null, lowThreshold: null, supplierId: null, leadDays: null, note: '', status: 'active',
    codes: [], updatedAt: '', onHand: 10, reserved: 0, expired: 0, available: 10, low: false, nearestExpiry: null, ...over,
  };
}

test('あと何日で無くなるかを出し、仕入れにかかる日数より早ければ発注の案を作る', () => {
  // 4 週で 28 本 → 1 日 1 本。使える数 5 本 → あと 5 日。仕入れに 7 日（会社の既定）
  const r = forecastItem(item({ available: 5 }), 28, [], null, settings, '2026-09-29');
  assert.deepEqual([r.dailyUse, r.daysLeft, r.leadDays, r.runningOut], [1, 5, 7, true]);
  // 届くまで 7 日 + 届いてから 14 日 = 21 本 + 目安 3 本 − 使える 5 本 = 19 本
  assert.equal(r.proposal?.qty, 19);
  assert.match(r.proposal?.reason ?? '', /1 日 1 本使用。あと 5 日で無くなる見込み（仕入れに 7 日）/);
});

test('発注の数は入り数で切り上げる。仕入れの日数は品目・仕入先・会社の既定の順', () => {
  const supplier = { id: 's1', name: '文具店', method: 'mail' as const, contact: 'order@example.jp', leadDays: 3, note: '', status: 'active' as const };
  const r = forecastItem(item({ available: 2, low: true, packUnit: '箱', packSize: 10 }), 14, [], supplier, settings, '2026-09-29');
  assert.equal(r.leadDays, 3, '仕入先の日数');
  // 1 日 0.5 本 ×（3 日 + 14 日）+ 目安 3 本 − 使える 2 本 = 9.5 本 → 10 本 → 1 箱（10 本）
  assert.deepEqual([r.proposal?.packs, r.proposal?.qty, r.proposal?.supplierName, r.proposal?.contact], [1, 10, '文具店', 'order@example.jp']);
  const own = forecastItem(item({ available: 2, low: true, leadDays: 1 }), 14, [], supplier, settings, '2026-09-29');
  assert.equal(own.leadDays, 1, '品目の日数が先');
});

test('使っていない品目は無くなる見込みを出さず、残りわずかなら目安を理由にする。発注の案を切った会社では案を作らない', () => {
  const r = forecastItem(item({ available: 1, low: true }), 0, [], null, settings, '2026-09-29');
  assert.deepEqual([r.daysLeft, r.runningOut], [null, false]);
  assert.match(r.proposal?.reason ?? '', /目安（3 本）以下/);
  const off = forecastItem(item({ available: 1, low: true }), 0, [], null, { ...settings, features: { ...settings.features, order: false } }, '2026-09-29');
  assert.equal(off.proposal, null);
  const enough = forecastItem(item({ available: 100 }), 28, [], null, settings, '2026-09-29');
  assert.equal(enough.proposal, null, '足りていれば案を作らない');
});

test('使用期限が 30 日以内のロットを近い順に出す（切れたものは負の日数）', () => {
  const r = forecastItem(item({}), 0, [
    { lot: 'A', expiresOn: '2026-10-05', qty: 2 }, { lot: 'B', expiresOn: '2026-12-31', qty: 5 }, { lot: 'C', expiresOn: '2026-09-20', qty: 1 },
  ], null, settings, '2026-09-29');
  assert.deepEqual(r.expiring.map((e) => [e.lot, e.days]), [['C', -9], ['A', 6]]);
});

test('急ぐ順: 無くなる見込み → 残りわずか → 期限 → そのほか', () => {
  const rows = [
    forecastItem(item({ id: 'plain', name: 'ふつう', available: 100 }), 0, [], null, settings, '2026-09-29'),
    forecastItem(item({ id: 'low', name: '少ない', available: 1, low: true }), 0, [], null, settings, '2026-09-29'),
    forecastItem(item({ id: 'out', name: '無くなる', available: 3 }), 28, [], null, settings, '2026-09-29'),
  ];
  assert.deepEqual(sortForecast(rows).map((r) => r.itemId), ['out', 'low', 'plain']);
});

test('処理: 使う速さは使用の記録から出し、取り消しは差し引き、調整は入れない', async () => {
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: settings }),
    appendAudit: async () => undefined,
  } as unknown as Repository;
  const service = new InventoryService({ store: new MemoryInventoryStore(), repo });
  const made = await service.createItem('t1', 'u1', { name: '紙', unit: '冊' }, 30);
  assert.ok('item' in made);
  const out = await service.recordMove('t1', 'u1', { kind: 'out', itemId: made.item.id, qty: 14 });
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: made.item.id, qty: 5 }).then((r) => (r.ok ? service.undo('t1', 'u1', r.moves[0]!.id) : null));
  await service.recordMove('t1', 'u1', { kind: 'adjust', itemId: made.item.id, qty: -2, reason: '破損' });
  assert.ok(out.ok);
  const [row] = await service.forecast('t1');
  assert.equal(row!.dailyUse, 0.5, '14 冊 ÷ 28 日（取り消した 5 冊と調整の 2 冊は入れない）');
  assert.equal(row!.daysLeft, 28, '使える 14 冊 ÷ 1 日 0.5 冊');
});

test('案の理由は、案を出した理由と同じことを書く（残りわずかなら目安。無くなる見込みの日数を出さない）', () => {
  // 1 日 0.04 本・使える 1 本 → あと 25 日（仕入れ 7 日より長い）。残りわずか（目安 3）で案を出す
  const r = forecastItem(item({ available: 1, low: true }), 1, [], null, settings, '2026-09-29');
  assert.equal(r.runningOut, false);
  assert.equal(r.proposal?.reason, '使える数が目安（3 本）以下。過去 4 週で 1 日 0.04 本使用');
});
