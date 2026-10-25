/**
 * @file M2Office が使う Google の API の一覧と、まとめて有効にする画面の URL の単体テスト。
 *
 * @see 仕様書 第6.6.2節「必要な API をまとめて有効にする」、Q-269
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_APIS, googleApiLabel, googleEnableApiUrl, googleProjectNumber } from '@m2office/shared';

test('まとめて有効にする画面: 使う API を並べ、プロジェクトの番号があればそのプロジェクトで開く', () => {
  assert.equal(GOOGLE_APIS.length, 12);
  assert.equal(new Set(GOOGLE_APIS.map((a) => a.service)).size, 12);
  const url = googleEnableApiUrl(['gmail.googleapis.com', 'meet.googleapis.com'], '123456789');
  assert.equal(url, 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,meet.googleapis.com&project=123456789');
  assert.equal(googleEnableApiUrl(['gmail.googleapis.com'], null), 'https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com');
  assert.equal(googleProjectNumber('123456789012-abcdef.apps.googleusercontent.com'), '123456789012');
  assert.equal(googleProjectNumber(''), null);
  assert.equal(googleProjectNumber('abc-def.apps.googleusercontent.com'), null);
  assert.equal(googleApiLabel('meet.googleapis.com'), 'Google Meet REST API');
  assert.equal(googleApiLabel('unknown.googleapis.com'), 'unknown.googleapis.com');
});
