/**
 * @file いま行われている会議の予定（仕様書 第9.4.5.2節、ADR-0137）の単体テスト。
 *
 * 始まりの 15 分前から終わりまでを「いまの会議」とし、終日の予定を除き、重なれば始まりがいまに近いものを選び、参加者から本人を除くことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ongoingMeeting, type CalendarEvent } from '../src/index.js';

const NOW = new Date('2026-11-11T06:05:00.000Z'); // 日本時間 15:05
const ev = (id: string, start: string, end: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: id, start, end, attendees: ['me@example.jp', 'guest@client.example.jp'], location: null, ...over,
});

test('いまの会議: 始まりの 15 分前から終わりまで。終日の予定は除き、参加者から本人を除く', () => {
  const m = ongoingMeeting([
    ev('終日', '2026-11-10T15:00:00.000Z', '2026-11-11T15:00:00.000Z', { allDay: true }),
    ev('打ち合わせ', '2026-11-11T06:00:00.000Z', '2026-11-11T07:00:00.000Z'),
  ], NOW, 'ME@example.jp');
  assert.deepEqual(m, { title: '打ち合わせ', start: '2026-11-11T06:00:00.000Z', end: '2026-11-11T07:00:00.000Z', attendees: ['guest@client.example.jp'] });
  assert.equal(ongoingMeeting([ev('まだ先', '2026-11-11T06:30:00.000Z', '2026-11-11T07:00:00.000Z')], NOW, 'me@example.jp'), null, '25 分後の会議はまだ');
  assert.equal(ongoingMeeting([ev('すぐ', '2026-11-11T06:15:00.000Z', '2026-11-11T07:00:00.000Z')], NOW, 'me@example.jp')?.title, 'すぐ', '10 分後なら');
  assert.equal(ongoingMeeting([ev('終わった', '2026-11-11T05:00:00.000Z', '2026-11-11T06:00:00.000Z')], NOW, 'me@example.jp'), null);
});

test('いまの会議: 重なっていれば、始まりがいまにいちばん近いもの', () => {
  const m = ongoingMeeting([
    ev('長い会議', '2026-11-11T04:00:00.000Z', '2026-11-11T08:00:00.000Z'),
    ev('次の会議', '2026-11-11T06:00:00.000Z', '2026-11-11T06:30:00.000Z'),
  ], NOW, 'me@example.jp');
  assert.equal(m?.title, '次の会議');
});
