/**
 * @file 覚えたことの種類の評価を回す（仕様書 第49.6節・第49.10節、ADR-0150）。
 *
 * 問題集（`docs/evals/memory-kinds/cases.json`）の文を、M2Office が使うのと同じ指示（`kindReviewPrompt`）で推論に渡し、
 * 秘書の話し方・その時だけのこと・どちらでもないものを見分けられたかを、決まった規則で採点する。推論に採点させない。
 * 合格の目安は 9 割、かつ、言葉の一覧で分けていた文（話し方と、話し方ではない「弁護士」「代弁」など）はすべて合格（Q-386 と同じ）。
 * 費用がかかるため、自動のテスト（`npm test`）には入れない。種類の指示を直したときに回す。
 *
 * 使い方:
 *   npm run eval:memory-kinds                        # 問題の数を表示するだけ
 *   npm run eval:memory-kinds -- --yes               # 本物の推論（GEMINI_API_KEY）で回し、results/<日付>.md に残す
 *   npm run eval:memory-kinds -- --yes --tenant oesf # その会社の推論（管理者ページで入れた会社の鍵）で回す
 *
 * 文はまとめて渡す（M2Office も 60 件ずつまとめて確かめる）。並びの影響を見るため、3 通りの並びで回す。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'docs/evals/memory-kinds');
const argv = process.argv.slice(2);
const core = await tsImport('../packages/core/src/index.ts', import.meta.url);
const {
  kindReviewPrompt, parseKindReview, platformAi, PostgresRepository, TenantAiResolver, secretBoxFromEnv, aiUsageMeterFromEnv,
  defaultGeminiModels, deploymentFromEnv, localLlmFromEnv,
} = core;

const doc = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
const cases = doc.cases;
console.log(`覚えたことの種類の評価: ${cases.length} 問`);
if (!argv.includes('--yes')) {
  console.log('回すときは --yes を付けてください（GEMINI_API_KEY か、--tenant <サブドメイン> の会社の鍵が要ります。推論を 3 回呼びます）。');
  process.exit(0);
}
const tenantSub = argv.includes('--tenant') ? argv[argv.indexOf('--tenant') + 1] : null;

/** 会社の推論を、アプリと同じ仕組みで開く（`--tenant`）。鍵は暗号化されたまま読み、この中で開くだけで表に出さない。 */
async function tenantLlm(subdomain) {
  const url = process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office';
  const repo = new PostgresRepository(url);
  const tenant = await repo.findTenantBySubdomain(subdomain);
  if (!tenant) { console.error(`会社「${subdomain}」が見つかりません`); process.exit(1); }
  const { box } = secretBoxFromEnv(process.env);
  const platform = platformAi(process.env);
  const meter = aiUsageMeterFromEnv({ repo, connectionString: url, env: process.env });
  const ai = new TenantAiResolver({
    repo, box, fallbackLlm: platform.llm, fallbackResearch: platform.research, meter,
    platformKey: platform.platformKey, testMode: platform.testMode, defaults: defaultGeminiModels(), baseUrl: platform.baseUrl,
    deployment: deploymentFromEnv(process.env), local: localLlmFromEnv(process.env),
  });
  return ai.llmFor(tenant.id);
}

const llm = tenantSub ? await tenantLlm(tenantSub) : platformAi(process.env).llm;
if (!tenantSub && llm.name !== 'gemini') { console.error('GEMINI_API_KEY がありません（会社の鍵で回すときは --tenant <サブドメイン>）'); process.exit(1); }
if (llm.name === 'unconfigured') { console.error(`会社「${tenantSub}」の推論が設定されていません`); process.exit(1); }

/** 3 通りの並び（そのまま・逆・交互）。 */
const orders = [cases, [...cases].reverse(), [...cases.filter((_, i) => i % 2 === 0), ...cases.filter((_, i) => i % 2 === 1)]];
const wrong = new Map();
let correct = 0;
let total = 0;
for (const order of orders) {
  const res = await llm.complete({
    tier: 'fast', maxOutputTokens: 600,
    messages: [{ role: 'system', content: '日本語で答えます。指定された形式だけを出力します。' }, { role: 'user', content: kindReviewPrompt(order.map((c) => ({ text: c.text }))) }],
  });
  const hits = parseKindReview(res.text, order.length);
  order.forEach((c, i) => {
    const got = hits.get(i + 1) ?? null;
    total++;
    if (got === c.kind) correct++;
    else wrong.set(c.id, [...(wrong.get(c.id) ?? []), got]);
  });
}
const rate = correct / total;
const lines = [
  `# 覚えたことの種類の評価（${new Date().toISOString().slice(0, 10)}）`,
  '',
  `- 推論: ${llm.name}${tenantSub ? `（会社 ${tenantSub} の鍵）` : ''}`,
  `- 正解: ${correct} / ${total}（${Math.round(rate * 1000) / 10}%。3 通りの並び × ${cases.length} 問）`,
  `- 合格の目安: 9 割、かつ、すべての問いが 3 通りとも正解 → ${rate >= 0.9 && wrong.size === 0 ? '合格' : '不合格'}`,
  '',
  ...(wrong.size ? ['| 問い | 文 | 正しい種類 | 推論の答え（外れた並びごと） |', '|---|---|---|---|',
    ...[...wrong].map(([id, got]) => { const c = cases.find((x) => x.id === id); return `| ${id} | ${c.text} | ${c.kind ?? 'なし'} | ${got.map((g) => g ?? 'なし').join('・')} |`; })] : ['外れた問いはありません。']),
];
console.log(lines.join('\n'));
mkdirSync(join(dir, 'results'), { recursive: true });
const day = new Date().toISOString().slice(0, 10);
// 同じ日の結果があれば番号を付ける。有無を先に確かめず、書けなかったら（もうある）次の番号で書く（CodeQL js/file-system-race）
let n = 1;
let out = join(dir, 'results', `${day}.md`);
for (;;) {
  try {
    writeFileSync(out, `${lines.join('\n')}\n`, { flag: 'wx' });
    break;
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    out = join(dir, 'results', `${day}-${++n}.md`);
  }
}
console.log(`残しました: ${out}`);
