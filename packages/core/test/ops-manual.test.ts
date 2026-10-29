/**
 * @file 運営者のヘルプ（仕様書 第23.8.16節）のテスト。運営者マニュアル（`docs/ops-manual/`）を章として読むこと、
 * 本文の「第 N 章」をその章へのリンクにすること（コード・リンクの中と自分の章は変えない）、文字での絞り込みを見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { linkChapters, loadOpsManual, searchOpsManual, OPS_MANUAL_INTRO } from '../src/index.js';

const dir = fileURLToPath(new URL('../../../docs/ops-manual', import.meta.url));

test('マニュアルを読む: はじめにが先頭で、章はファイルの名前の順。題は見出し、本文は見出しを除く', () => {
  const chapters = loadOpsManual(dir);
  assert.equal(chapters[0]?.id, OPS_MANUAL_INTRO);
  assert.equal(chapters[0]?.title, 'はじめに');
  const ids = chapters.slice(1).map((c) => c.id);
  assert.deepEqual(ids, [...ids].sort());
  const server = chapters.find((c) => c.id === '07-server');
  assert.equal(server?.title, '第 7 章 稼働状況');
  assert.ok(!server?.body.startsWith('# '), '題の見出しは本文に残さない');
  for (const id of ['15-incidents', '16-law-tables']) assert.ok(chapters.some((c) => c.id === id), `${id} がある`);
  assert.deepEqual(loadOpsManual('/存在しない置き場'), []);
});

test('「第 N 章」をその章へのリンクにする。コードの囲み・行の中のコード・リンクの中・自分の章・無い章は変えない', () => {
  const byNumber = new Map([[5, '05-suspension'], [7, '07-server']]);
  const body = '第 5 章を見る。`第 5 章` と [第 7 章](07-server.md)。第 7 章 と 第 99 章\n```\n第 5 章\n```';
  assert.equal(linkChapters(body, byNumber, '07-server'),
    '[第 5 章](05-suspension.md)を見る。`第 5 章` と [第 7 章](07-server.md)。第 7 章 と 第 99 章\n```\n第 5 章\n```');
});

test('絞り込み: 題と本文に、すべての語を含む章だけ。空なら全部', () => {
  const chapters = [
    { id: 'a', title: '第 1 章 ログイン', body: 'パスキーで確かめる' },
    { id: 'b', title: '第 2 章 運営者', body: 'パスキーをやり直す。ロール' },
  ];
  assert.deepEqual(searchOpsManual(chapters, 'パスキー ロール').map((c) => c.id), ['b']);
  assert.deepEqual(searchOpsManual(chapters, '  ').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(searchOpsManual(chapters, 'ログイン')[0], { id: 'a', title: '第 1 章 ログイン' }, '本文は返さない');
});
