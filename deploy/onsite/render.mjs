/**
 * @file ローカルの形の雛形（`{{名前}}`）を、答えの値で埋める（仕様書 第8.6.1節、ADR-0077）。setup.sh から呼ぶ。
 *
 * 使い方: node render.mjs <答えのファイル（KEY=値 の行）> <雛形> <出力先>
 *
 * launchd の設定（.plist）に入れる値は、XML として書けるように置き換える。埋められない名前が残れば、書かずに止める
 * （空のまま起動して、分かりにくい失敗をさせないため）。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , answersFile, template, output] = process.argv;
if (!answersFile || !template || !output) {
  console.error('使い方: node render.mjs <答えのファイル> <雛形> <出力先>');
  process.exit(2);
}

/** `KEY=値` の行を読む（値は 1 行。前後の引用符は外し、`\n`・`\t` は改行と字下げにする。入口の TLS の段のため）。 */
const values = {};
for (const line of readFileSync(answersFile, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (!m) continue;
  values[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

const xml = template.endsWith('.plist');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const missing = new Set();
const out = readFileSync(template, 'utf8').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
  if (!(name in values)) { missing.add(name); return ''; }
  return xml ? esc(values[name]) : values[name];
});
if (missing.size) {
  console.error(`埋められない名前があります: ${[...missing].join(', ')}（${template}）`);
  process.exit(1);
}
writeFileSync(output, out);
