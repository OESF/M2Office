/**
 * @file バーコードの値を解く処理の単体テスト（仕様書 第29.8節・第29.11節）。
 *
 * GS1 の区切りの形と括弧の形、使用期限の日が 00 の扱い、JAN・UPC の検査数字、解けない値をそのまま返すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gs1Date, parseCode, validGtin } from '../src/inventory/gs1.js';

const GS = '\u001d';

test('GS1: 区切りの形から、商品コード・使用期限・ロットを取り出し、JAN に直す', () => {
  const r = parseCode(`]C10104912345678904${'17'}271231${'10'}AB12C${GS}21SER1`);
  assert.equal(r.kind, 'gs1');
  assert.equal(r.gtin, '04912345678904');
  assert.equal(r.code, '4912345678904');
  assert.equal(r.expiresOn, '2027-12-31');
  assert.equal(r.lot, 'AB12C');
});

test('GS1: 括弧の形も読む。期限の日が 00 なら月末', () => {
  const r = parseCode('(01)04912345678904(17)270200(10)LOT-9');
  assert.equal(r.kind, 'gs1');
  assert.equal(r.code, '4912345678904');
  assert.equal(r.expiresOn, '2027-02-28');
  assert.equal(r.lot, 'LOT-9');
});

test('JAN・UPC: 検査数字が正しいものだけを商品コードとして扱う。UPC は 13 桁にそろえる', () => {
  assert.equal(validGtin('4901234567894'), true);
  const jan = parseCode('4901234567894');
  assert.deepEqual([jan.kind, jan.code], ['ean', '4901234567894']);
  const upc = parseCode('036000291452');
  assert.deepEqual([upc.kind, upc.code], ['ean', '0036000291452']);
  const bad = parseCode('4901234567890');
  assert.equal(bad.kind, 'other', '検査数字が合わなければ商品コードとみなさない');
});

test('解けない値（棚のラベルの QR など）は、そのまま返し、推測で期限やロットを作らない', () => {
  const r = parseCode('m2o-shelf:abc123');
  assert.deepEqual(r, { code: 'm2o-shelf:abc123', gtin: null, expiresOn: null, lot: null, kind: 'other' });
  assert.equal(gs1Date('271331'), null, '13 月は無い');
  assert.equal(gs1Date('270231'), null, '2 月 31 日は無い');
});
