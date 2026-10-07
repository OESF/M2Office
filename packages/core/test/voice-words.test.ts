/**
 * @file 音声の固有名詞の聞き違えを直す仕組みの単体テスト（仕様書 第10.5.9節）。
 * 手がかりの言葉の集め方（社内の人と姓・会社の名前・名刺の相手・本人が直した言葉・上限）、聞き取りの直し方
 * （読みと同じかな・3 字に満たない読みは直さない・前に直された聞き違え）、「〇〇じゃなくて△△」の見分けと覚え方を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS } from '@m2office/shared';
import { addMishear, correctHeard, mishearOf, toKatakana, voiceWords, voiceWordsLine, type Repository } from '../src/index.js';

const repo = {
  listUsers: async () => [
    { id: 'u1', displayName: '三上 健', status: 'active' },
    { id: 'u2', displayName: '大野 花', status: 'active' },
    { id: 'u3', displayName: '退職 者', status: 'disabled' },
  ],
  getUserSettings: async (_t: string, u: string) => ({
    ...structuredClone(DEFAULT_USER_SETTINGS),
    profile: { ...DEFAULT_USER_SETTINGS.profile, furigana: u === 'u1' ? 'みかみ けん' : u === 'u2' ? 'おおの はな' : '' },
    secretary: { ...DEFAULT_USER_SETTINGS.secretary, mishears: u === 'u1' ? [{ heard: '見積もり課', meant: '見積課' }] : [] },
  }),
  getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, company: { ...DEFAULT_TENANT_SETTINGS.company, shortName: 'アルファ' } }),
} as unknown as Repository;

test('手がかり: 本人が直した言葉・会社の名前・社内の人（と姓）・名刺の相手を集める。止めた人は入れない', async () => {
  const words = await voiceWords({ repo, contacts: async () => [{ name: '山本 一郎', nameKana: 'やまもと いちろう', company: 'ミライ工業' }] }, 't1', 'u1');
  const terms = words.map((w) => w.term);
  assert.deepEqual(terms, ['見積課', 'アルファ', '三上 健', '三上', '大野 花', '大野', '山本 一郎', '山本', 'ミライ工業']);
  assert.equal(words.find((w) => w.term === '三上')?.reading, 'ミカミ');
  assert.match(voiceWordsLine(words), /^聞き取りの手がかり（社内の人・取引先・会社の言葉）: 見積課、アルファ、/);
  assert.equal(voiceWordsLine([]), '');
  assert.equal(toKatakana('やまだ たろう'), 'ヤマダタロウ');
});

test('直し: 読みと同じかなを書き方に直す。3 字に満たない読みと、すでに正しいものは直さない。直された聞き違えも使う', () => {
  const words = [{ term: '三上', reading: 'ミカミ' }, { term: '大野', reading: 'オオノ' }, { term: '小野', reading: 'オノ' }];
  assert.deepEqual(correctHeard('みかみさんに電話して', words), { text: '三上さんに電話して', corrected: [{ from: 'みかみ', to: '三上' }] });
  assert.deepEqual(correctHeard('オノさんの予定は', words).corrected, [], '2 字の読みは直さない');
  assert.deepEqual(correctHeard('三上さんの予定は', words).corrected, []);
  assert.equal(correctHeard('見積もり課に送って', [], [{ heard: '見積もり課', meant: '見積課' }]).text, '見積課に送って');
});

test('覚える: 「〇〇じゃなくて△△」を見分け、同じ聞き違えは置き換えて 50 組まで持つ', () => {
  assert.deepEqual(mishearOf('みかみじゃなくて三上です'), { heard: 'みかみ', meant: '三上' });
  assert.deepEqual(mishearOf('「見積もり課」ではなくて「見積課」'), { heard: '見積もり課', meant: '見積課' });
  assert.equal(mishearOf('今日の予定を教えて'), null);
  const list = addMishear([{ heard: 'a', meant: 'b' }], { heard: 'a', meant: 'c' });
  assert.deepEqual(list, [{ heard: 'a', meant: 'c' }]);
  let many: { heard: string; meant: string }[] = [];
  for (let i = 0; i < 60; i++) many = addMishear(many, { heard: `h${i}`, meant: `m${i}` });
  assert.equal(many.length, 50);
  assert.equal(many[0]!.heard, 'h10');
});
