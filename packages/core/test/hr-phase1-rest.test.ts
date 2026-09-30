/**
 * @file 人事・給与の Phase 1 の残り（仕様書 第30.8.2節・第30.18.1節・第30.20.1節）。
 *
 * 法令の表の見張り（更新待ちと変わり目）、秘書から担当者の仕事を頼む言い方、規程から作る設定の案の確かめを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type HrSettings } from '@m2office/shared';
import { Law, LAW_BOOK, parseProposal } from '../src/index.js';
import { hrStaffRequest } from '../src/secretary/hr-staff.js';

const law = new Law(LAW_BOOK);

test('法令の表: 毎年変わる表が時期を過ぎても入っていなければ「更新待ち」とする', () => {
  assert.deepEqual(law.staleAt('2026-10'), [], '令和8年度・令和8年分は入っている');
  const stale = law.staleAt('2027-04').map((x) => `${x.label}:${x.expectedFrom}`);
  assert.deepEqual(stale, [
    '協会けんぽの健康保険料率:2027-03', '介護保険料率:2027-03', '子ども・子育て支援金率:2027-04', '雇用保険料率:2027-04', '源泉徴収税額表（月額表）:2027-01',
  ]);
  assert.deepEqual(law.staleAt('2027-02').map((x) => x.label), ['源泉徴収税額表（月額表）'], '2 月は税額表だけ');
});

test('法令の表: これから効く版を、会社の都道府県の新旧の率とともに挙げる', () => {
  const next = new Law({ ...LAW_BOOK, health: [...LAW_BOOK.health, { ...LAW_BOOK.health[0]!, version: '協会けんぽ 令和9年度', effectiveFrom: '2027-03', prefectures: { ...LAW_BOOK.health[0]!.prefectures, 東京都: 9.91 } }] });
  const list = next.changesBetween('2027-01-01', '2027-03-31', '東京都');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.detail, '東京都 9.85% → 9.91%');
  assert.equal(list[0]!.applies, '2027 年 3 月分の保険料から');
  assert.deepEqual(next.staleAt('2027-03').map((x) => x.label).includes('協会けんぽの健康保険料率'), false);
});

test('秘書: 人事の担当者の依頼を見分ける（月・名前）。方法の問いは当てない', () => {
  const today = '2026-09-30';
  assert.deepEqual(hrStaffRequest('今月の給与を計算して', today), { kind: 'calculate', month: '2026-09' });
  assert.deepEqual(hrStaffRequest('来月の給与を計算して', today), { kind: 'calculate', month: '2026-10' });
  assert.deepEqual(hrStaffRequest('11月の給料を計算してください', today), { kind: 'calculate', month: '2026-11' });
  assert.deepEqual(hrStaffRequest('山田さんの労働条件通知書を作って', today), { kind: 'notice', name: '山田' });
  assert.deepEqual(hrStaffRequest('労務の期限は？', today), { kind: 'deadlines' });
  assert.deepEqual(hrStaffRequest('源泉の納付の期限を教えて', today), { kind: 'deadlines' });
  for (const m of ['給与の計算方法を教えて', '今月の給与明細を見せて', '明日の予定', '労働条件通知書とは']) assert.equal(hrStaffRequest(m, today), null, m);
});

test('規程から設定の案: 書かれた項目だけを案にし、法定の下限を下回る割増率は採らない。手当の扱いは名前から決める', () => {
  const current: HrSettings = { ...DEFAULT_HR_SETTINGS };
  const fields = parseProposal(JSON.stringify({
    closingDay: { value: 20, quote: '賃金は毎月 20 日に締め' }, payDay: { value: '末日', quote: '当月末日に支払う' }, payMonth: { value: 'same', quote: '当月末日に支払う' },
    workdays: { value: [1, 2, 3, 4, 5], quote: '月曜日から金曜日' }, overtime: { value: 20, quote: '時間外は 20% 増し' }, holiday: { value: 35, quote: '休日は 35%' },
    halfDay: { value: true, quote: '半日単位で取得できる' }, allowances: { value: ['役職手当', '家族手当'], quote: '手当は役職手当・家族手当とする' },
    retirement: { value: '定年は 60 歳', quote: '定年は満 60 歳' },
  }), current);
  const by = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(by['pay.closingDay']!.value, 20);
  assert.equal(by['pay.payDay']!.problem, '1〜31 日の範囲の外です', '「末日」を数にできなければ採らない');
  assert.equal(by['payroll.premiums.overtime']!.problem, '法定の下限（25%）を下回るか、読めませんでした');
  assert.equal(by['payroll.premiums.holiday']!.problem, undefined);
  assert.deepEqual(by['payroll.items']!.value, [{ name: '役職手当', premiumBase: true, taxable: true }, { name: '家族手当', premiumBase: false, taxable: true }]);
  assert.equal(by['notice.retirement']!.value, '定年は 60 歳');
  assert.equal(by['payroll.premiums.night'], undefined, '書かれていない項目は案にしない');
  assert.deepEqual(parseProposal('読めませんでした', current), []);
});
