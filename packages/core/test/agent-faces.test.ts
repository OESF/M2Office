/**
 * @file 業務エージェントの絵の割り当ての単体テスト（仕様書 第6.7.4.3節）。
 *
 * 絵の番号の台帳（`packages/web/public/agents/README.md` の表）と、業務の定義の `face` が 1 つずつ合っていること、
 * 番号が重ならないこと（公式のカタログと内蔵の拡張の業務を合わせて）、同梱した画像が実際にあること、
 * 番号を書かない定義でも絵が決まり、並べたときに重ならないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_FACE_COUNT } from '@m2office/shared';
import { BUILTIN_EXTENSIONS, OFFICIAL_AGENTS, agentFace, assignAgentFaces } from '../src/index.js';

/** 画像の置き場所。テストのファイルからの相対で引く。 */
const FACE_DIR = fileURLToPath(new URL('../../web/public/agents/', import.meta.url));

/** M2Office に入っている業務すべて（公式のカタログと内蔵の拡張。内蔵の拡張をすべて入れた会社で並ぶもの）。 */
const ALL_BUILTIN = [...OFFICIAL_AGENTS, ...BUILTIN_EXTENSIONS.flatMap((e) => e.pkg.agents)];

test('公式のカタログと内蔵の拡張は、すべての業務に絵の番号を書いている', () => {
  for (const a of ALL_BUILTIN) {
    assert.equal(typeof a.face, 'number', `${a.id} に face が無い`);
  }
});

test('絵の番号が、業務どうしで重なっていない（内蔵の拡張をすべて入れた会社でも）', () => {
  const seen = new Map<number, string>();
  for (const a of ALL_BUILTIN) {
    const n = agentFace(a);
    assert.equal(seen.has(n), false, `face ${n} が ${seen.get(n)} と ${a.id} で重なっている`);
    seen.set(n, a.id);
  }
});

test('絵の番号が 1〜50 の範囲に収まっている', () => {
  for (const a of ALL_BUILTIN) {
    const n = agentFace(a);
    assert.ok(n >= 1 && n <= AGENT_FACE_COUNT, `${a.id} の face ${n} が範囲の外`);
    assert.equal(Number.isInteger(n), true, `${a.id} の face ${n} が整数でない`);
  }
});

test('割り当てた番号の画像が、実際に置いてある', () => {
  for (const a of ALL_BUILTIN) {
    const file = `${FACE_DIR}agent${String(agentFace(a)).padStart(2, '0')}.png`;
    assert.equal(existsSync(file), true, `${a.id} の絵 ${file} が無い`);
  }
});

test('番号を書かない定義でも、いつも同じ絵になる（拡張機能で入った業務）', () => {
  const a = agentFace({ id: 'some-extension-agent' });
  const b = agentFace({ id: 'some-extension-agent' });
  assert.equal(a, b);
  assert.ok(a >= 1 && a <= AGENT_FACE_COUNT);
  // ID が違えば、たいてい違う絵になる（重なりは許す）
  assert.equal(existsSync(`${FACE_DIR}agent${String(a).padStart(2, '0')}.png`), true);
});

test('並べるときは、拡張機能の業務の絵をほかと重ならない番号にずらす（第6.7.4.3節）', () => {
  // 拡張機能の業務の、ID から決まる番号と同じ番号を、内蔵の業務が先に使っている場合
  const ext = { id: 'some-extension-agent' };
  const taken = agentFace(ext);
  const faces = assignAgentFaces([{ id: 'builtin-a', face: taken }, ext, { id: 'other-extension' }]);
  assert.equal(faces.get('builtin-a'), taken, '番号を書いた業務はそのまま');
  assert.notEqual(faces.get('some-extension-agent'), taken, '重なれば次の空いている番号にずらす');
  assert.equal(new Set(faces.values()).size, 3);
  const all = assignAgentFaces([...ALL_BUILTIN, ext, { id: 'other-extension' }]);
  assert.equal(new Set(all.values()).size, all.size, '内蔵の業務をすべて並べても重ならない');
});

test('台帳（絵の README の表）と、業務の定義の face が 1 つずつ合っている（使い回しを止める）', () => {
  const readme = readFileSync(`${FACE_DIR}README.md`, 'utf8');
  // 「| 15 | 名前（`web-columns:signage`） | コラムの作成 |」の行を読む
  const ledger = new Map<number, string>();
  for (const m of readme.matchAll(/^\| (\d+) \| [^|]*（`([^`]+)`）[^|]* \|/gm)) {
    const n = Number(m[1]);
    assert.equal(ledger.has(n), false, `台帳で番号 ${n} が 2 行ある`);
    ledger.set(n, m[2]!);
  }
  const ids = new Set<string>();
  for (const a of ALL_BUILTIN) {
    assert.equal(ledger.get(a.face!), a.id, `${a.id} の face ${a.face} が台帳と違う（台帳では ${ledger.get(a.face!) ?? '未使用'}）`);
    ids.add(a.id);
  }
  for (const [n, id] of ledger) assert.ok(ids.has(id), `台帳の番号 ${n} の業務 ${id} が無い（使わなくなったら行を消して未使用に戻す）`);
  // 「未使用」の書き方が、台帳に無い番号と合っている
  const unused = Array.from({ length: AGENT_FACE_COUNT }, (_, i) => i + 1).filter((n) => !ledger.has(n));
  const ranges: string[] = [];
  for (let i = 0; i < unused.length;) {
    let j = i;
    while (j + 1 < unused.length && unused[j + 1] === unused[j]! + 1) j++;
    ranges.push(i === j ? `${unused[i]}` : `${unused[i]}〜${unused[j]}`);
    i = j + 1;
  }
  assert.ok(readme.includes(`**未使用: ${ranges.join('・') || 'なし'}**`), `台帳の「未使用」を「${ranges.join('・')}」にしてください`);
});
