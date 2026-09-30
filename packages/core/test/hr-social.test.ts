/**
 * @file 社会保険の定時決定・随時改定・資格・加入の判定の見本（仕様書 第30.12.1節）。
 *
 * 日本年金機構の算定基礎届の記入ガイドブック（令和8年度）と随時改定の説明の決まり（支払基礎日数 17 日・11 日・15 日、
 * 2 等級以上の差と上限・下限の特例、固定的賃金の増減と平均の向き）と、短時間労働者・雇用保険の適用の要件の施行日を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type HrEmployee, type HrStandardPay, type HrTerms, type PaySlip } from '@m2office/shared';
import {
  Law, LAW_BOOK, averageOf, calcSlip, changeCandidates, changeQualifies, eligibility, regularDetermination, socialEvents, acquirePay, day70, day75, type PaidSlip,
} from '../src/index.js';

const law = new Law(LAW_BOOK);
const rules = law.insuranceRules('2026-07-01')!;
const employee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: 'e1', code: '', name: '見本', kana: '', birthDate: '1980-05-10', gender: 'female', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '', ...over,
});
const terms = (over: Partial<HrTerms> = {}): HrTerms => ({
  id: 't', employeeId: 'e1', effectiveOn: '2020-04-01', contractStart: null, contractEnd: null, renewal: '', renewalLimit: '', probationUntil: null, weeklyHours: 40, weeklyDays: 5,
  startTime: '09:00', endTime: '18:00', breakMinutes: 60, wageType: 'monthly', wageAmount: 280000, allowances: [], workplace: '', work: '', workplaceScope: '', workScope: '',
  socialInsurance: true, employmentInsurance: true, createdAt: '', ...over,
});
/** 月給の明細（支払った月・基本給・通勤手当・時間外手当・支払基礎日数）。 */
const paid = (month: string, base: number, opt: { commute?: number; overtime?: number; days?: number; kind?: string } = {}): PaidSlip => {
  const lines: PaySlip['lines'] = [
    { code: 'base', label: '基本給', amount: base, kind: 'pay', basis: { 賃金の定め: '月給' } },
    ...(opt.commute ? [{ code: 'commute', label: '通勤手当', amount: opt.commute, kind: 'pay' as const, basis: {} }] : []),
    ...(opt.overtime ? [{ code: 'overtime', label: '時間外手当', amount: opt.overtime, kind: 'pay' as const, basis: {} }] : []),
  ];
  const gross = lines.reduce((s, l) => s + l.amount, 0);
  return {
    slip: { id: month, runId: month, employeeId: 'e1', gross, deductions: 0, net: gross, lines, warnings: [], meta: { baseDays: opt.days ?? 30 } },
    run: { kind: opt.kind ?? 'monthly', payMonth: month, payDate: `${month}-25`, periodStart: '', periodEnd: '' },
  };
};
const std = (fromMonth: string, amount: number): HrStandardPay => ({ id: fromMonth, employeeId: 'e1', fromMonth, amount, kind: 'manual' });
const months = (days: (number | null)[], pays: number[]) => days.map((d, i) => ({ month: `2026-0${4 + i}`, baseDays: d, pay: pays[i]!, retro: 0, counted: false }));

test('定時決定: 支払基礎日数 17 日以上の月だけの平均（1 円未満切り捨て）・短時間労働者は 11 日・4 分の 3 以上のパートは 15 日', () => {
  const a = averageOf(months([30, 16, 31], [300000, 250000, 300001]), rules, { shortTime: false, part: false, mode: 'regular' });
  assert.deepEqual(a.months.map((m) => m.counted), [true, false, true]);
  assert.equal(a.adjusted, 300000, '(300,000 + 300,001) ÷ 2 = 300,000.5 → 切り捨て');
  const s = averageOf(months([12, 10, 11], [100000, 90000, 110000]), rules, { shortTime: true, part: false, mode: 'regular' });
  assert.equal(s.adjusted, 105000, '短時間労働者は 11 日以上の月');
  const p = averageOf(months([16, 15, 14], [120000, 110000, 100000]), rules, { shortTime: false, part: true, mode: 'regular' });
  assert.equal(p.adjusted, 115000, '17 日以上の月が無いパートは 15 日以上の月');
  const none = averageOf(months([10, 9, 8], [1, 1, 1]), rules, { shortTime: false, part: false, mode: 'regular' });
  assert.equal(none.adjusted, null, '3 か月とも満たなければ従前の標準報酬月額');
});

