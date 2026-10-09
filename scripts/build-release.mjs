/**
 * @file 本番の組み立て（仕様書 第20.4.5節、ADR-0077）。クラウドのコンテナとローカルの形の Mac のパッケージの両方の元になる。
 *
 * API とワーカーと運営の API（マスター管理画面。クラウドだけで動かす）を、それぞれ 1 つの JavaScript にまとめ（社内のパッケージ `@m2office/*` は中に入れ、外のパッケージは入れない）、
 * 画面を静的なファイルにし、実行中に読むファイル（ヘルプの記事・マニュアル・フォント・拡張機能・データベースの移行）を写す。
 * 開発用の道具（tsx・Vite の開発サーバー）は本番で動かさない。
 *
 * 使い方:
 *   npm run build:release              # dist-release/ に組み立てる
 *   npm run build:release -- --install # 組み立てたあと、外のパッケージを dist-release/node_modules に入れる
 *
 * 動かし方（組み立てたものの根で）:
 *   M2O_APP_ROOT=$PWD node --env-file-if-exists=m2office.env server/api.js
 *   M2O_APP_ROOT=$PWD node --env-file-if-exists=m2office.env server/worker.js
 *   M2O_APP_ROOT=$PWD node --env-file-if-exists=m2office.env server/ops.js     # クラウドだけ（仕様書 第23.8.15節）
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist-release');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const rootPkg = read('package.json');
const packages = ['shared', 'core', 'api', 'worker'].map((p) => read(`packages/${p}/package.json`));

// 外のパッケージ（組み立てに入れず、実行の場所に入れるもの）。版は、いま入っているものに固定する（組み立てと同じものを動かすため）
const external = new Map();
for (const pkg of packages) {
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name.startsWith('@m2office/')) continue;
    const installed = read(`node_modules/${name}/package.json`).version;
    external.set(name, installed);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'server'), { recursive: true });

// 1. API とワーカーと運営の API をまとめる
for (const [name, entry] of [['api', 'packages/api/src/index.ts'], ['worker', 'packages/worker/src/index.ts'], ['ops', 'packages/api/src/ops/index.ts']]) {
  await build({
    entryPoints: [join(root, entry)],
    outfile: join(out, 'server', `${name}.js`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    external: [...external.keys()].flatMap((n) => [n, `${n}/*`]),
    // まとめた ESM の中で require を使う外のパッケージのため
    banner: { js: "import { createRequire as __m2oRequire } from 'node:module'; const require = __m2oRequire(import.meta.url);" },
    logLevel: 'warning',
  });
}

// 2. 画面（版を埋め込むため、ここで組み立て直す）
execFileSync('npm', ['run', 'build', '-w', 'packages/web'], { cwd: root, stdio: 'inherit' });
cpSync(join(root, 'packages/web/dist'), join(out, 'web'), { recursive: true });

// 3. 実行中に読むファイル
const copy = (from, filter) => { if (existsSync(join(root, from))) cpSync(join(root, from), join(out, from), { recursive: true, filter }); };
copy('assets/fonts');
copy('docs/help', (p) => !p.endsWith('.pdf'));
copy('docs/manual', (p) => !p.endsWith('.pdf'));
copy('docs/api', (p) => !p.endsWith('.html') && !p.endsWith('.md'));
copy('extensions');
copy('db/migrations');
for (const s of ['migrate.mjs', 'create-tenant.mjs', 'create-operator.mjs', 'wait-for-db.mjs']) copy(`scripts/${s}`);

// 4. 実行の場所の package.json（外のパッケージと版。移行と会社の作成はここから動かす）
writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'm2office-release',
  version: rootPkg.version,
  private: true,
  type: 'module',
  engines: rootPkg.engines,
  description: 'M2Office の本番の組み立て（npm run build:release で作る。仕様書 第20.4.5節）',
  scripts: {
    'start:api': 'node --env-file-if-exists=m2office.env server/api.js',
    'start:worker': 'node --env-file-if-exists=m2office.env server/worker.js',
    'start:ops': 'node --env-file-if-exists=m2office.env server/ops.js',
    'db:migrate': 'node --env-file-if-exists=m2office.env scripts/migrate.mjs',
    'tenant:create': 'node --env-file-if-exists=m2office.env scripts/create-tenant.mjs',
    'ops:operator': 'node --env-file-if-exists=m2office.env scripts/create-operator.mjs',
  },
  dependencies: Object.fromEntries([...external.entries()].sort()),
}, null, 2)}\n`);
writeFileSync(join(out, 'VERSION'), `${rootPkg.version}\n`);

if (process.argv.includes('--install')) {
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' });
}

const size = (dir) => readdirSync(dir, { recursive: true }).length;
console.log(`組み立てました: dist-release/（版 ${rootPkg.version}・ファイル ${size(out)} 件・外のパッケージ ${external.size} 個）`);
