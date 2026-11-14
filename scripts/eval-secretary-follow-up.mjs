/**
 * @file 秘書の続きの頼みの評価を回す（仕様書 第10.7.4.5節、ADR-0147）。
 *
 * 問題集（`docs/evals/secretary-follow-up/cases.json`。100 問）の各問について、これまでのやり取りを見本の会話ログに置き、
 * 秘書に頼みを渡して、選んだ先（業務・秘書が自分で答える・決め打ちの照会）と、答えや業務への材料に入るべきもの
 * （話に出たもののリンク・開いている 1 件の ID）を決まった規則で採点する。推論に採点させない。
 * 作業の記憶を切ったとき（直す前）と、使ったとき（直した後）を比べる。合格の目安は 9 割（Q-365）。
 * 費用がかかるため、自動のテスト（`npm test`）には入れない。秘書の振り分けや記憶の渡し方を直したときに回す。
 *
 * 使い方:
 *   npm run eval:secretary-follow-up                  # 問題の数を表示するだけ
 *   npm run eval:secretary-follow-up -- --yes         # 本物の推論（GEMINI_API_KEY）で前と後を回し、results/<日付>.md に残す
 *   npm run eval:secretary-follow-up -- --yes --after # 直した後だけを回す
 *   npm run eval:secretary-follow-up -- --stub        # 見本の推論で仕組みだけを確かめる（費用なし・結果は残さない）
 *   npm run eval:secretary-follow-up -- --yes --only A # 分類（A〜F）か ID で絞る
 *   npm run eval:secretary-follow-up -- --yes --tenant oesf # その会社の推論（管理者ページで入れた会社の鍵）で回す
 *
 * `--tenant <サブドメイン>` は、データベース（DATABASE_URL）からその会社を引き、アプリと同じ仕組み（TenantAiResolver）で
 * 会社の推論を開く。鍵は暗号化されたまま読み、この中で開くだけで、表に出さない（M2OFFICE_SECRET_KEY が要る）。
 * 使った分は、その会社の AI の利用（用途 `eval:secretary-follow-up`）として数え、会社の上限も効く。
 * 会社の会話・メール・資料などの中身は使わない（問題集の見本のやり取りだけを使う）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'docs/evals/secretary-follow-up');
const argv = process.argv.slice(2);
const stub = argv.includes('--stub');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const core = await tsImport('../packages/core/src/index.ts', import.meta.url);
const {
  Secretary, OFFICIAL_AGENTS, platformAi, StubLlmProvider, PostgresRepository, TenantAiResolver, secretBoxFromEnv, aiUsageMeterFromEnv,
  withAiUsage, defaultGeminiModels, deploymentFromEnv, localLlmFromEnv,
} = core;
const tenantSub = argv.includes('--tenant') ? argv[argv.indexOf('--tenant') + 1] : null;

const doc = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
const cases = doc.cases.filter((c) => !only || c.category === only || c.id === only);
console.log(`秘書の続きの頼みの評価: ${cases.length} 問`);
if (!argv.includes('--yes') && !stub) {
  console.log('回すときは --yes を付けてください（GEMINI_API_KEY か、--tenant <サブドメイン> の会社の鍵が要ります。1 問で推論を 2〜4 回呼びます）。仕組みだけなら --stub。');
  process.exit(0);
}

/**
 * 会社の推論を、アプリと同じ仕組みで開く（`--tenant`）。
 *
 * @returns 推論と、AI の利用を数える範囲を決める関数
 */
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

const llm = stub ? new StubLlmProvider() : tenantSub ? await tenantLlm(tenantSub) : platformAi(process.env).llm;
if (!stub && !tenantSub && llm.name !== 'gemini') { console.error('GEMINI_API_KEY がありません（会社の鍵で回すときは --tenant <サブドメイン>）'); process.exit(1); }
if (!stub && llm.name === 'unconfigured') { console.error(`会社「${tenantSub}」の推論が設定されていません`); process.exit(1); }

const AGENTS = OFFICIAL_AGENTS.filter((a) => ['secretary-lookup', 'document-draft', 'slides', 'quote', 'scheduling', 'sheet-builder', 'calendar-register', 'minutes'].includes(a.id));
const WEEKDAYS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

