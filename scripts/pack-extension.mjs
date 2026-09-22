/**
 * @file 拡張機能のディレクトリから、持ち運べるファイル（`.m2ext`）を作る。
 *
 * 使い方:
 *   npm run ext:pack extensions/hello-world
 *   npm run ext:pack examples/extensions/weekly-report dist/weekly-report.m2ext
 *
 * 先に検証し、通らなければ作らない。出力先を省略すると `dist/extensions/<ID>-<版>.m2ext` に作る。
 * 入れてよいファイル（仕様書 第12.10.2節）以外は入れない。
 *
 * @see 仕様書 第12.10.2節 ファイルの形式
 * @see 開発者マニュアル docs/developer/05-package.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BUILTIN_TOOLS, OFFICIAL_AGENTS, ToolRegistry, loadExtension, packExtension, readExtensionDir,
  EXTENSION_FILE_MAX_BYTES,
} from '../packages/core/src/index.ts';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('使い方: npm run ext:pack <拡張機能のディレクトリ> [出力するファイル]');
  process.exit(2);
}
const dir = resolve(dirArg);
const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

const { pkg, problems } = loadExtension(dir, registry, { takenAgents: OFFICIAL_AGENTS.map((a) => a.id) });
if (!pkg || problems.length > 0) {
  console.log(`\x1b[31m✗\x1b[0m 検証を通らないため、ファイルを作りませんでした: ${dir}`);
  for (const p of problems) console.log(`    ${p}`);
  process.exit(1);
}

const { data, skipped } = await packExtension(readExtensionDir(dir));
if (data.length > EXTENSION_FILE_MAX_BYTES) {
  console.log(`\x1b[31m✗\x1b[0m 大きすぎます（${data.length} バイト。5 MB まで）`);
  process.exit(1);
}
const out = resolve(outArg ?? join(import.meta.dirname, '..', 'dist', 'extensions', `${pkg.manifest.id}-${pkg.manifest.version}.m2ext`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, data);
console.log(`\x1b[32m✓\x1b[0m ${pkg.manifest.name}（${pkg.manifest.id} ${pkg.manifest.version}）`);
console.log(`    業務エージェント ${pkg.agents.length}・コネクタ ${pkg.connectors.length}`);
console.log(`    ${out}（${data.length} バイト）`);
if (skipped.length > 0) console.log(`    入れなかったファイル: ${skipped.join(', ')}`);