test('定時決定: 6 月 1 日以後の取得は対象外、70 歳以上被用者は備考に入れて対象、遡及支払額は修正平均から除く', () => {
  const list = [paid('2026-04', 300000, { commute: 10000 }), paid('2026-05', 300000, { commute: 10000 }), paid('2026-06', 300000, { commute: 10000 }), paid('2026-05', 30000, { kind: 'correction' })];
  const base = { law, rules, year: 2026, terms: terms(), shortTime: false, paid: list, standardPays: [std('2025-09', 280000)], changeInJulyToSep: false };
  const d = regularDetermination({ ...base, employee: employee() });
  assert.equal(d.adjustedAverage, 310000);
  assert.equal(d.average, 320000, '遡及支払額 30,000 円を含めた平均');
  assert.equal(d.after?.amount, law.grade(310000, '2026-09')!.value.health.amount);
  assert.equal(d.applyMonth, '2026-09');
  assert.match(regularDetermination({ ...base, employee: employee({ hiredOn: '2026-06-10' }) }).excluded ?? '', /6 月 1 日以後/);
  assert.match(regularDetermination({ ...base, changeInJulyToSep: true, employee: employee() }).excluded ?? '', /随時改定/);
  assert.ok(regularDetermination({ ...base, employee: employee({ birthDate: '1955-01-15' }) }).notes.includes('70 歳以上被用者算定'));
  assert.match(regularDetermination({ ...base, paid: [], employee: employee() }).excluded ?? '', /M2Office にありません/, '給与の記録が無い月は、従前の額で決めない');
});

test('随時改定: 固定的賃金の変動から 3 か月の平均で 2 等級以上・向きが同じなら 4 か月目から。待つ・向きが逆・特例', () => {
  const base = { law, rulesAt: (m: string) => law.insuranceRules(m), employee: employee(), shortTime: false, filed: new Map<string, string>(), since: '2026-01' };
  const raise = [paid('2026-05', 280000, { commute: 10000 }), paid('2026-06', 310000, { commute: 10000 }), paid('2026-07', 310000, { commute: 10000 }), paid('2026-08', 310000, { commute: 10000 })];
  const [d] = changeCandidates({ ...base, paid: raise, standardPays: [std('2025-09', 280000)], confirmedMonths: new Set(['2026-05', '2026-06', '2026-07', '2026-08']) });
  assert.equal(d!.applyMonth, '2026-09', '6 月支払で変動 → 9 月改定');
  assert.equal(d!.excluded, null);
  assert.equal(d!.direction, 'up');
  assert.equal(d!.after?.amount, 320000);
  assert.equal(d!.after!.grade - d!.before!.grade, 2);

  const [w] = changeCandidates({ ...base, paid: raise.slice(0, 3), standardPays: [std('2025-09', 280000)], confirmedMonths: new Set(['2026-05', '2026-06', '2026-07']) });
  assert.match(w!.excluded ?? '', /8 月に支払う給与が確定したら/);

  const down = [paid('2026-05', 280000, { overtime: 60000 }), paid('2026-06', 285000), paid('2026-07', 285000), paid('2026-08', 285000)];
  const [x] = changeCandidates({ ...base, paid: down, standardPays: [std('2025-09', 340000)], confirmedMonths: new Set(['2026-05', '2026-06', '2026-07', '2026-08']) });
  assert.match(x!.excluded ?? '', /固定的賃金は上がりましたが、平均の等級は下がった/);

  assert.equal(changeQualifies(law, rules, 'health', 49, 50, 'up', 1300000, 1420000, '2026-09'), true, '健康保険 49 等級 → 平均 141.5 万円以上なら 1 等級差でも');
  assert.equal(changeQualifies(law, rules, 'health', 49, 50, 'up', 1300000, 1400000, '2026-09'), false);
  assert.equal(changeQualifies(law, rules, 'pension', 31, 32, 'up', 600000, 665000, '2026-09'), true, '厚生年金 31 等級 → 平均 66.5 万円以上');
  assert.equal(changeQualifies(law, rules, 'pension', 1, 2, 'up', 85000, 95000, '2026-09'), false, '従前の報酬月額が 8.3 万円以上なら特例に当たらない');
});

