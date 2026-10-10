/**
 * @file つかんで動かして並べ替える一覧の、並びの入れ替えの単体テスト。
 *
 * @see 仕様書 第6.5.6節 メニューの並び
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex, moveItem } from '../src/Sortable.js';

test('並べ替え: 1 つを別の位置へ動かし、ほかの順は保つ。端を越えたら端に置く。元の並びは変えない', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(list, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(list, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(list, 1, 1), list);
  assert.deepEqual(moveItem(list, 0, 99), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveItem(list, 2, -5), ['c', 'a', 'b', 'd']);
  assert.deepEqual(list, ['a', 'b', 'c', 'd']);
});

test('置く位置: つかんだ行の真ん中が、ほかの行の真ん中を越えた分だけ動く。一気に何段でも動く', () => {
  const mids = [20, 60, 100, 140, 180, 220];
  assert.equal(dropIndex(mids, 0, 20), 0, '動かしていなければそのまま');
  assert.equal(dropIndex(mids, 0, 59), 0, '次の行の真ん中を越えるまでは動かない');
  assert.equal(dropIndex(mids, 0, 61), 1);
  assert.equal(dropIndex(mids, 0, 190), 4, '一気に 4 段');
  assert.equal(dropIndex(mids, 0, 999), 5, '下の端を越えたらいちばん下');
  assert.equal(dropIndex(mids, 5, 15), 0, '上へも一気に');
  assert.equal(dropIndex(mids, 3, 120), 3, '上の行の真ん中を越えるまでは動かない');
  assert.equal(dropIndex(mids, 3, 95), 2);
});

