/**
 * @file 秘書から見たあなたを見出しごとに分ける処理の単体テスト（仕様書 第6.5.4.2節）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileSections } from '../src/profile-sections.js';

test('見出しごとに分け、まだ分からない見出しに印を付ける', () => {
  const out = profileSections('## 役割と担当\n- 見積書の作成\n- 発注\n\n## よく使う言葉\n- （まだ分かりません）\n');
  assert.deepEqual(out.map((s) => s.heading), ['役割と担当', 'よく使う言葉']);
  assert.equal(out[0]!.body, '- 見積書の作成\n- 発注');
  assert.equal(out[0]!.unknown, false);
  assert.equal(out[1]!.unknown, true);
});

test('見出しが無ければ空の配列（全文をそのまま出す）', () => {
  assert.deepEqual(profileSections('見出しの無い文'), []);
});
