/**
 * @file 朝のブリーフと週次ブリーフの定時実行を、秘書が本人ごとに自動で用意する（仕様書 第9.5.5.1節・第9.5.5節、ADR-0034・ADR-0048）。
 *
 * 画面を開いたとき（`GET /v1/me`）に呼ぶ。設定しなくても毎朝届くようにする（原則 p4）。
 */

import { randomUUID } from 'node:crypto';
import { AG05_WEEKLY_BRIEF, MORNING_BRIEF, describeRule, nextRunAt } from '@m2office/core';
import type { Schedule, ScheduleRule } from '@m2office/shared';
import type { AppDeps } from '../context.js';

/** 朝のブリーフの既定の時刻（会社の営業日の 7:30。本人の地域の時刻。第 0.243.0 版で「毎平日」から改めた）。 */
export const MORNING_BRIEF_RULE: ScheduleRule = { kind: 'business', hour: 7, minute: 30 };

/** 週次ブリーフの既定の時刻（月曜 7:00。朝のブリーフより先に届く。ADR-0048）。 */
export const WEEKLY_BRIEF_RULE: ScheduleRule = { kind: 'weekly', weekday: 1, hour: 7, minute: 0 };

/**
 * まだ用意していなければ、朝のブリーフの定時実行を用意する。
 *
 * @returns 用意した定時実行。用意しなかったときは `null`
 *
 * @remarks
 * - **一度用意したら作り直さない**（本人が止めたり消したりしたものを、勝手に戻さない）。用意したことは個人設定に残す
 * - 秘書の積極性が「控えめ」の人、朝のブリーフを使えない人（利用範囲の外・会社が無効にした）には用意しない
 * - すでに同じ業務の定時実行を自分で作っていれば、用意したことだけを記録する
 */
export async function ensureMorningBrief(deps: AppDeps, tenantId: string, userId: string, now: Date = new Date()): Promise<Schedule | null> {
  const prefs = await deps.repo.getUserSettings(tenantId, userId);
  if (prefs.onboarding.morningBriefAt) return null;
  if (prefs.secretary.proactivity === 'low') return null;
  const settings = await deps.repo.getTenantSettings(tenantId);
  if (settings.agents.disabled.includes(MORNING_BRIEF.id)) return null;
  if (!(await deps.canUse(tenantId, userId, MORNING_BRIEF.id))) return null;
  // 先に記録を取る。同時に開いた 2 つの画面から二重に用意しないため（取れなかった側は何もしない）
  const mark = now.toISOString();
  await deps.repo.saveUserSettings(tenantId, userId, 'onboarding', { ...prefs.onboarding, morningBriefAt: mark });
  const again = await deps.repo.getUserSettings(tenantId, userId);
  if (again.onboarding.morningBriefAt !== mark) return null;
  const mine = await deps.repo.listSchedules(tenantId, userId);
  if (mine.some((s) => s.agentId === MORNING_BRIEF.id)) return null;
  const timezone = prefs.profile.timezone || 'Asia/Tokyo';
  const schedule: Schedule = {
    id: randomUUID(), tenantId, userId, agentId: MORNING_BRIEF.id, agentVersion: MORNING_BRIEF.version,
    input: {}, rule: MORNING_BRIEF_RULE, timezone, enabled: true,
    nextRunAt: nextRunAt(MORNING_BRIEF_RULE, timezone, now), lastRunAt: null,
    createdBy: userId, createdAt: mark,
  };
  await deps.repo.createSchedule(schedule);
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'secretary', actorId: userId, action: 'schedule.create',
    targetType: 'schedule', targetId: schedule.id,
    detail: { agentId: MORNING_BRIEF.id, rule: describeRule(MORNING_BRIEF_RULE), automatic: true }, occurredAt: mark,
  });
  return schedule;
}

/**
 * まだ用意していなければ、週次ブリーフの定時実行を用意する（仕様書 第9.5.5節、ADR-0048）。
 *
 * @returns 用意した定時実行。用意しなかったときは `null`
 *
 * @remarks
 * 朝のブリーフ（{@link ensureMorningBrief}）と同じ決まりで用意する。一度用意したら作り直さない。
 * 秘書の積極性が「控えめ」の人、週次ブリーフを使えない人には用意しない。
 * すでに週次ブリーフの定時実行を自分で作っていれば（以前は本人が登録していた）、用意したことだけを記録する。
 */
export async function ensureWeeklyBrief(deps: AppDeps, tenantId: string, userId: string, now: Date = new Date()): Promise<Schedule | null> {
  const prefs = await deps.repo.getUserSettings(tenantId, userId);
  if (prefs.onboarding.weeklyBriefAt) return null;
  if (prefs.secretary.proactivity === 'low') return null;
  const settings = await deps.repo.getTenantSettings(tenantId);
  if (settings.agents.disabled.includes(AG05_WEEKLY_BRIEF.id)) return null;
  if (!(await deps.canUse(tenantId, userId, AG05_WEEKLY_BRIEF.id))) return null;
  // 先に記録を取る。同時に開いた 2 つの画面から二重に用意しないため（取れなかった側は何もしない）
  const mark = now.toISOString();
  await deps.repo.saveUserSettings(tenantId, userId, 'onboarding', { ...prefs.onboarding, weeklyBriefAt: mark });
  const again = await deps.repo.getUserSettings(tenantId, userId);
  if (again.onboarding.weeklyBriefAt !== mark) return null;
  const mine = await deps.repo.listSchedules(tenantId, userId);
  if (mine.some((s) => s.agentId === AG05_WEEKLY_BRIEF.id)) return null;
  const timezone = prefs.profile.timezone || 'Asia/Tokyo';
  const schedule: Schedule = {
    id: randomUUID(), tenantId, userId, agentId: AG05_WEEKLY_BRIEF.id, agentVersion: AG05_WEEKLY_BRIEF.version,
    input: {}, rule: WEEKLY_BRIEF_RULE, timezone, enabled: true,
    nextRunAt: nextRunAt(WEEKLY_BRIEF_RULE, timezone, now), lastRunAt: null,
    createdBy: userId, createdAt: mark,
  };
  await deps.repo.createSchedule(schedule);
  await deps.repo.appendAudit({
    id: randomUUID(), tenantId, actorType: 'secretary', actorId: userId, action: 'schedule.create',
    targetType: 'schedule', targetId: schedule.id,
    detail: { agentId: AG05_WEEKLY_BRIEF.id, rule: describeRule(WEEKLY_BRIEF_RULE), automatic: true }, occurredAt: mark,
  });
  return schedule;
}
