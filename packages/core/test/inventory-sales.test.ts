/**
 * @file 外部のアプリ（仕様書 第13.4.1節、ADR-0090）と、その在庫の機能（販売管理とのつなぎ。第29.20.1節、ADR-0087）の確かめ。
 *
 * アプリの登録と鍵・機能の承認・機能の道・回数の上限、商品の一覧（承認した範囲だけ・分類の絞り込み・変わった品目だけ・外れた品目）、
 * 販売の通知（取り置き・販売・取り消し・返品・二重に数えない・照らせない行と品目を選んでの記録）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  InventoryService, MemoryInventoryStore, InventorySales, MemorySalesStore, ExternalApps, MemoryAppStore, parseSaleEvent, appKeyHash, appFunctionFor,
  APP_RATE_PER_MINUTE, type Repository, type SalesItem,
} from '../src/index.js';

function setup(inventoryOn = true) {
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: inventoryOn } };
  const repo = {
    getTenantSettings: async () => settings,
    listUserGroupIds: async () => [],
    listUsers: async () => [{ id: 'u-admin', displayName: '管理者' }],
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const inv = new MemoryInventoryStore();
  const service = new InventoryService({ store: inv, repo });
  const appStore = new MemoryAppStore();
  const apps = new ExternalApps({ store: appStore, repo, activeItemIds: async (t) => (await inv.listItems(t)).map((i) => i.id) });
  const store = new MemorySalesStore(inv);
  const sales = new InventorySales({ store, service, repo, apps });
  return { service, sales, apps, appStore, audits };
}

async function item(service: InventoryService, name: string, extra: Record<string, unknown> = {}, qty = 10) {
  const r = await service.createItem('t1', 'u1', { name, unit: '個', ...extra }, qty);
  assert.ok('item' in r, JSON.stringify(r));
  return r.item;
}

/** アプリを登録し、在庫の 2 つの機能を許す。 */
async function salesApp(apps: ExternalApps, itemIds: string[], opts: { showCount?: boolean; price?: boolean; employeePrice?: boolean } = {}) {
  const made = await apps.create('t1', 'u-admin', 'レジ');
  assert.ok('key' in made);
  const ok = await apps.approve('t1', 'u-admin', made.app.id, {
    functions: ['inventory.catalog', 'inventory.sales'],
    settings: { catalog: { itemIds, showCount: opts.showCount ?? true, price: opts.price ?? false, employeePrice: opts.employeePrice ?? false } },
  });
  assert.ok(!('error' in ok), JSON.stringify(ok));
  return made;
}

const available = async (service: InventoryService, id: string) => (await service.list('t1')).find((i) => i.id === id)!.available;
const onHand = async (service: InventoryService, id: string) => (await service.list('t1')).find((i) => i.id === id)!.onHand;

test('外部のアプリ: 鍵は m2oa_ で始まり一度だけ返り、ハッシュだけを持つ。承認するまで機能は無い。止めると鍵が効かない', async () => {
  const { apps, appStore, audits } = setup();
  const made = await apps.create('t1', 'u-admin', 'レジ');
  assert.ok('key' in made);
  assert.match(made.key, /^m2oa_[A-Za-z0-9_-]{32}$/);
  const rec = (await appStore.getApp('t1', made.app.id))!;
  assert.equal(rec.keyHash, appKeyHash(made.key));
  assert.ok(!JSON.stringify(rec).includes(made.key), '鍵そのものは持たない');
  assert.deepEqual((await apps.authenticate(made.key))?.functions, [], '承認するまで機能は無い');
  assert.equal(await apps.authenticate('m2oa_' + 'x'.repeat(32)), null);
  assert.equal(await apps.authenticate('not-a-key'), null);
  const approved = await apps.approve('t1', 'u-admin', made.app.id, { functions: ['company.profile'], settings: {} });
  assert.ok(!('error' in approved));
  assert.deepEqual((await apps.authenticate(made.key))?.functions, ['company.profile']);
  const rekeyed = await apps.rekey('t1', 'u-admin', made.app.id);
  assert.ok('key' in rekeyed);
  assert.equal(await apps.authenticate(made.key), null, '前の鍵はすぐ使えない');
  assert.ok('error' in await apps.remove('t1', 'u-admin', made.app.id), '動いているアプリは削除できない');
  await apps.setStatus('t1', 'u-admin', made.app.id, 'stopped');
  assert.equal(await apps.authenticate(rekeyed.key), null);
  assert.ok('ok' in await apps.remove('t1', 'u-admin', made.app.id));
  assert.deepEqual(audits.map((a) => a.action), ['app.create', 'app.approve', 'app.rekey', 'app.stop', 'app.delete']);
});

