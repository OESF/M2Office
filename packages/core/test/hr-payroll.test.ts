/**
 * @file 人事・給与の段 3 の計算の見本（仕様書 第30.10.1節・第30.10.2節・第30.27節）。
 *
 * 公式の額表・税額表の値（協会けんぽ 令和8年度の東京都と北海道の保険料額表、国税庁の月額表の設例）と、
 * 取り込んだ法令の表で出した額が一致することを確かめる。表を更新するたびにこのテストを通す。
 * あわせて、割増賃金・欠勤控除・翌月徴収・介護保険の年齢・住民税の年度・最低賃金の決まりを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type AttTotals, type HrEmployee, type HrSettings, type HrTerms } from '@m2office/shared';
import { Law, LAW_BOOK, calcSlip, round50, reachMonth, insuredIn } from '../src/index.js';

const law = new Law(LAW_BOOK);

test('表: 協会けんぽ 令和8年度の保険料額表の折半額と一致する（50 銭以下切り捨て）', () => {
  const half = (std: number, rate: number) => round50((std * rate) / 100 / 2);
  assert.equal(law.healthRate('東京都', '2026-04')!.value, 9.85);
  assert.equal(half(260000, 9.85), 12805, '東京都 等級 20 健康保険');
  assert.equal(half(240000, 9.85), 11820, '東京都 等級 19');
  assert.equal(half(500000, 9.85 + law.careRate('2026-04')!.value), 28675, '東京都 等級 30 介護を含む 11.47%');
  assert.equal(half(260000, law.pensionRate('2026-04')!.value), 23790, '厚生年金 18.3%');
  assert.equal(half(260000, law.childSupportRate('2026-04')!.value), 299, '子ども・子育て支援金 0.23%');
  assert.equal(half(58000, law.healthRate('北海道', '2026-04')!.value), 2981, '北海道 等級 1 の 2,981.2 円');
  assert.equal(law.childSupportRate('2026-03'), null, '支援金は令和8年4月分から');
  assert.equal(law.healthRate('東京都', '2026-02'), null, '令和7年度の表は持っていない（表が未登録と示す）');
});

test('表: 標準報酬月額の等級（健康保険と厚生年金の上限・下限）', () => {
  assert.deepEqual([law.grade(62999, '2026-04')!.value.health.amount, law.grade(63000, '2026-04')!.value.health.amount], [58000, 68000]);
  assert.equal(law.grade(2000000, '2026-04')!.value.health.amount, 1390000);
  assert.equal(law.pensionAmountFor(58000, '2026-04')!.value.amount, 88000, '厚生年金の下限');
  assert.equal(law.pensionAmountFor(1390000, '2026-04')!.value.amount, 650000, '厚生年金の上限');
});

test('表: 源泉徴収税額表（月額表）令和8年分の設例と式', () => {
  assert.equal(law.withholding(357000, 'ko', 2, '2026-10-25')!.value.tax, 7020, '国税庁の設例: 356,000 円の行・扶養 2 人');
  assert.equal(law.withholding(104999, 'ko', 0, '2026-10-25')!.value.tax, 0, '105,000 円未満の甲欄は 0 円');
  assert.equal(law.withholding(100000, 'otsu', 0, '2026-10-25')!.value.tax, 3063, '105,000 円未満の乙欄は 3.063%');
  assert.equal(law.withholding(105000, 'ko', 0, '2026-10-25')!.value.tax, 170);
  assert.equal(law.withholding(750000, 'ko', 0, '2026-10-25')!.value.tax, 71680 + 2042, '740,000 円の額 ＋ 超える分 × 20.42%');
  assert.equal(law.withholding(357000, 'ko', 9, '2026-10-25')!.value.tax, 0, '7 人を超えたら 1 人ごとに引き、0 円より下にしない');
  assert.equal(law.withholding(357000, 'ko', 0, '2025-12-25'), null, '令和7年分の表は持っていない');
});

const settings: HrSettings = {
  ...DEFAULT_HR_SETTINGS, enabled: true, health: { kind: 'kyokai', prefecture: '東京都' },
  payroll: { ...DEFAULT_HR_SETTINGS.payroll, avgMonthlyHours: 170 },
};
const employee: HrEmployee = {
  id: 'e1', code: '', name: '見本', kana: '', birthDate: '1990-05-01', gender: '', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '',
};
const terms: HrTerms = {
  id: 't1', employeeId: 'e1', effectiveOn: '2020-04-01', contractStart: null, contractEnd: null, renewal: '', probationUntil: null, weeklyHours: 40, weeklyDays: 5,
  startTime: '09:00', endTime: '18:00', breakMinutes: 60, wageType: 'monthly', wageAmount: 300000, allowances: [{ name: '役職手当', amount: 20000 }, { name: '家族手当', amount: 10000 }],
  workplace: '', work: '', workplaceScope: '', workScope: '', socialInsurance: true, employmentInsurance: true, createdAt: '',
};
const zero: AttTotals = { workDays: 20, workMinutes: 9600, overtimeMinutes: 0, weeklyOvertimeMinutes: 0, extraMinutes: 0, nightMinutes: 0, holidayMinutes: 0, over60Minutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, missingDays: 0 };
const slip = (over: Partial<Parameters<typeof calcSlip>[0]> = {}) => calcSlip({
  employee, terms, profile: { employeeId: 'e1', taxColumn: 'ko', dependents: 0, residentTax: [{ fiscalYear: 2026, municipality: '渋谷区', june: 12300, monthly: 12000 }], commute: { monthly: 15000, taxFree: 15000 }, bank: {} },
  standardPay: 340000, totals: zero, days: [], settings, payMonth: '2026-10', payDate: '2026-10-25', periodEnd: '2026-09-30', law, ...over,
});
const line = (r: ReturnType<typeof calcSlip>, code: string) => r.lines.find((l) => l.code === code)?.amount ?? 0;

test('給与: 基本給・手当・割増（家族手当は割増の基礎に入れない）・社会保険料・雇用保険料・所得税・住民税', () => {
  const r = slip({ totals: { ...zero, overtimeMinutes: 600, nightMinutes: 120 } });
  // 単価 = (300,000 + 20,000) ÷ 170 = 1,882.35…
  assert.equal(line(r, 'overtime'), Math.round((320000 / 170) * 10 * 1.25), '10 時間 × 1.25');
  assert.equal(line(r, 'night'), Math.round((320000 / 170) * 2 * 0.25));
  assert.equal(line(r, 'health'), round50((340000 * 9.85) / 100 / 2), '9 月分（翌月徴収）の東京都の料率');
  assert.equal(line(r, 'child'), round50((340000 * 0.23) / 100 / 2));
  assert.equal(line(r, 'pension'), round50((340000 * 18.3) / 100 / 2));
  assert.equal(line(r, 'employment'), round50(r.gross * 0.005), '賃金の総額（通勤手当を含む）× 5/1000');
  const social = line(r, 'health') + line(r, 'child') + line(r, 'pension') + line(r, 'employment');
  assert.equal(line(r, 'income-tax'), law.withholding(r.gross - 15000 - social, 'ko', 0, '2026-10-25')!.value.tax, '非課税の通勤手当と社会保険料等を引いて月額表');
  assert.equal(line(r, 'resident-tax'), 12000, '10 月は 7 月以降の月額');
  assert.equal(r.net, r.gross - r.deductions);
  assert.ok(r.warnings.includes('法令の表が監修前です（確定には使えません）'));
  assert.ok(r.lines.find((l) => l.code === 'health')!.basis['表']);
});

test('給与: 月 60 時間超・欠勤と遅刻・介護保険の年齢・資格の月・時給の人', () => {
  const r = slip({ totals: { ...zero, overtimeMinutes: 4200, over60Minutes: 600, missingDays: 2, lateMinutes: 30 }, days: Array.from({ length: 21 }, (_, i) => ({ date: `2026-09-${i + 1}`, type: 'workday' as const, in: null, out: null, breakMinutes: 0, workMinutes: 0, nightMinutes: 0, overtimeMinutes: 0, extraMinutes: 0, holidayMinutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, issues: [] })) });
  assert.equal(line(r, 'over60'), Math.round((320000 / 170) * 10 * 1.5), '60 時間を超えた 10 時間は × 1.5');
  assert.equal(line(r, 'absence'), -Math.round((300000 / 21) * 2), '基本給 ÷ 所定の労働日 × 欠勤');
  assert.equal(line(r, 'late'), -Math.round((320000 / 170) * 0.5));
  assert.equal(reachMonth('1986-10-01', 40), '2026-09', '40 歳に達した日（誕生日の前の日）の月');
  const care = slip({ employee: { ...employee, birthDate: '1986-10-01' } });
  assert.match(care.lines.find((l) => l.code === 'health')!.label, /介護/, '9 月 30 日に 40 歳に達した人は 9 月分から介護');
  const noCare = slip({ employee: { ...employee, birthDate: '1986-10-02' } });
  assert.doesNotMatch(noCare.lines.find((l) => l.code === 'health')!.label, /介護/, '10 月 1 日に達する人は 10 月分から');
  assert.equal(insuredIn({ hiredOn: '2026-09-15', leftOn: null }, '2026-09'), true);
  assert.equal(insuredIn({ hiredOn: '2026-10-01', leftOn: null }, '2026-09'), false, '翌月徴収で入社の前の月の分は引かない');
  assert.equal(insuredIn({ hiredOn: '2020-04-01', leftOn: '2026-09-30' }, '2026-09'), true, '月末の退職はその月まで');
  assert.equal(insuredIn({ hiredOn: '2020-04-01', leftOn: '2026-09-29' }, '2026-09'), false, '月の途中の退職はその月の分は無い');
  const part = slip({ terms: { ...terms, wageType: 'hourly', wageAmount: 1200, allowances: [], weeklyHours: 20 }, totals: { ...zero, workMinutes: 4800, overtimeMinutes: 60 }, standardPay: null });
  assert.equal(line(part, 'base'), 96000, '時給 × 実労働 80 時間');
  assert.equal(line(part, 'overtime'), Math.round(1200 * 1 * 0.25), '時給の人は割増の分だけを足す');
  assert.ok(part.warnings.some((w) => w.includes('標準報酬月額が未登録')));
  const low = slip({ terms: { ...terms, wageType: 'hourly', wageAmount: 1100, allowances: [] }, standardPay: null });
  assert.ok(low.warnings.some((w) => w.includes('東京都の最低賃金')), '東京都 1,226 円を下回る');
});
