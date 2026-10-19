/**
 * @file 減り具合と需要の予測を見る（仕様書 第29.14.1節、Q-243）の単体テスト。
 *
 * 直近 4 週と前の 4 週の 1 日あたりの使用・増減・次の 4 週の見込み（予測の倍率つき）、品目の詳細の週ごとの使用（使っていない週は 0）、
 * 販売品の季節の流行の調べもの（外へ渡すのは分類と時期だけ。販売品が無い・実際に調べていないときは使わない）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';
import { demandBase, seasonalTrend } from '../src/inventory/demand.js';
import { weekStartJst } from '../src/inventory/store.js';
import type { ResearchProvider } from '../src/research/provider.js';

function setup() {
  const store = new MemoryInventoryStore();
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true } }),
    listUserGroupIds: async () => [], appendAudit: async () => undefined,
  } as unknown as Repository;
  return { store, service: new InventoryService({ store, repo }) };
}

test('週の始まりは日本時間の月曜', () => {
  assert.equal(weekStartJst('2026-10-19T00:00:00+09:00'), '2026-10-19', '月曜');
  assert.equal(weekStartJst('2026-10-25T23:00:00+09:00'), '2026-10-19', '日曜はその週');
  assert.equal(weekStartJst('2026-10-18T16:00:00Z'), '2026-10-19', '日本時間で数える');
});

test('減り具合: 1 日の使用・前の 4 週からの増減・次の 4 週の見込み（予測の倍率つき）と、週ごとの使用', async () => {
  const { store, service } = setup();
  const today = '2026-10-19';
  const now = Date.parse(`${today}T12:00:00+09:00`);
  const made = await service.saveItem('t1', 'u1', { name: '茶', unit: '本', price: 160 });
  const id = 'item' in made ? made.item.id : '';
  await store.setForecast('t1', id, { low: 10, factor: 1.5, note: '寒くなる', at: new Date(now).toISOString() });
  const push = (daysAgo: number, qty: number) => store.moves.push({
    id: `m${daysAgo}`, kind: 'out', itemId: id, lotId: null, fromLocationId: null, toLocationId: null, delta: -qty, reason: '', source: 'manual',
    sourceId: null, reversalOf: null, batchId: 'b', createdBy: 'u1', createdAt: new Date(now - daysAgo * 86_400_000).toISOString(), tenantId: 't1',
  } as never);
  push(3, 28); push(10, 28); // 直近 4 週で 56 → 1 日 2
  push(40, 28); // 前の 4 週で 28 → 1 日 1
  const [row] = await service.usage('t1', { today });
  assert.equal(row!.daily, 2);
  assert.equal(row!.prevDaily, 1);
  assert.equal(row!.changePct, 100);
  assert.equal(row!.next4w, 84, '1 日 2 本 × 1.5 倍 × 28 日');
  assert.equal(row!.note, '寒くなる');
  const detail = await service.detail('t1', id, today);
  assert.equal(detail!.weekly.length, 12);
  assert.equal(detail!.weekly.at(-1)!.week, '2026-10-19');
  assert.equal(detail!.weekly.reduce((a, w) => a + w.qty, 0), 84, '12 週の使用の合計（使っていない週は 0）');
  assert.equal(detail!.usage?.next4w, 84);
});

test('販売品の季節の流行: 外へ渡すのは分類と時期だけ。販売品が無い・実際に調べていないときは使わない', async () => {
  const asked: string[] = [];
  const research = (source: 'gemini' | 'mock'): ResearchProvider => ({
    name: 'gemini',
    research: async (topic, opts) => { asked.push(`${topic} ${opts?.focus ?? ''}`); return { source, text: '飲料は寒さで温かいものが伸びる', sources: [], queries: [], tokensUsed: 1 }; },
  });
  const sale = demandBase({ id: 'a', name: '〇〇緑茶 500ml', category: '飲料', unit: '本', kind: 'sale' }, 28, 10, 0, 0);
  const supply = demandBase({ id: 'b', name: 'コピー用紙', category: '事務用品', unit: '束', kind: 'supply' }, 28, 10, 0, 0);
  assert.equal(await seasonalTrend(research('gemini'), [sale, supply], '2026-10-19'), '飲料は寒さで温かいものが伸びる');
  assert.match(asked[0]!, /飲料/);
  assert.doesNotMatch(asked[0]!, /緑茶|事務用品|コピー用紙/, '品目の名前と販売品でない分類は渡さない');
  assert.equal(await seasonalTrend(research('gemini'), [supply], '2026-10-19'), '', '販売品が無ければ調べない');
  assert.equal(await seasonalTrend(research('mock'), [sale], '2026-10-19'), '', '実際に調べていない結果は使わない');
  assert.equal(await seasonalTrend(null, [sale], '2026-10-19'), '');
});
