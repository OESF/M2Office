/**
 * @file 帳票の PDF 出力の単体テスト。
 *
 * 日本語が埋め込まれて読み返せること、書体を丸ごと入れないこと、金額の計算を確かめる。
 *
 * @see 仕様書 第9.4.1節、Q-59、ADR-0017
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OCR_MAX_PAGES, REPLACEMENT, extractPages, extractPdfText, missingCharacters, renderPdf, rowAmount, yen,
} from '../src/index.js';

const DOC = {
  title: '請求書',
  to: '株式会社アルファ 御中',
  from: ['見本商事株式会社'],
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

test('書体はそのまま埋め込む（使った字だけを抜き出すと字の形が落ちた。ADR-0017 の改め）', async () => {
  const bytes = await renderPdf(DOC);
  // 同梱の書体（通常と太字）は 1 つ約 1.5 MB。そのまま入れれば帳票は数 MB になり、抜き出しに戻れば数十 KB になる
  assert.ok(bytes.byteLength > 2_000_000 && bytes.byteLength < 5_000_000, `大きさが想定と違います: ${bytes.byteLength}`);
});

test('明細が多い帳票は次のページへ送る', async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ name: `品目 ${i + 1}`, quantity: 1, unitPrice: 100 }));
  const out = await extractPdfText(await renderPdf({ title: '請求書', rows }));
  assert.ok(out.pageCount >= 2, `ページが増えない: ${out.pageCount}`);
  assert.ok((out.pages.at(-1)?.text ?? '').includes('8,000'), '合計が最後のページにある');
});

test('同梱した書体に無い字は、置き換えたうえで知らせる（Q-59）', async () => {
  // 鷗（かもめ）と 𠮷（つちよし）は同梱の範囲の外
  assert.deepEqual(await missingCharacters(['鷗外商会', '請求書']), ['鷗']);
  assert.deepEqual(await missingCharacters(['𠮷田さん']), ['𠮷'], '2 文字分の字も 1 字として数える');
  // 人名でよく使う異体字（髙・﨑）は範囲に入っている
  assert.deepEqual(await missingCharacters(['髙橋さん', '﨑山さん', '請求書 合計 1,000 円 ㈱ ①']), []);

  const text = (await extractPdfText(await renderPdf({ title: '請求書', rows: [{ name: '鷗外商会', amount: 100 }] })))
    .pages[0]?.text ?? '';
  assert.ok(text.includes(`${REPLACEMENT}外商会`), `置き換わっていない: ${text}`);
});

test('読めないページだけを抜き出す（第9.4.1節）', async () => {
  // 3 ページの PDF を作り、2 ページ目だけを抜き出す
  const rows = Array.from({ length: 160 }, (_, i) => ({ name: `品目 ${i + 1}`, quantity: 1, unitPrice: 100 }));
  const whole = await renderPdf({ title: '一覧', rows });
  const pageCount = (await extractPdfText(whole)).pageCount;
  assert.ok(pageCount >= 3, `ページが足りません: ${pageCount}`);

  const part = await extractPages(whole, [2]);
  assert.ok(part);
  assert.equal((await extractPdfText(part)).pageCount, 1);
  assert.equal(
    (await extractPdfText(part)).pages[0]?.text,
    (await extractPdfText(whole)).pages[1]?.text,
    '抜き出したページの中身が一致する',
  );

  // 無いページは落とす。1 つも残らなければ null
  assert.equal((await extractPdfText((await extractPages(whole, [99, 1]))!)).pageCount, 1);
  assert.equal(await extractPages(whole, [99]), null);

  // 上限を超える指定は、先頭から上限までにする
  const many = await extractPages(whole, Array.from({ length: OCR_MAX_PAGES + 5 }, (_, i) => i + 1));
  assert.equal((await extractPdfText(many!)).pageCount, Math.min(OCR_MAX_PAGES, pageCount));
});

test('会社の帳票の体裁を帳票に出す（第15.2.2節、Q-57）', async () => {
  // 1×1 の PNG（ロゴの代わり）
  const logo = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const bytes = await renderPdf({
    title: '請求書',
    rows: [{ name: '月額利用料', quantity: 1, unitPrice: 30000 }],
    notes: ['この帳票だけの備考'],
    style: {
      logo: { bytes: logo, kind: 'png' },
      from: ['見本商事株式会社', '東京都…', '登録番号 T1234567890123'],
      bankAccount: '○○銀行 △△支店 普通 1234567',
      notes: '振込手数料は貴社にてご負担ください',
      sealBox: true,
    },
  });
  const text = (await extractPdfText(bytes)).pages[0]?.text ?? '';
  for (const expected of [
    '見本商事株式会社', '登録番号 T1234567890123', '印',
    'お振込先: ○○銀行 △△支店 普通 1234567', 'この帳票だけの備考', '振込手数料は貴社にてご負担ください',
  ]) {
    assert.ok(text.includes(expected), `${expected} が出ていない: ${text}`);
  }
  // 振込先は、帳票ごとの備考より前に出す
  assert.ok(text.indexOf('お振込先') < text.indexOf('この帳票だけの備考'));
});

test('体裁が未設定でも帳票は出せる（無い欄は出さない）', async () => {
  const text = (await extractPdfText(await renderPdf({ title: '請求書', rows: [{ name: '品目', amount: 100 }] })))
    .pages[0]?.text ?? '';
  assert.ok(text.includes('請求書'));
  assert.equal(text.includes('お振込先'), false);
  assert.equal(text.includes('印'), false);
});
