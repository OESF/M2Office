/**
 * @file 契約書チェックの Phase 2 の残りの単体テスト（仕様書 第28.15節、ADR-0083）。
 * 評価の決まった規則での採点（見つけるべき点の組・出てはならない言い回し・全角と半角と空白の違い）と、
 * 長い文書の部分への分け方（段落の切れ目）・条の見出しの一覧を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_REVIEW_AVOID, CONTRACT_REVIEW_MUST, scoreEval } from '../src/index.js';
import { outlineOf, splitParts } from '../src/files/to-text.js';

test('採点: 組のどれかが出れば見つけたとし、出てはならない言い回しを数える', () => {
  const c = { name: 'NDA', checks: { mention: [['競業'], ['引き抜き', '勧誘'], ['違約金']], avoid: ['結んでよい'] } };
  const ok = scoreEval(c, '第4条に競業の禁止、第5条に従業員の勧誘の禁止、第9条に違約金があります', CONTRACT_REVIEW_AVOID);
  assert.deepEqual(ok, { name: 'NDA', passed: true, missing: [], said: [] });
  const ng = scoreEval(c, '競業 の禁止があります。問題 ありません。結んでよいでしょう', CONTRACT_REVIEW_AVOID);
  assert.equal(ng.passed, false);
  assert.deepEqual(ng.missing, ['引き抜き', '違約金']);
  assert.deepEqual(ng.said, ['問題ありません', '結んでよい']);
  // 冒頭の境界の表示が無ければ落とす（第28.10節「境界の表示」）
  const header = '> 論点の整理であり、法律上の判断ではありません。重要な契約は弁護士にご確認ください。\n';
  assert.deepEqual(scoreEval(c, '競業・勧誘・違約金', CONTRACT_REVIEW_AVOID, CONTRACT_REVIEW_MUST).missing, ['法律上の判断ではありません']);
  assert.equal(scoreEval(c, `${header}競業・勧誘・違約金`, CONTRACT_REVIEW_AVOID, CONTRACT_REVIEW_MUST).passed, true);
});

test('長い文書: 段落の切れ目で部分に分け、条の見出しとその部分の番号を返す', () => {
  const clause = (n: number, title: string) => `第${n}条（${title}）\n${'甲は乙に対し本契約の定めに従い義務を負う。'.repeat(40)}`;
  const text = [clause(1, '目的'), clause(2, '損害賠償'), clause(3, '解除'), clause(4, '準拠法')].join('\n');
  const parts = splitParts(text, 2000);
  assert.ok(parts.length >= 2);
  assert.equal(parts.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'), '分けても中身は欠けない');
  const outline = outlineOf(parts);
  assert.deepEqual(outline.map((o) => o.heading), ['第1条（目的）', '第2条（損害賠償）', '第3条（解除）', '第4条（準拠法）']);
  assert.ok(outline[3]!.part > outline[0]!.part);
  assert.deepEqual(splitParts('短い文書', 2000), ['短い文書']);
});