test('外部のアプリ: 機能ごとに呼べる道が決まり、管理者と本人の道はどの機能でも呼べない。在庫を切った会社では在庫の機能を選べない', async () => {
  assert.equal(appFunctionFor('GET', '/v1/company/profile'), 'company.profile');
  assert.equal(appFunctionFor('GET', '/v1/inventory/catalog'), 'inventory.catalog');
  assert.equal(appFunctionFor('POST', '/v1/inventory/sales-events'), 'inventory.sales');
  assert.equal(appFunctionFor('POST', '/v1/inventory/catalog'), null);
  assert.equal(appFunctionFor('GET', '/v1/admin/users'), null);
  assert.equal(appFunctionFor('GET', '/v1/me'), null);
  assert.equal(appFunctionFor('GET', '/v1/inventory'), null);
  const { apps } = setup(false);
  assert.deepEqual(await apps.available('t1'), ['company.profile']);
  const made = await apps.create('t1', 'u-admin', 'レジ');
  assert.ok('key' in made);
  const res = await apps.approve('t1', 'u-admin', made.app.id, { functions: ['inventory.sales'], settings: {} });
  assert.ok('error' in res && /選べない機能/.test(res.error));
  for (let i = 0; i < APP_RATE_PER_MINUTE; i++) assert.ok(apps.allowHit('A', 1000));
  assert.equal(apps.allowHit('A', 1000), false);
  assert.ok(apps.allowHit('A', 62_000), '1 分たてば戻る');
});

