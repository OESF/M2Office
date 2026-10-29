/**
 * @file データベースの移行の書き方の確かめ。移行は記録の表を持たず、毎回すべてを頭から流す（`scripts/migrate.mjs`）。
 *
 * 同じ制約を後の移行で広げたとき、前の移行が狭い形で付け直すと、後で足した値の行があるデータベースでは前の移行が止まり、
 * 更新ができなくなる（2026-10-29 に、見積書の行があると移行 168 が止まることが分かった）。そのため、同じ名前の制約を
 * 付ける移行が 2 つ以上あれば、最後のもの以外は `not valid`（いまある行を確かめない）で付けることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

test('同じ制約を付け直す移行は、最後のもの以外は not valid で付ける（毎回すべて流しても止まらない）', () => {
  const adds = new Map<string, { file: string; notValid: boolean }[]>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/add constraint (\w+)\s+check\s*\(([\s\S]*?);/gi)) {
      adds.set(m[1]!, [...(adds.get(m[1]!) ?? []), { file, notValid: /\)\s*not valid\s*$/i.test(m[2]!.trim()) }]);
    }
  }
  const bad = [...adds].flatMap(([name, list]) => list.slice(0, -1).filter((x) => !x.notValid).map((x) => `${x.file} の ${name}`));
  assert.deepEqual(bad, [], '後の移行で付け直す制約は、前の移行では not valid にする');
});
