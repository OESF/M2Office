/**
 * @file ワーカーの見回りの繰り返し（仕様書 第8.6.7.1節「止まらないように」）の確かめ。
 * 1 回分の中でデータベースの切断やほかの例外が投げられても、繰り返しを抜けずに待ってから次の回へ進むこと、
 * 止める合図で終わることを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentLogger, type Logger } from '@m2office/core';
import { patrolLoop } from '../src/patrol.js';

/** 書かれた記録を、重さと文だけ覚えるロガー。 */
function recordingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log: Logger = {
    ...silentLogger,
    warn: (msg: string) => { lines.push(`warn ${msg}`); },
    error: (msg: string) => { lines.push(`error ${msg}`); },
    child: () => log,
  };
  return { log, lines };
}

test('データベースの切断が 2 回続いても、繰り返しを抜けずに 3 回目から続けて動く。待つ時間は倍にしていく', async () => {
  const { log, lines } = recordingLogger();
  const waits: number[] = [];
  let calls = 0;
  await patrolLoop({
    running: () => calls < 5,
    once: async () => {
      calls++;
      if (calls <= 2) throw new Error('Connection terminated unexpectedly');
    },
    sleep: async (ms) => { waits.push(ms); },
    log, retryMs: 100, retryMaxMs: 1_000,
  });
  assert.equal(calls, 5);
  assert.deepEqual(waits, [100, 200]);
  assert.equal(lines.filter((l) => l.startsWith('warn データベースが一時的に止まりました')).length, 2);
});

test('切断以外の例外も記録して次の回へ進む。待つ時間には上限があり、うまく回れば始まりに戻る', async () => {
  const { log, lines } = recordingLogger();
  const waits: number[] = [];
  let calls = 0;
  await patrolLoop({
    running: () => calls < 7,
    once: async () => {
      calls++;
      if (calls <= 4 || calls === 6) throw new TypeError('壊れた値');
    },
    sleep: async (ms) => { waits.push(ms); },
    log, retryMs: 100, retryMaxMs: 300,
  });
  assert.equal(calls, 7);
  assert.deepEqual(waits, [100, 200, 300, 300, 100]);
  assert.ok(lines.every((l) => l.startsWith('error 見回りの途中で例外が発生しました')));
});

test('止める合図を受けたら、1 回も回さずに終わる', async () => {
  let calls = 0;
  await patrolLoop({ running: () => false, once: async () => { calls++; }, sleep: async () => undefined, log: silentLogger });
  assert.equal(calls, 0);
});
