/**
 * @file シフトと 1 か月単位の変形労働時間制の見本（仕様書 第30.6.2節）。
 *
 * 厚生労働省のリーフレット「1箇月単位の変形労働時間制」（静岡労働局の資料も同じ）の計算例: 31 日の月（1 日が日曜）・所定 172 時間・
 * 総枠 177.1 時間・実労働 181 時間で、1 日の時間外 2 時間・週の時間外 1 時間・期間の時間外 0.9 時間（所定の中）・法定内 6 時間、
 * 時給 1,000 円なら 181,975 円。あわせて、シフトの案づくり（休みの希望・連続の勤務・総枠）と点検を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type AttDay, type HrShiftSettings, type HrTerms, type HrEmployee } from '@m2office/shared';
import { Law, LAW_BOOK, variableTotals, variableCapMinutes, generatePlan, checkPlan, calcSlip, type PlanInput } from '../src/index.js';

const H = 60;
/** 2026 年 3 月（1 日が日曜）の日。所定と実労働（時間）を曜日で並べる。 */
function march(): AttDay[] {
  // [日付, 所定, 実労働]
  const plan: [number, number, number][] = [
    [2, 8, 8], [3, 8, 8], [4, 8, 8], [5, 8, 8], [6, 8, 8],
    [9, 6, 6], [10, 6, 6], [11, 7, 7], [12, 7, 7], [13, 4, 7], [14, 8, 9],
    [16, 6, 6], [17, 8, 8], [18, 8, 8], [19, 10, 10], [20, 10, 11],
    [23, 6, 6], [24, 6, 6], [25, 8, 8], [26, 8, 8], [27, 4, 6], [28, 4, 6],
    [30, 8, 8], [31, 8, 8],
  ];
  const out: AttDay[] = [];
  for (let d = 1; d <= 31; d++) {
    const p = plan.find((x) => x[0] === d);
    out.push({
      date: `2026-03-${String(d).padStart(2, '0')}`, type: p ? 'workday' : 'dayoff', in: null, out: null, breakMinutes: 0, workMinutes: (p?.[2] ?? 0) * H, nightMinutes: 0,
      overtimeMinutes: 0, extraMinutes: 0, holidayMinutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, issues: [], scheduledMinutes: (p?.[1] ?? 0) * H,
    });
  }
  return out;
}

test('総枠: 40 × 暦日数 ÷ 7 の 0.1 時間未満切り捨て（28 日 160.0・30 日 171.4・31 日 177.1 時間、特例 31 日 194.8 時間）', () => {
  assert.deepEqual([28, 29, 30, 31].map((d) => variableCapMinutes(d) / 60), [160, 165.7, 171.4, 177.1]);
  assert.equal(variableCapMinutes(31, true) / 60, 194.8);
});

test('リーフレットの計算例: 日の時間外 2 時間・週の時間外 1 時間・期間の時間外 0.9 時間（所定の中）・法定内 6 時間', () => {
  const days = march();
  const t = variableTotals(days, { start: '2026-03-01', end: '2026-03-31' }, 0, variableCapMinutes(31));
  assert.equal(t.workMinutes, 181 * H);
  assert.equal(t.overtimeMinutes, 3.9 * H, '1（14 日）＋ 1（20 日）＋ 週 1 ＋ 期間 0.9');
  assert.equal(t.weeklyOvertimeMinutes, 60, '8〜14 日の週は所定 38 時間で、40 時間を超えた 1 時間');
  assert.equal(t.overtimeWithinMinutes, 0.9 * H, '期間の時間外は最終日の所定の中');
  assert.equal(t.extraMinutes, 6 * H, '法定内（割増なし）6 時間');
  assert.equal(days.find((d) => d.date === '2026-03-31')!.overtimeMinutes, 0.9 * H);
  // 時給 1,000 円: 181 時間 ＋ 割増 25% × 3.9 時間 = 181,975 円
  const settings = { ...DEFAULT_HR_SETTINGS, enabled: true, health: { kind: 'none' as const, prefecture: '' } };
  const terms = { id: 't', employeeId: 'e1', effectiveOn: '2020-04-01', contractStart: null, contractEnd: null, renewal: '', probationUntil: null, weeklyHours: 40, weeklyDays: 5, startTime: '', endTime: '', breakMinutes: 0,
    wageType: 'hourly', wageAmount: 1000, allowances: [], workplace: '', work: '', workplaceScope: '', workScope: '', socialInsurance: false, employmentInsurance: false, createdAt: '' } as HrTerms;
  const employee = { id: 'e1', name: '見本', birthDate: '1990-01-01', hiredOn: '2020-04-01', leftOn: null, category: 'employee' } as HrEmployee;
  const r = calcSlip({ employee, terms, profile: null, standardPay: null, totals: t, days, settings, payMonth: '2026-04', payDate: '2026-04-25', periodEnd: '2026-03-31', law: new Law(LAW_BOOK) });
  assert.equal(r.gross, 181975);
});

