/**
 * @file 文字の大きさの単体テスト。段の動かし方と、秘書が「文字を大きくして」に応える照会を確かめる。
 *
 * @see 仕様書 第6.1節・第10.9.2節、ADR-0122
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_USER_SETTINGS, TEXT_SIZES, stepTextSize, type AuditEvent, type UserSettings } from '@m2office/shared';
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

test('既定は標準で、段は小さい順に並ぶ。端から先へは動かない', () => {
  assert.equal(DEFAULT_USER_SETTINGS.display.textSize, 'normal');
  assert.deepEqual(TEXT_SIZES.map((t) => t.label), ['小さい', '標準', '大きい']);
  assert.equal(stepTextSize('normal', 1), 'large');
  assert.equal(stepTextSize('normal', -1), 'small');
  assert.equal(stepTextSize('large', 1), 'large');
  assert.equal(stepTextSize('small', -1), 'small');
});

test('画面の CSS の倍率は、段の表とそろっている', () => {
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8');
  for (const t of TEXT_SIZES) {
    const block = t.id === 'normal'
      ? css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
      : css.match(new RegExp(String.raw`:root\[data-text-size="${t.id}"\]\s*\{([^}]*)\}`))?.[1] ?? '';
    assert.match(block, new RegExp(String.raw`--font-scale:\s*${t.font};`), `${t.label}の文字`);
    assert.match(block, new RegExp(String.raw`--line-scale:\s*${t.line};`), `${t.label}の行間`);
    assert.match(block, new RegExp(String.raw`--space-scale:\s*${t.space};`), `${t.label}の余白`);
  }
});

test('「文字を大きくして」で 1 段大きくし、変えた後の段を画面に返す', async () => {
  const repo = new SettingsRepo();
  const a = await ask(repo, '文字を大きくして');
  assert.equal(repo.settings.display.textSize, 'large');
  assert.deepEqual(a.display, { textSize: 'large' });
  assert.match(a.text, /「大きい」にしました/);
  assert.equal(repo.audits[0]?.targetId, 'display');
  // いちばん大きい段からは変えず、ブラウザの拡大を案内する
  const b = await ask(repo, 'もう少し字を大きく');
  assert.equal(repo.settings.display.textSize, 'large');
  assert.equal(b.display, undefined);
  assert.match(b.text, /いちばん大きい/);
});

test('「字を小さく」で 1 段小さくする。「字が小さくて見にくい」は大きくする', async () => {
  const repo = new SettingsRepo();
  await ask(repo, '字を小さくしてください');
  assert.equal(repo.settings.display.textSize, 'small');
  await ask(repo, '字が小さくて見にくい');
  assert.equal(repo.settings.display.textSize, 'normal');
  await ask(repo, '画面の文字が大きすぎる');
  assert.equal(repo.settings.display.textSize, 'small');
});

test('書類の文字の頼みは、文字の大きさの設定として扱わない', () => {
  for (const m of ['スライドの文字を大きくして', 'チラシの字を小さくして', '見出しの文字を大きく', '名刺の文字が小さくて読みにくい']) {
    assert.notEqual(match(m)?.id, 'text-size', m);
  }
});
