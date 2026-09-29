/**
 * @file 左のメニューのピン止めとカテゴリーの単体テスト（仕様書 第6.1.1節「業務の並び」）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PINNED } from '@m2office/shared';
import {
  addCategory, assignCategory, checkCategoryName, groupMenu, pinnedIds, removeCategory, splitMenu, togglePinned,
} from '../src/menu.js';

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

test('カテゴリー: ピン止め → カテゴリー（作った順） → 「ほかの業務」の順に分け、中身の無いカテゴリーは出さない', () => {
  const layout = {
    pinned: ['knowledge-qa'],
    categories: [{ id: 'c1', name: 'ブリーフ' }, { id: 'c2', name: '経理' }, { id: 'c3', name: '資料' }],
    categoryOf: { 'weekly-brief': 'c1', 'morning-brief': 'c1', slides: 'c3', 'knowledge-qa': 'c3' },
  };
  const { top, sections } = groupMenu(agents, layout);
  assert.deepEqual(top.map((a) => a.id), ['knowledge-qa'], 'ピン止めが優先し、カテゴリーに入っていても上に出る');
  assert.deepEqual(sections.map((s) => s.category?.name ?? null), ['ブリーフ', '資料', null], '空の「経理」は出さず、最後に「ほかの業務」');
  assert.deepEqual(sections[0]!.items.map((a) => a.id), ['weekly-brief', 'morning-brief'], 'カテゴリーの中はメニューの順のまま');
  assert.deepEqual(sections[1]!.items.map((a) => a.id), ['slides']);
  assert.deepEqual(sections[2]!.items.map((a) => a.id), ['minutes', 'inbox-triage', 'scheduling', 'document-draft']);
  // ピン止めを外すと、入っているカテゴリーに戻る
  const unpinned = groupMenu(agents, { ...layout, pinned: togglePinned(layout.pinned, 'knowledge-qa') });
  assert.deepEqual(unpinned.sections.find((s) => s.category?.id === 'c3')!.items.map((a) => a.id), ['knowledge-qa', 'slides']);
  // 消したカテゴリーを指す対応は「ほかの業務」に出す
  assert.ok(groupMenu(agents, { ...layout, categories: [] }).sections[0]!.category === null);
});

test('カテゴリー: 作る・入れる・入れない・名前を変える・消す', () => {
  const made = addCategory([], ' 経理 ');
  assert.ok(!('error' in made));
  assert.equal(made.category.name, '経理', '前後の空白を落とす');
  assert.ok('error' in addCategory(made.categories, '経理'), '同じ名前は作れない');
  assert.ok('error' in addCategory(made.categories, '   '), '空の名前は作れない');
  assert.ok('error' in addCategory(made.categories, 'あ'.repeat(21)), '21 字は長すぎる');
  assert.ok('error' in addCategory(Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, name: `n${i}` })), '二十一'), '21 個目は作れない');
  const of = assignCategory({}, 'slides', made.category.id);
  assert.deepEqual(of, { slides: made.category.id });
  assert.deepEqual(assignCategory(of, 'slides', null), {}, '「カテゴリーに入れない」で外れる');
  assert.ok(!('error' in checkCategoryName(made.categories, '経理', made.category.id)), '自分の名前のままなら変えられる');
  const removed = removeCategory({ categories: made.categories, categoryOf: of }, made.category.id);
  assert.deepEqual(removed, { categories: [], categoryOf: {} }, '消すと、中の業務は「カテゴリーに入れない」に戻る');
});