test('月給の人は、期間の時間外のうち所定の中の分に割増（25%）だけを払い、法定内は 100% で払う', () => {
  const days = march();
  const t = variableTotals(days, { start: '2026-03-01', end: '2026-03-31' }, 0, variableCapMinutes(31));
  const settings = { ...DEFAULT_HR_SETTINGS, enabled: true, health: { kind: 'none' as const, prefecture: '' }, payroll: { ...DEFAULT_HR_SETTINGS.payroll, avgMonthlyHours: 172, deductAbsence: false } };
  const terms = { id: 't', employeeId: 'e1', effectiveOn: '2020-04-01', contractStart: null, contractEnd: null, renewal: '', probationUntil: null, weeklyHours: 40, weeklyDays: 5, startTime: '', endTime: '', breakMinutes: 0,
    wageType: 'monthly', wageAmount: 172000, allowances: [], workplace: '', work: '', workplaceScope: '', workScope: '', socialInsurance: false, employmentInsurance: false, createdAt: '' } as HrTerms;
  const employee = { id: 'e1', name: '見本', birthDate: '1990-01-01', hiredOn: '2020-04-01', leftOn: null, category: 'employee' } as HrEmployee;
  const r = calcSlip({ employee, terms, profile: null, standardPay: null, totals: t, days, settings, payMonth: '2026-04', payDate: '2026-04-25', periodEnd: '2026-03-31', law: new Law(LAW_BOOK) });
  // 単価 172,000 ÷ 172 = 1,000 円: 時間外 3 時間 × 1.25 ＋ 所定の中 0.9 時間 × 0.25 ＋ 法定内 6 時間 × 1.00 = 3,750 ＋ 225 ＋ 6,000
  assert.equal(r.gross, 172000 + 3750 + 225 + 6000);
});

test('シフトの案: 要る人数を、休みの希望・7 日続けない・週の所定労働日数・総枠を守って割り当て、足りない枠を点検に出す', () => {
  const settings: HrShiftSettings = {
    variable: true, special44: false,
    patterns: [{ id: 'a', name: '早番', start: '09:00', end: '18:00', breakMinutes: 60 }, { id: 'b', name: '遅番', start: '13:00', end: '22:00', breakMinutes: 60 }],
    needs: [0, 1, 2, 3, 4, 5, 6].flatMap((day) => [{ day, patternId: 'a', count: 1 }, { day, patternId: 'b', count: 1 }]),
  };
  const days = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  const member = (id: string) => ({ employeeId: id, name: id, weeklyDays: 5, weeklyHours: null, hiredOn: null, leftOn: null });
  const input: PlanInput = { days, members: ['A', 'B', 'C'].map(member), settings, requests: new Set(['A|2026-11-03']), weekStart: 0 };
  const shifts = generatePlan(input);
  assert.ok(!shifts.some((s) => s.employeeId === 'A' && s.date === '2026-11-03'), '休みの希望の日は入れない');
  for (const id of ['A', 'B', 'C']) {
    const mine = shifts.filter((s) => s.employeeId === id).length * 8 * H;
    assert.ok(mine <= variableCapMinutes(30), `${id} は総枠 171.4 時間以内`);
  }
  const issues = checkPlan(input, shifts);
  assert.ok(!issues.some((x) => x.level === 'stop'), '止めるものは無い');
  assert.ok(!issues.some((x) => x.code === 'short'), '3 人なら 60 枠を埋められる（1 人 21 日 × 8 時間 = 168 時間 ≦ 総枠 171.4 時間）');
  const two = { ...input, members: ['A', 'B'].map(member) };
  assert.ok(checkPlan(two, generatePlan(two)).some((x) => x.code === 'short'), '2 人では 60 枠を埋めきれず、足りない枠を示す');
  const seven = [...shifts, ...days.slice(0, 7).map((d) => ({ employeeId: 'C', date: d, patternId: 'a', start: '09:00', end: '18:00', breakMinutes: 60 }))];
  assert.ok(checkPlan(input, seven).some((x) => x.code === 'no-rest' && x.employeeId === 'C'), '7 日続けて働くと止める');
});
