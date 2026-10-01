/**
 * @file 本人の朝のブリーフ・週次ブリーフの中身を読むツール（`brief.settings`。仕様書 第9.5.5.1.1節、ADR-0047・ADR-0048）。
 */

import { BRIEF_SECTIONS, WEEKLY_SECTIONS } from '@m2office/shared';
import type { Tool } from '../tools/registry.js';

/**
 * 本人の関心の分野と、外した項目を返す。
 *
 * @remarks
 * 危険度: `read`。本人の設定を読む。
 * 秘書が最初の分野を選んだことを伝える印（`seedNote`）が立っていれば返し、**その印を下ろす**（一度だけ伝えるため）。本人の設定の印だけで、中身は変えない。
 */
export const briefSettings: Tool = {
  name: 'brief.settings',
  risk: 'read',
  activityLabel: 'ブリーフの中身を確かめています',
  helpText: 'あなたのブリーフ（朝・週）に入れる関心の分野と、外した項目を確かめます。設定を書き換えることはしません',
  description: '依頼した本人のブリーフ（朝・週）の中身を返す。引数は無い。'
    + 'topics は関心の分野（label は名前、query は Web で調べる言葉）。omit は朝のブリーフで外した項目、weeklyOmit は週次ブリーフで外した項目の名前で、その項目は調べず伝えない。'
    + 'seededTopics が true なら、秘書が最初の分野を選んだことをブリーフの最後に一度だけ添える',
  args: { properties: {} },
  async invoke(_args, ctx) {
    const prefs = await ctx.repo.getUserSettings(ctx.tenantId, ctx.userId);
    const brief = prefs.brief;
    if (brief.seedNote) await ctx.repo.saveUserSettings(ctx.tenantId, ctx.userId, 'brief', { ...brief, seedNote: false });
    return {
      topics: brief.topics.map((t) => ({ label: t.label, query: t.query })),
      omit: brief.omit.map((id) => BRIEF_SECTIONS.find((s) => s.id === id)?.label ?? id),
      weeklyOmit: (brief.weeklyOmit ?? []).map((id) => WEEKLY_SECTIONS.find((s) => s.id === id)?.label ?? id),
      seededTopics: brief.seedNote && brief.topics.length > 0,
    };
  },
};

export const BRIEF_TOOLS: Tool[] = [briefSettings];
