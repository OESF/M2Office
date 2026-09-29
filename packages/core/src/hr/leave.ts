/**
 * @file 年次有給休暇の付与・残り・取得義務（仕様書 第30.7.1節）。決まったプログラムで出す。
 *
 * 付与は入社日から 6 か月で 10 日、以後 1 年ごと（6 年 6 か月以上は 20 日）。週 30 時間未満で週 4 日以下の人は比例付与。
 * 付与の日から 2 年で時効。古い付与から使う。10 日以上の付与は、付与の日から 1 年以内に 5 日を取る義務がある。
 */

import type { LeaveBalance, LeaveGrant, LeaveTake } from '@m2office/shared';

/** 通常の付与の日数（6 か月・1 年 6 か月・…・6 年 6 か月以上）。 */
export const LEAVE_NORMAL = [10, 11, 12, 14, 16, 18, 20];
/** 比例付与の日数（週の所定労働日数ごと）。 */
export const LEAVE_PROPORTIONAL: Record<number, number[]> = {
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
};
/** 取得義務の日数。 */
export const LEAVE_OBLIGATION_DAYS = 5;

/** 月を足す（同じ日。無ければ月末）。 */
export function addMonths(date: string, months: number): string {
  // 1 か月ずつ足すと月末でずれるため、元の日付から直接求める
  const [y, m, day] = date.split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(day, last))).toISOString().slice(0, 10);
}

/**
 * 付与の日数（何回目の付与か・週の所定）。
 *
 * @param index 0 が入社から 6 か月の付与
 */
export function grantDays(index: number, weeklyDays: number | null, weeklyHours: number | null): number {
  const i = Math.min(index, 6);
  const proportional = weeklyDays !== null && weeklyDays <= 4 && (weeklyHours === null || weeklyHours < 30);
  if (proportional) {
    const row = LEAVE_PROPORTIONAL[Math.max(1, Math.floor(weeklyDays!))];
    return row ? row[i]! : 0;
  }
  return LEAVE_NORMAL[i]!;
}

/**
 * 今日までに来た付与の日（入社日から 6 か月、以後 1 年ごと）。
 *
 * @returns 付与の日と、何回目か（0 始まり）
 */
export function dueGrantDates(hiredOn: string, today: string, leftOn: string | null = null): { date: string; index: number }[] {
  const out: { date: string; index: number }[] = [];
  for (let i = 0; i < 60; i++) {
    const date = addMonths(hiredOn, 6 + 12 * i);
    if (date > today || (leftOn && date > leftOn)) break;
    out.push({ date, index: i });
  }
  return out;
}

/**
 * 残りと取得義務。取った日を古い順に、その日に使える最も古い付与から引く。
 */
export function leaveBalance(grants: LeaveGrant[], takes: LeaveTake[], today: string): LeaveBalance {
  const gs = [...grants].sort((a, b) => a.grantedOn.localeCompare(b.grantedOn)).map((g) => ({ ...g, used: 0, left: g.days }));
  for (const t of [...takes].filter((x) => x.status === 'taken').sort((a, b) => a.date.localeCompare(b.date))) {
    let need = t.days;
    for (const g of gs) {
      if (need <= 0) break;
      if (g.grantedOn > t.date || g.expiresOn <= t.date || g.left <= 0) continue;
      const use = Math.min(g.left, need);
      g.used += use;
      g.left -= use;
      need -= use;
    }
  }
  const valid = gs.filter((g) => g.grantedOn <= today && g.expiresOn > today);
  const remaining = Math.round(valid.reduce((s, g) => s + g.left, 0) * 10) / 10;
  // 取得義務: 10 日以上の付与のうち、付与の日から 1 年がまだ来ていない最も新しいもの
  const target = [...gs].reverse().find((g) => g.days >= 10 && g.grantedOn <= today && addMonths(g.grantedOn, 12) > today);
  let obligation: LeaveBalance['obligation'] = null;
  if (target) {
    const end = addMonths(target.grantedOn, 12);
    const taken = takes.filter((t) => t.status === 'taken' && t.date >= target.grantedOn && t.date < end).reduce((s, t) => s + t.days, 0);
    const deadline = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    obligation = { grantedOn: target.grantedOn, deadline, taken, required: LEAVE_OBLIGATION_DAYS };
  }
  return { remaining, grants: gs, obligation };
}
