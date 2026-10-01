/**
 * @file 依頼した本人の情報を読むツール（`profile.read`。仕様書 第9.5.5.1節）。
 *
 * 出張・外出の行程の出発地（自宅か勤務地か）と、朝のブリーフの天気の地域に使う。
 * 自宅は本人の秘書と、本人の依頼で動く業務だけが使う（第6.5.1節）。このツールを宣言した業務だけが読める。
 */

import type { Tool } from './registry.js';

/** 曜日の名前。 */
const WEEKDAYS = '日月火水木金土';

/**
 * 依頼した本人の表示名・役職・自宅・いつもの勤務地・タイムゾーンと、今日の日付を返す。
 *
 * @remarks
 * 危険度: `read`。本人の設定を読むだけで、どこにも書き込まない。
 * 勤務地が空なら会社情報の住所を返す。自宅が空なら空のまま返す（推測で埋めない）。
 * 依頼した本人のものだけを返す（不変則 I-9）。ほかの人の情報は読めない。
 */
export const profileRead: Tool = {
  name: 'profile.read',
  risk: 'read',
  activityLabel: 'あなたの情報を確かめています',
  helpText: 'あなたの自宅（地域）・いつもの勤務地・今日の日付を確かめます。行程の出発地や天気の地域に使い、どこにも書き込みません',
  description: '依頼した本人の表示名・役職・自宅（地域か最寄り駅）・いつもの勤務地・タイムゾーンと、今日の日付・曜日を返す。引数は無い。'
    + '出発地は、朝早い出発・休日は自宅、平日の日中は勤務地を基本にする',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const [user, prefs, settings] = await Promise.all([
      ctx.repo.findUserById(ctx.tenantId, ctx.userId),
      ctx.repo.getUserSettings(ctx.tenantId, ctx.userId),
      ctx.repo.getTenantSettings(ctx.tenantId),
    ]);
    const timezone = prefs.profile.timezone || 'Asia/Tokyo';
    const now = new Date();
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(now);
    const weekday = WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
    const office = settings.company.address?.trim() ?? '';
    return {
      name: user?.displayName ?? '',
      title: prefs.profile.title,
      home: prefs.profile.home || '（登録されていません）',
      workplace: prefs.profile.workplace || office || '（登録されていません）',
      workplaceIsCompanyAddress: !prefs.profile.workplace && !!office,
      company: settings.company.shortName || settings.company.legalName,
      timezone,
      today: `${date}（${weekday}）`,
    };
  },
};

export const PROFILE_TOOLS: Tool[] = [profileRead];
