/**
 * @file 会社の営業日の単体テスト（第 0.243.0 版）。営業する曜日・祝日・休業の期間と、「会社の営業日」の定時実行（朝のブリーフの既定）を
 * 営業日でない日には動かさないこと、休業のお知らせを出したら期間を覚えること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Schedule, type TenantSettings } from '@m2office/shared';
import {
  MemoryAnnouncementStore, Scheduler, businessDayChecker, closedReason, describeRule, isClosure, localDay, nextRunAt, validateRule,
  type Repository,
} from '../src/index.js';

test('規則: 「会社の営業日」は毎日の回に置き、言葉は「会社の営業日 7:30」', () => {
  const rule = { kind: 'business' as const, hour: 7, minute: 30 };
  validateRule(rule);
  assert.equal(describeRule(rule), '会社の営業日 7:30');
  // 2026-10-03（土）の 8 時（日本時間）の次は、10-04（日）の 7:30。営業日かは動かすときに確かめる
  assert.equal(nextRunAt(rule, 'Asia/Tokyo', new Date('2026-10-02T23:00:00Z')), '2026-10-03T22:30:00.000Z');
  assert.equal(localDay(new Date('2026-10-03T22:30:00Z'), 'Asia/Tokyo'), '2026-10-04');
});

test('営業日: 営業しない曜日・祝日（休みにしていれば）・休業の期間は営業日でない。土日に営業する店も選べる', () => {
  const weekdays = { businessDays: [1, 2, 3, 4, 5], holidaysClosed: true };
  assert.equal(closedReason(weekdays, '2026-10-05', false), null, '月曜');
  assert.equal(closedReason(weekdays, '2026-10-04', false), 'weekday', '日曜');
  assert.equal(closedReason(weekdays, '2026-11-03', false), 'holiday', '文化の日（火）');
  assert.equal(closedReason({ ...weekdays, holidaysClosed: false }, '2026-11-03', false), null, '祝日も営業する会社');
  assert.equal(closedReason(weekdays, '2026-12-29', true), 'closure', '年末年始の休業');
  const shop = { businessDays: [0, 2, 3, 4, 5, 6], holidaysClosed: false };
  assert.equal(closedReason(shop, '2026-10-04', false), null, '日曜に営業する店');
  assert.equal(closedReason(shop, '2026-10-05', false), 'weekday', '月曜が定休日');
  assert.equal(closedReason({}, '2026-10-04', false), 'weekday', '古い設定は月〜金');
});

test('休業のお知らせ: 題名と本文の言葉で見分け、期間を覚える', async () => {
  assert.equal(isClosure({ title: '年末年始の休業のお知らせ', body: '' }), true);
  assert.equal(isClosure({ title: '夏季休診のお知らせ', body: '' }), true);
  assert.equal(isClosure({ title: '新しいサービスを始めました', body: 'ぜひお試しください' }), false);
  const store = new MemoryAnnouncementStore();
  await store.addClosure('t1', 'ann-1', '2026-12-28', '2027-01-05');
  assert.equal(await store.closedOn('t1', '2027-01-01'), true);
  assert.equal(await store.closedOn('t1', '2027-01-06'), false);
  assert.equal(await store.closedOn('t2', '2027-01-01'), false, 'ほかの会社には効かない');
});

test('定時実行: 「会社の営業日」の回は、営業日でない日には動かさず、次の回に進める。ほかの規則はそのまま動く', async () => {
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS };
  const store = new MemoryAnnouncementStore();
  await store.addClosure('t1', 'ann-1', '2026-12-28', '2027-01-05');
  const schedules: Schedule[] = [
    { id: 's-business', tenantId: 't1', userId: 'u1', agentId: 'morning-brief', agentVersion: 1, input: {}, rule: { kind: 'business', hour: 7, minute: 30 }, timezone: 'Asia/Tokyo', enabled: true, nextRunAt: '', lastRunAt: null } as unknown as Schedule,
    { id: 's-daily', tenantId: 't1', userId: 'u1', agentId: 'other', agentVersion: 1, input: {}, rule: { kind: 'daily', hour: 7, minute: 30 }, timezone: 'Asia/Tokyo', enabled: true, nextRunAt: '', lastRunAt: null } as unknown as Schedule,
  ];
  const run = async (at: string) => {
    let pending = [...schedules];
    const checked: string[] = [];
    const repo = {
      getTenantSettings: async () => settings,
      claimDueSchedule: async () => pending.shift() ?? null,
    } as unknown as Repository;
    const scheduler = new Scheduler({
      repo, businessDay: businessDayChecker({ repo, closedOn: (t, d) => store.closedOn(t, d) }),
    } as never);
    // 実行を始める手前（業務の確かめ）まで来たかを、確かめの関数が呼ばれたかで見る
    (scheduler as unknown as { deps: Record<string, unknown> }).deps['resolveDefinition'] = async (id: string) => { checked.push(id); return null; };
    (scheduler as unknown as { deps: Record<string, unknown> }).deps['repo'] = { ...repo, appendAudit: async () => undefined };
    await scheduler.tick(new Date(at)).catch(() => undefined);
    pending = [];
    return checked;
  };
  assert.deepEqual(await run('2026-10-05T22:30:00Z'), ['morning-brief', 'other'], '火曜は両方動かす');
  assert.deepEqual(await run('2026-10-03T22:30:00Z'), ['other'], '日曜は営業日の回を動かさない');
  assert.deepEqual(await run('2026-12-30T22:30:00Z'), ['other'], '休業の期間も動かさない');
  settings = { ...settings, company: { ...settings.company, businessDays: [0, 1, 2, 3, 4, 5, 6], holidaysClosed: false } };
  assert.deepEqual(await run('2026-10-03T22:30:00Z'), ['morning-brief', 'other'], '年中無休の会社は日曜も動かす');
});
