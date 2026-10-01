/**
 * @file ヘルプの目次の木の開き方と、端末に覚える状態の単体テスト。
 *
 * @see 仕様書 第6.10.7節 ヘルプセンター（すべて開く・すべて閉じる・前の状態に戻す）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allBranches, branchesHolding, defaultOpenKeys, loadHelpState, openTo, saveHelpState, type HelpBranch } from '../src/help-state.js';

const TREE: HelpBranch[] = [
  { key: 'start', items: [{ id: 'start-secretary' }] },
  {
    key: 'business', items: [], nodes: [
      { key: 'business:inventory', closed: true, items: [{ id: 'start-inventory' }], nodes: [{ key: 'manual:inventory', closed: true, items: [{ id: 'inventory-11' }] }] },
    ],
  },
  { key: 'updates', closed: true, items: [{ id: 'updates-v0-12-0' }] },
];

test('木の開き方: 既定は閉じる印の無い枝だけ。すべての枝は下の枝まで含む', () => {
  assert.deepEqual(defaultOpenKeys(TREE), ['start', 'business']);
  assert.deepEqual(allBranches(TREE).map((n) => n.key), ['start', 'business', 'business:inventory', 'manual:inventory', 'updates']);
});

test('開いている記事を含む枝を開き足す。足すものが無ければ同じ配列を返す', () => {
  assert.deepEqual(branchesHolding(TREE, 'inventory-11'), ['business', 'business:inventory', 'manual:inventory']);
  assert.deepEqual(openTo(['start'], TREE, 'inventory-11'), ['start', 'business', 'business:inventory', 'manual:inventory']);
  const all = ['start', 'business', 'business:inventory', 'manual:inventory'];
  assert.equal(openTo(all, TREE, 'inventory-11'), all, '覚え直しを起こさない');
  assert.equal(openTo(all, TREE, null), all);
  assert.equal(openTo(all, TREE, '無い記事'), all);
});

test('端末に覚える: 書いたものを読め、壊れていれば既定、覚えられなくても止まらない', () => {
  const box = new Map<string, string>();
  const g = globalThis as { window?: unknown };
  g.window = { localStorage: { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => { box.set(k, v); } } };
  try {
    assert.deepEqual(loadHelpState('workspace'), { open: null, article: null });
    saveHelpState('workspace', { open: ['start', 'updates'], article: 'updates-v0-12-0' });
    assert.deepEqual(loadHelpState('workspace'), { open: ['start', 'updates'], article: 'updates-v0-12-0' });
    assert.deepEqual(loadHelpState('admin'), { open: null, article: null }, 'ワークスペースと管理者ページは別々');
    box.set('m2o.help.v1.admin', '{壊れた');
    assert.deepEqual(loadHelpState('admin'), { open: null, article: null });
    g.window = { localStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } };
    assert.deepEqual(loadHelpState('workspace'), { open: null, article: null });
    assert.doesNotThrow(() => saveHelpState('workspace', { open: [], article: null }));
  } finally {
    delete g.window;
  }
});
