/**
 * @file 名刺の切り出しの計算の単体テスト（仕様書 第27.5節「向きと切り出し」）。
 *
 * 長方形を四角形に写す変換が四隅を合わせること、切り出す大きさと外への広げ方、逆さの名刺が正しい向きに写ることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropPlan, homography, project } from '../src/card-image.js';

const near = (a: [number, number], b: [number, number], msg: string) =>
  assert.ok(Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6, `${msg}: ${a} と ${b}`);

test('射影変換: 長方形の四隅を、傾いた四角形の四隅に写す', () => {
  const quad: [[number, number], [number, number], [number, number], [number, number]] = [[120, 80], [900, 140], [860, 620], [90, 560]];
  const hm = homography(quad, 910, 550);
  near(project(hm, 0, 0), quad[0], '左上');
  near(project(hm, 910, 0), quad[1], '右上');
  near(project(hm, 910, 550), quad[2], '右下');
  near(project(hm, 0, 550), quad[3], '左下');
  assert.throws(() => homography([[0, 0], [1, 1], [2, 2], [3, 3]], 10, 10), /一直線/);
});

test('逆さの名刺: 文字の左上が画像の右下にある四隅なら、切り出した画像の左上は元の右下から取る', () => {
  const plan = cropPlan([[900, 900], [100, 900], [100, 400], [900, 400]], 1000, 1000);
  const hm = homography(plan.quad, plan.width, plan.height);
  const [x, y] = project(hm, 0, 0);
  assert.ok(x > 890 && y > 890, `左上は元の右下の近く: ${x}, ${y}`);
});

test('切り出す大きさ: 名刺の縦横の比を保ち、長い辺は 1,400 画素まで。端を切らないよう少し外へ広げ、画像の外には出さない', () => {
  const plan = cropPlan([[0, 0], [1000, 0], [1000, 600], [0, 600]], 4000, 3000);
  assert.equal(plan.width, 1400);
  assert.ok(Math.abs(plan.height / plan.width - (1800 / 4000) * 1.0) < 0.02, `縦横の比 ${plan.height / plan.width}`);
  assert.deepEqual(plan.quad[0], [0, 0], '画像の外に出さない');
  const small = cropPlan([[400, 400], [600, 400], [600, 520], [400, 520]], 1000, 1000);
  assert.ok(small.quad[0][0] < 400 && small.quad[2][0] > 600, '外へ広げる');
  assert.ok(small.width <= 1400 && small.width > 200);
});
