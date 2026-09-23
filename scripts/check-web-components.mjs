/**
 * @file 画面の部品が、定義も取り込みもされずに使われていないかを確かめる。
 *
 * TypeScript の型検査は、ブラウザ標準の名前（`Text`・`Option` など）を部品として書いても通す。
 * 実行するまで気づけないため、ここで機械的に見つける。
 *
 * 使い方: node scripts/check-web-components.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../packages/web/src/', import.meta.url).pathname;

/** 画面のファイルを集める。 */
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    // JSX を書けるのは .tsx だけ。型の書き方（`useState<Loaded>`）と取り違えないため
    return name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * コメントを取り除く。
 *
 * @remarks
 * 説明の中に `<ID>` のような書き方があると、JSX と取り違える。
 * 行数を保つため、消した分は改行に置き換える。
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, head) => head + m.slice(head.length).replace(/./g, ' '));
}

/**
 * JSX で使っている部品の名前（大文字で始まるもの）。
 *
 * @remarks
 * 直前が識別子の文字なら、型の指定（`useState<Loaded>`・`call<T>(`）であって JSX ではない。
 * 直後が `extends` なら、関数の型引数（`<K extends keyof T>`）である。
 * コメントの中は見ない（説明に書いた `<ID>` を部品と取り違えるため）。
 */
function usedComponents(source) {
  const code = withoutComments(source);
  const hits = [...code.matchAll(/(^|[\s(){}[\],:?=&|])<([A-Z][A-Za-z0-9_]*)(\s+extends\b|\s|\/|>)/g)];
  return new Set(hits.filter((m) => !/extends/.test(m[3])).map((m) => m[2]));
}

/** そのファイルで定義または取り込んでいる名前。 */
function definedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/\bfunction\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/\b(?:const|let|class)\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/import\s+([^;]+?)\s+from/gs)) {
    for (const part of m[1].replace(/[{}]/g, ',').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
      if (name && /^[A-Za-z0-9_]+$/.test(name)) names.add(name);
    }
  }
  return names;
}

const problems = [];
for (const path of files(ROOT)) {
  const source = readFileSync(path, 'utf8');
  const defined = definedNames(source);
  for (const used of usedComponents(source)) {
    if (!defined.has(used)) problems.push(`${path.replace(ROOT, '')}: <${used}> が定義も取り込みもされていません`);
  }
}

if (problems.length > 0) {
  console.error('画面の部品:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('ブラウザ標準の名前（Text・Option など）と重なっていないか確かめてください。');
  process.exit(1);
}
console.log('画面の部品: すべて定義または取り込みがあります。');
