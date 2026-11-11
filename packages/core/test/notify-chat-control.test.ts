/**
 * @file Chat への通知の届け方を本人が決める仕組みの単体テスト（仕様書 第10.16.5節、ADR-0138）。
 *
 * 既定の時間帯（21:00〜翌 7:00）・一人ひとりの時間帯（夜勤の人は昼）・会社の休みの日・Chat に送らない種類・
 * 明けたら 1 通にまとめて送ること、秘書への頼みで届け方を変えること（読み取りと当て方）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type Notification, type Tenant, type UserSettings } from '@m2office/shared';
import {
  MockNotificationSender, NotificationDelivery, applyNotifyPreference, chatNotificationText, inQuietTime, kindsOf, notifyPreferenceRequest, readTime,
  type Repository,
} from '../src/index.js';

class Repo {
  tenants: Tenant[] = [{ id: 't1', subdomain: 'a', name: 'A 社', workspaceDomain: null, status: 'active' }];
  users = [{ id: 'u1', tenantId: 't1', email: 'u1@alpha.example.jp', displayName: '一般', roles: ['member'], status: 'active' }];
  settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  notifications: Notification[] = [];
  audits: { action: string; detail?: Record<string, unknown> }[] = [];
  async listTenantIds() { return this.tenants.map((t) => t.id); }
  async findTenantById(id: string) { return this.tenants.find((t) => t.id === id) ?? null; }
  async findUserById(t: string, id: string) { return this.users.find((u) => u.tenantId === t && u.id === id) ?? null; }
  async getUserSettings() { return this.settings; }
  async listUndeliveredNotifications(t: string, limit: number) { return this.notifications.filter((n) => n.tenantId === t && !n.deliveredAt).slice(0, limit); }
  async markNotificationDelivered(_t: string, id: string, deliveredAt: string | null, note: string) {
    this.notifications = this.notifications.map((n) => (n.id === id ? { ...n, deliveredAt, deliveryNote: note } : n));
  }
  async appendAudit(e: { action: string; detail?: Record<string, unknown> }) { this.audits.push(e); }
}

const note = (id: string, kind: Notification['kind'], title: string): Notification => ({
  id, tenantId: 't1', userId: 'u1', kind, title, body: '本文は送らない', runId: null, readAt: null,
  createdAt: '2026-11-11T12:00:00.000Z', deliveredAt: null, deliveryNote: null,
});

/** 日本時間の日時。 */
const jst = (s: string) => new Date(`${s}+09:00`);

function setup(opts: { holidays?: string[] } = {}) {
  const repo = new Repo();
  repo.settings.notifications.channels.chat = true;
  const sender = new MockNotificationSender();
  const delivery = new NotificationDelivery({
    repo: repo as unknown as Repository, sender, linkFor: () => 'https://a.m2office.example',
    businessDay: async (_t, day) => !(opts.holidays ?? []).includes(day),
  });
  return { repo, sender, delivery };
}

test('既定: 決めていなくても夜（21:00〜翌 7:00）は送らず、明けたら 1 通にまとめて送る', async () => {
  const { repo, sender, delivery } = setup();
  assert.deepEqual(DEFAULT_USER_SETTINGS.notifications.quietHours, { from: '21:00', to: '07:00' });
  repo.notifications.push(note('n1', 'approval', '承認をお願いします: 見積書'), note('n2', 'run', '議事録ができました'), note('n3', 'run', 'スライドができました'));
  assert.deepEqual(await delivery.sweep(jst('2026-11-11T23:30:00')), { sent: 0, held: 3 });
  assert.equal(sender.outbox.length, 0);
  assert.deepEqual(await delivery.sweep(jst('2026-11-12T07:05:00')), { sent: 3, held: 0 });
  assert.equal(sender.outbox.length, 1, '1 通にまとめる');
  const text = chatNotificationText(sender.outbox[0]!);
  assert.equal(text, [
    '【知らせ 3 件】業務の完了 2 件・承認依頼 1 件',
    '・【承認依頼】承認をお願いします: 見積書', '・【業務の完了】議事録ができました', '・【業務の完了】スライドができました',
    '<https://a.m2office.example/|画面で開く>',
  ].join('\n'));
  assert.ok(!text.includes('本文'), '本文は載せない');
  assert.ok(repo.notifications.every((n) => n.deliveredAt));
  assert.equal(repo.audits.filter((a) => a.action === 'notification.deliver').length, 3);
});

test('一人ひとりの時間帯: 夜勤の人は昼を控え、「いつでも送る」なら時間で控えない', async () => {
  const s = structuredClone(DEFAULT_USER_SETTINGS);
  s.notifications.quietHours = { from: '09:00', to: '17:00' };
  assert.equal(await inQuietTime(s, jst('2026-11-11T12:00:00')), true);
  assert.equal(await inQuietTime(s, jst('2026-11-11T23:00:00')), false, '夜勤の人には夜に送る');
  s.notifications.quietHours = null;
  assert.equal(await inQuietTime(s, jst('2026-11-11T03:00:00')), false);
});

