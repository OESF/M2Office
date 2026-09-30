/**
 * @file 人事・給与の段 1 の単体テスト（仕様書 第30.5.2節・第30.5節）。
 *
 * 入退社の手続きの期限（決まったプログラムで作る）、支払日の求め方、取り込みの日付と加入の読み方を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS } from '@m2office/shared';
import { hireProcedures, leaveProcedures, payDateFor, tenthOfNextMonth, addOneMonth, toHrDate, toFlag, withinFiveDays } from '../src/index.js';

const settings = { ...DEFAULT_HR_SETTINGS };

test('入社の手続き: 保険の加入に応じて並び、期限は入社日から決まる', () => {
  const all = hireProcedures({ category: 'employee', hiredOn: '2026-10-01', leftOn: null, socialInsurance: true, employmentInsurance: true }, settings);
  const due = Object.fromEntries(all.map((t) => [t.code, t.dueOn]));
  assert.equal(due['terms-notice'], '2026-10-01', '労働条件通知書は入社日まで');
  assert.equal(due['social-acquire'], '2026-10-05', '資格取得届は入社日から 5 日以内');
  assert.equal(due['employment-acquire'], '2026-11-10', '雇用保険は翌月 10 日');
  assert.equal(due['dependents'], '2026-11-01');
  const part = hireProcedures({ category: 'employee', hiredOn: '2026-10-01', leftOn: null, socialInsurance: false, employmentInsurance: false }, settings);
  assert.ok(!part.some((t) => t.code === 'social-acquire' || t.code === 'employment-acquire'), '加入しない保険の届出は作らない');
  assert.deepEqual(hireProcedures({ category: 'owner', hiredOn: '2026-10-01', leftOn: null, socialInsurance: true, employmentInsurance: true }, settings), [], '事業主本人には作らない');
  const byExpert = hireProcedures({ category: 'employee', hiredOn: '2026-10-01', leftOn: null, socialInsurance: true, employmentInsurance: false }, { procedures: 'sharoushi' });
  assert.match(byExpert.find((t) => t.code === 'social-acquire')!.title, /^社会保険労務士へ依頼: /);
});

test('社会保険の届出の 5 日以内: 事実のあった日を 1 日目として 5 日目（資格取得・資格喪失・年齢の到達・賞与支払届でそろえる）', () => {
  assert.equal(withinFiveDays('2026-07-10'), '2026-07-14', '7 月 10 日に払った賞与の支払届は 7 月 14 日まで');
  assert.equal(withinFiveDays('2026-12-30'), '2027-01-03', '年をまたぐ。休みの日でもずらさない');
  assert.equal(withinFiveDays('2027-02-26'), '2027-03-02', '月をまたぐ');
});

test('退職の手続き: 退職日の翌日から数え、最後の給与は会社の締めと支払で決まる', () => {
  const pay = { closingDay: 20, payDay: 25, payMonth: 'same' as const };
  const all = leaveProcedures({ category: 'employee', hiredOn: '2020-04-01', leftOn: '2027-06-15', socialInsurance: true, employmentInsurance: true }, { procedures: 'self', pay });
  const due = Object.fromEntries(all.map((t) => [t.code, t.dueOn]));
  assert.equal(due['social-lose'], '2027-06-20');
  assert.equal(due['employment-lose'], '2027-06-25');
  assert.equal(due['resident-change'], '2027-07-10');
  assert.equal(due['withholding-slip'], '2027-07-15');
  assert.equal(due['final-pay'], '2027-06-25', '20 日締め当月 25 日払いで 6/15 の分は 6/25');
});

test('支払日・翌月 10 日・1 か月後（月末と年またぎ）', () => {
  assert.equal(payDateFor('2026-12-31', { closingDay: 31, payDay: 25, payMonth: 'next' }), '2027-01-25', '末締め翌月 25 日払い');
  assert.equal(payDateFor('2026-01-21', { closingDay: 20, payDay: 31, payMonth: 'next' }), '2026-03-31', '20 日を過ぎれば翌月の締め、その翌月の末日');
  assert.equal(payDateFor('2026-02-10', { closingDay: 31, payDay: 31, payMonth: 'same' }), '2026-02-28', '末日は月の日数に合わせる');
  assert.equal(tenthOfNextMonth('2026-12-05'), '2027-01-10');
  assert.equal(addOneMonth('2026-01-31'), '2026-02-28');
});

test('取り込み: 日付と加入の読み方', () => {
  assert.equal(toHrDate('2026/4/1'), '2026-04-01');
  assert.equal(toHrDate('2026年4月1日'), '2026-04-01');
  assert.equal(toHrDate('２０２６－０４－０１'), '2026-04-01', '全角も読む');
  assert.equal(toHrDate('2026/2/30'), null, '無い日は読まない');
  assert.equal(toHrDate('令和8年4月1日'), null, '和暦は読まない（推測で直さない）');
  assert.equal(toFlag('加入'), true);
  assert.equal(toFlag('×'), false);
  assert.equal(toFlag(''), null);
});

test('取り込み: 見出しの言い方の揺れを推論なしで読む', async () => {
  const { HrService } = await import('../src/index.js');
  const service = new HrService({ store: {} as never, repo: {} as never });
  const mapping = await (service as unknown as { mapHeaders(t: string, h: string[]): Promise<{ header: string; field: string | null }[]> })
    .mapHeaders('t1', ['従業員氏名', 'フリガナ', '入社年月日', '時給', '雇用保険', '社会保険加入']);
  assert.deepEqual(mapping.map((m) => m.field), ['name', 'kana', 'hiredOn', 'wageAmount', 'employmentInsurance', 'socialInsurance']);
});
