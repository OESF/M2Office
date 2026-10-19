/**
 * @file 販売品の相場と競合の比較（仕様書 第29.24節、Q-243）の単体テスト。
 *
 * 相場（中央値・最安・最高）と位置（中央値から ±10% の内を相場並み）、出典の番号の合わない価格・同じ商品と確かめられない価格を使わないこと、
 * 税抜の価格を品目の消費税率で税込にそろえること、外へ渡すのは商品の名前とバーコードだけであること、調べられないときは推測しないこと、
 * 競合のサイトの事実を出典に加えること、月の見回り（30 日に 1 回・±20% を超えたら管理者に知らせる）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type InventoryItemView } from '@m2office/shared';
import {
  InventoryMarketService, InventoryService, MemoryInventoryStore, MemoryMarketStore, marketComment, marketSummary, relatedFacts, researchItemPrice, type Repository,
} from '../src/index.js';
import type { LlmProvider } from '../src/llm/provider.js';
import type { ResearchProvider } from '../src/research/provider.js';

const item = (o: Partial<InventoryItemView> = {}) => ({ name: '〇〇 ハンドクリーム 50g', publicName: '', codes: ['4901234567894'], taxRate: 10 as const, ...o });
const research = (asked: string[] = []): ResearchProvider => ({
  name: 'gemini',
  research: async (topic, opts) => { asked.push(`${topic} ${opts?.focus ?? ''}`); return { source: 'gemini', text: 'A 店 1,980 円（税込）、B 通販 1,700 円（税抜）、C 店 30g 980 円', sources: [{ title: 'a.example', url: 'https://a.example/x' }, { title: 'b.example', url: 'https://b.example/y' }], queries: [], tokensUsed: 1 }; },
});
const llm = (answer: unknown): LlmProvider => ({ name: 'gemini', complete: async () => ({ text: JSON.stringify(answer), tokensUsed: 1 }) } as unknown as LlmProvider);

test('相場: 中央値・最安・最高と、中央値から ±10% の内を相場並みとする位置', () => {
  assert.deepEqual(marketSummary([2000, 1800, 2200], 2100), { median: 2000, min: 1800, max: 2200, offers: 3, diffPct: 5, position: 'fair' });
  assert.equal(marketSummary([2000, 1800], 2400).position, 'high');
  assert.equal(marketSummary([2000], 1700).position, 'low');
  assert.equal(marketSummary([1000, 2000], null).diffPct, null, '自社の価格が無ければ差を出さない');
  assert.equal(marketSummary([], 1000).median, null);
  assert.equal(marketComment(marketSummary([2000, 1800, 2200], 2400), 'B 店'), '相場（2,000 円）より 20% 高い。最安は 1,800 円（B 店）');
});

test('調べ方: 番号の合う出典の価格だけを使い、税抜は税込にそろえ、外へ渡すのは名前とバーコードだけ', async () => {
  const asked: string[] = [];
  const r = await researchItemPrice({ research: research(asked), llm: llm({ offers: [
    { source: 1, shop: 'A 店', price: 1980, taxIncluded: true },
    { source: 2, shop: 'B 通販', price: 1700, taxIncluded: false },
    { source: 9, shop: '架空の店', price: 100, taxIncluded: true },
    { source: 1, shop: 'A 店', price: '無料' },
  ] }) }, item());
  assert.equal(r.status, 'found');
  assert.deepEqual(r.sources.map((s) => [s.shop, s.price, s.listed]), [['A 店', 1980, 1980], ['B 通販', 1870, 1700]]);
  assert.match(asked[0]!, /〇〇 ハンドクリーム 50g/);
  assert.match(asked[0]!, /4901234567894/);
  assert.doesNotMatch(asked[0]!, /円|在庫|株式会社/, '自社の価格・在庫・会社の名前は渡さない');
});

test('調べられないときは推測しない（実際に調べていない・見本の推論・同じ商品が無い）', async () => {
  assert.equal((await researchItemPrice({ research: { ...research(), name: 'mock' }, llm: llm({}) }, item())).status, 'unavailable');
  assert.equal((await researchItemPrice({ research: research(), llm: { name: 'stub' } as LlmProvider }, item())).status, 'unavailable');
  assert.equal((await researchItemPrice({ research: research(), llm: llm({ offers: [] }) }, item())).status, 'none');
  const notReal: ResearchProvider = { name: 'gemini', research: async () => ({ source: 'mock', text: '', sources: [], queries: [], tokensUsed: 0 }) };
  assert.equal((await researchItemPrice({ research: notReal, llm: llm({}) }, item())).status, 'unavailable');
});

test('競合のサイトの事実: 名前の主な語に触れたものを出典に加える', async () => {
  const facts = [{ shop: '見本商店', url: 'https://shop.example/menu', text: 'ハンドクリーム 50g 1,650 円' }, { shop: '見本商店', url: 'https://shop.example/menu', text: 'シャンプー 2,000 円' }];
  const related = relatedFacts(item(), facts);
  assert.equal(related.length, 1);
  const r = await researchItemPrice({ research: research(), llm: llm({ offers: [{ source: 3, shop: '見本商店', price: 1650, taxIncluded: true }] }) }, item(), related);
  assert.equal(r.sources[0]?.from, 'competitor');
  assert.equal(r.sources[0]?.url, 'https://shop.example/menu');
});

test('月の見回り: 30 日に 1 回、販売価格のある販売品を調べ、±20% を超えて離れたら利用範囲の管理者に知らせる', async () => {
  const notes: { userId: string; title: string }[] = [];
  const settings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true } };
  const repo = {
    getTenantSettings: async () => settings, listUserGroupIds: async () => [], appendAudit: async () => undefined,
    listUsers: async () => [{ id: 'u-admin', status: 'active', roles: ['admin'] }, { id: 'u-member', status: 'active', roles: ['member'] }],
    getUserSettings: async () => ({ notifications: { kinds: { inventory: true } } }),
    createNotification: async (n: { userId: string; title: string }) => { notes.push(n); },
  } as unknown as Repository;
  const inventory = new InventoryService({ store: new MemoryInventoryStore(), repo });
  await inventory.saveItem('t1', 'u1', { name: '〇〇 ハンドクリーム 50g', price: 2600, kind: 'sale' });
  await inventory.saveItem('t1', 'u1', { name: 'コピー用紙', kind: 'supply', price: 500 });
  await inventory.saveItem('t1', 'u1', { name: '値段の無い販売品', kind: 'sale' });
  const store = new MemoryMarketStore();
  const market = new InventoryMarketService({
    inventory, repo, store, research: async () => research(),
    llm: async () => llm({ offers: [{ source: 1, shop: 'A 店', price: 2000, taxIncluded: true }, { source: 2, shop: 'B 通販', price: 1818, taxIncluded: false }] }),
  });
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal(await market.watch('t1', now), 1, '販売価格のある販売品だけを調べる');
  assert.equal(store.rows[0]?.position, 'high');
  assert.equal(store.rows[0]?.diffPct, 30);
  assert.deepEqual(notes.map((n) => n.userId), ['u-admin'], '利用範囲の管理者だけに知らせる');
  assert.match(notes[0]!.title, /相場から離れた販売品が 1 品目/);
  assert.equal(await market.watch('t1', new Date(now.getTime() + 10 * 86_400_000)), 0, '30 日たつまで見回らない');
  settings.aiPolicy = { mode: 'local-only' } as typeof settings.aiPolicy;
  assert.equal(await market.watch('t1', new Date(now.getTime() + 40 * 86_400_000)), 0, '「ローカルだけ」の会社では見回らない');
});

test('仕入れの相場: ケースの価格を入り数で割って 1 つあたりの税抜にそろえ、自社の仕入価格と比べる（第29.6.2節）', async () => {
  const { researchItemPurchase, purchaseExTax } = await import('../src/index.js');
  const asked: string[] = [];
  const r = await researchItemPurchase({ research: research(asked), llm: llm({ offers: [
    { source: 1, shop: '卸 A', price: 12000, pack: 24, taxIncluded: false },
    { source: 2, shop: '業務用 B', price: 13200, pack: 24, taxIncluded: true },
    { source: 2, shop: '入り数なし', price: 500 },
    { source: 7, shop: '架空', price: 1, pack: 1 },
  ] }) }, item({ taxRate: 10 }));
  assert.deepEqual(r.sources.map((s) => [s.shop, s.price, s.pack]), [['卸 A', 500, 24], ['業務用 B', 500, 24]], '1 つ 500 円（税抜）にそろう。入り数の無いもの・番号の合わないものは捨てる');
  assert.match(asked[0]!, /卸・業務用・ケース/);
  assert.doesNotMatch(asked[0]!, /仕入価格|円/, '自社の仕入価格は渡さない');
  assert.equal(purchaseExTax({ purchasePrice: 660, purchaseTaxIncluded: true, taxRate: 10 }), 600);
  assert.equal(marketComment(marketSummary([500, 500], 600), '卸 A', 'purchase'), '仕入れの相場（1 つ 500 円・税抜）より 20% 高く仕入れている。最安は 1 つ 500 円（卸 A）');
});
