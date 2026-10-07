/**
 * @file 契約書チェックの評価を自動で回す（仕様書 第28.15節「評価を自動で回す」・第28.10節、ADR-0083）。
 *
 * 見本の契約書（`docs/evals/contract-review/`）を Word にして渡し、動いている API で契約書チェックを本物の推論に通し、
 * 答えを決まった規則（`evals/contract-review.json` の `checks` と、法務の境界の言い回し）で採点する。推論に採点させない。
 * 費用がかかるため、自動のテスト（`npm test`）には入れない。リリースの前と、指示や観点を直したときに回す。
 *
 * 使い方（API とワーカーが本物の推論の鍵で動いているとき）:
 *   npm run eval:contract-review               # 見本の数と見込みの費用を表示するだけ
 *   npm run eval:contract-review -- --yes      # 回して、docs/evals/contract-review/results/<日付>.md に残す
 *   npm run eval:contract-review -- --yes --only 紛れ込んだ
 *
 * 環境変数: API_URL（既定 http://localhost:3101）・EVAL_TENANT（既定 a）・EVAL_USER（既定 admin@alpha.example.jp）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = fileURLToPath(new URL('..', import.meta.url));
const API = process.env.API_URL ?? 'http://localhost:3101';
const TENANT = process.env.EVAL_TENANT ?? 'a';
const USER = process.env.EVAL_USER ?? 'admin@alpha.example.jp';
const EXT = 'jp.m2office.legal.contract-review';
const AGENT = `${EXT}:contract-review`;
/** 1 件の見込みの費用（円。高性能のモデルで全文を読み、Word を 2 つ作る。2026-10 の料金表からの目安）。 */
const YEN_PER_CASE = 60;

const { renderDocx } = await tsImport('../packages/core/src/files/docx.ts', import.meta.url);
const { scoreEval, CONTRACT_REVIEW_AVOID, CONTRACT_REVIEW_MUST } = await tsImport('../packages/core/src/evals/score.ts', import.meta.url);

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] ?? '' : '';
const evals = JSON.parse(readFileSync(join(root, 'extensions/contract-review/evals/contract-review.json'), 'utf8'));
const cases = evals.cases.filter((c) => c.checks && (!only || c.name.includes(only)));

console.log(`契約書チェックの評価: ${cases.length} 件（見込みの費用 およそ ${(cases.length * YEN_PER_CASE).toLocaleString('ja-JP')} 円）`);
if (!argv.includes('--yes')) {
  console.log('回すときは --yes を付けてください（本物の推論の鍵で動いている API が要ります）。');
  process.exit(0);
}

const headers = { 'x-tenant': TENANT, 'x-user': USER };
const call = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
/** 見本（Markdown）を Word にして上げる。 */
const upload = async (rel) => {
  const md = readFileSync(join(root, rel), 'utf8');
  const lines = md.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = (lines[0] ?? '契約書').replace(/^#+\s*/, '');
  const bytes = await renderDocx(title, lines.slice(1).map((l) => (l.startsWith('#') ? { heading: l.replace(/^#+\s*/, ''), level: 2 } : { text: l })));
  const form = new FormData();
  form.append('file', new Blob([bytes]), `${rel.split('/').pop().replace(/\.md$/, '')}.docx`);
  const res = await fetch(`${API}/v1/files`, { method: 'POST', body: form, headers });
  const body = await res.json();
  if (!body.id) throw new Error(`見本を上げられませんでした: ${rel}（${JSON.stringify(body)}）`);
  return body.id;
};

const installed = (await call('/v1/admin/extensions')).body.items?.find((x) => x.id === EXT)?.installed;
if (!installed) await call(`/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });

const results = [];
for (const c of cases) {
  const started = Date.now();
  try {
    const input = {};
    for (const [k, v] of Object.entries(c.input)) input[k] = typeof v === 'string' && v.endsWith('.md') ? await upload(v) : v;
    const job = await call('/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AGENT, input }) });
    if (!job.body.runId) throw new Error(`業務を始められませんでした（${JSON.stringify(job.body)}）`);
    let run;
    for (let i = 0; i < 240; i++) {
      run = (await call(`/v1/runs/${job.body.runId}`)).body;
      if (['completed', 'failed', 'cancelled'].includes(run.run?.status)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    const text = [...(run.steps ?? []).map((s) => (typeof s.output === 'string' ? s.output : JSON.stringify(s.output ?? ''))), ...(run.artifacts ?? []).map((a) => a.body ?? '')].join('\n');
    const score = scoreEval(c, text, CONTRACT_REVIEW_AVOID, CONTRACT_REVIEW_MUST);
    const words = (run.artifacts ?? []).filter((a) => a.kind === 'file:docx').length;
    results.push({ ...score, status: run.run?.status, seconds: Math.round((Date.now() - started) / 1000), words, cost: run.run?.costJpy ?? null });
    console.log(`${score.passed ? '✓' : '✗'} ${c.name}${score.missing.length ? ` 見つからない: ${score.missing.join('・')}` : ''}${score.said.length ? ` 出てしまった: ${score.said.join('・')}` : ''}`);
  } catch (err) {
    results.push({ name: c.name, passed: false, missing: [], said: [], status: 'error', error: String(err) });
    console.log(`✗ ${c.name}: ${err}`);
  }
}

const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const dir = join(root, 'docs/evals/contract-review/results');
mkdirSync(dir, { recursive: true });
const rows = results.map((r) => `| ${r.name} | ${r.passed ? '合格' : '不合格'} | ${r.status} | ${(r.missing ?? []).join('・') || '—'} | ${(r.said ?? []).join('・') || '—'} | ${r.words ?? 0} | ${r.cost ?? '—'} |`);
writeFileSync(join(dir, `${day}.md`), [
  `# 契約書チェックの評価（${day}）`, '',
  `合格 ${results.filter((r) => r.passed).length} / ${results.length} 件。採点は決まった規則（仕様書 第28.15節）。`, '',
  '| 見本 | 結果 | 実行 | 見つからなかった点 | 出てしまった言い回し | Word | 費用（円） |', '|---|---|---|---|---|---|---|', ...rows, '',
].join('\n'));
console.log(`結果を docs/evals/contract-review/results/${day}.md に残しました`);
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
