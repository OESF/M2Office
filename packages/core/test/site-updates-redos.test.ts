/**
 * @file 長い・壊れた HTML と DESIGN.md で、読み取りが遅くならないこと（2026-11-13 の CodeQL の指摘。正規表現の組み合わせの爆発）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText, stripTags, scanHtml, segmentContent, pageImages, editPageImage, navLinks, readYamlMap, parseDesignMd } from '../src/index.js';

const N = 60_000;
const within = (label: string, ms: number, fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  const took = performance.now() - t0;
  assert.ok(took < ms, `${label} が ${Math.round(took)}ms かかった`);
};

test('読み取りの速さ: 閉じない注釈・札・印、長い空白と数の並びでも、すぐに終わる', () => {
  within('閉じない注釈', 500, () => plainText('<!--'.repeat(N)));
  within('閉じない札', 500, () => plainText('<a'.repeat(N)));
  within('「<」の並び', 500, () => stripTags('<'.repeat(N)));
  within('分ける', 1000, () => segmentContent(`<p>${'<!--'.repeat(N)}</p>`));
  within('画像の印', 500, () => pageImages('<!-- wp:image'.repeat(N)));
  within('画像の属性の空白', 500, () => editPageImage(`<img src="a.png"${' '.repeat(N)}`, 1, { alt: 'x' }));
  within('リンクのブロック', 500, () => navLinks('<!-- wp:navigation-link {{'.repeat(N)));
  within('YAML の空白', 500, () => readYamlMap(`${' '.repeat(N)}a${' '.repeat(N)}: b`));
  within('DESIGN.md の空白', 500, () => parseDesignMd(`---\nname: x${' '.repeat(N)}y\n---\n`));
});

test('札を外す: 文と札と注釈を分け、閉じない札は文として残し、文字の参照は 1 回だけ戻す', () => {
  assert.deepEqual(scanHtml('a<b>c</b><!-- x -->d<e').map((t) => t.kind), ['text', 'tag', 'text', 'tag', 'comment', 'text']);
  assert.equal(stripTags('<p>営業<b>時間</b></p>'), '営業時間');
  assert.equal(plainText('<p>A&amp;lt;B</p><script>alert(1)</script><p>C</p>'), 'A&lt;B C', '戻した文をもう一度戻さない・スクリプトの中身は捨てる');
  assert.equal(plainText('1<br>2'), '1\n2');
});
