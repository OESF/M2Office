/**
 * @file 文書の本文（Markdown）を、名前の付いたスタイルで書き入れる命令に直す部品の単体テスト。
 *
 * @see 仕様書 第9.5.5.2節「文書のテンプレート」、ADR-0110
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE_MARK, clearBodyRequests, docBodyRequests, fillTableRequests, findMark, parseInline, parseMarkdownBlocks } from '../src/connectors/google/doc-requests.js';

test('塊に分ける: 見出し・段落・箇条書き（入れ子と番号）・表・コード・区切り線', () => {
  const blocks = parseMarkdownBlocks('# 題名\n\n本文の\n続き\n\n- 一\n  - 一の一\n1. 番号\n\n| 項目 | 値 |\n|---|---|\n| A | 1 |\n\n```\nx = 1\n```\n---\n> 引用');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'para', 'list', 'list', 'table', 'code', 'para', 'para']);
  assert.deepEqual(blocks[1], { type: 'para', text: '本文の 続き' });
  assert.deepEqual(blocks[2], { type: 'list', ordered: false, items: [{ level: 0, text: '一' }, { level: 1, text: '一の一' }] });
  assert.deepEqual(blocks[4], { type: 'table', rows: [['項目', '値'], ['A', '1']] });
  assert.deepEqual(blocks[7], { type: 'para', text: '引用' });
});

test('行の中の書式: 太字・コード・リンクの印を外し、位置を返す（http(s) のリンクだけ）', () => {
  const r = parseInline('これは**大事**で `code` と[資料](https://example.jp/a)、[外](javascript:x)');
  assert.equal(r.text, 'これは大事で code と資料、[外](javascript:x)');
  assert.deepEqual(r.bold, [[3, 5]]);
  assert.deepEqual(r.code, [[7, 11]]);
  assert.deepEqual(r.links, [[13, 15, 'https://example.jp/a']]);
});

test('書き入れる命令: 文を 1 回で入れ、直接の書式を外してから、段落ごとに名前の付いたスタイルを当てる', () => {
  const { requests, tables } = docBodyRequests('# 提案書\n## 背景\n本文は**大事**\n- 一\n  - 二\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  const insert = requests[0]!['insertText'] as { location: { index: number }; text: string };
  assert.equal(insert.location.index, 1);
  assert.equal(insert.text, `提案書\n背景\n本文は大事\n一\n\t二\n${TABLE_MARK(0)}`, '入れ子はタブで表す。表は印の段落');
  const reset = requests[1]!['updateTextStyle'] as { textStyle: object; fields: string };
  assert.deepEqual(reset.textStyle, {});
  assert.ok(reset.fields.includes('weightedFontFamily') && reset.fields.includes('foregroundColor'), '字体と色はスタイルに任せる');
  const styles = requests.filter((r) => r['updateParagraphStyle']).map((r) => (r['updateParagraphStyle'] as { paragraphStyle: { namedStyleType: string } }).paragraphStyle.namedStyleType);
  assert.deepEqual(styles, ['TITLE', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  const bold = requests.find((r) => (r['updateTextStyle'] as { textStyle?: { bold?: boolean } } | undefined)?.textStyle?.bold) as { updateTextStyle: { range: { startIndex: number; endIndex: number } } };
  // 「提案書\n背景\n本文は」の後ろ: 1 + 4 + 3 + 3 = 11
  assert.deepEqual(bold.updateTextStyle.range, { startIndex: 11, endIndex: 13 });
  const bullets = requests.filter((r) => r['createParagraphBullets']);
  assert.equal(bullets.length, 1);
  assert.equal(requests.at(-1), bullets[0], '箇条書きは最後（タブが外れて位置がずれるため）');
  assert.deepEqual(tables, [{ mark: TABLE_MARK(0), rows: [['a', 'b'], ['1', '2']] }]);
});

test('本文を空にする・印を探す・表のます目を後ろから埋める（見出しの行は太字）', () => {
  assert.deepEqual(clearBodyRequests([{ startIndex: 0, endIndex: 1 }, { startIndex: 1, endIndex: 40 }]), [{ deleteContentRange: { range: { startIndex: 1, endIndex: 39 } } }]);
  assert.deepEqual(clearBodyRequests([{ startIndex: 0, endIndex: 1 }, { startIndex: 1, endIndex: 2 }]), [], 'すでに空なら何もしない');
  const mark = TABLE_MARK(2);
  assert.deepEqual(findMark([{ startIndex: 10, endIndex: 30, paragraph: { elements: [{ textRun: { content: `前${mark}\n` } }] } }], mark), { start: 11, end: 11 + mark.length });
  const reqs = fillTableRequests({ table: { tableRows: [
    { tableCells: [{ content: [{ startIndex: 5 }] }, { content: [{ startIndex: 7 }] }] },
    { tableCells: [{ content: [{ startIndex: 10 }] }, { content: [{ startIndex: 12 }] }] },
  ] } }, [['見出し', '値'], ['A', '']]);
  const inserts = reqs.filter((r) => r['insertText']).map((r) => (r['insertText'] as { location: { index: number }; text: string }));
  assert.deepEqual(inserts.map((i) => [i.location.index, i.text]), [[10, 'A'], [7, '値'], [5, '見出し']], '後ろから。空のます目は飛ばす');
  assert.equal(reqs.filter((r) => (r['updateTextStyle'] as { textStyle?: { bold?: boolean } } | undefined)?.textStyle?.bold).length, 2);
});
