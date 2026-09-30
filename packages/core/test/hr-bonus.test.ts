/**
 * @file 賞与と調整の行の計算の見本（仕様書 第30.11.1節・第30.10.4節）。
 *
 * 国税庁の使用例（扶養 2 人・前月の給与 196,616 円 → 2.042%、468,407 円 × 2.042% = 9,564 円）と、標準賞与額の上限・資格を失う月・
 * 前の月に給与が無いときと 10 倍を超えるときの月額表の計算・調整の行の税と雇用保険の扱いを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type HrEmployee, type HrSettings, type HrTerms, type PayAdjustment } from '@m2office/shared';
import { Law, LAW_BOOK, calcBonus, adjustmentLines, HEALTH_BONUS_CAP } from '../src/index.js';

const law = new Law(LAW_BOOK);
const settings: HrSettings = { ...DEFAULT_HR_SETTINGS, enabled: true, health: { kind: 'kyokai', prefecture: '東京都' } };
const employee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: 'e1', code: '', name: '見本', kana: '', birthDate: '1996-04-01', gender: '', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '', ...over,
});
const terms = { socialInsurance: true, employmentInsurance: true } as HrTerms;
const input = (over: Partial<Parameters<typeof calcBonus>[0]> = {}) => ({
  employee: employee(), terms, profile: null, settings, amount: 500000, payDate: '2026-12-10', longPeriod: false,
  prevTaxable: 250000 as number | null, prevTax: 5000, healthBonusSoFar: 0, law, ...over,
});
const amt = (r: ReturnType<typeof calcBonus>, code: string) => r.lines.find((l) => l.code === code)?.amount;

test('算出率の表: 国税庁の使用例（扶養 2 人・前月 196,616 円 → 2.042%、468,407 円 × 2.042% = 9,564 円）', () => {
  const r = law.bonusRate(196616, 'ko', 2, '2026-12-10');
  assert.equal(r?.value.rate, 2.042);
  assert.equal(Math.floor((468407 * r!.value.rate) / 100), 9564);
  assert.equal(law.bonusRate(285454, 'ko', 3, '2026-12-10')?.value.rate, 2.042, '3 人・285,454 円');
  assert.equal(law.bonusRate(100000, 'otsu', 0, '2026-12-10')?.value.rate, 10.21, '乙欄の最初の行');
  assert.equal(law.bonusRate(100000, 'ko', 12, '2026-12-10')?.value.row.includes('7 人以上'), true, '7 人を超えれば 7 人以上の欄');
  assert.equal(law.bonusRate(100000, 'ko', 0, '2025-12-10'), null, '令和7年分の表は持っていない');
});

test('賞与: 標準賞与額に支払った月の料率を掛け、率の表で所得税を出す。住民税は引かない', () => {
  const r = calcBonus(input());
  assert.equal(amt(r, 'health'), 24625, '500,000 × 9.85% ÷ 2');
  assert.equal(amt(r, 'child'), 575, '500,000 × 0.23% ÷ 2');
  assert.equal(amt(r, 'pension'), 45750, '500,000 × 18.3% ÷ 2');
  assert.equal(amt(r, 'employment'), 2500, '500,000 × 5/1000');
  const base = 500000 - 24625 - 575 - 45750 - 2500;
  const rate = law.bonusRate(250000, 'ko', 0, '2026-12-10')!.value.rate;
  assert.equal(amt(r, 'income-tax'), Math.floor((base * rate) / 100));
  assert.equal(amt(r, 'resident-tax'), undefined);
  assert.equal(r.meta.taxable, base);
  assert.equal(r.meta.stdBonusHealth, 500000);
});

test('賞与: 1,000 円未満の切り捨て・健康保険の年度の累計と厚生年金の 1 か月の上限', () => {
  const r = calcBonus(input({ amount: 2_000_999, healthBonusSoFar: HEALTH_BONUS_CAP - 230_000 }));
  assert.equal(r.meta.stdBonusHealth, 230000, '年度の累計 573 万円まで');
  assert.equal(r.meta.stdBonusPension, 1500000, '1 か月 150 万円まで');
  assert.equal(amt(r, 'pension'), 137250);
});

test('賞与: 資格を失う月（退職日の翌日の月）の賞与には社会保険料をかけない', () => {
  const r = calcBonus(input({ employee: employee({ leftOn: '2026-12-20' }) }));
  assert.equal(amt(r, 'health'), undefined);
  assert.equal(amt(r, 'pension'), undefined);
  assert.ok(r.warnings.some((w) => /資格を失う月/.test(w)));
});

test('賞与: 前の月に給与が無いとき・10 倍を超えるときは月額表を使う', () => {
  const none = calcBonus(input({ prevTaxable: null, prevTax: 0 }));
  const base = none.meta.taxable!;
  assert.equal(amt(none, 'income-tax'), law.withholding(Math.floor(base / 6), 'ko', 0, '2026-12-10')!.value.tax * 6);
  const long = calcBonus(input({ prevTaxable: null, prevTax: 0, longPeriod: true }));
  assert.equal(amt(long, 'income-tax'), law.withholding(Math.floor(base / 12), 'ko', 0, '2026-12-10')!.value.tax * 12);
  const ten = calcBonus(input({ prevTaxable: 40000, prevTax: 0 }));
  assert.ok(base > 400000);
  assert.equal(amt(ten, 'income-tax'), law.withholding(Math.floor(base / 6) + 40000, 'ko', 0, '2026-12-10')!.value.tax * 6);
  assert.ok(ten.warnings.some((w) => /10 倍を超える/.test(w)));
});

test('調整の行: 支給は既定で所得税と雇用保険の対象、控除（立替えの戻しなど）は対象外', () => {
  const adj = (over: Partial<PayAdjustment>): PayAdjustment => ({ id: 'a', employeeId: 'e1', kind: 'monthly', payMonth: '2026-10', label: '調整', direction: 'pay', amount: 10000, taxable: true, insurable: true, reason: '', source: 'manual', ...over });
  const x = adjustmentLines([adj({ id: 'p1' }), adj({ id: 'p2', taxable: false, insurable: false, amount: 3000 }), adj({ id: 'd1', direction: 'deduct', taxable: false, insurable: false, amount: 5000 })]);
  assert.equal(x.pays.length, 2);
  assert.equal(x.deducts.length, 1);
  assert.equal(x.notTaxable, 3000, '対象外の支給だけを外す');
  assert.equal(x.notInsurable, 3000);
  const back = adjustmentLines([adj({ direction: 'deduct', taxable: true, insurable: true, amount: 2000 })]);
  assert.equal(back.notTaxable, 2000, '過払いの戻し（対象の控除）は対象から引く');
});
