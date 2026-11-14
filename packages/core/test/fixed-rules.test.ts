/**
 * @file 秘書の決め打ちの決まりの表の単体テスト（仕様書 第10.7.4.2節・第10.7.4.6節 段 3、ADR-0147）。
 *
 * 頼みの例が、その決まりに当たり、前の決まりに奪われないこと（順番）と、
 * 業務に頼むべき頼み・社内の規程の質問が、どの決まりにも当たらないこと（推論が選ぶ）を守る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_RULES, firstFixedRule } from '../src/secretary/fixed-rules.js';

test('決まりの例は、その決まりに最初に当たる（前の決まりに奪われない）', () => {
  for (const rule of FIXED_RULES) {
    for (const sample of rule.samples) {
      assert.equal(firstFixedRule(sample)?.id, rule.id, `「${sample}」は ${rule.id} に当たるべき`);
    }
  }
});

test('決まりの ID は重ならず、どれにも決め打ちにする理由がある', () => {
  const ids = FIXED_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of FIXED_RULES) assert.ok(['safety', 'speed', 'setting'].includes(r.reason), r.id);
});

test('業務に頼む頼み・社内の規程の質問・話の続きは、決め打ちに当てない（推論が選ぶ）', () => {
  for (const m of [
    '取引先へのお礼状を作って', '新サービスの説明のスライドを作って', '見本商事向けに見積書を作って', '出張の日当はいくら？',
    '明日の大阪の天気は？', '去年の保守契約書を出して', '来週の打ち合わせの日程を山田さんと調整して', '試作工房のも同じように',
  ]) {
    assert.equal(firstFixedRule(m), null, `「${m}」は ${firstFixedRule(m)?.id} に当たった`);
  }
});
