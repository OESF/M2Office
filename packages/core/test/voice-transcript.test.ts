/**
 * @file 音声の聞き取りの文字を整える（仕様書 第10.5.2節「聞き取りの文字」）の単体テスト。
 *
 * 日本語の単語の間に入った空白を詰め、ハングルの聞き違えを外し、英字どうしの間の空白は残すことを確かめる。
 * 例は 2026-11-17 に実際に聞き取られた文から取った。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyTranscript } from '../src/index.js';

test('日本語の単語の間の空白を詰める', () => {
  assert.equal(tidyTranscript('えーと 、 Slack に は 今 どんな チャンネル が あり まし た か ?'), 'えーと、Slackには今どんなチャンネルがありましたか?');
  assert.equal(tidyTranscript('もう 一度 今後 1 週間 の 予定 を 表示 し て ください 。'), 'もう一度今後1週間の予定を表示してください。');
  assert.equal(tidyTranscript('今週　の 予定'), '今週の予定', '全角の空白も詰める');
});

test('ハングルの聞き違えを外す', () => {
  assert.equal(tidyTranscript('어?'), '');
  assert.equal(tidyTranscript('언니はい 、 大丈夫 です 。'), 'はい、大丈夫です。');
  assert.equal(tidyTranscript('ね 。 어? はい'), 'ね。はい');
});

test('英字どうしの間の空白と、空白の無い文はそのまま', () => {
  assert.equal(tidyTranscript('Google Drive'), 'Google Drive');
  assert.equal(tidyTranscript('Oi. Konbanwa.'), 'Oi. Konbanwa.');
  assert.equal(tidyTranscript('今日の予定は？'), '今日の予定は？');
  assert.equal(tidyTranscript(''), '');
});
