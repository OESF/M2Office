/**
 * @file 人事・給与の段 4 の決まり（仕様書 第30.10.3節）。点検・振込データ（全銀協の形式）・試しの計算・住民税の通知書の読み取り・秘書の問い。
 *
 * どれも決まったプログラム（推論を使わない部分）を確かめる。振込データはバイトの長さと並びまで確かめる（銀行に上げるファイルのため）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HrEmployee, HrPayrollProfile, HrTerms, PaySlip } from '@m2office/shared';
import {
  buildZenginFile, toZenginKana, reviewRun, explainDiff, parseNoticeReading, noticeProblem, mapTrialHeaders, trialTotals, trialNumber, compareTrialRow,
} from '../src/index.js';
import { payslipRequest } from '../src/secretary/attendance.js';

const slip = (over: Partial<PaySlip> = {}): PaySlip => ({
  id: 's1', runId: 'r1', employeeId: 'e1', employeeName: '山田 花子', gross: 300000, deductions: 60000, net: 240000,
  lines: [
    { code: 'base', label: '基本給', amount: 300000, kind: 'pay', basis: {} },
    { code: 'health', label: '健康保険料', amount: 15000, kind: 'deduct', basis: {} },
    { code: 'resident-tax', label: '住民税', amount: 10000, kind: 'deduct', basis: {} },
  ],
  warnings: [], ...over,
});

const employee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: 'e1', code: 'A1', name: '山田 花子', kana: 'ヤマダ ハナコ', birthDate: '1990-05-01', gender: 'female', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: 'u1', status: 'active', note: '', updatedAt: '', ...over,
});

const profile = (over: Partial<HrPayrollProfile> = {}): HrPayrollProfile => ({
  employeeId: 'e1', taxColumn: 'ko', dependents: 0, residentTax: [], commute: {}, bank: { bankCode: '0001', branchCode: '001', number: '1234567' }, payslipConsentAt: '2026-09-01T00:00:00Z', ...over,
});

const base = () => ({
  payMonth: '2026-10', premiumMonth: '2026-09', slips: [slip()], previous: new Map<string, PaySlip>(), employees: new Map([['e1', employee()]]),
  profiles: new Map([['e1', profile()]]), family: new Map(), terms: new Map<string, HrTerms[]>(), attendanceClosed: true, periodLabel: '2026 年 9 月分', unverified: false,
});

test('全銀: 名前を半角のカナに直し、小さいカナは大きく、使えない字を返す', () => {
  assert.equal(toZenginKana('ヤマダ ハナコ').value, 'ﾔﾏﾀﾞ ﾊﾅｺ');
  assert.equal(toZenginKana('きょうこ').value, 'ｷﾖｳｺ', 'ひらがなと小さいカナ');
  assert.equal(toZenginKana('ｶ)ｴﾑﾂｰ').value, 'ｶ)ｴﾑﾂ-', '半角のカナと長音');
  assert.deepEqual(toZenginKana('山田').bad, ['山', '田']);
});

test('全銀: 総合振込のファイルは 120 バイトの固定長 4 種で、件数と合計が合う', () => {
  const client = { format: 'sogo' as const, clientCode: '1234567890', clientName: 'カ)エムツー', bankCode: '0005', bankName: 'ミツビシUFJ', branchCode: '001', branchName: 'ホンテン', accountType: '普通' as const, accountNumber: '7654321' };
  const r = buildZenginFile(client, '2026-10-23', [
    { bankCode: '0001', branchCode: '100', accountType: '普通', accountNumber: '1234567', holder: 'ヤマダ ハナコ', amount: 240000, customerCode: 'A1' },
    { bankCode: '0009', branchCode: '200', accountType: '当座', accountNumber: '12', holder: 'スズキ タロウ', amount: 1000 },
  ]);
  assert.ok('bytes' in r);
  const lines = new TextDecoder('shift_jis').decode(r.bytes).split('\r\n').filter(Boolean);
  assert.equal(r.bytes.length, 122 * 5, '1 行 120 バイト ＋ CRLF が 5 行');
  assert.deepEqual(lines.map((l) => l[0]), ['1', '2', '2', '8', '9']);
  assert.equal(lines[0]!.slice(1, 3), '21', '種別は総合振込');
  assert.equal(lines[0]!.slice(54, 58), '1023', '振込指定日（MMDD）');
  assert.equal(lines[1]!.slice(80, 90), '0000240000', '振込金額は右寄せのゼロ埋め');
  assert.equal(lines[2]!.slice(42, 43), '2', '当座は 2');
  assert.equal(lines[2]!.slice(43, 50), '0000012', '口座番号は 7 桁');
  assert.equal(lines[3], '8' + '000002' + '000000241000' + ' '.repeat(101), 'トレーラーの件数と合計');
});

test('全銀: 番号の桁が違う・名義に漢字がある振込は作らずに理由を返す（漢字の銀行名は空にする）', () => {
  const client = { format: 'kyuyo' as const, clientCode: '123', clientName: 'エムツー', bankCode: '0005', bankName: '', branchCode: '001', branchName: '', accountType: '普通' as const, accountNumber: '1' };
  const r = buildZenginFile(client, '2026-10-23', [{ bankCode: '1', branchCode: '100', accountType: '普通', accountNumber: '1', holder: '山田', amount: 1 }]);
  assert.ok('problems' in r);
  const text = r.problems.map((p) => p.text).join('|');
  assert.match(text, /委託者コードは 10 桁/);
  assert.match(text, /銀行コードは 4 桁/);
  assert.match(text, /名義に使えない字があります（山田）/);
  const ok = buildZenginFile({ ...client, clientCode: '1234567890' }, '2026-10-23', [{ bankCode: '0001', bankName: 'みずほ銀行', branchCode: '100', branchName: '本店', accountType: '普通', accountNumber: '1', holder: 'ヤマダ', amount: 1 }]);
  assert.ok('bytes' in ok, '漢字の銀行名と支店名では止めない');
  assert.equal(new TextDecoder('shift_jis').decode(ok.bytes).split('\r\n')[1]!.slice(5, 20), ' '.repeat(15), '銀行名は空');
});

test('点検: 勤怠が締まっていない・監修前・マイナスは止め、振込先と同意の無い人は確かめる', () => {
  const checks = reviewRun({
    ...base(), attendanceClosed: false, unverified: true, slips: [slip({ net: -100 })],
    profiles: new Map([['e1', profile({ bank: {}, payslipConsentAt: null })]]),
  });
  const codes = (level: string) => checks.filter((c) => c.level === level).map((c) => c.code).sort();
  assert.deepEqual(codes('stop'), ['negative', 'not-closed', 'unverified']);
  assert.deepEqual(codes('check'), ['no-bank', 'no-consent']);
  assert.equal(reviewRun(base()).length, 0, '揃っていれば何も出さない');
});

test('点検: 前の確定した回との差（1 割以上かつ 5,000 円以上）を、変わった行とともに示す', () => {
  const prev = slip({ net: 250000, lines: [
    { code: 'base', label: '基本給', amount: 300000, kind: 'pay', basis: {} },
    { code: 'health', label: '健康保険料', amount: 15000, kind: 'deduct', basis: {} },
  ] });
  assert.equal(explainDiff(slip(), prev), '住民税 −10,000 円');
  const small = reviewRun({ ...base(), previous: new Map([['e1', prev]]) });
  assert.equal(small.length, 0, '1 万円・4% の差は出さない');
  const big = reviewRun({ ...base(), previous: new Map([['e1', slip({ net: 280000 })]]) });
  assert.match(big[0]!.text, /差引支給が前の回より −40,000 円/);
});

test('点検: 介護保険の始まり・扶養の数の違い（固定的賃金の変動は社会保険の処理が確定した明細から知らせる）', () => {
  const terms = (effectiveOn: string, wageAmount: number): HrTerms => ({
    id: effectiveOn, employeeId: 'e1', effectiveOn, contractStart: null, contractEnd: null, renewal: '', probationUntil: null, weeklyHours: 40, weeklyDays: 5, startTime: '09:00', endTime: '18:00',
    breakMinutes: 60, wageType: 'monthly', wageAmount, allowances: [], workplace: '', work: '', workplaceScope: '', workScope: '', socialInsurance: true, employmentInsurance: true, createdAt: '',
  });
  const checks = reviewRun({
    ...base(), employees: new Map([['e1', employee({ birthDate: '1986-09-15' })]]),
    terms: new Map([['e1', [terms('2024-04-01', 280000), terms('2026-08-01', 300000)]]]),
    family: new Map([['e1', [{ id: 'f', employeeId: 'e1', name: '子', relation: '子', birthDate: '2008-01-01', cohabiting: true, incomeEstimate: 0, dependent: true }]]]),
  });
  assert.deepEqual(checks.map((c) => c.code).sort(), ['care', 'dependents']);
});

test('試しの計算: 見出しを見分け（額の列を時間に当てない）、時間の値と勤怠を読む', async () => {
  const cols = await mapTrialHeaders(['社員番号', '氏名', '残業時間', '残業手当', '健康保険料(介護含む)', '介護保険料', '所得税', '差引支給額', '欠勤日数']);
  assert.deepEqual(cols.map((c) => c.item), ['code', 'name', 'overtimeHours', null, 'health', 'care', 'income-tax', 'net', 'absenceDays']);
  assert.equal(trialNumber('12:30', true), 12.5);
  assert.equal(trialNumber('¥12,345'), 12345);
  assert.equal(trialNumber('▲500'), -500);
  const days = Array.from({ length: 22 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, type: 'workday' as const })) as never;
  const t = trialTotals({ overtimeHours: '10:30', absenceDays: 2 }, days, 480);
  assert.deepEqual([t.overtimeMinutes, t.missingDays, t.workDays, t.over60Minutes], [630, 2, 20, 0]);
  const row = compareTrialRow('山田 花子', 'e1', slip(), { health: 10000, care: 5000, net: 240100 }, new Set(['health', 'care', 'net'] as const));
  assert.deepEqual(row.items.map((i) => [i.label, i.diff]), [['健康保険料', 0], ['差引支給', -100]], '健康保険は介護を足して比べる');
});

test('住民税の通知書: 6 月分 ＋ 月額 × 11 が年税額と合わないものは入れない', () => {
  const r = parseNoticeReading('```json\n{"isNotice": true, "entries": [{"name": "山田 花子", "fiscalYear": 2026, "june": 18300, "monthly": 18000, "annual": 216300}, {"name": "鈴木", "fiscalYear": "2026", "june": 1, "monthly": 1, "annual": 99}]}\n```');
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(noticeProblem(r.entries[0]!), null);
  assert.match(noticeProblem(r.entries[1]!) ?? '', /年税額 99 円と合いません/);
  assert.deepEqual(parseNoticeReading('{"isNotice": false}'), { status: 'not-notice' });
});

test('秘書: 本人の明細の問いを見分け、計算や決まりの問いは当てない', () => {
  for (const m of ['今月の給与明細を見せて', '手取りが減ったのはなぜ？', '先月の給料はいくら？', '給与明細']) assert.equal(payslipRequest(m), true, m);
  for (const m of ['今月の給与を計算して', '給与の締め日は？', '手取りの計算方法を教えて', '明日の予定']) assert.equal(payslipRequest(m), false, m);
});