test('会社の休みの日は送らない。休みの日に働く人は切れる', async () => {
  const { repo, sender, delivery } = setup({ holidays: ['2026-11-14'] });
  repo.notifications.push(note('n1', 'failure', '業務が止まりました'));
  assert.deepEqual(await delivery.sweep(jst('2026-11-14T10:00:00')), { sent: 0, held: 1 });
  repo.settings.notifications.quietDaysOff = false;
  assert.deepEqual(await delivery.sweep(jst('2026-11-14T10:00:00')), { sent: 1, held: 0 });
  assert.equal(sender.outbox[0]!.title, '業務が止まりました', '1 件ならそのまま');
  assert.equal(sender.outbox[0]!.items, undefined);
});

test('Chat に送らない種類は送らない（画面には届いている）', async () => {
  const { repo, sender, delivery } = setup();
  repo.settings.notifications.chatOff = ['run'];
  repo.notifications.push(note('n1', 'run', '議事録ができました'), note('n2', 'approval', '承認をお願いします'));
  assert.deepEqual(await delivery.sweep(jst('2026-11-11T10:00:00')), { sent: 1, held: 0 });
  assert.equal(sender.outbox.length, 1);
  assert.equal(sender.outbox[0]!.kindLabel, '承認依頼');
  assert.equal(repo.notifications.find((n) => n.id === 'n1')!.deliveryNote, 'Chat に送らない種類');
});

test('時刻の読み方: 夜・朝・午後・半・コロン', () => {
  assert.equal(readTime('夜10時'), '22:00');
  assert.equal(readTime('朝8時半'), '08:30');
  assert.equal(readTime('午後9時15分'), '21:15');
  assert.equal(readTime('22:30'), '22:30');
  assert.equal(readTime('夜12時'), '00:00');
  assert.equal(readTime('9時'), '09:00');
  assert.equal(readTime('30時'), null);
});

test('秘書への頼みの読み取り: 時間帯・いつでも・休みの日・種類', () => {
  assert.deepEqual(notifyPreferenceRequest('夜 10 時から朝 8 時は送らないで'), { kind: 'quiet', from: '22:00', to: '08:00' });
  assert.deepEqual(notifyPreferenceRequest('9時〜17時は Chat に通知しないで'), { kind: 'quiet', from: '09:00', to: '17:00' });
  assert.deepEqual(notifyPreferenceRequest('夜も送っていい'), { kind: 'quietOff' });
  assert.deepEqual(notifyPreferenceRequest('時間を気にせず Chat に送って'), { kind: 'quietOff' });
  assert.deepEqual(notifyPreferenceRequest('土日も送っていい'), { kind: 'daysOff', on: false });
  assert.deepEqual(notifyPreferenceRequest('休みの日は送らないで'), { kind: 'daysOff', on: true });
  assert.deepEqual(notifyPreferenceRequest('完了は Chat に送らなくていい'), { kind: 'chatOff', kinds: ['run'] });
  assert.deepEqual(notifyPreferenceRequest('承認の依頼だけ Chat に送って'), { kind: 'chatOnly', kinds: ['approval'] });
  assert.deepEqual(notifyPreferenceRequest('完了と失敗の通知も Chat に送って'), { kind: 'chatOn', kinds: ['run', 'failure'] });
  // 通知の届け方でない頼みは取らない
  assert.equal(notifyPreferenceRequest('議事録は Chat に送らなくていい'), null);
  assert.equal(notifyPreferenceRequest('技術部のスペースに議事録を送って'), null);
  assert.equal(notifyPreferenceRequest('明日の 10 時から 12 時は予定を入れないで'), null);
  assert.equal(kindsOf('議事録'), null);
});

test('秘書への頼みを当てる: 設定を直し、答えを返す。Chat を切っている人には入れ方を添える', () => {
  const cur = structuredClone(DEFAULT_USER_SETTINGS).notifications;
  cur.channels.chat = true;
  const a = applyNotifyPreference(cur, { kind: 'quiet', from: '22:00', to: '08:00' });
  assert.deepEqual(a.next.quietHours, { from: '22:00', to: '08:00' });
  assert.equal(a.text, 'Chat には、22:00〜08:00 の間は送らず、明けてからまとめて送ります。');
  const only = applyNotifyPreference(cur, { kind: 'chatOnly', kinds: ['approval'] });
  assert.ok(only.next.chatOff.includes('run') && !only.next.chatOff.includes('approval'));
  const back = applyNotifyPreference(only.next, { kind: 'chatOn', kinds: ['run'] });
  assert.ok(!back.next.chatOff.includes('run'));
  assert.equal(back.text, '「業務の完了」も Chat に送ります。');
  const off = applyNotifyPreference({ ...cur, channels: { chat: false } }, { kind: 'daysOff', on: false });
  assert.equal(off.next.quietDaysOff, false);
  assert.match(off.text, /いまは Chat に送らない設定です/);
});
