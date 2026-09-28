/**
 * @file スキル（SKILL.md）で書いた業務エージェントの単体テスト。
 *
 * スキルの項目（name・description・when_to_use・argument-hint・arguments と $ARGUMENTS・disable-model-invocation・
 * user-invocable・allowed-tools・effort・補助のファイル）が同じ意味で効くこと、M2Office で足すもの（HELP.md・m2office-*）、
 * プログラムを動かさないことを確かめる。
 *
 * @see 仕様書 第12.12節、ADR-0029
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import {
  BUILTIN_TOOLS, SKILL_FOLDER_ENTRY, ToolRegistry, buildAgentHelp, loadExtension, loadExtensionFiles, parseSkill, parseInputs,
  substituteArguments, unpackExtension, type ExtensionFiles,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);
const enc = (s: string) => new TextEncoder().encode(s);
const load = (files: Record<string, string>) => loadExtensionFiles(new Map(Object.entries(files).map(([k, v]) => [k, enc(v)])), registry);

const SKILL = `---
name: expense-check
description: 経費の申請を社内の規程と照らし合わせる
when_to_use: 「経費を確認して」と頼まれたとき
argument-hint: 申請の内容を貼り付けてください
allowed-tools: knowledge.search Read Bash(git:*)
effort: low
license: Apache-2.0
metadata:
  author: 株式会社サンプル
  version: "1.2.0"
---

# 経費精算チェック

次の申請を規程と照らし合わせる。

$ARGUMENTS

費目の区分は [reference.md](reference.md) に従う。
`;

test('フロントマターを読む（一覧・真偽・複数行の文字・metadata）。無くても全体を本文として読む', () => {
  const p = parseSkill('---\nname: x\narguments: [a, b]\ntags:\n  - one\n  - "two"\nuser-invocable: no\nmetadata:\n  m2office-inputs: |\n    申請: 長文\n    期限: 日付（任意）\n---\n本文');
  assert.deepEqual(p.frontmatter['arguments'], ['a', 'b']);
  assert.deepEqual(p.frontmatter['tags'], ['one', 'two']);
  assert.equal(p.frontmatter['user-invocable'], 'no');
  assert.equal((p.frontmatter['metadata'] as Record<string, string>)['m2office-inputs'], '申請: 長文\n期限: 日付（任意）');
  assert.deepEqual(parseSkill('# 見出しだけ'), { frontmatter: {}, body: '# 見出しだけ' });
});

test('スキルの項目が同じ意味で効く: 名前・説明・いつ使うか・引数の例・effort。見出しが画面の名前', () => {
  const { pkg, problems, notices } = load({ 'SKILL.md': SKILL, 'reference.md': '交通費は…' });
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.equal(def.id, 'skill.expense-check:expense-check');
  assert.equal(def.name, '経費精算チェック', '本文の最初の見出し');
  assert.equal(def.description, '経費の申請を社内の規程と照らし合わせる（「経費を確認して」と頼まれたとき）', 'when_to_use を秘書の手がかりに添える');
  assert.equal(def.help?.summary, '経費の申請を社内の規程と照らし合わせる');
  assert.deepEqual((def.inputs as { properties: Record<string, { examples?: string[] }> }).properties['request']!.examples, ['申請の内容を貼り付けてください']);
  assert.equal(def.tier, 'fast', 'effort: low は高速のモデル');
  assert.deepEqual(def.tools, ['knowledge.search', 'skill.read'], 'M2Office の道具と、補助のファイルを読む道具');
  assert.match(notices!.join('\n'), /Read・Bash は M2Office の道具ではない/);
  assert.equal(pkg!.manifest.version, '1.2.0');
  assert.equal(pkg!.manifest.publisher.name, '株式会社サンプル');
});

test('$ARGUMENTS・$N・$名前 を入力で置き換える（スキルと同じ）', () => {
  assert.equal(substituteArguments('課題 $0 を $1 まで。全部: $ARGUMENTS。$ARGUMENTS[1]。\\$1.00', { issue: '123', due: '金曜' }, ['issue', 'due']),
    '課題 123 を 金曜 まで。全部: 123 金曜。金曜。$1.00');
  assert.equal(substituteArguments('会議: $会議名 / $知らない', { 会議名: '営業定例' }, ['会議名']), '会議: 営業定例 / $知らない', '知らない名前は残す');
  assert.equal(substituteArguments('依頼: $ARGUMENTS', { request: '見積を確認して' }, []), '依頼: 見積を確認して');
});

test('arguments から入力の欄を作る。m2office-inputs があれば種類付きの欄にする', () => {
  const byArgs = parseInputs(undefined, ['会議名', '記録'], '9月度 営業定例');
  assert.deepEqual(byArgs.schema.required, ['会議名', '記録']);
  assert.deepEqual(byArgs.schema.properties['会議名']!.examples, ['9月度 営業定例']);
  const typed = parseInputs('申請の内容: 長文\n対象期間を指定: 日付（任意）', ['無視される']);
  assert.deepEqual(typed.schema.required, ['申請の内容']);
  assert.equal(typed.schema.properties['対象期間を指定']!.format, 'date');
  assert.match(parseInputs('期限: 時刻').problems[0]!, /種類は/);
});

test('disable-model-invocation は秘書が取り次がない。user-invocable: false はメニューに出さない', () => {
  const quiet = load({ 'SKILL.md': '---\nname: deploy\ndescription: 出す\ndisable-model-invocation: true\n---\n本文' }).pkg!.agents[0]!;
  assert.equal(quiet.secretaryRoute, false);
  assert.equal(quiet.menu, undefined);
  const background = load({ 'SKILL.md': '---\nname: glossary\ndescription: 社内の用語\nuser-invocable: false\n---\n本文' }).pkg!.agents[0]!;
  assert.equal(background.menu, false);
  assert.equal(background.secretaryRoute, undefined);
});

test('allowed-tools: 書かなければ読むだけの道具、空なら道具なし', () => {
  assert.deepEqual(load({ 'SKILL.md': '---\nname: a\ndescription: b\n---\n本文' }).pkg!.agents[0]!.tools, ['knowledge.search', 'file.read_text']);
  assert.deepEqual(load({ 'SKILL.md': '---\nname: a\ndescription: b\nallowed-tools: ""\n---\n本文' }).pkg!.agents[0]!.tools, []);
});

test('送る道具を書くと「作業 → 承認 → 送る」を組み立てる（書き手は承認を書かない）', () => {
  const { pkg, problems } = load({ 'SKILL.md': '---\nname: reply\ndescription: 返信する\nallowed-tools: gmail.get gmail.send\n---\n返信する' });
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.deepEqual(def.steps.map((s) => `${s.type}:${s.id}`), ['agent:work', 'approval:approve', 'agent:send']);
  assert.deepEqual((def.steps[2] as { tools: string[] }).tools, ['gmail.send']);
  assert.equal(pkg!.manifest.permissions.max_risk_level, 'external-send');
});

test('HELP.md を業務の説明の本文にし、道具の説明と組み立てた段は出さない', () => {
  const { pkg } = load({ 'SKILL.md': SKILL, 'HELP.md': '# 経費精算チェック\n\n申請を貼ると、規程に合わない点を指摘します。' });
  const def = pkg!.agents[0]!;
  assert.match(def.help?.body ?? '', /規程に合わない点/);
  const view = buildAgentHelp(def, registry);
  assert.match(view.body ?? '', /規程に合わない点/);
  assert.deepEqual(view.does, []);
  assert.deepEqual(view.flow, []);
});

test('プログラムと画像は取り込まず、本文のコマンドは消して知らせる。補助のファイルは持ち込む', () => {
  const res = load({
    'SKILL.md': SKILL.replace('$ARGUMENTS', '$ARGUMENTS\n\n!`git diff HEAD`'),
    'scripts/extract.py': 'print(1)', 'assets/logo.png': 'x', 'reference.md': '交通費は…',
  });
  assert.deepEqual(res.problems, []);
  const notes = res.notices!.join('\n');
  assert.match(notes, /コマンド（!`…`）1 か所は実行しません/);
  assert.match(notes, /scripts\/extract\.py, assets\/logo\.png/);
  assert.deepEqual([...res.keep!.keys()].sort(), ['SKILL.md', 'reference.md']);
  const def = res.pkg!.agents[0]!;
  assert.doesNotMatch((def.steps[0] as { instruction: string }).instruction, /git diff/);
  assert.deepEqual(def.skill?.files.map((f) => f.path), ['reference.md']);
});

test('name を省けばフォルダの名前。description を省けば本文の最初の行', async () => {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('meeting-memo/SKILL.md', '# 会議メモの整理\n\nメモを整理する。');
  const unpacked = await unpackExtension(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(new TextDecoder().decode(unpacked.files.get(SKILL_FOLDER_ENTRY)), 'meeting-memo');
  const { pkg, problems, keep } = loadExtensionFiles(unpacked.files, registry);
  assert.deepEqual(problems, []);
  assert.equal(pkg!.agents[0]!.id, 'skill.meeting-memo:meeting-memo');
  assert.equal(pkg!.agents[0]!.help?.summary, '会議メモの整理');
  assert.ok(keep!.has(SKILL_FOLDER_ENTRY), '保存し直しても名前が変わらないように、フォルダの名前も残す');
  const single = await unpackExtension(enc('---\nname: a\ndescription: b\n---\n本文'));
  assert.deepEqual([...single.files.keys()], ['SKILL.md']);
});

test('書き方の誤りは、直し方の分かる言葉で断る', () => {
  const bad = load({ 'SKILL.md': '---\nname: Bad_Name\n---\n' });
  assert.ok(bad.problems.some((p) => /英小文字/.test(p)));
  assert.ok(bad.problems.some((p) => /本文/.test(p)));
  const files: ExtensionFiles = new Map([['SKILL.md', enc('本文だけ')]]);
  assert.ok(loadExtensionFiles(files, registry).problems.some((p) => /name がありません/.test(p)));
});

test('見本の拡張機能「あいさつ」はスキルの書き方のままで、業務の ID は前と同じ', () => {
  const { pkg, problems } = loadExtension(new URL('../../../extensions/hello-world', import.meta.url).pathname, registry);
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.equal(def.id, 'jp.m2office.samples.hello-world:hello');
  assert.equal(def.name, 'あいさつ（サンプル）');
  assert.deepEqual(def.tools, []);
  assert.deepEqual(Object.keys((def.inputs as { properties: object }).properties), ['あいさつ']);
  assert.ok(def.help?.body);
});

test('実行のとき、推論に渡す指示の $名前 を入力で置き換え、補助のファイルは skill.read で開ける', async () => {
  const { RunEngine, MockWorkspaceConnector, MemoryFileStore } = await import('../src/index.js');
  const { pkg } = load({ 'SKILL.md': '---\nname: memo\ndescription: 整理する\narguments: [会議名]\n---\n# 整理\n会議「$会議名」を整理する。[t.md](t.md) に従う', 't.md': '宿題は担当つきで書く' });
  const def = pkg!.agents[0]!;
  const prompts: string[] = [];
  let round = 0;
  const llm = {
    name: 'test',
    async complete(req: { messages: { content: string }[] }) {
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      round += 1;
      return { text: round === 1 ? '```tool\n{"name":"skill.read","args":{"path":"t.md"}}\n```' : '整理しました', tokensUsed: 1 };
    },
  };
  const now = new Date().toISOString();
  const steps: Record<string, unknown>[] = [];
  const run = { id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now, endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null };
  const repo = {
    getJob: async () => ({ id: 'j1', tenantId: 't', agentId: def.id, agentVersion: 1, requestedBy: 'u', origin: 'menu', input: { 会議名: '営業定例' }, createdAt: now }),
    getTenantSettings: async () => structuredClone(DEFAULT_TENANT_SETTINGS),
    listUserGroupIds: async () => [], listUserCompartments: async () => [], getRun: async () => run,
    updateRun: async () => undefined, appendRunStep: async (_t: string, s: Record<string, unknown>) => { steps.push(s); },
    updateRunStep: async (_t: string, s: Record<string, unknown>) => { steps.splice(steps.findIndex((x) => x['id'] === s['id']), 1, s); },
    listRunSteps: async () => steps, appendAudit: async () => undefined, listArtifacts: async () => [], listUsers: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: {} } }), createNotification: async () => undefined, listNotifications: async () => [],
    recordActivity: async () => undefined, setStepActivity: async () => undefined,
  } as unknown as import('../src/index.js').Repository;
  const engine = new RunEngine({ repo, llm: llm as never, registry, connector: new MockWorkspaceConnector(), files: new MemoryFileStore(), resolveDefinition: () => def });
  await engine.advance(run as never);
  assert.match(prompts[0]!, /会議「営業定例」を整理する/, '$会議名 を置き換える');
  const read = (steps[0]!['output'] as { tools: { name: string; result?: { text?: string } }[] }).tools.find((t) => t.name === 'skill.read');
  assert.equal(read?.result?.text, '宿題は担当つきで書く');
});

test('学ばない業務の印・推論の強さの上限・ファイルの欄（契約書チェック。第12.12.3節・第12.12.5節）', async () => {
  const { pkg, problems } = load({
    'SKILL.md': [
      '---', 'name: contract-review', 'description: 契約書を読んで注意したい点をまとめる', 'effort: xhigh',
      'allowed-tools: file.read_text docx.render', 'metadata:', '  m2office-private: "true"', '  m2office-inputs: |',
      '    契約書: ファイル', '    気になる点・背景: 長文（任意）', '---', '# 契約書チェック', '契約書: $契約書',
    ].join('\n'),
  });
  assert.deepEqual(problems, []);
  const def = pkg!.agents[0]!;
  assert.equal(def.private, true, 'm2office-private で学ばない業務になる');
  assert.equal(def.tier, 'advanced');
  assert.equal(def.limits.maxTokens, 300_000, '強さを上げたスキルは上限も大きい');
  const { fileInputKey } = await import('@m2office/shared');
  assert.equal(fileInputKey(def), '契約書', '「ファイル」と書いた欄が、渡されたファイルの入る欄');
  const { acceptsFile } = await import('../src/index.js');
  assert.equal(acceptsFile(def), true, '秘書が契約書を渡せる');
  const plain = load({ 'SKILL.md': SKILL, 'reference.md': '区分' }).pkg!.agents[0]!;
  assert.equal(plain.private, undefined);
  assert.equal(plain.limits.maxTokens, 100_000);
  assert.equal(fileInputKey(plain), null);
});
