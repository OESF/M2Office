/**
 * @file 拡張機能の単体テスト。読み込み時の検証、会社ごとの目録、鍵が無い環境での見本の応答の再生を確かめる。
 *
 * @see 仕様書 第12.9節 拡張機能の読み込みと導入
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCatalog, BUILTIN_TOOLS, OFFICIAL_AGENTS, StubLlmProvider, ToolRegistry, loadExtension, loadExtensions,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const SAMPLE = new URL('../../../extensions/hello-world', import.meta.url).pathname;

/** サンプルを一時ディレクトリへ写し、一部を書き換えて検証する。 */
function variant(edit: (dir: string) => void): string[] {
  const dir = join(mkdtempSync(join(tmpdir(), 'm2o-ext-')), 'pkg');
  cpSync(SAMPLE, dir, { recursive: true });
  edit(dir);
  return loadExtension(dir, registry).problems;
}
const rewrite = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  fn(j);
  writeFileSync(file, JSON.stringify(j));
};

test('サンプルの拡張機能は検証を通り、ID に拡張機能の ID が付く', () => {
  const { pkg, problems } = loadExtension(SAMPLE, registry);
  assert.deepEqual(problems, []);
  assert.equal(pkg!.agents[0]!.id, 'jp.m2office.samples.hello-world:hello');
  assert.equal(pkg!.agents[0]!.evals!.filter((e) => e.stub).length, 2, '評価のケースを定義に結び付ける');
});

test('マニフェストで宣言していないツールを使う定義は拒否する（不変則 I-8）', () => {
  const p = variant((d) => rewrite(join(d, 'agents/hello.json'), (j) => { j.tools.push('knowledge.search'); }));
  assert.ok(p.some((x) => x.includes('permissions.tools に無いツール')), p.join('\n'));
});

test('宣言した最大の危険度を超えるツールは拒否する', () => {
  const p = variant((d) => {
    rewrite(join(d, 'manifest.json'), (j) => { j.permissions.tools.push('tasks.create'); });
    rewrite(join(d, 'agents/hello.json'), (j) => { j.tools.push('tasks.create'); });
  });
  assert.ok(p.some((x) => x.includes('max_risk_level')), p.join('\n'));
});

test('対外送信のツールを承認ゲートなしで使う定義は拒否する（第9.4節）', () => {
  const p = variant((d) => {
    rewrite(join(d, 'manifest.json'), (j) => { j.permissions = { tools: ['chat.post'], max_risk_level: 'external-send' }; });
    rewrite(join(d, 'agents/hello.json'), (j) => { j.tools = ['chat.post']; });
  });
  assert.ok(p.some((x) => x.includes('承認ゲートが必要')), p.join('\n'));
});

test('ヘルプの概要が無い定義は拒否する（第9.2.5節）', () => {
  const p = variant((d) => rewrite(join(d, 'agents/hello.json'), (j) => { delete j.help; }));
  assert.ok(p.some((x) => x.includes('help.summary')), p.join('\n'));
});

test('マニフェストの形式の誤りは拒否する', () => {
  const p = variant((d) => rewrite(join(d, 'manifest.json'), (j) => { j.id = 'HelloWorld'; j.version = 'v1'; }));
  assert.ok(p.some((x) => x.includes('逆ドメイン名')));
  assert.ok(p.some((x) => x.includes('セマンティックバージョニング')));
});

test('検証を通らない拡張機能は、読み込みの結果から除く', () => {
  const root = mkdtempSync(join(tmpdir(), 'm2o-exts-'));
  cpSync(SAMPLE, join(root, 'good'), { recursive: true });
  cpSync(SAMPLE, join(root, 'bad'), { recursive: true });
  rewrite(join(root, 'bad/manifest.json'), (j) => { j.id = 'jp.example.bad'; j.permissions.tools = []; });
  const { packages, errors } = loadExtensions(root, registry, OFFICIAL_AGENTS.map((a) => a.id));
  assert.deepEqual(packages.map((p) => p.manifest.id), ['jp.m2office.samples.hello-world']);
  assert.equal(errors.length, 1);
});

test('同じ ID の拡張機能は 2 つ目を拒否する', () => {
  const root = mkdtempSync(join(tmpdir(), 'm2o-exts-'));
  cpSync(SAMPLE, join(root, 'a'), { recursive: true });
  cpSync(SAMPLE, join(root, 'b'), { recursive: true });
  const { packages, errors } = loadExtensions(root, registry, []);
  assert.equal(packages.length, 1);
  assert.ok(errors[0]!.problems.some((x) => x.includes('すでに使われています')));
});

test('会社が導入した拡張機能の業務エージェントだけが、その会社で使える', () => {
  const { pkg } = loadExtension(SAMPLE, registry);
  const catalog = new AgentCatalog(OFFICIAL_AGENTS, [pkg!]);
  const id = 'jp.m2office.samples.hello-world:hello';
  assert.ok(!catalog.forTenant([]).some((a) => a.id === id));
  assert.ok(catalog.forTenant(['jp.m2office.samples.hello-world']).some((a) => a.id === id));
  assert.equal(catalog.availableFor(id, []), false);
  assert.equal(catalog.availableFor('minutes', []), true, '公式は常に使える');
  assert.equal(catalog.resolve(id, 1)?.name, 'あいさつ（サンプル）');
});

test('スタブは入力の一致する評価のケースの見本を再生し、一致しなければツールを呼ばない', async () => {
  const { pkg } = loadExtension(SAMPLE, registry);
  const def = pkg!.agents[0]!;
  const stub = new StubLlmProvider((id) => (id === def.id ? def.evals : undefined));
  const ask = (message: string) => stub.complete({
    tier: 'standard', messages: [{ role: 'user', content: '' }],
    context: { agentId: def.id, stepId: 'reply', input: { message } },
  });
  const hit = await ask('こんにちは');
  assert.match(hit.text, /"body":"Hello World"/);
  const miss = await ask('やあ');
  assert.ok(!miss.text.includes('```tool'), '見本が無い入力では推測でツールを呼ばない');
  assert.match(miss.text, /見本の応答がありません/);
});
