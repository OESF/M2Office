/**
 * 通しの動作確認（仕様書 第24.3.2節）。
 *
 * 承認ゲートで中断し、承認後に別のワーカーが再開して完了するまでを確認する。
 * あわせてテナント分離が効いていることも確かめる。
 *
 * 使い方: API とワーカーを起動した状態で `node scripts/smoke.mjs`
 */
const API = process.env.API_URL ?? 'http://localhost:3101';

const ok = (label) => console.log(`  \x1b[32m✓\x1b[0m ${label}`);
const ng = (label, detail) => {
  console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  if (detail) console.log(`    ${detail}`);
  process.exitCode = 1;
};

/** テナントと利用者を指定して API を呼ぶ。 */
async function call(tenant, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tenant': tenant,
      'x-user': `admin@${tenant === 'a' ? 'alpha' : 'beta'}.example.jp`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 実行が指定した状態になるまで待つ。 */
async function waitFor(tenant, runId, statuses, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call(tenant, `/v1/runs/${runId}`);
    if (body?.run && statuses.includes(body.run.status)) return body;
    if (Date.now() > deadline) return body;
    await sleep(500);
  }
}

console.log('\n■ 1. 疎通と一覧');
{
  const health = await fetch(`${API}/health`).then((r) => r.json());
  health.ok ? ok('API が応答する') : ng('API が応答しない');

  const { body } = await call('a', '/v1/agents');
  body.agents?.length === 2
    ? ok(`エージェントが 2 件（${body.agents.map((a) => a.name).join(' / ')}）`)
    : ng('エージェントの一覧が取得できない', JSON.stringify(body));
}

console.log('\n■ 2. 承認なしの経路（AG-04 社内ナレッジ Q&A）');
let qaRunId;
{
  const { body } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇の付与日数は' } }),
  });
  qaRunId = body.runId;
  const run = await waitFor('a', qaRunId, ['completed', 'failed']);
  run.run.status === 'completed'
    ? ok(`完了した（ステップ ${run.steps.length} 件、${run.run.tokensUsed} トークン、${run.run.costJpy} 円）`)
    : ng(`完了しない（状態: ${run.run.status}）`, run.run.failureReason);

  const searched = run.steps.find((s) => s.stepId === 'search');
  const hits = searched?.output?.tools?.[0]?.result?.hits ?? [];
  hits.length > 0
    ? ok(`知識を検索できた（出典: ${hits[0].source}）`)
    : ng('知識が検索できていない');
}

console.log('\n■ 3. 承認ありの経路（AG-02 議事録作成・共有）');
let runId;
{
  const { body } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      agentId: 'minutes',
      origin: 'menu',
      input: {
        title: '定例会議',
        transcript: '来月の販促を議論。A 案で進めることを決定。担当は山田、期限は月末。',
        space: 'general',
      },
    }),
  });
  runId = body.runId;
  body.status === 'queued' ? ok('ジョブを受け付けた（待ち行列へ）') : ng('ジョブを受け付けない');

  const run = await waitFor('a', runId, ['awaiting_approval', 'failed', 'completed']);
  run.run.status === 'awaiting_approval'
    ? ok(`承認ゲートで中断した（cursor=${run.run.cursor}）`)
    : ng(`承認待ちにならない（状態: ${run.run.status}）`, run.run.failureReason);

  const artifact = run.artifacts?.[0];
  artifact ? ok(`成果物が保存された（${artifact.title}）`) : ng('成果物が無い');
}

