/**
 * @file 秘書の在庫の依頼の見分けと、在庫の数の問いへのその場の答えの単体テスト（仕様書 第29.15節）。
 *
 * 在庫の問いを組織知識の問いと取り違えないこと、記録の依頼と期間の問いを見分けること、
 * 在庫と関係の無い依頼を在庫の依頼にしないこと、答えが在庫の表の数どおりで推測を含まないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, type Repository } from '../src/index.js';
import { answerStock, bareStockQuestion, findPlaces, inventoryRequest, stockQuery } from '../src/secretary/inventory.js';

test('在庫の依頼の見分け: 数の問い・残りわずか・期間の記録・記録の依頼', () => {
  const cases: [string, string | null][] = [
    ['コピー用紙の在庫は', 'stock'],
    ['ハンドクリームの在庫は？', 'stock'],
    ['コピー用紙は何個ある？', 'stock'],
    ['トナーは残りいくつ？', 'stock'],
    ['在庫を教えて', 'stock'],
    ['足りなくなりそうなものは？', 'low'],
    ['残りわずかの品を教えて', 'low'],
    ['先週のコピー用紙の使用を教えて', 'history'],
    ['今月の入庫の記録は？', 'history'],
    ['A4 用紙を 2 箱入庫して', 'record'],
    ['トナーを発注して', 'order'],
    ['コピー用紙を注文しておいて', 'order'],
    ['トナーを１本使った', 'record'],
    ['体験セットを 2 セット店頭に移した', 'record'],
    ['このテンプレートを使った', null],
    ['会議の資料を 3 部出した', null],
    ['今日の予定は？', null],
    ['就業規則の残業の上限は？', null],
  ];
  for (const [message, want] of cases) assert.equal(inventoryRequest(message), want, message);
});

test('問いから品目の言葉を取り出す', () => {
  assert.equal(stockQuery('コピー用紙の在庫は？'), 'コピー用紙');
  assert.equal(stockQuery('いま トナーは残りいくつ？'), 'トナー');
  assert.equal(stockQuery('在庫を教えて'), '');
  assert.equal(stockQuery('在庫管理用ラベルの在庫は？'), '在庫管理用ラベル', '品目の名前に在庫の言葉が入っていても切らない');
});

test('在庫の数の問いに、表の数どおりにその場で答える。無ければ推測せず、無いと答える', async () => {
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, lots: true } } }),
    appendAudit: async () => undefined,
  } as unknown as Repository;
  const service = new InventoryService({ store: new MemoryInventoryStore(), repo });
  const paper = await service.createItem('t1', 'u1', { name: 'コピー用紙 A4', unit: '冊' }, 7);
  const cream = await service.createItem('t1', 'u1', { name: 'ハンドクリーム 50g', unit: '個' });
  assert.ok('item' in paper && 'item' in cream);
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: cream.item.id, qty: 5, lot: 'OLD', expiresOn: '2020-01-01' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: cream.item.id, qty: 8, lot: 'NEW', expiresOn: '2099-01-01' });
  const toner = await service.createItem('t1', 'u1', { name: 'トナー（黒）', unit: '本', lowThreshold: 2 }, 1);
  assert.ok('item' in toner);

  const a = await answerStock(service, 't1', 'コピー用紙の在庫は', 'stock');
  assert.equal(a.text, 'コピー用紙 A4: 使える数 7 冊。');
  const b = await answerStock(service, 't1', 'ハンドクリームの在庫は？', 'stock');
  assert.equal(b.text, 'ハンドクリーム 50g: 使える数 8 個（在庫 13 個・期限切れ 5 個）。');
  const c = await answerStock(service, 't1', '足りなくなりそうなものは？', 'low');
  assert.match(c.text, /トナー（黒）: 使える数 1 本・残りわずか\n  発注の案: 2 本（使える数が目安（2 本）以下）/, '見張りの結果と発注の案を添える');
  const d = await answerStock(service, 't1', 'ボールペンの在庫は？', 'stock');
  assert.match(d.text, /「ボールペン」という品目は、在庫管理にありません/);
  const e = await answerStock(service, 't1', 'A4のコピー用紙の在庫は？', 'stock');
  assert.match(e.text, /コピー用紙 A4: 使える数 7 冊/, '語順が違っても見つける');
});

test('場所を言われたら、その場所の数で答える（「店頭在庫はいくつ？」「店頭のハンドクリームは何個？」）', async () => {
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, lots: true } } }),
    appendAudit: async () => undefined,
  } as unknown as Repository;
  const service = new InventoryService({ store: new MemoryInventoryStore(), repo });
  const store = await service.addLocation('t1', '倉庫');
  const shop = await service.addLocation('t1', '店頭');
  assert.ok(!('error' in store) && !('error' in shop));
  const cream = await service.createItem('t1', 'u1', { name: 'ハンドクリーム 50g', unit: '個' });
  const kit = await service.createItem('t1', 'u1', { name: '体験セット', unit: 'セット' });
  const paper = await service.createItem('t1', 'u1', { name: 'コピー用紙 A4', unit: '冊' });
  assert.ok('item' in cream && 'item' in kit && 'item' in paper);
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: cream.item.id, qty: 5, locationId: shop.id, lot: 'OLD', expiresOn: '2020-01-01' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: cream.item.id, qty: 8, locationId: shop.id, lot: 'NEW', expiresOn: '2099-01-01' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: kit.item.id, qty: 6, locationId: store.id });
  await service.recordMove('t1', 'u1', { kind: 'transfer', itemId: kit.item.id, qty: 2, locationId: store.id, toLocationId: shop.id });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: paper.item.id, qty: 7, locationId: store.id });

  const all = await answerStock(service, 't1', '店頭在庫はいくつですか？', 'stock');
  assert.equal(all.text, [
    '店頭にある品目は 2 件です。',
    '- ハンドクリーム 50g: 使える数 8 個（在庫 13 個・期限切れ 5 個）',
    '- 体験セット: 使える数 2 セット',
  ].join('\n'), 'その場所にある品目だけを、その場所の数で並べる');
  const one = await answerStock(service, 't1', '店頭在庫のハンドクリームは何個ありますか？', 'stock');
  assert.equal(one.text, '店頭のハンドクリーム 50g: 使える数 8 個（在庫 13 個・期限切れ 5 個）。');
  const none = await answerStock(service, 't1', '店頭のコピー用紙の在庫は？', 'stock');
  assert.equal(none.text, '店頭にはコピー用紙 A4はありません。全体の使える数は 7 冊です。');
  const kitAtStore = await answerStock(service, 't1', '倉庫の体験セットは何個？', 'stock');
  assert.equal(kitAtStore.text, '倉庫の体験セット: 使える数 4 セット。');
  const casual = await answerStock(service, 't1', 'ハンドクリームまだ足りてる？', 'stock');
  assert.equal(casual.text, 'ハンドクリーム 50g: 使える数 8 個（在庫 13 個・期限切れ 5 個）。', '在庫の言葉が無い問いでも品目の名前で当てる');
  const other = await answerStock(service, 't1', 'ハンドクリームの容器ある？', 'stock');
  assert.match(other.text, /在庫管理にありません/, '名前のあとにほかの言葉が続けば、名前の一部で当てない');
  const whole = await answerStock(service, 't1', '体験セットの在庫は？', 'stock');
  assert.equal(whole.text, '体験セット: 使える数 6 セット。', '場所を言わなければ全体の数');
});

test('品目と場所の名前だけの短い問いは在庫の問い。ほかの言葉が残る問いは違う', () => {
  const items = [{ name: 'コピー用紙 A4' }, { name: 'トナー（黒）' }, { name: 'ハンドクリーム 50g' }];
  const locations = [{ id: 'l1', warehouse: '倉庫', shelf: '', labelKey: 'k1' }, { id: 'l2', warehouse: '店頭', shelf: '', labelKey: 'k2' }];
  assert.equal(bareStockQuestion('店頭のコピー用紙は？', items, locations), true);
  assert.equal(bareStockQuestion('トナーは？', items, locations), true);
  assert.equal(bareStockQuestion('ハンドクリームって', items, locations), true);
  assert.equal(bareStockQuestion('トナーの交換方法は？', items, locations), false);
  assert.equal(bareStockQuestion('トナーまだ足りてる？', items, locations), true);
  assert.equal(bareStockQuestion('店頭にハンドクリームある？', items, locations), true);
  assert.equal(bareStockQuestion('コピー用紙もうない？', items, locations), true);
  assert.equal(bareStockQuestion('トナーは大丈夫ですか？', items, locations), true);
  assert.equal(bareStockQuestion('トナーを注文して', items, locations), false, '頼みごとは在庫の問いにしない');
  assert.equal(bareStockQuestion('倉庫の鍵は？', items, locations), false, '品目の名前が無ければ在庫の問いにしない');
  assert.equal(bareStockQuestion('今日の予定は？', items, locations), false);
});

test('品目の名前の中の言葉を、場所と取り違えない', () => {
  const locations = [{ id: 'l1', warehouse: '店頭', shelf: '', labelKey: 'k1' }];
  const hit = findPlaces('店頭用POPの在庫は？', locations, ['店頭用POP']);
  assert.equal(hit.places.length, 0);
  const both = findPlaces('店頭の店頭用POPは何個？', locations, ['店頭用POP']);
  assert.deepEqual([both.places.map((p) => p.id), both.rest], [['l1'], '店頭用POPは何個?']);
});
