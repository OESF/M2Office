/**
 * @file 秘書・記憶・業務のコードにある言葉の一覧（正規表現）を数え、増やさないよう見張る。`npm test` から呼ばれる（仕様書 第49.9節、ADR-0150）。
 *
 * 言葉の一覧で頼みの意味を決めると、外れた言い方・当たりすぎた言い方が見つかるたびに一覧が増え、特殊化していく。
 * 残してよいのは、外れても当たりすぎても害の無い 3 種類だけ（第49.4節）で、宣言のすぐ上に印を付ける。
 *
 * ```ts
 * // @wordlist 形を読む（第49.4節）
 * const QTY = /…/;
 * ```
 *
 * 印は `形を読む`・`安全の側`・`定型` のどれか。数えるのは、ファイルの上の段の `const 名前 = /…/` の宣言。
 *
 * 1. 印の無い一覧の数が、ファイルごとに台帳（`scripts/word-lists-baseline.json`）を超えたら失敗にする
 * 2. 台帳に無いファイルに、印の無い一覧があれば失敗にする
 * 3. 知らない印は失敗にする
 *
 * 一覧を外して数が減ったら、`node scripts/check-word-lists.mjs --update` で台帳を下げる（下げた数を変更の履歴に書く。第49.9節）。
 * 台帳を上げてはならない。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const baselinePath = join(root, 'scripts', 'word-lists-baseline.json');
const DIRS = ['packages/core/src/secretary', 'packages/core/src/memory', 'packages/core/src/engine'];
const KINDS = new Set(['形を読む', '安全の側', '定型']);
const DECL = /^(export )?const ([A-Za-z_0-9]+) = \//;
const TAG = /@wordlist\s+(\S+?)(?:（|$|\s)/;

const problems = [];
const untagged = {};
let tagged = 0;
for (const dir of DIRS) {
  for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith('.ts'))) {
    const path = join(root, dir, f);
    const rel = relative(root, path);
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = DECL.exec(line);
      if (!m) return;
      // 宣言のすぐ上に続くコメントの行から、印を探す
      let kind = null;
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/**'))) break;
        const k = TAG.exec(t);
        if (k) { kind = k[1]; break; }
      }
      if (kind === null) { untagged[rel] = (untagged[rel] ?? 0) + 1; return; }
      if (!KINDS.has(kind)) problems.push(`${rel}:${i + 1}: 知らない印「${kind}」です（形を読む・安全の側・定型のどれか）`);
      else tagged++;
    });
  }
}

const total = Object.values(untagged).reduce((a, b) => a + b, 0);
if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(untagged).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`言葉の一覧の台帳を書き直しました（印の無いもの ${total}・印のあるもの ${tagged}）`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
for (const [file, n] of Object.entries(untagged)) {
  const allowed = baseline[file] ?? 0;
  if (n > allowed) {
    problems.push(`${file}: 印の無い言葉の一覧が ${n} 個あります（台帳は ${allowed}）。頼みの意味は推論が読みます。残すなら、形を読む・安全の側・定型のどれかの印を付けてください（仕様書 第49.4節）`);
  }
}
const before = Object.values(baseline).reduce((a, b) => a + b, 0);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`言葉の一覧: 印の無いもの ${total}（台帳 ${before}）・印のあるもの ${tagged}${total < before ? '。減ったので --update で台帳を下げてください' : ''}`);
