/**
 * @file 労働保険の年度更新の計算の見本（仕様書 第30.13.1節）。厚生労働省「令和8年度 労働保険年度更新申告書の書き方（継続事業用）」の記入例と一致するかを確かめる。
 *
 * 記入例（p.19・p.21・p.27）: 労災 56,765 千円 × 3/1000 と雇用 54,151 千円 × 14.5/1000（確定）・13.5/1000（概算）、一般拠出金、延納の期別の額、
 * 算定基礎額が同じときに合わせた率で計算する例（78,083 千円 × 17.5/1000・16.5/1000）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type HrEmployee, type HrTerms, type LaborInsuranceData, type PaySlip } from '@m2office/shared';
import { Law, LAW_BOOK, perMille, premium, installments, laborMonths, laborCalc, fiscalMonths, type LaborSlip } from '../src/index.js';

const law = new Law(LAW_BOOK);

test('記入例: 算定基礎額が違えば労災と雇用保険をそれぞれ計算して足す（確定 955,484 円・概算 901,333 円・一般拠出金 1,135 円）', () => {
  const c = premium(56765, 54151, 3, 14.5);
  assert.equal(c.workersComp.amount, 170295);
  assert.equal(c.employment.amount, 785189, '785,189.5 → 1 円未満切り捨て');
  assert.equal(c.total, 955484);
  assert.equal(premium(56765, 54151, 3, 13.5).total, 901333);
  assert.equal(perMille(56765, 0.02), 1135, '一般拠出金 1,135.3 → 1,135 円');
});

test('記入例: 算定基礎額が同じなら合わせた率で 1 回だけ計算する（1,366,452 円・1,288,369 円）', () => {
  assert.equal(premium(78083, 78083, 3, 14.5).total, 1366452);
  assert.equal(premium(78083, 78083, 3, 13.5).total, 1288369);
});

test('記入例: 延納は 3 期に分け、1 円未満の端数と確定の不足額・一般拠出金を第 1 期に入れる（328,498 円／300,444 円／300,444 円）。超過は第 1 期から充当する', () => {
  const r = installments(2026, 901333, 26918, 0, 1135, true);
  assert.deepEqual(r.list.map((x) => x.amount), [328498, 300444, 300444]);
  assert.deepEqual(r.list.map((x) => x.due), ['2026-07-10', '2026-11-02', '2027-02-01'], '10 月 31 日は土曜、1 月 31 日は日曜なので次の平日');
  const s = installments(2026, 900000, 0, 350000, 1000, true);
  assert.deepEqual(s.list.map((x) => x.amount), [0, 251000, 300000], '充当は第 1 期（301,000 円）→ 第 2 期（49,000 円）の順');
  assert.equal(installments(2026, 100000, 0, 150000, 0, false).refund, 50000, '充当しきれない分は還付');
});

test('集計: 月の給与は締めの月、賞与は支払った日。役員と同居の親族は労災の対象に入れず、雇用保険は被保険者だけ。足りない月は担当者の合計を使う', () => {
  const emp = (id: string, category: HrEmployee['category']): HrEmployee => ({
    id, code: '', name: id, kana: '', birthDate: '1980-01-01', gender: '', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
    leaveReason: '', employment: 'regular', category, department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '',
  });
  const employees = new Map([['a', emp('a', 'employee')], ['p', emp('p', 'employee')], ['o', emp('o', 'officer')]]);
  const terms = (employmentInsurance: boolean) => ({ employmentInsurance } as HrTerms);
  const slip = (employeeId: string, gross: number, run: LaborSlip['run'], lines: PaySlip['lines'] = []): LaborSlip => ({ slip: { id: `${employeeId}${run.payDate}`, runId: run.payDate, employeeId, gross, deductions: 0, net: gross, lines, warnings: [] }, run });
  const months = fiscalMonths(2025);
  const slips: LaborSlip[] = [];
  for (const m of months.slice(1, 11)) {
    const run = { kind: 'monthly', payDate: `${m}-25`, periodEnd: `${m}-20` };
    slips.push(slip('a', 300000, run), slip('p', 100000, run), slip('o', 500000, run));
  }
  // 臨時の見舞金（雇用保険の賃金に入れない調整の行）は除く
  const march = { kind: 'monthly', payDate: '2026-03-25', periodEnd: '2026-03-20' };
  slips.push(slip('a', 330000, march, [{ code: 'adjust:x', label: '見舞金', amount: 30000, kind: 'pay', basis: { 雇用保険: '入れない' } }]), slip('p', 100000, march));
  slips.push(slip('a', 600000, { kind: 'bonus', payDate: '2025-12-10', periodEnd: '2025-12-10' }));
  const data: LaborInsuranceData = { supplements: { '2025-04': { workers: 2, wages: 400000, insured: 1, insuredWages: 300000 } }, declaredEstimate: 1000000, estimateWages: null };
  const input = {
    law, year: 2026, settings: DEFAULT_HR_SETTINGS.labor, employees, termsAt: (id: string) => terms(id === 'a'), slips, confirmedMonths: new Set(months.slice(1)), data,
  };
  const rows = laborMonths(input);
  const may = rows.find((r) => r.key === '2025-05')!;
  assert.deepEqual([may.workers, may.wages, may.insured, may.insuredWages], [2, 400000, 1, 300000], '役員は入れず、パートは労災だけ');
  assert.equal(rows.find((r) => r.key === '2025-04')!.source, 'manual');
  assert.equal(rows.find((r) => r.key === '2026-03')!.wages, 300000 + 100000, '3 月は a の 330,000 − 見舞金 30,000 ＋ p');
  assert.equal(rows.find((r) => r.key === '2025-12-10')!.insuredWages, 600000, '賞与は支払った日の行');
  const r = laborCalc(input, rows);
  assert.ok('result' in r);
  // 労災 400,000 × 12（3 月の a は見舞金を除いた 300,000）＋ 賞与 600,000 = 5,400,000
  assert.equal(r.result.confirmed.workersComp.base, 5400000);
  assert.equal(r.result.confirmed.employment.base, 3600000 + 600000);
  assert.equal(r.result.confirmed.total, perMille(5400, 3) + perMille(4200, 14.5), '令和7年度の率（その他の各種事業 3・一般 14.5）');
  assert.equal(r.result.estimate.employment.rate, 13.5, '概算は令和8年度の率');
  assert.equal(r.result.workers, 2);
  assert.equal(r.result.insured, 1);
  assert.equal(r.result.installments.length, 1, '概算が 40 万円未満なら延納できない');
  const missing = laborMonths({ ...input, data: { ...data, supplements: {} } });
  assert.ok('error' in laborCalc({ ...input, data: { ...data, supplements: {} } }, missing), '足りない月があれば計算しない');
});
