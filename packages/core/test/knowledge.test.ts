/**
 * @file 組織知識の分割（節）と、検索の言葉の取り出し・並べ替えの単体テスト。
 *
 * @see 仕様書 第11.7.2節 取り込み時の分割
 * @see 仕様書 第11.7.3節 検索と並べ替え
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_MAX_CHARS, citationOf, extractTerms, rankSections, splitKnowledge,
} from '../src/knowledge/index.js';

const RULES = [
  'この規則は、従業員の労働条件を定める。',
  '',
  '第1章 総則',
  '（目的）',
  '第1条 この規則は、就業に関する事項を定める。',
  '第5章　休暇',
  '第二十三条（年次有給休暇）',
  '6 か月継続勤務した従業員に 10 日を付与する。',
  '第２４条 年次有給休暇の申請は 3 日前までに行う。',
  '第25条の2（削除）',
  '附則',
  'この規則は 2024 年 4 月 1 日から施行する。',
].join('\n');

test('規程は条ごとの節に分け、章を見出しの経路に入れる', () => {
  const s = splitKnowledge(RULES);
  assert.deepEqual(s.map((x) => [x.path.join('/'), x.heading]), [
    ['', '前文'],
    ['第1章 総則', '第1条（目的）'],
    ['第5章 休暇', '第二十三条（年次有給休暇）'],
    ['第5章 休暇', '第２４条'],
    ['第5章 休暇', '第25条の2（削除）'],
    ['', '附則'],
  ]);
  assert.equal(s[1]!.body, 'この規則は、就業に関する事項を定める。', '括弧だけの前の行は見出しにして本文に入れない');
  assert.equal(s[3]!.body, '年次有給休暇の申請は 3 日前までに行う。', '条の行に続く本文は本文に入れる');
  assert.deepEqual(s.map((x) => x.ordinal), [0, 1, 2, 3, 4, 5]);
});

test('条を引用して始まる本文の行や、句点のある行は見出しにしない', () => {
  const s = splitKnowledge(['第3条（賃金）', '基本給は月給とする。', '第3条の規定にかかわらず、試用期間は別に定める。', '第2章に定める手当を含む。'].join('\n'));
  assert.equal(s.length, 1);
  assert.match(s[0]!.body, /第3条の規定にかかわらず/);
  assert.match(s[0]!.body, /第2章に定める/);
});

test('Markdown の見出しで分け、見出しのない短い文書は 1 節にする', () => {
  const md = splitKnowledge('# 経費規程\n\n## 交通費\n実費を精算する。\n\n## 出張\n### 日当\n1 日 2,000 円。');
  assert.deepEqual(md.map((x) => citationOf('経費', x)), ['経費 › 経費規程 › 交通費', '経費 › 経費規程 › 出張 › 日当']);
  const plain = splitKnowledge('交通費は実費を精算する。');
  assert.deepEqual(plain.map((x) => [x.heading, x.body]), [['', '交通費は実費を精算する。']]);
  assert.equal(citationOf('経費規程', plain[0]!), '経費規程');
  assert.deepEqual(splitKnowledge('   \n  '), []);
});

test('長い節は段落の境で分け、「（続き）」を付ける。見出しのない長い文書は段落でまとめる', () => {
  const para = 'あ'.repeat(900);
  const long = splitKnowledge(['第1条（長い条）', para, '', para, '', para].join('\n'));
  assert.ok(long.length >= 2);
  assert.equal(long[1]!.heading, '第1条（長い条）（続き）');
  assert.ok(long.every((x) => x.body.length <= SECTION_MAX_CHARS));
  const plain = splitKnowledge([para, para, para].join('\n\n'));
  assert.ok(plain.length >= 2);
  assert.match(plain[0]!.heading, /^本文（1\/\d）$/);
});

test('質問から検索の言葉を取り出す（助詞で区切り、ひらがなを含む語も拾う）', () => {
  assert.deepEqual(extractTerms('育休の取り扱いを教えて').sort(), ['取り扱い', '育休'].sort());
  const t = extractTerms('有給休暇は何日もらえますか？');
  assert.ok(t.includes('有給休暇'));
  assert.ok(!t.some((x) => /^[ぁ-ん]+$/.test(x)), 'ひらがなだけの語を言葉にしない');
  assert.ok(extractTerms('ＰＣの貸与').includes('pc'), '全角の英字は半角の小文字に揃える');
  assert.deepEqual(extractTerms('は？'), []);
});

test('見出しに言葉がある節を上にし、点の足りない節と最上位の 3 割に満たない節は返さない', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const cands = [
    { heading: '第16条（時間外労働）', path: ['第3章 労働時間'], body: '時間外労働は事前に承認を得る。', updatedAt: at },
    { heading: '第32条（年次有給休暇）', path: ['第5章 休暇'], body: '年次有給休暇は 10 日を付与する。', updatedAt: at },
    { heading: '第33条（年次有給休暇の申請）', path: ['第5章 休暇'], body: '3 日前までに申請する。', updatedAt: at },
    { heading: '第1条（目的）', path: [], body: '就業に関する事項を定める。', updatedAt: at },
  ];
  const r = rankSections(extractTerms('有給休暇の申請方法は？'), cands);
  assert.equal(r[0]!.heading, '第33条（年次有給休暇の申請）');
  assert.ok(r.some((x) => x.heading === '第32条（年次有給休暇）'));
  assert.ok(!r.some((x) => x.heading === '第1条（目的）'), '当たらない節は返さない');
  assert.ok(!r.some((x) => x.heading === '第16条（時間外労働）'));
  assert.deepEqual(rankSections(extractTerms('宇宙旅行'), cands), []);
});

test('返す節は 5 節まで、本文の合計は 8,000 字まで', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const cands = Array.from({ length: 12 }, (_, i) => ({
    heading: `第${i + 1}条（休暇）`, path: [], body: `休暇${'。'.repeat(1_900)}`, updatedAt: at,
  }));
  const r = rankSections(extractTerms('休暇'), cands);
  assert.ok(r.length <= 5);
  assert.ok(r.reduce((n, x) => n + x.body.length, 0) <= 8_000);
});
