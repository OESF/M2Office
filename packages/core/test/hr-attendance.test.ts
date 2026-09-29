/**
 * @file 人事・給与の段 2 の単体テスト（仕様書 第30.6.1節・第30.7.1節）。
 *
 * 日の集計（休憩・深夜・日の法定外・所定外・法定休日・点検）、週 40 時間、期間と 60 時間超、締めの期間、36 協定の知らせ、
 * 有給の付与の表（通常と比例）・時効・古い付与から使う順・取得義務を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttDay, AttPunch, LeaveGrant, LeaveTake } from '@m2office/shared';
import {
  summarizeDay, periodTotals, periodOf, periodContaining, agreementAlerts, dueGrantDates, grantDays, leaveBalance, groupShifts,
  japaneseHolidays, dayType,
} from '../src/index.js';
import { attendanceRequest, parseLeaveDate, isHalfDay } from '../src/secretary/attendance.js';

const p = (kind: AttPunch['kind'], date: string, hm: string): AttPunch => ({ id: `${kind}${date}${hm}`, employeeId: 'e1', kind, at: new Date(`${date}T${hm}:00+09:00`).toISOString(), source: 'screen' });
const sched = { start: '09:00', end: '18:00', breakMinutes: 60 };

test('日の集計: 所定どおり・残業・深夜・休憩の不足・法定休日', () => {
  const normal = summarizeDay('2026-09-28', [p('in', '2026-09-28', '09:00'), p('break_start', '2026-09-28', '12:00'), p('break_end', '2026-09-28', '13:00'), p('out', '2026-09-28', '18:00')], 'workday', sched, 0, '2026-10-01');
  assert.deepEqual([normal.workMinutes, normal.breakMinutes, normal.overtimeMinutes, normal.extraMinutes, normal.issues.length], [480, 60, 0, 0, 0]);
  const late = summarizeDay('2026-09-28', [p('in', '2026-09-28', '09:30'), p('break_start', '2026-09-28', '12:00'), p('break_end', '2026-09-28', '13:00'), p('out', '2026-09-28', '20:00')], 'workday', sched, 0, '2026-10-01');
  assert.equal(late.overtimeMinutes, 90, '8 時間を超えた分');
  assert.equal(late.lateMinutes, 30);
  const night = summarizeDay('2026-09-28', [p('in', '2026-09-28', '18:00'), p('out', '2026-09-29', '03:00')], 'workday', sched, 0, '2026-10-01');
  assert.equal(night.workMinutes, 540);
  assert.equal(night.nightMinutes, 300, '22 時〜3 時');
  assert.equal(night.overtimeMinutes, 60);
  assert.ok(night.issues.some((i) => i.includes('60 分')), '8 時間を超えて休憩が無い');
  const holiday = summarizeDay('2026-09-27', [p('in', '2026-09-27', '10:00'), p('out', '2026-09-27', '15:00')], 'legal-holiday', sched, 0, '2026-10-01');
  assert.deepEqual([holiday.holidayMinutes, holiday.overtimeMinutes], [300, 0], '法定休日の労働は時間外に数えない');
  const part = summarizeDay('2026-09-28', [p('in', '2026-09-28', '10:00'), p('out', '2026-09-28', '16:00')], 'workday', { start: '10:00', end: '15:00', breakMinutes: 0 }, 0, '2026-10-01');
  assert.equal(part.extraMinutes, 60, '所定 5 時間を超え 8 時間までの分');
  const missing = summarizeDay('2026-09-28', [], 'workday', sched, 0, '2026-10-01');
  assert.deepEqual(missing.issues, ['打刻がありません']);
  const onLeave = summarizeDay('2026-09-28', [], 'workday', sched, 1, '2026-10-01');
  assert.deepEqual(onLeave.issues, [], '有給の日は指摘しない');
  const noOut = summarizeDay('2026-09-28', [p('in', '2026-09-28', '09:00')], 'workday', sched, 0, '2026-10-01');
  assert.deepEqual(noOut.issues, ['退勤の打刻がありません']);
});

test('週 40 時間: 月〜土に 8 時間ずつ働くと、土曜の 8 時間が週の法定外になる', () => {
  const days: AttDay[] = [];
  for (let d = 27; d <= 30; d++) {
    const date = `2026-09-${d}`;
    const type = d === 27 ? 'legal-holiday' as const : 'workday' as const;
    days.push(summarizeDay(date, d === 27 ? [] : [p('in', date, '09:00'), p('break_start', date, '12:00'), p('break_end', date, '13:00'), p('out', date, '18:00')], type, sched, 0, '2026-12-31'));
  }
  for (let d = 1; d <= 3; d++) {
    const date = `2026-10-0${d}`;
    days.push(summarizeDay(date, [p('in', date, '09:00'), p('break_start', date, '12:00'), p('break_end', date, '13:00'), p('out', date, '18:00')], d === 3 ? 'dayoff' : 'workday', sched, 0, '2026-12-31'));
  }
  const t = periodTotals(days, { start: '2026-09-27', end: '2026-10-03' }, 0);
  assert.equal(t.workMinutes, 2880);
  assert.equal(t.weeklyOvertimeMinutes, 480);
  assert.equal(t.overtimeMinutes, 480);
  const firstHalf = periodTotals(days, { start: '2026-09-27', end: '2026-09-30' }, 0);
  assert.equal(firstHalf.overtimeMinutes, 0, '40 時間を超えた日の期間に数える');
});

test('締めの期間と、月 60 時間を超えた法定外', () => {
  assert.deepEqual(periodOf('2026-09', 20), { start: '2026-08-21', end: '2026-09-20', label: '2026 年 9 月分' });
  assert.deepEqual(periodOf('2026-02', 31), { start: '2026-02-01', end: '2026-02-28', label: '2026 年 2 月分' });
  assert.equal(periodContaining('2026-09-25', 20).end, '2026-10-20');
  assert.equal(periodContaining('2026-12-25', 20).end, '2027-01-20');
  const days: AttDay[] = Array.from({ length: 20 }, (_, i) => {
    const date = `2026-09-${String(i + 1).padStart(2, '0')}`;
    return summarizeDay(date, [p('in', date, '08:00'), p('break_start', date, '12:00'), p('break_end', date, '13:00'), p('out', date, '21:00')], 'workday', sched, 0, '2026-12-31');
  });
  const t = periodTotals(days, { start: '2026-09-01', end: '2026-09-20' }, 1);
  assert.ok(t.overtimeMinutes >= 4 * 60 * 20);
  assert.equal(t.over60Minutes, t.overtimeMinutes - 3600);
});

test('36 協定: 80% で近づき、上限で超える。特別条項は 100 時間と平均も見る', () => {
  const tot = (ot: number, hol = 0) => ({ workDays: 0, workMinutes: 0, overtimeMinutes: ot * 60, weeklyOvertimeMinutes: 0, extraMinutes: 0, nightMinutes: 0, holidayMinutes: hol * 60, over60Minutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, missingDays: 0 });
  const a = { enabled: true, monthly: 45, yearly: 360, special: false, startMonth: 4 };
  assert.deepEqual(agreementAlerts([{ label: '9 月分', totals: tot(30) }], a), []);
  assert.equal(agreementAlerts([{ label: '9 月分', totals: tot(37) }], a)[0]!.level, 'near');
  assert.equal(agreementAlerts([{ label: '9 月分', totals: tot(46) }], a)[0]!.level, 'over');
  const special = agreementAlerts([{ label: '8 月分', totals: tot(85) }, { label: '9 月分', totals: tot(90, 12) }], { ...a, special: true });
  assert.ok(special.some((x) => x.key.includes(':100:over')), '法定外と休日の労働で 100 時間');
  assert.ok(special.some((x) => x.key.includes(':avg2:over')), '2 か月の平均が 80 時間を超える');
  assert.deepEqual(agreementAlerts([{ label: '9 月分', totals: tot(99) }], { ...a, enabled: false }), [], '協定が無ければ見ない');
});

test('有給の付与: 通常と比例、6 か月と以後 1 年ごと', () => {
  assert.equal(grantDays(0, 5, 40), 10);
  assert.equal(grantDays(1, 5, 40), 11);
  assert.equal(grantDays(9, 5, 40), 20, '6 年 6 か月以上は 20 日');
  assert.equal(grantDays(0, 3, 20), 5, '週 3 日の比例付与');
  assert.equal(grantDays(6, 4, 25), 15);
  assert.equal(grantDays(0, 4, 32), 10, '週 30 時間以上は通常');
  assert.deepEqual(dueGrantDates('2025-04-01', '2026-10-01').map((x) => x.date), ['2025-10-01', '2026-10-01']);
  assert.deepEqual(dueGrantDates('2026-08-31', '2027-03-01').map((x) => x.date), ['2027-02-28'], '月末は月の日数に合わせる');
  assert.deepEqual(dueGrantDates('2025-04-01', '2026-10-01', '2026-06-30').map((x) => x.date), ['2025-10-01'], '退職日より後は付与しない');
});

test('有給の残り: 古い付与から使い、2 年で時効。取得義務は 1 年に 5 日', () => {
  const g = (id: string, on: string, days: number, exp: string): LeaveGrant => ({ id, employeeId: 'e1', grantedOn: on, days, expiresOn: exp, basis: 'auto', note: '' });
  const t = (date: string, days = 1): LeaveTake => ({ id: date, employeeId: 'e1', date, days, status: 'taken', source: 'screen' });
  const grants = [g('a', '2024-10-01', 10, '2026-10-01'), g('b', '2025-10-01', 11, '2027-10-01')];
  const takes = [t('2025-11-10'), t('2025-12-01'), t('2026-01-05', 0.5), { ...t('2026-02-02'), status: 'cancelled' as const }];
  const now = leaveBalance(grants, takes, '2026-03-01');
  assert.equal(now.grants[0]!.used, 2.5, '古い付与から使う');
  assert.equal(now.remaining, 18.5);
  assert.deepEqual(now.obligation, { grantedOn: '2025-10-01', deadline: '2026-09-30', taken: 2.5, required: 5 });
  const later = leaveBalance(grants, takes, '2026-10-01');
  assert.equal(later.remaining, 11, '古い付与の残りは時効で消える');
});

test('打刻を出勤した日の勤務にまとめる（日をまたぐ退勤は出勤した日の分）', () => {
  const shifts = groupShifts([p('in', '2026-09-28', '18:00'), p('out', '2026-09-29', '03:00'), p('in', '2026-09-29', '18:00'), p('out', '2026-09-29', '22:00')], '2026-09-28', '2026-09-29');
  assert.equal(shifts.get('2026-09-28')!.length, 2);
  assert.equal(shifts.get('2026-09-29')!.length, 2);
});

test('秘書: 打刻・有給の残り・申請を見分け、日付を読む（決まりの問いは見分けない）', () => {
  assert.deepEqual(attendanceRequest('出勤'), { kind: 'punch', punch: 'in' });
  assert.deepEqual(attendanceRequest('おはようございます、出勤します'), { kind: 'punch', punch: 'in' });
  assert.deepEqual(attendanceRequest('退勤します。'), { kind: 'punch', punch: 'out' });
  assert.deepEqual(attendanceRequest('休憩'), { kind: 'punch', punch: 'break_start' });
  assert.deepEqual(attendanceRequest('休憩終わり'), { kind: 'punch', punch: 'break_end' });
  assert.equal(attendanceRequest('出勤簿を出して'), null);
  assert.equal(attendanceRequest('出勤時間は？'), null);
  assert.deepEqual(attendanceRequest('有給あと何日？'), { kind: 'balance' });
  assert.deepEqual(attendanceRequest('来週の金曜、有給で休みます'), { kind: 'leave', cancel: false });
  assert.deepEqual(attendanceRequest('10月3日の有給を取り消して'), { kind: 'leave', cancel: true });
  assert.equal(attendanceRequest('有給休暇の申請方法を教えて'), null, '手順の問いは規程の問い');
  assert.equal(attendanceRequest('有給は何日もらえるの？'), null);
  // 2026-09-30 は水曜
  assert.equal(parseLeaveDate('来週の金曜、有給で休みます', '2026-09-30'), '2026-10-09');
  assert.equal(parseLeaveDate('今週の金曜に有給', '2026-09-30'), '2026-10-02');
  assert.equal(parseLeaveDate('金曜に有給', '2026-09-30'), '2026-10-02');
  assert.equal(parseLeaveDate('明日有給で休みます', '2026-09-30'), '2026-10-01');
  assert.equal(parseLeaveDate('10/5 に有給', '2026-09-30'), '2026-10-05');
  assert.equal(parseLeaveDate('1月5日に有給', '2026-12-20'), '2027-01-05', '過ぎた月日は来年');
  assert.equal(parseLeaveDate('2月30日に有給', '2026-09-30'), null);
  assert.equal(parseLeaveDate('そのうち有給で', '2026-09-30'), null, '読めなければ推測しない');
  assert.equal(isHalfDay('明日の午後休を有給で'), true);
});

test('祝日: 決まった日・ハッピーマンデー・春分と秋分・振替休日・国民の休日（2026 年）', () => {
  const h = [...japaneseHolidays(2026)].sort();
  assert.deepEqual(h, [
    '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
    '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
  ]);
  const work = { weekdays: [1, 2, 3, 4, 5], legalHoliday: 0, weekStart: 0, nationalHolidays: true };
  assert.equal(dayType('2026-09-23', work), 'dayoff', '祝日は所定休日');
  assert.equal(dayType('2026-09-23', { ...work, nationalHolidays: false }), 'workday', '祝日も働く会社');
  assert.equal(dayType('2026-09-27', work), 'legal-holiday');
});
