/**
 * @file 公開用のリポジトリへの書き出し（仕様書 第22.5節、ADR-0060）。
 *
 * 開発用のリポジトリの履歴は引き継がない。いまのコミット（HEAD）の、追跡しているファイルだけを空のフォルダに書き出す。
 * 書き出す前に公開の前の点検（`scripts/check-publish.mjs`）を通し、問題があれば書き出さない。
 * 公開用のリポジトリへのコミットと push は、書き出した中身を人が確かめてから行う（このスクリプトは行わない）。
 *
 * 使い方:
 *   npm run publish:export -- ../m2office-public
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const dest = process.argv[2] ? resolve(process.argv[2]) : null;
if (!dest) {
  console.error('書き出す先のフォルダを指定してください（例: npm run publish:export -- ../m2office-public）');
  process.exit(2);
}
if (existsSync(dest) && readdirSync(dest).filter((f) => f !== '.git').length > 0) {
  console.error(`書き出す先が空ではありません: ${dest}（.git 以外を空にしてから書き出してください）`);
  process.exit(2);
}
// 追跡していない変更があれば止める（コミットした中身だけを公開する）
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
  console.error('コミットしていない変更があります。コミットしてから書き出してください');
  process.exit(2);
}
const check = spawnSync(process.execPath, ['scripts/check-publish.mjs'], { cwd: root, stdio: 'inherit' });
if (check.status !== 0) {
  console.error('公開の前の点検を通らなかったため、書き出しませんでした');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 1024 * 1024 * 512 });
execFileSync('tar', ['-x', '-C', dest], { input: archive });
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
console.log(`書き出しました: ${dest}（開発用のリポジトリの ${head} の中身。履歴は含みません）`);
console.log('次に、中身を確かめてから、公開用のリポジトリでコミットして push してください。');
