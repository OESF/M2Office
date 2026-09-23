/**
 * @file 話し終わりを待って伝える門の単体テスト。
 *
 * 話している最中に送ると、Gemini Live では割り込みとみなされ音声が切れる。
 * その 1 点だけを守る仕組みであり、その 1 点を確かめる。
 *
 * @see 仕様書 第10.11.7節 終わったことを伝える
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnGate } from '../src/voice/turn-gate.js';

/** 送った内容を控える門を作る。 */
function gate() {
  const sent: string[] = [];
  return { sent, g: new TurnGate((n) => sent.push(n)) };
}

test('話していなければ、そのまま伝える', () => {
  const { sent, g } = gate();
  g.tell('調べものが終わりました');
  assert.deepEqual(sent, ['調べものが終わりました']);
  assert.equal(g.pending, 0);
});

test('話している最中は伝えず、話し終わりまで待たせる', () => {
  const { sent, g } = gate();
  g.startedSpeaking();
  g.tell('調べものが終わりました');

  // 割り込むと、再生中の音声が切れる
  assert.deepEqual(sent, [], '話している間は送らない');
  assert.equal(g.pending, 1);

  g.finishedSpeaking();
  assert.deepEqual(sent, ['調べものが終わりました']);
  assert.equal(g.pending, 0);
});

test('待たせたものが複数あっても、話し終わりごとに 1 つだけ伝える', () => {
  const { sent, g } = gate();
  g.startedSpeaking();
  g.tell('1 件目');
  g.tell('2 件目');
  assert.equal(g.pending, 2);

  // まとめて送ると、続けて割り込むことになる
  g.finishedSpeaking();
  assert.deepEqual(sent, ['1 件目']);
  assert.equal(g.pending, 1);

  g.startedSpeaking();
  g.finishedSpeaking();
  assert.deepEqual(sent, ['1 件目', '2 件目']);
  assert.equal(g.pending, 0);
});

test('待たせているものが無ければ、話し終わりで何も送らない', () => {
  const { sent, g } = gate();
  g.startedSpeaking();
  g.finishedSpeaking();
  assert.deepEqual(sent, []);
});

test('伝えたあとにまた話し始めても、送り直さない', () => {
  const { sent, g } = gate();
  g.tell('1 件目');
  g.startedSpeaking();
  g.finishedSpeaking();
  assert.deepEqual(sent, ['1 件目'], '同じものを二度送らない');
});
