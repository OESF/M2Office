/**
 * @file 法令の表: 社会保険と雇用保険の適用の決まり（仕様書 第30.12.1節）。施行日ごとに版を並べ、使う日で選ぶ。
 *
 * AI が日本年金機構・厚生労働省の公式の資料から 2026-09-30 に取り込んだ。**監修前**（第30.27節）。
 *
 * 取り込みのときの注記:
 * - 支払基礎日数: 一般 17 日・特定適用事業所等の短時間労働者 11 日・4 分の 3 以上のパートで 17 日以上の月が無ければ 15 日
 *   （算定基礎届の記入ガイドブック 令和8年度 p.4〜5。https://www.nenkin.go.jp/service/kounen/hokenryo/hoshu/20121017.html）。
 * - 短時間労働者: 週 20 時間以上・学生でない・所定内賃金 8.8 万円以上・特定適用事業所（厚生年金の被保険者 51 人以上）
 *   （https://www.nenkin.go.jp/service/kounen/tekiyo/jigyosho/tanjikan.html）。
 * - 8.8 万円の要件は 2026 年 10 月 1 日に撤廃（機構のページの「令和8年10月に撤廃予定」と、政令案の資料。施行期日の政令の官報の原文は未確認）。
 *   最低賃金の減額の特例を受けて 8.8 万円未満の人は、当分の間は被保険者としない（本表では扱わない）。
 * - 企業規模の要件: 2027 年 10 月から 36 人以上、2029 年 10 月から 21 人以上、2032 年 10 月から 11 人以上、2035 年 10 月に撤廃
 *   （https://www.mhlw.go.jp/content/12500000/001633788.pdf）。
 * - 2 か月以内の期間を定めて使用される人は、見込みで適用する場合を除き対象外（表記が機構のページの間で揺れるため、雇用条件で確かめる）。
 * - 雇用保険: 週 20 時間以上かつ 31 日以上の雇用の見込み（https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/0000147331.html）。
 *   週 10 時間以上への拡大は 2028 年 10 月 1 日（https://www.mhlw.go.jp/content/11600000/001255172.pdf）。
 * - 随時改定は 2 等級以上の差（https://www.nenkin.go.jp/service/kounen/hokenryo/hoshu/20150515-02.html）。
 */

import type { InsuranceRules } from './types.js';

const base: Omit<InsuranceRules, 'version' | 'effectiveFrom'> = {
  source: 'https://www.nenkin.go.jp/service/kounen/tekiyo/jigyosho/tanjikan.html',
  checkedOn: '2026-09-30',
  review: { status: 'unverified' },
  baseDays: { general: 17, shortTime: 11, part: 15 },
  shortTime: { weeklyHours: 20, monthlyWage: 88000, months: 2, officeSize: 51 },
  employment: { weeklyHours: 20, days: 31 },
  changeGrades: 2,
};

const next = (prev: InsuranceRules, version: string, effectiveFrom: string, patch: Partial<InsuranceRules>): InsuranceRules => ({ ...prev, ...patch, version, effectiveFrom });

export const INSURANCE_2026_04: InsuranceRules = { ...base, version: '社会保険と雇用保険の適用 令和8年4月から', effectiveFrom: '2026-04-01' };
export const INSURANCE_2026_10 = next(INSURANCE_2026_04, '社会保険と雇用保険の適用 令和8年10月から（賃金要件の撤廃）', '2026-10-01',
  { shortTime: { ...INSURANCE_2026_04.shortTime, monthlyWage: null } });
export const INSURANCE_2027_10 = next(INSURANCE_2026_10, '社会保険と雇用保険の適用 令和9年10月から（36 人以上）', '2027-10-01',
  { shortTime: { ...INSURANCE_2026_10.shortTime, officeSize: 36 } });
export const INSURANCE_2028_10 = next(INSURANCE_2027_10, '社会保険と雇用保険の適用 令和10年10月から（雇用保険 週 10 時間以上）', '2028-10-01',
  { employment: { weeklyHours: 10, days: 31 }, source: 'https://www.mhlw.go.jp/content/11600000/001255172.pdf' });
export const INSURANCE_2029_10 = next(INSURANCE_2028_10, '社会保険と雇用保険の適用 令和11年10月から（21 人以上）', '2029-10-01',
  { shortTime: { ...INSURANCE_2028_10.shortTime, officeSize: 21 } });
export const INSURANCE_2032_10 = next(INSURANCE_2029_10, '社会保険と雇用保険の適用 令和14年10月から（11 人以上）', '2032-10-01',
  { shortTime: { ...INSURANCE_2029_10.shortTime, officeSize: 11 } });
export const INSURANCE_2035_10 = next(INSURANCE_2032_10, '社会保険と雇用保険の適用 令和17年10月から（企業規模の要件の撤廃）', '2035-10-01',
  { shortTime: { ...INSURANCE_2032_10.shortTime, officeSize: 0 } });

/** 施行日の順の版。 */
export const INSURANCE_RULES: InsuranceRules[] = [INSURANCE_2026_04, INSURANCE_2026_10, INSURANCE_2027_10, INSURANCE_2028_10, INSURANCE_2029_10, INSURANCE_2032_10, INSURANCE_2035_10];
