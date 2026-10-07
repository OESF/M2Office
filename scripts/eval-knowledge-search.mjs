/**
 * @file 知識の意味の検索の評価を回す（仕様書 第11.7.6.5節、ADR-0009）。
 *
 * 見本の規程（`docs/evals/knowledge-search/*.md`）を節に分け、60 問について、言葉の検索（段階 2）だけのときと、
 * 意味での検索を順位の融合で合わせたときを比べる。類似度のしきい値ごとに、正解の節が上位 5 節に入る割合・
 * 答えが無い質問で何も返さない割合・質問の埋め込みにかかった時間を測り、採用の条件を満たすかを示す。
 * データベースは使わず、検索の並べ方は本番と同じ関数（`orderSections`・`fuseRankings`・`limitSections`）を使う。
 * 費用がかかるため、自動のテスト（`npm test`）には入れない。モデル・次元・しきい値を変えるたびに回す。
 *
 * 使い方:
 *   npm run eval:knowledge-search               # 問題の数と見込みの費用を表示するだけ
 *   npm run eval:knowledge-search -- --yes      # 本物の埋め込み（GEMINI_API_KEY）で回し、results/<日付>.md に残す
 *   npm run eval:knowledge-search -- --stub     # 見本の埋め込みで仕組みだけを確かめる（費用なし・結果は残さない）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'docs/evals/knowledge-search');
const argv = process.argv.slice(2);
const stub = argv.includes('--stub');

const { splitKnowledge, citationOf } = await tsImport('../packages/core/src/knowledge/sections.ts', import.meta.url);
const { orderSections, fuseRankings, limitSections, expandTerms, extractTerms, bigrams, normalizeForSearch, FUSION_DEPTH } =
  await tsImport('../packages/core/src/knowledge/search.ts', import.meta.url);
const { STANDARD_SYNONYMS } = await tsImport('../packages/shared/src/types/settings.ts', import.meta.url);
const { OpenAiCompatibleProvider } = await tsImport('../packages/core/src/llm/gemini.ts', import.meta.url);
const { StubLlmProvider } = await tsImport('../packages/core/src/llm/stub.ts', import.meta.url);
const { usdJpy, MODEL_PRICES } = await tsImport('../packages/core/src/llm/models.ts', import.meta.url);

const evals = JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8'));
const sections = evals.rules.flatMap((file) => {
  const [first, ...rest] = readFileSync(join(dir, file), 'utf8').split('\n');
  const title = first.replace(/^#+\s*/, '').trim();
  return splitKnowledge(rest.join('\n')).map((s, ordinal) => ({
    id: title, ordinal, title, heading: s.heading, path: s.path, body: s.body, updatedAt: '2026-10-01', category: 'rule',
  }));
});

const chars = sections.reduce((n, s) => n + citationOf(s.title, s).length + s.body.length, 0) + evals.cases.reduce((n, c) => n + c.question.length, 0);
const yen = (chars * (MODEL_PRICES['gemini-embedding-2']?.inputUsd ?? 0.2) / 1_000_000) * usdJpy();
console.log(`知識の意味の検索の評価: 節 ${sections.length}・問題 ${evals.cases.length} 問（見込みの費用 およそ ${yen.toFixed(2)} 円）`);
if (!argv.includes('--yes') && !stub) {
  console.log('回すときは --yes を付けてください（GEMINI_API_KEY が要ります）。仕組みだけなら --stub。');
  process.exit(0);
}
const key = process.env.GEMINI_API_KEY;
if (!stub && !key) { console.error('GEMINI_API_KEY がありません'); process.exit(1); }
const llm = stub ? new StubLlmProvider()
  : new OpenAiCompatibleProvider(key, { fast: '', standard: '', advanced: '' }, process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai');

// 節を埋め込む（32 節ずつ）
const docVectors = [];
let model = '';
for (let i = 0; i < sections.length; i += 32) {
  const batch = sections.slice(i, i + 32);
  const out = await llm.embed({ items: batch.map((s) => ({ title: citationOf(s.title, s), text: s.body })), kind: 'document' });
  docVectors.push(...out.vectors);
  model = out.model;
}
const cos = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);

// 言葉の検索（本番と同じく、2 文字の組を 1 つでも含む節を候補にしてから並べる）
const byWords = (q) => {
  const concepts = expandTerms(extractTerms(q), STANDARD_SYNONYMS);
  const grams = [...new Set(concepts.flatMap((c) => c.alternatives.flatMap(bigrams)))];
  const candidates = sections.filter((s) => grams.some((g) => normalizeForSearch([...s.path, s.heading, s.body].join('\n')).includes(g)));
  return orderSections(concepts, candidates);
};

