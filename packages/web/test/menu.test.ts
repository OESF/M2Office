/**
 * @file 左のメニューのピン止めの単体テスト（仕様書 第6.1.1節「業務の並び」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PINNED } from '@m2office/shared';
import { pinnedIds, splitMenu, togglePinned } from '../src/menu.js';

const agents = ['knowledge-qa', 'minutes', 'inbox-triage', 'scheduling', 'weekly-brief', 'morning-brief', 'slides', 'document-draft'].map((id) => ({ id }));

test('まだ一度も変えていなければ、標準の組がピン止めされている', () => {
  assert.deepEqual(pinnedIds(null), DEFAULT_PINNED);
  assert.deepEqual(pinnedIds(undefined), DEFAULT_PINNED);
  const { top, others } = splitMenu(agents, null);
  assert.deepEqual(top.map((a) => a.id), ['knowledge-qa', 'minutes', 'inbox-triage', 'scheduling', 'slides', 'document-draft'], 'メニューの順のまま');
  assert.deepEqual(others.map((a) => a.id), ['weekly-brief', 'morning-brief']);
});

test('ピン止めすれば上に出て、外せば「ほかの業務」に入る。空にもできる', () => {
  const pinned = togglePinned(togglePinned(null, 'morning-brief'), 'scheduling');
  const { top, others } = splitMenu(agents, pinned);
  assert.ok(top.some((a) => a.id === 'morning-brief'));
  assert.ok(others.some((a) => a.id === 'scheduling'));
  assert.deepEqual(splitMenu(agents, []).top, [], '全部外せば、上には何も出ない');
});
