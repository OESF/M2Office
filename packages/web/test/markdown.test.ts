/**
 * @file ヘルプの記事の Markdown の読み取りの単体テスト。見出しのすぐ次に箇条書きが続く書き方（業務の説明）で崩れないこと。
 *
 * @see 仕様書 第6.10.5節 業務のヘルプは定義から作る
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../src/markdown.js';

test('見出しのすぐ次の行に箇条書きが続いても、見出しと箇条書きに分ける（業務の説明の書き方）', () => {
  const md = [
    '会議の記録から議事録を作ります。', '',
    '## この業務がすること', '- 議事録を作ります', '- ToDo を登録します', '',
    '## 進み方', '取得 → 作成 → 承認', '',
    '## 承認が入る場所', '- **内容の承認**: 承認者が判断します',
  ].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { kind: 'p', text: '会議の記録から議事録を作ります。' },
    { kind: 'h2', text: 'この業務がすること' },
    { kind: 'ul', items: ['議事録を作ります', 'ToDo を登録します'] },
    { kind: 'h2', text: '進み方' },
    { kind: 'p', text: '取得 → 作成 → 承認' },
    { kind: 'h2', text: '承認が入る場所' },
    { kind: 'ul', items: ['**内容の承認**: 承認者が判断します'] },
  ]);
});

test('空行で区切った書き方（人が書く記事）も、これまでどおり読める', () => {
  const md = ['## 導入のしかた', '', '1. 押します', '2. 確かめます', '', '段落の 1 行目', '続きの行'].join('\n');
  assert.deepEqual(parseMarkdown(md), [
    { kind: 'h2', text: '導入のしかた' },
    { kind: 'ol', items: ['押します', '確かめます'] },
    { kind: 'p', text: '段落の 1 行目続きの行' },
  ]);
});

test('段落のすぐ次の箇条書き、### の見出し、箇条書きの種類の切り替わりも分ける', () => {
  const md = ['説明の文', '- 項目 1', '### 小見出し', '1. 番号', '- 記号'].join('\n');
  assert.deepEqual(parseMarkdown(md).map((b) => b.kind), ['p', 'ul', 'h3', 'ol', 'ul']);
});
