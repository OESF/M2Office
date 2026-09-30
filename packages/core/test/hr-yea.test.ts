/**
 * @file 年末調整の計算の見本（仕様書 第30.15.1節）。国税庁「令和8年分 年末調整のしかた」の表・設例・計算式と一致するかを確かめる。
 *
 * 給与所得控除後の金額（表と算式）・所得金額調整控除・基礎控除（令和8年度改正の後）・配偶者特別控除・特定親族特別控除・
 * 23 歳未満の扶養親族がいる人の生命保険料控除の特例・課税給与所得金額と算出所得税額（設例 117,100 円）・年調年税額。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HrEmployee, YeaDeclaration } from '@m2office/shared';
import { Law, LAW_BOOK, calcYea, declarationProblems } from '../src/index.js';
import { employmentIncome, stepFormula, ageAtLeast } from '../src/hr/yea-calc.js';

const law = new Law(LAW_BOOK);
const r = law.yeaRules(2026)!;
const employee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: 'e1', code: '', name: '見本', kana: '', birthDate: '1980-01-01', gender: '', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '', ...over,
});
const decl = (over: Partial<YeaDeclaration> = {}): YeaDeclaration => ({
  year: 2026, self: { otherIncome: 0, disability: 'none', widow: 'none', workingStudent: false }, spouse: null, dependents: [],
  insurance: { lifeNewGeneral: 0, lifeOldGeneral: 0, lifeNewCare: 0, lifeNewPension: 0, lifeOldPension: 0, earthquake: 0, oldLongTerm: 0, social: 0, smallBusiness: 0 },
  housingCredit: 0, previousJob: null, ...over,
});
const run = (d: YeaDeclaration, payHere: number, socialHere = 0, withheldHere = 0) => {
  const x = calcYea({ law, year: 2026, employee: employee(), declaration: d, payHere, socialHere, withheldHere });
  assert.ok('result' in x, 'error' in x ? x.error : '');
  return x.result;
};
const child = { name: '子', relation: '子', birthDate: '2015-06-01', incomeEstimate: 0, disability: 'none' as const, cohabiting: true };

test('給与所得控除後の金額: 最低保障 74 万円・表の特例値・表・算式（国税庁の例 7,654,321 円 → 5,788,888 円）', () => {
  assert.equal(employmentIncome(r, 740999), 0);
  assert.equal(employmentIncome(r, 1500000), 760000, '741,000 円以上 2,191,000 円未満は 収入 − 740,000');
  assert.equal(employmentIncome(r, 2191000), 1451000);
  assert.equal(employmentIncome(r, 2199999), 1456000);
  assert.equal(employmentIncome(r, 2200000), 1460000);
  assert.equal(employmentIncome(r, 7654321), 5788888);
  assert.equal(employmentIncome(r, 8970000), 7020000);
});

test('設例: 給与 8,970,000 円・23 歳未満の扶養親族 → 所得金額調整控除 47,000 円 → 調整控除後 6,973,000 円 → 課税 2,146,000 円 → 算出所得税額 117,100 円', () => {
  // 所得控除の合計を設例と同じ 4,826,102 円にする（基礎控除 62 万円 ＋ 社会保険料等 4,206,102 円。16 歳未満の子は扶養控除 0 円）
  const x = run(decl({ dependents: [child] }), 8970000, 4206102, 200000);
  assert.equal(x.incomeAdjustment, 47000);
  assert.equal(x.afterDeduction, 6973000);
  assert.equal(x.deductions.basic, 620000, '合計所得 655 万円超は 62 万円');
  assert.equal(x.deductionTotal, 4826102);
  assert.equal(x.taxable, 2146000);
  assert.equal(x.calculatedTax, 117100);
  assert.equal(x.annualTax, 119500, '117,100 × 102.1% = 119,559 → 100 円未満切り捨て');
  assert.equal(x.difference, 200000 - 119500);
  assert.equal(x.counts.under16, 1);
});

test('基礎控除（令和8年度改正の後）と、住宅借入金等特別控除は算出所得税額までで年調年税額を 0 にする', () => {
  const x = run(decl({ housingCredit: 1_000_000 }), 4000000, 600000, 80000);
  assert.equal(x.deductions.basic, 1040000, '合計所得 489 万円以下は 104 万円');
  assert.equal(x.annualTax, 0);
  assert.equal(x.housingCredit, x.calculatedTax);
  assert.equal(x.difference, 80000);
});

test('配偶者控除・配偶者特別控除・特定親族特別控除・扶養控除の年齢', () => {
  const x = run(decl({
    spouse: { name: '配偶者', relation: '妻', birthDate: '1982-01-01', incomeEstimate: 1000000, disability: 'none', cohabiting: true },
    dependents: [
      { name: '大学生', relation: '子', birthDate: '2006-05-01', incomeEstimate: 0, disability: 'none', cohabiting: true },
      { name: '働く学生', relation: '子', birthDate: '2005-05-01', incomeEstimate: 1000000, disability: 'none', cohabiting: true },
      { name: '高校生', relation: '子', birthDate: '2009-05-01', incomeEstimate: 0, disability: 'none', cohabiting: true },
      { name: '父', relation: '父', birthDate: '1950-03-01', incomeEstimate: 0, disability: 'special-cohabiting', cohabiting: true },
    ],
  }), 6000000);
  assert.equal(x.deductions.spouseSpecial, 360000, '配偶者 95 万円超 100 万円以下・本人 900 万円以下');
  assert.equal(x.deductions.specificRelative, 410000, '95 万円超 100 万円以下');
  assert.equal(x.deductions.dependents, 630000 + 380000 + 580000, '特定・一般・同居老親等');
  assert.equal(x.deductions.disability, 750000, '同居特別障害者');
  assert.deepEqual([x.counts.specific, x.counts.general, x.counts.elderly, x.counts.elderlyCohabiting, x.counts.specificRelative], [1, 1, 1, 1, 1]);
  assert.equal(ageAtLeast('2011-01-01', 2026, 16), true, '平成23年1月1日生まれは 16 歳以上');
  assert.equal(ageAtLeast('2011-01-02', 2026, 16), false);
});

test('生命保険料控除: 計算式 I・II・III と、23 歳未満の扶養親族がいる人の一般の上限 6 万円・合計 12 万円', () => {
  assert.equal(stepFormula(r.life.formulaI, 100000), 40000);
  assert.equal(stepFormula(r.life.formulaII, 100000), 55000);
  assert.equal(stepFormula(r.life.formulaIII, 30001), 27501, '1 円未満は切り上げ');
  const ins = { lifeNewGeneral: 100000, lifeOldGeneral: 100000, lifeNewCare: 100000, lifeNewPension: 100000, lifeOldPension: 0, earthquake: 60000, oldLongTerm: 30000, social: 0, smallBusiness: 0 };
  const without = run(decl({ insurance: ins }), 5000000);
  assert.equal(without.deductions.life, 120000, '一般 50,000 ＋ 介護医療 40,000 ＋ 個人年金 40,000 → 上限 12 万円');
  const withChild = run(decl({ insurance: { ...ins, lifeNewCare: 0, lifeNewPension: 0 }, dependents: [child] }), 5000000);
  assert.equal(withChild.deductions.life, 60000, '新 55,000 ＋ 旧 50,000 → 上限 6 万円');
  assert.equal(without.deductions.earthquake, 50000, '地震保険料と旧長期の合計は 5 万円まで');
});

test('不備: 扶養親族の所得の見積もりが要件を超える・生年月日が無い・年の途中の入社で前の勤め先の額が無い', () => {
  const p = declarationProblems(law, 2026, employee({ hiredOn: '2026-06-01' }), decl({
    dependents: [{ name: '甲', relation: '子', birthDate: '2000-01-01', incomeEstimate: 800000, disability: 'none', cohabiting: true }, { name: '乙', relation: '子', birthDate: null, incomeEstimate: 0, disability: 'none', cohabiting: true }],
  }), 3000000);
  assert.equal(p.length, 3);
  assert.match(p[0]!, /甲さんの所得の見積もり/);
  assert.match(p[1]!, /乙さんの生年月日/);
  assert.match(p[2]!, /前の勤め先/);
});
