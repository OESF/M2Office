/**
 * @file 在庫管理の処理と道具の単体テスト（仕様書 第29章）。
 *
 * 使える数の求め方、使用期限の近いロットから減らすこと、単位の換算、マイナスの在庫を受け付けて知らせること、
 * 取り消しが逆の記録を足すこと（自分の記録・その日のうち・二重に取り消さない）、会社の境界、
 * 取り込みの列の見出しの読み方、在庫が残る品目と場所を止め・外せないこと、道具が切った会社で使えないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type InventorySettings, type TenantSettings } from '@m2office/shared';
import {
  InventoryService, MemoryInventoryStore, INVENTORY_TOOLS, inventoryAccess, toDate, toNumber, formatQty, splitUnit,
  type Repository, type ToolContext,
} from '../src/index.js';

function setup(inventory: Partial<InventorySettings> = {}) {
  const audits: { action: string; tenantId: string }[] = [];
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, ...inventory, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, ...(inventory.features ?? {}) } },
  };
  const repo = {
    getTenantSettings: async () => settings,
    listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string; tenantId: string }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryInventoryStore();
  const service = new InventoryService({ store, repo });
  return { service, store, repo, audits, set: (s: Partial<InventorySettings>) => { settings = { ...settings, inventory: { ...settings.inventory, ...s } }; } };
}

async function item(service: InventoryService, name: string, extra: Record<string, unknown> = {}) {
  const r = await service.saveItem('t1', 'u1', { name, ...extra });
  assert.ok('item' in r, JSON.stringify(r));
  return r.item;
}

test('入庫と使用で使える数が変わり、場所が無ければ既定の場所を作る', async () => {
  const { service } = setup();
  const a = await item(service, 'コピー用紙');
  const r1 = await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 10 });
  assert.ok(r1.ok);
  assert.equal(r1.item.available, 10);
  assert.equal((await service.locations('t1')).length, 1, '場所を選ばずに使える');
  const r2 = await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 8 });
  assert.ok(r2.ok);
  assert.equal(r2.item.available, 2);
  assert.equal(r2.item.low, true, '既定の目安（3）以下は残りわずか');
});

test('ロット: 使用期限の近いものから減らし、期限切れは使える数から外す（自動で消さない）', async () => {
  const { service } = setup({ features: { lots: true } as InventorySettings['features'] });
  const a = await item(service, 'ハンドクリーム');
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 5, lot: 'B', expiresOn: '2027-06-30' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 3, lot: 'A', expiresOn: '2027-01-31' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 2, lot: 'OLD', expiresOn: '2020-01-01' });
  const used = await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 4 });
  assert.ok(used.ok);
  assert.deepEqual(used.moves.map((m) => [m.lot, m.delta]), [['A', -3], ['B', -1]], '切れていないロットのうち期限の近い順');
  const [view] = await service.list('t1', { today: '2026-09-29' });
  assert.equal(view!.onHand, 6);
  assert.equal(view!.expired, 2);
  assert.equal(view!.available, 4);
  assert.equal(view!.nearestExpiry, '2020-01-01');
});

test('単位の換算: 仕入れの単位で入れて使う単位で持つ。換算を切った会社では断る', async () => {
  const { service, set } = setup({ features: { units: true } as InventorySettings['features'] });
  const a = await item(service, '注射', { unit: '回', packUnit: '本', packSize: 5 });
  const r = await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 2, unit: 'pack' });
  assert.ok(r.ok);
  assert.equal(r.item.onHand, 10);
  assert.equal(formatQty(r.item, 10), '10 回（2 本）');
  set({ features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, units: false } });
  const off = await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 1, unit: 'pack' });
  assert.equal(off.ok, false);
});

test('マイナスの在庫は受け付けて知らせる。調整は理由が要り、監査ログに残す', async () => {
  const { service, audits } = setup();
  const a = await item(service, 'トナー');
  const r = await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 2 });
  assert.ok(r.ok);
  assert.equal(r.item.onHand, -2);
  assert.match(r.warnings.join(), /マイナス/);
  const noReason = await service.recordMove('t1', 'u1', { kind: 'adjust', itemId: a.id, qty: 2 });
  assert.equal(noReason.ok, false);
  const adj = await service.recordMove('t1', 'u1', { kind: 'adjust', itemId: a.id, qty: 2, reason: '数え直し' });
  assert.ok(adj.ok);
  assert.equal(adj.item.onHand, 0);
  assert.ok(audits.some((e) => e.action === 'inventory.adjust'));
});

test('移動: 元から減らして先に足す。元と先が同じなら断る', async () => {
  const { service } = setup();
  const a = await item(service, '体験セット');
  const w1 = await service.addLocation('t1', '本店', '棚A');
  const w2 = await service.addLocation('t1', '本店', '店頭');
  assert.ok(!('error' in w1) && !('error' in w2));
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 5, locationId: w1.id });
  const t = await service.recordMove('t1', 'u1', { kind: 'transfer', itemId: a.id, qty: 2, locationId: w1.id, toLocationId: w2.id });
  assert.ok(t.ok);
  const d = await service.detail('t1', a.id);
  assert.deepEqual(d!.stock.map((s) => [s.locationId, s.qty]).sort(), [[w1.id, 3], [w2.id, 2]].sort());
  assert.equal(d!.item.onHand, 5, '移動で合計は変わらない');
  const same = await service.recordMove('t1', 'u1', { kind: 'transfer', itemId: a.id, qty: 1, locationId: w1.id, toLocationId: w1.id });
  assert.equal(same.ok, false);
  const removed = await service.removeLocation('t1', 'u1', w2.id);
  assert.ok('error' in removed, '在庫が残る場所は外せない');
});

test('取り消し: 逆の記録を足す。自分の記録だけ・一緒に足した記録はまとめて・二度は取り消さない', async () => {
  const { service, store } = setup({ features: { lots: true } as InventorySettings['features'] });
  const a = await item(service, 'マスク');
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 2, lot: 'A', expiresOn: '2027-01-01' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 2, lot: 'B', expiresOn: '2027-02-01' });
  const used = await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 3 });
  assert.ok(used.ok && used.moves.length === 2);
  const other = await service.undo('t1', 'u2', used.moves[0]!.id);
  assert.equal(other.ok, false, 'ほかの人の記録は取り消せない');
  const undone = await service.undo('t1', 'u1', used.moves[0]!.id);
  assert.ok(undone.ok);
  assert.equal(undone.moves.length, 2);
  assert.equal(undone.item.onHand, 4);
  assert.equal(store.moves.length, 6, '記録は消さず、足すだけ（入庫 2・使用 2・取り消し 2）');
  const again = await service.undo('t1', 'u1', used.moves[1]!.id);
  assert.equal(again.ok, false);
  const reversal = await service.undo('t1', 'u1', undone.moves[0]!.id);
  assert.equal(reversal.ok, false, '取り消しの記録は取り消せない');
});

test('会社の境界: ほかの会社の品目・記録は見えず、動かせない', async () => {
  const { service } = setup();
  const a = await item(service, '共有しない品');
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 3 });
  assert.equal((await service.list('t2')).length, 0);
  assert.equal(await service.detail('t2', a.id), null);
  const r = await service.recordMove('t2', 'u9', { kind: 'out', itemId: a.id, qty: 1 });
  assert.equal(r.ok, false);
  assert.equal((await service.history('t2', {})).length, 0);
});

test('品目: バーコードは会社の中で重ならない。在庫が残れば止められない。GS1 で引ける', async () => {
  const { service } = setup();
  const a = await item(service, '品 A', { codes: ['4901234567894'] });
  const b = await service.saveItem('t1', 'u1', { name: '品 B', codes: ['4901234567894'] });
  assert.ok('error' in b && /ほかの品目/.test(b.error));
  const found = await service.lookup('t1', '(01)04901234567894(17)270200(10)L9');
  assert.equal(found.item?.id, a.id);
  assert.equal(found.parsed.expiresOn, '2027-02-28');
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 1 });
  assert.ok('error' in (await service.setItemStatus('t1', 'u1', a.id, 'stopped')));
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 1 });
  assert.deepEqual(await service.setItemStatus('t1', 'u1', a.id, 'stopped'), { ok: true });
  const stopped = await service.recordMove('t1', 'u1', { kind: 'in', itemId: a.id, qty: 1 });
  assert.equal(stopped.ok, false, '止めた品目には記録しない');
});

test('取り込み: よくある見出しを読み、新しい品目だけに在庫の数を入れる。同じコードの品目は直す', async () => {
  const { service, audits } = setup();
  const r1 = await service.importRows('t1', 'u1', [
    ['品番', '商品名', '入数', '在庫数量', '保管場所', '売価'],
    ['A-1', 'コピー用紙 A4', '5', '12', '本社倉庫', '1,200円'],
    ['A-2', 'トナー 黒', null, '3', '本社倉庫', null],
    [null, null, null, null, null, null],
    ['A-3', null, null, '1', null, null],
  ]);
  assert.equal(r1.created, 2);
  assert.equal(r1.stocked, 2);
  assert.deepEqual(r1.skipped.map((s) => s.row), [5], '品名の無い行だけを残す（空の行は数えない）');
  const r2 = await service.importRows('t1', 'u1', [['品番', '商品名', '在庫数量'], ['A-1', 'コピー用紙（A4）', '99']]);
  assert.equal(r2.updated, 1);
  const paper = (await service.list('t1', { q: 'A-1' }))[0]!;
  assert.equal(paper.name, 'コピー用紙（A4）');
  assert.equal(paper.onHand, 12, '今ある品目の数は取り込みで上書きしない');
  assert.equal(paper.price, 1200);
  assert.equal((await service.locations('t1'))[0]!.warehouse, '本社倉庫');
  const none = await service.importRows('t1', 'u1', [['あ', 'い'], ['1', '2']]);
  assert.match(none.skipped[0]!.reason, /品名の列/);
  assert.equal(audits.filter((e) => e.action === 'inventory.import').length, 2);
});

test('値の読み方: 数は全角や単位つきも読み、日付は読めなければ null（推測しない）', () => {
  assert.equal(toNumber('１２個'), 12);
  assert.equal(toNumber('¥1,500'), 1500);
  assert.equal(toNumber('たくさん'), null);
  assert.equal(toDate('2027/2'), '2027-02-28');
  assert.equal(toDate('2027年3月5日'), '2027-03-05');
  assert.equal(toDate('2027-02-30'), null);
  assert.equal(toDate('来月'), null);
});

test('道具: 在庫管理を切った会社では使えない。品目が決まらなければ記録せず候補を返す', async () => {
  const { service, repo, set } = setup();
  await item(service, 'コピー用紙 A4');
  await item(service, 'コピー用紙 B5');
  const ctx = {
    tenantId: 't1', userId: 'u1', runId: 'r1',
    inventory: { service, access: () => inventoryAccess(repo)('t1', 'u1') },
  } as unknown as ToolContext;
  const move = INVENTORY_TOOLS.find((t) => t.name === 'inventory.move')!;
  const search = INVENTORY_TOOLS.find((t) => t.name === 'inventory.search')!;
  const ambiguous = await move.invoke({ kind: 'in', item: 'コピー用紙', qty: 1 }, ctx) as { recorded: boolean; candidates?: string[] };
  assert.equal(ambiguous.recorded, false);
  assert.equal(ambiguous.candidates?.length, 2);
  const ok = await move.invoke({ kind: 'in', item: 'コピー用紙 A4', qty: 3 }, ctx) as { recorded: boolean; availableNow: string };
  assert.equal(ok.recorded, true);
  assert.equal(ok.availableNow, '3 個');
  const found = await search.invoke({ query: 'B5' }, ctx) as { count: number };
  assert.equal(found.count, 1);
  set({ enabled: false });
  const off = await search.invoke({ query: 'A4' }, ctx) as { available: boolean };
  assert.equal(off.available, false);
});

test('品目を作るとき: はじめの数を入庫として記録する。単位の欄の数は尋ねずに数として読む。直すときは断る', async () => {
  const { service } = setup();
  const withQty = await service.createItem('t1', 'u1', { name: 'コピー用紙', unit: '冊' }, 7);
  assert.ok('item' in withQty);
  assert.equal(withQty.item.onHand, 7);
  assert.equal(withQty.moves[0]?.reason, 'はじめの数');
  assert.equal(withQty.note, null);
  const numeric = await service.createItem('t1', 'u1', { name: 'ワクチン', unit: '3' });
  assert.ok('item' in numeric);
  assert.deepEqual([numeric.item.unit, numeric.item.onHand], ['個', 3], '「3」は数。単位は既定の「個」');
  assert.match(numeric.note ?? '', /はじめの数 3 個/);
  const withName = await service.createItem('t1', 'u1', { name: 'トナー', unit: '２本' });
  assert.ok('item' in withName);
  assert.deepEqual([withName.item.unit, withName.item.onHand], ['本', 2], '「２本」は数 2・単位 本（全角も読む）');
  const both = await service.createItem('t1', 'u1', { name: 'マスク', unit: '5' }, 10);
  assert.ok('item' in both);
  assert.deepEqual([both.item.unit, both.item.onHand, both.note], ['個', 10, null], 'はじめの数の欄があればそちらを使う');
  const none = await service.createItem('t1', 'u1', { name: '手袋', unit: '双' });
  assert.ok('item' in none);
  assert.deepEqual([none.item.onHand, none.moves.length], [0, 0], '数を入れなければ記録しない');
  const update = await service.saveItem('t1', 'u1', { id: none.item.id, unit: '4' });
  assert.ok('error' in update && /呼び名/.test(update.error));
  assert.deepEqual(splitUnit('個'), { unit: '個', qty: null });
  await service.saveItem('t1', 'u1', { id: none.item.id, codes: ['4901234567894'] });
  const dup = await service.createItem('t1', 'u1', { name: '別の手袋', codes: ['4901234567894'] }, 5);
  assert.ok('error' in dup && /手袋/.test(dup.error));
  assert.equal((await service.list('t1', { q: '別の手袋' })).length, 0, 'バーコードが重なれば品目を作らない');
});
