/**
 * @file Phase 2 の需要の予測（仕様書 第29.14.2節・第29.14.3節・第29.24.1節、Q-248）の単体テスト。
 *
 * 予約で使った出庫を使う速さに入れないこと、曜日の重みの出し方と条件、重みを使ったあと何日と発注の案、
 * 終売の見込みの確かめ（出典の番号が合うものだけ）、終売の品目の発注の案（終売済みは出さない・終売予定は終売までの分）、
 * 「終売ではない」とした出典では付け直さないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type InventoryItemView, type InventorySettings, type TenantSettings } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';
import { forecastItem, weekdayNote, weekdayWeights, type ForecastCalendar } from '../src/inventory/forecast.js';
import { pickDiscontinued } from '../src/inventory/market.js';

const settings: InventorySettings = { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true };
const view = (o: Partial<InventoryItemView>): InventoryItemView => ({
  id: 'x', name: '乳液', publicName: '', sku: '', category: '', kind: 'sale', taxRate: 10, unit: '本', packUnit: '', packSize: null, price: 1000,
  priceTaxIncluded: true, employeePrice: null, photoFileId: null, lowThreshold: 3, supplierId: null, leadDays: 7, note: '', status: 'active',
  codes: [], updatedAt: '', onHand: 10, reserved: 0, expired: 0, available: 10, low: false, nearestExpiry: null, ...o,
});

test('曜日の重み: 営業日 1 日あたりの平均に対する比。営業しない曜日は 0、記録が足りなければ出さない', () => {
  const first = '2026-07-01T00:00:00.000Z';
  // 土曜に 3 倍出る（月〜土の営業）
  const rows = [1, 2, 3, 4, 5].map((dow) => ({ dow, qty: 12, days: 5, first })).concat([{ dow: 6, qty: 36, days: 10, first }]);
  const w = weekdayWeights(rows, [1, 2, 3, 4, 5, 6], '2026-10-19');
  assert.deepEqual(w, [0, 0.75, 0.75, 0.75, 0.75, 0.75, 2.25]);
  assert.equal(weekdayNote(w), '土曜に多い');
  assert.equal(weekdayNote([2, 1, 1, 1, 1, 1, 2]), '土日に多い');
  assert.equal(weekdayNote([0, 1.6, 1, 1, 1, 1.7, 0]), '月・金曜に多い');
  assert.equal(weekdayNote([0, 1, 1, 1, 1, 1, 0]), '');
  assert.equal(weekdayWeights(rows.map((r) => ({ ...r, days: 2 })), [1, 2, 3, 4, 5, 6], '2026-10-19'), null, '出庫のあった日が 20 日に満たない');
  assert.equal(weekdayWeights(rows.map((r) => ({ ...r, first: '2026-10-01T00:00:00.000Z' })), [1, 2, 3, 4, 5, 6], '2026-10-19'), null, '使いはじめて 8 週に満たない');
});

test('曜日の重みがあれば、あと何日と届くまでに使う分を日ごとに数える', () => {
  // 明日（月）から: 月〜金は 0.5、土は 3、日は休み
  const dows = Array.from({ length: 90 }, (_, k) => (k + 1) % 7);
  const calendar: ForecastCalendar = { dows, open: dows.map((d) => d !== 0), openLast28: 24 };
  const weekdays = [0, 0.5, 0.5, 0.5, 0.5, 0.5, 3.5];
  const item = view({ available: 5, forecast: { low: null, factor: 1, note: '', at: '', weekdays } });
  // 28 日に 24 本 → 営業日 1 日 1 本。月〜金で 2.5 本、土に 3.5 本 → 土曜の途中で尽きる（5 日もつ）
  const r = forecastItem(item, 24, [], null, settings, '2026-10-18', calendar);
  assert.equal(r.daysLeft, 5);
  assert.equal(r.weekdayNote, '土曜に多い');
  assert.ok(r.runningOut, '仕入れに 7 日かかるので無くなる見込み');
  assert.match(r.proposal?.reason ?? '', /土曜に多い/);
  // 重みが無ければ平らに割る（28 日に 24 本 → 1 日 0.86 本 → 5 本で 5 日）
  const flat = forecastItem(view({ available: 5 }), 24, [], null, settings, '2026-10-18', calendar);
  assert.equal(flat.weekdayNote, null);
  assert.equal(flat.daysLeft, 5);
});

test('終売: 終売済みは発注の案を出さず、終売予定は終売の日までに使う分だけにする', () => {
  const ended = forecastItem(view({ available: 1, low: true, discontinued: { status: 'ended', date: null, successor: '新乳液', url: 'https://m.example/a', source: 'メーカー', checkedAt: '' } }), 28, [], null, settings, '2026-10-19');
  assert.equal(ended.proposal, null);
  assert.equal(ended.discontinued?.status, 'ended');
  // 1 日 1 本、終売まで 10 日、いま 2 本 → 8 本だけ
  const planned = forecastItem(view({ available: 2, low: true, discontinued: { status: 'planned', date: '2026-10-29', successor: '', url: 'https://m.example/b', source: 'メーカー', checkedAt: '' } }), 28, [], null, settings, '2026-10-19');
  assert.equal(planned.proposal?.qty, 8);
  assert.match(planned.proposal?.reason ?? '', /最後の発注/);
  // 終売の日までの分が足りていれば案を出さない
  const enough = forecastItem(view({ available: 20, low: true, discontinued: { status: 'planned', date: '2026-10-29', successor: '', url: 'u', source: 'メーカー', checkedAt: '' } }), 28, [], null, settings, '2026-10-19');
  assert.equal(enough.proposal, null);
});

test('終売の見込みは、出典の番号が合い、状態が決まったものだけを採る', () => {
  const refs = [{ shop: 'メーカー', url: 'https://maker.example/news' }];
  assert.deepEqual(pickDiscontinued({ source: 1, status: 'planned', date: '2026-12-31', successor: '新乳液' }, refs, 'T'),
    { status: 'planned', date: '2026-12-31', successor: '新乳液', url: 'https://maker.example/news', source: 'メーカー', checkedAt: 'T' });
  assert.equal(pickDiscontinued({ source: 2, status: 'planned' }, refs, 'T'), null, '番号が合わない');
  assert.equal(pickDiscontinued({ source: 1, status: 'maybe' }, refs, 'T'), null, '状態が決まらない');
  assert.equal(pickDiscontinued(null, refs, 'T'), null);
  assert.equal(pickDiscontinued({ source: 1, status: 'ended', date: '12月末' }, refs, 'T')?.date, null, '日付の形でなければ空');
});

test('予約で使った出庫は使う速さに入れず、「終売ではない」とした出典では付け直さない', async () => {
  const tenant: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: settings };
  const repo = { getTenantSettings: async () => tenant, listUserGroupIds: async () => [], appendAudit: async () => undefined } as unknown as Repository;
  const store = new MemoryInventoryStore();
  const service = new InventoryService({ store, repo });
  const r = await service.saveItem('t1', 'u1', { name: '体験セット', kind: 'supply' });
  assert.ok('item' in r);
  const id = r.item.id;
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: id, qty: 100 });
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: id, qty: 5 });
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: id, qty: 20, source: 'reservation' });
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const until = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await store.usageByItem('t1', since, until)).get(id), 5, '予約の 20 は数えない');
  const [row] = await service.forecast('t1');
  assert.equal(row?.dailyUse, Math.round((5 / 28) * 100) / 100);

  const d = { status: 'planned' as const, date: null, successor: '', url: 'https://maker.example/x', source: 'メーカー', checkedAt: 'T' };
  assert.deepEqual(await service.markDiscontinued('t1', 'watch', id, d), { ok: true, changed: true });
  assert.deepEqual(await service.markDiscontinued('t1', 'watch', id, d), { ok: true, changed: false }, '同じものは新しくない');
  assert.deepEqual(await service.dismissDiscontinued('t1', 'u1', id), { ok: true });
  assert.equal((await service.list('t1')).find((i) => i.id === id)?.discontinued, null);
  assert.deepEqual(await service.markDiscontinued('t1', 'watch', id, d), { ok: true, changed: false }, '外した出典では付け直さない');
  assert.equal((await service.list('t1')).find((i) => i.id === id)?.discontinued, null);
});
