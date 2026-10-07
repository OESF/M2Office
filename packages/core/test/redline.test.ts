/**
 * @file 修正の案を Word の変更履歴として入れる仕組みの単体テスト（仕様書 第28.15節、ADR-0083、Q-98）。
 * 空白の違いを吸収して元の文を探すこと、段落の中に削除と挿入の印とコメントを入れること、ほかの段落を変えないこと、
 * 1 つの段落に 2 つの修正、見つからない修正を最後に並べることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { findRange, redlineDocx } from '../src/files/redline.js';
import { renderDocx } from '../src/files/docx.js';

test('元の文を探す: 空白と全角・半角の違いを吸収する', () => {
  assert.deepEqual(findRange('第 5 条　受託者は、損害を賠償する。', '受託者は、損害を 賠償する'), { start: 6, end: 18 });
  assert.equal(findRange('第 5 条', '第 6 条'), null);
  assert.deepEqual(findRange('㈱ミライの責任', 'ミライ'), { start: 1, end: 4 }, 'そろえて字数が変わっても元の位置');
});

test('変更履歴: 削除と挿入とコメントを入れ、ほかの段落は変えず、見つからない修正は最後に並べる', async () => {
  const src = await renderDocx('業務委託契約書', [
    { text: '第 1 条 本契約は業務の委託について定める。' },
    { text: '第 5 条 受託者は、一切の損害を賠償する。支払いは 120 日以内とする。' },
  ]);
  const r = await redlineDocx(src, [
    { before: '一切の損害', after: '直接かつ通常の損害（委託料の総額を上限とする）', reason: '上限の無い損害賠償は当社に不利になりうるため' },
    { before: '120 日以内', after: '60 日以内' },
    { before: '存在しない条文', after: 'x', reason: '見つからない' },
  ], 'M2Office（修正の案）', new Date('2026-10-07T00:00:00Z'));
  assert.equal(r.applied, 2);
  assert.equal(r.unapplied.length, 1);
  const zip = await JSZip.loadAsync(r.bytes);
  const doc = await zip.file('word/document.xml')!.async('string');
  assert.match(doc, /<w:del [^>]*w:author="M2Office（修正の案）"[^>]*><w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:delText xml:space="preserve">一切の損害<\/w:delText>/);
  assert.match(doc, /<w:ins [^>]*><w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t xml:space="preserve">直接かつ通常の損害（委託料の総額を上限とする）<\/w:t>/);
  assert.match(doc, /<w:delText xml:space="preserve">120 日以内<\/w:delText>/);
  assert.match(doc, /第 1 条 本契約は業務の委託について定める。/, 'ほかの段落はそのまま');
  assert.match(doc, /変更履歴にできなかった修正の案/);
  assert.match(doc, /元の文: 存在しない条文/);
  const comments = await zip.file('word/comments.xml')!.async('string');
  assert.match(comments, /上限の無い損害賠償は当社に不利になりうるため/);
  assert.match(await zip.file('[Content_Types].xml')!.async('string'), /\/word\/comments\.xml/);
  assert.match(await zip.file('word/_rels/document.xml.rels')!.async('string'), /relationships\/comments/);
});
