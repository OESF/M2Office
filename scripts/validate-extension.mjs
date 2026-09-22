/**
 * @file 拡張機能を検証する。API が読み込み・取り込みの時点で行うのと同じ検証を、導入の前に手元で行う。
 *
 * 使い方:
 *   npm run ext:validate                                  # extensions/ の下をすべて
 *   npm run ext:validate extensions/hello-world           # 指定したディレクトリだけ
 *   npm run ext:validate dist/extensions/foo-1.0.0.m2ext  # 作ったファイル
 *
 * 問題があれば一覧を出して終了コード 1 で終わる。
 *
 * @see 仕様書 第12.9.2節 読み込み時の検証
 * @see 仕様書 第12.10.2節 ファイルの形式
 * @see 開発者マニュアル docs/developer/06-validate-and-install.md
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BUILTIN_TOOLS, OFFICIAL_AGENTS, ToolRegistry, loadExtension, loadExtensionFiles, unpackExtension,
} from '../packages/core/src/index.ts';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

const root = join(import.meta.dirname, '..', 'extensions');
const targets = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map((d) => resolve(d))
  : readdirSync(root).map((d) => join(root, d)).filter((d) => statSync(d).isDirectory());

const takenAgents = new Set(OFFICIAL_AGENTS.map((a) => a.id));
const takenConnectors = new Set();
let failed = 0;
for (const target of targets) {
  let result;
  if (statSync(target).isDirectory()) {
    result = loadExtension(target, registry, { takenAgents, takenConnectors });
  } else {
    const unpacked = await unpackExtension(new Uint8Array(readFileSync(target)));
    result = unpacked.problems.length > 0
      ? { pkg: null, problems: unpacked.problems }
      : loadExtensionFiles(unpacked.files, registry, { takenAgents, takenConnectors });
  }
  const { pkg, problems } = result;
  if (!pkg || problems.length > 0) {
    failed += 1;
    console.log(`\x1b[31m✗\x1b[0m ${target}`);
    for (const p of problems) console.log(`    ${p}`);
    continue;
  }
  console.log(`\x1b[32m✓\x1b[0m ${pkg.manifest.name}（${pkg.manifest.id} ${pkg.manifest.version}）`);
  for (const c of pkg.connectors) {
    console.log(`    コネクタ ${c.id}: ${c.url}（認証 ${c.auth.type}）`);
    for (const t of c.tools) console.log(`      ツール ${c.id}.${t.name}=${t.risk}`);
  }
  const risk = (name) => registry.get(name)?.risk
    ?? pkg.connectors.flatMap((c) => c.tools.map((t) => [`${c.id}.${t.name}`, t.risk])).find(([n]) => n === name)?.[1];
  for (const a of pkg.agents) {
    const withStub = (a.evals ?? []).filter((e) => e.stub).length;
    console.log(`    業務エージェント ${a.id}: ${a.steps.length} ステップ、ツール ${a.tools.map((t) => `${t}=${risk(t)}`).join(', ')}`);
    console.log(`    評価のケース ${(a.evals ?? []).length} 件（うち見本の応答つき ${withStub} 件）`);
    if (withStub === 0) console.log('    \x1b[33m注意\x1b[0m: 見本の応答が無いため、LLM の鍵が無い環境では動作を確かめられません');
  }
  for (const a of pkg.agents) takenAgents.add(a.id);
  for (const c of pkg.connectors) takenConnectors.add(c.id);
}
process.exit(failed > 0 ? 1 : 0);
