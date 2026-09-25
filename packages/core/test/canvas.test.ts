/**
 * @file 音声の答えを秘書のキャンバスにも出すかの判定の単体テスト。
 *
 * @see 仕様書 第6.2.0節、ADR-0026
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsCanvas } from '../src/index.js';

const reply = (text: string, extra: Record<string, unknown> = {}) => ({ text, evidence: [], ...extra });

test('短い答えは声だけで返す', () => {
  assert.equal(needsCanvas(reply('明日の予定は 2 件です。10 時から朝会です。')), null);
  assert.equal(needsCanvas(reply('- 朝会\n- 定例\n- 面談')), null, '3 件までの一覧は声で足りる');
  assert.equal(needsCanvas(reply('承認待ちは 1 件です。', { evidence: [{ label: '承認待ち', value: '議事録' }] })), null);
});

test('大きい答えは画面にも出す', () => {
  assert.equal(needsCanvas(reply('- a\n- b\n- c\n- d')), '一覧');
  assert.equal(needsCanvas(reply('1. a\n2. b\n3. c\n4. d')), '一覧');
  assert.equal(needsCanvas(reply('未読は 4 件です。', {
    evidence: [1, 2, 3, 4].map((i) => ({ label: `差出人 ${i}`, value: '件名' })),
  })), '一覧', '根拠が 4 件以上');
  assert.equal(needsCanvas(reply('| 日付 | 件名 |\n|---|---|\n| 1 | a |')), '表');
  assert.equal(needsCanvas(reply('あ'.repeat(201))), '長い答え');
  assert.equal(needsCanvas(reply('開きます', { suggestedAgent: { id: 'minutes', version: 1, name: '議事録' } })), '業務を開くボタン');
  assert.equal(needsCanvas(reply('こうします', { helpArticles: [{ id: 'x', title: 'y' }] })), 'ヘルプの記事');
  assert.equal(needsCanvas(reply('規程では 3 日です', { evidence: [{ label: '就業規則', value: '…', kind: 'source' }] })), '出典');
});
