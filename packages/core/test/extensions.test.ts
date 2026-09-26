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
  BUILTIN_TOOLS, ExtensionHub, OFFICIAL_AGENTS, StubLlmProvider, ToolRegistry, blockedByDisabledTool,
  loadExtension, loadExtensions,
  type DisabledConnectorTool, type InstalledExtension, type Repository,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
// JSON の形（廃止の方向。中の定義の検証を確かめる）の見本。見本の拡張機能は SKILL.md になった（第12.12節）
const SAMPLE = new URL('./fixtures/extension-json', import.meta.url).pathname;
const DEEPWIKI = new URL('../../../extensions/deepwiki-research', import.meta.url).pathname;

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

test('業務エージェントの ID の形式の誤りは拒否する', () => {
  const p = variant((d) => rewrite(join(d, 'agents/hello.json'), (j) => { j.id = 'Hello World'; }));
  assert.ok(p.some((x) => x.includes('英小文字・数字・ハイフン')), p.join('\n'));
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

test('会社が導入した拡張機能の業務エージェントだけが、その会社で使える', async () => {
  const { pkg } = loadExtension(SAMPLE, registry);
  const installed: InstalledExtension[] = [];
  const disabledTools: DisabledConnectorTool[] = [];
  const repo = {
    listInstalledExtensions: async () => installed,
    listDisabledConnectorTools: async () => disabledTools,
    listPrivateExtensions: async () => [],
  } as unknown as Repository;
  const hub = new ExtensionHub({ repo, registry, official: OFFICIAL_AGENTS, packages: [pkg!] });
  const id = 'jp.m2office.samples.hello-world:hello';
  let view = await hub.forTenant('t1');
  assert.ok(!view.agents.some((a) => a.id === id));
  assert.equal(view.isAvailable(id), false);
  assert.equal(view.isAvailable('minutes'), true, '公式は常に使える');
  assert.equal(view.resolve(id, 1)?.name, 'あいさつ（サンプル）', '名前を引くために、未導入でも解決はできる');
  installed.push({
    tenantId: 't1', extensionId: 'jp.m2office.samples.hello-world', version: '1.0.0',
    consentedPermissions: { tools: ['document.create'], max_risk_level: 'draft', connectors: [] },
    installedBy: 'u', installedAt: new Date().toISOString(), enabled: true,
  });
  view = await hub.forTenant('t1');
  assert.ok(view.agents.some((a) => a.id === id));
  assert.equal(view.entryOf(id)?.active, true);
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

test('管理者が止めたコネクタのツールは、その会社のツールの一覧から消える（第6.6.3.1節）', async () => {
  const { pkg } = loadExtension(DEEPWIKI, registry);
  const disabledTools: DisabledConnectorTool[] = [];
  const installed: InstalledExtension[] = [{
    tenantId: 't1', extensionId: 'jp.m2office.samples.deepwiki-research', version: '1.0.0',
    consentedPermissions: {
      tools: ['deepwiki.ask_wiki_question', 'deepwiki.read_wiki_structure', 'document.create'],
      max_risk_level: 'draft',
      connectors: [{
        id: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', auth: 'none',
        tools: [{ name: 'ask_wiki_question', risk: 'read' }, { name: 'read_wiki_structure', risk: 'read' }],
      }],
    },
    installedBy: 'u', installedAt: new Date().toISOString(), enabled: true,
  }];
  const repo = {
    listInstalledExtensions: async () => installed,
    listDisabledConnectorTools: async () => disabledTools,
    listPrivateExtensions: async () => [],
  } as unknown as Repository;
  const hub = new ExtensionHub({ repo, registry, official: OFFICIAL_AGENTS, packages: [pkg!] });
  const agentId = 'jp.m2office.samples.deepwiki-research:research';

  // 止める前は、ツールも業務も使える
  let view = await hub.forTenant('t1');
  assert.ok(view.registry.get('deepwiki.ask_wiki_question'), '止める前はツールがある');
  assert.equal(view.isAvailable(agentId), true, '止める前は業務が使える');
  assert.equal(view.disabledTools.size, 0);

  disabledTools.push({
    connectorId: 'deepwiki', toolName: 'ask_wiki_question',
    disabledBy: 'u-admin', disabledAt: new Date().toISOString(),
  });
  view = await hub.forTenant('t1');
  assert.equal(view.registry.get('deepwiki.ask_wiki_question'), undefined, '止めたツールは一覧から消える');
  assert.ok(view.registry.get('deepwiki.read_wiki_structure'), '止めていないツールは残る');
  assert.ok(view.disabledTools.has('deepwiki.ask_wiki_question'));

  // そのツールを使う業務は、メニュー・秘書・定時実行・API から消える
  assert.equal(view.isAvailable(agentId), false, '止めたツールを使う業務は使えない');
  assert.ok(!view.agents.some((a) => a.id === agentId));
  assert.equal(view.resolve(agentId, 1)?.id, agentId, '名前を引くために、解決はできる');
  assert.equal(view.isAvailable('minutes'), true, '関係のない公式の業務は使える');

  // 戻せば、ツールも業務も戻る
  disabledTools.length = 0;
  view = await hub.forTenant('t1');
  assert.ok(view.registry.get('deepwiki.ask_wiki_question'));
  assert.equal(view.isAvailable(agentId), true);
});

test('業務が止められたツールを使うかを、名前で判定する', () => {
  const def = { tools: ['deepwiki.ask_wiki_question', 'document.create'] } as never;
  assert.equal(blockedByDisabledTool(def, new Set(['deepwiki.ask_wiki_question'])), true);
  assert.equal(blockedByDisabledTool(def, new Set(['deepwiki.read_wiki_structure'])), false);
  assert.equal(blockedByDisabledTool(def, new Set()), false);
});
