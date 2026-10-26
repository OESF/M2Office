/**
 * @file 消費税の区分と日付で変わる税率の単体テスト（仕様書 第15.1.1節、Q-275）。税率の表（予定は確定まで使わない）・
 * 品名からの区分の推し量り・税率ごとの計算（対象外を含む）・販売の書類での区分の判断と、納品の日ごとの税率の請求書・見積書。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_SETTINGS, TAX_RATE_TABLE, guessTaxCategory, plannedTaxNote, taxBreakdown, taxCategoryOf, taxLegend, taxRateOn, type TenantSettings,
} from '@m2office/shared';
import { MemoryFileStore, MemorySalesDocStore, SalesDocService, quoteTotals, type Repository } from '../src/index.js';

test('税率の表: 予定の変更（食料品の 1%）は確定するまで使わず、知らせだけを返す', () => {
  assert.equal(taxRateOn('standard', '2026-10-26'), 10);
  assert.equal(taxRateOn('food', '2026-10-26'), 8);
  assert.equal(taxRateOn('food', '2027-05-01'), 8, '成立前は 8% のまま');
  assert.match(plannedTaxNote('food', '2027-05-01') ?? '', /1% になる予定/);
  assert.equal(plannedTaxNote('food', '2026-10-26'), null);
  assert.equal(plannedTaxNote('news', '2027-05-01'), null, '新聞は 8% のまま');
  assert.equal(taxRateOn('exempt', '2027-05-01'), 0);
  // 成立して予定を外したら、その期間は 1%、終われば 8% に戻る
  const enacted = TAX_RATE_TABLE.map((e) => ({ ...e, planned: false }));
  assert.equal(taxRateOn('food', '2027-04-01', enacted), 1);
  assert.equal(taxRateOn('food', '2029-03-31', enacted), 1);
  assert.equal(taxRateOn('food', '2029-04-01', enacted), 8);
  assert.equal(taxRateOn('food', '2027-03-31', enacted), 8);
});

test('品名から区分を推し量る（酒類・外食は標準、新聞は定期購読だけ軽減、会費は迷いつきで対象外）', () => {
  assert.equal(guessTaxCategory('食パン').category, 'food');
  assert.equal(guessTaxCategory('缶ビール 350ml').category, 'standard');
  assert.equal(guessTaxCategory('店内飲食 ランチ').category, 'standard');
  assert.deepEqual(guessTaxCategory('日経新聞 定期購読料'), { category: 'news', unsure: false });
  assert.equal(guessTaxCategory('新聞広告').category, 'standard');
  assert.deepEqual(guessTaxCategory('商工会 年会費'), { category: 'exempt', unsure: true });
  assert.deepEqual(guessTaxCategory('セミナー会費'), { category: 'standard', unsure: true });
  assert.equal(guessTaxCategory('収入印紙').category, 'exempt');
  assert.equal(guessTaxCategory('ホームページ制作').category, 'standard');
  assert.equal(guessTaxCategory('塩ビ管').category, 'standard');
  assert.equal(taxCategoryOf({ taxRate: 8 }), 'food');
  assert.equal(taxCategoryOf({ taxRate: 10 }), 'standard');
  assert.equal(taxCategoryOf({ taxRate: 0 }), 'exempt');
  assert.equal(taxCategoryOf({ taxCategory: 'news', taxRate: 8 }), 'news');
});

test('税率ごとの計算: 高い税率から並べ、対象外は消費税 0 で最後。内訳と印の説明の言葉', () => {
  const t = quoteTotals([
    { name: '制作', quantity: 1, unit: '式', unitPrice: 10000, taxRate: 10 },
    { name: '会費', quantity: 1, unit: '式', unitPrice: 5000, taxRate: 0 },
    { name: 'パン', quantity: 3, unit: '個', unitPrice: 200, taxRate: 1 },
    { name: '新聞', quantity: 1, unit: '月', unitPrice: 4000, taxRate: 8 },
  ], 'floor');
  assert.deepEqual(t.byRate.map((x) => x.rate), [10, 8, 1, 0]);
  assert.equal(t.tax, 1000 + 320 + 6);
  assert.equal(t.total, 19600 + 1326);
  assert.equal(taxBreakdown(t.byRate), '（内訳）10% 対象 10,000 円・消費税 1,000 円、8% 対象 4,000 円・消費税 320 円、1% 対象 600 円・消費税 6 円、対象外 5,000 円');
  assert.equal(taxLegend([10, 8, 0]), '（8%）は軽減税率の対象、（対象外）は消費税のかからないものです');
  assert.equal(taxLegend([10]), null);
});

function setup() {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, salesDocs: { enabled: true } };
  const files: Record<string, unknown>[] = [];
  const repo = {
    listUsers: async () => [{ id: 'u1', email: 'u1@example.jp', displayName: '営業', roles: ['member'], status: 'active' }],
    findUserById: async () => ({ id: 'u1', roles: ['member'], status: 'active' }),
    getTenantSettings: async () => settings, listUserGroupIds: async () => [], createNotification: async () => undefined, appendAudit: async () => undefined,
    createFile: async (f: Record<string, unknown>) => { files.push(f); }, getFile: async (_t: string, id: string) => files.find((f) => f['id'] === id) ?? null,
    replaceFileMeta: async () => undefined, deleteFile: async () => undefined, listQuotes: async () => [], createArtifact: async () => undefined,
  } as unknown as Repository;
  const store = new MemorySalesDocStore();
  return { store, service: new SalesDocService({ store, repo, files: new MemoryFileStore(), llmFor: async () => null }), who: { tenantId: 't1', userId: 'u1' } };
}

test('書類: 区分の無い品目は品名から決めて判断を示し、対象外は消費税をかけない。前の同じ品目の区分を使う', async () => {
  const { service, who } = setup();
  const r = await service.createDocument(who, {
    kind: 'invoice', party: { name: '株式会社見本商事' }, items: [
      { name: '店舗の清掃', code: '', quantity: 1, unit: '式', unitPrice: 20000, taxRate: 10 },
      { name: '商工会 年会費', code: '', quantity: 1, unit: '年', unitPrice: 12000, taxRate: 10 },
      { name: '食パン', code: '', quantity: 10, unit: '斤', unitPrice: 300, taxRate: 10 },
    ],
  }, null);
  assert.ok(!('error' in r));
  assert.deepEqual(r.doc.items.map((i) => [i.taxCategory, i.taxRate]), [['standard', 10], ['exempt', 0], ['food', 8]]);
  assert.deepEqual(r.doc.taxLines.map((x) => [x.rate, x.base, x.tax]), [[10, 20000, 2000], [8, 3000, 240], [0, 12000, 0]]);
  assert.equal(r.doc.total, 35000 + 2240);
  assert.ok(r.notes.some((n) => n.includes('商工会 年会費 は対象外') && n.includes('対価のあるもの')));
  assert.ok(r.notes.some((n) => n.includes('食パン は軽減税率（飲食料品）')));
  // 同じ取引先の 2 通目は、前の区分を使い、判断の言葉は出さない
  const again = await service.createDocument(who, { kind: 'invoice', party: { name: '株式会社見本商事' }, items: [{ name: '食パン', code: '', quantity: 1, unit: '斤', unitPrice: 300, taxRate: 10 }] }, null);
  assert.ok(!('error' in again) && again.doc.items[0]!.taxRate === 8 && !again.notes.some((n) => n.includes('食パン')));
});

test('まとめた請求書は、納品書ごとの納品の日の税率をそのまま使い、税率ごとに合計する（税率の変わる日をまたぐ）', async () => {
  const { service, who, store } = setup();
  const d1 = await service.createDocument(who, { kind: 'delivery', party: { name: '株式会社見本商事' }, items: [{ name: '食パン', code: '', quantity: 10, unit: '斤', unitPrice: 300, taxRate: 10, taxCategory: 'food' }] }, null);
  const d2 = await service.createDocument(who, { kind: 'delivery', party: { name: '株式会社見本商事' }, items: [{ name: '食パン', code: '', quantity: 10, unit: '斤', unitPrice: 300, taxRate: 10, taxCategory: 'food' }] }, null);
  assert.ok(!('error' in d1) && !('error' in d2));
  // 2 通目を「1% の期間の納品」に見立てる（成立後の表で当てた税率）
  await store.updateDoc('t1', d2.doc.id, { issuedOn: '2027-04-02', items: d2.doc.items.map((i) => ({ ...i, taxRate: 1 })) });
  const inv = await service.createDocument(who, { kind: 'invoice', deliveryIds: [d1.doc.id, d2.doc.id] }, null);
  assert.ok(!('error' in inv));
  assert.deepEqual(inv.doc.taxLines.map((x) => [x.rate, x.base, x.tax]), [[8, 3000, 240], [1, 3000, 30]]);
});

test('運営の表: 無ければ同梱の表。確かめは区分・税率・日付と、区分ごとに終わりの無い確定した行を求める', async () => {
  const { effectiveTaxTable, checkTaxTable } = await import('@m2office/shared');
  assert.equal(effectiveTaxTable([]), TAX_RATE_TABLE);
  assert.equal(effectiveTaxTable(null), TAX_RATE_TABLE);
  assert.equal(checkTaxTable(TAX_RATE_TABLE), null);
  assert.match(checkTaxTable(TAX_RATE_TABLE.filter((e) => e.category !== 'news')) ?? '', /軽減（新聞）に、終わりの日の無い確定した税率/);
  assert.match(checkTaxTable([...TAX_RATE_TABLE, { category: 'food', rate: 120, from: '2030-01-01' }]) ?? '', /0〜100/);
  assert.match(checkTaxTable([...TAX_RATE_TABLE, { category: 'food', rate: 5, from: '2030-01-01', to: '2029-01-01' }]) ?? '', /終わりの日/);
});

test('運営が予定を確定にした表で計算し、下書きは発行の日の税率で計算し直す（第15.1.1.1節）', async () => {
  const { service, who, store } = setup();
  let table = TAX_RATE_TABLE;
  service.deps.taxTable = async () => table;
  const r = await service.createDocument(who, { kind: 'invoice', party: { name: '株式会社見本商事' }, items: [{ name: '食パン', code: '', quantity: 10, unit: '斤', unitPrice: 300, taxRate: 10, taxCategory: 'food' }] }, null);
  assert.ok(!('error' in r));
  assert.equal(r.doc.items[0]!.taxRate, 8);
  // 下書きを 2027-04-01 より前に作ったことにし、運営が 1% を確定したあと、その期間に発行する
  await store.updateDoc('t1', r.doc.id, { issuedOn: '2027-03-30' });
  table = TAX_RATE_TABLE.map((e) => ({ ...e, planned: false }));
  const { taxRateOn: rateOn } = await import('@m2office/shared');
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const issued = await service.issue(who, r.doc.id);
  assert.ok(!('error' in issued));
  // 発行の日（今日）の税率で計算し直す（今日が 1% の期間でなければ 8% のまま）
  assert.equal(issued.items[0]!.taxRate, rateOn('food', today, table));
  // 書類の詳細は、運営の表の予定の知らせを返す
  table = TAX_RATE_TABLE;
  const later = await service.createDocument(who, { kind: 'delivery', party: { name: '株式会社見本商事' }, items: [{ name: '食パン', code: '', quantity: 1, unit: '斤', unitPrice: 300, taxRate: 10, taxCategory: 'food' }] }, null);
  assert.ok(!('error' in later));
  await store.updateDoc('t1', later.doc.id, { issuedOn: '2027-05-01' });
  assert.ok((await service.get(who, later.doc.id))!.taxNotes.some((n) => n.includes('1% になる予定')));
});
