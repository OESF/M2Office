/**
 * @file 画面の作りを機械的に確かめる。2 つを見る。
 *
 * 1. 部品が、定義も取り込みもされずに使われていないか。
 *    TypeScript の型検査は、ブラウザ標準の名前（`Text`・`Option` など）を部品として書いても通す。
 * 2. **利用者に見える文に、社内の文書への参照が混じっていないか**（仕様書 第6.10.4.1節）。
 *    「仕様書 第6.1.3節」のような書き方は、コードの説明には要るが、画面に出してはならない。
 *    実際に個人設定へ出ていた（2026-09-24）。
 * 3. **画面の言葉の決まりに外れた言い方が無いか。** クリップボードへのコピーは「コピー」「コピーしました」で、
 *    「写す」は使わない（2026-10-03 に決めたのに、2026-10-30 に体験版の画面で使ってしまった）。
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

/**
 * 利用者に見える文に、社内の文書への参照が混じっていないか（仕様書 第6.10.4.1節）。
 *
 * @remarks
 * コメントは見ない（コードの説明には要る）。JSX の文字と、画面に出る属性
 * （`title`・`placeholder`・`aria-label`・`alt`）を見る。
 */
function docLeaks(source) {
  const code = withoutComments(source);
  const bad = /(仕様書\s*第[0-9.]+節|開発規約\s*第[0-9.]+節|不変則\s*I-[0-9]+|ADR-[0-9]{4}|第[0-9]+\.[0-9.]+節)/;
  const hits = [];
  // 画面に出る属性
  for (const m of code.matchAll(/\b(title|placeholder|aria-label|alt)\s*=\s*(["'])([^"']*)\2/g)) {
    if (bad.test(m[3])) hits.push(`${m[1]}="${m[3]}"`);
  }
  // JSX の中の地の文（タグとタグのあいだ）
  for (const m of code.matchAll(/>([^<>{}]*[^\s<>{}][^<>{}]*)</g)) {
    if (bad.test(m[1])) hits.push(m[1].trim());
  }
  return hits;
}

/** 画面で使わない言い方と、代わりに使う言葉。 */
const AVOID_WORDS = [
  { word: /写す|写しました/, use: '「コピー」「コピーしました」' },
];

/**
 * 画面の言葉の決まりに外れた言い方を探す。
 *
 * @remarks コメントは見ない。文字列（`'…'`・`"…"`・`` `…` ``）と JSX の地の文を見る
 */
function wordRuleHits(source) {
  const code = withoutComments(source);
  const texts = [
    ...[...code.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]),
    ...[...code.matchAll(/>([^<>{}]*[^\s<>{}][^<>{}]*)</g)].map((m) => m[1]),
  ];
  const hits = [];
  for (const t of texts) {
    for (const r of AVOID_WORDS) if (r.word.test(t)) hits.push(`「${t.trim()}」→ ${r.use}`);
  }
  return hits;
}

const problems = [];
for (const path of files(ROOT)) {
  const source = readFileSync(path, 'utf8');
  const defined = definedNames(source);
  for (const used of usedComponents(source)) {
    if (!defined.has(used)) problems.push(`${path.replace(ROOT, '')}: <${used}> が定義も取り込みもされていません`);
  }
  for (const leak of docLeaks(source)) {
    problems.push(`${path.replace(ROOT, '')}: 画面に社内の文書への参照が出ています: ${leak}`);
  }
  for (const hit of wordRuleHits(source)) {
    problems.push(`${path.replace(ROOT, '')}: 画面の言葉の決まりに外れています: ${hit}`);
  }
}

if (problems.length > 0) {
  console.error('画面の確認:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('部品はブラウザ標準の名前（Text・Option など）と重なっていないか、');
  console.error('文は「仕様書 第○節」のような社内の参照を含んでいないか、画面の言葉の決まりに合っているかを確かめてください。');
  process.exit(1);
}
console.log('画面の確認: 部品の取り込みと、利用者に見える文の書き方はどちらも問題ありません。');
