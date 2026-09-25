/**
 * @file ヘルプの記事と、画面からの記事の参照を確かめる。`npm test` から呼ばれる。
 *
 * 1. `docs/help/` の記事が必須の属性（id・title・audience・category）を持ち、ID が重複しない
 * 2. 記事の `related` が実在する記事を指す
 * 3. 画面の `<HelpTip article="…">` と `openHelp('…')`、題名の説明（`article: '…'`）が実在する記事を指す
 * 4. 「？」を段落の中に置いていない（仕様書 第6.10.4.4節）。見出しの無い「？」と、文の途中の「？」を見つける
 *
 * 業務の記事（`agent-<ID>`）は定義から自動で作るため、公式エージェントの ID と照合する。
 *
 * @see 仕様書 第6.10.9節 ヘルプの内容の管理
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const helpDir = join(root, 'docs', 'help');
const problems = [];

const articles = new Map();
for (const f of readdirSync(helpDir).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
  const text = readFileSync(join(helpDir, f), 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) { problems.push(`${f}: 先頭に属性（---）がありません`); continue; }
  const attrs = Object.fromEntries(
    m[1].split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l.trim())).filter(Boolean).map((x) => [x[1], x[2]]),
  );
  for (const k of ['id', 'title', 'audience', 'category']) {
    if (!attrs[k]) problems.push(`${f}: 属性 ${k} がありません`);
  }
  if (attrs.audience && !['all', 'approver', 'admin'].includes(attrs.audience)) problems.push(`${f}: audience が不正です`);
  if (articles.has(attrs.id)) problems.push(`${f}: ID ${attrs.id} が重複しています`);
  const related = (attrs.related ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  articles.set(attrs.id, { file: f, related });
}

// 公式エージェントの ID（業務の記事 agent-<ID> の照合用）
const agentIds = new Set();
for (const f of readdirSync(join(root, 'packages/core/src/agents')).filter((f) => f.startsWith('ag-'))) {
  const m = /^\s+id: '([^']+)',/m.exec(readFileSync(join(root, 'packages/core/src/agents', f), 'utf8'));
  if (m) agentIds.add(m[1]);
}
const exists = (id) => articles.has(id) || (id.startsWith('agent-') && agentIds.has(id.slice(6)));

for (const [id, a] of articles) {
  for (const r of a.related) if (!exists(r)) problems.push(`${a.file}: related の ${r} が見つかりません（${id}）`);
}

// 画面からの参照
const webDir = join(root, 'packages/web/src');
for (const f of readdirSync(webDir).filter((f) => /\.tsx?$/.test(f))) {
  const text = readFileSync(join(webDir, f), 'utf8');
  for (const m of text.matchAll(/<HelpTip article="([^"]+)"/g)) {
    if (!exists(m[1])) problems.push(`packages/web/src/${f}: HelpTip の記事 ${m[1]} が見つかりません`);
  }
  for (const m of text.matchAll(/openHelp\('([^']+)'\)/g)) {
    if (!exists(m[1])) problems.push(`packages/web/src/${f}: openHelp の記事 ${m[1]} が見つかりません`);
  }
  // 題名の「？」の説明（PageTitle に渡す { article, text }）
  for (const m of text.matchAll(/\barticle: '([^']+)'/g)) {
    if (!exists(m[1])) problems.push(`packages/web/src/${f}: 題名の説明の記事 ${m[1]} が見つかりません`);
  }
  // 「？」は題名か見出しの横にだけ置く。段落（<p>）の中に置くと、囲みの中で離れた「？」や、文の途中の「？」になる
  for (const m of text.matchAll(/<p\b[^>]*>[^<]*<HelpTip\b/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`packages/web/src/${f}:${line}: 「？」を段落の中に置いています。題名の説明（PageTitle）へまとめてください（仕様書 第6.10.4.4節）`);
  }
}
// API のチェックリストが指す記事
const onboarding = readFileSync(join(root, 'packages/api/src/routes/onboarding.ts'), 'utf8');
for (const m of onboarding.matchAll(/help: '([^']+)'/g)) {
  if (!exists(m[1])) problems.push(`packages/api/src/routes/onboarding.ts: 記事 ${m[1]} が見つかりません`);
}

if (problems.length > 0) {
  console.error('ヘルプの記事に問題があります:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`ヘルプ: 記事 ${articles.size} 件と、画面からの参照がすべて有効です。`);
