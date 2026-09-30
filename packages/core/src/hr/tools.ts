/**
 * @file 人事・給与の道具（仕様書 第30.19.1節・第30.20節）。朝のブリーフが労務の期限を読む。
 *
 * 人事区画の人にだけ答える。区画の外の人・人事・給与を切っている会社には「使えない」と返す（H-3）。
 */

import type { HrDeadline } from '@m2office/shared';
import type { Tool } from '../tools/registry.js';

/** 道具が人事・給与を使うための口。 */
export interface HrToolContext {
  /**
   * 依頼者が人事区画に入っていれば、今日から `days` 日の労務の期限を返す。
   *
   * @returns 使えなければ `null`
   */
  deadlines(days: number): Promise<HrDeadline[] | null>;
}

const UNAVAILABLE = { available: false, reason: '人事・給与は使えません（会社で切っているか、人事区画の外です）' };

/**
 * 労務の期限（源泉所得税と住民税の納付・年度更新・算定基礎届・入退社の手続き・契約の満了など）。
 *
 * @remarks 危険度 `read`。推論を使わない決まった計算。人事区画の人にだけ答える
 */
export const hrDeadlines: Tool = {
  name: 'hr.deadlines',
  risk: 'read',
  activityLabel: '労務の期限を調べています',
  helpText: '源泉所得税と住民税の納付、年度更新、算定基礎届、入退社の手続き、契約の満了などの近い期限を調べます。人事の担当者だけが使えます',
  description: '今日から days 日（既定 7、最大 90）の労務の期限を日付の順に返す。過ぎて済んでいない手続きは overdue が true。人事区画の外の人には available: false を返す',
  args: { properties: { days: { type: 'number', description: '何日先までか（既定 7）' } } },
  async invoke(args, ctx) {
    if (!ctx.hr) return UNAVAILABLE;
    const days = Math.min(90, Math.max(1, Math.round(Number(args['days'] ?? 7)) || 7));
    const list = await ctx.hr.deadlines(days);
    if (!list) return UNAVAILABLE;
    return {
      available: true, count: list.length,
      items: list.map((d) => ({ date: d.date, ...(d.from ? { from: d.from } : {}), title: d.title, detail: d.detail, ...(d.overdue ? { overdue: true } : {}) })),
      ...(list.length === 0 ? { note: `${days} 日以内の労務の期限はありません` } : {}),
    };
  },
};

/** 人事・給与の道具。 */
export const HR_TOOLS: Tool[] = [hrDeadlines];
