/**
 * @file Google Workspace だけでできる基本の業務の単体テスト（仕様書 第9.5.5.2節、ADR-0035）。
 *
 * どれも公式に入り、定義の検証を通り、送らない・共有しない（危険度は read か draft、承認は無い）ことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_ORDER } from '@m2office/shared';
import { BUILTIN_TOOLS, OFFICIAL_AGENTS, ToolRegistry, validateDefinition } from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

const IDS = ['meeting-prep', 'reply-followup', 'document-draft', 'sheet-builder', 'slides'];

test('基本の業務は公式に入り、定義の検証を通る', () => {
  for (const id of IDS) {
    const def = OFFICIAL_AGENTS.find((a) => a.id === id);
    assert.ok(def, `${id} が公式にある`);
    assert.doesNotThrow(() => validateDefinition(def, registry), id);
    assert.ok(def.help?.summary, `${id} にヘルプがある`);
  }
});

test('基本の業務は送らない・共有しない（道具は read か draft、承認は無い）', () => {
  for (const id of IDS) {
    const def = OFFICIAL_AGENTS.find((a) => a.id === id)!;
    for (const name of def.tools) {
      const risk = registry.get(name)!.risk;
      assert.ok(RISK_ORDER[risk] <= RISK_ORDER.draft, `${id} の ${name}（${risk}）は下書きまで`);
    }
    assert.ok(!def.steps.some((s) => s.type === 'approval'), `${id} に承認は無い`);
  }
});

test('公式の業務の絵は重ならない', () => {
  const faces = OFFICIAL_AGENTS.map((a) => a.face);
  assert.equal(new Set(faces).size, faces.length);
});
