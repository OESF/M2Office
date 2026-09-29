/**
 * @file 棚卸しと棚のラベルの単体テスト（仕様書 第29.10節・第29.7節、ADR-0050）。
 *
 * 会社で 1 つだけ開くこと、読むたびに足し何人でも足し合わせること、数えた時点の帳簿の数と比べること（数えている間の入出庫を止めない）、
 * 確定で差の分を調整にし数えていない行は 0 にしないこと、確定できる人、やめても帳簿を変えないこと、
 * 棚のラベルの PDF が場所の数に応じてページを作ること、帳票の書体を抜き出さずに埋め込むこと（字の形が落ちた不具合）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream, PDFDict } from 'pdf-lib';
import { DEFAULT_TENANT_SETTINGS, type InventorySettings } from '@m2office/shared';
import { InventoryService, MemoryInventoryStore, renderShelfLabels, renderPdf, shelfKeyOf, shelfUrl, type Repository } from '../src/index.js';

function setup(features: Partial<InventorySettings['features']> = {}) {
  const audits: { action: string }[] = [];
  const repo = {
    getTenantSettings: async () => ({
      ...DEFAULT_TENANT_SETTINGS,
      inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, ...features } },
    }),
    listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string }) => { audits.push(e); },
  } as unknown as Repository;
  const service = new InventoryService({ store: new MemoryInventoryStore(), repo });
  return { service, audits };
}

test('棚卸し: 会社で 1 つ。読むたびに足し、数えた時点の帳簿の数と比べる。確定で差を調整にし、数えていない行は 0 にしない', async () => {
  const { service, audits } = setup({ units: true });
  const shelf = await service.addLocation('t1', '倉庫', '棚1');
  assert.ok(!('error' in shelf));
  const paper = await service.createItem('t1', 'u1', { name: '紙', unit: '冊', packUnit: '箱', packSize: 5 }, 10);
  const pen = await service.createItem('t1', 'u1', { name: 'ペン', unit: '本' }, 4);
  assert.ok('item' in paper && 'item' in pen);

  const started = await service.startCount('t1', 'u1');
  assert.ok('count' in started && started.created);
  const again = await service.startCount('t1', 'u2');
  assert.ok('count' in again && !again.created && again.count.id === started.count.id, '開いていれば、それを続ける');
  const id = started.count.id;

  const a = await service.recordCount('t1', 'u1', id, { itemId: paper.item.id, qty: 1, unit: 'pack' });
  assert.ok('row' in a);
  assert.deepEqual([a.row.counted, a.row.book, a.row.diff], [5, 10, -5], '1 箱は 5 冊。数えた時点の帳簿は 10');
  const b = await service.recordCount('t1', 'u2', id, { itemId: paper.item.id, qty: 1 });
  assert.ok('row' in b && b.row.counted === 6, 'ほかの人が数えた分も足す');
  // 数えている間の使用は止めない。確定では数えた時点の差（−4）を足す
  await service.recordMove('t1', 'u3', { kind: 'out', itemId: paper.item.id, qty: 2 });

  const view = await service.countView('t1', id);
  assert.deepEqual([view!.counted, view!.uncounted, view!.differing], [1, 1, 1]);
  assert.deepEqual(view!.rows.map((r) => [r.itemName, r.counted, r.diff]), [['紙', 6, -4], ['ペン', null, null]]);

  const denied = await service.closeCount('t1', 'u2', id, false);
  assert.ok('error' in denied, '確定できるのは始めた人と管理者');
  const closed = await service.closeCount('t1', 'u1', id, false);
  assert.deepEqual(closed, { adjusted: 1, uncounted: 1 });
  const [paperNow, penNow] = await Promise.all([service.detail('t1', paper.item.id), service.detail('t1', pen.item.id)]);
  assert.equal(paperNow!.item.onHand, 4, '10 − 2（使用）− 4（棚卸しの差）');
  assert.equal(paperNow!.moves[0]!.reason, '棚卸し');
  assert.equal(paperNow!.moves[0]!.source, 'count');
  assert.equal(penNow!.item.onHand, 4, '数えていない品目は 0 にしない');
  assert.ok(audits.some((e) => e.action === 'inventory.count.close'));
  const after = await service.recordCount('t1', 'u1', id, { itemId: pen.item.id, qty: 1 });
  assert.ok('error' in after, '終わった棚卸しには数えない');
});

test('棚卸し: 数え直しは置き換える。対象の場所の外は数えない行に出さない。やめても帳簿は変えない', async () => {
  const { service } = setup({ lots: true });
  const s1 = await service.addLocation('t1', '倉庫', '棚1');
  const s2 = await service.addLocation('t1', '店頭');
  assert.ok(!('error' in s1) && !('error' in s2));
  const cream = await service.createItem('t1', 'u1', { name: 'クリーム', unit: '個' });
  assert.ok('item' in cream);
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: cream.item.id, qty: 5, locationId: s1.id, lot: 'L1', expiresOn: '2099-01-01' });
  await service.recordMove('t1', 'u1', { kind: 'in', itemId: cream.item.id, qty: 3, locationId: s2.id });
  const started = await service.startCount('t1', 'u1', { kind: 'location', value: s1.id });
  assert.ok('count' in started);
  const id = started.count.id;
  await service.recordCount('t1', 'u1', id, { itemId: cream.item.id, qty: 1, lot: 'L1' });
  const set = await service.recordCount('t1', 'u1', id, { itemId: cream.item.id, qty: 4, lot: 'L1', mode: 'set' });
  assert.ok('row' in set);
  assert.deepEqual([set.row.locationId, set.row.lot, set.row.counted, set.row.diff], [s1.id, 'L1', 4, -1], '場所の棚卸しは、その場所で数える');
  const view = await service.countView('t1', id);
  assert.equal(view!.uncounted, 0, '対象の場所の外（店頭）は数えていない行に出さない');
  assert.deepEqual(await service.cancelCount('t1', 'u1', id, false), { ok: true });
  assert.equal((await service.detail('t1', cream.item.id))!.item.onHand, 8, 'やめても帳簿は変えない');
  assert.equal(await service.openCount('t1'), null);
});

test('棚のラベル: 1 枚に 21 枚。場所が多ければページを足す', async () => {
  const locs = Array.from({ length: 22 }, (_, i) => ({ id: String(i), warehouse: '倉庫', shelf: `棚${i + 1}`, labelKey: `m2o-shelf:${i}` }));
  const pdf = await PDFDocument.load(await renderShelfLabels(locs, 'https://a.example.jp'));
  assert.equal(pdf.getPageCount(), 2);
});

test('棚のラベルの QR はスマホ用のページの URL。読めば棚が決まる。以前の値だけの QR も読める', async () => {
  const url = shelfUrl('https://a.example.jp/', 'm2o-shelf:AbC_1');
  assert.equal(url, 'https://a.example.jp/m/inventory?shelf=m2o-shelf%3AAbC_1');
  assert.equal(shelfKeyOf(url), 'm2o-shelf:AbC_1');
  assert.equal(shelfKeyOf('m2o-shelf:old'), 'm2o-shelf:old');
  const { service } = setup();
  const loc = await service.addLocation('t1', '倉庫', '棚1');
  assert.ok(!('error' in loc));
  assert.equal((await service.lookup('t1', shelfUrl('https://a.example.jp', loc.labelKey))).location?.id, loc.id);
  assert.equal((await service.lookup('t1', loc.labelKey)).location?.id, loc.id);
  assert.equal((await service.lookup('t2', shelfUrl('https://a.example.jp', loc.labelKey))).location, null, 'ほかの会社の棚は引けない');
});

test('帳票の書体: 使った字だけを抜き出さず、そのまま埋め込む（抜き出すと字の形が落ちた。ADR-0017 の改め）', async () => {
  const bytes = await renderPdf({ title: '請求書', to: '株式会社見本 御中', rows: [{ name: 'コピー用紙', quantity: 1, unit: '箱', unitPrice: 100 }] });
  const pdf = await PDFDocument.load(bytes);
  // 埋め込んだ書体の中身（FontFile2）の大きさで確かめる。抜き出すと数 KB になる
  const sizes: number[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('FontFile2'))) {
      const stream = pdf.context.lookup(obj.get(PDFName.of('FontFile2')));
      if (stream instanceof PDFRawStream) sizes.push(stream.contents.length);
    }
  }
  assert.ok(sizes.length >= 1 && sizes.every((n) => n > 500_000), `書体の大きさ: ${sizes.join(', ')}`);
});
