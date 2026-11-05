/**
 * @file 長い文で遅くならないこと（仕様書 第10.9.9節）の確かめ。秘書への依頼の文の上限と、決まった言い回しで見分ける部分が
 * 文の頭だけを見ること、外から届く文や上げた書類を読む正規表現にかける長さを区切ったことを見る。
 *
 * 見分けの正規表現の中には、特定の文字が長く続くと時間が文の長さの 2 乗で伸びるものがある（CodeQL の js/polynomial-redos）。
 * 区切らなければ 8 万字で 1 つあたり 5〜12 秒かかったので、ここでは区切った後に 1 秒より十分短く終わることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRETARY_COMMAND_CHARS, SECRETARY_MESSAGE_MAX, SECRETARY_MESSAGE_TOO_LONG } from '@m2office/shared';
import { MockWorkspaceConnector, OFFICIAL_AGENTS, Secretary, UnconfiguredLlmProvider, commandText, type Repository } from '../src/index.js';
import { signageRequest } from '../src/secretary/signage.js';
import { attendanceRequest } from '../src/secretary/attendance.js';
import { maybeReservation } from '../src/secretary/reservations.js';
import { inventoryRequest } from '../src/secretary/inventory.js';
import { partyFromText } from '../src/inquiries/line.js';
import { noticeDaysOf, renewMonthsOf } from '../src/contracts/extract.js';
import { readOrderByRule } from '../src/sales-docs/extract.js';
import { parseTagRequest } from '../src/print-designs/service.js';
import { weekdayChecks } from '../src/print-designs/checks.js';
import { splitUnit } from '../src/inventory/service.js';
import { readHtml, stripHidden } from '../src/competitors/html.js';
import { externalRefs } from '../src/signage/service.js';
import { guessInquiry } from '../src/inquiries/extract.js';
import { afterLabel, parseHeader, parseSpeech, splitReport } from '../src/decisions/format.js';

/** かかった時間（ミリ秒）。 */
const ms = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t; };

test('秘書への依頼の文は 20,000 字まで。超えたら AI を呼ばず、会話にも残さずに断る', async () => {
  const repo = { appendConversation: async () => assert.fail('会話ログに残さない') } as unknown as Repository;
  const s = new Secretary({ repo, llm: new UnconfiguredLlmProvider(), connector: new MockWorkspaceConnector(), agents: OFFICIAL_AGENTS });
  const r = await s.respond('t', 'u', 'あ'.repeat(SECRETARY_MESSAGE_MAX + 1));
  assert.equal(r.text, SECRETARY_MESSAGE_TOO_LONG);
  assert.match(SECRETARY_MESSAGE_TOO_LONG, /20,000 字まで/);
});

test('決まった言い回しで見分ける部分は文の頭だけを見るので、上限いっぱいのいじわるな文でもすぐ終わる', () => {
  assert.equal(commandText('今日の予定は？'), '今日の予定は？');
  assert.equal(commandText('a'.repeat(SECRETARY_COMMAND_CHARS + 10)).length, SECRETARY_COMMAND_CHARS);
  // 区切らなければ、1 つあたり数秒かかる形の文（CodeQL が挙げた繰り返し）
  const evil = ['「'.repeat(SECRETARY_MESSAGE_MAX), '\t'.repeat(SECRETARY_MESSAGE_MAX), '0'.repeat(SECRETARY_MESSAGE_MAX), '!'.repeat(SECRETARY_MESSAGE_MAX)];
  for (const m of evil) {
    const head = commandText(m);
    const took = ms(() => { signageRequest(head); attendanceRequest(head); maybeReservation(head); inventoryRequest(head); });
    assert.ok(took < 500, `頭だけを見れば速い（${Math.round(took)} ms）`);
  }
});

test('外から届く文や上げた書類を読む正規表現は、読む長さを区切るので、長い文でもすぐ終わる', () => {
  const long = (c: string) => c.repeat(80_000);
  const cases: [string, () => unknown][] = [
    ['LINE の問い合わせ', () => partyFromText(long('%'))],
    ['契約書の申し出の決まり', () => noticeDaysOf(long('0'))],
    ['契約書の更新の文', () => renewMonthsOf(long('0'))],
    ['注文書の長い 1 行', () => readOrderByRule(`a${' '.repeat(80_000)}x`, '例の会社')],
    ['値札の頼み', () => parseTagRequest(long('+'))],
    ['販促物の曜日の点検', () => weekdayChecks(long(' '), '2026-11-04')],
    ['在庫の単位', () => splitUnit(`0${' '.repeat(80_000)}`)],
  ];
  for (const [name, fn] of cases) {
    const took = ms(fn);
    assert.ok(took < 500, `${name}（${Math.round(took)} ms）`);
  }
  // 区切っても、ふつうの文は読める
  assert.equal(partyFromText('山田と申します。taro@example.jp 03-1234-5678').email, 'taro@example.jp');
  assert.equal(noticeDaysOf('満了の 3 か月前までに申し出る'), 90);
});

