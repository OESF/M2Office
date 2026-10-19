/**
 * @file 発注の記録と発注書（仕様書 第29.14.4節・第29.14.5節、Q-249）の単体テスト。
 *
 * 発注の番号と届く予定の日、入荷待ちの数を使える数に足して見張ること（残りわずか・発注の案）、入庫で古い発注から消し込むこと
 * （一部入荷・入荷済み）、入庫を取り消すと消し込みも戻ること、メールの発注が業務の実行の結果に合わせて入荷待ち・取り消しになること、
 * Web・電話の「発注した」、遅れた日数、発注書の PDF が作れることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_TENANT_SETTINGS, type Run, type TenantSettings } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';
import { renderPurchaseOrder } from '../src/files/pdf-render.js';

function setup(runs: Record<string, Partial<Run>> = {}) {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, lowDefault: 5, leadDaysDefault: 7 } };
  const repo = {
    getTenantSettings: async () => settings, listUserGroupIds: async () => [], appendAudit: async () => undefined,
    getRun: async (_t: string, id: string) => (runs[id] ? { id, ...runs[id] } as Run : null),
  } as unknown as Repository;
  const store = new MemoryInventoryStore();
  return { store, service: new InventoryService({ store, repo }) };
}

async function prepare(service: InventoryService, store: MemoryInventoryStore, method: 'mail' | 'web' | 'phone' = 'web') {
  const sup = await service.saveSupplier('t1', { name: '〇〇商事', method, contact: method === 'mail' ? 'order@example.jp' : 'https://shop.example', leadDays: 3 });
  assert.ok('id' in sup, JSON.stringify(sup));
  const r = await service.saveItem('t1', 'u1', { name: 'トナー', supplierId: sup.id });
  assert.ok('item' in r);
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: r.item.id, qty: 3 });
  void store;
  return { supplierId: sup.id, itemId: r.item.id };
}

test('発注すると番号と届く予定の日を持ち、入荷待ちの数を使える数に足して見張る', async () => {
  const { service, store } = setup();
  const { supplierId, itemId } = await prepare(service, store);
  assert.equal((await service.list('t1')).find((i) => i.id === itemId)?.low, true, '発注の前は残りわずか（3 ≦ 5）');
  const o = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 10 }], status: 'ordered' });
  assert.ok(!('error' in o));
  assert.match(o.number, /^PO-\d{6}-001$/);
  assert.ok(o.dueOn, '届く予定の日（仕入先の 3 日）');
  const item = (await service.list('t1')).find((i) => i.id === itemId)!;
  assert.equal(item.onOrder, 10);
  assert.equal(item.low, false, '入荷待ちを足すと残りわずかではない');
  const row = (await service.forecast('t1')).find((r) => r.itemId === itemId)!;
  assert.equal(row.proposal, null, '発注の案を出さない');
  const second = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 1 }], status: 'pending' });
  assert.ok(!('error' in second));
  assert.match(second.number, /-002$/);
  assert.equal((await service.list('t1')).find((i) => i.id === itemId)?.onOrder, 10, '発注前の発注は入荷待ちに数えない');
});

test('入庫で古い発注から消し込み、一部入荷・入荷済みにする。入庫を取り消すと戻る', async () => {
  const { service, store } = setup();
  const { supplierId, itemId } = await prepare(service, store);
  const a = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 4 }], status: 'ordered' });
  const b = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 4 }], status: 'ordered' });
  assert.ok(!('error' in a) && !('error' in b));
  const got = await service.recordMove('t1', 'u1', { kind: 'in', itemId, qty: 6 });
  assert.ok(got.ok);
  assert.equal((await service.order('t1', a.id))?.status, 'received', '古い発注を先に');
  assert.equal((await service.order('t1', b.id))?.status, 'partial');
  assert.equal((await service.order('t1', b.id))?.lines[0]?.received, 2);
  const undo = await service.undo('t1', 'u1', got.moves[0]!.id);
  assert.ok(undo.ok);
  assert.equal((await service.order('t1', a.id))?.status, 'ordered', '入庫を取り消すと消し込みも戻る');
  assert.equal((await service.order('t1', b.id))?.status, 'ordered');
  // 取り込みの初めの数や返品は消し込まない
  await service.recordMove('t1', 'u1', { kind: 'in', itemId, qty: 4, source: 'import' });
  assert.equal((await service.order('t1', a.id))?.status, 'ordered');
});

test('メールの発注は、承認されて送れたら入荷待ち、却下・失敗なら取り消し。Web・電話は「発注した」で入荷待ち', async () => {
  const runs: Record<string, Partial<Run>> = { r1: { status: 'awaiting_approval' }, r2: { status: 'cancelled', endedAt: '2026-10-19T01:00:00.000Z' } };
  const { service, store } = setup(runs);
  const mail = await prepare(service, store, 'mail');
  const o1 = await service.createOrder('t1', 'u1', { supplierId: mail.supplierId, lines: [{ itemId: mail.itemId, qty: 5 }], status: 'pending', runId: 'r1' });
  const o2 = await service.createOrder('t1', 'u1', { supplierId: mail.supplierId, lines: [{ itemId: mail.itemId, qty: 5 }], status: 'pending', runId: 'r2' });
  assert.ok(!('error' in o1) && !('error' in o2));
  assert.equal((await service.markOrdered('t1', 'u1', o1.id) as { error?: string }).error, 'メールの発注は、承認されて送ったときに発注済みになります');
  runs['r1'] = { status: 'completed', endedAt: '2026-10-19T02:00:00.000Z' };
  const list = await service.orders('t1', { open: true });
  assert.equal(list.find((o) => o.id === o1.id)?.status, 'ordered');
  assert.equal(list.find((o) => o.id === o2.id), undefined, '却下されたものは閉じる');
  assert.equal((await service.order('t1', o2.id))?.status, 'cancelled');

  const { service: s2, store: st2 } = setup();
  const web = await prepare(s2, st2, 'web');
  const w = await s2.createOrder('t1', 'u1', { supplierId: web.supplierId, lines: [{ itemId: web.itemId, qty: 2 }], status: 'pending' });
  assert.ok(!('error' in w));
  const marked = await s2.markOrdered('t1', 'u1', w.id);
  assert.ok(!('error' in marked) && marked.status === 'ordered' && marked.orderedAt);
  const cancelled = await s2.cancelOrder('t1', 'u1', w.id);
  assert.ok(!('error' in cancelled) && cancelled.status === 'cancelled');
  assert.ok('error' in (await s2.cancelOrder('t1', 'u1', w.id)), '閉じた発注は取り消せない');
});

test('届く予定の日を過ぎた入荷待ちに、遅れた日数を添える', async () => {
  const { service, store } = setup();
  const { supplierId, itemId } = await prepare(service, store);
  const o = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 4 }], status: 'ordered' });
  assert.ok(!('error' in o));
  const later = new Date(Date.parse(`${o.dueOn}T00:00:00Z`) + 5 * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await service.orders('t1', { open: true, today: later }))[0]?.overdueDays, 5);
  assert.equal((await service.orders('t1', { open: true, today: o.dueOn! }))[0]?.overdueDays, undefined);
});

test('発注書の PDF を作る（金額は載せない）', async () => {
  const bytes = await renderPurchaseOrder({
    to: '〇〇商事 御中', fields: [{ label: '発注番号', value: 'PO-202610-001' }, { label: '発注日', value: '2026-10-19' }],
    greeting: '下記のとおり発注いたします。', rows: [{ name: 'トナー（黒）', code: 'TN-1', quantity: '2 箱（10 個）' }], notes: ['納品書を添えてください。'],
  });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getTitle(), '発注書');
});

test('同じ仕入先の発注待ちがあれば、新しく作らずに出し直す（同じ発注を重ねない）', async () => {
  const { service, store } = setup();
  const { supplierId, itemId } = await prepare(service, store);
  const first = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 5 }], status: 'pending' });
  const again = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 8 }], status: 'pending' });
  assert.ok(!('error' in first) && !('error' in again));
  assert.equal(again.id, first.id);
  assert.equal(again.number, first.number);
  assert.equal(again.revised, true);
  assert.deepEqual(again.lines.map((l) => l.qty), [8], '品目と数を差し替える');
  assert.equal((await service.orders('t1', { open: true })).length, 1);
  // 発注完了にしたあとは、新しい発注になる
  await service.markOrdered('t1', 'u1', first.id);
  const next = await service.createOrder('t1', 'u1', { supplierId, lines: [{ itemId, qty: 2 }], status: 'pending' });
  assert.ok(!('error' in next) && next.id !== first.id && !next.revised);
});
