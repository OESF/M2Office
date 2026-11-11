/**
 * @file 会議の録音を議事録にしてもらう頼みの文（仕様書 第9.4.5.2節「止めたあと」）の単体テスト。
 *
 * 予定があれば題名・日付・参加者を添え、無ければ「会議（日付 時刻）」と呼ぶことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingMinutesRequest } from '../src/meeting-request.js';

test('予定があれば、題名・日付・参加者を添えて議事録を頼む', () => {
  const text = meetingMinutesRequest({ title: '改装の打ち合わせ', start: '2026-11-11T06:00:00.000Z', end: '2026-11-11T07:00:00.000Z', attendees: ['guest@client.example.jp'] }, new Date());
  assert.equal(text, '録音した会議「改装の打ち合わせ」（11/11 15:00）を議事録にしてください。参加者は guest@client.example.jp です。');
});

test('予定が無ければ、録り終えた日時で呼ぶ', () => {
  assert.equal(meetingMinutesRequest(null, new Date('2026-11-11T06:42:00.000Z')), '録音した会議（11/11 15:42）を議事録にしてください。');
});