test('商品の一覧: 承認した範囲だけを返し、分類で絞り、変わった品目だけを返し、止めた・分類を変えた・範囲から外した品目は active: false', async () => {
  const { service, sales, apps } = setup();
  const a = await item(service, 'ハンドクリーム', { category: '販売品', sku: 'HC-050', price: 1980, employeePrice: 1500, codes: ['4901234567894'] });
  const b = await item(service, 'ボディソープ', { category: '販売品' });
  const c = await item(service, 'コピー用紙', { category: '消耗品' });
  const made = await apps.create('t1', 'u-admin', 'ネットショップ');
  assert.ok('key' in made);
  const id = made.app.id;
  const before = await sales.listItems('t1', id, {});
  assert.deepEqual(before.status === 200 && before.body.items, [], '承認するまで何も渡さない');
  await apps.approve('t1', 'u-admin', id, { functions: ['inventory.catalog'], settings: { catalog: { itemIds: [a.id, b.id, c.id], showCount: false, price: true, employeePrice: true } } });
  const first = await sales.listItems('t1', id, { categories: ['販売品'] });
  assert.ok(first.status === 200);
  assert.deepEqual(first.body.items.map((x) => x.id).sort(), [a.id, b.id].sort());
  const hc = first.body.items.find((x) => x.id === a.id) as SalesItem;
  assert.equal(hc.code, 'HC-050');
  assert.deepEqual(hc.price, { amount: 1980, taxIncluded: true });
  assert.equal(hc.employeePrice, 1500);
  assert.equal('available' in hc, false, '数を渡さないアプリは状態だけ');

  await new Promise((r) => setTimeout(r, 5));
  const since = first.body.asOf;
  await new Promise((r) => setTimeout(r, 5));
  await service.recordMove('t1', 'u1', { kind: 'out', itemId: a.id, qty: 3 });
  await service.saveItem('t1', 'u1', { id: b.id, name: 'ボディソープ', category: '消耗品' });
  const diff = await sales.listItems('t1', id, { categories: ['販売品'], updatedSince: since });
  assert.ok(diff.status === 200);
  assert.ok(diff.body.items.some((x) => x.id === a.id && x.active));
  assert.deepEqual(diff.body.items.find((x) => x.id === b.id), { id: b.id, active: false }, '分類を変えた品目は外れたことを伝える');
  assert.equal(diff.body.items.some((x) => x.id === c.id), false, '変わっていない品目は返さない');

  const since2 = diff.body.asOf;
  await new Promise((r) => setTimeout(r, 5));
  await apps.approve('t1', 'u-admin', id, { functions: ['inventory.catalog'], settings: { catalog: { itemIds: [b.id, c.id], showCount: false, price: false, employeePrice: false } } });
  const diff2 = await sales.listItems('t1', id, { updatedSince: since2 });
  assert.ok(diff2.status === 200);
  assert.deepEqual(diff2.body.items.find((x) => x.id === a.id), { id: a.id, active: false }, '範囲から外した品目');

  assert.equal((await sales.listItems('t1', id, { categories: Array.from({ length: 21 }, (_, i) => `c${i}`) })).status, 400);
  const paged = await sales.listItems('t1', id, { limit: 1 });
  assert.ok(paged.status === 200 && paged.body.nextCursor);
  const next = await sales.listItems('t1', id, { limit: 1, cursor: paged.body.nextCursor! });
  assert.ok(next.status === 200 && next.body.items.length === 1 && next.body.nextCursor === null);
});

