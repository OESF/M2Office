/**
 * @file 暗号の鍵の入れ替え（仕様書 第16.11.3節 G-10）の単体テスト。
 *
 * 今の鍵で暗号化し、前の鍵でも読めること、前の鍵で読めた値を見分けられること、
 * 入れ替えのスクリプト（`scripts/rotate-secrets.mjs`）と `SecretBox` が同じ形で読み合えること、
 * どの鍵でも読めない値を変えないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretBox, secretBoxFromEnv } from '../src/index.js';
// @ts-expect-error 型の宣言の無い素の JavaScript（配布物に入れるため TypeScript にしない）
import { decide, keyOf, seal, unseal, SEALED_COLUMNS } from '../../../scripts/rotate-secrets.mjs';

const OLD = 'old-secret-key-for-test';
const NEW = Buffer.alloc(32, 7).toString('base64');

test('今の鍵で暗号化し、前の鍵で暗号化した値も読める', () => {
  const before = new SecretBox(OLD).encrypt('refresh-token');
  const box = new SecretBox(NEW, [OLD]);
  assert.equal(box.decrypt(before), 'refresh-token');
  assert.deepEqual(box.open(before), { plaintext: 'refresh-token', oldKey: true });
  assert.deepEqual(box.open(box.encrypt('x')), { plaintext: 'x', oldKey: false });
  assert.throws(() => new SecretBox(NEW).decrypt(before), /読めません/, '前の鍵を置かなければ読めない');
  const { box: fromEnv } = secretBoxFromEnv({ M2OFFICE_SECRET_KEY: NEW, M2OFFICE_SECRET_KEY_OLD: ` ${OLD} ,` });
  assert.equal(fromEnv.decrypt(before), 'refresh-token', '設定の前の鍵（カンマで複数）を読む');
});

test('入れ替えのスクリプトと SecretBox は同じ形で読み合う', () => {
  const keys = [keyOf(NEW), keyOf(OLD)];
  assert.equal(new SecretBox(NEW).decrypt(seal(keys[0], 'a')), 'a');
  assert.equal(unseal(keys, new SecretBox(OLD).encrypt('b')).plaintext, 'b');
});

test('入れ替え: 今の鍵の値は変えず、前の鍵の値は今の鍵で暗号化し直し、読めない値は変えない', () => {
  const keys = [keyOf(NEW), keyOf(OLD)];
  assert.equal(decide(keys, new SecretBox(NEW).encrypt('a')).action, 'keep');
  const r = decide(keys, new SecretBox(OLD).encrypt('b'));
  assert.equal(r.action, 'reseal');
  assert.equal(new SecretBox(NEW).decrypt(r.sealed), 'b', '暗号化し直した値は今の鍵だけで読める');
  assert.equal(decide(keys, new SecretBox('another').encrypt('c')).action, 'unreadable');
  assert.equal(decide(keys, 'not-sealed').action, 'unreadable');
  assert.equal(SEALED_COLUMNS.length, 7);
});

test('入れ替えの対象の列は、移行で作った暗号化の列（*_enc）とそろっている', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../../../db/migrations/', import.meta.url);
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((x: string) => x.endsWith('.sql'))) {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    for (const m of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
      for (const c of m[2]!.matchAll(/^\s*(\w+_enc)\s/gm)) found.add(`${m[1]}.${c[1]}`);
    }
    for (const m of sql.matchAll(/alter table (\w+) add column if not exists (\w+_enc)\b/g)) found.add(`${m[1]}.${m[2]}`);
  }
  const listed = new Set((SEALED_COLUMNS as { table: string; column: string }[]).map((x) => `${x.table}.${x.column}`));
  assert.deepEqual([...found].sort(), [...listed].sort(), '暗号化の列を足したら scripts/rotate-secrets.mjs の SEALED_COLUMNS にも足す');
});
