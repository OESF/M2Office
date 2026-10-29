/**
 * @file 運営の鍵の出どころ（仕様書 第23.8.14節「マスター管理画面の設定を広げる」）のテスト。配備の設定の鍵で始め、
 * 画面で鍵を入れると替わり、消すと戻ること、中継の代わりがいまの提供者の機能だけを持つように見えること、
 * 自動テストでは画面の鍵を使わないこと、読めないときは前の設定のまま続けること、上限の既定の決め方を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformAiSource, defaultGeminiModels, envTenantCapJpy, type LlmProvider, type PlatformAiSettings, type ResearchProvider } from '../src/index.js';

const envLlm: LlmProvider = { name: 'unconfigured', complete: async () => { throw new Error('none'); } };
const envResearch: ResearchProvider = { name: 'unconfigured', research: async () => { throw new Error('none'); } };
const box = { decrypt: (v: string) => v.replace(/^enc:/, '') };

function source(settings: () => PlatformAiSettings | Error, testMode = false) {
  return new PlatformAiSource({
    reader: { read: async () => { const s = settings(); if (s instanceof Error) throw s; return s; }, platformTotal: async () => 0 },
    box, base: { llm: envLlm, research: envResearch, platformKey: null, testMode, baseUrl: 'https://example.invalid' },
    envTenantCapJpy: 2000, models: defaultGeminiModels(),
  });
}
const none: PlatformAiSettings = { keyEnc: null, keySetAt: null, tenantCapJpy: null, platformCapJpy: null };

test('配備の設定で始め、画面で鍵を入れると替わり、消すと戻る。中継の代わりは、いまの提供者の機能だけを持つ', async () => {
  let s: PlatformAiSettings = none;
  const src = source(() => s);
  assert.equal(src.key(), null);
  assert.equal(src.llm.name, 'unconfigured');
  assert.equal(src.llm.readImage, undefined, '設定されていない提供者は画像を読めない');
  s = { ...none, keyEnc: 'enc:AIzaScreenKey0001', keySetAt: '2026-10-29T00:00:00Z', tenantCapJpy: 5000, platformCapJpy: 30000 };
  await src.refresh();
  assert.equal(src.key(), 'AIzaScreenKey0001');
  assert.equal(src.fromScreen(), true);
  assert.equal(src.llm.name, 'gemini');
  assert.equal(typeof src.llm.readImage, 'function', 'Gemini は画像を読める');
  assert.equal(src.tenantCapJpy(), 5000);
  assert.equal(src.platformCapJpy(), 30000);
  s = none;
  await src.refresh();
  assert.equal(src.key(), null, '消すと配備の設定の鍵に戻る');
  assert.equal(src.llm.name, 'unconfigured');
  assert.equal(src.tenantCapJpy(), 2000, '画面で決めていなければ配備の設定の既定');
});

test('読めないときは前の設定のまま。自動テストでは画面の鍵を使わない', async () => {
  let s: PlatformAiSettings | Error = { ...none, keyEnc: 'enc:AIzaScreenKey0002', keySetAt: '2026-10-29T00:00:00Z' };
  const src = source(() => s);
  await src.refresh();
  s = new Error('db down');
  await src.refresh();
  assert.equal(src.key(), 'AIzaScreenKey0002');
  const stub = source(() => ({ ...none, keyEnc: 'enc:AIzaScreenKey0003', keySetAt: '2026-10-29T00:00:00Z' }), true);
  await stub.refresh();
  assert.equal(stub.key(), null);
  assert.deepEqual([envTenantCapJpy({ AI_MONTHLY_LIMIT_JPY: '8000' }), envTenantCapJpy({}), envTenantCapJpy({ AI_MONTHLY_LIMIT_JPY: '0' })], [8000, null, null]);
});
