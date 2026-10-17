/**
 * @file 脆弱性の報告の窓口（security.txt。RFC 9116。仕様書 第16.11.3節 G-11）の単体テスト。
 *
 * 連絡先が無ければ出さないこと、形の合わない連絡先を落とすこと、有効期限と正式な URL を付けることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityTxt } from '../src/routes/security-txt.js';

test('security.txt: 連絡先が無ければ出さず、あれば有効期限と正式な URL を付ける', () => {
  assert.equal(securityTxt([''], 'https://a.example.jp/.well-known/security.txt'), null);
  assert.equal(securityTxt(['javascript:alert(1)', 'mail me'], 'https://a.example.jp/.well-known/security.txt'), null, '形の合わない連絡先は落とす');
  const body = securityTxt([' mailto:security@example.jp', 'https://example.jp/security'], 'https://a.example.jp/.well-known/security.txt', new Date('2026-10-17T00:00:00Z'))!;
  assert.match(body, /^Contact: mailto:security@example\.jp\nContact: https:\/\/example\.jp\/security\n/);
  assert.match(body, /Expires: 2027-04-15T00:00:00Z/, '有効期限は 180 日後');
  assert.match(body, /Canonical: https:\/\/a\.example\.jp\/\.well-known\/security\.txt/);
});