test('資格: 取得（時給は所定の時間から見込む）・退職の喪失（翌日）・75 歳（誕生日）・70 歳到達（相当額が同じなら届出は要らない）', () => {
  assert.equal(acquirePay(terms({ wageType: 'hourly', wageAmount: 1200, weeklyHours: 30 }), { employeeId: 'e1', taxColumn: 'ko', dependents: 0, residentTax: [], commute: { monthly: 8000 }, bank: {} })!.pay,
    Math.floor((1200 * 30 * 52) / 12) + 8000);
  assert.equal(day75('1951-10-03'), '2026-10-03');
  assert.equal(day70('1956-10-01'), '2026-09-30', '誕生日の前の日');
  const events = socialEvents({
    law, from: '2026-09-01', to: '2026-11-30',
    employees: [employee({ id: 'a', hiredOn: '2026-10-01' }), employee({ id: 'b', leftOn: '2026-10-15' }), employee({ id: 'c', birthDate: '1951-10-03' }), employee({ id: 'd', birthDate: '1956-10-20' })],
    termsAt: () => terms(), profiles: new Map(), standardPays: [{ ...std('2025-09', 280000), employeeId: 'd' }], withDependents: new Set(), shortTime: () => false, filed: new Map(),
  });
  const by = (id: string) => events.find((x) => x.employeeId === id)!;
  assert.equal(by('a').kind, 'acquire');
  assert.equal(by('a').dueOn, '2026-10-05', '5 日以内');
  assert.equal(by('a').grade?.amount, law.grade(280000, '2026-10')!.value.health.amount);
  assert.equal(by('b').date, '2026-10-16', '退職日の翌日に喪失');
  assert.equal(by('c').cause, '75 歳到達（健康保険のみ喪失）');
  assert.equal(by('c').date, '2026-10-03');
  assert.equal(by('d').kind, 'age70');
  assert.equal(by('d').required, false, '相当額（280,000 円）が今の標準報酬月額と同じ');
});

test('加入の判定: 4 分の 3・短時間労働者（特定適用事業所・週 20 時間・2026 年 10 月から賃金の要件なし・学生）・雇用保険（週 20 時間、2028 年 10 月から週 10 時間）', () => {
  const settings = { socialApply: 'mandatory' as const, officeForm: 'corporation' as const, insurance: DEFAULT_HR_SETTINGS.insurance, fullTimeWeeklyDays: 5 };
  const judge = (t: HrTerms, date: string, specificOffice: boolean, student = false) => eligibility({
    rules: law.insuranceRules(date)!, date, employee: employee(), terms: t, profile: { employeeId: 'e1', taxColumn: 'ko', dependents: 0, residentTax: [], commute: {}, bank: {}, insurance: { student } }, settings, specificOffice,
  });
  assert.equal(judge(terms({ weeklyHours: 32 }), '2026-09-30', false).social.should, true, '4 分の 3（30 時間）以上');
  const part = terms({ wageType: 'hourly', wageAmount: 1000, weeklyHours: 20, weeklyDays: 4 });
  assert.equal(judge(part, '2026-09-30', false).social.should, false, '特定適用事業所でない');
  assert.equal(judge(part, '2026-09-30', true).social.should, false, '2026 年 9 月は月 8.8 万円の要件（1,000 × 20 × 52 ÷ 12 = 86,666 円）');
  assert.equal(judge(part, '2026-10-01', true).social.should, true, '2026 年 10 月 1 日に賃金の要件を撤廃');
  assert.equal(judge(part, '2026-10-01', true, true).social.should, false, '学生');
  assert.equal(judge(part, '2026-10-01', true).employment.should, true);
  const short = terms({ wageType: 'hourly', wageAmount: 1200, weeklyHours: 12, weeklyDays: 3 });
  assert.equal(judge(short, '2026-10-01', true).employment.should, false);
  assert.equal(judge(short, '2028-10-01', true).employment.should, true, '2028 年 10 月から週 10 時間以上');
  assert.equal(law.insuranceRules('2027-10-01')!.shortTime.officeSize, 36);
});

test('75 歳の誕生日の月から、健康保険料・介護保険料・子ども・子育て支援金を引かない（厚生年金は 70 歳で終わっている）', () => {
  const settings = { ...DEFAULT_HR_SETTINGS, enabled: true, health: { kind: 'kyokai' as const, prefecture: '東京都' } };
  const zero = { workDays: 20, workMinutes: 9600, overtimeMinutes: 0, weeklyOvertimeMinutes: 0, extraMinutes: 0, nightMinutes: 0, holidayMinutes: 0, over60Minutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, missingDays: 0 };
  const run = (payMonth: string) => calcSlip({
    employee: employee({ birthDate: '1951-10-03' }), terms: terms(), profile: null, standardPay: 280000, totals: zero, days: [], settings, payMonth, payDate: `${payMonth}-25`, periodEnd: `${payMonth}-20`, law,
  });
  const before = run('2026-10');
  const after = run('2026-11');
  assert.ok(before.lines.some((l) => l.code === 'health'), '9 月分（翌月徴収）は健康保険の被保険者');
  assert.ok(!after.lines.some((l) => l.code === 'health' || l.code === 'child'), '10 月分（誕生日の月）から後期高齢者医療');
  assert.ok(!after.lines.some((l) => l.code === 'pension'));
  assert.ok(after.warnings.some((w) => /75 歳/.test(w)));
});
