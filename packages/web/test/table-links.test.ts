/**
 * @file レポートの表の中のリンクを外す変換の単体テスト（仕様書 第36.11節）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTableLinks } from '../src/table-links.js';

test('表の中の名前のリンクは名前だけに、出典とリンクマークは消す。表の外はそのまま', () => {
  const out = stripTableLinks('| 医院 | 評価 |\n|---|---|\n| [ショップ A](https://a.example.jp/) | 4.3（[出典](https://a.example.jp/x)） [🔗](https://a.example.jp/) |\n本文の [リンク](https://b.example.jp/)');
  assert.equal(out.split('\n')[2], '| ショップ A | 4.3 |');
  assert.equal(out.split('\n')[3], '本文の [リンク](https://b.example.jp/)');
});
