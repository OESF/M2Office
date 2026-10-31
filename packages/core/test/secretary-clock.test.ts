/**
 * @file 秘書に渡すいまの日時（仕様書 第10.3.1節）の試験。
 *
 * 深夜・朝・タイムゾーン・知らないタイムゾーンで、年月日・曜日・時刻を正しく書くこと。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretaryClockLine } from '../src/secretary/clock.js';

test('深夜 0:30 は、日付を進めた日の 0:30 と曜日で書き、挨拶を合わせるよう添える', () => {
  const line = secretaryClockLine('Asia/Tokyo', new Date('2026-10-30T15:30:00Z'));
  assert.match(line, /^いまは 2026 年 10 月 31 日（土）0:30（Asia\/Tokyo）です。/);
  assert.match(line, /おはようございます/);
});

test('タイムゾーンが空なら日本時間、知らない名前でも日本時間で読む', () => {
  const at = new Date('2026-11-02T00:05:00Z');
  assert.match(secretaryClockLine('', at), /2026 年 11 月 2 日（月）9:05（Asia\/Tokyo）/);
  assert.match(secretaryClockLine('Not/AZone', at), /2026 年 11 月 2 日（月）9:05（Asia\/Tokyo）/);
});

test('本人のタイムゾーンで書く', () => {
  assert.match(secretaryClockLine('America/Los_Angeles', new Date('2026-10-30T15:30:00Z')), /2026 年 10 月 30 日（金）8:30（America\/Los_Angeles）/);
});
