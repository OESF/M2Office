/**
 * @file 2026-10-12 の点検で直した、外へ送る前の宛先の確かめと、CSV の数式の注入の防ぎの単体テスト。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutboundUrl, isForbiddenAddress, outboundPolicy } from '../src/net/outbound.js';
import { csvSafeText } from '../src/files/sheet.js';

test('宛先の決まり: クラウドの本番は社内のアドレスをすべて断り、ローカルの形はクラウドの管理用だけを断る', async () => {
  assert.equal(outboundPolicy({ NODE_ENV: 'production' }), 'strict');
  assert.equal(outboundPolicy({ NODE_ENV: 'production', M2O_DEPLOYMENT: 'onsite' }), 'lan');
  assert.equal(outboundPolicy({ NODE_ENV: 'development' }), 'dev');
  for (const a of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '::1', 'fd00::1']) assert.ok(isForbiddenAddress(a, 'strict'), a);
  assert.ok(!isForbiddenAddress('93.184.216.34', 'strict'));
  assert.ok(isForbiddenAddress('169.254.169.254', 'lan'), 'ローカルの形でもクラウドの管理用は断る');
  assert.ok(!isForbiddenAddress('192.168.1.10', 'lan'), 'ローカルの形では社内の LAN を通す');
  assert.ok(!isForbiddenAddress('10.0.0.5', 'dev'));
  assert.equal(await checkOutboundUrl('http://169.254.169.254/latest/meta-data', 'strict'), '社内のアドレスには送りません');
  assert.equal(await checkOutboundUrl('http://127.0.0.1:11434/', 'strict'), '社内のアドレスには送りません');
  assert.equal(await checkOutboundUrl('http://[::1]/', 'lan'), null, 'ローカルの形では同じ機械を通す');
  assert.equal(await checkOutboundUrl('file:///etc/passwd', 'strict'), 'http か https の URL だけに送ります');
  assert.equal(await checkOutboundUrl('https://u:p@93.184.216.34/', 'strict'), 'ID やパスワードを含む URL には送りません');
});

test('CSV: 式として動く値の先頭に印を付け、電話番号やマイナスの数は変えない', () => {
  assert.equal(csvSafeText('=HYPERLINK("https://evil.example","x")'), `'=HYPERLINK("https://evil.example","x")`);
  assert.equal(csvSafeText('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(csvSafeText('+cmd|calc'), `'+cmd|calc`);
  assert.equal(csvSafeText('-2+3+cmd'), `'-2+3+cmd`);
  assert.equal(csvSafeText('+81-3-1234-5678'), '+81-3-1234-5678', '電話番号は変えない');
  assert.equal(csvSafeText('-5'), '-5');
  assert.equal(csvSafeText('山田 太郎'), '山田 太郎');
});
