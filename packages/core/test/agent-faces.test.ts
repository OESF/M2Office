/**
 * @file 業務エージェントの絵の割り当ての単体テスト（仕様書 第6.7.4.3節）。
 *
 * 番号が重ならないこと、同梱した画像が実際にあること、
 * 番号を書かない定義でも絵が決まることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_FACE_COUNT } from '@m2office/shared';
import { OFFICIAL_AGENTS, agentFace } from '../src/index.js';

/** 画像の置き場所。テストのファイルからの相対で引く。 */
const FACE_DIR = fileURLToPath(new URL('../../web/public/agents/', import.meta.url));

test('公式のカタログは、すべての業務に絵の番号を書いている', () => {
  for (const a of OFFICIAL_AGENTS) {
    assert.equal(typeof a.face, 'number', `${a.id} に face が無い`);
  }
});

test('絵の番号が、業務どうしで重なっていない', () => {
  const seen = new Map<number, string>();
  for (const a of OFFICIAL_AGENTS) {
    const n = agentFace(a);
    assert.equal(seen.has(n), false, `face ${n} が ${seen.get(n)} と ${a.id} で重なっている`);
    seen.set(n, a.id);
  }
});

test('絵の番号が 1〜25 の範囲に収まっている', () => {
  for (const a of OFFICIAL_AGENTS) {
    const n = agentFace(a);
    assert.ok(n >= 1 && n <= AGENT_FACE_COUNT, `${a.id} の face ${n} が範囲の外`);
    assert.equal(Number.isInteger(n), true, `${a.id} の face ${n} が整数でない`);
  }
});

test('割り当てた番号の画像が、実際に置いてある', () => {
  for (const a of OFFICIAL_AGENTS) {
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
