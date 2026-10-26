/**
 * @file 見積書の管理・再見積・販売品とのつながり・見積からの受注・受注の進み具合の単体テスト（仕様書 第42.14節、Q-278）。
 *
 * 見積書を書類として作る（番号・有効期限・宛先の分け方）・再見積（同じ番号の新しい版・前の版を残す・税率ごとの出精値引き・前の版との違い）・
 * 失注と期限切れ・見積書から受注（新しい版を写す・受注済み・重ねない・つなぎ直し）・注文に合う見積書を探してつなぐ・
 * 「この前の見積で」・受注から先の進み具合と次の一手（口頭の発注・請書なし・納品書をまとめた請求・領収）・販売品の販売価格と在庫の数・ツール。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, salesQuoteState, type TenantSettings } from '@m2office/shared';
import {
  MemoryFileStore, MemorySalesDocStore, QUOTE_TOOLS, SalesDocService, discountLines, partyFromTo, quoteDiff, salesToday,
  type Repository, type SalesInventory, type SalesStockItem, type ToolContext,
} from '../src/index.js';

const item = (name: string, quantity: number, unitPrice: number | null, extra: Record<string, unknown> = {}) =>
  ({ name, code: '', quantity, unit: '', unitPrice, taxRate: 10, ...extra });

function setup(opts: { stock?: SalesStockItem[] } = {}) {
  const settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', invoiceRegistrationNumber: 'T1234567890123' },
    invoice: { ...DEFAULT_TENANT_SETTINGS.invoice, paymentDue: '翌月末' },
    salesDocs: { enabled: true },
  };
  const users = [{ id: 'u1', email: 'u1@alpha.example.jp', displayName: '営業', roles: ['member'], status: 'active' }];
  const files: Record<string, unknown>[] = [];
  const artifacts: { kind: string; title: string; body: string }[] = [];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    listUserGroupIds: async () => [],
    createNotification: async () => undefined,
    appendAudit: async () => undefined,
    createFile: async (f: Record<string, unknown>) => { files.push(f); },
    getFile: async (_t: string, id: string) => files.find((f) => f['id'] === id) ?? null,
    replaceFileMeta: async () => undefined,
    deleteFile: async () => undefined,
    listApprovalsForFileInput: async () => [],
    createArtifact: async (a: { kind: string; title: string; body: string }) => { artifacts.push(a); },
  } as unknown as Repository;
  const holds: { itemId: string; qty: number }[] = [];
  const inventory: SalesInventory | undefined = opts.stock ? {
    access: async () => ({}),
    items: async () => opts.stock!,
    hold: async (_t, _u, r) => { holds.push(r); return `rs-${holds.length}`; },
    release: async () => undefined,
    out: async () => null,
    undo: async () => undefined,
  } : undefined;
  const store = new MemorySalesDocStore();
  const service = new SalesDocService({ store, repo, files: new MemoryFileStore(), llmFor: async () => null, ...(inventory ? { inventory } : {}) });
  const who = { tenantId: 't1', userId: 'u1' };
  const ctx = (runId = 'run-1'): ToolContext => ({
    tenantId: 't1', userId: 'u1', runId, compartment: null, repo, files: new MemoryFileStore(),
    connector: { docs: { create: async () => { throw new Error('Google に接続していません'); } } } as unknown as ToolContext['connector'],
    salesDocs: { service, access: async () => settings.salesDocs },
  });
  return { service, store, who, ctx, artifacts, holds };
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test('見積書を書類として作る: すぐ番号が付き、有効期限は会社の既定。宛先は会社と担当に分け、単位の既定は「式」', async () => {
  const { service, who } = setup();
  const r = await service.createQuote(who, { to: '株式会社見本商事 山田様', items: [item('デザイン', 1, 300000), item('コーディング', 1, 200000)] }, null);
  assert.ok(!('error' in r));
  assert.equal(r.doc.kind, 'quote');
  assert.equal(r.doc.status, 'issued');
  assert.match(r.doc.number!, /^Q-\d{8}-01$/);
  assert.equal(r.doc.validUntil, addDays(salesToday(), 30));
  assert.deepEqual([r.doc.party.name, r.doc.party.person], ['株式会社見本商事', '山田']);
  assert.equal(r.doc.items[0]!.unit, '式');
  assert.equal(r.doc.total, 550000);
  assert.equal(salesQuoteState(r.doc, salesToday()), 'submitted');
  assert.deepEqual(partyFromTo('見本商事 御中'), { name: '見本商事' });
  assert.deepEqual(partyFromTo('山田様'), { person: '山田' });
});

test('再見積: 同じ番号の新しい版で前の版を残し、全体の値引きは税率ごとの出精値引きの行。違いを決まった計算で出す', async () => {
  const { service, who } = setup();
  const first = await service.createQuote(who, { to: '株式会社見本商事', items: [item('焼き菓子', 100, 300, { taxCategory: 'food' }), item('包装', 1, 20000, { taxCategory: 'standard' })] }, null);
  assert.ok(!('error' in first));
  const second = await service.reviseQuote(who, first.doc.number!, { discountTotal: 5000 }, null);
  assert.ok(!('error' in second));
  assert.equal(second.doc.number, first.doc.number);
  assert.equal(second.doc.version, 2);
  assert.equal(second.doc.previousId, first.doc.id);
  // 税抜 50,000 円（飲食料品 30,000・標準 20,000）から 5,000 円を、税率ごとの割合で分ける
  const lines = second.doc.items.filter((i) => i.name === '出精値引き');
  assert.deepEqual(lines.map((l) => [l.taxRate, l.unitPrice]), [[10, -2000], [8, -3000]]);
  assert.equal(second.doc.subtotal, 45000);
  assert.ok(second.diff.some((x) => x.includes('値引き')), '合計の違い');
  assert.ok(second.diff.some((x) => x.startsWith('出精値引き')));
  // 一覧は新しい版だけ。前の版は置き換え済みで残る
  const list = await service.listQuotes(who);
  assert.deepEqual(list.map((d) => d.version), [2]);
  const detail = await service.get(who, first.doc.id);
  assert.ok(detail?.doc.superseded);
  assert.equal(detail?.versions.length, 2);
  assert.deepEqual((await service.get(who, second.doc.id))?.diff, second.diff);
  // 品目を変える再見積（単価を下げ、外す）
  const third = await service.reviseQuote(who, second.doc.id, { items: [item('焼き菓子', 100, 250, { taxCategory: 'food' })], discountTotal: 0 }, null);
  assert.ok(!('error' in third));
  assert.equal(third.doc.version, 3);
  assert.ok(third.diff.includes('包装 を外しました'));
  assert.ok(third.diff.some((x) => x.includes('焼き菓子') && x.includes('300 円 → 250 円')));
  assert.ok(!third.doc.items.some((i) => i.name === '出精値引き'));
  // 値引きが金額より大きければ作らない
  assert.ok('error' in discountLines([item('品', 1, 1000)], 2000));
  assert.deepEqual(quoteDiff({ items: [item('A', 1, 100)], total: 110 }, { items: [item('A', 1, 100)], total: 110 }), []);
});

test('失注と期限切れ: 失注は理由を残し、有効期限を過ぎて結びの無い見積書は期限切れ。受注済みは失注にも再見積にもしない', async () => {
  const { service, store, who } = setup();
  const a = await service.createQuote(who, { to: '見本商事', items: [item('保守', 12, 10000)] }, null);
  const b = await service.createQuote(who, { to: '見本商事', items: [item('研修', 1, 80000)] }, null);
  assert.ok(!('error' in a) && !('error' in b));
  assert.equal(await service.loseQuote(who, a.doc.id, '他社に決まった'), null);
  const lost = (await service.get(who, a.doc.id))!.doc;
  assert.equal(salesQuoteState(lost, salesToday()), 'lost');
  assert.equal(lost.outcomeNote, '他社に決まった');
  await store.updateDoc('t1', b.doc.id, { validUntil: addDays(salesToday(), -1) });
  assert.equal(salesQuoteState((await service.get(who, b.doc.id))!.doc, salesToday()), 'expired');
  const o = await service.orderFromQuote(who, b.doc.number!);
  assert.ok(!('error' in o));
  assert.match((await service.loseQuote(who, b.doc.id, '')) ?? '', /受注済み/);
  const re = await service.reviseQuote(who, b.doc.id, { discountTotal: 1000 }, null);
  assert.ok('error' in re && re.error.includes('受注済み'));
});

test('見積書から受注: いちばん新しい版を写して受注済みにし、二度目は重ねない。つなぎを外すと提出済みに戻る', async () => {
  const { service, who } = setup();
  const q = await service.createQuote(who, { to: '株式会社見本商事', items: [item('ルーター', 2, 15000)] }, null);
  assert.ok(!('error' in q));
  const v2 = await service.reviseQuote(who, q.doc.id, { discountTotal: 2000 }, null);
  assert.ok(!('error' in v2));
  // 古い版の ID を渡しても、新しい版から作る
  const r = await service.orderFromQuote(who, q.doc.id);
  assert.ok(!('error' in r) && !r.duplicate);
  assert.equal(r.order.quoteId, v2.doc.id);
  assert.equal(r.order.quoteNumber, `${q.doc.number}（再見積 2）`);
  assert.equal(r.order.total, v2.doc.total);
  assert.equal(r.order.source, 'quote');
  assert.equal((await service.get(who, v2.doc.id))!.doc.outcome, 'won');
  assert.equal((await service.get(who, v2.doc.id))!.orders.length, 1);
  const again = await service.orderFromQuote(who, q.doc.number!);
  assert.ok(!('error' in again) && again.duplicate && again.order.id === r.order.id);
  assert.equal(await service.relinkQuote(who, r.order.id, null), null);
  assert.equal((await service.get(who, v2.doc.id))!.doc.outcome, null);
  assert.equal((await service.getOrder(who, r.order.id))!.order.quoteId, null);
  assert.equal(await service.relinkQuote(who, r.order.id, v2.doc.number!), null);
  assert.equal((await service.get(who, v2.doc.id))!.doc.outcome, 'won');
});

test('注文に合う見積書を探してつなぎ、違いを印にする。「この前の見積で」は取引先のいちばん新しい提出済みの見積書から作る', async () => {
  const { service, who } = setup();
  const q = await service.createQuote(who, { to: '株式会社見本商事', items: [item('ケーブル3m', 10, 1200), item('ルーター', 2, 15000)] }, null);
  assert.ok(!('error' in q));
  const r = await service.recordOrder(who, { party: '見本商事', items: [item('ケーブル3m', 12, 1200)], dueOn: '2026-11-30' }, 'manual');
  assert.ok(!('error' in r) && !r.duplicate);
  assert.equal(r.order.quoteId, q.doc.id);
  const texts = r.order.flags.filter((f) => f.kind === 'quote').map((f) => f.text);
  assert.ok(texts.some((t) => t.includes('ケーブル3m の数 12')));
  assert.ok(texts.some((t) => t.includes('ルーター が注文にありません')));
  assert.equal((await service.get(who, q.doc.id))!.doc.outcome, 'won');
  // 受注済みの見積書には、ほかの注文をつながない
  const other = await service.recordOrder(who, { party: '見本商事', items: [item('ルーター', 1, 15000)], dueOn: '2026-12-01' }, 'manual');
  assert.ok(!('error' in other));
  assert.equal(other.order.quoteId, null);
  // 電話で「この前の見積で」
  const q2 = await service.createQuote(who, { to: '株式会社見本商事', items: [item('スイッチ', 3, 8000)] }, null);
  assert.ok(!('error' in q2));
  const phone = await service.orderFromLatestQuote(who, '見本商事');
  assert.ok(!('error' in phone));
  assert.equal(phone.order.quoteId, q2.doc.id);
  const none = await service.orderFromLatestQuote(who, '見知らぬ商店');
  assert.ok('error' in none);
});

test('受注の進み具合と次の一手: 口頭の発注は見積「—」、請書は任意、納品書は貯めてまとめて請求、請求の後は領収', async () => {
  const { service, who } = setup();
  const r = await service.recordOrder(who, { party: '見本商事', items: [item('特製パン', 10, 200)], dueOn: '2026-11-30' }, 'manual');
  assert.ok(!('error' in r));
  const id = r.order.id;
  const view = async () => (await service.getOrder(who, id))!.order;
  let o = await view();
  assert.equal(o.quoteNumber, null);
  assert.deepEqual(o.progress, { acknowledged: false, deliveredRate: 0, invoiced: 'none', unbilledDeliveries: 0, receipted: false, next: { label: '納品書を作る', action: 'delivery' } });
  // 請書を出さなくても次の一手は納品
  const d1 = await service.createDocument(who, { kind: 'delivery', orderId: id, items: [item('特製パン', 4, 200)] }, null);
  const d2 = await service.createDocument(who, { kind: 'delivery', orderId: id }, null);
  assert.ok(!('error' in d1) && !('error' in d2));
  o = await view();
  assert.equal(o.progress!.deliveredRate, 100);
  assert.equal(o.progress!.unbilledDeliveries, 2);
  assert.deepEqual(o.progress!.next, { label: '請求書を作る', action: 'invoice' });
  const ack = await service.createDocument(who, { kind: 'acknowledgement', orderId: id }, null);
  assert.ok(!('error' in ack));
  assert.equal((await view()).progress!.acknowledged, true);
  const inv = await service.createDocument(who, { kind: 'invoice', deliveryIds: [d1.doc.id, d2.doc.id] }, null);
  assert.ok(!('error' in inv));
  assert.equal((await view()).progress!.invoiced, 'none', '下書きの請求書は請求に数えない');
  assert.ok(!('error' in await service.issue(who, inv.doc.id)));
  o = await view();
  assert.equal(o.progress!.invoiced, 'all');
  assert.equal(o.progress!.unbilledDeliveries, 0);
  assert.equal(o.progress!.next?.action, 'receipt');
  const rc = await service.createDocument(who, { kind: 'receipt', invoiceId: inv.doc.id }, null);
  assert.ok(!('error' in rc));
  assert.ok(!('error' in await service.issue(who, rc.doc.id)));
  o = await view();
  assert.equal(o.progress!.receipted, true);
  assert.equal(o.progress!.next, null);
  // 締め日の前の未請求の納品書は、まだ「請求書を作る」と示さない
  await service.rememberParty(who, '月末商店', { closingDay: 0 }, '会話');
  const late = await service.recordOrder(who, { party: '月末商店', items: [item('米', 1, 5000)], dueOn: '2026-11-30' }, 'manual');
  assert.ok(!('error' in late));
  assert.ok(!('error' in await service.createDocument(who, { kind: 'delivery', orderId: late.order.id }, null)));
  assert.deepEqual((await service.getOrder(who, late.order.id))!.order.progress!.next, { label: '請求書を作る', action: 'invoice' }, '月末締めの日の当日は区切りの内');
  // 領収書だけ・請求書だけも作れる（流れに乗らない）
  assert.ok(!('error' in await service.createDocument(who, { kind: 'receipt', party: { name: '店頭' }, items: [item('パン', 2, 200)] }, null)));
  assert.ok(!('error' in await service.createDocument(who, { kind: 'invoice', party: { name: '直接の請求' }, items: [item('作業', 1, 10000)] }, null)));
});

test('在庫の販売品: 単価が無ければ税込の販売価格を税抜に直して使い、品番と税の区分を入れる。足りなければ知らせ、候補に出す', async () => {
  const stock: SalesStockItem[] = [
    { id: 'it-1', name: '焙煎コーヒー豆', sku: 'CF-200', unit: '袋', available: 3, sale: true, price: 1080, priceTaxIncluded: true, taxRate: 8 },
    { id: 'it-2', name: 'ドリッパー', sku: 'DR-1', unit: '個', available: 50, sale: true, price: 2000, priceTaxIncluded: false, taxRate: 10 },
    { id: 'it-3', name: '梱包材', sku: 'PK', unit: '枚', available: 999, sale: false, price: 10, priceTaxIncluded: false, taxRate: 10 },
    { id: 'it-4', name: 'ペーパーフィルター', sku: 'PF-100', unit: '箱', available: 20, sale: true, price: 550, priceTaxIncluded: true, taxRate: 10 },
  ];
  const { service, who } = setup({ stock });
  const r = await service.createQuote(who, { to: '見本商事', items: [item('焙煎コーヒー豆', 5, null), item('ドリッパー', 2, 1800), item('梱包材', 1, null)] }, null);
  assert.ok(!('error' in r));
  const [bean, dripper, pack] = r.doc.items;
  assert.deepEqual([bean!.unitPrice, bean!.code, bean!.unit, bean!.taxCategory, bean!.taxRate, bean!.inventoryItemId], [1000, 'CF-200', '袋', 'food', 8, 'it-1']);
  assert.equal(dripper!.unitPrice, 1800, '書いた単価を使う');
  assert.equal(pack!.inventoryItemId, undefined, '販売品でない品目はつながない');
  assert.ok(r.notes.some((n) => n.includes('販売価格') && n.includes('焙煎コーヒー豆')));
  assert.deepEqual(r.stock, ['焙煎コーヒー豆 の在庫が 2 袋足りません（納期に気をつけてください）']);
  const sug = await service.suggestions(who, '');
  assert.ok(sug.items.some((x) => x.name === 'ドリッパー' && x.unitPrice === 1800), '前の書類の単価が先');
  assert.ok(sug.items.some((x) => x.name === 'ペーパーフィルター' && x.unitPrice === 500 && x.unit === '箱'), '販売品は販売価格（税抜）');
});

test('見積書のツール: 作る・探す（状態つき）・送るメールの用意（この依頼で作ったものだけ）・再見積・失注', async () => {
  const { ctx, artifacts } = setup();
  const t = (name: string) => QUOTE_TOOLS.find((x) => x.name === name)!;
  const made = await t('quote.create').invoke({ to: '株式会社見本商事 山田様', items: [{ name: 'デザイン', quantity: 1, unitPrice: 300000 }] }, ctx()) as Record<string, unknown>;
  assert.equal(made['created'], true);
  assert.match(String(made['number']), /^Q-\d{8}-01$/);
  assert.equal(made['total'], 330000);
  assert.ok(String(made['docError']).includes('Google'));
  assert.ok(artifacts.some((a) => a.kind === 'quote'));
  const found = await t('quote.search').invoke({ to: '見本' }, ctx()) as { quotes: { state: string; quoteId: string }[] };
  assert.equal(found.quotes[0]!.state, '提出済み');
  const mail = await t('quote.prepare_mail').invoke({ quoteId: made['quoteId'], sendTo: 'yamada@example.co.jp' }, ctx()) as Record<string, unknown>;
  assert.equal(mail['available'], true);
  const other = await t('quote.prepare_mail').invoke({ quoteId: made['quoteId'], sendTo: 'yamada@example.co.jp' }, ctx('run-2')) as Record<string, unknown>;
  assert.equal(other['available'], false, 'ほかの依頼で作った見積書は添えない');
  const re = await t('quote.revise').invoke({ quote: made['number'], discountTotal: 30000 }, ctx('run-2')) as Record<string, unknown>;
  assert.equal(re['created'], true);
  assert.equal(re['total'], 297000);
  assert.ok(Array.isArray(re['diff']));
  const mail2 = await t('quote.prepare_mail').invoke({ quoteId: re['quoteId'], sendTo: 'yamada@example.co.jp' }, ctx('run-2')) as Record<string, unknown>;
  assert.equal(mail2['available'], true);
  assert.match(String(mail2['subjectHint']), /再見積/);
  const lost = await t('quote.lost').invoke({ quote: made['number'], reason: '予算が合わない' }, ctx()) as Record<string, unknown>;
  assert.equal(lost['done'], true);
  const after = await t('quote.search').invoke({}, ctx()) as { quotes: { state: string; number: string }[] };
  assert.deepEqual(after.quotes.map((q) => [q.state, q.number.endsWith('（再見積 2）')]), [['失注', true]]);
});
