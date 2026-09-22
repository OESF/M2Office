/**
 * @file ヘルプの記事の Markdown の読み取りの単体テスト。見出しのすぐ次に箇条書きが続く書き方（業務の説明）で崩れないこと。
 *
 * @see 仕様書 第6.10.5節 業務のヘルプは定義から作る
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown } from '../src/markdown.js';

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

test('表は、見出しの行と区切りの行があるときだけ表にし、コードの中の | では分けない', () => {
  const md = ['| ツール | すること |', '|---|---|', '| `a|b` | 読む |', '| `document.create` | 書く |', '', '| 区切りのない | 行 |'].join('\n');
  const b = parseMarkdown(md);
  assert.deepEqual(b[0], { kind: 'table', header: ['ツール', 'すること'], rows: [['`a|b`', '読む'], ['`document.create`', '書く']] });
  assert.equal(b[1]!.kind, 'p', '区切りの行が無ければ表にしない');
});

test('コードの囲みの中は、見出しや箇条書きとして読まない', () => {
  const b = parseMarkdown(['```bash', 'npm run ext:validate x', '# 見出しではない', '```', '次の段落'].join('\n'));
  assert.deepEqual(b, [
    { kind: 'code', lang: 'bash', text: 'npm run ext:validate x\n# 見出しではない' },
    { kind: 'p', text: '次の段落' },
  ]);
});

test('行の中のコード・リンク・太字を読み、相対のリンクは文字だけにする', () => {
  assert.deepEqual(parseInline('[DeepWiki](https://deepwiki.com/) で `**x**` を **調べる**。[第7章](../../docs/07.md)'), [
    { kind: 'link', text: 'DeepWiki', href: 'https://deepwiki.com/' },
    { kind: 'text', text: ' で ' },
    { kind: 'code', text: '**x**' },
    { kind: 'text', text: ' を ' },
    { kind: 'strong', text: '調べる' },
    { kind: 'text', text: '。' },
    { kind: 'text', text: '第7章' },
  ]);
  assert.ok(!parseInline('[危ない](javascript:alert(1))').some((n) => n.kind === 'link'), 'http(s) 以外は押せるリンクにしない');
});
