/**
 * @file 画面の CSS の印刷の決まりの単体テスト。ある画面だけを印刷するための「全体を隠す」決まりが、ほかの画面の印刷を白紙にしないことと、
 * 画面の土台がはみ出しを切る決まりが、長い画面の印刷を 1 ページめで終わらせないことを確かめる。
 *
 * @see 仕様書 第23.4.5節（請求書の印刷）・第6.1節（画面の土台）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** `@media print { … }` の中身を、入れ子の括弧を数えて取り出す。 */
function printBlocks(css: string): string[] {
  const blocks: string[] = [];
  for (let at = css.indexOf('@media print'); at >= 0; at = css.indexOf('@media print', at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { blocks.push(css.slice(open + 1, i)); break; }
    }
  }
  return blocks;
}

test('印刷で全体を隠す決まりは、その画面を開いているときだけに絞る（請求書のほかの印刷を白紙にしない）', () => {
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  const blocks = printBlocks(css);
  assert.ok(blocks.length > 0, '印刷の決まりを読めた');
  for (const block of blocks) {
    for (const rule of block.split('}')) {
      const selectors = rule.split('{')[0] ?? '';
      const body = rule.split('{')[1] ?? '';
      if (!/visibility:\s*hidden/.test(body)) continue;
      for (const sel of selectors.split(',').map((x) => x.trim()).filter(Boolean)) {
        assert.ok(!/^(body|html|\*)(\s|$)/.test(sel), `「${sel}」は画面を限らずに全体を隠す`);
      }
    }
  }
  assert.match(css, /body:has\(\.invoice-overlay\) \* \{ visibility: hidden; \}/);
});

test('画面の土台ははみ出しを切るが、印刷では切らない（長い画面の印刷を 1 ページめで終わらせない）', () => {
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /^\.app \{[^}]*overflow: hidden;/m, '画面では切る（ページ全体を動かさない）');
  assert.ok(printBlocks(css).some((b) => /(^|\s)\.app \{[^}]*overflow: visible;/.test(b)), '印刷では切らない');
});