/** 今日より前の直近のその曜日の、日本時間 10 時。 */
function lastWeekday(name, now) {
  const want = WEEKDAYS.indexOf(name);
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  let back = (jst.getUTCDay() - want + 7) % 7;
  if (back === 0) back = 7;
  const day = new Date(jst.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  return new Date(`${day}T01:00:00.000Z`);
}

/** 1 問ぶんの見本の永続化層。会話ログ・実行の記録・監査（照会の ID を読む）を持つ。 */
function repoFor(c, now) {
  const dayOf = (iso) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
  const rows = c.history.map((h, i) => {
    const at = h.weekday ? new Date(lastWeekday(h.weekday, now).getTime() + i * 60_000) : new Date(now.getTime() - (c.history.length - i) * 120_000);
    return { id: `c${i}`, tenantId: 't', userId: 'u', message: h.message, reply: h.reply, layer: 'full', agentId: null, runId: null, createdAt: at.toISOString(), mentions: h.mentions ?? [] };
  });
  const runs = rows.flatMap((r) => r.mentions.filter((m) => m.kind === 'run').map((m) => ({
    run: { id: m.id, status: 'completed', startedAt: r.createdAt, endedAt: r.createdAt },
    job: { agentId: 'secretary-lookup', input: { request: m.title.replace(/^.*?「|」$/g, '') } },
  })));
  const audits = [];
  const repo = {
    audits,
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' }, automation: {} }),
    getUserSettings: async () => ({ secretary: { name: '', callMe: '', style: 'polite', proactivity: 'low' }, memory: { keepConversations: true, learning: true, excludes: [] }, profile: { timezone: 'Asia/Tokyo' }, display: {} }),
    findUserById: async () => ({ id: 'u', displayName: '本人', roles: [] }),
    listMemories: async () => [],
    listUserCompartments: async () => [],
    listRoutingMemories: async () => [],
    listCaseNotes: async () => [],
    getUserProfile: async () => null,
    searchKnowledge: async () => ({ hits: [], rewrites: [] }),
    appendAudit: async (a) => { audits.push(a); },
    appendConversation: async () => undefined,
    touchMemories: async () => undefined,
    listConversationDigests: async () => [],
    listConversationsOfDay: async (_t, _u, d) => rows.filter((r) => r.createdAt >= d.from && r.createdAt < d.to),
    listConversationDays: async (_t, _u, since) => [...new Set(rows.filter((r) => r.createdAt >= since).map((r) => dayOf(r.createdAt)))].sort().reverse(),
    listConversationsBetween: async (_t, _u, from, to) => rows.filter((r) => r.createdAt >= from && r.createdAt < to),
    listRunsWithJobs: async () => [...runs].reverse(),
    listActivePlans: async () => [],
    listPendingApprovals: async () => [],
    // 段取りを選んだら、先は plan として数える（2026-11-14 の 2 回目で、見本に無くて例外になった）
    createPlan: async () => undefined,
    saveUserSettings: async () => undefined,
    listSchedules: async () => [],
  };
  return repo;
}

/** 見本の接続口。決め打ちの照会が呼ぶものに、空の答えを返す。 */
const connector = {
  calendar: { list: async () => [], listEvents: async () => [] },
  mail: { unreadCount: async () => 0, unread: async () => [], listUnread: async () => [], search: async () => [] },
  tasks: { list: async () => [], create: async () => ({}) },
  sourceFor: () => 'mock',
};

async function runCase(c, workingMemory) {
  const now = new Date();
  const repo = repoFor(c, now);
  const started = [];
  const s = new Secretary({
    repo, llm, connector, agents: AGENTS, workingMemory,
    startLookup: async (_t, _u, request, _f, context) => { started.push({ agentId: 'secretary-lookup', context: context ?? '' }); return { runId: 'r-new', already: false }; },
    startAgent: async (_t, _u, agent, input) => { started.push({ agentId: agent.id, context: JSON.stringify(input) }); return { runId: 'r-new', already: false }; },
  });
  let reply;
  try {
    // AI の利用は、評価の用途として数える（会社の鍵で回すとき。第6.6.2節）
    reply = await withAiUsage({ userId: null, purpose: 'eval:secretary-follow-up' }, () => s.respond('t', 'u', c.message, undefined, c.screen ? { screen: c.screen } : {}));
  } catch (err) {
    return { ok: false, got: `例外: ${err.message}` };
  }
  const direct = repo.audits.find((a) => a.action === 'secretary.direct')?.targetId;
  const planned = reply.lookup?.runId?.startsWith('plan:');
  const got = started[0]?.agentId ?? (planned ? 'plan' : direct ? `direct:${direct}` : reply.suggestedAgent ? reply.suggestedAgent.id : 'none');
  const problems = [];
  if (c.expect.route && got !== c.expect.route) problems.push(`先: ${got}（期待 ${c.expect.route}）`);
  for (const s of c.expect.answerContains ?? []) if (!reply.text.includes(s)) problems.push(`答えに「${s}」が無い`);
  for (const s of c.expect.contextContains ?? []) if (!started.some((x) => x.context.includes(s))) problems.push(`業務への材料に「${s}」が無い`);
  return { ok: problems.length === 0, got, problems, answer: reply.text.slice(0, 160).replace(/\n/g, ' ') };
}

const modes = argv.includes('--after') ? [['後', true]] : [['前', false], ['後', true]];
const results = {};
for (const [label, wm] of modes) {
  results[label] = [];
  for (const c of cases) {
    const r = await runCase(c, wm);
    results[label].push({ id: c.id, category: c.category, ...r });
    process.stdout.write(r.ok ? '.' : 'x');
  }
  const pass = results[label].filter((r) => r.ok).length;
  console.log(`\n${label}: ${pass}/${cases.length}（${Math.round((pass / cases.length) * 100)}%）`);
}

const byCategory = (list) => [...new Set(cases.map((c) => c.category))].map((cat) => {
  const xs = list.filter((r) => r.category === cat);
  return `${cat} ${xs.filter((r) => r.ok).length}/${xs.length}`;
}).join('・');
const lines = [
  `# 秘書の続きの頼みの評価（${new Date().toISOString().slice(0, 10)}）`, '',
  // 会社の名前は結果に書かない（会社の鍵で回したことだけを残す）
  `推論: ${stub ? '見本' : llm.name}${tenantSub ? '（会社の鍵）' : ''}・問題 ${cases.length} 問・合格の目安 9 割（Q-365）`, '',
  ...modes.map(([label]) => `- ${label}: ${results[label].filter((r) => r.ok).length}/${cases.length}（${byCategory(results[label])}）`), '',
  '## 外れた問題（後）', '',
  ...(results['後'] ?? []).filter((r) => !r.ok).map((r) => `- ${r.id}: ${r.problems?.join('／') ?? r.got} — 答え: ${r.answer ?? ''}`),
];
if (!stub) {
  mkdirSync(join(dir, 'results'), { recursive: true });
  // 同じ日に何度か回したら、前の結果を残して番号を付ける
  const day = new Date().toISOString().slice(0, 10);
  let file = join(dir, 'results', `${day}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, 'results', `${day}-${n}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`結果: ${file}`);
} else {
  console.log(lines.join('\n'));
}
// データベースの接続を残さずに終わる
process.exit(0);
