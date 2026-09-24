/**
 * @file ヘルプの記事の Markdown の読み取りの単体テスト。見出しのすぐ次に箇条書きが続く書き方（業務の説明）で崩れないこと。
 *
 * @see 仕様書 第6.10.5節 業務のヘルプは定義から作る
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown } from '../src/markdown.js';
import { timeGreeting } from '../src/greeting.js';

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

test('業務の答えの書き方を読む（仕様書 第6.2.2節）', () => {
  // 実機で出た答えの形。見出し・太字つきの箇条書き・出典が混じる
  const blocks = parseMarkdown([
    '就業規則におけるリモートワークに関する規則は以下のとおりです。',
    '',
    '### リモートワークの実施について',
    '* **趣旨・適用**: 開発業務の効率化のため、リモートワークを認めます。',
    '* **遵守事項**: 第6条の情報セキュリティ基準を遵守しなければなりません。',
    '',
    '#### 費用の負担',
    '通信費は別途定めます。',
    '',
    '**出典:**',
    '* 就業規則 › 第5章 › 第9条（リモートワークの実施）',
  ].join('\n'));

  assert.deepEqual(blocks.map((b) => b.kind), ['p', 'h3', 'ul', 'h3', 'p', 'p', 'ul']);
  // #### も見出しとして読む（文字のまま出さない）
  assert.equal((blocks[3] as { text: string }).text, '費用の負担');
  assert.equal((blocks[2] as { items: string[] }).items.length, 2);
});

test('答えに書かれたリンクは、http(s) と mailto だけを押せるようにする', () => {
  // 外から取り込んだ文書に由来する行が答えに混じりうる（不変則 I-6）
  const nodes = parseInline('[社内](javascript:alert(1)) と [規程](https://example.jp/a)');
  assert.deepEqual(nodes.filter((n) => n.kind === 'link').map((n) => (n as { href: string }).href),
    ['https://example.jp/a']);
  // 押せないものは文字だけが残る
  assert.equal(nodes.some((n) => n.kind === 'text' && n.text === '社内'), true);
});

test('時候の一言は、時刻と曜日から選ぶ（仕様書 第6.1.5節）', () => {
  // 2026-09-24 は木曜日
  assert.equal(timeGreeting(new Date('2026-09-24T07:00:00+09:00')), 'おはようございます');
  assert.equal(timeGreeting(new Date('2026-09-24T13:00:00+09:00')), 'こんにちは');
  assert.equal(timeGreeting(new Date('2026-09-24T20:00:00+09:00')), 'お疲れさまです');
  assert.equal(timeGreeting(new Date('2026-09-24T23:30:00+09:00')), '遅くまでお疲れさまです');
  assert.equal(timeGreeting(new Date('2026-09-25T03:00:00+09:00')), '遅くまでお疲れさまです');

  // 土曜・日曜は、時刻より優先する
  assert.equal(timeGreeting(new Date('2026-09-26T09:00:00+09:00')), '休日にお疲れさまです');
  assert.equal(timeGreeting(new Date('2026-09-27T21:00:00+09:00')), '休日にお疲れさまです');
});
