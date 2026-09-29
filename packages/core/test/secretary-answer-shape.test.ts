/**
 * @file 秘書の答えの形の単体テスト（仕様書 第10.9.4.1節「答えの形」・第6.2節）。
 *
 * 本文から出典の申告の行と出典の括弧を外し、根拠にした出典に印を付けて先頭に並べること、
 * 出典でない括弧は残すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCitations } from '../src/secretary/secretary.js';

const sources = [
  { label: '就業規則 › 第3章 › 第15条（始業・終業の時刻）', value: '始業は 9 時', kind: 'source' as const },
  { label: '経費精算規程 › 第2章 › 第4条（対象となる経費）', value: '消耗品費', kind: 'source' as const },
];

test('申告の行を外し、根拠にした出典に印を付けて先頭に並べる', () => {
  const r = splitCitations('始業は 9 時です。\n根拠: 【経費精算規程 › 第2章 › 第4条（対象となる経費）】', sources);
  assert.equal(r.text, '始業は 9 時です。');
  assert.deepEqual(r.evidence.map((e) => [e.label.slice(0, 6), !!e.cited]), [['経費精算規程', true], ['就業規則 ›', false]]);
});

test('本文に残った出典の括弧と、覚えていることを文のまま引いた括弧は外す。ほかの括弧は残す', () => {
  const r = splitCitations(
    'トナー（黒）は、使える数が 1 本で残りわずかです【トナー（黒）の使える数は現在1本で、残りわずかである。】。始業は 9 時です【就業規則 › 第3章 › 第15条（始業・終業の時刻）】。件名は【至急】です。',
    sources,
  );
  assert.equal(r.text, 'トナー（黒）は、使える数が 1 本で残りわずかです。始業は 9 時です。件名は【至急】です。');
  assert.equal(r.evidence[0]!.cited, true);
});

test('根拠にしなければ、答えも根拠もそのまま', () => {
  const r = splitCitations('承知しました。', sources);
  assert.equal(r.text, '承知しました。');
  assert.equal(r.evidence.filter((e) => e.cited).length, 0);
});
