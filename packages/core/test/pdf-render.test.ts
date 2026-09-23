/**
 * @file 帳票の PDF 出力の単体テスト。
 *
 * 日本語が埋め込まれて読み返せること、書体を丸ごと入れないこと、金額の計算を確かめる。
 *
 * @see 仕様書 第9.4.1節、Q-59、ADR-0017
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, renderPdf, rowAmount, yen } from '../src/index.js';

const DOC = {
  title: '請求書',
  to: '株式会社アルファ 御中',
  from: ['M2ホールディングス株式会社'],
  fields: [{ label: '発行日', value: '2026-09-23' }],
  rows: [
    { name: '月額利用料（9 月分）', quantity: 10, unitPrice: 3000 },
    { name: '初期設定の支援', quantity: 1, unitPrice: 50000 },
  ],
  notes: ['お支払い期限: 2026-10-31'],
};

test('明細の金額は数量×単価。指定があればそれを使う', () => {
  assert.equal(rowAmount({ name: 'a', quantity: 3, unitPrice: 200 }), 600);
  assert.equal(rowAmount({ name: 'a', quantity: 3, unitPrice: 200, amount: 500 }), 500);
  assert.equal(rowAmount({ name: 'a' }), 0);
  assert.equal(yen(1234567.4), '1,234,567');
});

test('日本語の帳票を作り、同じ文字を読み返せる', async () => {
  const bytes = await renderPdf(DOC);
  assert.ok(bytes.byteLength > 1000);
  const text = (await extractPdfText(bytes)).pages[0]?.text ?? '';
  for (const expected of ['請求書', '株式会社アルファ 御中', '月額利用料（9 月分）', '初期設定の支援', 'お支払い期限: 2026-10-31']) {
    assert.ok(text.includes(expected), `${expected} が読み返せない: ${text}`);
  }
  // 合計は明細から求める（80,000）
  assert.ok(text.includes('80,000'), text);
});

test('書体は使った文字だけを埋め込む（丸ごと入れない）', async () => {
  const bytes = await renderPdf(DOC);
  // 書体のファイルは 1 つ 5 MB ある。サブセットが効いていれば帳票は 1 MB に満たない
  assert.ok(bytes.byteLength < 1_000_000, `大きすぎます: ${bytes.byteLength}`);
});

test('明細が多い帳票は次のページへ送る', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ name: `品目 ${i + 1}`, quantity: 1, unitPrice: 100 }));
  const out = await extractPdfText(await renderPdf({ title: '請求書', rows }));
  assert.ok(out.pageCount >= 2, `ページが増えない: ${out.pageCount}`);
  assert.ok((out.pages.at(-1)?.text ?? '').includes('8,000'), '合計が最後のページにある');
});