const rows = [];
for (const c of evals.cases) {
  const started = Date.now();
  const q = await llm.embed({ items: [{ text: c.question }], kind: 'query' });
  const ms = Date.now() - started;
  const sims = sections.map((s, i) => ({ ...s, similarity: cos(q.vectors[0], docVectors[i]) })).sort((a, b) => b.similarity - a.similarity);
  rows.push({ c, words: byWords(c.question), sims, ms });
}

const keyOf = (s) => `${s.id}#${s.ordinal}`;
const correct = (c, hits) => hits.some((h) => h.title === c.title && h.heading === c.heading);
/** しきい値ごとの成績。`null` は言葉の検索だけ。 */
const measure = (threshold) => {
  const score = { literal: 0, paraphrase: 0, none: 0 };
  for (const r of rows) {
    const hits = threshold === null
      ? limitSections(r.words)
      : limitSections(fuseRankings(r.words.slice(0, FUSION_DEPTH), r.sims.filter((s) => s.similarity >= threshold).slice(0, FUSION_DEPTH), keyOf));
    if (r.c.kind === 'none') { if (hits.length === 0) score.none++; } else if (correct(r.c, hits)) score[r.c.kind]++;
  }
  return score;
};
const total = (kind) => evals.cases.filter((c) => c.kind === kind).length;
const base = measure(null);
const thresholds = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];
const results = thresholds.map((t) => {
  const s = measure(t);
  const adopt = s.paraphrase > base.paraphrase && s.literal >= base.literal && s.none / total('none') >= 0.9;
  return { t, s, adopt };
});
const best = results.filter((r) => r.adopt).sort((a, b) => b.s.paraphrase - a.s.paraphrase || b.t - a.t)[0] ?? null;
const avgMs = Math.round(rows.reduce((n, r) => n + r.ms, 0) / rows.length);

const line = (label, s, adopt) => `| ${label} | ${s.literal} / ${total('literal')} | ${s.paraphrase} / ${total('paraphrase')} | ${s.none} / ${total('none')} | ${adopt} |`;
const table = [
  '| 検索 | 言葉のまま | 言い換え | 答えが無い（何も返さない） | 採用の条件 |', '|---|---|---|---|---|',
  line('言葉の検索だけ', base, '—'),
  ...results.map((r) => line(`意味も合わせる（しきい値 ${r.t}）`, r.s, r.adopt ? '満たす' : '満たさない')),
];
console.log(table.join('\n'));
console.log(`モデル: ${model}・質問の埋め込みの平均 ${avgMs} ミリ秒・${best ? `条件を満たすしきい値のうち、言い換えがいちばん多く見つかるもの: ${best.t}` : '条件を満たすしきい値はありません'}`);

if (!stub) {
  const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  mkdirSync(join(dir, 'results'), { recursive: true });
  // 言い換えの質問で見つからなかったもの（採用のしきい値。無ければ 0.6）
  const at = best?.t ?? 0.6;
  const missed = rows.filter((r) => r.c.kind === 'paraphrase'
    && !correct(r.c, limitSections(fuseRankings(r.words.slice(0, FUSION_DEPTH), r.sims.filter((s) => s.similarity >= at).slice(0, FUSION_DEPTH), keyOf))))
    .map((r) => `- ${r.c.question}（正解: ${r.c.title} › ${r.c.heading}・類似度 ${r.sims.find((s) => s.title === r.c.title && s.heading === r.c.heading)?.similarity.toFixed(3) ?? '—'}）`);
  writeFileSync(join(dir, 'results', `${day}.md`), [
    `# 知識の意味の検索の評価（${day}）`, '',
    `モデル ${model}・節 ${sections.length}・問題 ${evals.cases.length} 問・質問の埋め込みの平均 ${avgMs} ミリ秒。採用の条件は仕様書 第11.7.6.5節。`, '',
    ...table, '',
    best ? `条件を満たすしきい値のうち、言い換えがいちばん多く見つかるもの: **${best.t}**` : '**条件を満たすしきい値はありません。**', '',
    `## 言い換えの質問で見つからなかったもの（しきい値 ${at}）`, '', ...(missed.length ? missed : ['（なし）']), '',
  ].join('\n'));
  console.log(`結果を docs/evals/knowledge-search/results/${day}.md に残しました`);
}