console.log('\n■ 4. 承認による再開（最重要）');
{
  const { body: pending } = await call('a', '/v1/approvals');
  const first = pending.items?.[0];
  first ? ok(`承認待ちが ${pending.items.length} 件（${first.present}）`) : ng('承認待ちが無い');

  const before = await call('a', `/v1/runs/${runId}`);
  const cursorBefore = before.body.run.cursor;

  await call('a', `/v1/approvals/${first.id}`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved', comment: '内容を確認しました' }),
  });
  ok('承認した');

  const resumed = await waitFor('a', runId, ['awaiting_approval', 'completed', 'failed']);
  resumed.run.cursor > cursorBefore
    ? ok(`別のワーカーが続きから再開した（cursor ${cursorBefore} → ${resumed.run.cursor}）`)
    : ng('再開していない');

  // 2 つ目の承認ゲート（共有範囲の確認）
  const { body: pending2 } = await call('a', '/v1/approvals');
  if (pending2.items?.length) {
    await call('a', `/v1/approvals/${pending2.items[0].id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', comment: null }),
    });
    ok('2 つ目の承認ゲートも通過した');
  }

  const final = await waitFor('a', runId, ['completed', 'failed'], 20000);
  final.run.status === 'completed'
    ? ok(`最後まで完了した（${final.steps.length} ステップ、${final.run.costJpy} 円）`)
    : ng(`完了しない（状態: ${final.run.status}）`, final.run.failureReason);
}

console.log('\n■ 5. テナント分離');
{
  // B 社から A 社の実行を取得しようとする
  const { status } = await call('b', `/v1/runs/${runId}`);
  status === 404 ? ok('他テナントの実行は見えない（404）') : ng(`他テナントの実行が見えてしまう（${status}）`);

  // B 社の承認トレイに A 社の承認が出ていないこと
  const { body } = await call('b', '/v1/approvals');
  (body.items ?? []).length === 0 ? ok('他テナントの承認待ちが混ざらない') : ng('他テナントの承認が見える');

  // 知識もテナントごとに分かれていること
  const { body: bJob } = await call('b', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇の付与日数は' } }),
  });
  const bRun = await waitFor('b', bJob.runId, ['completed', 'failed']);
  const bHits = bRun.steps.find((s) => s.stepId === 'search')?.output?.tools?.[0]?.result?.hits ?? [];
  const bodies = bHits.map((h) => h.body).join(' ');
  bodies.includes('12 日') && !bodies.includes('10 日')
    ? ok('B 社の検索結果に A 社の知識が混ざらない')
    : ng('知識が分離されていない', bodies.slice(0, 80));

  // 権限区画のデータが区画外の検索に出ないこと
  const { body: aJob } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '給与' } }),
  });
  const aRun = await waitFor('a', aJob.runId, ['completed', 'failed']);
  const aHits = aRun.steps.find((s) => s.stepId === 'search')?.output?.tools?.[0]?.result?.hits ?? [];
  aHits.every((h) => !h.title.includes('区画内'))
    ? ok('権限区画の文書は区画外の検索に出ない')
    : ng('区画の文書が漏れている');
}

console.log('\n■ 6. 監査ログ');
{
  const { body } = await call('a', '/v1/audit-events');
  const actions = new Set((body.items ?? []).map((e) => e.action));
  const required = ['job.create', 'tool.invoke', 'run.await_approval', 'approval.decide', 'run.complete'];
  const missing = required.filter((a) => !actions.has(a));
  missing.length === 0
    ? ok(`主要な操作が記録されている（${actions.size} 種類）`)
    : ng(`記録が足りない: ${missing.join(', ')}`);
}

console.log('\n■ 7. 秘書の応答（3 層）');
{
  const { body: direct } = await call('a', '/v1/secretary', {
    method: 'POST',
    body: JSON.stringify({ message: '承認待ちある？' }),
  });
  direct.layer === 'direct' && direct.tokensUsed === 0
    ? ok(`層 1 で応答（${direct.elapsedMs}ms、LLM 不使用）: ${direct.text}`)
    : ng(`層 1 にならない（layer=${direct.layer}）`);

  const { body: routed } = await call('a', '/v1/secretary', {
    method: 'POST',
    body: JSON.stringify({ message: '会議の議事録をまとめて' }),
  });
  routed.suggestedAgent
    ? ok(`業務エージェントへ取り次いだ（${routed.suggestedAgent.name}）`)
    : ng('取次ができない', JSON.stringify(routed).slice(0, 120));
}

console.log('');
console.log(process.exitCode ? '\x1b[31m一部の確認に失敗しました\x1b[0m' : '\x1b[32mすべての確認を通過しました\x1b[0m');
console.log('');
