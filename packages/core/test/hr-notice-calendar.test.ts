/**
 * @file 労働条件通知書と労務カレンダー（仕様書 第30.5.3節・第30.19.1節）。
 *
 * 通知書が法定の明示事項を満たすか（足りない事項を挙げるか）と、期限が決まったプログラムで正しい日になるか（休日の繰り下げを含む）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HR_SETTINGS, type HrEmployee, type HrSettings, type HrTerms } from '@m2office/shared';
import { buildTermsNotice, renderTermsNoticePdf, buildDeadlines, nextBusinessDay, hrDeadlines } from '../src/index.js';

const employee = (over: Partial<HrEmployee> = {}): HrEmployee => ({
  id: 'e1', code: '', name: '山田 花子', kana: '', birthDate: null, gender: '', address: '', phone: '', email: '', hiredOn: '2026-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '', ...over,
});
const terms = (over: Partial<HrTerms> = {}): HrTerms => ({
  id: 't', employeeId: 'e1', effectiveOn: '2026-04-01', contractStart: null, contractEnd: null, renewal: '', renewalLimit: '', probationUntil: null,
  weeklyHours: 40, weeklyDays: 5, startTime: '09:00', endTime: '18:00', breakMinutes: 60, wageType: 'monthly', wageAmount: 250000, allowances: [],
  workplace: '本社', work: '事務', workplaceScope: '会社の定める場所', workScope: '会社の定める業務', socialInsurance: true, employmentInsurance: true, createdAt: '', ...over,
});
const settings = (over: Partial<HrSettings> = {}): HrSettings => ({ ...DEFAULT_HR_SETTINGS, enabled: true, office: { name: '株式会社見本', address: '東京都', form: 'corporation' }, ...over });
const texts = { raise: '', bonus: '', severance: '', retirement: '定年 60 歳', consultation: '', other: '' };

test('通知書: 正社員は退職に関する事項まで揃えば足りない事項が無い。変更の範囲と割増率・締め日を載せる', async () => {
  const doc = buildTermsNotice({ employee: employee(), terms: terms(), settings: settings(), notice: texts, company: '株式会社見本', issuedOn: '2026-09-30' });
  assert.deepEqual(doc.missing, []);
  const v = (label: string) => doc.items.find((i) => i.label === label)?.value;
  assert.equal(v('契約期間'), '期間の定めなし');
  assert.equal(v('就業の場所の変更の範囲'), '会社の定める場所');
  assert.equal(v('休日'), '毎週 日・土曜日、国民の祝日、法定休日は 日曜日');
  assert.match(v('所定時間外・休日・深夜の割増賃金率') ?? '', /法定時間外 25%（月 60 時間を超える分 50%）/);
  assert.equal(v('賃金の締切日・支払日'), '毎月 末日締め、翌月 25 日支払');
  const pdf = await renderTermsNoticePdf(doc);
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-');
});

test('通知書: 有期のパートは更新の基準と上限・昇給・賞与・退職手当・相談の窓口を求め、5 年を超えれば無期転換を示す', () => {
  const doc = buildTermsNotice({
    employee: employee({ employment: 'part', hiredOn: '2020-04-01' }), terms: terms({ contractEnd: '2026-03-31', workScope: '' }),
    settings: settings(), notice: texts, company: '', issuedOn: '2026-09-30',
  });
  assert.deepEqual(doc.missing, ['契約の更新の有無と判断の基準', '更新の上限（通算の契約期間か更新の回数）', '従事すべき業務の変更の範囲', '昇給', '賞与', '退職手当', '雇用管理の改善等に関する相談窓口']);
  assert.match(doc.notes[0] ?? '', /無期転換/);
});

test('カレンダー: 納付の期限は休日なら次の平日（年末年始を含む）', () => {
  assert.equal(nextBusinessDay('2026-10-10'), '2026-10-13', '10 日は土曜、12 日はスポーツの日');
  assert.equal(nextBusinessDay('2027-01-01'), '2027-01-04', '年始');
  assert.equal(nextBusinessDay('2026-11-10'), '2026-11-10');
});

test('カレンダー: 源泉所得税・住民税の月ごとの納付、確定した給与の集計、年度更新と算定基礎届', () => {
  const list = buildDeadlines({
    today: '2026-05-25', days: 60, settings: settings(), employees: [employee()], terms: new Map([['e1', terms()]]), tasks: [], obligations: [],
    payments: [{ month: '2026-05', people: 3, gross: 900000, tax: 18000, resident: 30000 }],
  });
  const find = (t: RegExp) => list.find((d) => t.test(d.title));
  assert.equal(find(/源泉所得税の納付（5 月支払分）/)?.date, '2026-06-10');
  assert.match(find(/源泉所得税の納付（5 月支払分）/)?.detail ?? '', /人員 3 人・支給額 900,000 円・税額 18,000 円/);
  assert.match(find(/住民税の納付（5 月に引いた分）/)?.detail ?? '', /30,000 円/);
  assert.equal(find(/労働保険の年度更新/)?.date, '2026-07-10');
  assert.equal(find(/算定基礎届/)?.from, '2026-07-01');
  assert.equal(find(/住民税の決定通知書/)?.date, '2026-05-31');
});

test('カレンダー: 納期の特例・36 協定・健康診断・契約の満了・過ぎた手続き', () => {
  const s = settings({ duties: { withholdingSpecial: true, residentSpecial: true, healthCheckMonth: 10 } });
  const list = buildDeadlines({
    today: '2026-09-30', days: 130, settings: s, employees: [employee()], terms: new Map([['e1', terms({ contractEnd: '2026-12-31' })]]),
    tasks: [{ id: 'k', employeeId: 'e1', employeeName: '山田 花子', kind: 'hire', code: 'x', title: '雇用保険の資格取得届', dueOn: '2026-09-10', doneAt: null, doneBy: null },
      { id: 'k2', employeeId: 'e1', employeeName: '山田 花子', kind: 'hire', code: 'y', title: '扶養控除等申告書を受け取る', dueOn: '2026-10-05', doneAt: null, doneBy: null }],
    obligations: [], payments: [],
  });
  assert.equal(list[0]!.overdue, true, '過ぎた手続きが先頭');
  const rest = list.slice(1).map((d) => d.date);
  assert.deepEqual(rest, [...rest].sort(), 'あとは日付の順（手続きも混ぜて並べる）');
  const titles = list.map((d) => d.title);
  assert.ok(titles.includes('住民税の納付（2026 年 6〜11 月分・納期の特例）'));
  assert.ok(!titles.some((t) => /源泉所得税の納付（\d+ 月支払分）/.test(t)), '特例なら月ごとには出さない');
  assert.equal(list.find((d) => d.kind === 'health-check')?.date, '2026-10-01');
  assert.equal(list.find((d) => /更新しないなら予告/.test(d.title))?.date, '2026-12-01');
  assert.equal(list.find((d) => /給与支払報告書/.test(d.title))?.date, '2027-02-01', '1 月 31 日は日曜');
});

test('ツール hr.deadlines: 人事区画の外の人には「使えない」と返す', async () => {
  const ctx = { tenantId: 't', userId: 'u', hr: { deadlines: async () => null } } as never;
  assert.deepEqual(await hrDeadlines.invoke({}, ctx), { available: false, reason: '人事・給与は使えません（会社で切っているか、人事区画の外です）' });
  const ok = await hrDeadlines.invoke({ days: 3 }, { tenantId: 't', userId: 'u', hr: { deadlines: async (d: number) => [{ date: '2026-10-13', kind: 'withholding', title: `期限 ${d}`, detail: '' }] } } as never) as { items: { title: string }[] };
  assert.equal(ok.items[0]!.title, '期限 3');
});
