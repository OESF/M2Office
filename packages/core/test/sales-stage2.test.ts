/**
 * @file 販売の書類と受注の段 2 の単体テスト（仕様書 第42.13節）。メールに届いた注文書の取り込み（初めは時刻だけ・絞り込み・
 * 同じメールは 1 回・持ち主に知らせる）・締めの翌朝の請求書の下書き（日に 1 回・作り直さない）・納期の見張り・在庫との連動
 * （引き当て・足りない印・納品書で出庫・取り消しで戻す）・注文請書。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import { MemoryFileStore, MemorySalesDocStore, SalesDocService, SalesDocWatch, type MailConnector, type Repository, type SalesInventory } from '../src/index.js';

const ORDER_TEXT = ['注文書', '株式会社アルファ商事 御中', '株式会社見本商事', '注文番号: PO-1', '注文日: 2026年10月20日', '納期: 2026年11月5日', 'ケーブル3m 10 本 1200 12000'].join('\n');

function setup(opts: { mailIntake?: boolean } = {}) {
  const settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS, company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事' },
    salesDocs: { enabled: true, mailIntake: opts.mailIntake ?? true },
  };
  const users = [
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '営業', roles: ['member'], status: 'active' },
    { id: 'u2', email: 'u2@alpha.example.jp', displayName: '経理', roles: ['admin'], status: 'active' },
  ];
  const notes: { userId: string; title: string; body: string }[] = [];
  const files: Record<string, unknown>[] = [];
  const repo = {
    listTenantIds: async () => ['t1'], listUsers: async () => users, findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings, listUserGroupIds: async () => [], appendAudit: async () => undefined,
    createNotification: async (n: { userId: string; title: string; body: string }) => { notes.push(n); },
    createFile: async (f: Record<string, unknown>) => { files.push(f); }, getFile: async (_t: string, id: string) => files.find((f) => f['id'] === id) ?? null,
    replaceFileMeta: async () => undefined, deleteFile: async () => undefined, listQuotes: async () => [], listApprovalsForFileInput: async () => [],
  } as unknown as Repository;
  // 在庫: ケーブルが 6 本ある
  const stock = new Map<string, number>([['it-cable', 6]]);
  const holds = new Map<string, { itemId: string; qty: number }>();
  const moves = new Map<string, { itemId: string; qty: number }>();
  const inventory: SalesInventory = {
    access: async () => ({}),
    items: async () => [{ id: 'it-cable', name: 'ケーブル3m', sku: '', unit: '本', available: (stock.get('it-cable') ?? 0) - [...holds.values()].reduce((n, h) => n + h.qty, 0) }],
    hold: async (_t, _u, r) => { const id = `h${holds.size + moves.size + 1}-${Math.random()}`; holds.set(id, { itemId: r.itemId, qty: r.qty }); return id; },
    release: async (_t, id) => { holds.delete(id); },
    out: async (_t, _u, r) => { const id = `m${moves.size + 1}`; moves.set(id, r); stock.set(r.itemId, (stock.get(r.itemId) ?? 0) - r.qty); return id; },
    undo: async (_t, _u, id) => { const m = moves.get(id); if (m) { stock.set(m.itemId, (stock.get(m.itemId) ?? 0) + m.qty); moves.delete(id); } },
  };
  const store = new MemorySalesDocStore();
  const fileStore = new MemoryFileStore();
  const service = new SalesDocService({ store, repo, files: fileStore, llmFor: async () => null, inventory });
  // メール: 見本の受信箱（人ごとに同じ注文書のメールが 1 通と、宣伝が 1 通）
  const inbox = [
    { id: 'g1', from: '見本商事 <buy@mihon.example>', subject: '注文書の送付（PO-1）', snippet: '', receivedAt: '', unread: true, labels: [], body: 'いつもお世話になっております。注文書を送ります。' },
    { id: 'g2', from: 'shop@ads.example', subject: '【キャンペーン】ご注文はお早めに', snippet: '', receivedAt: '', unread: true, labels: [], body: '数量限定 10 個' },
  ];
  const mail = {
    search: async () => inbox.map(({ body: _b, ...m }) => m),
    get: async (_p: unknown, id: string) => inbox.find((m) => m.id === id) ?? null,
    attachments: async (_p: unknown, id: string) => (id === 'g1'
      ? { messageId: '<po-1@mihon.example>', files: [{ name: '注文書.csv', mime: 'text/csv', bytes: new TextEncoder().encode(ORDER_TEXT) }] }
      : { messageId: `<${id}@ads.example>`, files: [] }),
  } as unknown as MailConnector;
  const watch = new SalesDocWatch({ service, store, repo, mail, llmFor: async () => null });
  return { service, store, watch, notes, stock, holds, moves, who: { tenantId: 't1', userId: 'u1' } };
}

test('メール: 初めの回は時刻を覚えるだけ。注文書らしいメールだけを受注に入れて持ち主に知らせ、同じメールは何人受け取っても 1 回', async () => {
  const { watch, service, notes } = setup();
  const now = new Date('2026-10-26T01:00:00Z');
  assert.equal(await watch.mailTick(now), 0, '初めの回は取り込まない');
  const n = await watch.mailTick(new Date(now.getTime() + 15 * 60_000));
  assert.equal(n, 1, 'u1 の 1 通だけ（u2 は同じメールなので取り込み直さない）');
  const orders = await service.listOrders({ tenantId: 't1', userId: 'u1' });
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.source, 'mail');
  assert.equal(orders[0]!.mailMessageId, '<po-1@mihon.example>');
  assert.ok(notes.some((x) => x.userId === 'u1' && x.title.includes('受注 S-')));
  assert.ok(notes.some((x) => x.userId === 'u2' && x.body.includes('もう受注に入っていました')));
  // もう見たメールは見直さない
  assert.equal(await watch.mailTick(new Date(now.getTime() + 30 * 60_000)), 0);
  // 宣伝のメールは注文書とみなさない
  assert.equal(await watch.looksLikeOrder('t1', '【キャンペーン】ご注文はお早めに', '数量限定 10 個', []), false);
});

test('メール: 会社が入れていなければ見ない', async () => {
  const { watch } = setup({ mailIntake: false });
  await watch.mailTick(new Date('2026-10-26T01:00:00Z'));
  assert.equal(await watch.mailTick(new Date('2026-10-26T01:15:00Z')), 0);
});

test('在庫: 受注を在庫につないで取り置き、足りなければ印。納品書で出庫し、取り消しで戻す', async () => {
  const { service, who, stock, holds } = setup();
  const r = await service.recordOrder(who, { party: '株式会社見本商事', items: [{ name: 'ケーブル3m', code: '', quantity: 10, unit: '本', unitPrice: 1200, taxRate: 10 }], dueOn: '2026-11-05' }, 'manual');
  assert.ok(!('error' in r));
  const o = (await service.getOrder(who, r.order.id))!.order;
  assert.equal(o.stock.length, 1);
  assert.equal(o.stock[0]!.held, 10);
  assert.ok(o.flags.some((f) => f.kind === 'stock' && f.text.includes('4 足りません')));
  const d = await service.createDocument(who, { kind: 'delivery', orderId: o.id, items: [{ name: 'ケーブル3m', code: '', quantity: 6, unit: '本', unitPrice: 1200, taxRate: 10 }] }, null);
  assert.ok(!('error' in d));
  assert.equal(stock.get('it-cable'), 0, '6 本を出庫');
  const after = (await service.getOrder(who, o.id))!.order;
  assert.equal(after.stock[0]!.held, 4, '取り置きは残りの 4 本');
  assert.equal(holds.size, 1);
  assert.equal(await service.cancel(who, d.doc.id, '数の誤り'), null);
  assert.equal(stock.get('it-cable'), 6, '取り消しで出庫を戻す');
  assert.equal((await service.getOrder(who, o.id))!.order.stock[0]!.held, 10);
  assert.equal(await service.cancelOrder(who, o.id, '先方の都合'), null);
  assert.equal(holds.size, 0, '受注を取り消したら取り置きを外す');
});

test('朝: 締め日の翌朝に請求書の下書きを作って知らせ（日に 1 回・作り直さない）、納期の近い受注を知らせる', async () => {
  const { service, store, watch, notes, who } = setup();
  const d = await service.createDocument(who, { kind: 'delivery', party: { name: '株式会社見本商事' }, items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 30000, taxRate: 10 }] }, null);
  assert.ok(!('error' in d));
  await store.updateDoc('t1', d.doc.id, { issuedOn: '2026-10-30' });
  await service.recordOrder(who, { party: '株式会社見本商事', items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 30000, taxRate: 10 }], dueOn: '2026-11-02' }, 'manual');
  // 11/1 の 7 時（日本時間）: 10/31 が月末締め
  const morning = new Date('2026-10-31T22:30:00Z');
  const r = await watch.morningTick(morning);
  assert.equal(r.drafts, 1);
  assert.equal(r.due, 1, '納期が明日（11/2）の受注');
  const drafts = await service.list(who, { kind: 'invoice', status: 'draft' });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.total, 33000);
  assert.ok(notes.some((x) => x.title.includes('請求書の下書きができています')));
  assert.ok(notes.some((x) => x.title.includes('明日が納期: 1 件')));
  // 同じ日に 2 回目は動かない。下書きを削除しても、同じ締めでは作り直さない
  assert.deepEqual(await watch.morningTick(new Date(morning.getTime() + 600_000)), { drafts: 0, due: 0 });
  assert.equal(await service.removeDraft(who, drafts[0]!.id), null);
  assert.equal(await watch.closing('t1', '2026-11-01', morning), 0);
  // 7 時より前は動かない
  assert.deepEqual(await watch.morningTick(new Date('2026-11-01T20:00:00Z')), { drafts: 0, due: 0 });
});

test('注文請書: 受注から作り、作ったら発行済み（番号 A-）', async () => {
  const { service, who } = setup();
  const r = await service.recordOrder(who, { party: '株式会社見本商事', items: [{ name: '保守', code: '', quantity: 1, unit: '式', unitPrice: 30000, taxRate: 10 }], dueOn: '2026-11-05' }, 'manual');
  assert.ok(!('error' in r));
  const a = await service.createDocument(who, { kind: 'acknowledgement', orderId: r.order.id }, null);
  assert.ok(!('error' in a));
  assert.equal(a.doc.status, 'issued');
  assert.match(a.doc.number!, /^A-\d{8}-001$/);
  assert.equal(a.doc.total, 33000);
});
