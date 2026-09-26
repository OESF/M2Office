/**
 * @file スキルの形式（SKILL.md）で書いた業務エージェントの単体テスト。読み取り・組み立て・取り込みを確かめる。
 *
 * @see 仕様書 第12.12節、ADR-0029
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, ToolRegistry, loadExtension, loadExtensionFiles, parseSkill, parseInputs, unpackExtension,
  type ExtensionFiles,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const enc = (s: string) => new TextEncoder().encode(s);

const SKILL = `---
name: expense-check
description: 経費の申請を社内の規程と照らし合わせる。「経費を確認して」と頼まれたときに使う
license: Apache-2.0
allowed-tools: Bash(git:*) Read
metadata:
  author: 株式会社サンプル
  version: "1.2.0"
  m2office-title: 経費精算チェック
  m2office-inputs: |
    申請の内容: 長文
    対象期間を指定: 日付（任意）
  m2office-examples: |
    先月の出張の経費を確認して
---

# 経費精算チェック

申請の内容を規程と照らし合わせる。
`;

test('SKILL.md のフロントマターを読む（Agent Skills の決まり。metadata は文字の値）', () => {
  const p = parseSkill(SKILL)!;
  assert.equal(p.frontmatter['name'], 'expense-check');
  assert.equal(p.frontmatter['allowed-tools'], 'Bash(git:*) Read');
  const meta = p.frontmatter['metadata'] as Record<string, string>;
  assert.equal(meta['version'], '1.2.0', '引用符を外す');
  assert.equal(meta['m2office-inputs'], '申請の内容: 長文\n対象期間を指定: 日付（任意）', '複数行の文字');
  assert.match(p.body, /^# 経費精算チェック/);
  assert.equal(parseSkill('# 見出しだけ'), null, 'フロントマターが無ければ読まない');
});

test('入力の欄を「欄の名前: 種類」から作る。書かなければ自由記入の依頼の欄 1 つ', () => {
  const r = parseInputs('申請の内容: 長文\n対象期間を指定: 日付（任意）\n添付: ファイル');
  assert.deepEqual(r.schema.required, ['申請の内容', '添付']);
  assert.equal(r.schema.properties['対象期間を指定']!.format, 'date');
  assert.equal(r.schema.properties['申請の内容']!.format, 'textarea');
  assert.deepEqual(parseInputs(undefined).schema.required, ['request']);
  assert.match(parseInputs('期限: 時刻').problems[0]!, /種類は/);
});

test('既存のスキル（name と description と本文だけ）を、そのまま業務として取り込める', () => {
  const files: ExtensionFiles = new Map([['SKILL.md', enc('---\nname: summarize\ndescription: 文章を 3 行に要約する\n---\n\n渡された文章を 3 行に要約する。')]]);
  const { pkg, problems } = loadExtensionFiles(files, registry);
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.equal(pkg!.manifest.id, 'skill.summarize');
  assert.equal(def.id, 'skill.summarize:summarize');
  assert.deepEqual(def.tools, ['knowledge.search', 'file.read_text'], '既定は読むだけの道具');
  assert.equal(def.steps.length, 1, '承認の段は要らない');
  assert.match((def.steps[0] as { instruction: string }).instruction, /3 行に要約/, '本文がそのまま指示');
  assert.equal(pkg!.manifest.permissions.max_risk_level, 'read');
  assert.equal(def.help?.summary, '文章を 3 行に要約する');
});

test('＋α（m2office-）で名前・入力・実行例・版・提供者を決める', () => {
  const { pkg, problems } = loadExtensionFiles(new Map([['SKILL.md', enc(SKILL)]]), registry);
  assert.deepEqual(problems, []);
  assert.equal(pkg!.manifest.version, '1.2.0');
  assert.equal(pkg!.manifest.publisher.name, '株式会社サンプル');
  const def = pkg!.agents[0]!;
  assert.equal(def.name, '経費精算チェック');
  assert.deepEqual(def.help?.examples, [{ title: '先月の出張の経費を確認して', input: { 申請の内容: '先月の出張の経費を確認して' } }]);
});

test('送る道具を使うスキルには「作業 → 承認 → 送る」を組み立てる（書き手は承認を書かない）', () => {
  const md = SKILL.replace('  m2office-title:', '  m2office-tools: knowledge.search gmail.create_draft gmail.send\n  m2office-title:');
  const { pkg, problems } = loadExtensionFiles(new Map([['SKILL.md', enc(md)]]), registry);
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.deepEqual(def.steps.map((s) => `${s.type}:${s.id}`), ['agent:work', 'approval:approve', 'agent:send']);
  assert.deepEqual((def.steps[0] as { tools: string[] }).tools, ['knowledge.search', 'gmail.create_draft']);
  assert.deepEqual((def.steps[2] as { tools: string[] }).tools, ['gmail.send']);
  assert.equal((def.steps[1] as { approver?: string }).approver, 'requester', '既定は依頼した本人');
  assert.equal(pkg!.manifest.permissions.max_risk_level, 'external-send');
});

test('プログラムと画像は取り込まずに知らせる。資料は指示に添える', () => {
  const files: ExtensionFiles = new Map([
    ['SKILL.md', enc(SKILL)],
    ['scripts/extract.py', enc('print(1)')],
    ['assets/logo.png', new Uint8Array([1, 2])],
    ['references/規程の読み方.md', enc('第 5 条を先に見る')],
  ]);
  const res = loadExtensionFiles(files, registry);
  assert.deepEqual(res.problems, []);
  assert.match(res.notices![0]!, /scripts\/extract\.py, assets\/logo\.png/);
  assert.deepEqual([...res.keep!.keys()].sort(), ['SKILL.md', 'references/規程の読み方.md'], '除いたものは保存しない');
  assert.match((res.pkg!.agents[0]!.steps[0] as { instruction: string }).instruction, /## 資料: references\/規程の読み方\.md\n\n第 5 条を先に見る/);
});

test('書き方の誤りは、直し方の分かる言葉で断る', () => {
  const bad = loadExtensionFiles(new Map([['SKILL.md', enc('---\nname: Bad_Name\n---\n本文')]]), registry);
  assert.ok(bad.problems.some((p) => /英小文字/.test(p)));
  assert.ok(bad.problems.some((p) => /description/.test(p)));
  const unknownTool = loadExtensionFiles(new Map([['SKILL.md', enc('---\nname: x\ndescription: y\nmetadata:\n  m2office-tools: no.such\n---\n本文')]]), registry);
  assert.ok(unknownTool.problems.length > 0, '無い道具は取り込まない');
});

test('SKILL.md 1 つのファイルも、フォルダごとの ZIP も取り込める', async () => {
  const single = await unpackExtension(enc(SKILL));
  assert.deepEqual([...single.files.keys()], ['SKILL.md']);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('expense-check/SKILL.md', SKILL);
  zip.file('expense-check/references/a.md', '資料');
  const unpacked = await unpackExtension(await zip.generateAsync({ type: 'uint8array' }));
  assert.deepEqual([...unpacked.files.keys()].sort(), ['SKILL.md', 'references/a.md'], 'フォルダを外す');
});

test('見本の拡張機能「あいさつ」は SKILL.md で書かれ、業務の ID は前と同じ', () => {
  const { pkg, problems } = loadExtension(new URL('../../../extensions/hello-world', import.meta.url).pathname, registry);
  assert.deepEqual(problems, []);
  assert.equal(pkg!.agents[0]!.id, 'jp.m2office.samples.hello-world:hello');
  assert.equal(pkg!.agents[0]!.evals?.[0]?.input['あいさつ'], 'こんにちは', '評価のケースを持ち込む');
});