test('上げたサイネージの HTML と外のサイトの HTML は、閉じの無い形が長く続いてもすぐ終わる。ふつうの HTML は前と同じに読む', () => {
  const mb = 2 * 1024 * 1024;
  const evil: [string, string][] = [
    ['url( の後の空白', `url(${' '.repeat(mb)}`],
    ['閉じの無い url(', 'url('.repeat(mb / 4)],
    ['閉じの無い <meta', '<meta'.repeat(mb / 5)],
    ['閉じの無いコメント', '<!--'.repeat(mb / 4)],
    ['閉じの無い <script', '<script'.repeat(mb / 7)],
  ];
  for (const [name, html] of evil) {
    const took = ms(() => { externalRefs(html); stripHidden(html); });
    assert.ok(took < 1_000, `${name}（2 MB。${Math.round(took)} ms）`);
  }
  // サイネージ: 外への参照を、CSS の url(…) と移動の印からも拾う
  const refs = externalRefs('<style>body{background:url( "https://cdn.example/a.png" )}</style><meta http-equiv="refresh" content="0; url=https://evil.example/x"><img src="/v1/files/x/view">');
  assert.deepEqual(refs.sort(), ['https://cdn.example/a.png', 'https://evil.example/x']);
  assert.deepEqual(externalRefs("<div style=\"background:url('img/local.png')\"></div>"), [], '中の参照は拾わない');
  // 競合のサイト: コメント・スクリプト・スタイルの中身は読まず、見出しは読む
  assert.equal(stripHidden('a<!-- x -->b<script>alert(1)</script >c<STYLE>p{}</STYLE>d'), 'a b c d');
  assert.equal(stripHidden('a<script>never closed'), 'a ');
  const page = readHtml('<title>見本</title><!-- <h1>隠れ</h1> --><h1>表の見出し</h1><script>var h="<h2>x</h2>"</script>', 'https://shop.example/');
  assert.deepEqual([page.title, page.headings], ['見本', ['表の見出し']]);
  // 題名・説明・見出し・リンク・本文を読む処理も、閉じの無い形が 2 MB 続いてもすぐ終わる
  for (const [name, html] of [['<title', '<title>'.repeat(mb / 7)], ['<a', '<a href="/x">'.repeat(mb / 13)], ['<h1', '<h1>'.repeat(mb / 4)], ['<', '<'.repeat(mb)], ['<meta', '<meta name="description" content="'.repeat(mb / 34)], ['<body', '<body>'.repeat(mb / 6)]] as const) {
    const took = ms(() => readHtml(html, 'https://shop.example/'));
    assert.ok(took < 2_000, `readHtml ${name}（2 MB。${Math.round(took)} ms）`);
  }
  const full = readHtml('<head><meta charset="utf-8"><meta content="料金と &amp; 予約" name="description"></head><body><h2>料金</h2><a href="/menu" title="メニュー"><img src="m.png"></a><a href="/menu">二度目</a><a href="/staff#top">スタッフ</a></body>', 'https://shop.example/');
  assert.equal(full.description, '料金と & 予約', 'content を先に書いた <meta> も読む');
  assert.deepEqual(full.links, [{ url: 'https://shop.example/menu', label: 'メニュー' }, { url: 'https://shop.example/staff', label: 'スタッフ' }]);
  assert.match(full.text, /料金/);
});

test('問い合わせのメールの本文は 5,000 字で区切って連絡先を探す（長い本文でもすぐ終わる）', () => {
  const today = { date: '2026-11-04', weekday: 3 } as unknown as Parameters<typeof guessInquiry>[1];
  const took = ms(() => guessInquiry('%'.repeat(80_000), today));
  assert.ok(took < 500, `${Math.round(took)} ms`);
  const d = guessInquiry('見本商事の山田です。taro@example.jp 03-1234-5678 まで', today);
  assert.equal(JSON.stringify(d).includes('taro@example.jp'), true);
});

test('意思決定支援の発言と報告の読み取りは、空白が長く続く行でもすぐ終わり、ふつうの行は前と同じに読む', () => {
  const spaces = ' '.repeat(100_000);
  // 見出しの題・要旨・欄の頭の言葉の後ろに、長い空白をはさんだ行
  const report = `## 見立て${spaces}x${spaces}y\n本文`;
  const speech = `【A1-1｜新しい論点｜論点 客離れ｜根拠 材料 4】\n本文\n要旨:\nA1-1:${spaces}a${spaces}b`;
  for (const [name, fn] of [
    ['報告の見出し', () => splitReport(report)],
    ['要旨の行', () => parseSpeech(speech, 'A1-', new Set())],
    ['欄の頭の言葉', () => afterLabel(`論点${spaces}：${spaces}x${spaces}y`, ['論点'])],
  ] as const) {
    const t = ms(fn);
    assert.ok(t < 300, `${name}（${Math.round(t)} ms）`);
  }
  // ふつうの行は前と同じに読む
  assert.deepEqual(splitReport('前置き\n## 見立て \n値上げは見送る\n### 分かれ目\n客数'), [
    { heading: '見立て', body: '値上げは見送る' }, { heading: '分かれ目', body: '客数' },
  ]);
  assert.deepEqual(parseHeader('【A3-1｜反論｜対象 B2-2への反論｜論点：客離れ｜根拠 材料 4・推測】'), {
    code: 'A3-1', kind: 'rebut', target: 'B2-2', issue: '客離れ', grounds: ['材料 4', '推測'],
  });
  const parsed = parseSpeech('【A1-1｜新しい論点｜論点 競合】\n本文です。\n要旨:\nA1-1： 競合が近くにある', 'A1-', new Set());
  assert.equal(parsed.claims[0]?.gist, '競合が近くにある');
  assert.equal(afterLabel('論点', ['論点']), null);
  assert.equal(afterLabel('対象 B1-1', ['対象'], false), 'B1-1');
});
