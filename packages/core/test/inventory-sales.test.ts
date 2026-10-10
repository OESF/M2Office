/**
 * @file 在庫管理と販売管理のつなぎの確かめ（仕様書 第29.20.1節、ADR-0087）。
 *
 * つなぎの作成と鍵・渡す範囲の承認、商品の一覧（承認した範囲だけ・分類の絞り込み・変わった品目だけ・外れた品目）、
 * 販売の通知（取り置き・販売・取り消し・返品・二重に数えない・照らせない行と品目を選んでの記録）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  InventoryService, MemoryInventoryStore, InventorySales, MemorySalesStore, parseSaleEvent, salesKeyHash, SALES_RATE_PER_MINUTE,
  type Repository, type SalesItem,
} from '../src/index.js';

function setup() {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true } };
  const repo = {
    getTenantSettings: async () => settings,
    listUserGroupIds: async () => [],
    listUsers: async () => [{ id: 'u-admin', displayName: '管理者' }],
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const inv = new MemoryInventoryStore();
  const service = new InventoryService({ store: inv, repo });
  const store = new MemorySalesStore(inv);
  const sales = new InventorySales({ store, service, repo });
  return { service, sales, store, audits };
}

async function item(service: InventoryService, name: string, extra: Record<string, unknown> = {}, qty = 10) {
  const r = await service.createItem('t1', 'u1', { name, unit: '個', ...extra }, qty);
  assert.ok('item' in r, JSON.stringify(r));
  return r.item;
}

const available = async (service: InventoryService, id: string) => (await service.list('t1')).find((i) => i.id === id)!.available;
const onHand = async (service: InventoryService, id: string) => (await service.list('t1')).find((i) => i.id === id)!.onHand;

test('つなぎ: 鍵は一度だけ返り、ハッシュだけを持つ。承認するまで一覧は空。止めると鍵が効かない', async () => {
  const { service, sales, store, audits } = setup();
  const cream = await item(service, 'ハンドクリーム', { category: '販売品', sku: 'HC-050', price: 1980, employeePrice: 1500, codes: ['4901234567894'] });
  const made = await sales.create('t1', 'u-admin', 'レジ');
  assert.ok('key' in made);
  assert.equal(made.key.length, 32);
  const rec = (await store.getLink('t1', made.link.id))!;
  assert.equal(rec.keyHash, salesKeyHash(made.key));
  assert.ok(!JSON.stringify(rec).includes(made.key), '鍵そのものは持たない');
  const hit = await sales.authenticate(made.key);
  assert.deepEqual(hit, { tenantId: 't1', linkId: made.link.id });
  const empty = await sales.listItems('t1', made.link.id, {});
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.status === 200 && empty.body.items, [], '承認するまで何も渡さない');

  await sales.approve('t1', 'u-admin', made.link.id, { itemIds: [cream.id], showCount: true, price: true, employeePrice: false });
  const r = await sales.listItems('t1', made.link.id, {});
  assert.equal(r.status, 200);
  const it = (r.status === 200 ? r.body.items[0] : null) as SalesItem;
  assert.equal(it.name, 'ハンドクリーム');
  assert.equal(it.code, 'HC-050');
  assert.deepEqual(it.barcodes, ['4901234567894']);
  assert.equal(it.available, 10);
  assert.deepEqual(it.price, { amount: 1980, taxIncluded: true });
  assert.equal('employeePrice' in it, false, '社員価格は承認しなければ渡さない');

  const rekeyed = await sales.rekey('t1', 'u-admin', made.link.id);
  assert.ok('key' in rekeyed);
  assert.equal(await sales.authenticate(made.key), null, '前の鍵はすぐ使えない');
  await sales.setStatus('t1', 'u-admin', made.link.id, 'stopped');
  assert.equal(await sales.authenticate(rekeyed.key), null);
  assert.deepEqual(audits.map((a) => a.action), [
    'inventory.sales_link.create', 'inventory.sales_link.approve', 'inventory.sales_link.rekey', 'inventory.sales_link.stop',
  ]);
  assert.ok('ok' in await sales.remove('t1', 'u-admin', made.link.id));
});

test('一覧: 分類で絞り、変わった品目だけを返し、止めた・分類を変えた・範囲から外した品目は active: false で伝える', async () => {
  const { service, sales } = setup();
  const a = await item(service, 'ハンドクリーム', { category: '販売品' });
  const b = await item(service, 'ボディソープ', { category: '販売品' });
  const c = await item(service, 'コピー用紙', { category: '消耗品' });
  const made = await sales.create('t1', 'u-admin', 'ネットショップ');
  assert.ok('key' in made);
  const id = made.link.id;
  await sales.approve('t1', 'u-admin', id, { itemIds: [a.id, b.id, c.id], showCount: false, price: false, employeePrice: true });
  const first = await sales.listItems('t1', id, { categories: ['販売品'] });
  assert.ok(first.status === 200);
  assert.deepEqual(first.body.items.map((x) => x.id).sort(), [a.id, b.id].sort());
  const it = first.body.items[0] as SalesItem;
  assert.equal('available' in it, false, '数を渡さないつなぎは状態だけ');
  assert.equal(it.employeePrice, null, '社員価格を渡すと承認したが、品目に無ければ null');

  await new Promise((r) => setTimeout(r, 5));
  const since = first.body.asOf;
  await new Promise((r) => setTimeout(r, 5));
  // a を売り、b の分類を変え、c は何もしない
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 3 });
  await service.saveItem('t1', 'u1', { id: b.id, name: 'ボディソープ', category: '消耗品' });
  const diff = await sales.listItems('t1', id, { categories: ['販売品'], updatedSince: since });
  assert.ok(diff.status === 200);
  assert.deepEqual(diff.body.items.find((x) => x.id === a.id) && (diff.body.items.find((x) => x.id === a.id) as SalesItem).status, 'in_stock');
  assert.deepEqual(diff.body.items.find((x) => x.id === b.id), { id: b.id, active: false }, '分類を変えた品目は外れたことを伝える');
  assert.equal(diff.body.items.some((x) => x.id === c.id), false, '変わっていない品目は返さない');

  // 承認し直して a を範囲から外す
  const since2 = diff.body.asOf;
  await new Promise((r) => setTimeout(r, 5));
  await sales.approve('t1', 'u-admin', id, { itemIds: [b.id, c.id], showCount: false, price: false, employeePrice: false });
  const diff2 = await sales.listItems('t1', id, { updatedSince: since2 });
  assert.ok(diff2.status === 200);
  assert.deepEqual(diff2.body.items.find((x) => x.id === a.id), { id: a.id, active: false });

  const bad = await sales.listItems('t1', id, { categories: Array.from({ length: 21 }, (_, i) => `c${i}`) });
  assert.equal(bad.status, 400);
  const paged = await sales.listItems('t1', id, { limit: 1 });
  assert.ok(paged.status === 200 && paged.body.nextCursor);
  const next = await sales.listItems('t1', id, { limit: 1, cursor: paged.body.nextCursor! });
  assert.ok(next.status === 200 && next.body.items.length === 1 && next.body.nextCursor === null);
});

test('販売の通知: 注文で取り置き、出荷で在庫を減らし、取り消しで戻す。遅れて届いた前の状態は動かさない', async () => {
  const { service, sales } = setup();
  const a = await item(service, 'ハンドクリーム', { sku: 'HC-050' });
  const made = await sales.create('t1', 'u-admin', 'ネットショップ');
  assert.ok('key' in made);
  const id = made.link.id;
  await sales.approve('t1', 'u-admin', id, { itemIds: [a.id], showCount: true, price: false, employeePrice: false });
  const post = (body: Record<string, unknown>) => sales.postEvent('t1', id, { occurredAt: '2026-10-10T10:00:00+09:00', ...body });

  const ordered = await post({ eventId: 'e1', saleId: 'ORD-1', status: 'ordered', lines: [{ code: 'HC-050', quantity: 2 }] });
  assert.ok(ordered.status === 200);
  assert.deepEqual(ordered.body.lines, [{ index: 0, itemId: a.id, result: 'held', available: 8 }]);
  assert.equal(await onHand(service, a.id), 10, '取り置きは在庫を減らさない');
  assert.equal(await available(service, a.id), 8);

  // 注文の送り直し（数が変わった）は取り置きを直す
  await post({ eventId: 'e2', saleId: 'ORD-1', status: 'ordered', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.equal(await available(service, a.id), 7);

  const sold = await post({ eventId: 'e3', saleId: 'ORD-1', status: 'sold', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.ok(sold.status === 200 && sold.body.lines[0]!.result === 'used');
  assert.equal(await onHand(service, a.id), 7);
  assert.equal(await available(service, a.id), 7, '取り置きは使ったことになり、二重に減らない');
  const moves = await service.history('t1', { itemId: a.id });
  assert.equal(moves[0]!.source, 'sales');
  assert.equal(moves[0]!.reason, '販売');

  // 遅れて届いた注文は動かさない
  const late = await post({ eventId: 'e4', saleId: 'ORD-1', status: 'ordered', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.ok(late.status === 200 && late.body.lines[0]!.result === 'ignored');
  assert.equal(await available(service, a.id), 7);

  const cancelled = await post({ eventId: 'e5', saleId: 'ORD-1', status: 'cancelled' });
  assert.ok(cancelled.status === 200 && cancelled.body.lines.length === 0);
  assert.equal(await onHand(service, a.id), 10, '販売のあとの取り消しは減らした分を戻す');
  // 取り消しのあとの販売は動かさない
  await post({ eventId: 'e6', saleId: 'ORD-1', status: 'sold', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.equal(await onHand(service, a.id), 10);
});

test('販売の通知: 同じ eventId は二重に数えず、中身が違えば 409。返品は入庫。足りなくても受け付ける', async () => {
  const { service, sales } = setup();
  const a = await item(service, 'ハンドクリーム', { codes: ['4901234567894'] }, 1);
  const made = await sales.create('t1', 'u-admin', 'レジ');
  assert.ok('key' in made);
  const id = made.link.id;
  const body = { eventId: 'pos-1', saleId: 'POS-1', status: 'sold', occurredAt: '2026-10-10T10:00:00+09:00', lines: [{ barcode: '4901234567894', quantity: 2 }] };
  const r1 = await sales.postEvent('t1', id, body);
  const r2 = await sales.postEvent('t1', id, { ...body });
  assert.deepEqual(r2, r1, '送り直しには前と同じ答え');
  assert.equal(await onHand(service, a.id), -1, '足りなくても受け付け、マイナスの在庫にする');
  const conflict = await sales.postEvent('t1', id, { ...body, lines: [{ barcode: '4901234567894', quantity: 5 }] });
  assert.equal(conflict.status, 409);
  const ret = await sales.postEvent('t1', id, { eventId: 'pos-2', saleId: 'POS-1', status: 'returned', occurredAt: '2026-10-11T10:00:00+09:00', lines: [{ barcode: '4901234567894', quantity: 1 }] });
  assert.ok(ret.status === 200 && ret.body.lines[0]!.result === 'returned');
  assert.equal(await onHand(service, a.id), 0);
});

test('販売の通知: 照らせない行は受け付けて残し、品目を選べば記録する。取り消されたら要らなくなる', async () => {
  const { service, sales } = setup();
  const a = await item(service, 'ハンドクリーム');
  const made = await sales.create('t1', 'u-admin', 'レジ');
  assert.ok('key' in made);
  const id = made.link.id;
  const r = await sales.postEvent('t1', id, { eventId: 'x1', saleId: 'POS-9', status: 'sold', occurredAt: '2026-10-10T10:00:00+09:00', lines: [{ code: 'UNKNOWN', quantity: 2 }] });
  assert.ok(r.status === 200);
  assert.equal(r.body.lines[0]!.result, 'unmatched');
  assert.match(r.body.lines[0]!.reason!, /見つかりません/);
  const open = await sales.unmatched('t1');
  assert.equal(open.length, 1);
  assert.equal(open[0]!.saleRef, 'POS-9');
  assert.equal(open[0]!.action, 'use');
  assert.equal((await sales.attention('t1')).count, 1);
  assert.ok('ok' in await sales.resolve('t1', 'u1', open[0]!.id, a.id));
  assert.equal(await onHand(service, a.id), 8);
  assert.equal((await sales.unmatched('t1')).length, 0);
  // 選んで記録した販売も、取り消せば戻る
  await sales.postEvent('t1', id, { eventId: 'x2', saleId: 'POS-9', status: 'cancelled', occurredAt: '2026-10-10T11:00:00+09:00' });
  assert.equal(await onHand(service, a.id), 10);
  // 照らせない注文は、取り消されたら選ばなくてよくなる
  await sales.postEvent('t1', id, { eventId: 'x3', saleId: 'ORD-7', status: 'ordered', occurredAt: '2026-10-10T10:00:00+09:00', lines: [{ code: 'NOPE', quantity: 1 }] });
  assert.equal((await sales.unmatched('t1')).length, 1);
  await sales.postEvent('t1', id, { eventId: 'x4', saleId: 'ORD-7', status: 'cancelled', occurredAt: '2026-10-10T12:00:00+09:00' });
  assert.equal((await sales.unmatched('t1')).length, 0);
});

test('通知の形: 必須の項目と行の形を確かめ、ほかの項目（金額・お客様の情報）は読まない。呼び出しの上限', () => {
  const ok = parseSaleEvent({
    eventId: 'e', saleId: 's', status: 'sold', occurredAt: '2026-10-10T10:00:00+09:00', total: 1980, customer: { name: '山田' },
    lines: [{ code: 'A', quantity: 1, price: 100 }],
  });
  assert.ok(!('error' in ok));
  assert.deepEqual(ok.lines, [{ code: 'A', quantity: 1 }]);
  assert.equal(JSON.stringify(ok).includes('山田'), false);
  assert.equal((parseSaleEvent({ eventId: 'e', saleId: 's', status: 'sold', occurredAt: 'x', lines: [] }) as { field: string }).field, 'occurredAt');
  assert.equal((parseSaleEvent({ eventId: 'e', saleId: 's', status: 'sold', occurredAt: '2026-10-10T10:00:00Z', lines: [{ quantity: 1 }] }) as { field: string }).field, 'lines[0]');
  assert.equal((parseSaleEvent({ eventId: 'e', saleId: 's', status: 'sold', occurredAt: '2026-10-10T10:00:00Z', lines: [{ code: 'A', quantity: 1.5 }] }) as { field: string }).field, 'lines[0].quantity');
  assert.ok(!('error' in parseSaleEvent({ eventId: 'e', saleId: 's', status: 'cancelled', occurredAt: '2026-10-10T10:00:00Z' })), '取り消しは行が要らない');
  const { sales } = setup();
  for (let i = 0; i < SALES_RATE_PER_MINUTE; i++) assert.ok(sales.allowHit('L', 1000));
  assert.equal(sales.allowHit('L', 1000), false);
  assert.ok(sales.allowHit('L', 62_000), '1 分たてば戻る');
});
