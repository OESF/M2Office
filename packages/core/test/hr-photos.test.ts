/**
 * @file 従業員の顔写真を人に当てる処理の単体テスト（仕様書 第30.5.4節、ADR-0055）。
 *
 * ファイル名（社員番号・氏名・ふりがな）での当て方、同じ名前の人がいるときに当てないこと、
 * 写真の中の名札の読み取りの答えの読み方、画像の種類の見分け方を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HrEmployee } from '@m2office/shared';
import { matchPhotoText, parseNameTag, photoMime } from '../src/index.js';

const person = (id: string, name: string, kana: string, code: string): HrEmployee => ({
  id, code, name, kana, birthDate: null, gender: '', address: '', phone: '', email: '', hiredOn: '2020-04-01', leftOn: null,
  leaveReason: '', employment: 'regular', category: 'employee', department: '', title: '', userId: null, status: 'active', note: '', updatedAt: '',
});
const staff = [
  person('e1', '山田 太郎', 'やまだ たろう', '0012'),
  person('e2', '佐藤 花子', 'さとう はなこ', '0013'),
  person('e3', '佐藤 一郎', 'さとう いちろう', '0120'),
];
const who = (text: string) => { const r = matchPhotoText(text, staff); return 'employee' in r ? r.employee.id : r.reason; };

test('顔写真: ファイル名の社員番号・氏名（空白や全角の違いを問わない）・ふりがなで 1 人に当てる', () => {
  assert.equal(who('0012.jpg'), 'e1');
  assert.equal(who('００１３_写真.JPG'), 'e2', '全角の社員番号');
  assert.equal(who('山田太郎.png'), 'e1', '空白の無い氏名');
  assert.equal(who('2024 佐藤　一郎 顔.jpeg'), 'e3', '全角の空白');
  assert.equal(who('さとう_はなこ.jpg'), 'e2', 'ふりがな');
});

test('顔写真: 社員番号は区切られた語だけ・同じ名字だけでは当てない', () => {
  assert.match(who('IMG_00120012.jpg'), /台帳に当たる人がいません/, '番号が区切られていなければ当てない');
  assert.match(who('佐藤.jpg'), /台帳に当たる人がいません/, '名字だけ（氏名に含まれない）');
  assert.match(who('DSC0001.jpg'), /台帳に当たる人がいません/);
  const twins = [...staff, person('e4', '山田 太郎', 'やまだ たろう', '')];
  const r = matchPhotoText('山田太郎.jpg', twins);
  assert.ok('reason' in r && /同じ名前の人が 2 人/.test(r.reason), '同じ名前の人がいれば当てずに社員番号を求める');
});

test('顔写真: 名札の読み取りの答えを読み、書かれていなければ当てない', () => {
  assert.deepEqual(parseNameTag('{"name": "佐藤 花子", "code": null}'), { name: '佐藤 花子', code: '' });
  assert.deepEqual(parseNameTag('結果: {"name": null, "code": "0120"}'), { name: '', code: '0120' });
  assert.equal(parseNameTag('{"name": null, "code": null}'), null);
  assert.equal(parseNameTag('読めません'), null);
});

test('顔写真: JPEG と PNG だけを受け取る', () => {
  assert.equal(photoMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(photoMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d])), 'image/png');
  assert.equal(photoMime(new TextEncoder().encode('<svg></svg>')), null);
});
