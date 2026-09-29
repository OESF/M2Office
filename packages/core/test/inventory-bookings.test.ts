/**
 * @file 予約との引き当ての単体テスト（仕様書 第29.13節）。
 *
 * 取り置きで使える数だけが減ること、同じ予約は 1 件にまとめて最後の状態にそろえること、取り消し・来店済みの扱い、
 * 予約した人の情報を持たないこと、受け口の鍵（ハッシュだけ持つ・止めた受け口は受け取らない・会社の境界）、
 * 違う形の通知の型を AI が推測すること（推論には骨組みだけを渡す）、メニューと品目の推測と、人が教えたときの引き当て、
 * 推論が一時的に使えなくても予約を受け取り、あとで推測し直すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type InventorySettings } from '@m2office/shared';
import {
  InventoryBookings, InventoryService, MemoryInventoryStore, skeleton, toBookingEvent, toInstant, STANDARD_BOOKING_MAPPING,
  type LlmProvider, type Repository,
} from '../src/index.js';

function setup(llmAnswers: string[] = []) {
  const settings: InventorySettings = {
    ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, reserve: true },
  };
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: settings }),
    appendAudit: async () => undefined,
  } as unknown as Repository;
  const prompts: string[] = [];
  const llm = {
    name: 'fake',
    complete: async (req: { messages: { content: string }[] }) => {
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      const text = llmAnswers.shift() ?? '{}';
      // 「!throw」は推論が一時的に使えないこと（503 など）の代わり
      if (text === '!throw') throw new Error('LLM 呼び出しに失敗しました (503)');
      return { text, tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const store = new MemoryInventoryStore();
  const service = new InventoryService({ store, repo });
  const bookings = new InventoryBookings({ store, service, repo, llm: async () => llm });
  return { store, service, bookings, prompts, repo };
}

test('取り置き: 使える数だけを減らし、使ったら使用の記録にする。取り消せば戻る', async () => {
  const { service, bookings } = setup();
  const kit = await service.createItem('t1', 'u1', { name: '体験セット', unit: 'セット' }, 5);
  assert.ok('item' in kit);
  const held = await bookings.hold('t1', 'u1', { itemId: kit.item.id, qty: 2, startsAt: toInstant('2099-01-10 10:00'), source: 'screen' });
  assert.ok(!('error' in held));
  let v = (await service.detail('t1', kit.item.id))!.item;
  assert.deepEqual([v.onHand, v.reserved, v.available], [5, 2, 3], '在庫は減らさず、使える数だけ減らす');
  const used = await bookings.consume('t1', 'u1', held.id);
  assert.ok(!('error' in used) && used.status === 'visited');
  v = (await service.detail('t1', kit.item.id))!.item;
  assert.deepEqual([v.onHand, v.reserved, v.available], [3, 0, 3], '使ったら在庫を減らし、取り置きは消す（二重に減らさない）');
  const again = await bookings.hold('t1', 'u1', { itemId: kit.item.id, qty: 1, startsAt: null, source: 'secretary' });
  assert.ok(!('error' in again));
  await bookings.cancel('t1', again.id);
  assert.equal((await service.detail('t1', kit.item.id))!.item.available, 3, '取り消せば戻る');
});

test('受け口: 同じ予約は 1 件にまとめ、最後の状態にそろえる。予約した人の情報は持たない。止めた受け口・ほかの会社の鍵は受け取らない', async () => {
  const { store, service, bookings } = setup();
  const kit = await service.createItem('t1', 'u1', { name: '体験セット', unit: 'セット' }, 5);
  assert.ok('item' in kit);
  await bookings.teachMenu('t1', 'u1', '体験コース', [{ itemId: kit.item.id, qty: 1 }]);
  const src = await bookings.createSource('t1', 'admin', '見本の予約');
  assert.ok('key' in src);
  assert.ok(![...store.bookingSources.values()].some((s) => JSON.stringify(s).includes(src.key)), '鍵そのものは持たない（ハッシュだけ）');
  const r1 = await bookings.ingest(src.key, { id: 'E1', startsAt: '2099-01-11 11:00', menu: '体験コース', status: 'booked', name: '山田 花子', tel: '090-0000-0000' });
  assert.ok(r1.ok && r1.mapped);
  await bookings.ingest(src.key, { id: 'E1', startsAt: '2099-01-11 13:00', menu: '体験コース', status: 'booked' });
  const list = await bookings.list('t1');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.startsAt, '2099-01-11T04:00:00.000Z', '日時は最後の通知にそろえる（日本時間とみなす）');
  assert.equal(list[0]!.lines.length, 1, '引き当ては二重にしない');
  assert.ok(!JSON.stringify([...store.bookings.values()]).includes('山田'), '氏名は持たない');
  await bookings.ingest(src.key, { id: 'E1', startsAt: '2099-01-11 13:00', menu: '体験コース', status: 'cancelled' });
  assert.equal((await service.detail('t1', kit.item.id))!.item.available, 5);
  await bookings.setSourceStatus('t1', 'admin', src.source.id, 'stopped');
  assert.equal((await bookings.ingest(src.key, { id: 'E2', startsAt: '2099-01-12 10:00' })).reason, 'stopped');
  assert.equal((await bookings.ingest('x'.repeat(32), { id: 'E3', startsAt: '2099-01-12 10:00' })).reason, 'unknown');
  assert.equal((await bookings.list('t2')).length, 0, 'ほかの会社には見えない');
});

test('受け口: 違う形の通知は、骨組みだけを推論に渡して型を推測し、受け口に覚える', async () => {
  const { store, service, bookings, prompts } = setup([
    '{"id": "data.reservation.no", "startsAt": "data.reservation.start", "menu": "data.reservation.course.name", "status": "event", "cancelledValues": ["reservation.cancelled"], "visitedValues": ["reservation.checked_in"]}',
  ]);
  const kit = await service.createItem('t1', 'u1', { name: '体験セット', unit: 'セット' }, 5);
  assert.ok('item' in kit);
  await bookings.teachMenu('t1', 'u1', '体験コース', [{ itemId: kit.item.id, qty: 1 }]);
  const src = await bookings.createSource('t1', 'admin', '外部の予約');
  assert.ok('key' in src);
  const payload = { event: 'reservation.created', data: { reservation: { no: 'A-77', start: '2099-02-01T10:00:00+09:00', course: { name: '体験コース' }, customer: { name: '山田 花子' } } } };
  const r = await bookings.ingest(src.key, payload);
  assert.ok(r.ok && r.mapped);
  assert.ok(!prompts[0]!.includes('山田') && !prompts[0]!.includes('A-77'), '推論に氏名や番号の値を渡さない');
  assert.equal([...store.bookingSources.values()][0]!.mapping?.id, 'data.reservation.no', '推測した型を覚える');
  const cancel = await bookings.ingest(src.key, { ...payload, event: 'reservation.cancelled' });
  assert.equal(cancel.status, 'cancelled', '覚えた型で取り消しを読む（推論を使わない）');
  assert.equal(prompts.length, 1);
});

test('メニュー: AI が品目を推測して覚える。自信が無ければ取り置かず、教えれば待っていた予約にも引き当てる', async () => {
  const { service, bookings, prompts } = setup([
    '{"items": [], "none": false, "confident": false}',
  ]);
  const kit = await service.createItem('t1', 'u1', { name: '体験セット', unit: 'セット' }, 5);
  assert.ok('item' in kit);
  const src = await bookings.createSource('t1', 'admin', '見本');
  assert.ok('key' in src);
  const r = await bookings.ingest(src.key, { id: 'E5', startsAt: '2099-03-01 10:00', menu: 'はじめてのお試し' });
  assert.ok(r.ok && r.mapped === false, '自信が無ければ取り置かない');
  assert.equal((await service.detail('t1', kit.item.id))!.item.available, 5);
  const applied = await bookings.teachMenu('t1', 'u1', 'はじめてのお試し', [{ itemId: kit.item.id, qty: 2 }]);
  assert.equal(applied, 1, '待っていた予約に引き当てる');
  assert.equal((await service.detail('t1', kit.item.id))!.item.available, 3);
  // 教えたメニューは推論を使わない
  const before = prompts.length;
  await bookings.ingest(src.key, { id: 'E6', startsAt: '2099-03-02 10:00', menu: 'はじめてのお試し' });
  assert.equal(prompts.length, before);
});

test('値の読み方: 日時は時差が無ければ日本時間。骨組みは短い英字の値だけを残す', () => {
  assert.equal(toInstant('2026/10/01 9:30'), '2026-10-01T00:30:00.000Z');
  assert.equal(toInstant('2026-10-01T09:30:00Z'), '2026-10-01T09:30:00.000Z');
  assert.equal(toInstant('あした'), null);
  assert.deepEqual(skeleton({ status: 'cancelled', name: '山田 花子', at: '2026-10-01 10:00', n: 3, list: [{ x: 'abc' }] }),
    { status: 'cancelled', name: '<文字>', at: '<日時>', n: '<数>', list: [{ x: 'abc' }] });
  assert.equal(toBookingEvent({ id: '', startsAt: 'x' }, STANDARD_BOOKING_MAPPING), null, '予約番号が無ければ受け取らない');
  // 日付と時刻が別の項目の通知は、2 つを合わせて日時にする
  const split = { ...STANDARD_BOOKING_MAPPING, startsAt: 'r.date', startTime: 'r.time' };
  assert.equal(toBookingEvent({ id: 'S1', r: { date: '2026-10-06', time: '14:00' } }, split)?.startsAt, '2026-10-06T05:00:00.000Z');
  assert.equal(toBookingEvent({ id: 'S2', r: { date: '2026-10-06' } }, split)?.startsAt, '2026-10-05T15:00:00.000Z', '時刻が無ければその日の 0 時');
  assert.equal(skeleton({ time: '14:00' }).time, '<時刻>');
  // 取り消し・来店済みは、推測した値に無くてもよく使われる言い方で読む
  const guessed = { ...STANDARD_BOOKING_MAPPING, cancelledValues: [], visitedValues: [] };
  assert.equal(toBookingEvent({ id: 'S3', startsAt: '2026-10-06 10:00', status: 'CANCELLED_BY_CUSTOMER' }, guessed)?.status, 'cancelled');
  assert.equal(toBookingEvent({ id: 'S4', startsAt: '2026-10-06 10:00', status: 'キャンセル' }, guessed)?.status, 'cancelled');
  assert.equal(toBookingEvent({ id: 'S5', startsAt: '2026-10-06 10:00', status: '来店済み' }, guessed)?.status, 'visited');
  assert.equal(toBookingEvent({ id: 'S6', startsAt: '2026-10-06 10:00', status: 'confirmed' }, guessed)?.status, 'booked');
});

test('メニュー: 推論が一時的に使えなくても予約は受け取り、あとで推測し直して引き当てる', async () => {
  const { store, service, bookings, repo } = setup(['!throw']);
  const kit = await service.createItem('t1', 'u1', { name: '体験セット', unit: 'セット' }, 5);
  assert.ok('item' in kit);
  const src = await bookings.createSource('t1', 'admin', '見本');
  assert.ok('key' in src);
  const r = await bookings.ingest(src.key, { id: 'E7', startsAt: '2099-04-01 10:00', menu: '体験コース' });
  assert.ok(r.ok && r.mapped === false, '推論に失敗しても受け取る');
  // 推論が戻ったあと（毎朝の見張りの前）に推測し直す
  const retry = await new InventoryBookings({ store, service, repo,
    llm: async () => ({ name: 'fake', complete: async () => ({ text: `{"items": [{"itemId": "${kit.item.id}", "qty": 1}], "none": false, "confident": true}`, tokensUsed: 1 }) }) as unknown as LlmProvider,
  }).retryUnmapped('t1', '2099-03-31T15:00:00.000Z');
  assert.equal(retry, 1);
  assert.equal((await service.detail('t1', kit.item.id))!.item.available, 4);
});