test('販売の通知: 注文で取り置き、出荷で在庫を減らし、取り消しで戻す。遅れて届いた前の状態は動かさない', async () => {
  const { service, sales, apps } = setup();
  const a = await item(service, 'ハンドクリーム', { sku: 'HC-050' });
  const made = await salesApp(apps, [a.id]);
  const id = made.app.id;
  const post = (body: Record<string, unknown>) => sales.postEvent('t1', id, { occurredAt: '2026-10-10T10:00:00+09:00', ...body });

  const ordered = await post({ eventId: 'e1', saleId: 'ORD-1', status: 'ordered', lines: [{ code: 'HC-050', quantity: 2 }] });
  assert.ok(ordered.status === 200);
  assert.deepEqual(ordered.body.lines, [{ index: 0, itemId: a.id, result: 'held', available: 8 }]);
  assert.equal(await onHand(service, a.id), 10, '取り置きは在庫を減らさない');
  assert.equal(await available(service, a.id), 8, '予約との引き当てを入れていなくても、使える数から引く');

  await post({ eventId: 'e2', saleId: 'ORD-1', status: 'ordered', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.equal(await available(service, a.id), 7, '注文の送り直しは取り置きを直す');

  const sold = await post({ eventId: 'e3', saleId: 'ORD-1', status: 'sold', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.ok(sold.status === 200 && sold.body.lines[0]!.result === 'used');
  assert.equal(await onHand(service, a.id), 7);
  assert.equal(await available(service, a.id), 7, '取り置きは使ったことになり、二重に減らない');
  const moves = await service.history('t1', { itemId: a.id });
  assert.equal(moves[0]!.source, 'sales');
  assert.equal(moves[0]!.createdBy, `app:${id}`, '記録した人はアプリ');

  const late = await post({ eventId: 'e4', saleId: 'ORD-1', status: 'ordered', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.ok(late.status === 200 && late.body.lines[0]!.result === 'ignored');

  const cancelled = await post({ eventId: 'e5', saleId: 'ORD-1', status: 'cancelled' });
  assert.ok(cancelled.status === 200 && cancelled.body.lines.length === 0);
  assert.equal(await onHand(service, a.id), 10, '販売のあとの取り消しは減らした分を戻す');
  await post({ eventId: 'e6', saleId: 'ORD-1', status: 'sold', lines: [{ itemId: a.id, quantity: 3 }] });
  assert.equal(await onHand(service, a.id), 10, '取り消しのあとの販売は動かさない');
});

test('販売の通知: 同じ eventId は二重に数えず、中身が違えば 409。返品は入庫。足りなくても受け付ける', async () => {
  const { service, sales, apps } = setup();
  const a = await item(service, 'ハンドクリーム', { codes: ['4901234567894'] }, 1);
  const made = await salesApp(apps, [a.id]);
  const id = made.app.id;
  const body = { eventId: 'pos-1', saleId: 'POS-1', status: 'sold', occurredAt: '2026-10-10T10:00:00+09:00', lines: [{ barcode: '4901234567894', quantity: 2 }] };
  const r1 = await sales.postEvent('t1', id, body);
  const r2 = await sales.postEvent('t1', id, { ...body });
  assert.deepEqual(r2, r1, '送り直しには前と同じ答え');
  assert.equal(await onHand(service, a.id), -1, '足りなくても受け付け、マイナスの在庫にする');
  assert.equal((await sales.postEvent('t1', id, { ...body, lines: [{ barcode: '4901234567894', quantity: 5 }] })).status, 409);
  const ret = await sales.postEvent('t1', id, { eventId: 'pos-2', saleId: 'POS-1', status: 'returned', occurredAt: '2026-10-11T10:00:00+09:00', lines: [{ barcode: '4901234567894', quantity: 1 }] });
  assert.ok(ret.status === 200 && ret.body.lines[0]!.result === 'returned');
  assert.equal(await onHand(service, a.id), 0);
});

test('販売の通知: 照らせない行は受け付けて残し、品目を選べば記録する。取り消されたら要らなくなる', async () => {
  const { service, sales, apps } = setup();
  const a = await item(service, 'ハンドクリーム');
  const made = await salesApp(apps, [a.id]);
  const id = made.app.id;
  const r = await sales.postEvent('t1', id, { eventId: 'x1', saleId: 'POS-9', status: 'sold', occurredAt: '2026-10-10T10:00:00+09:00', lines: [{ code: 'UNKNOWN', quantity: 2 }] });
  assert.ok(r.status === 200);
  assert.equal(r.body.lines[0]!.result, 'unmatched');
  assert.match(r.body.lines[0]!.reason!, /見つかりません/);
  const open = await sales.unmatched('t1');
  assert.equal(open.length, 1);
  assert.equal(open[0]!.appName, 'レジ');
  assert.equal(open[0]!.action, 'use');
  assert.equal((await sales.attention('t1')).count, 1);
  assert.ok('ok' in await sales.resolve('t1', 'u1', open[0]!.id, a.id));
  assert.equal(await onHand(service, a.id), 8);
  assert.equal((await sales.unmatched('t1')).length, 0);
  await sales.postEvent('t1', id, { eventId: 'x2', saleId: 'POS-9', status: 'cancelled', occurredAt: '2026-10-10T11:00:00+09:00' });
  assert.equal(await onHand(service, a.id), 10, '選んで記録した販売も、取り消せば戻る');
  await sales.postEvent('t1', id, { eventId: 'x3', saleId: 'ORD-7', status: 'ordered', occurredAt: '2026-10-10T10:00:00+09:00', lines: [{ code: 'NOPE', quantity: 1 }] });
  assert.equal((await sales.unmatched('t1')).length, 1);
  await sales.postEvent('t1', id, { eventId: 'x4', saleId: 'ORD-7', status: 'cancelled', occurredAt: '2026-10-10T12:00:00+09:00' });
  assert.equal((await sales.unmatched('t1')).length, 0, '照らせない注文は、取り消されたら選ばなくてよくなる');
});

test('通知の形: 必須の項目と行の形を確かめ、ほかの項目（金額・お客様の情報）は読まない', () => {
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
});
