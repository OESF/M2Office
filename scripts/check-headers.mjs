/**
 * @file すべてのソースファイルがファイルヘッダーから始まっているかを確かめる。
 *
 * `.ts`・`.tsx`・`.mjs`・`.js` は 1 行目が `/**`、2 行目が ` * @file` で始まること。
 * Python は coding 行の直後が docstring であること。
 * 違反があれば一覧を出して終了コード 1 で終わる。`npm test` から呼ばれる。
 *
 * @see 開発規約 第5.3節 ファイルの先頭（ファイルヘッダー）
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs|js|py)$/.test(f) && !f.endsWith('.d.ts'));

const bad = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue; // 削除済みでまだ記録されていないもの
  }
  const lines = text.split('\n');
  const ok = f.endsWith('.py')
    ? lines[0] === '# -*- coding: utf-8 -*-' && lines[1]?.startsWith('"""')
    : lines[0] === '/**' && lines[1]?.startsWith(' * @file ');
  if (!ok) bad.push(f);
}

if (bad.length > 0) {
  console.error('ファイルヘッダーが無い、またはインポート文より後ろにあるファイル:');
  for (const f of bad) console.error(`  ${f}`);
  console.error('開発規約 第5.3節に従い、先頭に /** @file … */ を置いてください。');
  process.exit(1);
}
console.log(`ファイルヘッダー: ${files.length} ファイルすべて規約どおりです。`);
