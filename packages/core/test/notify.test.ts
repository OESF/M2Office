/**
 * @file 通知の控え（Chat・メール）の単体テスト。
 *
 * 届け先の選び方、通知しない時間帯、1 回しか送らないこと、停止中の会社へ送らないことを確かめる。
 *
 * @see 仕様書 第6.5.5.2節
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type Notification, type Tenant, type UserSettings } from '@m2office/shared';
import {
  MockNotificationSender, NotificationDelivery, channelsOf, inQuietHours, localHm,
  type Repository,
} from '../src/index.js';

/** 控えの見回りが使う操作だけを持つ、記憶上の永続化層。 */
class NotifyRepo {
  tenants: Tenant[] = [
    { id: 't1', subdomain: 'a', name: 'A 社', workspaceDomain: null, status: 'active' },
  ];
  users = [{ id: 'u1', tenantId: 't1', email: 'u1@alpha.example.jp', displayName: '一般', roles: ['member'], status: 'active' }];
  settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  notifications: Notification[] = [];
  audits: { action: string }[] = [];
  async listTenantIds() { return this.tenants.map((t) => t.id); }
  async findTenantById(id: string) { return this.tenants.find((t) => t.id === id) ?? null; }
  async findUserById(t: string, id: string) { return this.users.find((u) => u.tenantId === t && u.id === id) ?? null; }
  async getUserSettings() { return this.settings; }
  async listUndeliveredNotifications(t: string, limit: number) {
    return this.notifications.filter((n) => n.tenantId === t && !n.deliveredAt).slice(0, limit);
  }
  async markNotificationDelivered(_t: string, id: string, deliveredAt: string | null, note: string) {
    this.notifications = this.notifications.map((n) => (n.id === id ? { ...n, deliveredAt, deliveryNote: note } : n));
  }
  async appendAudit(e: { action: string }) { this.audits.push(e); }
}

function setup(): { repo: NotifyRepo; sender: MockNotificationSender; delivery: NotificationDelivery } {
  const repo = new NotifyRepo();
  const sender = new MockNotificationSender();
  const delivery = new NotificationDelivery({
    repo: repo as unknown as Repository, sender,
    linkFor: (tenant) => `http://${tenant.subdomain}.lvh.me:3100`,
  });
  repo.notifications.push({
    id: 'n1', tenantId: 't1', userId: 'u1', kind: 'approval', title: '承認をお願いします: 議事録作成・共有',
    body: '議事録の内容と、抽出した決定事項', runId: 'r1', readAt: null,
    createdAt: '2026-09-23T01:00:00.000Z', deliveredAt: null, deliveryNote: null,
  });
  return { repo, sender, delivery };
}

test('通知しない時間帯の判定は、日をまたぐ指定も扱う', () => {
  assert.equal(inQuietHours('23:30', { from: '22:00', to: '07:00' }), true);
  assert.equal(inQuietHours('06:59', { from: '22:00', to: '07:00' }), true);
  assert.equal(inQuietHours('07:00', { from: '22:00', to: '07:00' }), false);
  assert.equal(inQuietHours('13:00', { from: '12:00', to: '13:30' }), true);
  assert.equal(inQuietHours('13:00', null), false);
  assert.equal(localHm(new Date('2026-09-23T01:00:00.000Z'), 'Asia/Tokyo'), '10:00', '日本時間で見る');
});

test('既定では控えを送らない（画面内のみ）', async () => {
  const { repo, sender, delivery } = setup();
  assert.deepEqual(channelsOf(repo.settings), []);
  const r = await delivery.sweep(new Date('2026-09-23T01:10:00.000Z'));
  assert.deepEqual(r, { sent: 0, held: 0 });
  assert.equal(sender.outbox.length, 0);
  assert.equal(repo.notifications[0]!.deliveryNote, '画面内のみ', '見回りの対象から外す');
});

test('Chat とメールを選んだ人には、種類・題名・リンクだけを送り、二度と送らない', async () => {
  const { repo, sender, delivery } = setup();
  repo.settings.notifications.channels = { chat: true, email: true };
  const r = await delivery.sweep(new Date('2026-09-23T01:10:00.000Z'));
  assert.deepEqual(r, { sent: 1, held: 0 });
  assert.deepEqual(sender.outbox.map((x) => x.channel), ['chat', 'email']);
  const sent = sender.outbox[0]!;
  assert.equal(sent.kindLabel, '承認依頼');
  assert.equal(sent.title, '承認をお願いします: 議事録作成・共有');
  assert.equal(sent.link, 'http://a.lvh.me:3100');
  assert.equal(JSON.stringify(sent).includes('抽出した決定事項'), false, '本文は送らない');
  assert.ok(repo.audits.some((a) => a.action === 'notification.deliver'));

  await delivery.sweep(new Date('2026-09-23T01:20:00.000Z'));
  assert.equal(sender.outbox.length, 2, '送り終えた通知は送り直さない');
});

test('通知しない時間帯は送らず、明けてから送る', async () => {
  const { repo, sender, delivery } = setup();
  repo.settings.notifications.channels = { chat: true, email: false };
  repo.settings.notifications.quietHours = { from: '22:00', to: '07:00' };
  // 日本時間 23:00
  const r = await delivery.sweep(new Date('2026-09-23T14:00:00.000Z'));
  assert.deepEqual(r, { sent: 0, held: 1 });
  assert.equal(sender.outbox.length, 0);
  assert.equal(repo.notifications[0]!.deliveredAt, null, '届けていない通知として残す');

  // 日本時間 08:00
  const next = await delivery.sweep(new Date('2026-09-23T23:00:00.000Z'));
  assert.deepEqual(next, { sent: 1, held: 0 });
  assert.equal(sender.outbox.length, 1);
});

test('停止中の会社と、使えない利用者には送らない', async () => {
  const { repo, sender, delivery } = setup();
  repo.settings.notifications.channels = { chat: true, email: false };
  repo.tenants[0]!.status = 'suspended';
  assert.deepEqual(await delivery.sweep(new Date('2026-09-23T01:10:00.000Z')), { sent: 0, held: 0 });
  assert.equal(sender.outbox.length, 0);
  assert.equal(repo.notifications[0]!.deliveredAt, null, '再開したら届ける');

  repo.tenants[0]!.status = 'active';
  repo.users[0]!.status = 'disabled';
  await delivery.sweep(new Date('2026-09-23T01:10:00.000Z'));
  assert.equal(sender.outbox.length, 0);
  assert.equal(repo.notifications[0]!.deliveryNote, '届け先の利用者が使えません');
});

test('送れなかった通知は、あきらめる時刻まで送り直す', async () => {
  const { repo } = setup();
  repo.settings.notifications.channels = { chat: true, email: false };
  const failing = new NotificationDelivery({
    repo: repo as unknown as Repository,
    sender: { source: 'mock', chat: async () => { throw new Error('接続できません'); }, email: async () => undefined },
    linkFor: () => 'http://a.lvh.me:3100',
  });
  assert.deepEqual(await failing.sweep(new Date('2026-09-23T01:10:00.000Z')), { sent: 0, held: 1 });
  assert.equal(repo.notifications[0]!.deliveredAt, null);
  assert.match(repo.notifications[0]!.deliveryNote ?? '', /送れませんでした/);

  // 24 時間を過ぎたらあきらめる（画面内のお知らせは残る）
  await failing.sweep(new Date('2026-09-24T02:00:00.000Z'));
  assert.ok(repo.notifications[0]!.deliveredAt, 'あきらめて見回りの対象から外す');
});
