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

/** 営業日でない理由の言い方（秘書が候補を出すときに添える）。 */
export const CLOSED_REASON_LABELS: Record<Exclude<ClosedReason, null>, string> = {
  weekday: '営業しない曜日', holiday: '祝日（休み）', closure: '休業（お知らせで出した期間）',
};

/**
 * 期間の中の、会社の営業日でない日（秘書が予定の候補を出すときに避ける。第35.7節。第 0.247.0 版）。
 *
 * @param from 期間の始め（ISO の日時か日付。日本時間の日付で見る）
 * @param to 期間の終わり
 * @returns 日付と理由。多くて 62 日分を見る
 */
export async function closedDaysBetween(
  settings: { businessDays?: number[]; holidaysClosed?: boolean }, from: string, to: string,
  closedOn?: (day: string) => Promise<boolean>,
): Promise<{ date: string; reason: string }[]> {
  const day = (v: string) => new Date(Date.parse(v) + 9 * 3_600_000).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return [];
  const out: { date: string; reason: string }[] = [];
  let d = day(from);
  const end = day(to);
  for (let i = 0; i < 62 && d <= end; i++) {
    const closed = closedOn ? await closedOn(d).catch(() => false) : false;
    const why = closedReason(settings, d, closed);
    if (why) out.push({ date: d, reason: CLOSED_REASON_LABELS[why] });
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
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
