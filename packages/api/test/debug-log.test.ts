/**
 * @file デバッグモードの記録の単体テスト（仕様書 第20.4.1節「デバッグモード」）。
 *
 * 本人の分だけを返すこと、件数の上限、読み足し、本番で有効にすると断ること、振り分けの 1 行を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEBUG_EVENTS_PER_USER, DebugLog, debugEnabled } from '../src/debug/log.js';
import { traceTitle } from '../src/debug/trace.js';

test('本人の分だけを新しい順に返し、上限を超えたら古いものから捨てる', () => {
  const log = new DebugLog();
  log.add('t1', 'u1', 'voice', 'あなた（聞き取り）: 連絡先を出して');
  log.add('t1', 'u1', 'secretary', '振り分け: 定型の答え「未読メールの確認」');
  log.add('t1', 'u2', 'secretary', 'ほかの人');
  log.add('t2', 'u1', 'secretary', 'ほかの会社');
  const mine = log.list('t1', 'u1');
  assert.deepEqual(mine.map((e) => e.title), ['振り分け: 定型の答え「未読メールの確認」', 'あなた（聞き取り）: 連絡先を出して']);
  assert.deepEqual(log.list('t1', 'u1', mine[1]!.id).map((e) => e.kind), ['secretary'], 'after より後だけ');
  for (let i = 0; i < DEBUG_EVENTS_PER_USER + 5; i++) log.add('t1', 'u1', 'error', `e${i}`);
  assert.equal(log.list('t1', 'u1').length, DEBUG_EVENTS_PER_USER);
  log.clear('t1', 'u1');
  assert.equal(log.list('t1', 'u1').length, 0);
  assert.equal(log.list('t1', 'u2').length, 1, 'ほかの人の記録は消さない');
});

test('本番で M2O_DEBUG を入れると起動を断る', () => {
  assert.equal(debugEnabled({ M2O_DEBUG: 'true' }), true);
  assert.equal(debugEnabled({}), false);
  assert.throws(() => debugEnabled({ M2O_DEBUG: 'true', NODE_ENV: 'production' }));
});

test('振り分けの経過を業務の言葉の 1 行にする', () => {
  assert.equal(traceTitle('secretary.direct', 'mail-unread'), '振り分け: 定型の答え「未読メールの確認」');
  assert.equal(traceTitle('secretary.handoff', 'secretary-lookup', { agent: '秘書の調べもの', reason: '名刺を探す依頼' }), '振り分け: 秘書の調べものへ回す（名刺を探す依頼）');
});
