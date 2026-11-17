/**
 * @file 秘書の入力欄で前に送った依頼を呼び戻す決まり（仕様書 第6.1.3節「入力欄」）の単体テスト。
 *
 * 依頼の並べ方（新しい順・同じ依頼は 1 つ・上限）、↑↓ で呼び戻すときの条件（複数行の中の移動を残す）、
 * さかのぼって戻ると書きかけの文に戻ることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_HISTORY, INPUT_HISTORY_MAX, mergeHistory, shouldRecall, stepHistory } from '../src/input-history.js';

test('この画面で送った依頼を先に、同じ依頼は新しいほうだけを並べ、空の依頼を除く', () => {
  assert.deepEqual(mergeHistory(['b', 'a'], ['b', ' a ', '', 'c', 'a']), ['b', 'a', 'c']);
  assert.deepEqual(mergeHistory([], []), []);
  const many = Array.from({ length: INPUT_HISTORY_MAX + 10 }, (_, i) => `依頼 ${i}`);
  assert.equal(mergeHistory([], many).length, INPUT_HISTORY_MAX);
});

test('↑ はカーソルが 1 行目にあるとき、↓ は呼び戻している最中で最後の行にあるときだけ呼び戻す', () => {
  const at = (n: number) => ({ start: n, end: n });
  assert.equal(shouldRecall('ArrowUp', '', at(0), false), true);
  assert.equal(shouldRecall('ArrowUp', '今日の予定', at(5), false), true);
  assert.equal(shouldRecall('ArrowUp', '1 行目\n2 行目', at(8), false), false, '2 行目からは行を上がるだけ');
  assert.equal(shouldRecall('ArrowUp', '1 行目\n2 行目', at(2), true), true);
  assert.equal(shouldRecall('ArrowDown', '今日の予定', at(0), false), false, '呼び戻していなければ何もしない');
  assert.equal(shouldRecall('ArrowDown', '1 行目\n2 行目', at(0), true), false, '1 行目からは行を下がるだけ');
  assert.equal(shouldRecall('ArrowDown', '1 行目\n2 行目', at(8), true), true);
  assert.equal(shouldRecall('ArrowUp', '今日の予定', { start: 0, end: 3 }, false), false, '選んでいる範囲があれば呼び戻さない');
  assert.equal(shouldRecall('Enter', '', at(0), false), false);
});

test('↑ でさかのぼり、↓ で戻り、いちばん新しい依頼より先では書きかけの文に戻る', () => {
  let s = { ...EMPTY_HISTORY, items: ['新しい', '前の', 'いちばん前'] };
  const up1 = stepHistory(s, 'older', '書きかけ');
  assert.equal(up1.text, '新しい');
  s = up1.state;
  const up2 = stepHistory(s, 'older', '新しい');
  assert.equal(up2.text, '前の');
  s = up2.state;
  const up3 = stepHistory(s, 'older', '前の');
  assert.equal(up3.text, 'いちばん前');
  s = up3.state;
  const end = stepHistory(s, 'older', 'いちばん前');
  assert.equal(end.text, null, 'いちばん前より先へは動かない');
  const down1 = stepHistory(s, 'newer', 'いちばん前');
  assert.equal(down1.text, '前の');
  s = stepHistory(down1.state, 'newer', '前の').state;
  const back = stepHistory(s, 'newer', '新しい');
  assert.equal(back.text, '書きかけ');
  assert.equal(back.state.index, -1);
  assert.equal(stepHistory(back.state, 'newer', '書きかけ').text, null, '書きかけより先へは動かない');
});

test('送った依頼が無ければ、↑ を押しても何も変えない', () => {
  const r = stepHistory(EMPTY_HISTORY, 'older', '書きかけ');
  assert.equal(r.text, null);
  assert.equal(r.state, EMPTY_HISTORY);
});
