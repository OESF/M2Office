/**
 * @file 会議の音も録った録音を、秘書に議事録にしてもらう頼みの文（仕様書 第9.4.5.2節「止めたあと」、ADR-0137）。
 *
 * 録っていた間の予定があれば、その題名・日付と参加者を添える（参加者は、話した人の名前の手がかりにもなる）。
 * 無ければ「会議（11/11 15:00）」と呼ぶ。
 */

import type { OngoingMeetingView } from './api.js';

const DAY = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Tokyo' });
const TIME = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' });

/**
 * 議事録を頼む文。
 *
 * @param event 録っていた間の会議の予定（無ければ `null`）
 * @param now 録り終えた時刻（予定が無いときの呼び名に使う）
 */
export function meetingMinutesRequest(event: OngoingMeetingView | null, now: Date): string {
  if (!event) return `録音した会議（${DAY.format(now)} ${TIME.format(now)}）を議事録にしてください。`;
  const start = new Date(event.start);
  const who = event.attendees.length ? `参加者は ${event.attendees.join('、')} です。` : '';
  return `録音した会議「${event.title}」（${DAY.format(start)} ${TIME.format(start)}）を議事録にしてください。${who}`;
}
