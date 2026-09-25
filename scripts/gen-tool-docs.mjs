/**
 * @file 開発者マニュアル第4章のツールの一覧（4.2）と引数（4.3）を、ツールの定義から作る。
 *
 * ツールの `helpText`・`risk`・`google`・`args` から表を作り、docs/developer/04-tools.md の
 * `<!-- tools:start -->` から `<!-- tools:end -->` までを書き換える。手で書くと、ツールが増えるたびにずれるため。
 *
 * 使い方:
 *   npm run docs:tools           # 書き換える
 *   npm run docs:tools -- --check # 書き換えが要るかだけを確かめる（npm test で使う）
 *
 * @see 仕様書 第9.4.4節 Google Workspace を操作するツールの一覧
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_TOOLS } from '../packages/core/src/index.ts';

const FILE = join(import.meta.dirname, '..', 'docs', 'developer', '04-tools.md');
const START = '<!-- tools:start -->';
const END = '<!-- tools:end -->';
const RISK_ORDER = ['read', 'draft', 'write-internal', 'external-send', 'financial'];
const LEVEL = { restricted: '制限付き', sensitive: '機密', 'non-sensitive': '機密でない' };

const tools = [...BUILTIN_TOOLS].sort((a, b) =>
  RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk) || a.name.localeCompare(b.name));
const esc = (s) => String(s).replace(/\|/g, '\\|');

const lines = [
  START,
  '',
  '## 4.2 内蔵ツールの一覧',
  '',
  '右の列は、業務の説明の「この業務がすること」にそのまま出る文です。',
  '「Google の権限」は、そのツールが求める権限と段階です（段階は見込み。仕様書 第14.3.1節）。',
  '「制限付き」の権限を使うツールは、一般公開の前に第三者のセキュリティ評価（CASA）が必要になります。',
  '',
  '| ツール | 危険度 | Google の権限 | すること |',
  '|---|---|---|---|',
  ...tools.map((t) => `| \`${t.name}\` | ${t.risk} | ${t.google ? [t.google, ...(t.googleAlso ?? [])].map((g) => `\`${g.scope}\`（${LEVEL[g.level]}）`).join('・') : '—'} | ${esc(t.helpText)} |`),
  '',
  '## 4.3 引数',
  '',
  '推論は、次の引数でツールを呼びます。見本の応答（第5.4節）もこの形で書きます。',
  '必須の引数が無い・型が違う呼び出しは、ツールを呼ばずに理由を返します。',
  '',
  '| ツール | 引数 |',
  '|---|---|',
  ...tools.map((t) => {
    const props = Object.entries(t.args?.properties ?? {});
    const req = new Set(t.args?.required ?? []);
    const text = props.length === 0 ? 'なし' : props.map(([k, v]) =>
      `\`${k}\`${req.has(k) ? '（必須）' : ''}: ${esc(v.description)}${v.enum ? `（${v.enum.join('・')}）` : ''}`).join('、');
    return `| \`${t.name}\` | ${text} |`;
  }),
  '',
  END,
];

const doc = readFileSync(FILE, 'utf8');
const i = doc.indexOf(START);
const j = doc.indexOf(END);
if (i === -1 || j === -1) {
  console.error(`${FILE} に ${START} と ${END} がありません`);
  process.exit(1);
}
const next = doc.slice(0, i) + lines.join('\n') + doc.slice(j + END.length);
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('開発者マニュアル第4章のツールの一覧が古くなっています。npm run docs:tools を実行してください');
    process.exit(1);
  }
  console.log('ツールの一覧は最新です');
} else {
  writeFileSync(FILE, next);
  console.log(`ツール ${tools.length} 個の一覧を書き込みました: ${FILE}`);
}
