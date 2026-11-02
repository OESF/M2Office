/**
 * @file データベースの移行の書き方の確かめ。移行は記録の表を持たず、毎回すべてを頭から流す（`scripts/migrate.mjs`）。
 *
 * 同じ制約を後の移行で広げたとき、前の移行が狭い形で付け直すと、後で足した値の行があるデータベースでは前の移行が止まり、
 * 更新ができなくなる（2026-10-29 に、見積書の行があると移行 168 が止まることが分かった）。そのため、同じ名前の制約を
 * 付ける移行が 2 つ以上あれば、最後のもの以外は `not valid`（いまある行を確かめない）で付けることを確かめる。
 * 関数も同じで、同じ名前と引数のまま返す形を後の移行で変えると、前の移行の `create or replace` が止まる（2026-11-03 に移行 178 で起きかけた）。
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

test('同じ名前と引数の関数の、返す形を後の移行で変えない（毎回すべて流すと、前の移行の作り直しで止まる）', () => {
  // 名前と引数の型 → 移行ごとの返す形。引数が違えば別の関数になるので、名前と引数の型の組で見る
  const defs = new Map<string, { file: string; returns: string }[]>();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([^)]*)\)\s*returns\s+([\s\S]*?)\s+(?:language|as)\b/gi)) {
      // 引数は型だけを残す（名前と既定値は返す形の同じさに関わらない）
      const args = m[2]!.split(',').map((a) => norm(a).replace(/\s+default\s+.*$/, '').split(' ').slice(-1)[0] ?? '').join(',');
      const key = `${m[1]!.toLowerCase()}(${args})`;
      defs.set(key, [...(defs.get(key) ?? []), { file, returns: norm(m[3]!) }]);
    }
  }
  const bad = [...defs].filter(([, list]) => new Set(list.map((x) => x.returns)).size > 1)
    .map(([key, list]) => `${key}: ${list.map((x) => x.file).join('・')}`);
  assert.deepEqual(bad, [], '返す形を変えるときは新しい名前の関数にする');
});
