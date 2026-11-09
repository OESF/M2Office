/**
 * @file 業務と内蔵の拡張の説明の長さの単体テスト（仕様書 第9.2節。第 0.538.0 版）。
 *
 * 画面の一覧（セットアップウィザード・業務と承認・拡張機能）に並べる説明は、1 文・30 字前後にそろえる。
 * 項目ごとに長さが大きく違うと読みにくいため（三浦さんの指摘）。秘書が業務を選ぶための詳しい説明は `routeHint` に書く。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeText } from '@m2office/shared';
import { BUILTIN_EXTENSIONS, OFFICIAL_AGENTS } from '../src/index.js';

/** 説明の長さの幅（字数）。30 字前後にそろえるための目安。 */
const MIN = 20;
const MAX = 40;

/** M2Office に入っている業務すべて（公式のカタログと内蔵の拡張）。 */
const ALL_AGENTS = [...OFFICIAL_AGENTS, ...BUILTIN_EXTENSIONS.flatMap((e) => e.pkg.agents)];

test('業務の説明は 1 文・30 字前後（20〜40 字）にそろっている', () => {
  for (const a of ALL_AGENTS) {
    const n = [...a.description].length;
    assert.ok(n >= MIN && n <= MAX, `${a.id}「${a.description}」は ${n} 字`);
    assert.ok(!/。./.test(a.description), `${a.id} の説明が 2 文以上ある`);
  }
});

test('内蔵の拡張の説明も、1 文・30 字前後（20〜40 字）にそろっている', () => {
  for (const { pkg } of BUILTIN_EXTENSIONS) {
    const d = pkg.manifest.description ?? '';
    const n = [...d].length;
    assert.ok(n >= MIN && n <= MAX, `${pkg.manifest.id}「${d}」は ${n} 字`);
  }
});

test('秘書が業務を選ぶときは、手がかり（routeHint）があればそれを読み、画面の説明より詳しい', () => {
  for (const a of ALL_AGENTS) {
    if (!a.routeHint) continue;
    assert.equal(routeText(a), a.routeHint);
    assert.ok(a.routeHint.length > a.description.length, `${a.id} の routeHint が説明より短い`);
  }
});
