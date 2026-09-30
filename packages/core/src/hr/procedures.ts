/**
 * @file 入退社の手続きの一覧と期限（仕様書 第30.5.2節）。入社日・退職日と保険の加入から、決まったプログラムで作る。
 *
 * 推論に期限を決めさせない（誤りが届出の遅れに直結するため）。期限は法令の定めで、監修（第30.27節）で確かめる。
 * 日付は日本の暦日（YYYY-MM-DD）で扱い、時差を持ち込まない。
 */

import type { HrCategory, HrSettings } from '@m2office/shared';

/** 作る手続きの 1 つ。 */
export interface ProcedureDraft {
  code: string;
  title: string;
  dueOn: string | null;
}

/** 手続きを決めるのに要る、従業員と雇用条件の要点。 */
export interface ProcedureSubject {
  category: HrCategory;
  hiredOn: string | null;
  leftOn: string | null;
  socialInsurance: boolean;
  employmentInsurance: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

/** 日付に日数を足す。 */
export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

/**
 * 社会保険の届出の「事実のあった日から 5 日以内」の期限（第30.5.2節）。**事実のあった日を 1 日目として 5 日目**。
 *
 * 資格取得届（入社日）・資格喪失届（喪失日 = 退職日の翌日）・70 歳到達届と 75 歳の資格喪失届（到達の日）・賞与支払届（支払日）で数え方をそろえる。
 * 休みの日でも次の平日にずらさない（暦のまま）。
 *
 * @param factDate 事実のあった日（YYYY-MM-DD）
 */
export function withinFiveDays(factDate: string): string {
  return addDays(factDate, 4);
}

/** その月の日（月の日数を超えれば末日）。 */
export function dayOfMonth(year: number, month0: number, day: number): string {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(year, month0, Math.min(day, last))));
}

/** 翌月の同じ日（無ければ末日）。「1 か月以内」の期限に使う。 */
export function addOneMonth(date: string): string {
  const d = parse(date);
  return dayOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** その日の翌月 10 日。 */
export function tenthOfNextMonth(date: string): string {
  const d = parse(date);
  return dayOfMonth(d.getUTCFullYear(), d.getUTCMonth() + 1, 10);
}

/**
 * その日の勤務の分を払う日（会社の締め日・支払日・支払う月から）。
 *
 * @remarks 締め日・支払日の 31 は末日。休日の前後へのずらしは段 3 で扱う
 */
export function payDateFor(date: string, pay: HrSettings['pay']): string {
  const d = parse(date);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  // その日を含む締めの月（締め日を過ぎていれば翌月の締め）
  const closing = parse(dayOfMonth(y, m, pay.closingDay));
  if (d.getTime() > closing.getTime()) m += 1;
  if (pay.payMonth === 'next') m += 1;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return dayOfMonth(y, m, pay.payDay);
}

/**
 * 入社の手続き（第30.5.2節）。
 *
 * @returns 事業主本人・入社日の無い人は空
 */
export function hireProcedures(s: ProcedureSubject, settings: Pick<HrSettings, 'procedures'>): ProcedureDraft[] {
  if (s.category === 'owner' || !s.hiredOn) return [];
  const byExpert = settings.procedures === 'sharoushi' ? '社会保険労務士へ依頼: ' : '';
  const out: ProcedureDraft[] = [{ code: 'terms-notice', title: '労働条件通知書を渡す', dueOn: s.hiredOn }];
  // 入社日（資格取得日）を 1 日目として 5 日目まで
  if (s.socialInsurance) out.push({ code: 'social-acquire', title: `${byExpert}健康保険・厚生年金の資格取得届`, dueOn: withinFiveDays(s.hiredOn) });
  if (s.employmentInsurance) out.push({ code: 'employment-acquire', title: `${byExpert}雇用保険の資格取得届`, dueOn: tenthOfNextMonth(s.hiredOn) });
  out.push({ code: 'dependents', title: '扶養控除等申告書を受け取る', dueOn: addOneMonth(s.hiredOn) });
  out.push({ code: 'resident-transfer', title: '住民税の特別徴収の継続を確かめる（前の勤め先からの異動届）', dueOn: tenthOfNextMonth(s.hiredOn) });
  return out;
}

/**
 * 退職の手続き（第30.5.2節）。
 *
 * @returns 事業主本人・退職日の無い人は空
 */
export function leaveProcedures(s: ProcedureSubject, settings: Pick<HrSettings, 'procedures' | 'pay'>): ProcedureDraft[] {
  if (s.category === 'owner' || !s.leftOn) return [];
  const byExpert = settings.procedures === 'sharoushi' ? '社会保険労務士へ依頼: ' : '';
  const out: ProcedureDraft[] = [];
  // 退職日の翌日（資格喪失日）を 1 日目として数える
  if (s.socialInsurance) out.push({ code: 'social-lose', title: `${byExpert}健康保険・厚生年金の資格喪失届（保険証の回収）`, dueOn: withinFiveDays(addDays(s.leftOn, 1)) });
  if (s.employmentInsurance) out.push({ code: 'employment-lose', title: `${byExpert}雇用保険の資格喪失届・離職証明書`, dueOn: addDays(s.leftOn, 10) });
  out.push({ code: 'resident-change', title: '住民税の異動届出書（一括徴収か普通徴収への切り替え）', dueOn: tenthOfNextMonth(s.leftOn) });
  out.push({ code: 'withholding-slip', title: '源泉徴収票を渡す', dueOn: addOneMonth(s.leftOn) });
  out.push({ code: 'final-pay', title: '最後の給与を払う', dueOn: payDateFor(s.leftOn, settings.pay) });
  return out;
}
