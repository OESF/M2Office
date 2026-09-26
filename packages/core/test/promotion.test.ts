/**
 * @file 昇華の共通の決まりの単体テスト。
 *
 * 第 0.115.0 版から、会社の知識にするかは秘書が判断する（`learn.test.ts` で確かめる）。
 * 本人と管理者の二重の承認はやめたため、ここでは題名の付け方だけを確かめる。
 *
 * @see 仕様書 第11.3節、ADR-0028
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promotionTitle } from '../src/index.js';

test('昇華した知識の題名は、先頭の 30 字にする', () => {
  assert.equal(promotionTitle('経費の精算は佐藤さんに出す'), '経費の精算は佐藤さんに出す');
  const long = 'あ'.repeat(40);
  assert.equal(promotionTitle(long), `${'あ'.repeat(30)}…`);
});
