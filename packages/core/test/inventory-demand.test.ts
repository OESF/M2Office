/**
 * @file 在庫の需要の予測（仕様書 第29.14節、Q-116、ADR-0103）の単体テスト。
 *
 * 土台（直近 4 週と去年の同じ時期の伸び）の計算、倍率の幅、履歴の足りない品目を予測しないこと、
 * 会社が目安を決めた品目（固定）の目安を変えないこと、予測の倍率で発注の案が変わること、月曜の朝に週 1 回回すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INVENTORY_SETTINGS, type InventoryItemView } from '@m2office/shared';
import { MemoryInventoryStore, demandBase, demandDue, forecastDemand } from '../src/index.js';
import { effectiveLow, forecastItem } from '../src/inventory/forecast.js';

const settings = { ...DEFAULT_INVENTORY_SETTINGS, enabled: true };
const item = (id: string, o: Partial<InventoryItemView> = {}) => ({
  id, name: id, publicName: '', sku: '', category: '飲料', unit: '本', packUnit: '', packSize: null, price: null, priceTaxIncluded: true, employeePrice: null,
  photoFileId: null, lowThreshold: null, supplierId: null, leadDays: null, note: '', status: 'active' as const, ...o,
});

test('土台: 去年の同じ時期の伸びを 0.5〜3 倍に収め、去年の記録が無ければ 1', () => {
  assert.equal(demandBase(item('a'), 28, 10, 100, 180).seasonal, 1.8);
  assert.equal(demandBase(item('a'), 28, 10, 10, 100).seasonal, 3, '3 倍を超えない');
  assert.equal(demandBase(item('a'), 28, 10, 0, 0).seasonal, 1);
  assert.equal(demandBase(item('a'), 28, 0, 0, 0).enough, false, '4 週より前の記録が無ければ予測しない');
  assert.equal(demandBase(item('a'), 56, 0, 0, 0).recentDaily, 2);
});

test('予測の目安と倍率を書き、会社が目安を決めた品目の目安は効かせない', async () => {
  const store = new MemoryInventoryStore();
  const now = new Date('2026-12-07T00:00:00Z'); // 月曜の朝 9 時（日本時間）
  for (const id of ['tea', 'water', 'new']) await store.saveItem('t1', item(id, id === 'water' ? { lowThreshold: 50 } : {}), 'u1', now.toISOString());
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const move = (itemId: string, daysAgo: number, qty: number) => store.moves.push({
    id: `${itemId}-${daysAgo}`, kind: 'out', itemId, lotId: null, fromLocationId: null, toLocationId: null, delta: -qty, reason: '', source: 'manual',
    sourceId: null, reversalOf: null, batchId: 'b', createdBy: 'u1', createdAt: at(daysAgo), tenantId: 't1',
  } as never);
  move('tea', 10, 28); move('tea', 40, 20); move('tea', 380, 10); move('tea', 350, 20);
  move('water', 10, 56); move('water', 40, 56);
  move('new', 5, 10);
  const n = await forecastDemand({ store, llm: null, leadDaysOf: () => 7 }, 't1', settings, now);
  assert.equal(n, 2, '履歴が 4 週に満たない品目は予測しない');
  const items = await store.listItems('t1');
  const tea = items.find((i) => i.id === 'tea')!;
  assert.equal(tea.forecast?.factor, 2, '去年の同じ時期は 2 倍');
  assert.match(tea.forecast?.note ?? '', /去年の同じ時期は 2 倍/);
  assert.equal(tea.forecast?.low, 14, '1 日 1 本 × 2 倍 × 仕入れ 7 日');
  assert.equal(items.find((i) => i.id === 'new')?.forecast ?? null, null);
  const water = items.find((i) => i.id === 'water')!;
  assert.equal(effectiveLow(water, settings), 50, '会社が決めた目安（固定）が先');
  assert.equal(effectiveLow(tea, settings), 14);
  assert.equal(effectiveLow(tea, { ...settings, features: { ...settings.features, forecast: false } }), settings.lowDefault, '予測を切れば会社の既定');
});

test('予測の倍率で、使う速さと発注の案が変わる', () => {
  const view = { ...item('tea'), onHand: 10, reserved: 0, expired: 0, available: 10, low: true, nearestExpiry: null, codes: [], updatedAt: '' } as unknown as InventoryItemView;
  const plain = forecastItem(view, 28, [], null, settings, '2026-12-07');
  const boosted = forecastItem({ ...view, forecast: { low: 14, factor: 2, note: '年末の需要', at: '' } } as InventoryItemView, 28, [], null, settings, '2026-12-07');
  assert.equal(plain.dailyUse, 1);
  assert.equal(boosted.dailyUse, 2);
  assert.ok((boosted.proposal?.qty ?? 0) > (plain.proposal?.qty ?? 0));
  assert.match(boosted.proposal?.reason ?? '', /年末の需要/);
  assert.equal(boosted.forecastNote, '年末の需要');
});

test('月曜の朝 6 時から、前の予測から 5 日たっていれば回す', () => {
  const mon = new Date('2026-12-07T00:00:00Z'); // 月曜 9 時（日本時間）
  assert.equal(demandDue(mon, null), true);
  assert.equal(demandDue(mon, new Date(mon.getTime() - 3 * 86_400_000).toISOString()), false);
  assert.equal(demandDue(new Date('2026-12-06T20:00:00Z'), null), false, '月曜の 5 時（日本時間）はまだ');
  assert.equal(demandDue(new Date('2026-12-08T00:00:00Z'), null), false, '火曜は回さない');
});
