/**
 * @file 名刺の裏面の単体テスト（仕様書 第27.5.1節、ADR-0082）。
 * 読み取りの答えの解き方（英語の表記・裏の文・関連会社・商品とサービス・宣伝だけの裏を残す）、連絡先に足す差分（空の英語の欄だけ埋める・
 * 裏の文を置き換える・一覧を足し合わせる）、中身で組にする見分け、並べて撮った表と裏の組み方（中身 → 位置）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_CARD_ENGLISH, EMPTY_CARD_FIELDS, type CardCorners } from '@m2office/shared';
import { backMatches, backPatch, pairByContentThenPosition, parseCardReading } from '../src/index.js';

test('読み取り: 英語の表記・裏の文・関連会社・商品とサービスを読み、宣伝だけの裏も残す', () => {
  const r = parseCardReading(JSON.stringify({ isCard: true, cards: [{
    side: 'back', text: 'グループ会社のご案内', english: { name: 'Taro Yamada', company: 'Mirai Kogyo' }, related: ['ミライ HD', 'ミライ HD'], products: ['ミライ号'],
  }] }));
  assert.equal(r.kind, 'card');
  if (r.kind !== 'card') return;
  const c = r.cards[0]!;
  assert.equal(c.side, 'back');
  assert.deepEqual(c.back, { english: { ...EMPTY_CARD_ENGLISH, name: 'Taro Yamada', company: 'Mirai Kogyo' }, text: 'グループ会社のご案内', related: ['ミライ HD'], products: ['ミライ号'] });
  // 表の面の文は残さない
  const front = parseCardReading(JSON.stringify({ isCard: true, cards: [{ side: 'front', name: '山田', text: '余計な文' }] }));
  assert.equal(front.kind === 'card' && front.cards[0]!.back.text, '');
  // 何も読めない裏は名刺としない
  assert.equal(parseCardReading(JSON.stringify({ isCard: true, cards: [{ side: 'back' }] })).kind, 'not-card');
});

test('連絡先に足す: 英語の欄は空のところだけ埋め、裏の文は置き換え、関連会社と商品は足し合わせる', () => {
  const contact = { english: { ...EMPTY_CARD_ENGLISH, name: '人が直した名前' }, backText: '前の裏', related: ['A'], products: [] };
  const info = { english: { ...EMPTY_CARD_ENGLISH, name: 'Taro', company: 'Mirai' }, text: '新しい裏', related: ['A', 'B'], products: ['P'] };
  assert.deepEqual(backPatch(contact, info, true), {
    english: { ...EMPTY_CARD_ENGLISH, name: '人が直した名前', company: 'Mirai' }, backText: '新しい裏', related: ['A', 'B'], products: ['P'],
  });
  assert.equal(backPatch(contact, info, false).backText, undefined, '表の面からは裏の文を変えない');
  assert.deepEqual(backPatch({ ...contact, english: info.english, related: ['A', 'B'], products: ['P'], backText: '新しい裏' }, info, true), {});
});

test('中身で組にする: メール・電話・ドメイン・会社名（日本語か英語）のどれかが合えば同じ名刺の裏', () => {
  const front = { ...EMPTY_CARD_FIELDS, company: '株式会社ミライ工業', emails: ['t@mirai.example'], english: { company: 'Mirai Kogyo Co., Ltd.' } };
  const back = (f: Partial<typeof EMPTY_CARD_FIELDS>, en: Partial<typeof EMPTY_CARD_ENGLISH> = {}) => ({ fields: { ...EMPTY_CARD_FIELDS, ...f }, info: { english: { ...EMPTY_CARD_ENGLISH, ...en }, text: '', related: [], products: [] } });
  assert.equal(backMatches(front, back({ website: 'https://www.mirai.example/about' })), true, 'ドメイン');
  assert.equal(backMatches(front, back({}, { company: 'MIRAI KOGYO' })), true, '英語の会社名');
  assert.equal(backMatches(front, back({ company: 'ミライ工業' })), true, '会社名を含む');
  assert.equal(backMatches(front, back({ website: 'https://other.example' }, { company: 'Other Inc.' })), false);
});

test('並べて撮った表と裏: 中身で組にし、残りは位置（上から下・左から右）の順で組にする', () => {
  const box = (x: number, y: number): CardCorners => [[x, y], [x + 100, y], [x + 100, y + 60], [x, y + 60]];
  const fronts = [{ id: 'f1', c: box(100, 100), co: 'A' }, { id: 'f2', c: box(500, 100), co: 'B' }, { id: 'f3', c: box(100, 500), co: 'C' }];
  const backs = [{ c: box(500, 500), co: 'A' }, { c: box(500, 100), co: '' }, { c: box(100, 100), co: '' }];
  const pairs = pairByContentThenPosition(fronts, backs, (f, b) => !!b.co && f.co === b.co, (f) => f.c, (b) => b.c);
  assert.equal(pairs.get(0), 0, '中身で A の表');
  // 残りの表（f2・f3）と裏（1・2）は、位置の順（裏 2 → f2、裏 1 → f3）
  assert.equal(pairs.get(2), 1);
  assert.equal(pairs.get(1), 2);
});
