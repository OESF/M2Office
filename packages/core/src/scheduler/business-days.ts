/**
 * @file 会社の営業日（仕様書 第6.6.1節・第9.5.5.1節・第35.7節。第 0.243.0 版）。
 *
 * 会社情報の営業する曜日と「祝日を休みにする」、お知らせの作成で出した休業の期間から、その日が営業日かを決める。
 * 朝のブリーフなど「会社の営業日」の定時実行は、営業日でない日には動かない（土日に営業する店・年中無休の会社にも合わせる）。
 */

import type { Repository } from '../repository/types.js';
import { isJapaneseHoliday } from '../hr/holidays.js';

/** 営業日かを決めるのに使うもの。 */
export interface BusinessDayDeps {
  repo: Repository;
  /** その日が休業の期間（お知らせで出したもの）に入るか。無ければ休業の期間は見ない */
  closedOn?(tenantId: string, day: string): Promise<boolean>;
}

/** 営業日でない理由（営業日なら `null`）。 */
export type ClosedReason = 'weekday' | 'holiday' | 'closure' | null;

/**
 * その日（YYYY-MM-DD）が会社の営業日でない理由を返す。
 *
 * @param settings 会社情報の営業する曜日と祝日の扱い
 * @param closed その日が休業の期間に入るか
 */
export function closedReason(settings: { businessDays?: number[]; holidaysClosed?: boolean }, day: string, closed: boolean): ClosedReason {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  // 古い設定（営業日が無い）は月〜金
  const days = Array.isArray(settings.businessDays) && settings.businessDays.length ? settings.businessDays : [1, 2, 3, 4, 5];
  if (!days.includes(weekday)) return 'weekday';
  if ((settings.holidaysClosed ?? true) && isJapaneseHoliday(day)) return 'holiday';
  if (closed) return 'closure';
  return null;
}

/**
 * その日が会社の営業日かを確かめる関数を作る（定時実行が使う）。
 */
export function businessDayChecker(deps: BusinessDayDeps) {
  return async (tenantId: string, day: string): Promise<boolean> => {
    const settings = await deps.repo.getTenantSettings(tenantId);
    const closed = deps.closedOn ? await deps.closedOn(tenantId, day).catch(() => false) : false;
    return closedReason(settings.company, day, closed) === null;
  };
}
