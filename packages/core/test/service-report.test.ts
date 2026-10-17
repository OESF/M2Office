/**
 * @file 月ごとの稼働の報告（仕様書 第16.11.3節 G-9）の単体テスト。
 *
 * 稼働率は障害（止まった）の時間だけを数え、計画停止と一部の不具合を数えないこと、重なった障害を 1 つに数えること、
 * 月をまたぐ障害をその月の分だけ数えること、続いている障害はいままでを数えること、まだ来ていない月は稼働率を出さないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthRange, serviceReport, type ServiceIncident } from '../src/index.js';

const inc = (id: string, impact: ServiceIncident['impact'], startedAt: string, endedAt: string | null): ServiceIncident => ({ id, title: id, impact, body: '', updates: [], startedAt, endedAt });

test('月の範囲は日本時間で区切る', () => {
  const { from, to } = monthRange('2026-10');
  assert.equal(from.toISOString(), '2026-09-30T15:00:00.000Z');
  assert.equal(to.toISOString(), '2026-10-31T15:00:00.000Z');
});

test('稼働率: 障害だけを数え、重なりは 1 つに、月をまたぐものはその月の分だけ', () => {
  const now = new Date('2026-12-01T00:00:00Z');
  const r = serviceReport('2026-10', [
    inc('a', 'down', '2026-10-10T00:00:00Z', '2026-10-10T02:00:00Z'),
    inc('b', 'down', '2026-10-10T01:00:00Z', '2026-10-10T03:00:00Z'),
    inc('c', 'maintenance', '2026-10-20T00:00:00Z', '2026-10-20T04:00:00Z'),
    inc('d', 'degraded', '2026-10-21T00:00:00Z', '2026-10-21T05:00:00Z'),
    inc('e', 'down', '2026-10-31T14:00:00Z', '2026-11-01T00:00:00Z'),
  ], now);
  assert.equal(r.minutes, 31 * 24 * 60);
  assert.equal(r.downMinutes, 180 + 60, '重なった 2 つは 3 時間、月をまたぐものは 10 月の 1 時間だけ');
  assert.equal(r.maintenanceMinutes, 240);
  assert.equal(r.uptime, Math.floor((1 - 240 / (31 * 24 * 60)) * 10_000) / 100);
  assert.equal(r.incidents[0]!.id, 'e', '新しい順');
});

test('続いている障害はいままでを数え、まだ来ていない月は稼働率を出さない', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const r = serviceReport('2026-10', [inc('x', 'down', '2026-10-01T15:00:00Z', null)], now);
  assert.equal(r.downMinutes, 9 * 60);
  assert.equal(r.minutes, 33 * 60, '月の始まり（9/30 15:00Z）からいままで');
  assert.equal(serviceReport('2027-01', [], now).uptime, null);
  assert.equal(serviceReport('2026-09', [], now).uptime, 100);
});
