/**
 * @file いま行われている会議の予定（仕様書 第9.4.5.2節、ADR-0137）。会議の音も録るとき、録り方の選びを先に選んでおくのと、
 * 止めたあとの議事録の題名と参加者に使う。
 */

import type { CalendarEvent } from '../connectors/types.js';

/** 始まりの何分前から「いまの会議」とみなすか。 */
export const ONGOING_LEAD_MIN = 15;

/** いまの会議（画面と議事録の頼みに渡す形）。 */
export interface OngoingMeeting {
  title: string;
  start: string;
  end: string;
  /** 本人を除く参加者のアドレス */
  attendees: string[];
}

/**
 * いま行われている会議の予定を選ぶ（始まりの 15 分前から終わりまで。終日の予定は除く）。
 * 重なっていれば、始まりがいまにいちばん近いもの。
 *
 * @param self 本人のアドレス（参加者から除く）
 * @returns 無ければ `null`
 */
export function ongoingMeeting(events: CalendarEvent[], now: Date, self: string): OngoingMeeting | null {
  const t = now.getTime();
  const me = self.toLowerCase();
  const hit = events
    .filter((e) => !e.allDay && Date.parse(e.start) - ONGOING_LEAD_MIN * 60_000 <= t && t <= Date.parse(e.end))
    .sort((a, b) => Math.abs(Date.parse(a.start) - t) - Math.abs(Date.parse(b.start) - t))[0];
  if (!hit) return null;
  return {
    title: hit.title, start: hit.start, end: hit.end,
    attendees: hit.attendees.filter((a) => a.toLowerCase() !== me).slice(0, 20),
  };
}
