/**
 * @file 上の帯の版の表示と Google のアプリの一覧の単体テスト。版の食い違いの判定と、並べるリンクが本人のアカウントだけを載せること。
 *
 * @see 仕様書 第6.1.1.1節 版の表示
 * @see 仕様書 第6.1.1.2節 Google のサービスへのリンク
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleLinks } from '../src/google-links.js';
import { APP_VERSION, versionMismatch } from '../src/version.js';

test('版が違うときだけ「新しい版があります」と判定する', () => {
  assert.equal(versionMismatch('0.5.0', '0.6.0'), true);
  assert.equal(versionMismatch('0.5.0', '0.5.0'), false);
});

test('どちらかの版が分からないときは、食い違いと言わない', () => {
  assert.equal(versionMismatch(null, '0.5.0'), false);
  assert.equal(versionMismatch('0.5.0', null), false);
  assert.equal(versionMismatch('0.5.0', undefined), false);
});

test('ビルドで埋め込まれていないときは、画面の版を推測で埋めない', () => {
  assert.equal(APP_VERSION, null);
});

test('Google のアプリは 10 個を並べ、どれも Google のアドレスを本人のアカウントで開く', () => {
  const links = googleLinks('taro+work@example.co.jp');
  assert.deepEqual(links.map((l) => l.label), [
    'Gmail', 'カレンダー', 'ToDo', 'Chat', 'ドライブ', 'ドキュメント', 'スプレッドシート', 'スライド', 'Meet', 'フォーム',
  ]);
  for (const l of links) {
    const u = new URL(l.href);
    assert.equal(u.protocol, 'https:');
    assert.ok(u.hostname.endsWith('.google.com'), l.href);
    // 載せるのはアカウントの指定だけ（仕様書 第6.1.1.2節「送るもの」）
    assert.deepEqual([...u.searchParams.keys()], ['authuser']);
    assert.equal(u.searchParams.get('authuser'), 'taro+work@example.co.jp');
  }
});

test('管理コンソールは管理者にだけ並べる', () => {
  assert.equal(googleLinks('a@example.com').some((l) => l.label === '管理コンソール'), false);
  const admin = googleLinks('a@example.com', { admin: true });
  assert.equal(admin.at(-1)?.label, '管理コンソール');
  assert.equal(new URL(admin.at(-1)!.href).hostname, 'admin.google.com');
});

test('メールアドレスが無ければ、アカウントを指定せずに開く', () => {
  assert.equal(googleLinks('')[0]?.href, 'https://mail.google.com/mail/');
});
