/**
 * @file 在庫の見張りの知らせと、納品書からの入庫の単体テスト（仕様書 第29.14節・第29.9節）。
 *
 * 見張り: 数が変わって残りわずかになった品目をその場で知らせ、同じ日に二度は知らせない。知らせる相手は最近記録した人
 * （いなければ管理者）。本人が「在庫」の知らせを切っていれば送らない。毎朝の見直しは 1 通にまとめる。
 * 納品書: 推論の答えの読み方（金額を読まない・形が違えば読めなかった扱い）、品目への照らし方（バーコード → 品番 → 名前）、
 * 照らせた行だけを入庫にし、仕入れの単位を換算すること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS, type InventorySettings, type Notification, type User, type UserSettings,
} from '@m2office/shared';
import {
  InventoryService, InventoryWatch, MemoryInventoryStore, matchLine, parseSlipReading, type Repository,
} from '../src/index.js';

function setup(features: Partial<InventorySettings['features']> = {}) {
  const settings: InventorySettings = {
    ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true, features: { ...DEFAULT_TENANT_SETTINGS.inventory.features, ...features },
  };
  const notifications: Notification[] = [];
  const prefs = new Map<string, UserSettings>();
  const users: User[] = [
    { id: 'u-admin', tenantId: 't1', email: 'a@x.example', displayName: '管理者', roles: ['admin'], status: 'active' } as User,
    { id: 'u-staff', tenantId: 't1', email: 's@x.example', displayName: '担当', roles: ['member'], status: 'active' } as User,
    { id: 'u-other', tenantId: 't1', email: 'o@x.example', displayName: 'ほか', roles: ['member'], status: 'active' } as User,
  ];
  const repo = {
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, inventory: settings }),
    listUserGroupIds: async () => [],
    appendAudit: async () => undefined,
    listUsers: async () => users,
    listTenantIds: async () => ['t1'],
    getUserSettings: async (_t: string, u: string) => prefs.get(u) ?? structuredClone(DEFAULT_USER_SETTINGS),
    listNotifications: async (_t: string, u: string) => notifications.filter((n) => n.userId === u),
    createNotification: async (n: Notification) => { notifications.push(n); },
  } as unknown as Repository;
  const service = new InventoryService({ store: new MemoryInventoryStore(), repo });
  const watch = new InventoryWatch({ repo, service });
  return { service, watch, notifications, prefs };
}

test('見張り: 残りわずかになった品目を、最近記録した人にその場で知らせる。同じ日に二度は知らせない', async () => {
  const { service, watch, notifications } = setup();
  const made = await service.createItem('t1', 'u-staff', { name: 'トナー', unit: '本' }, 5);
  assert.ok('item' in made);
  await service.recordMove('t1', 'u-staff', { kind: 'out', itemId: made.item.id, qty: 3 });
  const n1 = await watch.afterMoves('t1', [made.item.id], new Date('2026-09-29T01:00:00Z'));
  assert.equal(n1, 1);
  assert.equal(notifications[0]!.userId, 'u-staff', '最近記録した人に知らせる（管理者やほかの人には送らない）');
  assert.equal(notifications[0]!.kind, 'inventory');
  assert.match(notifications[0]!.title, /トナーが残りわずかです（09\/29）/);
  assert.match(notifications[0]!.body, /使える数 2 本・残りわずか\n発注の案: /);
  const n2 = await watch.afterMoves('t1', [made.item.id], new Date('2026-09-29T03:00:00Z'));
  assert.equal(n2, 0, '同じ日に同じ品目を二度知らせない');
});

test('見張り: 最近記録した人がいなければ管理者に知らせる。「在庫」の知らせを切った人には送らない', async () => {
  const { service, watch, notifications, prefs } = setup();
  const made = await service.createItem('t1', 'u-admin', { name: '紙', unit: '冊' });
  assert.ok('item' in made);
  assert.deepEqual(await watch.recipients('t1'), ['u-admin'], '記録が無ければ管理者');
  const off = structuredClone(DEFAULT_USER_SETTINGS);
  off.notifications.kinds.inventory = false;
  prefs.set('u-admin', off);
  assert.equal(await watch.daily('t1', new Date('2026-09-29T00:00:00Z')), 0);
  assert.equal(notifications.length, 0);
});

test('見張り: 毎朝の見直しは、足りなくなりそうなものと使用期限の近いロットを 1 通にまとめる', async () => {
  const { service, watch, notifications } = setup({ lots: true });
  const cream = await service.createItem('t1', 'u-staff', { name: 'クリーム', unit: '個' });
  const paper = await service.createItem('t1', 'u-staff', { name: '紙', unit: '冊' }, 1);
  assert.ok('item' in cream && 'item' in paper);
  // 今日（日本時間 2026-09-29）から 7 日後が期限のロット
  await service.recordMove('t1', 'u-staff', { kind: 'in', itemId: cream.item.id, qty: 10, lot: 'L7', expiresOn: '2026-10-06' });
  const now = new Date('2026-09-28T23:30:00Z');
  const sent = await watch.daily('t1', now);
  assert.equal(sent, 1);
  const body = notifications[0]!.body;
  assert.match(body, /■ 足りなくなりそうなもの\n紙: 使える数 1 冊・残りわずか/);
  assert.match(body, /■ 使用期限\nクリーム（ロット L7）: 10 個が 7 日後に期限/);
  assert.equal(await watch.daily('t1', now), 0, '同じ日に二度まとめない');
});

test('納品書: 推論の答えを読み、金額は読まない。形が違えば読めなかった扱いにする', () => {
  const r = parseSlipReading('```json\n{"isSlip": true, "supplier": "文具店", "date": "2026-09-29", "lines": [{"name": "トナー 黒", "sku": "TN-1", "code": "", "qty": "２", "unit": "箱", "lot": "", "expiresOn": "2027/01/31", "price": 5000}]}\n```');
  assert.ok(r.kind === 'slip');
  assert.deepEqual(r.lines[0], { name: 'トナー 黒', sku: 'TN-1', code: '', qty: 2, unit: '箱', lot: '', expiresOn: '' });
  assert.equal(parseSlipReading('よく分かりません').kind, 'not-slip');
  assert.equal(parseSlipReading('{"isSlip": false}').kind, 'not-slip');
});

test('納品書: 品目への照らし合わせはバーコード → 品番 → 名前。1 つに決まらなければ候補を返す', () => {
  const base = { publicName: '', category: '', unit: '個', packUnit: '', packSize: null, price: null, priceTaxIncluded: true, photoFileId: null, lowThreshold: null, supplierId: null, leadDays: null, note: '', status: 'active' as const, updatedAt: '' };
  const items = [
    { ...base, id: 'a', name: 'トナー（黒）', sku: 'TN-1', codes: ['4901234567894'] },
    { ...base, id: 'b', name: 'トナー（カラー）', sku: 'TN-2', codes: [] },
    { ...base, id: 'c', name: 'コピー用紙 A4', sku: '', codes: [] },
  ];
  const line = (o: Partial<{ name: string; sku: string; code: string }>) => ({ name: '', sku: '', code: '', qty: 1, unit: '', lot: '', expiresOn: '', ...o });
  assert.equal((matchLine(line({ code: '4901234567894' }), items) as { item: { id: string } }).item.id, 'a');
  assert.equal((matchLine(line({ sku: 'tn-2' }), items) as { item: { id: string } }).item.id, 'b');
  assert.equal((matchLine(line({ name: 'コピー用紙A4 500枚' }), items) as { item: { id: string } }).item.id, 'c', '名前を含む');
  const amb = matchLine(line({ name: 'トナー' }), items);
  assert.ok('candidates' in amb && amb.candidates.length === 2);
});

test('納品書: 照らせた行だけを入庫にし、仕入れの単位は入り数で直す。数が読めない行は入れない', async () => {
  const { service } = setup({ units: true });
  const toner = await service.createItem('t1', 'u1', { name: 'トナー（黒）', unit: '本', packUnit: '箱', packSize: 5 });
  assert.ok('item' in toner);
  const res = await service.receiveLines('t1', 'u1', [
    { name: 'トナー（黒）', sku: '', code: '', qty: 2, unit: '箱', lot: '', expiresOn: '' },
    { name: '知らない品', sku: '', code: '', qty: 1, unit: '個', lot: '', expiresOn: '' },
    { name: 'トナー（黒）', sku: '', code: '', qty: null, unit: '箱', lot: '', expiresOn: '' },
  ], 'f-slip');
  assert.deepEqual(res.recorded.map((r) => r.text), ['トナー（黒）: 10 本（2 箱）']);
  assert.deepEqual(res.unmatched.map((u) => u.reason), ['当てはまる品目がありません', '数が読めません']);
  const d = await service.detail('t1', toner.item.id);
  assert.equal(d!.item.onHand, 10);
  assert.deepEqual([d!.moves[0]!.source, d!.moves[0]!.reason], ['slip', '納品書']);
});

test('発注の下書き: 送る段は承認の後ろに置き、承認の前の組み立てで必ず gmail.send を呼ばせる（呼び忘れると承認の段が空のまま通った）', async () => {
  const { INVENTORY_ORDER } = await import('../src/index.js');
  const ids = INVENTORY_ORDER.steps.map((s) => s.id);
  assert.deepEqual(ids, ['compose', 'gate-send', 'send']);
  const gate = INVENTORY_ORDER.steps[1]!;
  assert.equal(gate.type, 'approval');
  const send = INVENTORY_ORDER.steps[2]!;
  assert.ok(send.type === 'agent' && send.tools?.join() === 'gmail.send' && send.required?.includes('gmail.send'));
  const compose = INVENTORY_ORDER.steps[0]!;
  assert.ok(compose.type === 'agent' && !(compose.tools ?? []).includes('gmail.send'), '作る段では送れない');
});
