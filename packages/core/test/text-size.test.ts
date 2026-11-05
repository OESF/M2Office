/**
 * @file 文字の大きさの単体テスト。段の動かし方（70% から 130% まで 10% ずつ）と、秘書が「文字を大きくして」「標準に戻して」に応える照会を確かめる。
 *
 * @see 仕様書 第6.1節・第10.9.2節、ADR-0122
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_USER_SETTINGS, TEXT_SIZES, normalizeTextSize, stepTextSize, type AuditEvent, type UserSettings } from '@m2office/shared';
import { DIRECT_QUERIES, MockWorkspaceConnector, type Repository } from '../src/index.js';

/** 秘書の層 1 が設定を扱うのに必要な操作だけを持つ、記憶上の永続化層。 */
class SettingsRepo {
  settings: UserSettings = structuredClone(DEFAULT_USER_SETTINGS);
  audits: AuditEvent[] = [];
  async getUserSettings() { return this.settings; }
  async saveUserSettings(_t: string, _u: string, section: string, value: unknown) {
    (this.settings as unknown as Record<string, unknown>)[section] = value;
  }
  async appendAudit(e: AuditEvent) { this.audits.push(e); }
}

/** 層 1 の照会を、秘書と同じ順序で選ぶ。 */
function match(message: string) {
  return DIRECT_QUERIES.find(
    (q) => q.patterns.some((p) => p.test(message)) && !q.excludes?.some((p) => p.test(message)),
  );
}

async function ask(repo: SettingsRepo, message: string) {
  const query = match(message);
  assert.equal(query?.id, 'text-size', `文字の大きさとして扱えない: ${message}`);
  return query!.answer({
    tenantId: 't', userId: 'u', message,
    repo: repo as unknown as Repository, connector: new MockWorkspaceConnector(),
  });
}

test('既定は標準（100%）で、段は 70% から 130% まで 10% ずつ。端から先へは動かない', () => {
  assert.equal(DEFAULT_USER_SETTINGS.display.textSize, 100);
  assert.deepEqual(TEXT_SIZES.map((t) => t.label), ['70%', '80%', '90%', '100%', '110%', '120%', '130%']);
  assert.equal(stepTextSize(100, 1), 110);
  assert.equal(stepTextSize(100, -1), 90);
  assert.equal(stepTextSize(130, 1), 130);
  assert.equal(stepTextSize(70, -1), 70);
  // 文字と余白は同じ割合で変え、行間の割合は変えない
  for (const t of TEXT_SIZES) { assert.equal(t.font, t.id / 100); assert.equal(t.space, t.id / 100); assert.equal(t.line, 1); }
});

test('3 段の頃に覚えた値は近い段に読み替え、知らない値は使わない', () => {
  assert.equal(normalizeTextSize('small'), 90);
  assert.equal(normalizeTextSize('normal'), 100);
  assert.equal(normalizeTextSize('large'), 120);
  assert.equal(normalizeTextSize('120'), 120);
  assert.equal(normalizeTextSize(110), 110);
  assert.equal(normalizeTextSize(105), null);
  assert.equal(normalizeTextSize('huge'), null);
});

test('画面の CSS の倍率は、段の表とそろっている', () => {
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  for (const t of TEXT_SIZES) {
    const block = t.id === 100
      ? css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
      : css.match(new RegExp(String.raw`:root\[data-text-size="${t.id}"\]\s*\{([^}]*)\}`))?.[1] ?? '';
    assert.match(block, new RegExp(String.raw`--font-scale:\s*${t.font};`), `${t.label}の文字`);
    assert.match(block, new RegExp(String.raw`--line-scale:\s*${t.line};`), `${t.label}の行間`);
    assert.match(block, new RegExp(String.raw`--space-scale:\s*${t.space};`), `${t.label}の余白`);
  }
});

test('「文字を大きくして」で 10% 大きくし、変えた後の段を画面に返す。130% から先へは変えない', async () => {
  const repo = new SettingsRepo();
  const a = await ask(repo, '文字を大きくして');
  assert.equal(repo.settings.display.textSize, 110);
  assert.deepEqual(a.display, { textSize: 110 });
  assert.match(a.text, /「110%」にしました/);
  assert.equal(repo.audits[0]?.targetId, 'display');
  await ask(repo, 'もう少し字を大きく');
  await ask(repo, '文字を大きく');
  assert.equal(repo.settings.display.textSize, 130);
  // いちばん大きい段からは変えず、ブラウザの拡大を案内する
  const b = await ask(repo, 'もう少し字を大きく');
  assert.equal(repo.settings.display.textSize, 130);
  assert.equal(b.display, undefined);
  assert.match(b.text, /いちばん大きい「130%」/);
});

test('「字を小さく」で 10% 小さくする。「字が小さくて見にくい」は大きくする', async () => {
  const repo = new SettingsRepo();
  await ask(repo, '字を小さくしてください');
  assert.equal(repo.settings.display.textSize, 90);
  await ask(repo, '字が小さくて見にくい');
  assert.equal(repo.settings.display.textSize, 100);
  await ask(repo, '画面の文字が大きすぎる');
  assert.equal(repo.settings.display.textSize, 90);
});

test('「文字の大きさを標準に戻して」で 100% に戻す。標準のときは変えない', async () => {
  const repo = new SettingsRepo();
  await ask(repo, '字を小さく');
  await ask(repo, '字を小さく');
  assert.equal(repo.settings.display.textSize, 80);
  const a = await ask(repo, '文字の大きさを標準に戻して');
  assert.equal(repo.settings.display.textSize, 100);
  assert.deepEqual(a.display, { textSize: 100 });
  await ask(repo, '字を大きく');
  await ask(repo, '字を元の大きさに戻して');
  assert.equal(repo.settings.display.textSize, 100);
  const b = await ask(repo, '文字を標準にして');
  assert.equal(b.display, undefined);
  assert.match(b.text, /標準の「100%」/);
});

test('書類の文字の頼みは、文字の大きさの設定として扱わない', () => {
  for (const m of ['スライドの文字を大きくして', 'チラシの字を小さくして', '見出しの文字を大きく', '名刺の文字が小さくて読みにくい']) {
    assert.notEqual(match(m)?.id, 'text-size', m);
  }
});
