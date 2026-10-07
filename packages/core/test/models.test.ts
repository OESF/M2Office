/**
 * @file 既定のモデルと費用の計算の単体テスト（仕様書 第20.2.2節・第21.4.1節）。
 *
 * 費用を少なく見せないこと、「そのときの最新」を指す別名を既定にしないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODELS, MODEL_PRICES, UNKNOWN_MODEL_PRICE, costJpy, isHotSwapAlias, usdJpy,
  DEFAULT_IMAGE_MODEL, imageModel,
} from '../src/index.js';

test('既定のモデルは、値段の分かっているものだけを使う', () => {
  for (const [tier, model] of Object.entries(DEFAULT_MODELS)) {
    assert.ok(MODEL_PRICES[model], `${tier} の既定 ${model} が値段の表に無い`);
  }
});

test('既定に「そのときの最新」を指す別名を使わない（中身が入れ替わる）', () => {
  for (const [tier, model] of Object.entries(DEFAULT_MODELS)) {
    assert.equal(isHotSwapAlias(model), false, `${tier} の既定 ${model} は入れ替わる別名`);
  }
  assert.equal(isHotSwapAlias('gemini-flash-latest'), true);
  assert.equal(isHotSwapAlias('gemini-3.5-flash-lite'), false);
});

test('高速の既定は、標準より高くない', () => {
  const fast = MODEL_PRICES[DEFAULT_MODELS.fast]!;
  const standard = MODEL_PRICES[DEFAULT_MODELS.standard]!;
  assert.ok(fast.inputUsd <= standard.inputUsd && fast.outputUsd <= standard.outputUsd);
});

test('入力と出力を分けて、モデルごとの単価で計算する（仕様書 第21.4.1節）', () => {
  // gemini-3.5-flash-lite: 入力 $0.30 / 出力 $2.50、為替 155 円
  const yen = costJpy('gemini-3.5-flash-lite', 1_000_000, 0);
  assert.equal(yen, Math.round(0.30 * usdJpy() * 10_000) / 10_000);
  // 出力は入力より高い。まとめて数えると実態から外れる
  assert.ok(costJpy('gemini-3.5-flash-lite', 0, 1_000_000) > yen * 8);
});

test('models/ の前置きが付いていても、同じ単価で計算する', () => {
  assert.equal(
    costJpy('models/gemini-3.5-flash-lite', 1000, 1000),
    costJpy('gemini-3.5-flash-lite', 1000, 1000),
  );
});

test('値段の分からないモデルは、最も高い単価で見積もる（少なく見せない）', () => {
  const unknown = costJpy('まだ知らないモデル', 1_000_000, 1_000_000);
  const highest = Math.max(...Object.values(MODEL_PRICES).map((p) => p.inputUsd + p.outputUsd));
  assert.ok(UNKNOWN_MODEL_PRICE.inputUsd + UNKNOWN_MODEL_PRICE.outputUsd >= highest);
  for (const [name, p] of Object.entries(MODEL_PRICES)) {
    assert.ok(unknown >= costJpy(name, 1_000_000, 1_000_000), `${name} より安く見積もっている`);
    // 埋め込みのモデルは出力が無い（入力だけに値段が付く）
    if (!/embedding/.test(name)) assert.ok(p.outputUsd > p.inputUsd, `${name} の出力が入力より安い（表の写し間違い）`);
  }
});

test('為替は環境変数で変えられ、おかしな値は既定に戻す', () => {
  assert.equal(usdJpy({ USD_JPY: '160' }), 160);
  assert.equal(usdJpy({ USD_JPY: '0' }), 155);
  assert.equal(usdJpy({ USD_JPY: 'いくら' }), 155);
  assert.equal(usdJpy({}), 155);
});

test('画像のモデル: 既定は Nano Banana 2.1（終了する gemini-3.1-flash-image を使わない）。MODEL_IMAGE で変えられる', () => {
  const saved = process.env['MODEL_IMAGE'];
  try {
    delete process.env['MODEL_IMAGE'];
    assert.equal(imageModel(), 'gemini-nano-banana-2.1');
    assert.equal(DEFAULT_IMAGE_MODEL, 'gemini-nano-banana-2.1');
    process.env['MODEL_IMAGE'] = '  gemini-next-image  ';
    assert.equal(imageModel(), 'gemini-next-image');
    process.env['MODEL_IMAGE'] = ' ';
    assert.equal(imageModel(), 'gemini-nano-banana-2.1');
  } finally {
    if (saved === undefined) delete process.env['MODEL_IMAGE'];
    else process.env['MODEL_IMAGE'] = saved;
  }
});
