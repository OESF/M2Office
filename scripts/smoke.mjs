/**
 * @file 通しの動作確認。API とワーカーを起動した状態で、主要な経路と境界を端から端まで確かめる。
 *
 * とくに、承認ゲートで中断し、承認後に別のワーカーが再開して完了する経路を確かめる。
 * あわせてテナント分離・権限・ログイン・データベースの分離・設定・ファイルも確かめる。
 *
 * 使い方: `npm run dev` を起動した状態で `npm run smoke`
 * 外部の MCP サーバ（DeepWiki）への実際の問い合わせも確かめるときは `SMOKE_EXTERNAL=1 npm run smoke`
 *
 * @see 仕様書 第24.3.2節 通すべき一本の流れ
 */

const API = process.env.API_URL ?? 'http://localhost:3101';

const ok = (label) => console.log(`  \x1b[32m✓\x1b[0m ${label}`);
const ng = (label, detail) => {
  console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  if (detail) console.log(`    ${detail}`);
  process.exitCode = 1;
};

/**
 * テナントと利用者を指定して API を呼ぶ。
 *
 * 開発用の `X-User` ヘッダーを使う（`AUTH_DEV_HEADERS=true` が前提）。
 * Cookie によるログインは「■ 9. ログイン」で別に確かめる。
 */
async function call(tenant, path, init = {}, who = 'admin') {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-tenant': tenant,
      'x-user': `${who}@${tenant === 'a' ? 'alpha' : 'beta'}.example.jp`,
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
async function waitFor(tenant, runId, statuses, timeoutMs = 20000, who = 'admin') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call(tenant, `/v1/runs/${runId}`, {}, who);
    if (body?.run && statuses.includes(body.run.status)) return body;
    if (Date.now() > deadline) return body;
    await sleep(500);
  }
}

/**
 * SKILL.md の拡張機能を ZIP にする（仕様書 第12.12節。JSON の定義は第 0.131.0 版で廃止した）。
 *
 * @param o.inputs 入力の欄（`m2office-inputs` の行。例: `memo: 短文`）
 * @param o.stub 自動テスト用の見本の応答（段の ID ごと。スキルの段は work・approve・send）
 */
async function skillZip(o) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('SKILL.md', [
    '---', `name: ${o.name}`, `description: ${o.description ?? '確認用'}`, `allowed-tools: ${o.tools.join(' ')}`,
    'metadata:', `  author: ${o.author ?? '確認用'}`, '  version: "1.0.0"', `  m2office-id: ${o.id}`,
    '  m2office-inputs: |', ...o.inputs.map((l) => `    ${l}`), '---', '', `# ${o.title}`, '', o.body ?? '確認用の業務。', '',
  ].join('\n'));
  zip.file(`evals/${o.name}.json`, JSON.stringify({ agent: o.name, cases: [{ name: '確認', input: o.input, expect: '確認', stub: o.stub }] }));
  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * その実行が止まっている承認を探す。
 *
 * 承認トレイには他の実行の承認も並ぶため、「先頭の承認」を選ぶと別の実行を承認してしまう。
 * 実行の詳細で承認待ちのステップを見つけ、それに対応する承認を返す。
 */
async function approvalFor(tenant, runId, who = 'admin') {
  const { body: run } = await call(tenant, `/v1/runs/${runId}`, {}, who);
  const waiting = run.steps?.find((s) => s.status === 'awaiting');
  if (!waiting) return null;
  const { body: tray } = await call(tenant, '/v1/approvals', {}, who);
  return tray.items?.find((a) => a.runStepId === waiting.id) ?? null;
}

console.log('\n■ 1. 疎通と一覧');
{
  const health = await fetch(`${API}/health`).then((r) => r.json());
  health.ok ? ok('API が応答する') : ng('API が応答しない');

  const { body } = await call('a', '/v1/agents');
  // 拡張機能を導入している場合はその分が増えるため、公式の業務エージェントだけを数える
  const official = (body.agents ?? []).filter((a) => !a.extension);
  // 段取りの報告（第10.14節）はメニューに出ない中の業務
  official.length === 14 && official.filter((a) => a.menu === false).map((a) => a.id).join() === 'secretary-plan-report'
    ? ok(`公式の業務エージェントが 14 件（うち中の業務 1。${official.map((a) => a.name).join(' / ')}）`)
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

  // 答えるだけの業務でも、結果が読める（第6.2.2節）。成果物は作らない
  const last = [...run.steps].reverse().find((s) => (s.output?.text ?? '').replace(/```tool[\s\S]*?```/g, '').trim());
  last ? ok('成果物を作らない業務でも、最後の段に答えが残る') : ng('答えがどこにも無い', JSON.stringify(run.steps.map((s) => s.stepId)));
  (run.artifacts ?? []).length === 0
    ? ok('この業務は成果物を作らない（結果は段から読む）') : ng('成果物ができている');

  // 動いている間に「いま何をしているか」を出せる（第6.2.2.2節）。段の表示名が要る
  run.steps.every((s) => typeof s.label === 'string' && s.label.length > 0)
    ? ok('段に表示名が付いて返る（画面が「いま何をしているか」を出せる）')
    : ng('表示名が無い段がある', JSON.stringify(run.steps.map((s) => [s.stepId, s.label])));

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
  const first = await approvalFor('a', runId);
  first ? ok(`この実行の承認待ちを見つけた（${first.present}）`) : ng('承認待ちが無い');

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
  const second = await approvalFor('a', runId);
  if (second) {
    await call('a', `/v1/approvals/${second.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', comment: null }),
    });
    ok('2 つ目の承認ゲートも通過した');
  }

  const final = await waitFor('a', runId, ['completed', 'failed'], 20000);
  final.run.status === 'completed'
    ? ok(`最後まで完了した（${final.steps.length} ステップ、${final.run.costJpy} 円）`)
    : ng(`完了しない（状態: ${final.run.status}）`, final.run.failureReason);

  // 判断したもの（承認の履歴。仕様書 第6.2.5節）: 何を・どのように承認したかを見返せる
  const { body: decided } = await call('a', '/v1/approvals/decided');
  const mine = (decided.items ?? []).filter((x) => x.runId === runId);
  const firstDecided = mine.find((x) => x.id === first.id);
  firstDecided?.decision === 'approved' && firstDecided.comment === '内容を確認しました' && firstDecided.present === first.present
    && firstDecided.agentName && firstDecided.decidedAt
    ? ok('判断したものに、承認したときの画面・承認か却下か・日時・コメントが残る') : ng('判断したものが違う', JSON.stringify(firstDecided ?? decided).slice(0, 300));
  const secondDecided = second ? mine.find((x) => x.id === second.id) : null;
  !second || (secondDecided && Array.isArray(secondDecided.done) && secondDecided.done.length > 0 && secondDecided.done.every((d) => typeof d.text === 'string' && !/[a-z]+\.[a-z_]+:/.test(d.text)))
    ? ok(`承認のあとに実際に行ったことを業務の言葉で見返せる（${secondDecided?.done?.length ?? 0} 件）`) : ng('行ったことが出ない', JSON.stringify(secondDecided ?? null).slice(0, 300));
  const { body: other } = await call('a', '/v1/approvals/decided', {}, 'member');
  !(other.items ?? []).some((x) => x.runId === runId) ? ok('ほかの人の判断は見えない') : ng('ほかの人の判断が見える');
  const { body: detailed } = await call('a', `/v1/runs/${runId}`);
  (detailed.decisions ?? []).some((d) => d.decision === 'approved' && d.decidedBy && d.decidedAt)
    ? ok('実行の詳細に、誰がいつ判断したかが出る') : ng('実行の詳細に判断した人が出ない', JSON.stringify(detailed.decisions ?? null));

  // 手順 7: 承認②のあと、承認①で見た議事録をそのまま組織知識に登録する（仕様書 第9.5.2節）
  const { body: kb } = await call('a', '/v1/admin/knowledge');
  const registered = (kb.items ?? []).find((k) => k.originRunId === runId);
  registered && registered.body === final.artifacts?.[0]?.body && registered.googleDerived === false
    ? ok(`議事録が組織知識に登録された（${registered.title}、${registered.sectionCount} 節）`)
    : ng('議事録が組織知識に登録されていない', JSON.stringify(registered ?? null).slice(0, 120));

  const { body: qa } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '販促' } }),
  });
  const qaRun = await waitFor('a', qa.runId, ['completed', 'failed']);
  const qaHits = qaRun.steps.find((s) => s.stepId === 'search')?.output?.tools?.[0]?.result?.hits ?? [];
  qaHits.some((h) => h.title === registered?.title)
    ? ok('登録した議事録を社内ナレッジ Q&A が引ける')
    : ng('登録した議事録が検索に出ない', qaHits.map((h) => h.title).join('、'));

  // 後片付け: 以降の確認（B 社との分離など）に影響させないよう、登録した議事録を消す
  if (registered) await call('a', `/v1/admin/knowledge/${registered.id}`, { method: 'DELETE' });
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
  const { body } = await call('a', '/v1/admin/audit-events');
  const actions = new Set((body.items ?? []).map((e) => e.action));
  const required = ['job.create', 'tool.invoke', 'run.await_approval', 'approval.decide', 'run.complete'];
  const missing = required.filter((a) => !actions.has(a));
  missing.length === 0
    ? ok(`主要な操作が記録されている（${actions.size} 種類）`)
    : ng(`記録が足りない: ${missing.join(', ')}`);

  // 誰が・何をしたか・何に対してを、人の名前と業務の言葉で出す（第6.6.8.1節）
  const decided = (body.items ?? []).find((e) => e.action === 'approval.decide');
  decided && /^(承認した|却下した)$/.test(decided.what) && !/^user:|^u-/.test(decided.who) && /業務「.+」の承認/.test(decided.target)
    ? ok(`承認を人の名前と業務の言葉で出す（${decided.who}・${decided.what}・${decided.target}）`) : ng('言葉で出ていない', JSON.stringify(decided ?? null).slice(0, 300));
  const tool = (body.items ?? []).find((e) => e.action === 'tool.invoke');
  tool && /^業務「.+」（.+さんの依頼）$/.test(tool.who) ? ok(`業務が行ったものは指示した人を添える（${tool.who}）`) : ng('指示した人が出ない', JSON.stringify(tool ?? null).slice(0, 200));

  // 絞り込み: 人・操作の種類
  const me = (body.people ?? []).find((p) => p.name) ?? null;
  const { body: byCat } = await call('a', '/v1/admin/audit-events?category=approval');
  (byCat.items ?? []).length > 0 && (byCat.items ?? []).every((e) => e.action.startsWith('approval.'))
    ? ok('操作の種類で絞れる') : ng('種類で絞れない');
  const { body: member } = await call('a', '/v1/admin/audit-events', {}, 'member');
  member.items === undefined ? ok('一般の利用者は監査ログを見られない') : ng('一般の利用者が見られる');
  const users = (body.people ?? []).map((p) => p.id);
  const { body: byUser } = users[0] ? await call('a', `/v1/admin/audit-events?user=${encodeURIComponent(users[0])}`) : { body: {} };
  Array.isArray(byUser.items) ? ok('人で絞れる') : ng('人で絞れない');

  // CSV の出力と、出力したことの記録
  const res = await fetch(`${API}/v1/admin/audit-events/export?category=approval`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
  // fetch の text() は先頭の BOM を外すため、バイトで確かめる
  const bytes = new Uint8Array(await res.arrayBuffer());
  const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  res.ok && (res.headers.get('content-type') ?? '').includes('text/csv') && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    && csv.startsWith('\uFEFF日時,誰が,何をしたか,何に対して')
    ? ok('絞った結果を CSV で出力できる（Excel で開ける形）') : ng('CSV で出力できない', `${res.status} ${csv.slice(0, 80)}`);
  const { body: after } = await call('a', '/v1/admin/audit-events?category=settings');
  const { body: all } = await call('a', '/v1/admin/audit-events');
  (all.items ?? []).some((e) => e.action === 'audit.export' && e.what === '監査ログを出力した')
    ? ok('出力したことも監査ログに残す') : ng('出力が記録されない');
  void me; void after;
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

console.log('\n■ 8. ダミー接続による照会（Google 未接続）');
{
  for (const [message, expect] of [
    ['今日の予定は？', /予定/], ['未読のメールある？', /メール/], ['今日のタスクは？', /タスク/],
  ]) {
    const { body } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message }) });
    const marked = body.evidence?.[0]?.value?.includes('ダミー');
    body.layer === 'direct' && expect.test(body.text) && marked
      ? ok(`「${message}」→ 層 1（${body.elapsedMs}ms）: ${body.text}（ダミーと明示）`)
      : ng(`「${message}」に層 1 で答えない、またはダミーの明示が無い`, JSON.stringify(body).slice(0, 160));
  }
  const { body: routed } = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: 'メールの返信を下書きして' }),
  });
  // 専門の業務は、本人に実行の可否を聞かずに頼んで実行し、結果をあとで伝える（第10.9.6節、ADR-0033）
  routed.lookup?.runId && /「受信箱整理・返信起案」に頼みました/.test(routed.text) && !routed.suggestedAgent
    ? ok('作業の依頼は照会と取り違えず、受信箱整理に頼んで実行した（実行してよいかを聞かない）')
    : ng('依頼を照会として処理してしまう、または実行してよいかを聞く', JSON.stringify(routed).slice(0, 160));
  const delegated = routed.lookup?.runId ? await waitFor('a', routed.lookup.runId, ['completed', 'failed', 'awaiting_approval'], 20000) : null;
  const { body: bar } = await call('a', '/v1/secretary/lookups');
  const item = (bar.items ?? []).find((x) => x.runId === routed.lookup?.runId);
  item?.agentName === '受信箱整理・返信起案' && delegated?.run?.status === 'completed' && item.done
    ? ok('頼んだ業務は秘書バーの一覧に名前つきで並び、終わると伝える対象になる')
    : ng('頼んだ業務が秘書バーに並ばない', JSON.stringify(item));
}

console.log('\n■ 9. AG-01 受信箱整理（承認なし・送信しない）');
{
  const { body } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'inbox-triage' }) });
  const run = await waitFor('a', body.runId, ['completed', 'failed', 'awaiting_approval']);
  run.run.status === 'completed' ? ok('承認を挟まずに完了した') : ng(`完了しない（${run.run.status}）`, run.run.failureReason);
  const draft = run.steps.flatMap((s) => s.output?.tools ?? []).find((t) => t.name === 'gmail.create_draft');
  draft?.result?.sent === false && draft?.result?.draftId
    ? ok(`下書きを作った（${draft.result.draftId}、送信はしていない）`)
    : ng('下書きが作られていない');
  run.artifacts?.length ? ok(`分類の一覧を成果物に残した（${run.artifacts[0].title}）`) : ng('分類の一覧が無い');
}

console.log('\n■ 10. AG-03 日程調整（招待の前に本人が承認）');
{
  // 一般利用者が依頼する。承認は依頼した本人が行う（仕様書 第9.2.3節）
  const { body } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'scheduling', input: { title: '企画会議', attendees: 'admin@alpha.example.jp' } }),
  }, 'member');
  const run = await waitFor('a', body.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  // 承認の前に組み立てた段には「承認のあとに実行します」の印だけが残る（第9.3.3節）。実行した結果があるかで見る
  const invitedEarly = run.steps.flatMap((s) => s.output?.tools ?? []).some((t) => t.name === 'calendar.create' && t.result);
  run.run.status === 'awaiting_approval' && !invitedEarly
    ? ok('空きを取得し、招待の前で止まった')
    : ng(`承認待ちにならない（${run.run.status}）`);

  const approval = await approvalFor('a', body.runId, 'member');
  approval?.approverUserId === 'u-a-member'
    ? ok('依頼した本人の承認トレイに出た') : ng('本人の承認トレイに出ない');

  // 承認の画面に、判断するものと、承認すると行うことが出る（第9.3.3節）。見出しの 1 行だけではない
  const shown = approval?.present ?? '';
  shown.split('\n')[0] === '予定の候補と招待の文面' && /## 判断するもの/.test(shown)
    && /## 承認すると[\s\S]*予定を登録し、招待を送ります/.test(shown) && !/calendar\.create|\{"/.test(shown)
    ? ok('承認の画面に、判断するものと、承認すると行うこと（予定の作成）を業務の言葉で出す')
    : ng('承認の画面に中身が出ない', shown.slice(0, 200));

  // 開く前に、何を判断するのかが分かる（第6.2.4節）
  approval?.agentName
    ? ok(`承認トレイに業務の名前が出る（${approval.agentName}）`)
    : ng('業務の名前が無い', JSON.stringify(approval ?? null).slice(0, 120));

  const { body: adminTray } = await call('a', '/v1/approvals');
  adminTray.items.every((a) => a.id !== approval.id)
    ? ok('管理者の承認トレイには出ない') : ng('他人の承認トレイに出ている');

  const denied = await call('a', `/v1/approvals/${approval.id}`, {
    method: 'POST', body: JSON.stringify({ decision: 'approved' }),
  });
  denied.status === 403 ? ok('管理者でも本人以外は承認できない（403）') : ng(`拒否されない（${denied.status}）`);

  await call('a', `/v1/approvals/${approval.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, 'member');
  const done = await waitFor('a', body.runId, ['completed', 'failed'], 20000, 'member');
  const attempts = done.steps.flatMap((s) => s.output?.tools ?? []).filter((t) => t.name === 'calendar.create');
  const created = attempts.find((t) => t.result);
  done.run.status === 'completed' && created?.result?.eventId
    ? ok(`承認後に予定を作成した（${created.result.eventId}）`)
    : ng(`予定が作られない（${done.run.status}）`, done.run.failureReason);
}

console.log('\n■ 11. AG-05 週次ブリーフ（定時実行 → 本人へ通知）');
{
  const { body: list } = await call('a', '/v1/schedules', {}, 'member');
  const brief = list.items?.find((s) => s.agentId === 'weekly-brief');
  brief ? ok(`定時実行が登録されている（${brief.label}）`) : ng('週次ブリーフの定時実行が無い');

  // 一覧には件数の上限があるため、件数ではなく「呼び出したあとに作られた通知」で判定する
  const since = new Date().toISOString();
  await call('a', `/v1/schedules/${brief.id}/trigger`, { method: 'POST' }, 'member');
  ok('次の回を今にした（ワーカーの見回りを待つ）');

  const deadline = Date.now() + 40000;
  let latest;
  while (Date.now() < deadline) {
    const { body: after } = await call('a', '/v1/notifications', {}, 'member');
    latest = after.items.find((n) => n.kind === 'brief' && n.createdAt >= since);
    if (latest) break;
    await sleep(1000);
  }
  latest
    ? ok(`本人に届いた「${latest.title}」`)
    : ng('通知が届かない');
  /予定: \d+ 件/.test(latest?.body ?? '') ? ok('予定・タスク・受信箱・承認待ちを集めて要約した') : ng('要約に件数が無い', latest?.body);

  const { body: adminInbox } = await call('a', '/v1/notifications');
  adminInbox.items.every((n) => n.id !== latest?.id) ? ok('他の利用者の受信箱には入らない') : ng('他人に届いている');
  // 週次ブリーフは秘書の答えとしても届ける（第9.5.5節）。伝えたことにしておく（残すと、あとの音声の確認（第 42 節）で伝える結果として会話ログに入る）
  await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, 'member');

  const { body: again } = await call('a', '/v1/schedules', {}, 'member');
  const next = again.items.find((s) => s.id === brief.id);
  Date.parse(next.nextRunAt) > Date.now() ? ok(`次回は ${new Date(next.nextRunAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`) : ng('次回の時刻が進んでいない');
}

console.log('\n■ 12. 権限');
{
  const admin = await call('a', '/v1/admin/usage', {}, 'member');
  admin.status === 403 ? ok('一般利用者は管理者 API を使えない（403）') : ng(`使えてしまう（${admin.status}）`);

  const { body: mine } = await call('a', '/v1/jobs', {}, 'member');
  mine.items.every((i) => i.job?.requestedBy === 'u-a-member')
    ? ok(`実行履歴は本人の分だけ（${mine.items.length} 件）`)
    : ng('他人の実行が履歴に見える');

  const other = await call('a', `/v1/runs/${runId}`, {}, 'member');
  other.status === 404 ? ok('他人の実行の中身は見えない（404）') : ng(`見えてしまう（${other.status}）`);

  const { body: usage } = await call('a', '/v1/admin/usage');
  usage.total?.runs > 0 ? ok(`管理者は利用量を見られる（${usage.total.runs} 件、${usage.total.costJpy} 円）`) : ng('利用量が取れない');
}

console.log('\n■ 13. ログイン（Cookie と CSRF）');
{
  /** Cookie だけで API を呼ぶ。開発用ヘッダーは付けない。 */
  // fetch では Host ヘッダーを差し替えられないため、サブドメインの URL を直接呼ぶ
  const port = new URL(API).port || '3101';
  const raw = (host, path, init = {}) =>
    fetch(`http://${host}:${port}${path}`, {
      ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

  const anon = await raw('a.lvh.me', '/v1/me');
  anon.status === 401 ? ok('ログインしていなければ 401（管理者として扱わない）') : ng(`401 にならない（${anon.status}）`);

  const login = await raw('a.lvh.me', '/v1/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ email: 'member@alpha.example.jp' }),
  });
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  /httponly/i.test(setCookie) && /samesite=lax/i.test(setCookie) && !/domain=/i.test(setCookie)
    ? ok('HttpOnly・SameSite=Lax・Domain 無しの Cookie を発行した')
    : ng('Cookie の属性が不適切', setCookie);
  const { csrfToken } = await login.json();

  const me = await raw('a.lvh.me', '/v1/me', { headers: { cookie } }).then((r) => r.json());
  me.user?.email === 'member@alpha.example.jp' ? ok('Cookie で本人として扱われる') : ng('Cookie が効かない');

  const noCsrf = await raw('a.lvh.me', '/v1/secretary', {
    method: 'POST', headers: { cookie }, body: JSON.stringify({ message: '承認待ちある？' }),
  });
  noCsrf.status === 403 ? ok('CSRF トークンの無い書き込みは拒否（403）') : ng(`拒否されない（${noCsrf.status}）`);

  const withCsrf = await raw('a.lvh.me', '/v1/secretary', {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken }, body: JSON.stringify({ message: '承認待ちある？' }),
  });
  withCsrf.status === 200 ? ok('CSRF トークンがあれば通る') : ng(`通らない（${withCsrf.status}）`);

  const cross = await raw('b.lvh.me', '/v1/me', { headers: { cookie } });
  cross.status === 401 ? ok('A 社の Cookie を B 社に持ち込んでも通らない（401）') : ng(`通ってしまう（${cross.status}）`);

  const wrongDomain = await raw('a.lvh.me', '/v1/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ email: 'admin@beta.example.jp' }),
  });
  wrongDomain.status === 403 ? ok('他社のドメインではログインできない（403）') : ng(`ログインできてしまう（${wrongDomain.status}）`);

  await raw('a.lvh.me', '/v1/auth/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken } });
  const after = await raw('a.lvh.me', '/v1/me', { headers: { cookie } });
  after.status === 401 ? ok('ログアウト後は同じ Cookie が使えない') : ng(`使えてしまう（${after.status}）`);
}

console.log('\n■ 14. データベース側のテナント分離（RLS）');
{
  // アプリと同じロールで直接つなぎ、SQL の条件を書き漏らした場合を再現する
  const { default: pg } = await import('pg');
  const url = process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office';
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const count = async (tenant) => {
    await db.query('begin');
    if (tenant) await db.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    const { rows } = await db.query('select count(*)::int as n, count(distinct tenant_id)::int as t from runs');
    await db.query('commit');
    return rows[0];
  };
  const none = await count(null);
  none.n === 0 ? ok('テナント未設定では、条件なしの SELECT でも 1 行も見えない') : ng(`見えてしまう（${none.n} 行）`);
  const a = await count('t-alpha');
  a.n > 0 && a.t === 1 ? ok(`A 社を設定すると A 社の行だけが見える（${a.n} 行）`) : ng('A 社以外の行が混ざる', JSON.stringify(a));

  await db.query('begin');
  await db.query(`select set_config('app.tenant_id', 't-alpha', true)`);
  const cross = await db.query(
    `insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id)
     values ('rls-test', 't-beta', 'system', 'smoke', 'test', 'test', 'test')`,
  ).then(() => 'inserted', (e) => e.message);
  await db.query('rollback');
  cross !== 'inserted' ? ok('他社の tenant_id での書き込みは拒否される') : ng('他社の行を書き込めてしまう');

  await db.query('begin');
  await db.query(`select set_config('app.tenant_id', 't-alpha', true)`);
  const tamper = await db.query(`update audit_events set action = 'x'`).then(() => 'updated', (e) => e.message);
  await db.query('rollback');
  /permission denied/.test(tamper) ? ok('監査ログは更新できない（追記のみ）') : ng('監査ログを書き換えられる', tamper);

  const role = await db.query(`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
  !role.rows[0].rolbypassrls && !role.rows[0].rolsuper
    ? ok('アプリのロールは RLS を迂回できない') : ng('アプリのロールが RLS を迂回できる');
  await db.end();
}

console.log('\n■ 15. 管理者ページの設定');
{
  const put = (section, value, who = 'admin') =>
    call('a', `/v1/admin/settings/${section}`, { method: 'PUT', body: JSON.stringify(value) }, who);

  // 業務の無効化
  await put('agents', { disabled: ['scheduling'] });
  const { body: menu } = await call('a', '/v1/agents', {}, 'member');
  const blocked = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'scheduling' }) }, 'member');
  !menu.agents.some((a) => a.id === 'scheduling') && blocked.status === 403
    ? ok('無効にした業務はメニューに出ず、起動もできない（403）')
    : ng('無効化が効かない', `${menu.agents.length} / ${blocked.status}`);
  await put('agents', { disabled: [] });

  // 入力の検証
  const badInvoice = await put('company', {
    legalName: '株式会社アルファ商事', fiscalYearStartMonth: 4, invoiceRegistrationNumber: 'T123',
    taxRounding: 'floor', closingDay: 'end',
  });
  badInvoice.status === 400 ? ok('登録番号の形式の誤りを拒否する（T＋13 桁）') : ng(`拒否されない（${badInvoice.status}）`);
  const goodInvoice = await put('company', {
    legalName: '株式会社アルファ商事', fiscalYearStartMonth: 4, invoiceRegistrationNumber: 'T1234567890123',
    taxRounding: 'floor', closingDay: 'end', address: '東京都', phone: '03-0000-0000', paymentTerms: '翌月末払い',
  });
  goodInvoice.status === 200 ? ok('会社情報を保存できる') : ng(`保存できない（${goodInvoice.status}）`);

  const extSend = await put('automation', { writeInternal: 'allow', perAgent: {}, externalSend: 'allow' });
  const { body: saved } = await call('a', '/v1/admin/settings');
  !('externalSend' in saved.automation)
    ? ok('対外送信の承認を省略する設定は保存されない') : ng('externalSend が保存されてしまう');
  await put('automation', { writeInternal: 'require', perAgent: { 'weekly-brief': 'allow' } });
  void extSend;

  const notAdmin = await put('agents', { disabled: [] }, 'member');
  notAdmin.status === 403 ? ok('一般利用者は設定を変えられない（403）') : ng(`変えられてしまう（${notAdmin.status}）`);

  // 最後の管理者を守る
  const { body: users } = await call('a', '/v1/admin/users');
  const admin = users.items.find((u) => u.email === 'admin@alpha.example.jp');
  const demote = await call('a', `/v1/admin/users/${admin.id}`, { method: 'PATCH', body: JSON.stringify({ roles: ['member'] }) });
  demote.status === 409 ? ok('管理者が 1 人もいなくなる変更は拒否する（409）') : ng(`拒否されない（${demote.status}）`);

  const invite = await call('a', '/v1/admin/users', {
    method: 'POST', body: JSON.stringify({ email: 'someone@beta.example.jp', roles: ['member'] }),
  });
  invite.status === 400 ? ok('他社のドメインのアドレスは招待できない') : ng(`招待できてしまう（${invite.status}）`);

  // 規程の登録 → AG-04 で答えられる
  const { body: saved2 } = await call('a', '/v1/admin/knowledge/new', {
    method: 'PUT',
    body: JSON.stringify({ title: '慶弔休暇規程', body: '慶弔休暇は、本人の結婚の場合 5 日を付与する。', source: '慶弔休暇規程 第3条' }),
  });
  const { body: job } = await call('a', '/v1/jobs', {
    method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '慶弔休暇' } }),
  });
  const qa = await waitFor('a', job.runId, ['completed', 'failed']);
  const hits = qa.steps.find((x) => x.stepId === 'search')?.output?.tools?.[0]?.result?.hits ?? [];
  hits.some((h) => h.source === '慶弔休暇規程 第3条')
    ? ok('管理者ページで登録した規程を AG-04 が出典つきで見つける') : ng('登録した規程が検索されない');
  await call('a', `/v1/admin/knowledge/${saved2.id}`, { method: 'DELETE' });
}

console.log('\n■ 16. 個人設定');
{
  const put = (section, value, who = 'member') =>
    call('a', `/v1/me/settings/${section}`, { method: 'PUT', body: JSON.stringify(value) }, who);
  const bad = await put('profile', { timezone: 'Mars/Olympus' });
  bad.status === 400 ? ok('存在しないタイムゾーンは拒否する') : ng(`拒否されない（${bad.status}）`);

  await put('menu', { hidden: ['minutes'], order: ['weekly-brief'] });
  const { body: mine } = await call('a', '/v1/me/settings', {}, 'member');
  const { body: others } = await call('a', '/v1/me/settings', {}, 'admin');
  mine.menu.hidden.includes('minutes') && !others.menu.hidden.includes('minutes')
    ? ok('メニューの設定は本人だけに効く') : ng('設定が本人以外にも効いている');
  await put('menu', { hidden: [], order: [] });

  // 週次ブリーフを受け取らない設定にすると届かない
  await put('notifications', { kinds: { brief: false, run: true, approval: true, failure: true }, quietHours: null });
  const { body: sched } = await call('a', '/v1/schedules', {}, 'member');
  const brief = sched.items.find((x) => x.agentId === 'weekly-brief');
  const { body: before } = await call('a', '/v1/notifications', {}, 'member');
  // 呼び出した後に始まった実行だけを待つ（直前の第 11 節の実行を、終わったものと取り違えないため）
  const triggeredAt = Date.now() - 1000;
  await call('a', `/v1/schedules/${brief.id}/trigger`, { method: 'POST' }, 'member');
  const deadline = Date.now() + 40000;
  let done = false;
  while (Date.now() < deadline && !done) {
    const { body: j } = await call('a', '/v1/jobs', {}, 'member');
    const latest = j.items.find((i) => i.job.agentId === 'weekly-brief');
    done = latest && Date.parse(latest.run.startedAt) >= triggeredAt && latest.run.status === 'completed';
    if (!done) await sleep(1000);
  }
  const { body: after } = await call('a', '/v1/notifications', {}, 'member');
  done && after.items.length === before.items.length
    ? ok('受け取らないと決めた種類の通知は届かない') : ng('設定に反して届いた、または実行が終わらない');
  await put('notifications', { kinds: { brief: true, run: true, approval: true, failure: true }, quietHours: null });
  // 動かした週次ブリーフを伝えたことにしておく（第 11 節と同じ理由）
  await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, 'member');

  const { body: usage } = await call('a', '/v1/me/usage', {}, 'member');
  typeof usage.thisMonth?.runs === 'number' ? ok(`今月の実行件数を返す（${usage.thisMonth.runs} 件）`) : ng('利用状況が取れない');
}

console.log('\n■ 17. ファイルの受け取りと取り出し');
{
  const { readFileSync } = await import('node:fs');
  const upload = async (name, bytes, who = 'member') => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    const res = await fetch(`${API}/v1/files`, {
      method: 'POST', body: form,
      headers: { 'x-tenant': 'a', 'x-user': `${who}@alpha.example.jp` },
    });
    return { status: res.status, body: await res.json() };
  };
  const pdf = readFileSync(new URL('../packages/core/test/fixtures/invoice-ja.pdf', import.meta.url));
  const up = await upload('請求書.pdf', pdf);
  up.status === 201 && up.body.kind === 'pdf' && up.body.sha256?.length === 64
    ? ok(`PDF を受け取った（${up.body.size} バイト、SHA-256 を記録）`) : ng(`受け取れない（${up.status}）`, JSON.stringify(up.body));

  const fake = await upload('偽物.pdf', new TextEncoder().encode('これは PDF ではない'));
  fake.status === 415 ? ok('拡張子と中身が一致しないファイルは拒否する（415）') : ng(`拒否されない（${fake.status}）`);

  const own = await fetch(`${API}/v1/files/${up.body.id}/content`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
  const same = Buffer.from(await own.arrayBuffer()).equals(pdf);
  own.status === 200 && same && /attachment/.test(own.headers.get('content-disposition') ?? '')
    ? ok('本人は同じ中身を取り出せる（画面に埋め込まず保存させる）') : ng('取り出せない、または中身が違う');

  const b = await fetch(`${API}/v1/files/${up.body.id}`, { headers: { 'x-tenant': 'b', 'x-user': 'admin@beta.example.jp' } });
  b.status === 404 ? ok('他社からは見えない（404）') : ng(`他社から見えてしまう（${b.status}）`);
}

console.log('\n■ 18. ダッシュボード');
{
  const { status, body } = await call('a', '/v1/admin/dashboard/live');
  status === 200 && typeof body.counts?.activeUsers === 'number'
    ? ok(`いまの数値を返す（ログイン中 ${body.counts.activeUsers} 人、承認待ち ${body.counts.awaitingApproval} 件）`)
    : ng(`取れない（${status}）`);
  const text = JSON.stringify(body);
  !/"input":\{[^}]/.test(text) && !text.includes('来月の販促') && !text.includes('transcript')
    ? ok('業務の入力や記録の中身を含まない') : ng('中身が含まれている');
  body.flows?.every((f) => Array.isArray(f.steps) && f.steps.every((x) => x.label))
    ? ok(`業務の流れを段階の表示名つきで返す（${body.flows.length} 件）`) : ng('流れの形が不正');

  // 業務の流れに、終わったもの（失敗）を混ぜない（第6.7.5.1節）
  (body.flows ?? []).every((f) => f.status !== 'failed')
    ? ok('業務の流れは、いま動いているものだけ') : ng('失敗が流れに混ざっている');
  Array.isArray(body.failures) && (body.failures ?? []).every((f) => f.reason && f.at && f.agentName)
    ? ok(`今日の失敗を別に返す（${body.failures.length} 件）`) : ng('失敗の形が不正', JSON.stringify(body.failures ?? null));

  // 業務エージェントごとの受け持ち（第6.7.4.2節）。使える業務はすべて出る
  const { body: cat } = await call('a', '/v1/agents');
  const states = body.agents ?? [];
  states.length >= (cat.items ?? cat.agents ?? []).length && states.every((a) => a.name && typeof a.running === 'number')
    ? ok(`業務の状態を、使える業務すべてについて返す（${states.length} 件）`)
    : ng('業務の状態が足りない', JSON.stringify(states.map((a) => a.agentId)));
  // 絵の番号を業務ごとに返し、重ならない（第6.7.4.3節）
  const faces = states.map((a) => a.face);
  // 絵は 50 枚（AGENT_FACE_COUNT。第 0.140.1 版）
  faces.every((n) => Number.isInteger(n) && n >= 1 && n <= 50) && new Set(faces).size === faces.length
    ? ok(`業務ごとに絵の番号を返す（${faces.join('・')}）`)
    : ng('絵の番号が不正か重なっている', JSON.stringify(faces));
  // 忙しい順に並ぶ
  const busy = states.map((a) => a.running + a.awaiting + a.queued);
  busy.every((n, i) => i === 0 || busy[i - 1] >= n)
    ? ok('忙しい順に並ぶ') : ng('並び順が違う', JSON.stringify(busy));

  const member = await call('a', '/v1/admin/dashboard/live', {}, 'member');
  member.status === 403 ? ok('一般利用者は見られない（403）') : ng(`見えてしまう（${member.status}）`);

  const { body: stats } = await call('a', '/v1/admin/dashboard/stats?days=7');
  stats.daily?.length === 7 && stats.hourly?.length === 24
    ? ok(`集計を返す（7 日分、推計の削減時間 ${stats.totals.savedMinutes} 分）`) : ng('集計の形が不正');

  // 完了した実行に削減時間が記録される（AG-04 の既定値は 10 分）
  const { body: job } = await call('a', '/v1/jobs', {
    method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇の付与日数は' } }),
  });
  const done = await waitFor('a', job.runId, ['completed', 'failed']);
  done.run.savedMinutes === 10 ? ok('完了した実行に標準所要時間（10 分）が記録される') : ng(`記録されない（${done.run.savedMinutes}）`);

  const { body: b } = await call('b', '/v1/admin/dashboard/live', {}, 'admin');
  JSON.stringify(b).includes('管理者さんが「議事録作成') && b.flows.some((f) => f.runId === job.runId)
    ? ng('他社の業務が見える') : ok('他社のダッシュボードに A 社の業務は出ない');
}

console.log('\n■ 19. ヘルプと案内');
{
  const { body: memberList } = await call('a', '/v1/help/articles', {}, 'member');
  const { body: adminList } = await call('a', '/v1/help/articles');
  const memberIds = memberList.items.map((a) => a.id);
  !memberIds.some((id) => id.startsWith('admin-')) && adminList.items.some((a) => a.id === 'admin-setup')
    ? ok(`管理者向けの記事は一般の利用者に出ない（一般 ${memberIds.length} 件・管理者 ${adminList.items.length} 件）`)
    : ng('記事の出し分けが効かない');

  const hidden = await call('a', '/v1/help/articles/admin-setup', {}, 'member');
  hidden.status === 404 ? ok('管理者向けの記事は、ID を指定しても一般の利用者には見えない（404）') : ng(`見えてしまう（${hidden.status}）`);

  const { body: inbox } = await call('a', '/v1/help/agents/inbox-triage', {}, 'member');
  inbox.does?.some((d) => d.includes('送信はしません')) && inbox.flow?.join('→') === '取得→分類→下書き'
    ? ok('業務の説明を定義から作る（受信箱整理は「送信はしません」）') : ng('業務の説明が不正', JSON.stringify(inbox).slice(0, 160));

  const ask = (message) => call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message }) }, 'member');
  const { body: howto } = await ask('承認はどうやるの？');
  howto.helpArticles?.some((a) => a.id === 'start-approvals') && howto.tokensUsed === 0
    ? ok(`使い方の質問にヘルプの記事で答える（「${howto.helpArticles[0].title}」、LLM 不使用）`) : ng('ヘルプで答えない', JSON.stringify(howto).slice(0, 160));

  const { body: rule } = await ask('有給休暇の申請方法は？');
  rule.text.includes('社内の規程では') ? ok('社内規程の質問は、社内の規程から答えて区別する') : ng('社内規程と区別しない', rule.text);

  const { body: unknown } = await ask('宇宙旅行の予約方法は？');
  unknown.text.includes('見当たりませんでした') ? ok('見当たらないときは推測で答えない') : ng('推測で答えている', unknown.text);

  const { body: stillDirect } = await ask('承認待ちある？');
  stillDirect.text.includes('承認待ち') && !stillDirect.helpArticles ? ok('照会（承認待ちある？）は従来どおり即答する') : ng('照会が使い方の質問に取られた');

  const { body: tour } = await call('a', '/v1/onboarding/tour', { method: 'POST', body: JSON.stringify({ reset: true }) }, 'member');
  const { body: after } = await call('a', '/v1/onboarding/tour', {}, 'member');
  tour.completedAt === null && after.completedAt === null ? ok('初回の案内を見直せる（リセット）') : ng('案内の状態が不正');
  await call('a', '/v1/onboarding/tour', { method: 'POST', body: JSON.stringify({}) }, 'member');

  const { body: list } = await call('a', '/v1/onboarding/checklist');
  list.items?.length === 6 && list.items.find((i) => i.id === 'knowledge')?.done === true
    ? ok(`初期設定のチェックリストを他のデータから判定する（${list.items.filter((i) => i.done).length}/6 済み）`) : ng('チェックリストが不正');
  const forbidden = await call('a', '/v1/onboarding/checklist', {}, 'member');
  forbidden.status === 403 ? ok('チェックリストは管理者だけ（403）') : ng(`一般の利用者に見える（${forbidden.status}）`);

  const bad = await fetch(`${API}/v1/secretary`, {
    method: 'POST', body: '{壊れた', headers: { 'content-type': 'application/json', 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' },
  });
  const badBody = await bad.json();
  badBody.requestId && bad.headers.get('x-request-id') === badBody.requestId
    ? ok('エラーの応答に問い合わせ番号（要求 ID）を添える') : ng('要求 ID が無い');
}

console.log('\n■ 20. 拡張機能（サンプル「あいさつ」）');
{
  const EXT = 'jp.m2office.samples.hello-world';
  const AG = `${EXT}:hello`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });

  const { body: list } = await call('a', '/v1/admin/extensions');
  list.items?.some((x) => x.id === EXT) ? ok('サンプルの拡張機能が読み込まれている') : ng('拡張機能が読み込まれていない（API を再起動したか）');

  const before = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { message: 'こんにちは' } }) }, 'member');
  before.status === 404 ? ok('導入していない会社では実行できない（404）') : ng(`実行できてしまう（${before.status}）`);

  const noConsent = await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({}) });
  noConsent.status === 400 ? ok('同意なしでは導入できない（400）') : ng(`同意なしで導入できる（${noConsent.status}）`);
  const member = await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) }, 'member');
  member.status === 403 ? ok('一般の利用者は導入できない（403）') : ng(`導入できてしまう（${member.status}）`);

  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: menu } = await call('a', '/v1/agents', {}, 'member');
  menu.agents.some((x) => x.id === AG && x.extension?.id === EXT) ? ok('導入すると、その会社のメニューに現れる') : ng('メニューに現れない');

  // 見本の「あいさつ」は SKILL.md で書いている（仕様書 第12.12節）。入力の欄は「あいさつ」、答えの文がそのまま結果。
  // 自動テストはスタブの推論で動くため、返事の中身ではなく、最後まで進んで答えの文が残ることを確かめる
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { あいさつ: 'こんにちは' } }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  done.run?.status === 'completed' && (done.steps?.at(-1)?.output?.text ?? '').length > 0
    ? ok('SKILL.md の業務が最後まで進み、答えの文が結果として残る') : ng('返事が違う', JSON.stringify(done.steps?.at(-1)?.output));

  const { body: bMenu } = await call('b', '/v1/agents');
  const bRun = await call('b', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { message: 'こんにちは' } }) });
  !bMenu.agents.some((x) => x.id === AG) && bRun.status === 404
    ? ok('他の会社には現れず、実行もできない') : ng('他の会社から使えてしまう');

  const { body: helpText } = await call('a', `/v1/help/agents/${encodeURIComponent(AG)}`, {}, 'member');
  helpText.summary && Array.isArray(helpText.inputs) && helpText.safeguards === undefined
    ? ok('拡張機能の業務にも、説明が定義から自動で付く（決まり文句は並べない）') : ng('説明が付かない', JSON.stringify(helpText).slice(0, 200));

  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const after = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { message: 'こんにちは' } }) }, 'member');
  after.status === 404 ? ok('削除すると使えなくなる') : ng(`削除後も使える（${after.status}）`);
}

console.log('\n■ 21. 持ち運べる拡張機能（ファイルからの取り込み・スイッチ・コネクタ）');
{
  const EXT = 'jp.example.weekly-report';
  const AG = `${EXT}:weekly`;
  const DIR = new URL('../examples/extensions/weekly-report/', import.meta.url).pathname;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });

  /** ディレクトリを ZIP にする（npm run ext:pack と同じ形）。extra でファイルを足せる。 */
  async function zipDir(dir, extra = {}) {
    const { default: JSZip } = await import('jszip');
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const zip = new JSZip();
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f); else zip.file(relative(dir, f), readFileSync(f));
      }
    };
    walk(dir);
    for (const [k, v] of Object.entries(extra)) zip.file(k, v);
    return zip.generateAsync({ type: 'uint8array' });
  }
  const upload = async (tenant, data) => call(tenant, '/v1/admin/extensions/import', {
    method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' },
  });

  // JSON の定義（manifest.json＋agents/*.json）は廃止した（第 0.131.0 版）
  const { default: JSZipOld } = await import('jszip');
  const old = new JSZipOld();
  old.file('manifest.json', JSON.stringify({ id: 'jp.example.old-json', name: '古い形', version: '1.0.0', publisher: { name: '確認用' }, platform_schema: '>=1 <2', permissions: { tools: [], max_risk_level: 'read' } }));
  old.file('agents/old.json', '{}');
  const retired = await upload('a', await old.generateAsync({ type: 'uint8array' }));
  retired.status === 400 && retired.body.problems?.some((x) => x.includes('廃止しました') && x.includes('SKILL.md'))
    ? ok('JSON の定義の拡張機能は取り込めず、SKILL.md で書くよう伝える（400）') : ng(`取り込めてしまう（${retired.status}）`, JSON.stringify(retired.body));

  const bad = await upload('a', await zipDir(DIR, { 'tools/run.js': 'console.log(1)' }));
  bad.status === 200 && JSON.stringify(bad.body).includes('tools/run.js')
    ? ok('プログラムは持ち込まず、そのことを知らせる（第12.12.6節）') : ng(`扱いが違う（${bad.status}）`, JSON.stringify(bad.body));
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });

  const official = await upload('a', await zipDir(new URL('../extensions/hello-world/', import.meta.url).pathname));
  official.status === 400 && official.body.problems?.some((x) => x.includes('公式の拡張機能と同じ ID'))
    ? ok('公式の拡張機能と同じ ID のファイルは取り込めない') : ng(`取り込めてしまう（${official.status}）`);

  const imp = await upload('a', await zipDir(DIR));
  imp.status === 200 && imp.body.item?.origin === 'private' && !imp.body.item.installed
    ? ok('ファイルから取り込むと、自社専用として一覧に出る（まだ導入はされない）') : ng('取り込めない', JSON.stringify(imp.body));

  const notYet = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 対象の週: '今週' } }) });
  notYet.status === 404 ? ok('取り込んだだけでは使えない（同意して導入が必要）') : ng(`使えてしまう（${notYet.status}）`);

  const { body: bList } = await call('b', '/v1/admin/extensions');
  !bList.items?.some((x) => x.id === EXT) ? ok('取り込んだファイルは、ほかの会社には見えない') : ng('ほかの会社に見える');

  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 対象の週: '今週' } }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  done.run?.status === 'completed' && done.artifacts?.[0]?.title === '週報の下書き（今週）'
    ? ok('同意して導入すると、取り込んだ業務が動く（週報の下書き）') : ng('動かない', JSON.stringify(done.run));

  const off = await call('a', `/v1/admin/extensions/${EXT}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  const { body: menuOff } = await call('a', '/v1/agents', {}, 'member');
  const runOff = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 対象の週: '今週' } }) }, 'member');
  off.status === 200 && !menuOff.agents.some((x) => x.id === AG) && runOff.status === 404
    ? ok('スイッチを切ると、メニューから消えて実行できない') : ng('無効にしても使える');

  const memberToggle = await call('a', `/v1/admin/extensions/${EXT}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) }, 'member');
  memberToggle.status === 403 ? ok('一般の利用者はスイッチを切り替えられない（403）') : ng(`切り替えられる（${memberToggle.status}）`);

  await call('a', `/v1/admin/extensions/${EXT}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const { body: menuOn } = await call('a', '/v1/agents', {}, 'member');
  menuOn.agents.some((x) => x.id === AG) ? ok('スイッチを入れると、同意をやり直さずに戻る') : ng('戻らない');

  const { body: audit } = await call('a', '/v1/admin/audit-events');
  const actions = (audit.items ?? []).filter((e) => e.targetId === EXT).map((e) => e.action);
  ['extension.import', 'extension.install', 'extension.disable', 'extension.enable'].every((x) => actions.includes(x))
    ? ok('取り込み・導入・無効・有効を監査ログに残す') : ng('監査ログに無い', actions.join(', '));

  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const { body: gone } = await call('a', '/v1/admin/extensions');
  !gone.items?.some((x) => x.id === EXT) ? ok('削除すると、取り込んだファイルも消える') : ng('一覧に残る');

  // コネクタ（MCP）。DeepWiki への実際の問い合わせは、ネットワークに依存するため SMOKE_EXTERNAL=1 のときだけ行う
  const DW = 'jp.m2office.samples.deepwiki-research';
  const { body: list } = await call('a', '/v1/admin/extensions');
  const dw = list.items?.find((x) => x.id === DW);
  dw?.connectors?.[0]?.url === 'https://mcp.deepwiki.com/mcp' && dw.counts.tools === 2
    ? ok('コネクタを持つ拡張機能（DeepWiki）が読み込まれている') : ng('DeepWiki の拡張機能が無い');
  if (process.env.SMOKE_EXTERNAL === '1') {
    await call('a', `/v1/admin/extensions/${DW}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
    const check = await call('a', '/v1/admin/connections/mcp/deepwiki/check', { method: 'POST' });
    check.body.ok && check.body.tools.every((t) => t.provided)
      ? ok('コネクタの接続を確かめられる（宣言したツールが提供されている）') : ng('接続を確かめられない', JSON.stringify(check.body));
    const input = { リポジトリ: 'modelcontextprotocol/typescript-sdk', 知りたいこと: 'このリポジトリは何をするものですか？' };
    const { body: j } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: `${DW}:research`, input }) }, 'member');
    const r = await waitFor('a', j.runId, ['completed', 'failed'], 90000, 'member');
    // スキルの段は 1 つ。DeepWiki の答えは道具の結果に残る
    const answer = r.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === 'deepwiki.ask_wiki_question')?.result;
    const body = String(answer?.text ?? '');
    r.run?.status === 'completed' && body.length > 50 && r.artifacts?.length > 0
      ? ok('コネクタで外部に問い合わせ、その結果を資料に残す（鍵なし）') : ng('問い合わせの結果が残らない', body.slice(0, 200));
    await call('a', `/v1/admin/extensions/${DW}`, { method: 'DELETE' });
  } else {
    console.log('  - DeepWiki への実際の問い合わせは省略（SMOKE_EXTERNAL=1 で実行）');
  }

  // 同梱の接続は、導入のときに会社の接続として登録する（第12.11.0節、ADR-0037）。道具は接続の画面で 1 つずつ止める（第6.6.3.1節）
  await call('a', `/v1/admin/extensions/${DW}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: mcpList } = await call('a', '/v1/admin/connections/mcp');
  const reg = mcpList.items?.find((x) => x.id === 'deepwiki');
  reg?.origin === `extension:${DW}` && reg.tools.length === 2 && reg.usedBy.some((a) => a.id === `${DW}:research`)
    ? ok('同梱の接続は、導入のときに会社の接続として登録される（使う業務つき）') : ng('会社の接続に登録されない', JSON.stringify(mcpList));
  const AGENT = `${DW}:research`;
  const toolPath = '/v1/admin/connections/mcp/deepwiki/tools/ask_wiki_question';

  const { body: agentsBefore } = await call('a', '/v1/agents', {}, 'member');
  (agentsBefore.agents ?? []).some((a) => a.id === AGENT)
    ? ok('止める前は、その業務が使える') : ng('業務が使えない');

  // 止める前に、止まる業務を示す
  const { body: impact } = await call('a', `${toolPath}/impact`);
  (impact.agents ?? []).some((a) => a.id === AGENT)
    ? ok('止める前に、止まる業務の名前を示す') : ng('影響を示さない', JSON.stringify(impact));

  const toolOff = await call('a', `${toolPath}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  toolOff.status === 200 ? ok('ツールを 1 つ止められる') : ng(`止められない（${toolOff.status}）`, JSON.stringify(toolOff.body));

  const { body: listOff } = await call('a', '/v1/admin/connections/mcp');
  const conn = listOff.items?.find((x) => x.id === 'deepwiki');
  conn?.tools?.find((t) => t.name === 'ask_wiki_question')?.enabled === false
    && conn?.tools?.find((t) => t.name === 'read_wiki_structure')?.enabled === true
    ? ok('止めたツールだけが「止めている」になる') : ng('状態が違う', JSON.stringify(conn?.tools ?? []));

  const { body: agentsOff } = await call('a', '/v1/agents', {}, 'member');
  !(agentsOff.agents ?? []).some((a) => a.id === AGENT)
    ? ok('止めたツールを使う業務は、メニューから消える') : ng('業務が残っている');

  // 存在自体を示さない（依頼もできない）
  const denied = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AGENT }) }, 'member');
  denied.status === 404 ? ok('止めた業務は依頼もできない（404）') : ng(`依頼できてしまう（${denied.status}）`);

  const { body: auditsTool } = await call('a', '/v1/admin/audit-events');
  (auditsTool.items ?? []).some((e) => e.action === 'connection.mcp.tool.toggle' && e.detail?.enabled === false)
    ? ok('監査ログに connection.mcp.tool.toggle が残る') : ng('監査ログに残らない');

  const toolOn = await call('a', `${toolPath}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const { body: agentsOn } = await call('a', '/v1/agents', {}, 'member');
  toolOn.status === 200 && (agentsOn.agents ?? []).some((a) => a.id === AGENT)
    ? ok('戻せば、ツールも業務も戻る') : ng('戻らない');

  await call('a', `/v1/admin/extensions/${DW}`, { method: 'DELETE' });
}

console.log('\n■ 21b. 会社の接続（MCP を拡張機能から切り離して管理する。第12.11.0節、ADR-0037）');
{
  // 手元に小さな MCP サーバを立てる（開発用の localhost は http で登録できる）
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const msg = JSON.parse(raw || '{}');
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
      : msg.method === 'tools/list' ? { tools: [
        { name: 'list_deals', description: '商談を探す', annotations: { readOnlyHint: true } },
        { name: 'create_invoice', description: '請求書を作る' },
      ] }
      : msg.method === 'tools/call' ? { content: [{ type: 'text', text: `商談: 見本商事（${JSON.stringify(msg.params.arguments)}）` }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}/mcp`;
  await call('a', '/v1/admin/connections/mcp/crm', { method: 'DELETE' });

  const memberAdd = await call('a', '/v1/admin/connections/mcp', { method: 'POST', body: JSON.stringify({ id: 'crm', url }) }, 'member');
  memberAdd.status === 403 ? ok('一般の利用者は接続を登録できない（403）') : ng(`登録できてしまう（${memberAdd.status}）`);
  const added = await call('a', '/v1/admin/connections/mcp', { method: 'POST', body: JSON.stringify({ id: 'crm', name: '顧客管理', url }) });
  const { body: l1 } = await call('a', '/v1/admin/connections/mcp');
  const crm = l1.items?.find((x) => x.id === 'crm');
  added.status === 201 && crm?.tools?.find((t) => t.name === 'list_deals')?.risk === 'read' && crm.tools.find((t) => t.name === 'create_invoice')?.risk === 'external-send'
    ? ok('URL から登録すると道具の一覧を問い合わせ、読むだけの目印が無い道具は「社外に送る」にする') : ng('登録の結果が違う', JSON.stringify({ added: added.body, crm }));
  const dup = await call('a', '/v1/admin/connections/mcp', { method: 'POST', body: JSON.stringify({ id: 'gmail', url }) });
  dup.status === 400 ? ok('内蔵の道具と重なる ID は登録できない') : ng(`登録できてしまう（${dup.status}）`);

  // 同梱していない会社の接続の道具を使う SKILL.md の業務
  const EXT = 'jp.example.crm-deals';
  const AG = `${EXT}:deals`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const data = await skillZip({
    id: EXT, name: 'deals', title: '確認用: 商談を探す', tools: ['crm.list_deals'], inputs: ['会社: 短文'], input: { 会社: '見本商事' },
    stub: { work: [{ name: 'crm.list_deals', args: { company: '見本商事' } }] },
  });
  await call('a', '/v1/admin/extensions/import', { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 会社: '見本商事' } }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed', 'awaiting_approval'], 20000, 'member');
  const called = done.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === 'crm.list_deals')?.result;
  done.run?.status === 'completed' && /見本商事/.test(called?.text ?? '') && called?.source === 'external'
    ? ok('業務が会社の接続の道具を使える（応答は外部のデータの印つき）') : ng('会社の接続の道具を使えない', JSON.stringify({ status: done.run?.status, called }));

  const risk = await call('a', '/v1/admin/connections/mcp/crm', { method: 'PUT', body: JSON.stringify({ tools: [{ name: 'create_invoice', risk: 'financial' }] }) });
  const { body: l2 } = await call('a', '/v1/admin/connections/mcp');
  risk.status === 200 && l2.items?.find((x) => x.id === 'crm')?.tools?.find((t) => t.name === 'create_invoice')?.risk === 'financial'
    ? ok('道具ごとの危険度を管理者が決められる') : ng('危険度を変えられない');

  const check = await call('a', '/v1/admin/connections/mcp/crm/check', { method: 'POST' });
  check.body.ok && check.body.tools.every((t) => t.provided) ? ok('接続を確かめられる') : ng('確かめられない', JSON.stringify(check.body));

  const { body: impact } = await call('a', '/v1/admin/connections/mcp/crm/impact');
  (impact.agents ?? []).some((a) => a.id === AG) ? ok('消す前に、使えなくなる業務の名前を示す') : ng('影響を示さない', JSON.stringify(impact));
  await call('a', '/v1/admin/connections/mcp/crm', { method: 'DELETE' });
  const { body: menu } = await call('a', '/v1/agents', {}, 'member');
  const gone = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 会社: 'x' } }) }, 'member');
  !(menu.agents ?? []).some((a) => a.id === AG) && gone.status === 404
    ? ok('接続を消すと、その道具を使う業務は使えなくなる（接続が要る）') : ng('接続が無くても使えてしまう');
  const { body: bList } = await call('b', '/v1/admin/connections/mcp');
  !(bList.items ?? []).some((x) => x.id === 'crm') ? ok('会社の接続は、ほかの会社には見えない') : ng('ほかの会社に見える');
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  await new Promise((r) => server.close(r));
}

console.log('\n■ 22. グループと利用範囲');
{
  const EXT = 'jp.m2office.samples.hello-world';
  const AG = `${EXT}:hello`;
  const input = { message: 'こんにちは' };
  // 前の確認の残りを片付けてから始める
  for (const g of (await call('a', '/v1/admin/groups')).body.items ?? []) {
    if (g.name.startsWith('確認用')) await call('a', `/v1/admin/groups/${g.id}`, { method: 'DELETE' });
  }
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  await call('a', `/v1/admin/access/${EXT}`, { method: 'PUT', body: JSON.stringify({ scope: 'all' }) });
  await call('a', '/v1/admin/access/minutes', { method: 'PUT', body: JSON.stringify({ scope: 'all' }) });

  const { body: users } = await call('a', '/v1/admin/users');
  const memberId = users.items.find((u) => u.email.startsWith('member@')).id;
  const adminId = users.items.find((u) => u.email.startsWith('admin@')).id;

  const memberCreate = await call('a', '/v1/admin/groups', { method: 'POST', body: JSON.stringify({ name: '確認用-開発' }) }, 'member');
  memberCreate.status === 403 ? ok('一般の利用者はグループを作れない（403）') : ng(`作れてしまう（${memberCreate.status}）`);

  const { status, body: dev } = await call('a', '/v1/admin/groups', { method: 'POST', body: JSON.stringify({ name: '確認用-開発' }) });
  const dup = await call('a', '/v1/admin/groups', { method: 'POST', body: JSON.stringify({ name: '確認用-開発' }) });
  status === 201 && dup.status === 409 ? ok('グループを作れる。同じ名前は作れない') : ng('グループを作れない', `${status} ${dup.status}`);

  const empty = await call('a', `/v1/admin/access/${EXT}`, { method: 'PUT', body: JSON.stringify({ scope: { groups: [], users: [] } }) });
  empty.status === 400 ? ok('グループも人も選ばない範囲は保存できない') : ng(`保存できてしまう（${empty.status}）`);

  await call('a', `/v1/admin/access/${EXT}`, { method: 'PUT', body: JSON.stringify({ scope: { groups: [dev.id], users: [] } }) });
  const { body: m1 } = await call('a', '/v1/agents', {}, 'member');
  const r1 = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  !m1.agents.some((x) => x.id === AG) && r1.status === 404
    ? ok('範囲の外の人のメニューに出ず、起動もできない（404）') : ng('範囲の外から使えてしまう');

  const sec = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: 'こんにちはと英語で返事して' }) }, 'member');
  sec.body.suggestedAgent?.id !== AG ? ok('秘書は範囲の外の業務に取り次がない') : ng('範囲の外の業務に取り次いだ');

  const help = await call('a', `/v1/help/agents/${encodeURIComponent(AG)}`, {}, 'member');
  help.status === 404 ? ok('範囲の外の業務の説明はヘルプに出ない') : ng(`説明が出る（${help.status}）`);

  const sched = await call('a', '/v1/schedules', { method: 'POST', body: JSON.stringify({ agentId: AG, input, rule: { kind: 'daily', hour: 9, minute: 0 } }) }, 'member');
  sched.status === 404 ? ok('範囲の外の業務の定時実行は作れない') : ng(`作れてしまう（${sched.status}）`);

  await call('a', `/v1/admin/groups/${dev.id}/members`, { method: 'PUT', body: JSON.stringify({ userIds: [memberId] }) });
  const { body: m2 } = await call('a', '/v1/agents', {}, 'member');
  const { body: j2 } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const d2 = await waitFor('a', j2.runId, ['completed', 'failed'], 20000, 'member');
  m2.agents.some((x) => x.id === AG) && d2.run?.status === 'completed'
    ? ok('グループに入ると、メニューに出て実行できる') : ng('グループに入っても使えない', JSON.stringify(d2.run));

  const { body: a1 } = await call('a', '/v1/agents');
  !a1.agents.some((x) => x.id === AG) ? ok('管理者も、使う場面では範囲に従う（第16.7.6節）') : ng('管理者は範囲の外でも使える');
  await call('a', `/v1/admin/access/${EXT}`, { method: 'PUT', body: JSON.stringify({ scope: { groups: [dev.id], users: [adminId] } }) });
  const { body: a2 } = await call('a', '/v1/agents');
  a2.agents.some((x) => x.id === AG) ? ok('グループに加えて、個人を指定できる（開発プラス誰か）') : ng('個人の指定が効かない');

  // 依頼のあとに範囲から外れた場合、ワーカーが進める時点で止める
  await call('a', `/v1/admin/access/minutes`, { method: 'PUT', body: JSON.stringify({ scope: { groups: [dev.id], users: [] } }) });
  const { body: mj } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'minutes', input: { transcript: '確認' } }) }, 'member');
  await call('a', `/v1/admin/groups/${dev.id}/members`, { method: 'PUT', body: JSON.stringify({ userIds: [] }) });
  const md = await waitFor('a', mj.runId, ['completed', 'failed', 'awaiting_approval'], 20000, 'member');
  md.run?.status === 'failed' && /利用範囲の外/.test(md.run.failureReason ?? '')
    ? ok('依頼のあとに範囲から外れたら、実行を止める') : console.log(`  - 実行が先に進んだため、範囲の変更前に完了（${md.run?.status}）`);

  const { body: usage } = await call('a', '/v1/me/usage', {}, 'member');
  Array.isArray(usage.groups) ? ok('個人設定の利用状況に、本人のグループが出る') : ng('グループが出ない');

  const del = await call('a', `/v1/admin/groups/${dev.id}`, { method: 'DELETE' });
  const { body: acc } = await call('a', '/v1/admin/access');
  del.body.emptied?.includes('minutes') && acc.scopes.minutes?.groups.length === 0
    ? ok('グループを消すと範囲から外れ、誰も残らない業務を知らせる（全員には戻さない）') : ng('グループの削除の扱いが違う', JSON.stringify(del.body));

  const { body: audit } = await call('a', '/v1/admin/audit-events');
  const acts = new Set((audit.items ?? []).map((e) => e.action));
  ['group.create', 'group.members', 'group.delete', 'settings.update'].every((x) => acts.has(x))
    ? ok('グループと範囲の変更を監査ログに残す') : ng('監査ログに無い');

  const { body: bGroups } = await call('b', '/v1/admin/groups');
  !(bGroups.items ?? []).some((g) => g.name.startsWith('確認用')) ? ok('グループはほかの会社から見えない') : ng('ほかの会社から見える');

  await call('a', `/v1/admin/access/${EXT}`, { method: 'PUT', body: JSON.stringify({ scope: 'all' }) });
  await call('a', '/v1/admin/access/minutes', { method: 'PUT', body: JSON.stringify({ scope: 'all' }) });
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
}

console.log('\n■ 23. 権限区画をグループで割り当てる');
{
  for (const g of (await call('a', '/v1/admin/groups')).body.items ?? []) {
    if (g.name.startsWith('確認用')) await call('a', `/v1/admin/groups/${g.id}`, { method: 'DELETE' });
  }
  const { body: users } = await call('a', '/v1/admin/users');
  const memberId = users.items.find((u) => u.email.startsWith('member@')).id;

  const bad = await call('a', '/v1/admin/compartments', { method: 'POST', body: JSON.stringify({ name: '法務' }) });
  bad.status === 400 ? ok('区画の名前は英小文字・数字・ハイフンに限る') : ng(`受け付けてしまう（${bad.status}）`);
  let comp = (await call('a', '/v1/admin/compartments')).body.items.find((x) => x.name === 'smoke-legal');
  if (!comp) comp = (await call('a', '/v1/admin/compartments', { method: 'POST', body: JSON.stringify({ name: 'smoke-legal', description: '確認用の法務' }) })).body;
  comp?.id ? ok('区画を作れる') : ng('区画を作れない');

  const memberAssign = await call('a', `/v1/admin/compartments/${comp.id}/assignment`, { method: 'PUT', body: JSON.stringify({ groups: [], users: [memberId] }) }, 'member');
  memberAssign.status === 403 ? ok('一般の利用者は区画の割当を変えられない（403）') : ng(`変えられてしまう（${memberAssign.status}）`);

  const { body: legal } = await call('a', '/v1/admin/groups', { method: 'POST', body: JSON.stringify({ name: '確認用-法務' }) });
  await call('a', `/v1/admin/compartments/${comp.id}/assignment`, { method: 'PUT', body: JSON.stringify({ groups: [legal.id], users: [] }) });
  const before = (await call('a', '/v1/me/usage', {}, 'member')).body.compartments;
  !before.includes('smoke-legal') ? ok('グループに所属していなければ区画に入れない') : ng('所属していないのに区画に入れる');

  const since = new Date().toISOString();
  await call('a', `/v1/admin/groups/${legal.id}/members`, { method: 'PUT', body: JSON.stringify({ userIds: [memberId] }) });
  const after = (await call('a', '/v1/me/usage', {}, 'member')).body.compartments;
  after.includes('smoke-legal') ? ok('区画に割り当てたグループに入ると、区画に入れる') : ng('区画に入れない', JSON.stringify(after));

  const { body: notes } = await call('a', '/v1/notifications');
  (notes.items ?? []).some((n) => n.kind === 'security' && n.createdAt >= since && n.body.includes('確認用の法務'))
    ? ok('区画に入れる人が変わると、管理者に通知する') : ng('管理者に通知されない');

  const { body: groups } = await call('a', '/v1/admin/groups');
  groups.items.find((g) => g.id === legal.id)?.usedBy?.compartments.includes('確認用の法務')
    ? ok('グループがどの区画に割り当てられているかを示す') : ng('割り当て先が示されない');

  await call('a', `/v1/admin/groups/${legal.id}/members`, { method: 'PUT', body: JSON.stringify({ userIds: [] }) });
  const out = (await call('a', '/v1/me/usage', {}, 'member')).body.compartments;
  const { body: audit } = await call('a', '/v1/admin/audit-events');
  const acts = (audit.items ?? []).filter((e) => e.targetId === comp.id).map((e) => e.action);
  !out.includes('smoke-legal') && acts.includes('compartment.enter') && acts.includes('compartment.leave')
    ? ok('所属から外すと区画から出る。出入りを監査ログに残す') : ng('出入りの扱いが違う', acts.join(', '));

  const { body: bComp } = await call('b', '/v1/admin/compartments');
  !(bComp.items ?? []).some((x) => x.name === 'smoke-legal') ? ok('区画と割当はほかの会社から見えない') : ng('ほかの会社から見える');

  // 無効にすると、その間は誰も区画に入れない（第16.3.6.1節）
  await call('a', `/v1/admin/groups/${legal.id}/members`, { method: 'PUT', body: JSON.stringify({ userIds: [memberId] }) });
  await call('a', `/v1/admin/compartments/${comp.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  const disabled = (await call('a', '/v1/me/usage', {}, 'member')).body.compartments;
  !disabled.includes('smoke-legal') ? ok('無効にすると、割当が残っていても誰も区画に入れない') : ng('入れてしまう');

  await call('a', `/v1/admin/compartments/${comp.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const reenabled = (await call('a', '/v1/me/usage', {}, 'member')).body.compartments;
  reenabled.includes('smoke-legal') ? ok('有効に戻すと、元の割当が効く') : ng('戻らない', JSON.stringify(reenabled));

  // 区画に知識が残っていれば削除を断る
  await call('a', '/v1/admin/knowledge/smoke-comp-doc', {
    method: 'PUT',
    body: JSON.stringify({ title: '確認用の区画の文書', body: '区画内の文書です。', source: '確認用', compartment: 'smoke-legal' }),
  });
  const busy = await call('a', `/v1/admin/compartments/${comp.id}`, { method: 'DELETE' });
  busy.status === 409 && busy.body.knowledge === 1
    ? ok('区画に知識が残っていれば削除を断り、何が残っているかを示す') : ng(`断らない（${busy.status}）`, JSON.stringify(busy.body));

  await call('a', '/v1/admin/knowledge/smoke-comp-doc', { method: 'DELETE' });
  const removed = await call('a', `/v1/admin/compartments/${comp.id}`, { method: 'DELETE' });
  const { body: left } = await call('a', '/v1/admin/compartments');
  removed.status === 200 && !(left.items ?? []).some((x) => x.id === comp.id)
    ? ok('残っていなければ区画を削除できる') : ng(`削除できない（${removed.status}）`, JSON.stringify(removed.body));

  const { body: audit2 } = await call('a', '/v1/admin/audit-events');
  const acts2 = (audit2.items ?? []).filter((e) => e.targetId === comp.id).map((e) => e.action);
  ['compartment.disable', 'compartment.enable', 'compartment.delete'].every((a) => acts2.includes(a))
    ? ok('無効化・有効化・削除を監査ログに残す') : ng('記録が足りない', acts2.join(', '));

  await call('a', `/v1/admin/groups/${legal.id}`, { method: 'DELETE' });
}

console.log('\n■ 24. スライド作成（web.research・slides.create）');
{
  const EXT = 'jp.m2office.samples.research-slides';
  const AG = `${EXT}:research-slides`;
  const input = { request: 'ローカルで動く LLM の最近の製品動向を 8 ページで' };
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const badTpl = await call('a', '/v1/admin/settings/slides', { method: 'PUT', body: JSON.stringify({ templates: [{ name: 'x', presentationId: 'https://example.com/' }] }) });
  badTpl.status === 400 ? ok('Google スライドの URL でないものは、テンプレートとして登録できない') : ng(`登録できてしまう（${badTpl.status}）`);
  const url = 'https://docs.google.com/presentation/d/1EVrKerODrfy5b3iKJDfLUCi4pvJZbal0l8uM-0uKqUc/edit';
  await call('a', '/v1/admin/settings/slides', { method: 'PUT', body: JSON.stringify({ templates: [{ name: '確認用テンプレート', presentationId: url }] }) });
  const { body: st } = await call('a', '/v1/admin/settings');
  const tpl = st.slides?.templates?.[0];
  tpl?.presentationId === '1EVrKerODrfy5b3iKJDfLUCi4pvJZbal0l8uM-0uKqUc' && tpl.isDefault
    ? ok('URL からファイルの ID を取り出して登録し、1 件目を既定にする') : ng('テンプレートの登録が違う', JSON.stringify(tpl));
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const research = done.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === 'web.research')?.result;
  research?.source === 'mock' && /実際には調べていません/.test(research.text)
    ? ok('自動テストの見本の調査は、見本であることを明示する') : ng('見本の調査の扱いが違う', JSON.stringify(research));
  const art = done.artifacts?.find((x) => x.kind === 'slides');
  done.run?.status === 'completed' && art && (art.body.match(/^## \d+\./gm) ?? []).length === 7
    ? ok('構成を検証し、表紙を含む 8 ページのアウトラインを成果物に残す') : ng('スライドの成果物が無い', JSON.stringify(done.run));
  /テンプレート: 確認用テンプレート/.test(art?.body ?? '') ? ok('登録した既定のテンプレートで作る') : ng('既定のテンプレートが使われない');
  await call('a', '/v1/admin/settings/slides', { method: 'PUT', body: JSON.stringify({ templates: [] }) });
  const { body: tools } = await call('a', `/v1/help/agents/${encodeURIComponent(AG)}`, {}, 'member');
  JSON.stringify(tools).includes('Google に送られます')
    ? ok('業務の説明に、調べる言葉が Google に送られることが出る') : ng('説明に外部送信の注意が無い');
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
}

console.log('\n■ 25. Google Workspace のツール（第 1 弾）');
{
  const EXT = 'jp.example.smoke-google-tools';
  const AG = `${EXT}:memo-to-sheet`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const tools = ['drive.search', 'drive.read', 'sheets.create', 'sheets.append', 'gmail.send'];
  const input = { memo: '営業会議メモ' };
  // スキルの段は「作業 → 承認 → 送る」（送る道具があるため M2Office が組み立てる。第12.12.1節）
  const stub = {
    work: [
      { name: 'drive.search', args: { query: '営業会議メモ' } },
      { name: 'drive.read', args: { fileId: 'mock-file-t-alpha-1' } },
      { name: 'sheets.create', args: { title: '決定事項（確認用）', columns: ['内容'], rows: [['決定事項の見本']] } },
      { name: 'sheets.append', args: { spreadsheetId: 'x' } },
    ],
    send: [{ name: 'gmail.send', args: { to: ['sato@customer.example.jp'], subject: '決定事項（確認用）', body: '確認用の本文' } }],
  };
  const pack = () => skillZip({ id: EXT, name: 'memo-to-sheet', title: '確認用: 会議メモを表にして送る', tools, inputs: ['memo: 短文'], input, stub });
  const upload = async (data) => call('a', '/v1/admin/extensions/import', { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });

  const imp = await upload(await pack());
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const waiting = await waitFor('a', job.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  const out = (id) => waiting.steps?.find((x) => x.stepId === id)?.output?.tools ?? [];
  const tool = (name) => out('work').find((t) => t.name === name);
  const read = tool('drive.read')?.result;
  const [created, badAppend] = [tool('sheets.create'), tool('sheets.append')];
  const { body: menu } = await call('a', '/v1/agents', {}, 'member');
  menu.agents?.find((x) => x.id === AG)?.hasApproval === true
    ? ok('メールを送る業務には、M2Office が承認の段を入れる（SKILL.md に書かなくてよい）') : ng('承認の段が無い', JSON.stringify(menu.agents?.find((x) => x.id === AG)));
  imp.status === 200 && read?.untrusted === true && /佐藤様への提案/.test(read.text) && tool('drive.search')?.result?.count >= 1
    ? ok('ドライブのファイルを探して読める（中身はデータの印つき）') : ng('探す・読むができない', JSON.stringify(out('work')));
  created?.result?.created === true && created.result.file.kind === 'spreadsheet'
    ? ok('読んだ内容からスプレッドシートを作れる') : ng('スプレッドシートを作れない', JSON.stringify(created));
  /引数が正しくありません: rows がありません/.test(badAppend?.error ?? '')
    ? ok('必須の引数が無い呼び出しは、ツールを呼ばずに理由を返す') : ng('引数の検証が効かない', JSON.stringify(badAppend));
  // 送る段は承認の前に組み立てられ、「承認のあとに実行します」の印だけが残る（第9.3.3節）
  waiting.run?.status === 'awaiting_approval' && out('send').every((t) => !t.result) && out('send').some((t) => t.pending)
    ? ok('メールの送信の手前で、承認を待つ（送る中身は組み立て済みで、まだ送っていない）') : ng('承認を待たない', waiting.run?.status);

  const ap = await approvalFor('a', job.runId, 'member');
  await call('a', `/v1/approvals/${ap.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const sent = done.steps?.find((x) => x.stepId === 'send')?.output?.tools?.find((t) => t.name === 'gmail.send' && t.result)?.result;
  done.run?.status === 'completed' && sent?.sent === true && sent.source === 'mock'
    ? ok('承認のあとにメールを送る（見本の接続口）') : ng('承認のあとに送れない', JSON.stringify(done.run));

  const { body: perms } = await call('a', '/v1/admin/google-permissions');
  const gmail = perms.items?.find((p) => p.scope === 'gmail.readonly');
  const drive = perms.items?.find((p) => p.scope === 'drive.file');
  gmail?.level === 'restricted' && drive?.agents.includes('確認用: 会議メモを表にして送る')
    ? ok('会社の業務が求める Google の権限と段階を一覧できる') : ng('権限の一覧が違う', JSON.stringify(perms.items));
  const memberPerms = await call('a', '/v1/admin/google-permissions', {}, 'member');
  memberPerms.status === 403 ? ok('権限の一覧は管理者だけが見られる') : ng(`見られてしまう（${memberPerms.status}）`);
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
}

console.log('\n■ 26. Google Workspace のツール（第 2 弾）');
{
  const EXT = 'jp.example.smoke-google-tools-2';
  const AG = `${EXT}:meeting-share`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const tools = ['meet.transcript', 'directory.search', 'docs.create', 'drive.share'];
  const input = { meeting: '営業定例' };
  const stub = {
    work: [
      { name: 'meet.transcript', args: { query: '営業定例' } },
      { name: 'directory.search', args: { query: '営業部' } },
      { name: 'docs.create', args: { title: '営業定例の記録（確認用）', body: '営業定例の記録の見本' } },
    ],
  };
  const data = await skillZip({ id: EXT, name: 'meeting-share', title: '確認用: 会議の記録を共有する', tools, inputs: ['meeting: 短文'], input, stub });
  await call('a', '/v1/admin/extensions/import', { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const w = await waitFor('a', job.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  const out = (name) => w.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === name)?.result;
  out('meet.transcript')?.untrusted === true && /佐藤様への提案/.test(out('meet.transcript')?.text ?? '')
    ? ok('Meet の会議の文字起こしを取れる（中身はデータの印つき）') : ng('文字起こしを取れない', JSON.stringify(out('meet.transcript')));
  out('directory.search')?.people?.[0]?.department === '営業部' ? ok('社内の人を部署で探せる') : ng('社内の人を探せない', JSON.stringify(out('directory.search')));
  const docId = out('docs.create')?.file?.id;
  // 共有する文書の ID は実行中に決まるため、見本の応答では共有の段に操作を書けない。
  // 送るものが無い承認の段は、人を待たずに通る（仕様書 第9.3.3節・第9.4.0節、ADR-0028）
  const gateRow = w.steps?.find((x) => x.stepId === 'approve');
  w.run?.status === 'completed' && docId && gateRow?.output?.automatic === true
    ? ok('記録の文書を作り、送るものが無い承認の段は自動で通る') : ng('承認の段の扱いが違う', JSON.stringify({ status: w.run?.status, gate: gateRow?.output }));
  const { body: perms } = await call('a', '/v1/admin/google-permissions');
  ['meetings.space.readonly', 'directory.readonly'].every((sc) => perms.items?.some((p) => p.scope === sc && p.level === 'sensitive'))
    ? ok('第 2 弾の権限（Meet・ディレクトリ）が、段階つきで一覧に出る') : ng('権限の一覧に出ない', JSON.stringify(perms.items));
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
}

console.log('\n■ 27. Google Workspace のツール（第 3 弾: フォームの回答）');
{
  const EXT = 'jp.example.smoke-google-tools-3';
  const AG = `${EXT}:survey-summary`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const tools = ['drive.search', 'forms.responses', 'sheets.create'];
  const input = { form: '研修のアンケート' };
  const stub = {
    work: [
      { name: 'drive.search', args: { query: 'アンケート' } },
      { name: 'forms.responses', args: { formId: 'mock-file-t-alpha-3' } },
      { name: 'sheets.create', args: { title: 'アンケートの集計（確認用）', columns: ['回答'], rows: [['回答の見本']] } },
    ],
  };
  const data = await skillZip({ id: EXT, name: 'survey-summary', title: '確認用: アンケートを表にまとめる', tools, inputs: ['form: 短文'], input, stub });
  await call('a', '/v1/admin/extensions/import', { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const out = (name) => done.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === name)?.result;
  out('drive.search')?.items?.[0]?.kind === 'form' ? ok('ドライブの検索でフォームが見つかる') : ng('フォームが見つからない', JSON.stringify(out('drive.search')));
  const r = out('forms.responses');
  r?.untrusted === true && r.count === 3 && r.form?.questions?.includes('満足度')
    ? ok('フォームの回答を、質問の文つきで取れる（データの印つき）') : ng('回答を取れない', JSON.stringify(r));
  done.run?.status === 'completed' && out('sheets.create')?.created === true
    ? ok('回答を表（スプレッドシート）にまとめる') : ng('表にまとめられない', JSON.stringify(done.run));
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
}

console.log('\n■ 28. 接続の設定（Gemini・Google Workspace）');
{
  const key = 'AIzaSySMOKE_TEST_ONLY_0000000000000';
  const memberPut = await call('a', '/v1/admin/connections/gemini', { method: 'PUT', body: JSON.stringify({ mode: 'byok', apiKey: key }) }, 'member');
  memberPut.status === 403 ? ok('一般の利用者は接続の設定を変えられない（403）') : ng(`変えられてしまう（${memberPut.status}）`);

  await call('a', '/v1/admin/connections/gemini', { method: 'PUT', body: JSON.stringify({ mode: 'byok', apiKey: key, models: { standard: 'gemini-2.5-flash' } }) });
  const { body: conn } = await call('a', '/v1/admin/connections');
  conn.gemini.keyRegistered && conn.gemini.effective === 'tenant' && !JSON.stringify(conn).includes(key)
    ? ok('自社の鍵を登録でき、登録後は値を返さない') : ng('鍵の扱いが違う', JSON.stringify(conn.gemini));
  const { body: audit } = await call('a', '/v1/admin/audit-events');
  const ev = (audit.items ?? []).find((e) => e.action === 'connection.gemini.update');
  ev && !JSON.stringify(ev).includes(key) ? ok('鍵の登録を監査ログに残す（値は残さない）') : ng('監査ログの扱いが違う', JSON.stringify(ev));
  const bad = await call('a', '/v1/admin/connections/gemini', { method: 'PUT', body: JSON.stringify({ mode: 'byok', apiKey: 'short' }) });
  bad.status === 400 ? ok('短すぎる鍵は登録できない') : ng(`登録できてしまう（${bad.status}）`);
  const spaced = await call('a', '/v1/admin/connections/gemini', { method: 'PUT', body: JSON.stringify({ mode: 'byok', apiKey: 'AIza xxxxxxxxxxxxxxxxxxxxxxxx' }) });
  spaced.status === 400 ? ok('空白の混じった鍵は登録できない（貼り間違い）') : ng(`登録できてしまう（${spaced.status}）`);
  // 鍵の形は推測しない。Google は形式を変える（`AQ.` で始まりドットを含む鍵を弾いた事故がある）
  const newStyle = await call('a', '/v1/admin/connections/gemini', {
    method: 'PUT', body: JSON.stringify({ mode: 'byok', apiKey: 'AQ.Ab8RN6IsSMOKE_TEST_ONLY.0000000000000000000' }),
  });
  newStyle.status === 200 ? ok('新しい形式（AQ. で始まりドットを含む）の鍵も登録できる') : ng(`弾いてしまう（${newStyle.status}）`, JSON.stringify(newStyle.body));
  await call('a', '/v1/admin/connections/gemini', { method: 'PUT', body: JSON.stringify({ mode: 'byok', apiKey: key }) });
  await call('a', '/v1/admin/connections/gemini/key', { method: 'DELETE' });
  const { body: after } = await call('a', '/v1/admin/connections');
  !after.gemini.keyRegistered && after.gemini.mode === 'platform' ? ok('鍵を削除すると運営一括に戻る') : ng('削除できない');

  const badClient = await call('a', '/v1/admin/connections/google', { method: 'PUT', body: JSON.stringify({ clientId: 'x', clientSecret: 'y' }) });
  badClient.status === 400 ? ok('形式の違う OAuth クライアント ID は登録できない') : ng(`登録できてしまう（${badClient.status}）`);
  const before = await call('a', '/v1/me/google/connect', { method: 'POST' }, 'member');
  await call('a', '/v1/admin/connections/google', { method: 'DELETE' });
  const none = await call('a', '/v1/me/google/connect', { method: 'POST' }, 'member');
  none.status === 409 ? ok('会社の OAuth クライアントが無ければ、利用者は接続を始められない') : ng(`始められてしまう（${none.status}）`);
  void before;

  // 登録の確認（第14.3.3節）。保存の前に Google で組を確かめ、誤りなら保存しない。
  // 架空のクライアントは本物の Google に「見つからない」と断られる。届かない環境では確かめられないまま保存される
  const fake = await call('a', '/v1/admin/connections/google', { method: 'PUT', body: JSON.stringify({ clientId: '123456-smoke.apps.googleusercontent.com', clientSecret: 'GOCSPX-smoke-secret' }) });
  if (fake.status === 400) {
    fake.body.verdict === 'no-client' && fake.body.error.includes('見つかりません')
      ? ok('Google に無いクライアント ID は、確かめて保存しない') : ng('断り方が違う', JSON.stringify(fake.body));
    const { body: afterFake } = await call('a', '/v1/admin/connections');
    !afterFake.google.secretRegistered ? ok('断ったときは何も保存しない') : ng('断ったのに保存されている');
  } else {
    fake.status === 200 && fake.body.verdict === 'unreachable' && fake.body.message.includes('確かめられていません')
      ? ok('Google に届かない環境では、確かめられなかったと明示して保存する') : ng('確かめの結果が違う', JSON.stringify(fake.body));
  }

  // 以降の確認のために、架空のクライアントを直接入れる（テストの準備。Google の確かめを通らない値のため）。
  // 暗号化はサーバーと同じ箱で行う（.env を同じく読むため、同じ鍵になる）
  const { tsImport } = await import('tsx/esm/api');
  const { secretBoxFromEnv } = await tsImport('../packages/core/src/secrets/box.ts', import.meta.url);
  const { default: pgSeed } = await import('pg');
  const seedDb = new pgSeed.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await seedDb.connect();
  const seedClient = (secret) => seedDb.query(
    `insert into tenant_credentials (tenant_id, kind, secret_enc, meta, updated_by, updated_at)
     values ((select id from tenants where subdomain = 'a'), 'google_oauth', $1, $2, 'smoke', now())
     on conflict (tenant_id, kind) do update set secret_enc = excluded.secret_enc, meta = excluded.meta, updated_at = excluded.updated_at`,
    [secretBoxFromEnv().box.encrypt(secret), { clientId: '123456-smoke.apps.googleusercontent.com' }],
  );
  await seedClient('GOCSPX-smoke-secret');
  await seedDb.end();

  // 誤ったシークレットで上書きしようとしても、いまの登録は残る（接続済みの全員を巻き込まないため）
  const { body: seeded } = await call('a', '/v1/admin/connections');
  const over = await call('a', '/v1/admin/connections/google', { method: 'PUT', body: JSON.stringify({ clientId: '123456-smoke.apps.googleusercontent.com', clientSecret: 'GOCSPX-other' }) });
  const { body: afterOver } = await call('a', '/v1/admin/connections');
  if (over.status === 400) {
    afterOver.google.updatedAt === seeded.google.updatedAt && afterOver.google.secretRegistered
      ? ok('確かめて誤りなら、いまの登録を上書きしない') : ng('上書きされた', JSON.stringify(afterOver.google));
  }
  // 「Google で確かめる」は何も変えず、判定と文だけを返す。シークレットは返さない
  const tried = await call('a', '/v1/admin/connections/google/test', { method: 'POST' });
  tried.status === 200 && ['no-client', 'unreachable'].includes(tried.body.verdict) && tried.body.message && !JSON.stringify(tried.body).includes('GOCSPX')
    ? ok(`登録済みのクライアントを確かめられる（判定: ${tried.body.verdict}）`) : ng('確かめの応答が違う', JSON.stringify(tried.body));
  const triedByMember = await call('a', '/v1/admin/connections/google/test', { method: 'POST' }, 'member');
  triedByMember.status === 403 ? ok('一般利用者は確かめられない（403）') : ng(`確かめられてしまう（${triedByMember.status}）`);

  const { body: g } = await call('a', '/v1/admin/connections');
  g.google.secretRegistered && !JSON.stringify(g).includes('GOCSPX-smoke-secret') && g.google.redirectUri.endsWith('/v1/oauth/google/callback')
    ? ok('OAuth クライアントを登録でき、シークレットは返さず、登録するリダイレクト URI を示す') : ng('OAuth クライアントの扱いが違う', JSON.stringify(g.google));

  const { body: start } = await call('a', '/v1/me/google/connect', { method: 'POST' }, 'member');
  const q = new URL(start.url).searchParams;
  const scope = q.get('scope') ?? '';
  q.get('client_id') === '123456-smoke.apps.googleusercontent.com' && q.get('code_challenge_method') === 'S256' && q.get('state')
    && scope.includes('gmail.readonly') && scope.startsWith('openid email')
    ? ok('接続の URL に、会社のクライアント・PKCE・state・業務が求める権限を付ける') : ng('接続の URL が違う', start.url);
  const cb = await fetch(`${API}/v1/oauth/google/callback?state=forged&code=x`);
  cb.status === 400 ? ok('照合できない戻り（偽の state）では何もしない') : ng(`受け付けてしまう（${cb.status}）`);
  const cancel = await fetch(`${API}/v1/oauth/google/callback?state=${q.get('state')}&error=access_denied`, { redirect: 'manual' });
  (cancel.headers.get('location') ?? '').includes('google=cancelled') ? ok('利用者が取りやめたら、取りやめたことを画面に戻す') : ng('取りやめの扱いが違う', cancel.headers.get('location'));
  const reuse = await fetch(`${API}/v1/oauth/google/callback?state=${q.get('state')}&code=x`);
  reuse.status === 400 ? ok('state は 1 回しか使えない') : ng(`2 回使えてしまう（${reuse.status}）`);

  const { body: mine } = await call('a', '/v1/me/google', {}, 'member');
  mine.available && !mine.connected && mine.scopes.some((x) => x.label === 'メールを読む')
    ? ok('本人の Google 連携に、業務の言葉で許可の一覧を出す') : ng('本人の連携の表示が違う', JSON.stringify(mine));
  const { body: bConn } = await call('b', '/v1/admin/connections');
  !bConn.google.secretRegistered ? ok('接続の設定はほかの会社から見えない') : ng('ほかの会社から見える');
  await call('a', '/v1/admin/connections/google', { method: 'DELETE' });
}

console.log('\n■ 29. 組織知識の節（章・条で分けて、条の単位で引く）');
{
  const rules = ['第1章 総則', '第1条（目的）', 'この規程は出張の扱いを定める。', '第2章 旅費',
    '（日当）', '第5条 出張の日当は 1 日 2,000 円とする。', '第6条（宿泊費）', '宿泊費は 1 泊 1 万円を上限に実費を精算する。'].join('\n');
  const { status, body: saved } = await call('a', '/v1/admin/knowledge/new', {
    method: 'PUT', body: JSON.stringify({ title: '出張旅費規程', body: rules, source: '出張旅費規程（見本）' }),
  });
  const heads = (saved.sections ?? []).map((x) => x.heading);
  status === 200 && heads.join('|') === '第1条（目的）|第5条（日当）|第6条（宿泊費）' && saved.sections[1].path[0] === '第2章 旅費'
    ? ok('保存すると条ごとの節に分け、分けた結果を返す') : ng('分け方が違う', JSON.stringify(saved));

  const { body: list } = await call('a', '/v1/admin/knowledge');
  list.items?.find((k) => k.id === saved.id)?.sectionCount === 3 ? ok('一覧に節の数を出す') : ng('節の数が違う');

  const { body: job } = await call('a', '/v1/jobs', {
    method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '出張の日当はいくら？' } }),
  });
  const qa = await waitFor('a', job.runId, ['completed', 'failed']);
  const hits = qa.steps.find((x) => x.stepId === 'search')?.output?.tools?.[0]?.result?.hits ?? [];
  hits[0]?.citation === '出張旅費規程 › 第2章 旅費 › 第5条（日当）' && !hits[0].body.includes('宿泊費')
    ? ok(`条の単位で引き、出典に条を示す（${hits[0].citation}）`) : ng('条の単位で引けていない', JSON.stringify(hits[0]));

  const other = await call('b', `/v1/admin/knowledge/${saved.id}/sections`);
  other.status === 404 ? ok('ほかの会社の知識の節は見えない') : ng(`見えてしまう（${other.status}）`);
  const tooLong = await call('a', '/v1/admin/knowledge/new', {
    method: 'PUT', body: JSON.stringify({ title: '長すぎる', body: 'あ'.repeat(500_001) }),
  });
  tooLong.status === 400 ? ok('50 万字を超える本文は断る') : ng(`受け付けてしまう（${tooLong.status}）`);

  await call('a', `/v1/admin/knowledge/${saved.id}`, { method: 'DELETE' });
  const gone = await call('a', `/v1/admin/knowledge/${saved.id}/sections`);
  gone.status === 404 ? ok('知識を削除すると節も消える') : ng('節が残っている');
}

console.log('\n■ 30. 言い換え（第11.7.7節。第 0.115.0 版から秘書が考え、新しくは登録しない）');
{
  const qa = async (question, tenant = 'a') => {
    const { body: job } = await call(tenant, '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question } }) });
    const run = await waitFor(tenant, job.runId, ['completed', 'failed']);
    return run.steps.find((x) => x.stepId === 'search')?.output?.tools?.[0]?.result ?? {};
  };

  const std = await qa('育休はいつまで？');
  std.hits?.[0]?.heading === '第34条（育児休業）' && std.note === '「育休」を「育児休業」と読み替えて探しました'
    ? ok('標準の言い換えで「育休」から「育児休業」の条を見つけ、読み替えを示す') : ng('標準の言い換えが効かない', JSON.stringify(std).slice(0, 200));

  const put = await call('a', '/v1/admin/settings/knowledge', { method: 'PUT', body: JSON.stringify({ standardSynonyms: true, synonyms: '始業、出社の時刻' }) });
  put.status === 400 ? ok('言い換えを新しく登録する操作は受け付けない（400）') : ng(`登録できてしまう（${put.status}）`);

  // 第 0.115.0 版より前に会社が登録した組は、そのまま効く
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const { rows: [before] } = await owner.query(`select knowledge from tenant_settings where tenant_id = 't-alpha'`);
  try {
    await owner.query(`update tenant_settings set knowledge = $1 where tenant_id = 't-alpha'`,
      [JSON.stringify({ standardSynonyms: true, synonyms: [['始業', '出社の時刻']] })]);
    const own = await qa('出社の時刻は何時？');
    own.hits?.[0]?.heading === '第15条（始業・終業の時刻）' ? ok('以前に登録した自社の組は、そのまま効く') : ng('登録済みの組が効かない', JSON.stringify(own.hits?.[0] ?? null));
    const bOwn = await qa('出社の時刻は何時？', 'b');
    !(bOwn.hits ?? []).some((h) => h.heading?.includes('始業')) ? ok('言い換えはほかの会社に効かない') : ng('ほかの会社に効いている');
  } finally {
    await owner.query(`update tenant_settings set knowledge = $1 where tenant_id = 't-alpha'`, [before?.knowledge ?? null]);
    await owner.end();
  }
}

console.log('\n■ 31. 実行の中身を見られる人（第6.2.1節）');
{
  // 一般利用者が依頼した実行を、承認者の役割を持つ管理者が開けるか
  const run = async (agentId, input) => {
    const { body } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId, input }) }, 'member');
    for (let i = 0; i < 60; i++) {
      const { body: r } = await call('a', `/v1/runs/${body.runId}`, {}, 'member');
      if (['completed', 'failed', 'awaiting_approval'].includes(r.run?.status)) return body.runId;
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return body.runId;
  };
  const inbox = await run('inbox-triage', {});
  const own = await call('a', `/v1/runs/${inbox}`, {}, 'member');
  const other = await call('a', `/v1/runs/${inbox}`, {}, 'admin');
  own.status === 200 && other.status === 404
    ? ok('承認のない実行（受信箱整理）は、承認者の役割があっても依頼した本人しか開けない') : ng(`見えてしまう（本人 ${own.status}、ほかの人 ${other.status}）`);

  const minutes = await run('minutes', { title: '閲覧の確認', transcript: 'A 案で進めることを決定。', space: 'general' });
  const approver = await call('a', `/v1/runs/${minutes}`, {}, 'admin');
  approver.status === 200 ? ok('自分が判断できる承認がある実行は、承認する人が開ける') : ng(`承認する人が開けない（${approver.status}）`);

  const form = new FormData();
  form.append('file', new Blob(['日付,金額\n2026-09-01,1000\n']), '経費.csv');
  const up = await fetch(`${API}/v1/files`, { method: 'POST', body: form, headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
  const file = await up.json();
  const fileByOther = await fetch(`${API}/v1/files/${file.id}`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
  fileByOther.status === 404 ? ok('ほかの人が上げたファイルは、承認者の役割があっても開けない') : ng(`開けてしまう（${fileByOther.status}）`);

  // 後片付け: 承認待ちの議事録を却下して止める
  const { body: pend } = await call('a', '/v1/approvals', {}, 'admin');
  for (const a of (pend.items ?? [])) {
    const { body: r } = await call('a', `/v1/runs/${minutes}`, {}, 'member');
    if ((r.steps ?? []).some((st) => st.id === a.runStepId)) {
      await call('a', `/v1/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', comment: '閲覧の確認' }) }, 'admin');
    }
  }
}

console.log('\n■ 32. Google から取得したデータの保持（第14.3.2節）');
{
  const setDays = (d, who = 'admin') =>
    call('a', '/v1/admin/settings/privacy', { method: 'PUT', body: JSON.stringify({ googleDataRetentionDays: d }) }, who);
  const tooLong = await setDays(8);
  const member = await setDays(0, 'member');
  tooLong.status === 400 && member.status === 403
    ? ok('残す日数は 7 日より長くできず、管理者だけが変えられる') : ng(`設定の検証が違う（8 日: ${tooLong.status}、一般: ${member.status}）`);

  const saved = await setDays(0);
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'inbox-triage' }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const before = JSON.stringify(done.steps);
  const { body: kbJob } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇の付与日数は' } }) }, 'member');
  await waitFor('a', kbJob.runId, ['completed', 'failed'], 20000, 'member');

  // ワーカーの見回り（開発では 15 秒ごと）を待つ
  let after = null;
  for (let i = 0; i < 40; i++) {
    const { body: r } = await call('a', `/v1/runs/${job.runId}`, {}, 'member');
    if ((r.steps ?? []).some((st) => st.output?.redacted)) { after = r; break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  const toolNames = (after?.steps ?? []).flatMap((st) => (st.output?.tools ?? []).map((t) => t.name));
  saved.status === 200 && after && toolNames.includes('gmail.unread') && after.steps.every((st) => st.input === null)
    && before.length > JSON.stringify(after.steps).length
    ? ok(`日数を 0 にすると、終わった実行の中身を消し、ツール名だけを残す（${[...new Set(toolNames)].join('・')}）`)
    : ng('中身が消えない', JSON.stringify(after?.steps ?? done.steps).slice(0, 200));

  const { body: kb } = await call('a', `/v1/runs/${kbJob.runId}`, {}, 'member');
  (kb.steps ?? []).every((st) => !st.output?.redacted) ? ok('Google のツールを使わない実行（社内ナレッジ Q&A）の中身は消さない') : ng('Google を使わない実行まで消している');

  const { body: audits } = await call('a', '/v1/admin/audit-events');
  !JSON.stringify(audits).includes('見積') ? ok('監査ログにメールの中身は入らない') : ng('監査ログにメールの中身が入っている');
  await setDays(7);
}

console.log('\n■ 33. 許可がなくなったときの業務の扱い（第6.5.2.1節）');
{
  // 一般利用者が、承認待ちの議事録（Google のツールを使う）と、社内ナレッジ Q&A（使わない）を依頼する
  const { body: m } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'minutes', input: { title: '許可の確認', transcript: 'A 案で決定。', space: 'general' } }) }, 'member');
  await waitFor('a', m.runId, ['awaiting_approval', 'failed', 'completed'], 20000, 'member');

  const { body: impact } = await call('a', '/v1/me/google/impact', {}, 'member');
  impact.runs?.some((r) => r.runId === m.runId && r.agentName === '議事録作成・共有')
    ? ok(`取り消す前に、止まる業務を示す（${impact.runs.length} 件、定時実行 ${impact.schedules} 件）`) : ng('止まる業務を示さない', JSON.stringify(impact));
  const { body: clientImpact, status: ciStatus } = await call('a', '/v1/admin/connections/google/impact');
  ciStatus === 200 && typeof clientImpact.users === 'number' ? ok(`OAuth クライアントを消す前に、影響する人数を示す（${clientImpact.users} 人）`) : ng(`影響を示さない（${ciStatus}）`);

  // 利用を停止すると、Google を使う動いている途中の業務が止まる
  const { body: users } = await call('a', '/v1/admin/users');
  const memberId = (users.items ?? users).find((u) => u.email === 'member@alpha.example.jp')?.id;
  const { body: patched } = await call('a', `/v1/admin/users/${memberId}`, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) });
  const { body: after } = await call('a', `/v1/runs/${m.runId}`);
  const { body: tray } = await call('a', '/v1/approvals');
  const stillPending = (tray.items ?? []).some((a) => (after.steps ?? []).some((st) => st.id === a.runStepId));
  await call('a', `/v1/admin/users/${memberId}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
  const { body: notes } = await call('a', '/v1/notifications', {}, 'member');
  after.run?.status === 'cancelled' && /利用が停止/.test(after.run.failureReason ?? '') && !stillPending && patched.stoppedRuns >= 1
    ? ok('利用を停止すると、Google を使う承認待ちの業務を止め、承認トレイから外す') : ng('業務が止まらない', JSON.stringify({ status: after.run?.status, stillPending, stopped: patched.stoppedRuns }));
  (notes.items ?? notes).some((n) => n.title === '業務を止めました' && n.runId === m.runId)
    ? ok('止めたことを依頼した本人に知らせる') : ng('本人に知らせない');
}

console.log('\n■ 34. 会社の利用の停止（第23.8.6節）');
{
  // 状態はマスター管理画面ができるまでデータベースで変える。所有者のロールでつなぐ（アプリのロールは tenants を変えられない）
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const setStatus = (status) => owner.query(`update tenants set status = $1 where subdomain = 'b'`, [status]);

  // 停止の前に、承認の無い業務を 1 つ終えておく（あとで待ち行列に戻して、ワーカーが始めないことを確かめる）
  const { body: qa } = await call('b', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇' } }) });
  await waitFor('b', qa.runId, ['completed', 'failed']);
  try {
    await setStatus('suspended');
    const { status: meStatus, body: me } = await call('b', '/v1/me');
    const { status: runStatus } = await call('b', `/v1/runs/${qa.runId}`);
    meStatus === 200 && me.tenant?.status === 'suspended' && runStatus === 200
      ? ok('通常の停止の間も、画面と業務の結果を閲覧できる') : ng(`閲覧できない（${meStatus}・${runStatus}）`);

    const { status: jobStatus, body: jobBody } = await call('b', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '経費' } }) });
    const { status: apStatus } = await call('b', '/v1/approvals/unknown', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
    const { status: setStatusCode } = await call('b', '/v1/me/settings/notifications', { method: 'PUT', body: JSON.stringify({}) });
    jobStatus === 403 && jobBody.suspended === true && apStatus === 403 && setStatusCode === 403
      ? ok('業務の依頼・承認・設定の変更は、停止中であることを返して断る') : ng(`断らない（依頼 ${jobStatus}・承認 ${apStatus}・設定 ${setStatusCode}）`);
    const { status: outStatus } = await call('b', '/v1/auth/logout', { method: 'POST' });
    outStatus === 200 ? ok('ログアウトは受け付ける') : ng(`ログアウトできない（${outStatus}）`);

    // 待ち行列に戻しても、停止中はワーカーが始めない
    await owner.query(`update runs set status = 'queued', ended_at = null where id = $1`, [qa.runId]);
    await sleep(3000);
    const { body: held } = await call('b', `/v1/runs/${qa.runId}`);
    held.run?.status === 'queued' ? ok('停止中は、待ち行列の業務を始めない') : ng(`始めてしまう（${held.run?.status}）`);

    await setStatus('locked');
    const { status: lockedStatus } = await call('b', '/v1/me');
    lockedStatus === 403 ? ok('緊急停止は、閲覧を含めてすべて断る') : ng(`断らない（${lockedStatus}）`);
  } finally {
    await setStatus('active');
  }
  const resumed = await waitFor('b', qa.runId, ['completed', 'failed']);
  resumed.run?.status === 'completed' ? ok('再開すると、待っていた業務が動く') : ng(`再開しても動かない（${resumed.run?.status}）`);
  await owner.end();
}

console.log('\n■ 35. 通知（画面内のお知らせと、Chat・メールへの控え。第6.5.5節）');
{
  // 依頼した本人（member）が控えを受け取る設定にする
  const settings = { kinds: { brief: true, run: true, approval: true, failure: true }, quietHours: null, channels: { chat: true } };
  await call('a', '/v1/me/settings/notifications', { method: 'PUT', body: JSON.stringify(settings) }, 'member');

  const { body: job } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'minutes', input: { title: '通知の確認', transcript: 'A 案で決定。', space: 'general' } }),
  }, 'member');
  await waitFor('a', job.runId, ['awaiting_approval'], 20000, 'member');

  // 承認待ちになったら、判断できる人（管理者）に承認依頼が届く
  const { body: adminNotes } = await call('a', '/v1/notifications');
  const approval = (adminNotes.items ?? []).find((n) => n.runId === job.runId && n.kind === 'approval');
  approval ? ok(`承認待ちを、判断できる人に知らせる（${approval.title}）`) : ng('承認依頼が届かない');

  // 依頼した本人には、この時点では完了の通知が無い
  const { body: before } = await call('a', '/v1/notifications', {}, 'member');
  (before.items ?? []).every((n) => n.runId !== job.runId || n.kind === 'approval')
    ? ok('依頼した本人には、終わるまで完了を知らせない') : ng('終わる前に完了を知らせている');

  // 承認して最後まで進め、完了の通知と、控えを届けたことを確かめる
  for (let i = 0; i < 2; i++) {
    const a = await approvalFor('a', job.runId);
    if (!a) break;
    await call('a', `/v1/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: null }) });
    await waitFor('a', job.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  }
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  done.run?.status === 'completed' ? ok('承認を通して最後まで進んだ') : ng(`完了しない（${done.run?.status}）`, done.run?.failureReason);

  let finished = null;
  for (let i = 0; i < 40 && !finished?.deliveredAt; i++) {
    const { body: notes } = await call('a', '/v1/notifications', {}, 'member');
    finished = (notes.items ?? []).find((n) => n.runId === job.runId && n.kind === 'run');
    if (!finished?.deliveredAt) await sleep(500);
  }
  finished ? ok(`実行の完了を本人に知らせた（${finished.title}）`) : ng('完了の通知が無い');
  finished?.deliveredAt
    ? ok('Chat とメールへの控えを、ワーカーが届けた（見本の送信口）') : ng('控えが届かない', JSON.stringify(finished));

  // 後片付け: 控えの設定を既定（画面内のみ）に戻す
  await call('a', '/v1/me/settings/notifications', {
    method: 'PUT',
    body: JSON.stringify({ ...settings, channels: { chat: false } }),
  }, 'member');

  // 登録された議事録を消す（以降の確認に影響させない）
  const { body: kb } = await call('a', '/v1/admin/knowledge');
  const registered = (kb.items ?? []).find((k) => k.originRunId === job.runId);
  if (registered) await call('a', `/v1/admin/knowledge/${registered.id}`, { method: 'DELETE' });
}

console.log('\n■ 36. 記憶とデータ（第6.5.4・11.5.1節）');
{
  const who = 'member';
  await call('a', '/v1/me/memories', { method: 'DELETE' }, who);
  await call('a', '/v1/me/settings/memory', { method: 'PUT', body: JSON.stringify({ learning: true, excludes: [] }) }, who);

  const say = async (message) => (await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message }) }, who)).body;
  const remembered = await say('山田さんは経理の担当だと覚えておいて');
  const { body: mine } = await call('a', '/v1/me/memories', {}, who);
  remembered.layer === 'direct' && (mine.items ?? []).some((m) => m.text === '山田さんは経理の担当だ')
    ? ok('「覚えておいて」と頼むと覚える（LLM 不使用）') : ng('覚えない', JSON.stringify(mine));

  // 本人以外には見えない（不変則 I-10）
  const { body: others } = await call('a', '/v1/me/memories', {}, 'admin');
  (others.items ?? []).every((m) => m.text !== '山田さんは経理の担当だ')
    ? ok('ほかの人（管理者）には見えない') : ng('他人の記憶が見えている');

  const credential = await say('社内システムのパスワードは abc123 だと覚えておいて');
  const { body: afterCred } = await call('a', '/v1/me/memories', {}, who);
  /パスワードや鍵/.test(credential.text) && (afterCred.items ?? []).length === 1
    ? ok('認証情報らしきものは覚えない') : ng('認証情報を覚えてしまう', credential.text);

  const excluded = await say('人事評価のことは覚えないで');
  const { body: settings } = await call('a', '/v1/me/settings', {}, who);
  /覚えないようにします/.test(excluded.text) && settings.memory.excludes.includes('人事評価')
    ? ok('「覚えないで」は対象外の言葉として残る') : ng('対象外にならない', JSON.stringify(settings.memory));

  await say('人事評価は 3 月だと覚えておいて');
  const { body: afterExclude } = await call('a', '/v1/me/memories', {}, who);
  (afterExclude.items ?? []).length === 1 ? ok('対象外の言葉を含む指示は覚えない') : ng('覚えてしまう');

  const asked = await say('私について何を覚えてる？');
  /1 件/.test(asked.text) ? ok('覚えていることを秘書が答える') : ng('答えない', asked.text);

  const target = (afterExclude.items ?? [])[0];
  await call('a', `/v1/me/memories/${target.id}`, { method: 'DELETE' }, who);
  const { body: afterDelete } = await call('a', '/v1/me/memories', {}, who);
  (afterDelete.items ?? []).length === 0 ? ok('個別に消せる') : ng('消えない');

  // 後片付け: 対象外の指定を戻す
  await call('a', '/v1/me/settings/memory', { method: 'PUT', body: JSON.stringify({ learning: true, excludes: [] }) }, who);
  const { body: audits } = await call('a', '/v1/admin/audit-events');
  const created = (audits.items ?? []).find((e) => e.action === 'memory.create');
  created && !JSON.stringify(created).includes('山田')
    ? ok('監査ログに操作は残り、記憶の中身は残らない') : ng('監査ログの扱いが規定と違う', JSON.stringify(created ?? null));
}

console.log('\n■ 37. ダッシュボードの人の状態と SSE（第6.7.4.1・6.7.9節）');
{
  const { body: live } = await call('a', '/v1/admin/dashboard/live');
  const me = (live.people ?? []).find((p) => p.userId.endsWith('admin'));
  Array.isArray(live.people) && me?.name && me.state
    ? ok(`人の状態を個人名で返す（既定。${live.people.length} 人、${me.name}さんは「${me.detail}」）`)
    : ng('人の状態が返らない', JSON.stringify(live.people ?? null));
  // 状態に持たせてよい項目だけであること（中身の項目が紛れていない）
  // 本人と秘書の 1 組（第6.7.4.4節）の項目を含む。秘書の側も状態・名前・アバターまで
  const allowed = ['userId', 'name', 'state', 'detail', 'agentName', 'route', 'device', 'self', 'secretary', 'photo'];
  const secretaryAllowed = ['state', 'detail', 'busy', 'name', 'avatar'];
  (live.people ?? []).every((p) => Object.keys(p).every((k) => allowed.includes(k))
    && Object.keys(p.secretary ?? {}).every((k) => secretaryAllowed.includes(k)))
    ? ok('状態・業務の名前までで、会話や入力の中身の項目を持たない')
    : ng('余分な項目がある', JSON.stringify(Object.keys((live.people ?? [])[0] ?? {})));

  // SSE。変化があると送られてくる（依頼を出して確かめる）
  const controller = new AbortController();
  const received = [];
  const stream = (async () => {
    const res = await fetch(`${API}/v1/admin/dashboard/stream`, {
      headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`受け取れない (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const data = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (data) received.push(JSON.parse(data.slice('data: '.length)));
      }
    }
  })().catch((e) => { if (!controller.signal.aborted) ng('SSE が切れた', e.message); });

  await sleep(500);
  const { body: qa } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇' } }) });
  await waitFor('a', qa.runId, ['completed', 'failed']);
  for (let i = 0; i < 20 && received.length === 0; i++) await sleep(500);
  controller.abort();
  await stream;

  received.length > 0
    ? ok(`変化があると SSE で届く（${received.length} 回）`) : ng('SSE で届かない');
  received.some((r) => Array.isArray(r.people))
    ? ok('SSE でも人の状態を送る') : ng('SSE に人の状態が無い');

  // 粒度を「人数と業務だけ」に変えると、名前を出さない
  await call('a', '/v1/admin/settings/dashboard', { method: 'PUT', body: JSON.stringify({ people: 'counts' }) });
  const { body: counts } = await call('a', '/v1/admin/dashboard/live');
  counts.people === null && counts.peopleSummary && !JSON.stringify(counts.peopleSummary).includes('管理者')
    ? ok('「人数と業務だけ」にすると、誰かを示さない') : ng('名前が出ている', JSON.stringify(counts.peopleSummary ?? null));
  await call('a', '/v1/admin/settings/dashboard', { method: 'PUT', body: JSON.stringify({ people: 'names' }) });

  // 本人は自分の見え方を確かめられる（第6.7.10節 規定 4）
  const { body: mine } = await call('a', '/v1/me/presence', {}, 'member');
  mine.presence?.userId && mine.presence.detail
    ? ok(`本人は自分の見え方を確かめられる（「${mine.presence.detail}」）`) : ng('自分の見え方が分からない', JSON.stringify(mine));
  (mine.hidden ?? []).some((x) => x.includes('会話の中身'))
    ? ok('表示されないものを本人に示す') : ng('示さない');
}

console.log('\n■ 38. 会話ログ（第11.9.4.1節）');
{
  const who = 'member';
  await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
  const say = async (message) => (await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message }) }, who)).body;

  // 依頼した人を見分けられるよう、この確認だけの言い方にする
  const mark = '会話ログの確認です。承認待ちある？';
  await say(mark);
  const { body: mine } = await call('a', '/v1/me/conversations', {}, who);
  (mine.items ?? []).some((c) => c.message === mark && c.reply && c.layer === 'direct')
    ? ok('秘書とのやり取りを 1 往復ずつ残す') : ng('残らない', JSON.stringify(mine.items ?? []).slice(0, 150));

  // 本人以外には見えない（不変則 I-10）
  const { body: admin } = await call('a', '/v1/me/conversations', {}, 'admin');
  (admin.items ?? []).every((c) => c.message !== mark)
    ? ok('ほかの人（管理者）には見えない') : ng('他人の会話が見えている');

  await say('経費の規程を教えて');
  const { body: found } = await call('a', '/v1/me/conversations?q=経費', {}, who);
  (found.items ?? []).length === 1 && found.items[0].message.includes('経費')
    ? ok('言葉で探せる') : ng('探せない', String((found.items ?? []).length));

  const target = (found.items ?? [])[0];
  await call('a', `/v1/me/conversations/${target.id}`, { method: 'DELETE' }, who);
  const { body: afterDelete } = await call('a', '/v1/me/conversations?q=経費', {}, who);
  (afterDelete.items ?? []).length === 0 ? ok('1 件ずつ消せる') : ng('消えない');

  const forgotten = await say('この会話は残さないで');
  const { body: afterForget } = await call('a', '/v1/me/conversations', {}, who);
  /直近 1 時間の会話を消しました/.test(forgotten.text) && (afterForget.items ?? []).length === 0
    ? ok('「この会話は残さないで」で直近 1 時間を消す') : ng('消えない', forgotten.text);

  // 「会話を残す」を切ると 1 件も残らない
  const settings = { learning: true, excludes: [], keepConversations: false };
  await call('a', '/v1/me/settings/memory', { method: 'PUT', body: JSON.stringify(settings) }, who);
  await say('今日の予定は？');
  const { body: off } = await call('a', '/v1/me/conversations', {}, who);
  (off.items ?? []).length === 0 ? ok('「会話を残す」を切ると残らない') : ng('残ってしまう');
  await call('a', '/v1/me/settings/memory', { method: 'PUT', body: JSON.stringify({ ...settings, keepConversations: true }) }, who);

  const { body: audits } = await call('a', '/v1/admin/audit-events');
  const cleared = (audits.items ?? []).find((e) => e.action === 'conversation.clear');
  cleared && !JSON.stringify(cleared).includes('承認待ちある')
    ? ok('監査ログに操作は残り、会話の中身は残らない') : ng('監査ログの扱いが規定と違う', JSON.stringify(cleared ?? null));
  await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
}

console.log('\n■ 39. 対話からの学習（第11.5.2節。本人が候補を採る形は第 0.114.0 版でやめた）');
{
  // 覚えるのはワーカーが 1 日 1 回自分で行う（ADR-0027）。本人に候補を採らせる口は無い
  const list = await call('a', '/v1/me/memory-candidates', {}, 'member');
  const accept = await call('a', '/v1/me/memory-candidates/x/accept', { method: 'POST', body: '{}' }, 'member');
  list.status === 404 && accept.status === 404 ? ok('記憶の候補を本人に採らせる API は無い（404）') : ng(`候補の API が残っている（${list.status}・${accept.status}）`);
}

console.log('\n■ 40. 昇華（秘書が判断して会社の知識にする。第11.3節、ADR-0028）');
{
  const who = 'member';
  // 二重の承認の API は無い
  const promote = await call('a', '/v1/me/memories/x/promote', { method: 'POST', body: '{}' }, who);
  const pendingList = await call('a', '/v1/admin/promotions');
  const decide = await call('a', '/v1/admin/promotions/x', { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
  [promote.status, pendingList.status, decide.status].every((x) => x === 404)
    ? ok('本人が出す・管理者が承認する API は無い（404）') : ng('昇華の承認の API が残っている', [promote.status, pendingList.status, decide.status].join(','));

  // 秘書が会社の知識にしたものは、本人が履歴で見られる（ほかの人には見えない）
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  try {
    const { rows: [u] } = await owner.query(`select id, tenant_id from users where email = 'member@alpha.example.jp'`);
    await owner.query(`delete from promotions where id = 'smoke-promo-1'`);
    await owner.query(
      `insert into promotions (id, tenant_id, user_id, text, status, decided_at) values ('smoke-promo-1', $1, $2, $3, 'approved', now())`,
      [u.tenant_id, u.id, '経費の精算は佐藤さんに出す（確認用）']);
    const { body: mine } = await call('a', '/v1/me/promotions', {}, who);
    const { body: others } = await call('a', '/v1/me/promotions', {}, 'admin');
    (mine.items ?? []).some((p) => p.id === 'smoke-promo-1' && p.status === 'approved')
      ? ok('本人は、自分の記憶から会社の知識になったものを見られる') : ng('履歴が見えない');
    (others.items ?? []).every((p) => p.id !== 'smoke-promo-1')
      ? ok('ほかの人の履歴は見えない') : ng('他人の履歴が見える');
  } finally {
    await owner.query(`delete from promotions where id = 'smoke-promo-1'`);
    await owner.end();
  }
}

console.log('\n■ 41. 帳票の PDF（第9.4.1節、Q-59・Q-57）');
{
  // 会社の帳票の体裁を設定しておく（第15.2.2節）
  await call('a', '/v1/admin/settings/invoice', {
    method: 'PUT',
    body: JSON.stringify({
      logoFileId: null, bankAccount: '○○銀行 △△支店 普通 1234567',
      paymentDue: '翌月末', notes: '振込手数料は貴社にてご負担ください', sealBox: true,
    }),
  });

  // 公式の業務はまだ pdf.render を使わないため、見本の応答つきの小さな拡張機能で通しで確かめる
  const EXT = 'jp.example.invoice-draft';
  const AG = `${EXT}:invoice`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });

  const bytes = await skillZip({
    id: EXT, name: 'invoice', title: '請求書の下書き', author: 'サンプル株式会社', description: '明細から請求書の PDF を作る（送信しない）',
    tools: ['pdf.render'], inputs: ['to: 短文'], input: { to: '株式会社アルファ 御中' },
    body: 'pdf.render で請求書を作る。送信しない。',
    stub: {
      work: [{
        name: 'pdf.render',
        args: {
          title: '請求書', to: '株式会社アルファ 御中', from: ['M2ホールディングス株式会社'],
          fields: [{ label: '発行日', value: '2026-09-23' }],
          rows: [{ name: '月額利用料（9 月分）', quantity: 10, unitPrice: 3000 }],
          notes: ['お支払い期限: 2026-10-31'],
        },
      }],
    },
  });

  const imported = await call('a', '/v1/admin/extensions/import', {
    method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' },
  });
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });

  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { to: '株式会社アルファ 御中' } }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const artifact = done.artifacts?.[0];
  imported.status === 200 && done.run?.status === 'completed' && artifact?.kind === 'file:pdf'
    ? ok(`帳票の PDF を作れた（${artifact.body}）`) : ng('PDF を作れない', JSON.stringify(done.run ?? imported.body));

  // 取り出して、日本語が入っていることを確かめる
  if (artifact?.fileId) {
    const res = await fetch(`${API}/v1/files/${artifact.fileId}/content`, {
      headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' },
    });
    const pdf = new Uint8Array(await res.arrayBuffer());
    const head = new TextDecoder().decode(pdf.slice(0, 5));
    // 読み返しは pdf.js を直接使う（この確認は素の JavaScript で動かすため）
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false, disableFontFace: true }).promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
    // 書体はそのまま埋め込む（使った字だけを抜き出すと字の形が落ちた。文字の取り出しでは気づけない。ADR-0017 の改め）
    head === '%PDF-' && text.includes('請求書') && text.includes('株式会社アルファ 御中') && pdf.length < 5_000_000
      ? ok(`取り出した PDF から日本語を読み返せる（${Math.ceil(pdf.length / 1024)} KB）`)
      : ng('読み返せない', `${head} ${text.slice(0, 60)}`);
    text.includes('お振込先: ○○銀行') && text.includes('振込手数料は貴社にてご負担ください') && text.includes('印')
      ? ok('会社の帳票の体裁（振込先・備考の定型文・印の欄）が帳票に出る')
      : ng('体裁が出ない', text.slice(0, 160));
  }

  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  // 後片付け: 帳票の体裁を戻す
  await call('a', '/v1/admin/settings/invoice', {
    method: 'PUT',
    body: JSON.stringify({ logoFileId: null, bankAccount: '', paymentDue: '', notes: '', sealBox: false }),
  });
}

console.log('\n■ 42. 音声の対話（第10.5.5節）');
{
  const who = 'member';
  await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
  // 前の節で終わった調べものは、つないだ時点で持ち越して伝わる（第10.11.7節）。
  // ここで確かめたいのは声と話し方なので、先に受け取っておく
  await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, who);
  // 声と話し方の指示を選ぶ（第10.5.6節）。知らない声は受け付けない
  const { body: settings } = await call('a', '/v1/me/settings', {}, who);
  await call('a', '/v1/me/settings/secretary', {
    method: 'PUT',
    body: JSON.stringify({ ...settings.secretary, speak: true, voice: 'Charon', voiceStyle: '関西弁で話して' }),
  }, who);
  await call('a', '/v1/me/settings/secretary', {
    method: 'PUT',
    body: JSON.stringify({ ...settings.secretary, speak: true, voice: 'にせものの声', voiceStyle: '関西弁で話して' }),
  }, who);
  const { body: saved } = await call('a', '/v1/me/settings', {}, who);
  saved.secretary.voice === '' && saved.secretary.voiceStyle === '関西弁で話して'
    ? ok('声は一覧にあるものだけを受け付け、話し方の指示は残る') : ng('設定の扱いが違う', JSON.stringify(saved.secretary));
  await call('a', '/v1/me/settings/secretary', {
    method: 'PUT',
    body: JSON.stringify({ ...settings.secretary, speak: true, voice: 'Charon', voiceStyle: '関西弁で話して' }),
  }, who);

  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${API.replace('http', 'ws')}/v1/secretary/voice`, {
    headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' },
  });
  const messages = [];
  let binary = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) { binary++; return; }
    messages.push(JSON.parse(data.toString('utf8')));
  });
  const closed = new Promise((resolve) => ws.on('close', resolve));
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
  });
  opened ? ok('ログイン状態で音声の中継につながる') : ng('つながらない');

  for (let i = 0; i < 40 && !messages.some((m) => m.type === 'ready'); i++) await sleep(50);
  const ready = messages.find((m) => m.type === 'ready');
  ready?.provider === 'mock'
    ? ok('鍵が無い環境では見本の相手につなぐ（それらしい音声を作らない）') : ng('見本にならない', JSON.stringify(ready ?? null));

  // つないだ時点で、秘書から第一声がある（第6.1.4節）
  for (let i = 0; i < 60 && !messages.some((m) => m.type === 'reply'); i++) await sleep(50);
  /内部の指示を受け取りました/.test(messages.find((m) => m.type === 'reply')?.text ?? '')
    ? ok('つないだ時点で、秘書から先に声をかける') : ng('第一声が無い', JSON.stringify(messages));
  const before = messages.length;

  // マイクの音を送ると、聞こえた内容と応答が文字で返る（併記）
  ws.send(Buffer.alloc(320), { binary: true });
  for (let i = 0; i < 60 && !messages.slice(before).some((m) => m.type === 'reply'); i++) await sleep(50);
  const after = messages.slice(before);
  const heard = after.find((m) => m.type === 'heard');
  const reply = after.find((m) => m.type === 'reply');
  heard && reply ? ok('聞こえた内容と応答が文字でも返る（併記）') : ng('文字が返らない', JSON.stringify(after));
  /声「Charon」と話し方の指示を受け取りました/.test(reply?.text ?? '')
    ? ok('選んだ声と話し方の指示が提供者へ渡る') : ng('渡らない', reply?.text ?? '');
  binary === 0 ? ok('見本では音声を返さない') : ng(`音声が返る（${binary}）`);

  ws.close();
  await closed;
  await sleep(500);

  // 終わったら会話ログに 1 往復だけ残り、録音は残らない
  const { body: logs } = await call('a', '/v1/me/conversations', {}, who);
  const item = (logs.items ?? [])[0];
  (logs.items ?? []).length === 1 && item.reply.includes('見本の応答')
    ? ok('音声の対話が会話ログに 1 往復として残る') : ng('残らない', JSON.stringify(logs.items ?? []));
  // 第一声だけで終わったときに「聞き取れませんでした」と書かない（第6.1.4節）
  !/聞き取れませんでした/.test(item?.message ?? '')
    ? ok('第一声を、聞き取れなかったこととして残さない') : ng('聞き取れなかったことにしている', item?.message ?? '');

  const { body: audits } = await call('a', '/v1/admin/audit-events');
  const voiceAudit = (audits.items ?? []).filter((e) => e.action === 'secretary.voice');
  voiceAudit.length >= 2 && !JSON.stringify(voiceAudit).includes('見本の応答')
    ? ok('監査ログに開始と終了だけが残る（話した中身は残らない）') : ng('監査ログの扱いが規定と違う', JSON.stringify(voiceAudit));

  await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
  // 後片付け: 声と話し方の指示を戻す
  await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify(settings.secretary) }, who);

  // 停止中の会社では開けない（第23.8.6節）
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  try {
    await owner.query(`update tenants set status = 'suspended' where subdomain = 'b'`);
    const blocked = new WebSocket(`${API.replace('http', 'ws')}/v1/secretary/voice`, {
      headers: { 'x-tenant': 'b', 'x-user': 'member@beta.example.jp' },
    });
    const refused = await new Promise((resolve) => {
      blocked.on('open', () => resolve(false));
      blocked.on('error', () => resolve(true));
    });
    refused ? ok('停止中の会社では音声を開けない') : ng('開けてしまう');
    try { blocked.close(); } catch { /* 開いていない */ }
  } finally {
    await owner.query(`update tenants set status = 'active' where subdomain = 'b'`);
    await owner.end();
  }

  // 開いた直後に送った音を捨てない（第10.5.5節）。
  // 画面はつながった時点から音を送り始める。相手を開くまでの待ちの間に届いた分を
  // 捨てると、話し始めのひと言が欠ける。登録の順を誤って API ごと落とした（2026-09-24）
  {
    const early = new WebSocket(`${API.replace('http', 'ws')}/v1/secretary/voice`, {
      headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' },
    });
    const got = [];
    early.on('message', (data, isBinary) => { if (!isBinary) got.push(JSON.parse(data.toString('utf8'))); });
    // 待たずに、つながったその場で送る
    early.on('open', () => early.send(Buffer.alloc(320), { binary: true }));
    const gone = new Promise((resolve) => early.on('close', resolve));
    for (let i = 0; i < 80 && !got.some((m) => m.type === 'heard'); i++) await sleep(50);
    got.some((m) => m.type === 'heard')
      ? ok('開いた直後に送った音も届く（話し始めが欠けない）') : ng('開始直後の音が捨てられる', JSON.stringify(got));
    early.close();
    await gone;
    await sleep(300);
    await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
  }
}

console.log('\n■ 43. 実行の中止と、知識の登録（第9.3.1節、第13.3節・ADR-0019）');
{
  // 承認で止まる業務を作り、承認待ちのまま止める
  const { body: started } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({
      agentId: 'minutes', origin: 'menu',
      input: { title: '中止の確認', attendees: '三浦', meetingId: 'm-smoke-cancel' },
    }),
  });
  const runId = started.runId;
  const before = await waitFor('a', runId, ['awaiting_approval', 'completed', 'failed']);
  before.run.status === 'awaiting_approval'
    ? ok('承認待ちで止まった') : ng(`承認待ちにならない（${before.run.status}）`, before.run.failureReason);
  // 止める前に、この実行の承認を控えておく（承認トレイには他の実行の分も並ぶ）
  const pending = await approvalFor('a', runId);
  pending ? ok('承認トレイに載っている') : ng('承認が見つからない');

  // 依頼していない人は止められない（第9.3.1節）
  const other = await call('a', `/v1/runs/${runId}/cancel`, { method: 'POST' }, 'member');
  other.status === 404 || other.status === 403
    ? ok(`依頼していない人は止められない（${other.status}）`) : ng(`止められてしまう（${other.status}）`);

  const { status, body: cancelled } = await call('a', `/v1/runs/${runId}/cancel`, { method: 'POST' });
  status === 200 ? ok('依頼した本人が止められる') : ng(`止められない（${status}）`, JSON.stringify(cancelled));
  Array.isArray(cancelled.leftoverLinks)
    ? ok('作りかけの文書のリンクを返す') : ng('リンクを返さない', JSON.stringify(cancelled));

  const { body: after } = await call('a', `/v1/runs/${runId}`);
  after.run.status === 'cancelled' && after.run.failureReason === '依頼した人が止めました'
    ? ok('状態が「中止」になり、理由が残る') : ng('中止になっていない', JSON.stringify(after.run));

  // 控えておいた承認が、承認トレイから外れている
  const { body: tray } = await call('a', '/v1/approvals');
  pending && !(tray.items ?? []).some((a) => a.id === pending.id)
    ? ok('承認トレイから外れる') : ng('承認が残っている', pending?.id);

  // 監査ログに残る
  const { body: audits } = await call('a', '/v1/admin/audit-events');
  (audits.items ?? []).some((e) => e.action === 'run.cancel' && e.targetId === runId && e.actorType === 'user')
    ? ok('監査ログに run.cancel が残る（止めた人つき）') : ng('監査ログに残らない');

  // 終わった実行は止められない
  const again = await call('a', `/v1/runs/${runId}/cancel`, { method: 'POST' });
  again.status === 409 ? ok('終わった実行は止められない（409）') : ng(`止められてしまう（${again.status}）`);

  // 知識の登録は ID を発行する（ADR-0019 決定 6）
  const { status: created, body: k } = await call('a', '/v1/admin/knowledge', {
    method: 'POST',
    body: JSON.stringify({ kind: 'rule', title: '通しの確認で作った規程', body: '第1条 これは確認用である。' }),
  });
  created === 201 && typeof k.id === 'string' && k.id.startsWith('k-')
    ? ok(`知識を登録すると ID が発行される（${k.id}）`) : ng(`発行されない（${created}）`, JSON.stringify(k));
  (k.sections ?? []).length > 0
    ? ok('登録と同時に節へ分ける') : ng('節に分かれない', JSON.stringify(k.sections ?? []));
  await call('a', `/v1/admin/knowledge/${k.id}`, { method: 'DELETE' });
}

console.log('\n■ 44. 秘書にファイルを渡す（第10.10節）');
{
  const upload = async (name, bytes, who = 'member') => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    const res = await fetch(`${API}/v1/files`, {
      method: 'POST', body: form,
      headers: { 'x-tenant': 'a', 'x-user': `${who}@alpha.example.jp` },
    });
    return { status: res.status, body: await res.json() };
  };
  const csv = new TextEncoder().encode('品目,金額\nりんご,100\nみかん,200\n');
  const up = await upload('売上.csv', csv);
  up.status === 201 ? ok('秘書に渡すファイルを受け取れる') : ng(`受け取れない（${up.status}）`, JSON.stringify(up.body));
  const fileId = up.body.id;

  // ファイルが付いていれば、応答の中では読まず後ろへ回す（第10.11.3節）
  const asked = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: 'この表の品目を挙げて', fileId }),
  }, 'member');
  asked.body.lookup?.runId
    ? ok('ファイルが付くと、調べものとして後ろへ回す') : ng('後ろへ回らない', JSON.stringify(asked.body));
  // 受け付けの返事に結果を混ぜない（第10.11.5節）
  asked.body.tokensUsed === 0 && /お預かりしました/.test(asked.body.text ?? '')
    ? ok('受け付けの返事だけを返す（結果を混ぜない）') : ng('結果を混ぜている', asked.body.text ?? '');
  asked.body.elapsedMs < 3000
    ? ok(`応答が速い（${asked.body.elapsedMs}ms。会話を止めない）`) : ng(`遅い（${asked.body.elapsedMs}ms）`);

  // 同じ依頼は二度起こさない（第10.11.4節）。終わる前に確かめる
  const again2 = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: 'この表の品目を挙げて', fileId }),
  }, 'member');
  again2.body.lookup?.runId === asked.body.lookup.runId
    ? ok('同じ依頼は新しく起こさない') : ng('二重に起こす', JSON.stringify(again2.body.lookup ?? null));

  // 処理中であることが分かる（第10.11.6節）
  const { body: mid } = await call('a', '/v1/secretary/lookups', {}, 'member');
  (mid.items ?? []).some((x) => x.runId === asked.body.lookup.runId && x.progress)
    ? ok('処理中であることを、進み具合つきで返す') : ng('処理中が分からない', JSON.stringify(mid.items ?? []));

  // 終わると答えが返る
  const done = await waitFor('a', asked.body.lookup.runId, ['completed', 'failed'], 30000, 'member');
  done.run.status === 'completed' ? ok('調べものが完了する') : ng(`完了しない（${done.run.status}）`, done.run.failureReason);
  const { body: after } = await call('a', '/v1/secretary/lookups', {}, 'member');
  const finished = (after.items ?? []).find((x) => x.runId === asked.body.lookup.runId);
  finished?.text && finished.progress === null
    ? ok('終わると答えが返り、進み具合は消える') : ng('答えが返らない', JSON.stringify(finished ?? null));

  // 調べものは読むだけ。送信・登録の道具を持たない（第10.11.4節）
  const { body: agentList } = await call('a', '/v1/agents', {}, 'member');
  const lookup = (agentList.agents ?? []).find((x) => x.id === 'secretary-lookup');
  lookup && !lookup.hasApproval
    ? ok('調べものは承認を持たない（読むだけ）') : ng('承認を持つ、または見つからない', JSON.stringify(lookup ?? null));

  // 他人のファイルは読まない（第9.4.1節）。ここではまだ実行に紐づいていない
  const theirs = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: 'これを読んで', fileId }),
  }, 'admin');
  /見つかりませんでした/.test(theirs.body.text ?? '') && !theirs.body.lookup
    ? ok('他人のファイルは読まず、存在も示さない') : ng('他人のファイルを読んでしまう', theirs.body.text ?? '');

  // 監査ログに残る
  const { body: audits } = await call('a', '/v1/admin/audit-events');
  (audits.items ?? []).some((e) => e.action === 'secretary.file' && e.targetId === fileId)
    ? ok('監査ログに secretary.file が残る') : ng('監査ログに残らない');

  // ファイルを受け取れる業務があれば、取次を提案する（勝手に始めない。第10.11.4節）
  const routed = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: 'この記録から議事録を作って', fileId }),
  }, 'member');
  routed.body.suggestedAgent?.id === 'minutes' && !routed.body.lookup && /会議名が要ります/.test(routed.body.text)
    ? ok('必須の入力（会議名）が埋められなければ、それを聞いて業務を開くボタンを添える（始めない）') : ng('足りない入力を聞かない、または取り次がない', JSON.stringify(routed.body));

  // ファイルを受け取れる業務へ渡すと、その実行のものになる（4 週の入れ替えで消さない）
  const { body: job } = await call('a', '/v1/jobs', {
    method: 'POST',
    body: JSON.stringify({ agentId: 'minutes', input: { title: 'ファイルからの議事録', fileId } }),
  }, 'member');
  const run = await waitFor('a', job.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  run.run.status === 'awaiting_approval'
    ? ok('渡したファイルから議事録を作り、承認待ちになる') : ng(`進まない（${run.run.status}）`, run.run.failureReason);
  const fetched = run.steps?.find((s) => s.stepId === 'fetch');
  (fetched?.output?.tools ?? []).some((t) => t.name === 'file.read_text')
    ? ok('取得の段で file.read_text を使う') : ng('ファイルを読んでいない', JSON.stringify(fetched?.output?.tools ?? []));
  // 読んだ中身が成果物まで届く（読むだけで終わらない）
  const body = run.artifacts?.[0]?.body ?? '';
  /りんご/.test(body) && /みかん/.test(body)
    ? ok('読んだ中身が議事録の成果物に入る') : ng('中身が届いていない', body.slice(0, 200));

  // 判断できる承認がある人は、依頼に使われたファイルを見られるようになる（第6.2.1節）
  const byApprover = await call('a', `/v1/files/${fileId}`, {}, 'admin');
  byApprover.status === 200
    ? ok('判断する承認がある人は、依頼に使われたファイルを見られる') : ng(`見られない（${byApprover.status}）`);

  await call('a', `/v1/runs/${job.runId}/cancel`, { method: 'POST' }, 'member');
}

console.log('\n■ 45. 音声の最中に、調べものの結果を伝える（第10.11.7節）');
{
  const who = 'member';
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`${API.replace('http', 'ws')}/v1/secretary/voice`, {
    headers: { 'x-tenant': 'a', 'x-user': `${who}@alpha.example.jp` },
  });
  const messages = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { messages.push(JSON.parse(data.toString('utf8'))); } catch { /* 読めない形は無視 */ }
  });
  const opened = await new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
  });
  opened ? ok('音声の対話を開ける') : ng('開けない');
  await sleep(600);

  const before = messages.filter((m) => m.type === 'reply').length;

  // 音声をつないだまま、ファイルを渡して調べものを起こす
  const form = new FormData();
  form.append('file', new Blob([new TextEncoder().encode('部署,人数\n営業,3\n')]), '名簿.csv');
  const up = await fetch(`${API}/v1/files`, {
    method: 'POST', body: form,
    headers: { 'x-tenant': 'a', 'x-user': `${who}@alpha.example.jp` },
  }).then((r) => r.json());
  const asked = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: '名簿の部署を教えて', fileId: up.id }),
  }, who);
  asked.body.lookup?.runId ? ok('音声をつないだまま、調べものを起こせる') : ng('起こせない', JSON.stringify(asked.body));

  // 終わるのを待ち、そのあと中継が見に行く間隔（3 秒）を足して待つ
  await waitFor('a', asked.body.lookup.runId, ['completed', 'failed'], 30000, who);
  await sleep(4500);

  const after = messages.filter((m) => m.type === 'reply');
  after.length > before
    ? ok('終わると、音声の側にも秘書の応答として届く') : ng('届かない', JSON.stringify(messages.slice(-3)));
  // 内部の指示は、利用者が話したこととして扱わない
  const heard = messages.filter((m) => m.type === 'heard').map((m) => m.text).join('');
  !/内部情報/.test(heard)
    ? ok('内部の指示を、聞こえた内容として出さない') : ng('内部の指示が聞こえた内容に出る', heard.slice(0, 120));

  ws.close();
  await sleep(400);
  await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
}

console.log('\n■ 46. 会話していない間に終わったものの持ち越し（第10.11.7節）');
{
  const who = 'member';
  // 画面も音声も開いていない状態で、調べものを起こして終わらせる
  const form = new FormData();
  form.append('file', new Blob([new TextEncoder().encode('区分,件数\n新規,7\n')]), '持ち越し.csv');
  const up = await fetch(`${API}/v1/files`, {
    method: 'POST', body: form,
    headers: { 'x-tenant': 'a', 'x-user': `${who}@alpha.example.jp` },
  }).then((r) => r.json());
  const asked = await call('a', '/v1/secretary', {
    method: 'POST', body: JSON.stringify({ message: '持ち越しの確認', fileId: up.id }),
  }, who);
  const runId = asked.body.lookup?.runId;
  runId ? ok('調べものを起こせる') : ng('起こせない', JSON.stringify(asked.body));
  await waitFor('a', runId, ['completed', 'failed'], 30000, who);

  // 伝える前は「まだ伝えていない」
  const { body: pending } = await call('a', '/v1/secretary/lookups', {}, who);
  (pending.items ?? []).find((x) => x.runId === runId)?.told === false
    ? ok('伝える前は、まだ伝えていないと分かる') : ng('状態が違う', JSON.stringify((pending.items ?? [])[0] ?? null));

  // 次に会話が始まったときに、一度だけ伝わる
  const first = await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, who);
  (first.body.items ?? []).some((x) => x.runId === runId)
    ? ok('次に会話が始まったときに持ち越して伝える') : ng('持ち越されない', JSON.stringify(first.body.items ?? []));

  const second = await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, who);
  !(second.body.items ?? []).some((x) => x.runId === runId)
    ? ok('二度目は伝えない（開き直しても繰り返さない）') : ng('二度伝える');

  const { body: after } = await call('a', '/v1/secretary/lookups', {}, who);
  (after.items ?? []).find((x) => x.runId === runId)?.told === true
    ? ok('伝えたことが記録される') : ng('記録されない');

  // 他人の調べものは受け取れない（不変則 I-9）
  const theirs = await call('a', '/v1/secretary/lookups', {}, 'admin');
  !(theirs.items ?? []).some((x) => x.runId === runId)
    ? ok('他人の調べものは見えない') : ng('他人の調べものが見える');
}

console.log('\n■ 47. Google ログインの経路（第16.1.2節）');
{
  // 引換券は、このホストでしか使えない。でたらめな券では入れない
  const bad = await fetch(`${API}/v1/auth/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'a' },
    body: JSON.stringify({ ticket: 'でたらめな券' }),
  });
  bad.status === 401 ? ok('知らない引換券では入れない（401）') : ng(`入れてしまう（${bad.status}）`);

  const empty = await fetch(`${API}/v1/auth/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant': 'a' },
    body: JSON.stringify({}),
  });
  empty.status === 401 ? ok('券が無ければ入れない（401）') : ng(`入れてしまう（${empty.status}）`);

  // 運営のクライアントが未設定なら、始められないことを正直に返す
  const start = await fetch(`${API}/v1/auth/google/start`, { headers: { 'x-tenant': 'a' } });
  const startBody = await start.json();
  (start.status === 503 && /準備中/.test(startBody.error ?? ''))
    || (start.status === 200 && /^https:\/\/accounts\.google\.com\//.test(startBody.url ?? ''))
    ? ok(`ログインの開始が筋の通った応答を返す（${start.status}）`) : ng('応答が違う', JSON.stringify(startBody));

  // 運営のホストでの戻りは、テナントの判定より前に受ける。知らない state は断る
  const cb = await fetch(`${API}/v1/oauth/google/login-callback?state=unknown&code=x`);
  cb.status === 400 ? ok('知らない state の戻りは断る（400）') : ng(`断らない（${cb.status}）`);

  // 使える手段の一覧に、テナントの名前が入る
  const { body: providers } = await call('a', '/v1/auth/providers');
  providers.tenant?.subdomain === 'a' && typeof providers.google?.enabled === 'boolean'
    ? ok('使えるログイン手段を返す') : ng('返らない', JSON.stringify(providers));
}

console.log('\n■ 48. 管理者の実行の一覧は、状態だけを返す（第6.6.8節、不変則 I-10）');
{
  const { status, body } = await call('a', '/v1/admin/runs');
  status === 200 && Array.isArray(body.items) && body.items.length > 0
    ? ok(`実行の一覧を返す（${body.items.length} 件）`) : ng(`取れない（${status}）`);

  const listText = JSON.stringify(body);
  !listText.includes('"input"') && !listText.includes('"artifacts"') && !listText.includes('"output"')
    ? ok('一覧に、入力・出力・成果物を含まない') : ng('中身が含まれている');

  // その場で開くための 1 件の状態（第6.2.4節）。**中身は返らない**
  const one = body.items[0];
  const { status: st, body: detail } = await call('a', `/v1/admin/runs/${one.id}`);
  st === 200 && Array.isArray(detail.steps)
    ? ok(`1 件の状態を返す（段 ${detail.steps.length} 件）`) : ng(`取れない（${st}）`);
  (detail.steps ?? []).every((x) => x.label && x.status && !('input' in x) && !('output' in x))
    ? ok('段は表示名と状態だけで、入力と出力を持たない') : ng('段に中身がある', JSON.stringify(detail.steps?.[0] ?? null));
  typeof detail.costJpy === 'number' && 'savedMinutes' in detail && 'failureReason' in detail
    ? ok('費用・削減時間・失敗の理由は返る') : ng('状態が足りない', JSON.stringify(detail).slice(0, 160));
  const text = JSON.stringify(detail);
  !text.includes('"artifacts"') && !text.includes('"body"') && !/"input"\s*:/.test(text)
    ? ok('入力・成果物・本文は返らない') : ng('中身が漏れている', text.slice(0, 200));

  // 一般の利用者は見られない
  const member = await call('a', `/v1/admin/runs/${one.id}`, {}, 'member');
  member.status === 403 ? ok('一般利用者は見られない（403）') : ng(`見えてしまう（${member.status}）`);

  // 他の会社の実行は、存在も示さない（不変則 I-2）
  const other = await call('b', `/v1/admin/runs/${one.id}`);
  other.status === 404 ? ok('他の会社の実行は見つからない（404）') : ng(`テナントを跨げる（${other.status}）`);
}

console.log('\n■ 49. 本人のアバター（Google のプロフィール写真。第6.5.1.1節）');
{
  // 写真は Google から取り込むもので、ここでは作れない。所有者のロールで見本の写真を 1 枚入れる
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const { rows: [m] } = await owner.query(`select id, tenant_id from users where email = 'member@alpha.example.jp'`);
  await owner.query(`delete from user_photos where tenant_id = $1 and user_id = $2`, [m.tenant_id, m.id]);
  try {
    const { body: before } = await call('a', '/v1/me', {}, 'member');
    const none = await fetch(`${API}/v1/me/photo`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    before.photo === null && none.status === 404
      ? ok('写真が無ければ null を返し、写真の口は 404') : ng('写真の無い人の扱いが違う', JSON.stringify(before.photo));

    await owner.query(`insert into user_photos (tenant_id, user_id, mime, bytes) values ($1, $2, 'image/png', $3)`, [m.tenant_id, m.id, png]);
    const { body: after } = await call('a', '/v1/me', {}, 'member');
    const res = await fetch(`${API}${after.photo ?? '/v1/me/photo'}`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    const bytes = Buffer.from(await res.arrayBuffer());
    /^\/v1\/me\/photo\?v=/.test(after.photo ?? '') && res.status === 200 && bytes.equals(png)
      && res.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(res.headers.get('content-security-policy') ?? '')
      ? ok('本人の写真を、種類の推測と読み込みを禁じて返す') : ng(`写真の返し方が違う（${res.status}）`);

    // 本人の写真だけを返す。管理者が開いても、その人自身の写真（無ければ 404）
    const adminRes = await fetch(`${API}/v1/me/photo`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
    const adminBytes = Buffer.from(await adminRes.arrayBuffer());
    !adminBytes.equals(png) ? ok('ほかの人の写真は見えない（本人のものだけ）') : ng('他人の写真が見える');
    const { rows: leaked } = await owner.query(`select 1 from user_photos where tenant_id <> $1 and user_id = $2`, [m.tenant_id, m.id]);
    const bRes = await fetch(`${API}/v1/me/photo`, { headers: { 'x-tenant': 'b', 'x-user': 'admin@beta.example.jp' } });
    leaked.length === 0 && !Buffer.from(await bRes.arrayBuffer()).equals(png)
      ? ok('ほかの会社から写真は見えない') : ng('会社を跨いで見える');
  } finally {
    await owner.query(`delete from user_photos where tenant_id = $1 and user_id = $2`, [m.tenant_id, m.id]);
    await owner.end();
  }
}

console.log('\n■ 50. 秘書のアバターに使っている画像は、4 週の見回りで消さない（第10.10.5節・第6.1.3節）');
{
  // 本人が上げたアバターは、どの依頼の入力にも現れない。以前は「秘書に渡しただけのファイル」と
  // 同じ扱いで 4 週後に消え、アバターが人の形のアイコンに戻っていた
  const who = { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const upload = async (name) => {
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), name);
    const res = await fetch(`${API}/v1/files`, { method: 'POST', headers: who, body: form });
    return (await res.json()).id;
  };
  const avatarId = await upload('smoke-avatar.png');
  const looseId = await upload('smoke-loose.png');
  const { body: prefs } = await call('a', '/v1/me/settings', {}, 'member');
  const keep = prefs.secretary.avatar;
  await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify({ ...prefs.secretary, avatar: `file:${avatarId}` }) }, 'member');

  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const { tsImport } = await import('tsx/esm/api');
  const { PostgresRepository } = await tsImport('../packages/core/src/repository/postgres.ts', import.meta.url);
  const { LocalFileStore } = await tsImport('../packages/core/src/files/store.ts', import.meta.url);
  const repo = new PostgresRepository(process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const store = new LocalFileStore(process.env.FILE_STORAGE_DIR ?? new URL('../.data/files', import.meta.url).pathname);
  try {
    // 2 つとも 30 日前に上げたことにして、4 週の見回りと同じ条件で消させる
    await owner.query(`update files set created_at = now() - interval '30 days' where id = any($1)`, [[avatarId, looseId]]);
    const swept = await repo.deleteLooseUploadsBefore('t-alpha', new Date(Date.now() - 28 * 86_400_000).toISOString());
    for (const id of swept) await store.remove('t-alpha', id).catch(() => undefined);
    !swept.includes(avatarId) ? ok('アバターに使っている画像は消さない') : ng('アバターの画像が消えた');
    swept.includes(looseId) ? ok('どこにも使っていない画像は、これまでどおり 4 週で消す') : ng('使っていない画像が残った');
    const avatar = await fetch(`${API}/v1/me/avatar`, { headers: who });
    avatar.status === 200 ? ok('見回りのあとも、アバターを表示できる') : ng(`アバターが表示できない（${avatar.status}）`);

    // アバターを替えると、前の画像はどこにも使われなくなり、4 週の見回りで消える
    await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify({ ...prefs.secretary, avatar: '' }) }, 'member');
    const later = await repo.deleteLooseUploadsBefore('t-alpha', new Date(Date.now() - 28 * 86_400_000).toISOString());
    for (const id of later) await store.remove('t-alpha', id).catch(() => undefined);
    later.includes(avatarId) ? ok('アバターを替えたあとの古い画像は、4 週の見回りで消える') : ng('替えたあとの古い画像が残った');
  } finally {
    await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify({ ...prefs.secretary, avatar: keep }) }, 'member');
    await owner.query(`delete from files where id = any($1)`, [[avatarId, looseId]]);
    for (const id of [avatarId, looseId]) await store.remove('t-alpha', id).catch(() => undefined);
    await owner.end();
    await repo.close?.();
  }
}

console.log('\n■ 51. ダッシュボードの本人と秘書の 1 組（第6.7.4.4節）');
{
  const who = { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' };
  const { body: meBody } = await call('a', '/v1/me', {}, 'member');
  const memberId = meBody.user.id;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'smoke-pair.png');
  const avatarId = (await (await fetch(`${API}/v1/files`, { method: 'POST', headers: who, body: form })).json()).id;
  const { body: prefs } = await call('a', '/v1/me/settings', {}, 'member');
  const keep = prefs.secretary;
  const setSecretary = (over) => call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify({ ...keep, ...over }) }, 'member');

  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const { tsImport } = await import('tsx/esm/api');
  const { PostgresRepository } = await tsImport('../packages/core/src/repository/postgres.ts', import.meta.url);
  const { LocalFileStore } = await tsImport('../packages/core/src/files/store.ts', import.meta.url);
  const repo = new PostgresRepository(process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office');
  const store = new LocalFileStore(process.env.FILE_STORAGE_DIR ?? new URL('../.data/files', import.meta.url).pathname);
  const hadPhoto = (await owner.query(`select 1 from user_photos where tenant_id = 't-alpha' and user_id = $1`, [memberId])).rowCount > 0;
  try {
    await setSecretary({ name: 'スモーク秘書', avatar: `file:${avatarId}` });
    if (!hadPhoto) {
      await repo.saveUserPhoto({ tenantId: 't-alpha', userId: memberId, mime: 'image/png', bytes: png, fetchedAt: new Date().toISOString() });
    }
    const { body: live } = await call('a', '/v1/admin/dashboard/live');
    const pair = (live.people ?? []).find((p) => p.userId === memberId);
    pair?.self?.detail && pair.secretary?.detail && typeof pair.secretary.busy === 'boolean'
      ? ok(`本人の状態と秘書の状態を分けて返す（本人「${pair.self.detail}」・秘書「${pair.secretary.detail}」）`)
      : ng('本人と秘書の状態が返らない', JSON.stringify(pair ?? null));
    pair?.secretary.name === 'スモーク秘書' ? ok('秘書の名前を返す') : ng('秘書の名前が違う', pair?.secretary.name);
    const avatarUrl = `/v1/admin/dashboard/people/${encodeURIComponent(memberId)}/secretary-avatar`;
    pair?.secretary.avatar === avatarUrl ? ok('上げた画像の秘書のアバターは、利用者ごとの口を示す') : ng('アバターの URL が違う', pair?.secretary.avatar);
    pair?.photo?.startsWith(`/v1/admin/dashboard/people/${encodeURIComponent(memberId)}/photo?v=`)
      ? ok('本人の写真の URL を返す') : ng('写真の URL が返らない', pair?.photo);

    const get = (tenant, path, user) => fetch(`${API}${path}`, {
      headers: { 'x-tenant': tenant, 'x-user': `${user}@${tenant === 'a' ? 'alpha' : 'beta'}.example.jp` },
    });
    const img = await get('a', avatarUrl, 'admin');
    img.status === 200 && img.headers.get('content-type') === 'image/png'
      && img.headers.get('x-content-type-options') === 'nosniff' && (img.headers.get('content-security-policy') ?? '').includes('sandbox')
      ? ok('管理者は秘書のアバターを読める（nosniff と CSP 付き）') : ng(`アバターが読めない（${img.status}）`);
    const photo = await get('a', pair?.photo ?? '/', 'admin');
    photo.status === 200 ? ok('管理者は本人の写真を読める') : ng(`写真が読めない（${photo.status}）`);
    (await get('a', avatarUrl, 'member')).status === 403
      ? ok('管理者でなければ、ほかの人のアバターは読めない') : ng('管理者でない人が読めた');
    (await get('b', avatarUrl, 'admin')).status === 404
      ? ok('ほかの会社の管理者は、この会社の人のアバターを読めない（テナント境界）') : ng('ほかの会社から読めた');
    (await get('b', pair?.photo ?? '/', 'admin')).status === 404
      ? ok('ほかの会社の管理者は、この会社の人の写真を読めない（テナント境界）') : ng('ほかの会社から写真が読めた');

    await call('a', '/v1/admin/settings/dashboard', { method: 'PUT', body: JSON.stringify({ people: 'counts' }) });
    const hidden = [(await get('a', avatarUrl, 'admin')).status, (await get('a', pair?.photo ?? '/', 'admin')).status];
    hidden.every((x) => x === 404)
      ? ok('「人数と業務だけ」の会社では、写真もアバターも返さない') : ng('人数だけの会社で画像が返った', hidden.join(','));
    await call('a', '/v1/admin/settings/dashboard', { method: 'PUT', body: JSON.stringify({ people: 'names' }) });

    await setSecretary({ name: '', avatar: 'preset:secretary1' });
    const { body: again } = await call('a', '/v1/admin/dashboard/live');
    const p2 = (again.people ?? []).find((p) => p.userId === memberId);
    p2?.secretary.avatar === '/avatars/secretary1.png' && p2.secretary.name === '秘書'
      ? ok('同梱の絵は静的な置き場を示し、名前が無ければ「秘書」と出す') : ng('同梱の絵か名前の扱いが違う', JSON.stringify(p2?.secretary ?? null));
    (await get('a', avatarUrl, 'admin')).status === 404
      ? ok('上げた画像を登録していなければ、口は何も返さない（ファイルの ID は受け取らない）') : ng('登録していない画像が返った');
  } finally {
    await call('a', '/v1/admin/settings/dashboard', { method: 'PUT', body: JSON.stringify({ people: 'names' }) });
    await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify(keep) }, 'member');
    if (!hadPhoto) await owner.query(`delete from user_photos where tenant_id = 't-alpha' and user_id = $1`, [memberId]);
    await owner.query(`delete from files where id = $1`, [avatarId]);
    await store.remove('t-alpha', avatarId).catch(() => undefined);
    await owner.end();
    await repo.close?.();
  }
}

console.log('\n■ 52. 定時実行の画面と秘書からの制御、管理者の一覧（第6.1.7節・第10.9.8節・第6.6.8.2節）');
{
  const { body: ag } = await call('a', '/v1/agents', {}, 'member');
  const { body: before } = await call('a', '/v1/schedules', {}, 'member');
  const taken = new Set((before.items ?? []).map((s) => s.agentId));
  const target = ag.agents.find((a) => a.schedulable && !(a.inputs?.required ?? []).length && !taken.has(a.id));
  const fileAgent = ag.agents.find((a) => Object.keys(a.inputs?.properties ?? {}).includes('fileId'));
  const needsInput = ag.agents.find((a) => a.schedulable && (a.inputs?.required ?? []).length > 0);
  fileAgent && fileAgent.schedulable === false ? ok(`ファイルを受け取る業務は登録できない印が付く（${fileAgent.name}）`) : ng('ファイルを受け取る業務に印が無い');
  let id = null;
  try {
    if (!target) throw new Error('登録できる業務が見つからない');
    const created = await call('a', '/v1/schedules', { method: 'POST', body: JSON.stringify({ agentId: target.id, rule: { kind: 'weekly', weekday: 3, hour: 6, minute: 15 } }) }, 'member');
    id = created.body?.id;
    created.status === 201 && created.body.label === '毎週水曜 6:15' ? ok(`画面から登録できる（${target.name}・${created.body.label}）`) : ng('登録できない', JSON.stringify(created.body));
    if (fileAgent) {
      const bad = await call('a', '/v1/schedules', { method: 'POST', body: JSON.stringify({ agentId: fileAgent.id, rule: { kind: 'daily', hour: 9, minute: 0 } }) }, 'member');
      bad.status === 400 ? ok('ファイルを受け取る業務の登録は断る（400）') : ng(`登録できてしまう（${bad.status}）`);
    }
    if (needsInput) {
      const bad = await call('a', '/v1/schedules', { method: 'POST', body: JSON.stringify({ agentId: needsInput.id, rule: { kind: 'daily', hour: 9, minute: 0 }, input: {} }) }, 'member');
      bad.status === 400 && /必須/.test(bad.body?.error ?? '') ? ok(`必須の欄が空なら断る（${needsInput.name}）`) : ng(`必須の欄が空でも登録できる（${bad.status}）`);
    }
    const edited = await call('a', `/v1/schedules/${id}`, { method: 'PATCH', body: JSON.stringify({ rule: { kind: 'weekdays', hour: 7, minute: 5 }, input: { note: 'テスト' } }) }, 'member');
    edited.body?.label === '毎平日（月〜金） 7:05' && edited.body?.input?.note === 'テスト' && Date.parse(edited.body.nextRunAt) > Date.now()
      ? ok('繰り返し・時刻・入力を編集でき、次回を求め直す') : ng('編集できない', JSON.stringify(edited.body));

    const say = async (message) => (await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message }) }, 'member')).body;
    const mine = async () => (await call('a', '/v1/schedules', {}, 'member')).body.items.find((s) => s.id === id);
    const paused = await say(`${target.name}を止めて`);
    /止めました/.test(paused.text ?? '') && (await mine())?.enabled === false
      ? ok(`秘書に「${target.name}を止めて」と頼むと止まる（業務には取り次がない）`) : ng('秘書で止まらない', paused.text);
    const resumed = await say(`${target.name}を再開して`);
    const after = await mine();
    /再開しました/.test(resumed.text ?? '') && after?.enabled === true && Date.parse(after.nextRunAt) > Date.now()
      ? ok('秘書に頼んで再開でき、止めていた間の回は起動しない') : ng('秘書で再開できない', resumed.text);
    const status = await say('定時実行はどうなってる？');
    status.layer === 'direct' && new RegExp(`${target.name}: 毎平日`).test(status.text ?? '')
      ? ok('秘書が定時実行の状態を推論なしで並べる') : ng('状態を答えない', status.text);
    const edit = await say('定時実行を追加して');
    /「定時実行」の画面/.test(edit.text ?? '') ? ok('登録は画面を案内し、秘書は行わない') : ng('登録の案内が無い', edit.text);
    const { body: audits } = await call('a', '/v1/admin/audit-events');
    (audits.items ?? []).some((e) => e.action === 'schedule.update' && e.targetId === id && e.actorType === 'secretary')
      ? ok('秘書の操作を監査ログに秘書として残す') : ng('監査ログに秘書の操作が無い');

    // 管理者の「定時実行の一覧」（第6.6.8.2節）。見るだけ・入力を返さない・動かない理由は起動役と同じ判定
    const adminList = async (tenant = 'a', who) => (await call(tenant, '/v1/admin/schedules', {}, who));
    const { body: al } = await adminList();
    const row = (al.items ?? []).find((s) => s.id === id);
    row && row.userName && row.userName !== row.userId && row.agentName === target.name && row.label === '毎平日（月〜金） 7:05' && row.state === 'active'
      ? ok(`管理者は全員の定時実行を人の名前で一覧できる（${row.userName}・${row.agentName}・${row.label}）`) : ng('管理者の一覧に出ない', JSON.stringify(row));
    row && !('input' in row) ? ok('管理者の一覧は業務の入力を返さない（不変則 I-10）') : ng('管理者の一覧が入力を返す');
    const byMember = await adminList('a', 'member');
    const { body: otherTenant } = await adminList('b');
    byMember.status === 403 && !(otherTenant.items ?? []).some((s) => s.id === id)
      ? ok('管理者でない人は見られず（403）、ほかの会社の管理者には出ない') : ng(`一覧の境界が効かない（${byMember.status}）`);
    const { body: agentSettings } = await call('a', '/v1/admin/settings');
    const wasDisabled = agentSettings?.agents?.disabled ?? [];
    await call('a', '/v1/admin/settings/agents', { method: 'PUT', body: JSON.stringify({ disabled: [...wasDisabled, target.id] }) });
    try {
      const blocked = (await adminList()).body.items?.find((s) => s.id === id);
      blocked?.state === 'blocked' && /無効/.test(blocked.blockedReason ?? '') && al.items[0] && (await adminList()).body.items[0].state === 'blocked'
        ? ok(`業務を無効にすると「動かない」と理由が出て、先頭に並ぶ（${blocked.blockedReason}）`) : ng('動かない理由が出ない', JSON.stringify(blocked));
    } finally {
      await call('a', '/v1/admin/settings/agents', { method: 'PUT', body: JSON.stringify({ disabled: wasDisabled }) });
    }

    const other = await call('b', `/v1/schedules/${id}`, { method: 'DELETE' }, 'member');
    const admin = await call('a', `/v1/schedules/${id}`, { method: 'DELETE' });
    other.status === 404 && admin.status === 404 ? ok('ほかの会社の人も、同じ会社の管理者も、本人の定時実行を消せない') : ng(`消せてしまう（${other.status}・${admin.status}）`);
    const run = await say(`${target.name}を今すぐ実行して`);
    /今すぐ実行します/.test(run.text ?? '') ? ok('秘書に頼んで今すぐ実行できる') : ng('今すぐ実行できない', run.text);
    const del = await call('a', `/v1/schedules/${id}`, { method: 'DELETE' }, 'member');
    const gone = !(await mine());
    del.status === 200 && gone ? ok('本人は画面から削除できる') : ng(`削除できない（${del.status}）`);
    if (gone) id = null;
  } catch (err) {
    ng('定時実行の確認が途中で止まった', String(err));
  } finally {
    if (id) await call('a', `/v1/schedules/${id}`, { method: 'DELETE' }, 'member');
  }
}

console.log('\n■ 53. 秘書が指揮する: 業務と秘書のイベント（第10.13節、ADR-0039）');
{
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  try {
    const eventsOf = async (col, id) => (await owner.query(
      `select kind, status, user_id, tenant_id, processed_at, attempts, last_error from agent_events where ${col} = $1 order by created_at`, [id])).rows;
    const waitProcessed = async (col, id, ms = 10000) => {
      const until = Date.now() + ms;
      let rows = [];
      while (Date.now() < until) {
        rows = await eventsOf(col, id);
        if (rows.length > 0 && rows.every((r) => r.processed_at)) break;
        await sleep(300);
      }
      return rows;
    };

    // メニューから業務を使う
    const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question: '有給休暇は何日？' } }) }, 'member');
    const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
    const runEvents = await waitProcessed('run_id', job.runId);
    const { rows: [member] } = await owner.query(`select id, tenant_id from users where email = 'member@alpha.example.jp'`);
    const finished = runEvents.find((e) => e.kind === 'run.finished');
    finished && finished.status === done.run.status && finished.user_id === member.id && finished.tenant_id === member.tenant_id
      ? ok(`業務が終わると、データベースがイベントを書く（${finished.kind}・${finished.status}・依頼した本人）`) : ng('実行のイベントが無い', JSON.stringify(runEvents));
    runEvents.length > 0 && runEvents.every((e) => e.processed_at && !e.last_error)
      ? ok('秘書の受け手がすぐに取り出して処理する（数秒以内）') : ng('処理されない', JSON.stringify(runEvents));

    // 秘書と話す
    await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: '今日の予定は？' }) }, 'member');
    const { rows: [conv] } = await owner.query(`select id from conversations where user_id = $1 order by created_at desc limit 1`, [member.id]);
    const convEvents = conv ? await waitProcessed('conversation_id', conv.id) : [];
    convEvents.length === 1 && convEvents[0].kind === 'conversation.turn' && convEvents[0].processed_at
      ? ok('会話を 1 往復残すと、イベントが書かれ、すぐに処理される') : ng('会話のイベントが無い', JSON.stringify(convEvents));

    // 会社をまたいで取り出せるのはデータベースの関数だけ（アプリの権限では、ほかの会社のイベントは見えない）
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office' });
    await app.connect();
    try {
      await app.query(`select set_config('app.tenant_id', $1, false)`, ['t-beta']);
      const { rows: seen } = await app.query(`select count(*)::int as n from agent_events where tenant_id = $1`, [member.tenant_id]);
      seen[0].n === 0 ? ok('ほかの会社のイベントは見えない（テナント境界）') : ng('ほかの会社のイベントが見える', String(seen[0].n));
      const ins = await app.query(`insert into agent_events (tenant_id, user_id, kind) values ('t-beta', 'x', 'conversation.turn')`).then(() => 'ok', (e) => e.code);
      ins !== 'ok' ? ok('アプリはイベントを直接書けない（書くのはデータベースだけ）') : ng('アプリがイベントを書けてしまう');
    } finally {
      await app.end();
    }
  } catch (err) {
    ng('イベントの確認が途中で止まった', String(err));
  } finally {
    await owner.end();
  }
}

console.log('\n■ 54. 秘書が段取りをする: 分身と業務の連携（第10.14節、ADR-0040）');
{
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const say = async (message) => (await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message }) }, 'member')).body;
  const lookups = async () => (await call('a', '/v1/secretary/lookups', {}, 'member')).body.items ?? [];
  const planOf = async (id) => (await owner.query(`select status, question, report_run_id from plans where id = $1`, [id])).rows[0];
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(300); } return v; };
  const planIds = [];
  try {
    // 依頼を受けたら、段取りを作ってすぐ返す（黙り込まない）
    const started = Date.now();
    const reply = await say('大阪出張の準備の段取りをして');
    const ms = Date.now() - started;
    const planId = reply.lookup?.runId?.startsWith('plan:') ? reply.lookup.runId.slice(5) : null;
    if (planId) planIds.push(planId);
    planId && /段取りを組みます/.test(reply.text ?? '') && ms < 3000
      ? ok(`段取りを作ってすぐ返す（${ms} ms）`) : ng('段取りにならない', JSON.stringify(reply).slice(0, 200));

    // 分身が段取りを立て、業務に依頼し、足りない情報を本人に聞く
    const asked = await until(async () => (await planOf(planId))?.status === 'waiting_input' && await planOf(planId));
    asked?.question && /社内ナレッジ Q&A/.test(asked.question)
      ? ok(`分身が段取りを立てて業務に頼み、足りない情報を 1 回だけ聞く（「${asked.question}」）`) : ng('問いが出ない', JSON.stringify(asked ?? null));
    const bar = (await lookups()).find((x) => x.runId === `plan:${planId}`);
    bar && !bar.done && bar.progress === asked?.question ? ok('秘書バーに段取りの問いを出す') : ng('秘書バーに出ない', JSON.stringify(bar ?? null));
    const { rows: stepRuns } = await owner.query(
      `select s.seq, s.status, s.run_id, j.plan_step_id from plan_steps s left join jobs j on j.plan_step_id = s.id where s.plan_id = $1 order by s.seq`, [planId]);
    stepRuns[0]?.status === 'completed' && stepRuns[0]?.plan_step_id ? ok('1 段目の業務は、段取りの段として起こして完了した') : ng('段の業務が無い', JSON.stringify(stepRuns));
    (await lookups()).every((x) => x.runId !== stepRuns[0]?.run_id) ? ok('段の業務の結果は個別には届けない') : ng('段の結果が個別に届く');

    // 本人が答えると、秘書が段取りに渡して続きを進め、そろったら報告が届く
    const answered = await say('来週の月曜の会議です');
    /段取りを続けます/.test(answered.text ?? '') ? ok('本人の返事を秘書が見分けて段取りに渡す') : ng('返事が段取りに渡らない', answered.text);
    const reported = await until(async () => { const p = await planOf(planId); return p?.status === 'reported' && p.report_run_id ? p : null; });
    reported ? ok('すべての段が終わると、段取りの報告を起こす') : ng('報告にならない', JSON.stringify(await planOf(planId)));
    const report = await until(async () => (await lookups()).find((x) => x.runId === reported?.report_run_id && x.done));
    report && report.agentName === null && report.request === '大阪出張の準備の段取りをして'
      ? ok('報告は秘書の答えとして届く（依頼の文のまま）') : ng('報告が届かない', JSON.stringify(report ?? null));
    const { body: claimed } = await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, 'member');
    (claimed.items ?? []).some((x) => x.runId === reported?.report_run_id) ? ok('報告を本人に伝える（持ち越しと同じ経路）') : ng('報告を伝えない');

    // 進み具合と取りやめ
    const second = await say('東京の取引先訪問の段取りをして');
    const secondId = second.lookup?.runId?.slice(5);
    if (secondId) planIds.push(secondId);
    const status = await say('段取りはどこまで進んだ？');
    /段取り/.test(status.text ?? '') && status.layer === 'direct' ? ok('進み具合を推論なしで答える') : ng('進み具合を答えない', status.text);
    const cancelled = await say('段取りはやめて');
    const after = secondId ? await planOf(secondId) : null;
    /取りやめました/.test(cancelled.text ?? '') && after?.status === 'cancelled' ? ok('「やめて」で段取りを取りやめる') : ng('取りやめられない', `${cancelled.text} / ${after?.status}`);

    const { rows: audits } = await owner.query(
      `select distinct action from audit_events where target_id = any($1) and action like 'secretary.plan.%'`, [planIds]);
    const actions = audits.map((r) => r.action);
    ['secretary.plan.create', 'secretary.plan.report', 'secretary.plan.cancel'].every((a) => actions.includes(a))
      ? ok('段取りの操作を監査ログに残す') : ng('監査ログが足りない', actions.join(','));

    // テナント境界: ほかの会社から段取りは見えない
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query(`select set_config('app.tenant_id', 't-beta', false)`);
      const { rows: seen } = await app.query(`select count(*)::int as n from plans where id = any($1)`, [planIds]);
      seen[0].n === 0 ? ok('ほかの会社から段取りは見えない（テナント境界）') : ng('ほかの会社から見える');
    } finally {
      await app.end();
    }
  } catch (err) {
    ng('段取りの確認が途中で止まった', String(err));
  } finally {
    for (const id of planIds) {
      await owner.query(`update plans set status = 'cancelled' where id = $1 and status in ('planning','running','waiting_input')`, [id]);
    }
    await owner.end();
    await call('a', '/v1/me/conversations', { method: 'DELETE' }, 'member');
  }
}

console.log('\n■ 55. 声を試す・会話を文字で出す（第10.5.8節・第6.5.3節）');
{
  const before = await call('a', '/v1/me/settings', {}, 'member');
  const secretary = { name: '試しの秘書', callMe: '', style: 'polite', proactivity: 'normal', speak: true, voice: 'Kore', voiceStyle: 'ゆっくり話して', avatar: '' };
  const r = await call('a', '/v1/me/voice-test', { method: 'POST', body: JSON.stringify(secretary) }, 'member');
  // 自動テストでは見本の音声が返る。声は無く、内部の指示を受け取ったことだけを文字で返す
  r.status === 200 && typeof r.body.text === 'string' && r.body.text.includes('声の確認') && r.body.sampleRate === 24000 && typeof r.body.audio === 'string'
    ? ok('画面に入っている設定で秘書に名乗らせ、文字と声を返す') : ng(`声を試せない（${r.status}）`, JSON.stringify(r.body).slice(0, 200));
  const after = await call('a', '/v1/me/settings', {}, 'member');
  after.body?.secretary?.name === before.body?.secretary?.name
    ? ok('試しても設定は保存しない') : ng('試しただけで設定が変わった');
  const off = await call('a', '/v1/me/voice-test', { method: 'POST', body: JSON.stringify({ ...secretary, speak: false }) }, 'member');
  off.status === 400 ? ok('「声で答える」を切っているときは試せない') : ng(`切っていても試せる（${off.status}）`);
  const convs = await call('a', '/v1/me/conversations', {}, 'member');
  !(convs.body?.items ?? []).some((c) => String(c.reply ?? '').includes('声の確認'))
    ? ok('会話ログには残さない') : ng('会話ログに残った');

  // 会話を文字で出す（第6.5.3節）。既定は出す。切ったら保存され、戻せる
  (before.body?.secretary?.captions === true) ? ok('「会話を文字で出す」の既定は入') : ng('既定が入でない', JSON.stringify(before.body?.secretary));
  await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify({ ...before.body.secretary, captions: false }) }, 'member');
  const noCap = await call('a', '/v1/me/settings', {}, 'member');
  noCap.body?.secretary?.captions === false ? ok('「会話を文字で出す」を切って保存できる') : ng('切った値が保存されない');
  await call('a', '/v1/me/settings/secretary', { method: 'PUT', body: JSON.stringify(before.body.secretary) }, 'member');
}

console.log('\n■ 56. 認証の要る会社の接続（oauth・api_key。第12.11.6節、ADR-0044）');
{
  // 手元に「許可の画面と認可の受け取り」と「認可が要る MCP サーバ」を兼ねるサーバを立てる。
  // コード good-<名前> を受け取ると、認可 tok-<名前> を渡す。MCP は認可を見て、誰の認可で呼ばれたかを返す
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const origin = `http://localhost:${server.address().port}`;
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/.well-known/oauth-protected-resource') return json(200, { authorization_servers: [origin] });
    if (req.url === '/.well-known/oauth-authorization-server') {
      return json(200, { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ['S256'] });
    }
    if (req.url === '/token') {
      const f = new URLSearchParams(raw);
      if (f.get('client_secret') !== 'csecret') return json(200, { ok: false, error: 'bad_client_secret' });
      if (!f.get('code_verifier')) return json(200, { ok: false, error: 'pkce_required' });
      const who = (f.get('code') ?? '').replace(/^good-/, '');
      return json(200, { ok: true, access_token: `tok-${who}`, token_type: 'user', scope: 'deals:read' });
    }
    // MCP。/mcp は oauth の認可、/mcp-key は会社の鍵を求める
    const auth = req.url === '/mcp-key' ? (req.headers['x-api-key'] === 'KEY-1' ? 'key' : null)
      : /^Bearer tok-/.test(req.headers.authorization ?? '') ? req.headers.authorization.slice('Bearer '.length) : null;
    if (!auth) return json(401, { error: 'unauthorized' });
    const msg = JSON.parse(raw || '{}');
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
      : msg.method === 'tools/list' ? { tools: [{ name: 'list_deals', description: '商談を探す', annotations: { readOnlyHint: true } }] }
      : msg.method === 'tools/call' ? { content: [{ type: 'text', text: `商談: 見本商事（認可: ${auth}）` }] } : {};
    return json(200, { jsonrpc: '2.0', id: msg.id, result });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${server.address().port}`;
  const EXT = 'jp.example.oauth-deals';
  const AG = `${EXT}:deals`;
  for (const id of ['oauthcrm', 'keycrm']) await call('a', `/v1/admin/connections/mcp/${id}`, { method: 'DELETE' });
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });

  /** 本人として許可の画面へ進んだことにし、相手からの戻りを API に届ける（画面の転送は通さない）。 */
  const connectAs = async (who, code) => {
    const start = await call('a', '/v1/me/connections/oauthcrm/connect', { method: 'POST' }, who);
    const u = new URL(start.body.url ?? 'http://x/');
    const back = await fetch(`${API}/v1/oauth/connection/callback?state=${encodeURIComponent(u.searchParams.get('state') ?? '')}&code=${code}`, { redirect: 'manual' });
    return { start, u, back };
  };

  try {
    const added = await call('a', '/v1/admin/connections/mcp', { method: 'POST', body: JSON.stringify({ id: 'oauthcrm', name: '顧客管理', url: `${base}/mcp`, auth: 'oauth' }) });
    const { body: l1 } = await call('a', '/v1/admin/connections/mcp');
    const c1 = l1.items?.find((x) => x.id === 'oauthcrm');
    added.status === 201 && c1?.authState?.type === 'oauth' && c1.authState.ready === false && /\/v1\/oauth\/connection\/callback$/.test(c1.authState.redirectUri ?? '')
      ? ok('利用者ごとに許可する接続を登録でき、戻り先の URL を示す（道具は許可のあとで問い合わせる）') : ng('登録の結果が違う', JSON.stringify({ added: added.body, c1 }));

    const memberCred = await call('a', '/v1/admin/connections/mcp/oauthcrm/credentials', { method: 'PUT', body: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }) }, 'member');
    memberCred.status === 403 ? ok('一般の利用者は認証情報を登録できない（403）') : ng(`登録できてしまう（${memberCred.status}）`);
    const cred = await call('a', '/v1/admin/connections/mcp/oauthcrm/credentials', { method: 'PUT', body: JSON.stringify({ clientId: 'cid', clientSecret: 'csecret' }) });
    const { body: l2 } = await call('a', '/v1/admin/connections/mcp');
    const c2 = l2.items?.find((x) => x.id === 'oauthcrm');
    cred.status === 200 && c2?.authState?.ready === true && c2.authState.secretSet === true && !JSON.stringify(l2).includes('csecret')
      ? ok('クライアント ID とシークレットを登録できる。シークレットは返さない') : ng('認証情報の登録が違う', JSON.stringify(c2?.authState));

    const { body: before } = await call('a', '/v1/me/connections', {}, 'member');
    const m0 = before.items?.find((x) => x.id === 'oauthcrm');
    m0?.available === true && m0.connected === false ? ok('個人設定に、未接続のサービスとして出る') : ng('個人設定の一覧が違う', JSON.stringify(before));

    const bad = await fetch(`${API}/v1/oauth/connection/callback?state=nope&code=good-member`, { redirect: 'manual' });
    bad.status === 400 ? ok('照合できない戻りは受け付けない') : ng(`受け付けてしまう（${bad.status}）`);

    const { start, u, back } = await connectAs('member', 'good-member');
    start.status === 200 && u.searchParams.get('code_challenge') && u.searchParams.get('code_challenge_method') === 'S256' && u.pathname === '/authorize'
      ? ok('許可の画面の URL は、相手の案内から見つけた口に state と PKCE を付ける') : ng('許可の画面の URL が違う', start.body.url);
    const loc = back.headers.get('location') ?? '';
    back.status === 302 && /connection=connected/.test(loc) ? ok('相手からの戻りで認可を受け取り、個人設定へ戻す') : ng('戻りの扱いが違う', `${back.status} ${loc}`);
    const { body: after } = await call('a', '/v1/me/connections', {}, 'member');
    after.items?.find((x) => x.id === 'oauthcrm')?.connected === true ? ok('接続したことが個人設定に出る') : ng('接続が出ない', JSON.stringify(after));

    // 管理者も自分で接続して確かめ、自分の認可で道具を取り直す（第12.11.6.2節 手順 4）
    const noAdmin = await call('a', '/v1/admin/connections/mcp/oauthcrm/refresh', { method: 'POST' });
    noAdmin.status === 400 && /接続が要ります/.test(noAdmin.body.error ?? '') ? ok('管理者が接続する前は、道具を取り直せない（接続が要ると示す）') : ng('接続なしで取り直せてしまう', JSON.stringify(noAdmin.body));
    await connectAs('admin', 'good-admin');
    const refreshed = await call('a', '/v1/admin/connections/mcp/oauthcrm/refresh', { method: 'POST' });
    const { body: l3 } = await call('a', '/v1/admin/connections/mcp');
    refreshed.status === 200 && l3.items?.find((x) => x.id === 'oauthcrm')?.tools?.find((t) => t.name === 'list_deals')?.risk === 'read'
      ? ok('管理者の認可で道具を問い合わせて並べる') : ng('道具を取り直せない', JSON.stringify(refreshed.body));

    // 業務は依頼した本人の認可で呼ぶ（不変則 I-9）
    const data = await skillZip({
      id: EXT, name: 'deals', title: '確認用: 許可の要る商談', tools: ['oauthcrm.list_deals'], inputs: ['会社: 短文'], input: { 会社: '見本商事' },
      stub: { work: [{ name: 'oauthcrm.list_deals', args: { company: '見本商事' } }] },
    });
    await call('a', '/v1/admin/extensions/import', { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });
    await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
    const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 会社: '見本商事' } }) }, 'member');
    const done = await waitFor('a', job.runId, ['completed', 'failed', 'awaiting_approval'], 20000, 'member');
    const called = done.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === 'oauthcrm.list_deals')?.result;
    done.run?.status === 'completed' && /認可: tok-member/.test(called?.text ?? '')
      ? ok('業務は依頼した本人の認可で呼ぶ（管理者の認可で代わりに呼ばない）') : ng('本人の認可で呼べていない', JSON.stringify({ status: done.run?.status, called }));

    const off = await call('a', '/v1/me/connections/oauthcrm', { method: 'DELETE' }, 'member');
    const { body: menu } = await call('a', '/v1/agents', {}, 'member');
    const need = menu.agents?.find((a) => a.id === AG)?.needsConnection ?? [];
    off.status === 200 && need.some((x) => x.id === 'oauthcrm') ? ok('取り消すと、その業務に「接続が要ります」が出る') : ng('取り消しの結果が違う', JSON.stringify({ off: off.body, need }));
    const { body: job2 } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { 会社: '見本商事' } }) }, 'member');
    const done2 = await waitFor('a', job2.runId, ['completed', 'failed', 'awaiting_approval'], 20000, 'member');
    const called2 = done2.steps?.find((x) => x.stepId === 'work')?.output?.tools?.find((t) => t.name === 'oauthcrm.list_deals')?.result;
    /接続が要ります/.test(called2?.error ?? '') && !/tok-admin/.test(JSON.stringify(done2))
      ? ok('接続していない人の業務は、ほかの人の認可で動かさず「接続が要ります」で止まる') : ng('接続なしで動いてしまう', JSON.stringify({ status: done2.run?.status, called2 }));

    // 会社の鍵で動く接続
    const key = await call('a', '/v1/admin/connections/mcp', { method: 'POST', body: JSON.stringify({ id: 'keycrm', name: '販売管理', url: `${base}/mcp-key`, auth: 'api_key', header: 'X-API-Key' }) });
    const keyCred = await call('a', '/v1/admin/connections/mcp/keycrm/credentials', { method: 'PUT', body: JSON.stringify({ apiKey: 'KEY-1' }) });
    const { body: l4 } = await call('a', '/v1/admin/connections/mcp');
    const k = l4.items?.find((x) => x.id === 'keycrm');
    key.status === 201 && keyCred.body.tools === 1 && k?.authState?.keySet === true && !JSON.stringify(l4).includes('KEY-1')
      ? ok('会社の鍵を登録すると、その鍵で道具を問い合わせる。鍵は返さない') : ng('会社の鍵の登録が違う', JSON.stringify({ key: key.body, keyCred: keyCred.body, k: k?.authState }));
    const check = await call('a', '/v1/admin/connections/mcp/keycrm/check', { method: 'POST' });
    check.body.ok ? ok('会社の鍵で接続を確かめられる') : ng('確かめられない', JSON.stringify(check.body));

    const { body: bList } = await call('b', '/v1/admin/connections/mcp');
    const { body: bMine } = await call('b', '/v1/me/connections', {}, 'member');
    !(bList.items ?? []).some((x) => x.id === 'oauthcrm') && !(bMine.items ?? []).some((x) => x.id === 'oauthcrm')
      ? ok('認証の要る接続と利用者の接続は、ほかの会社には見えない') : ng('ほかの会社に見える');
    const { body: audits } = await call('a', '/v1/admin/audit-events');
    const actions = (audits.items ?? audits.events ?? []).map((e) => e.action);
    ['connection.secret.update', 'connection.oauth.connect', 'connection.oauth.disconnect'].every((a) => actions.includes(a))
      ? ok('認証情報の登録・接続・取り消しを監査ログに残す（値は残さない）') : ng('監査ログが足りない', actions.slice(0, 20).join(','));
  } catch (err) {
    ng('認証の要る接続の確認が途中で止まった', String(err));
  } finally {
    await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
    for (const id of ['oauthcrm', 'keycrm']) await call('a', `/v1/admin/connections/mcp/${id}`, { method: 'DELETE' });
    await new Promise((r) => server.close(r));
  }
}

console.log('\n■ 57. 名刺管理（内蔵の拡張。第27章、ADR-0042）');
{
  // 自動テストの推論（スタブ）は、画像に埋め込んだ見本の読み取り結果を返す（llm/stub.ts の extractFromImage）
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff0f0000050101005b1c4a1a0000000049454e44ae426082', 'hex');
  const tag = Date.now().toString(36);
  const cardImage = (fields) => Buffer.concat([PNG, Buffer.from(`\nM2O-CARD:${JSON.stringify({ isCard: true, cardCount: 1, textTop: 'up', ...fields })}\n`, 'utf8')]);
  const upload = async (tenant, who, files, extra = {}) => {
    const form = new FormData();
    for (const [name, bytes] of files) form.append('file', new Blob([bytes]), name);
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    const res = await fetch(`${API}/v1/cards`, {
      method: 'POST', body: form,
      headers: { 'x-tenant': tenant, 'x-user': `${who}@${tenant === 'a' ? 'alpha' : 'beta'}.example.jp` },
    });
    return { status: res.status, body: await res.json() };
  };
  const list = async (who, q = '', tenant = 'a') => (await call(tenant, `/v1/cards?q=${encodeURIComponent(q)}`, {}, who)).body;
  const settle = async (who) => {
    for (let i = 0; i < 40; i++) {
      const l = await list(who);
      if (!l.progress && !(l.unresolved ?? []).some((u) => u.status !== 'failed')) return l;
      await sleep(500);
    }
    return list(who);
  };
  const created = [];
  try {
    const email = `tanaka-${tag}@sample.example`;
    const first = await upload('a', 'member', [
      ['c1.png', cardImage({ name: `田中 ${tag}`, company: '株式会社サンプル', title: '課長', emails: [email], phones: [{ kind: 'main', number: '03-1111-2222' }] })],
      ['not-card.png', PNG],
    ]);
    first.status === 202 && first.body.queued === 2 ? ok('名刺のファイルを受け付け、読み取りを待たずに返す（202）') : ng('受け付けない', JSON.stringify(first.body));
    const after = await settle('member');
    const tanaka = (after.items ?? []).find((c) => c.emails.includes(email));
    if (tanaka) created.push(tanaka.id);
    tanaka && tanaka.scope === 'company' ? ok('読み取ったら確認なしに登録し、既定は会社で共有') : ng('登録されない', JSON.stringify(after));
    (after.unresolved ?? []).some((u) => u.status === 'failed')
      ? ok('名刺と見分けられないものは登録せず、「読み取れませんでした」と画像と一緒に残す') : ng('読み取れなかったものが残らない');

    // 別の人が同じ人の新しい名刺を取り込むと、1 つの連絡先にまとまり、中身は新しい名刺になる（第27.6節）
    await upload('a', 'admin', [['c2.png', cardImage({ name: `田中 ${tag}`, company: '株式会社サンプル', title: '部長', emails: [email], phones: [{ kind: 'mobile', number: '090-3333-4444' }] })]]);
    await settle('admin');
    const { body: merged } = await call('a', `/v1/cards/${tanaka?.id}`, {}, 'member');
    merged.cards?.length === 2 && merged.contact?.title === '部長' && merged.history?.some((h) => h.title === '課長')
      && merged.contact?.phones.length === 2
      ? ok('同じメールアドレスの名刺は 1 つにまとまり、新しい名刺の役職になり、以前の役職は履歴に残る') : ng('まとまらない', JSON.stringify(merged).slice(0, 300));

    // 自分だけの名刺は、管理者も・ほかの会社も見られない（第27.7節）
    const mine = await upload('a', 'member', [['c3.png', cardImage({ name: `佐藤 ${tag}`, company: '個人の知り合い', emails: [`sato-${tag}@private.example`] })]], { scope: 'personal' });
    await settle('member');
    const personal = (await list('member', `佐藤 ${tag}`)).items?.[0];
    if (personal) created.push(personal.id);
    const byAdmin = await list('admin', `佐藤 ${tag}`);
    const detailByAdmin = await call('a', `/v1/cards/${personal?.id}`, {}, 'admin');
    const imgByAdmin = await fetch(`${API}/v1/cards/card/${personal?.cardId}/front`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
    const imgByMe = await fetch(`${API}/v1/cards/card/${personal?.cardId}/front`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    mine.status === 202 && personal?.scope === 'personal' && (byAdmin.items ?? []).length === 0 && detailByAdmin.status === 404
      && imgByAdmin.status === 404 && imgByMe.status === 200
      ? ok('自分だけの名刺は、本人だけが一覧・詳細・画像を見られる（管理者も見られない）') : ng('自分だけの名刺が見える', `${byAdmin.items?.length} ${detailByAdmin.status} ${imgByAdmin.status} ${imgByMe.status}`);
    const other = await list('admin', tag, 'b');
    const otherDetail = await call('b', `/v1/cards/${tanaka?.id}`);
    (other.items ?? []).length === 0 && otherDetail.status === 404 ? ok('ほかの会社の名刺は、一覧にも詳細にも出ない') : ng('ほかの会社の名刺が見える');

    // その場の修正・範囲・vCard・分ける（第27.8節）
    const fix = await call('a', `/v1/cards/${tanaka?.id}`, { method: 'PATCH', body: JSON.stringify({ department: '営業部', note: '展示会で会った' }) }, 'admin');
    const { body: fixed } = await call('a', `/v1/cards/${tanaka?.id}`, {}, 'member');
    fix.status === 200 && fixed.contact?.department === '営業部' && fixed.updatedByName ? ok('会社で共有の名刺は、見られる人が直せ、直した人が残る') : ng('直せない', JSON.stringify(fix.body));
    // 受け取った日（第27.3節）。初めは取り込んだ日（日本時間）で、受け取った本人だけが直せる
    const todayJst = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const myCard = merged.cards?.find((c) => c.mine);
    const theirCard = merged.cards?.find((c) => !c.mine);
    const setMine = await call('a', `/v1/cards/card/${myCard?.id}/received`, { method: 'PUT', body: JSON.stringify({ receivedOn: '2026-09-01' }) }, 'member');
    const setTheirs = await call('a', `/v1/cards/card/${theirCard?.id}/received`, { method: 'PUT', body: JSON.stringify({ receivedOn: '2026-09-01' }) }, 'member');
    const future = await call('a', `/v1/cards/card/${myCard?.id}/received`, { method: 'PUT', body: JSON.stringify({ receivedOn: '2999-01-01' }) }, 'member');
    const { body: dated } = await call('a', `/v1/cards/${tanaka?.id}`, {}, 'member');
    myCard?.receivedOn === todayJst && setMine.status === 200 && setTheirs.status === 400 && future.status === 400
      && dated.cards?.some((c) => c.mine && c.receivedOn === '2026-09-01')
      ? ok('受け取った日は初め日本時間の取り込んだ日で、受け取った本人だけが直せる（今日より後は断る）')
      : ng('受け取った日が違う', JSON.stringify({ first: myCard?.receivedOn, todayJst, setMine: setMine.status, setTheirs: setTheirs.status, future: future.status }));
    const toPersonal = await call('a', `/v1/cards/${tanaka?.id}/scope`, { method: 'PUT', body: JSON.stringify({ scope: 'personal' }) }, 'admin');
    toPersonal.status === 403 ? ok('取り込んだ本人でない人は、自分だけにできない') : ng(`自分だけにできてしまう（${toPersonal.status}）`);
    const { body: mail } = await call('a', `/v1/cards/${tanaka?.id}/mail-draft`, { method: 'POST' }, 'member');
    mail.to === email && /名刺交換のお礼/.test(mail.subject ?? '') && new RegExp(`田中 ${tag} 様`).test(mail.body ?? '')
      ? ok('お礼のメールの件名と本文を作る（送らない。画面が Gmail の新しいメールの画面に入れて開く）') : ng('お礼のメールが違う', JSON.stringify(mail).slice(0, 200));
    const vcard = await fetch(`${API}/v1/cards/${tanaka?.id}/vcard`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    const vtext = await vcard.text();
    vcard.status === 200 && vtext.includes(`FN:田中 ${tag}`) && vtext.includes('TITLE:部長') ? ok('1 件を vCard で書き出せる') : ng('vCard が違う', vtext.slice(0, 120));
    // 管理者が取り込んだほうの名刺を分ける（分けた連絡先は、その名刺を取り込んだ人のものになる）
    const split = await call('a', `/v1/cards/${tanaka?.id}/split`, { method: 'POST', body: JSON.stringify({ cardId: merged.cards?.find((c) => !c.mine)?.id }) }, 'member');
    if (split.body?.contactId) created.push(split.body.contactId);
    const { body: afterSplit } = await call('a', `/v1/cards/${tanaka?.id}`, {}, 'member');
    split.status === 200 && afterSplit.cards?.length === 1 ? ok('まとめた名刺を別の連絡先に分けられる') : ng('分けられない', JSON.stringify(split.body));

    // 入り切りと利用範囲（第12.13節・第16.7.3節）
    await call('a', '/v1/admin/extensions/business-cards/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    const offList = await call('a', '/v1/cards', {}, 'member');
    const { body: offMe } = await call('a', '/v1/me', {}, 'member');
    await call('a', '/v1/admin/extensions/business-cards/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const onList = await list('member', tag);
    offList.status === 403 && offMe.cards === false && (onList.items ?? []).length > 0
      ? ok('名刺管理を切ると画面も API も使えず、入れ直すとデータが戻る') : ng('入り切りが効かない', `${offList.status} ${offMe.cards}`);
    const { body: users } = await call('a', '/v1/admin/users');
    const adminId = users.items?.find((u) => u.email === 'admin@alpha.example.jp')?.id;
    await call('a', '/v1/admin/access/business-cards', { method: 'PUT', body: JSON.stringify({ scope: { groups: [], users: [adminId] } }) });
    const outOfScope = await call('a', '/v1/cards', {}, 'member');
    await call('a', '/v1/admin/access/business-cards', { method: 'PUT', body: JSON.stringify({ scope: 'all' }) });
    outOfScope.status === 403 ? ok('利用範囲の外の人は名刺管理を使えない') : ng(`利用範囲の外でも使える（${outOfScope.status}）`);

    // 名刺も業務の 1 つとしてピン止めできる（第6.1.1節）。本人の設定に残る
    const { body: mySettings } = await call('a', '/v1/me/settings', {}, 'member');
    const pinSave = await call('a', '/v1/me/settings/menu', { method: 'PUT', body: JSON.stringify({ ...mySettings.menu, pinned: ['business-cards'] }) }, 'member');
    const { body: afterPin } = await call('a', '/v1/me/settings', {}, 'member');
    await call('a', '/v1/me/settings/menu', { method: 'PUT', body: JSON.stringify(mySettings.menu) }, 'member');
    pinSave.status === 200 && afterPin.menu?.pinned?.includes('business-cards')
      ? ok('名刺を業務の 1 つとしてピン止めでき、本人の設定に残る') : ng('名刺のピン止めが残らない', JSON.stringify(afterPin.menu));

    // ごみ箱と消去（第27.7節）
    const trash = await call('a', `/v1/cards/${personal?.id}`, { method: 'DELETE' }, 'member');
    const inTrash = (await call('a', '/v1/cards?trash=1', {}, 'member')).body.items?.some((c) => c.id === personal?.id);
    const purge = await call('a', `/v1/cards/${personal?.id}/purge`, { method: 'DELETE' }, 'member');
    const gone = await call('a', `/v1/cards/${personal?.id}`, {}, 'member');
    const imgGone = await fetch(`${API}/v1/cards/card/${personal?.cardId}/front`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    trash.status === 200 && inTrash && purge.status === 200 && gone.status === 404 && imgGone.status === 404
      ? ok('消すとごみ箱へ移り、「いま消す」で画像ごと本当に消える') : ng('消去が違う', `${trash.status} ${inTrash} ${purge.status} ${gone.status} ${imgGone.status}`);
    // 分けた連絡先は、その名刺を取り込んだ管理者のもの。一般の利用者は直せるが消せない
    const trashByOther = await call('a', `/v1/cards/${split.body?.contactId}`, { method: 'DELETE' }, 'member');
    trashByOther.status === 403 ? ok('取り込んだ本人でも管理者でもない人は消せない') : ng(`消せてしまう（${trashByOther.status}）`);

    const { body: audits } = await call('a', '/v1/admin/audit-events?category=cards');
    const acts = (audits.items ?? []).map((e) => e.action);
    const names = (audits.items ?? []).map((e) => e.target);
    ['card.import', 'contact.merge', 'contact.split', 'contact.trash', 'contact.purge'].every((a) => acts.includes(a)) && !names.some((n) => n.includes(tag))
      ? ok('取り込み・まとめる・分ける・消すを監査ログに残し、相手の名前は出さない') : ng('監査ログが違う', acts.slice(0, 12).join(','));
  } catch (err) {
    ng('名刺管理の確認が途中で止まった', String(err));
  } finally {
    await call('a', '/v1/admin/extensions/business-cards/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    await call('a', '/v1/admin/access/business-cards', { method: 'PUT', body: JSON.stringify({ scope: 'all' }) });
    for (const id of created) {
      for (const who of ['member', 'admin']) {
        await call('a', `/v1/cards/${id}`, { method: 'DELETE' }, who);
        await call('a', `/v1/cards/${id}/purge`, { method: 'DELETE' }, who);
      }
    }
    for (const u of (await list('member')).unresolved ?? []) await call('a', `/v1/cards/card/${u.id}`, { method: 'DELETE' }, 'member');
  }
}

console.log('\n■ 58. 契約書チェック（公式の拡張機能。第28章、ADR-0043）');
{
  const EXT = 'jp.m2office.legal.contract-review';
  const AGENT = `${EXT}:contract-review`;
  try {
    const { body: before } = await call('a', '/v1/admin/extensions');
    const item = (before.items ?? []).find((x) => x.id === EXT);
    item && !item.installed && item.permissions?.maxRisk === 'draft'
      ? ok('公式の拡張機能として配布元に並び、既定では入っていない。最上位の危険度は下書き') : ng('配布元に無いか、入っている', JSON.stringify(item?.installed));
    const install = await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
    const { body: agents } = await call('a', '/v1/agents', {}, 'member');
    const def = (agents.agents ?? []).find((a) => a.id === AGENT);
    install.status === 200 && def && def.inputs?.properties?.['契約書']?.format === 'file'
      ? ok('導入すると、契約書のファイルの欄を持つ業務として使える') : ng('業務が使えない', JSON.stringify(install.body));

    // 秘書に契約書を渡して「この NDA 大丈夫？」と聞くと、照会として答えずに契約書チェックへ回す（第28.8節）
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff0f0000050101005b1c4a1a0000000049454e44ae426082', 'hex')]), 'nda.png');
    const up = await fetch(`${API}/v1/files`, { method: 'POST', body: form, headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    const file = await up.json();
    const { body: reply } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: 'このNDA大丈夫？サインしていい？', fileId: file.id }) }, 'member');
    /契約書チェック/.test(reply.text ?? '') && reply.lookup?.runId
      ? ok('契約書を渡した問いは、秘書が大丈夫かを答えずに契約書チェックへ回す') : ng('契約書チェックに回らない', reply.text);
    if (reply.lookup?.runId) {
      const { body: run } = await call('a', `/v1/runs/${reply.lookup.runId}`, {}, 'member');
      run.job?.input?.['契約書'] === file.id ? ok('渡した契約書が、業務の「契約書」の欄に入る') : ng('ファイルが欄に入らない', JSON.stringify(run.job?.input));
    }
  } catch (err) {
    ng('契約書チェックの確認が途中で止まった', String(err));
  } finally {
    // 起こした実行を止め、伝えたことにしておく（残すと、次の回の音声の確認（第 42 節）で伝える結果として会話ログに入る）
    for (const r of (await call('a', '/v1/secretary/lookups', {}, 'member')).body.items ?? []) {
      if (!r.done) await call('a', `/v1/runs/${r.runId}/cancel`, { method: 'POST' }, 'member');
    }
    await sleep(1500);
    await call('a', '/v1/secretary/lookups/claim', { method: 'POST' }, 'member');
    await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  }
}

console.log('\n■ 59. 社内のお知らせと朝のブリーフの中身（第10.15節・第9.5.5.1.1節、ADR-0047）');
{
  const made = [];
  let groupId = null;
  try {
    // 全員宛て: A 社の一般の人に載り、B 社には載らない（不変則 I-2）
    const all = await call('a', '/v1/notices', {
      method: 'POST',
      body: JSON.stringify({ title: '確認用: 年末調整の書類', body: '12/5 までに総務へ', all: true, dueOn: '2099-12-05' }),
    }, 'member');
    if (all.body?.notice?.id) made.push(all.body.notice.id);
    all.status === 201 && all.body.notice.until === '2099-12-05' ? ok('一般の人もお知らせを出せる。締切の日まで載せる') : ng('お知らせを出せない', JSON.stringify(all.body));
    const { body: forAdmin } = await call('a', '/v1/notices');
    const mineA = (forAdmin.items ?? []).find((n) => n.id === all.body?.notice?.id);
    mineA?.isNew && typeof mineA.daysLeft === 'number' ? ok('全員宛てのお知らせが、ほかの人の一覧に載る（初めて載せるもの・締切までの日数つき）') : ng('全員宛てが載らない', JSON.stringify(forAdmin));
    const { body: forB } = await call('b', '/v1/notices');
    !(forB.items ?? []).some((n) => n.title?.startsWith('確認用:')) ? ok('ほかの会社には載らない') : ng('ほかの会社に載った');
    const crossWithdraw = await call('b', `/v1/notices/${all.body?.notice?.id}/withdraw`, { method: 'POST' });
    crossWithdraw.status === 404 ? ok('ほかの会社の管理者は取り下げられない（404）') : ng(`取り下げられた（${crossWithdraw.status}）`);

    // 入力の確かめ
    const bad = await call('a', '/v1/notices', { method: 'POST', body: JSON.stringify({ title: '確認用: x', link: 'http://example.jp', all: true }) }, 'member');
    bad.status === 400 ? ok('https でないリンクは受け付けない') : ng(`受け付けた（${bad.status}）`);
    const foreign = await call('b', '/v1/admin/groups', { method: 'POST', body: JSON.stringify({ name: '確認用-お知らせ' }) });
    const toForeign = await call('a', '/v1/notices', { method: 'POST', body: JSON.stringify({ title: '確認用: x', all: false, groupIds: [foreign.body?.id] }) });
    toForeign.status === 400 ? ok('ほかの会社のグループを宛先にできない') : ng(`宛先にできた（${toForeign.status}）`);
    if (foreign.body?.id) await call('b', `/v1/admin/groups/${foreign.body.id}`, { method: 'DELETE' });

    // グループ宛て: 所属していない人には載らない
    const g = await call('a', '/v1/admin/groups', { method: 'POST', body: JSON.stringify({ name: '確認用-お知らせ' }) });
    groupId = g.body?.id ?? null;
    const grp = await call('a', '/v1/notices', { method: 'POST', body: JSON.stringify({ title: '確認用: 健康診断の申し込み', link: 'https://example.jp/kenshin', all: false, groupIds: [groupId] }) });
    if (grp.body?.notice?.id) made.push(grp.body.notice.id);
    const { body: memberList } = await call('a', '/v1/notices', {}, 'member');
    grp.status === 201 && !(memberList.items ?? []).some((n) => n.id === grp.body.notice.id)
      ? ok('グループ宛てのお知らせは、所属していない人に載らない') : ng('グループの外の人に載った', JSON.stringify(memberList));

    // 済んだ・取り下げ
    const done = await call('a', `/v1/notices/${all.body?.notice?.id}/done`, { method: 'POST' });
    const { body: afterDone } = await call('a', '/v1/notices');
    done.status === 200 && !(afterDone.items ?? []).some((n) => n.id === all.body?.notice?.id)
      ? ok('済んだとしたら、その人には載せない') : ng('済んだ後も載る');
    const byOther = await call('a', `/v1/notices/${grp.body?.notice?.id}/withdraw`, { method: 'POST' }, 'member');
    byOther.status === 403 ? ok('出していない一般の人は取り下げられない（403）') : ng(`取り下げられた（${byOther.status}）`);
    const byAuthor = await call('a', `/v1/notices/${all.body?.notice?.id}/withdraw`, { method: 'POST' }, 'member');
    byAuthor.status === 200 ? ok('出した人は取り下げられる') : ng(`取り下げられない（${byAuthor.status}）`);
    const { body: audit } = await call('a', '/v1/admin/audit-events?limit=100');
    const acts = new Set((audit.items ?? []).map((e) => e.action));
    acts.has('notice.create') && acts.has('notice.withdraw') ? ok('出す・取り下げるを監査ログに残す') : ng('監査ログに無い');

    // 朝のブリーフの中身（個人設定の brief）
    const before = (await call('a', '/v1/me/settings', {}, 'member')).body.brief;
    const save = await call('a', '/v1/me/settings/brief', {
      method: 'PUT',
      body: JSON.stringify({
        topics: [{ label: '技術の動き', query: '生成AI 最新ニュース' }, { label: '', query: '空の名前' }],
        omit: ['weather', 'notices'], seededAt: null, seedNote: true,
      }),
    }, 'member');
    const after = (await call('a', '/v1/me/settings', {}, 'member')).body.brief;
    save.status === 200 && after.topics.length === 1 && after.omit.join() === 'weather'
      ? ok('朝のブリーフの中身を保存できる。名前の無い分野と、外せないお知らせは受け付けない') : ng('中身を保存できない', JSON.stringify(after));
    after.seededAt && after.seedNote === (before?.seedNote ?? false)
      ? ok('秘書が選んだ印は画面から変えられない（分野を消しても選び直さない）') : ng('印が画面から変わった', JSON.stringify(after));
    await call('a', '/v1/me/settings/brief', { method: 'PUT', body: JSON.stringify({ topics: before?.topics ?? [], omit: before?.omit ?? [] }) }, 'member');

  } catch (err) {
    ng('お知らせの確認が途中で止まった', String(err));
  } finally {
    for (const id of made) await call('a', `/v1/notices/${id}/withdraw`, { method: 'POST' });
    if (groupId) await call('a', `/v1/admin/groups/${groupId}`, { method: 'DELETE' });
  }
}

console.log('\n■ 60. 在庫管理（内蔵の拡張。第29章、ADR-0045）');
{
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const tag = `確認用在庫${Date.now().toString(36)}`;
  // 場所は品目と別の名前にする（品目の名前を場所と取り違えないことも確かめる）
  const place = `確認用場所${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  const { rows: saved } = await owner.query(`select tenant_id, inventory from tenant_settings where tenant_id in ('t-alpha', 't-beta')`);
  try {
    // 既定は切り（第29.2節）。切っている会社には画面も API も出さない
    await call('b', '/v1/admin/extensions/inventory/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    const offB = await call('b', '/v1/inventory');
    const { body: meB } = await call('b', '/v1/me');
    offB.status === 403 && meB.inventory === false ? ok('在庫管理を切っている会社では、API も左のメニューも使えない') : ng('切っていても使える', `${offB.status} ${meB.inventory}`);
    await call('a', '/v1/admin/extensions/inventory/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const feat = await call('a', '/v1/admin/extensions/inventory/settings', { method: 'PUT', body: JSON.stringify({ features: { lots: true, units: true }, lowDefault: 3 }) });
    const { body: meA } = await call('a', '/v1/me', {}, 'member');
    feat.body?.inventory?.features?.lots === true && meA.inventory === true ? ok('管理者が入れると使え、機能を会社ごとに入り切りできる') : ng('入れられない', JSON.stringify(feat.body));
    const memberSettings = await call('a', '/v1/admin/extensions/inventory/settings', { method: 'PUT', body: JSON.stringify({ lowDefault: 99 }) }, 'member');
    memberSettings.status === 403 ? ok('在庫管理の設定を変えられるのは管理者だけ') : ng(`一般の人が変えられる（${memberSettings.status}）`);

    // 品目と場所
    const made = await call('a', '/v1/inventory/items', { method: 'POST', body: JSON.stringify({ name: `${tag} ハンドクリーム`, unit: '個', packUnit: '箱', packSize: 10, codes: ['4912345678904'] }) }, 'member');
    const itemId = made.body?.item?.id;
    made.status === 201 && made.body.item.codes?.includes('4912345678904') ? ok('一般の人も品目を作れる（バーコードつき）') : ng('品目を作れない', JSON.stringify(made.body));
    const withQty = await call('a', '/v1/inventory/items', { method: 'POST', body: JSON.stringify({ name: `${tag} トナー`, unit: '3' }) }, 'member');
    withQty.status === 201 && withQty.body.item?.unit === '個' && withQty.body.item?.onHand === 3 && /はじめの数/.test(withQty.body.note ?? '')
      ? ok('品目を作るとき、単位の欄の数ははじめの数として読み、単位は呼び名にする') : ng('単位の欄の数の読み方が違う', JSON.stringify(withQty.body));
    const unitFix = await call('a', `/v1/inventory/items/${withQty.body?.item?.id}`, { method: 'PUT', body: JSON.stringify({ unit: '5' }) }, 'member');
    unitFix.status === 400 ? ok('品目を直すときに単位の欄へ数を入れると断る') : ng(`単位に数を入れられた（${unitFix.status}）`);
    const dup = await call('a', '/v1/inventory/items', { method: 'POST', body: JSON.stringify({ name: `${tag} 別の品`, codes: ['4912345678904'] }) });
    dup.status === 400 ? ok('同じバーコードは、会社の中で別の品目に付けられない') : ng(`重なった（${dup.status}）`);
    const shelfA = (await call('a', '/v1/inventory/locations', { method: 'POST', body: JSON.stringify({ warehouse: place, shelf: '棚A' }) })).body?.location;
    const shelfB = (await call('a', '/v1/inventory/locations', { method: 'POST', body: JSON.stringify({ warehouse: place, shelf: '店頭' }) })).body?.location;

    // 入出庫（第29.8節・第29.9節）
    const in1 = await call('a', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'in', itemId, qty: 1, unit: 'pack', locationId: shelfA?.id, lot: 'LATE', expiresOn: '2099-06-30' }) }, 'member');
    const in2 = await call('a', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'in', itemId, qty: 5, locationId: shelfA?.id, lot: 'EARLY', expiresOn: '2099-01-31' }) }, 'member');
    in1.status === 201 && in1.body.moves?.[0]?.delta === 10 && in2.body?.item?.available === 15
      ? ok('入庫を仕入れの単位で入れると、入り数で使う単位に直す（1 箱 → 10 個）') : ng('入庫が合わない', JSON.stringify(in2.body?.item ?? in1.body));
    const used = await call('a', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'out', itemId, qty: 7, reason: '販売' }) }, 'member');
    const lots = (used.body?.moves ?? []).map((m) => `${m.lot}:${m.delta}`).join(',');
    used.status === 201 && lots === 'EARLY:-5,LATE:-2' ? ok('使用は、使用期限の近いロットから減らす') : ng('減らす順が違う', lots);
    const moved = await call('a', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'transfer', itemId, qty: 3, locationId: shelfA?.id, toLocationId: shelfB?.id }) }, 'member');
    const { body: detail } = await call('a', `/v1/inventory/items/${itemId}`, {}, 'member');
    const at = (loc) => (detail.stock ?? []).filter((s) => s.locationId === loc).reduce((a, s) => a + s.qty, 0);
    moved.status === 201 && at(shelfA?.id) === 5 && at(shelfB?.id) === 3 && detail.item?.onHand === 8
      ? ok('移動は元から減らして先に足し、合計は変わらない') : ng('移動が合わない', JSON.stringify(detail.stock));
    const over = await call('a', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'out', itemId, qty: 20 }) });
    over.status === 201 && over.body.item?.onHand < 0 && (over.body.warnings ?? []).some((w) => w.includes('マイナス'))
      ? ok('在庫より多い使用も記録は受け付け、マイナスになったことを知らせる') : ng('マイナスの扱いが違う', JSON.stringify(over.body));

    // 取り消し（逆の記録を足す。自分の記録・その日のうち・二度は取り消さない）
    const byOther = await call('a', `/v1/inventory/moves/${over.body?.moves?.[0]?.id}/undo`, { method: 'POST' }, 'member');
    byOther.status === 400 ? ok('ほかの人の記録は取り消せない') : ng(`取り消せた（${byOther.status}）`);
    const undo = await call('a', `/v1/inventory/moves/${over.body?.moves?.[0]?.id}/undo`, { method: 'POST' });
    const again = await call('a', `/v1/inventory/moves/${over.body?.moves?.[0]?.id}/undo`, { method: 'POST' });
    undo.status === 201 && undo.body.item?.onHand === 8 && again.status === 400 ? ok('自分の記録はその日のうちなら取り消せ、二度は取り消せない') : ng('取り消しが合わない', `${undo.status} ${undo.body?.item?.onHand} ${again.status}`);
    const adjNoReason = await call('a', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'adjust', itemId, qty: -1 }) });
    adjNoReason.status === 400 ? ok('調整には理由が要る') : ng(`理由なしで調整できた（${adjNoReason.status}）`);

    // 入出庫の記録は追記のみ（アプリのロールに更新と削除を許さない。第29.9節）
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office' });
    await app.connect();
    const tryWrite = async (sql) => {
      await app.query('begin');
      await app.query(`select set_config('app.tenant_id', 't-alpha', true)`);
      const r = await app.query(sql, [itemId]).then(() => 'done', (e) => e.message);
      await app.query('rollback');
      return r;
    };
    const upd = await tryWrite(`update inventory_moves set delta = 999 where item_id = $1`);
    const del = await tryWrite(`delete from inventory_moves where item_id = $1`);
    /permission denied/.test(upd) && /permission denied/.test(del) ? ok('入出庫の記録は、アプリから書き換えも削除もできない') : ng('記録を書き換えられる', `${upd} / ${del}`);
    await app.query('begin');
    await app.query(`select set_config('app.tenant_id', 't-beta', true)`);
    const { rows: [seen] } = await app.query(`select count(*)::int as n from inventory_moves where item_id = $1`, [itemId]);
    await app.query('commit');
    await app.end();
    seen.n === 0 ? ok('B 社を設定したつなぎからは、A 社の入出庫の記録が見えない（RLS）') : ng(`見えてしまう（${seen.n} 行）`);

    // 会社の境界（不変則 I-2）。B 社も入れて、A 社の品目を引けないことを確かめる
    await call('b', '/v1/admin/extensions/inventory/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const crossGet = await call('b', `/v1/inventory/items/${itemId}`);
    const crossMove = await call('b', '/v1/inventory/moves', { method: 'POST', body: JSON.stringify({ kind: 'out', itemId, qty: 1 }) });
    const crossCode = await call('b', '/v1/inventory/lookup?code=4912345678904');
    crossGet.status === 404 && crossMove.status === 404 && crossCode.body?.item === null
      ? ok('B 社からは、A 社の品目を見ることも記録することもバーコードで引くこともできない') : ng('他社の品目に届く', `${crossGet.status} ${crossMove.status}`);

    // バーコード（GS1 は使用期限とロットも取り出す。第29.11節）
    const gs1 = await call('a', `/v1/inventory/lookup?code=${encodeURIComponent('(01)04912345678904(17)270200(10)LOT-9')}`, {}, 'member');
    gs1.body?.item?.id === itemId && gs1.body.parsed?.expiresOn === '2027-02-28' && gs1.body.parsed?.lot === 'LOT-9'
      ? ok('GS1 のバーコードから品目・使用期限・ロットを取り出す') : ng('GS1 を読めない', JSON.stringify(gs1.body));

    // 止める・外す（管理者。在庫が残れば止められない）
    const stopByMember = await call('a', `/v1/inventory/items/${itemId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'stopped' }) }, 'member');
    const stopWithStock = await call('a', `/v1/inventory/items/${itemId}/status`, { method: 'PUT', body: JSON.stringify({ status: 'stopped' }) });
    const removeWithStock = await call('a', `/v1/inventory/locations/${shelfA?.id}`, { method: 'DELETE' });
    stopByMember.status === 403 && stopWithStock.status === 400 && removeWithStock.status === 400
      ? ok('品目を止め・場所を外せるのは管理者で、在庫が残っていれば断る') : ng('止め・外しが合わない', `${stopByMember.status} ${stopWithStock.status} ${removeWithStock.status}`);

    // 取り込みと書き出し（第29.6節）
    const form = new FormData();
    form.append('file', new Blob([`品番,商品名,入数,在庫数量,保管場所\n${tag}-1,${tag} コピー用紙,5,12,${place}\n${tag}-2,,,1,\n`], { type: 'text/csv' }), 'items.csv');
    const imp = await fetch(`${API}/v1/inventory/import`, { method: 'POST', body: form, headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } }).then((r) => r.json());
    imp.created === 1 && imp.stocked === 1 && imp.skipped?.[0]?.row === 3 && imp.mapping?.find((m) => m.header === '商品名')?.field === 'name'
      ? ok('CSV の見出しを読んで品目を取り込み、取り込めない行は行の番号と理由を返す') : ng('取り込みが合わない', JSON.stringify(imp));
    const exp = await fetch(`${API}/v1/inventory/export?format=csv`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    // text() は BOM を落とすため、バイト列で確かめる
    const bytes = new Uint8Array(await exp.arrayBuffer());
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    exp.status === 200 && bom && new TextDecoder().decode(bytes).includes(`${tag} コピー用紙`)
      ? ok('品目と数を CSV（BOM 付き）で書き出せる') : ng(`書き出せない（${exp.status}・BOM ${bom}）`);
    const { body: audit } = await call('a', '/v1/admin/audit-events?category=inventory&limit=50');
    const acts = new Set((audit.items ?? []).map((e) => e.action));
    acts.has('inventory.import') && acts.has('inventory.export') && !acts.has('inventory.move')
      ? ok('取り込み・書き出しは監査ログの「在庫」に残し、入出庫の 1 件ずつは入れない') : ng('監査ログが合わない', [...acts].join(','));

    // 棚卸し（第29.10節）。会社で 1 つ・数えた時点の帳簿と比べる・確定で差を調整にする・確定できる人
    const cStart = await call('a', '/v1/inventory/counts', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
    const countId = cStart.body?.view?.count?.id;
    const cAgain = await call('a', '/v1/inventory/counts', { method: 'POST', body: JSON.stringify({ scope: 'all' }) }, 'member');
    cStart.status === 201 && cAgain.status === 200 && cAgain.body?.view?.count?.id === countId
      ? ok('棚卸しは会社で 1 つ。ほかの人が始めると、開いている棚卸しを続ける') : ng('棚卸しが 2 つ開く', `${cStart.status} ${cAgain.status}`);
    const tonerId = withQty.body?.item?.id;
    await call('a', `/v1/inventory/counts/${countId}/lines`, { method: 'POST', body: JSON.stringify({ itemId: tonerId, qty: 1 }) }, 'member');
    const cLine = await call('a', `/v1/inventory/counts/${countId}/lines`, { method: 'POST', body: JSON.stringify({ itemId: tonerId, qty: 1 }) });
    cLine.status === 201 && cLine.body?.row?.counted === 2 && cLine.body?.row?.book === 3 && cLine.body?.row?.diff === -1
      ? ok('棚卸し: 読むたびに足し、ほかの人が数えた分も足し合わせ、帳簿との差を出す') : ng('数えられない', JSON.stringify(cLine.body));
    const cByMember = await call('a', `/v1/inventory/counts/${countId}/close`, { method: 'POST' }, 'member');
    const cClose = await call('a', `/v1/inventory/counts/${countId}/close`, { method: 'POST' });
    const { body: tonerAfter } = await call('a', `/v1/inventory/items/${tonerId}`);
    cByMember.status === 403 && cClose.status === 200 && cClose.body?.adjusted >= 1 && tonerAfter.item?.onHand === 2 && tonerAfter.moves?.[0]?.reason === '棚卸し'
      ? ok('棚卸しの確定は始めた人と管理者だけ。差の分を理由「棚卸し」の調整にする') : ng('確定が合わない', `${cByMember.status} ${cClose.status} ${tonerAfter.item?.onHand}`);
    // 見張り（第29.14節）。棚卸しで 2 個になったトナーは残りわずか（目安 3）。記録した人に「在庫」のお知らせがその場で届く
    await sleep(800);
    const { body: memberNotes } = await call('a', '/v1/notifications', {}, 'member');
    const invNote = (memberNotes.items ?? []).find((n) => n.kind === 'inventory' && n.title.includes(`${tag} トナー`));
    invNote && /発注の案/.test(invNote.body) ? ok('残りわずかになった品目を、記録した人にその場で知らせる（発注の案つき）') : ng('在庫の知らせが届かない', JSON.stringify((memberNotes.items ?? []).slice(0, 3)));
    // 仕入先と発注の案（第29.4.1節・第29.14節）
    const badSupplier = await call('a', '/v1/inventory/suppliers', { method: 'POST', body: JSON.stringify({ name: `${tag} 文具`, method: 'web', contact: 'http://insecure.example' }) });
    const webSupplier = (await call('a', '/v1/inventory/suppliers', { method: 'POST', body: JSON.stringify({ name: `${tag} 文具`, method: 'web', contact: 'https://order.example.jp', leadDays: 3 }) })).body?.supplier;
    badSupplier.status === 400 && webSupplier?.id ? ok('仕入先を登録できる（Web の発注の画面は https だけ）') : ng('仕入先を登録できない', JSON.stringify(badSupplier.body));
    await call('a', `/v1/inventory/items/${tonerId}`, { method: 'PUT', body: JSON.stringify({ supplierId: webSupplier?.id }) });
    const { body: fc } = await call('a', '/v1/inventory/forecast', {}, 'member');
    const tonerRow = (fc.rows ?? []).find((r) => r.itemId === tonerId);
    tonerRow?.low && tonerRow.proposal?.supplierName === `${tag} 文具` && tonerRow.leadDays === 3 && tonerRow.proposal.qty > 0
      ? ok('見張りの結果に、仕入先と仕入れの日数を使った発注の案が出る') : ng('発注の案が合わない', JSON.stringify(tonerRow));
    const webOrder = await call('a', '/v1/inventory/orders', { method: 'POST', body: JSON.stringify({ supplierId: webSupplier?.id, lines: [{ itemId: tonerId, qty: 5 }] }) }, 'member');
    webOrder.status === 200 && webOrder.body?.method === 'web' && webOrder.body?.contact === 'https://order.example.jp' && /トナー: 5 個/.test(webOrder.body?.text ?? '')
      ? ok('Web の仕入先は、発注の画面と伝える内容を返す（何も送らない）') : ng('Web の発注の内容が合わない', JSON.stringify(webOrder.body));
    const mailSupplier = (await call('a', '/v1/inventory/suppliers', { method: 'POST', body: JSON.stringify({ name: `${tag} 問屋`, method: 'mail', contact: 'order@example.jp' }) })).body?.supplier;
    const mailOrder = await call('a', '/v1/inventory/orders', { method: 'POST', body: JSON.stringify({ supplierId: mailSupplier?.id, lines: [{ itemId: tonerId, qty: 5 }] }) }, 'member');
    if (mailOrder.status === 201) {
      const run = await waitFor('a', mailOrder.body.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
      const sent = (run?.steps ?? []).some((st) => (st.output?.tools ?? []).some((t) => t.name === 'gmail.send'));
      run?.run?.status === 'awaiting_approval' || !sent
        ? ok('メールの仕入先は「発注の下書き」を起こし、承認の前には送らない') : ng('承認の前に発注のメールを送った', run?.run?.status);
      if (run?.run?.status === 'awaiting_approval') await call('a', `/v1/runs/${mailOrder.body.runId}/cancel`, { method: 'POST' }, 'member');
    } else {
      mailOrder.status === 409 ? ok('発注の下書きを使えない会社では、使えないと答える（409）') : ng(`発注を始められない（${mailOrder.status}）`, JSON.stringify(mailOrder.body));
    }
    // 納品書（第29.9節）。見本の推論では読み取れないため、読めなかったと答えて何も入庫しない
    const slipForm = new FormData();
    slipForm.append('file', new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], { type: 'image/png' }), 'slip.png');
    const slipRes = await fetch(`${API}/v1/inventory/slips`, { method: 'POST', body: slipForm, headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    const slipBody = await slipRes.json();
    slipRes.status === 422 && slipBody.read?.ok === false && (slipBody.recorded ?? []).length === 0
      ? ok('納品書として読めなければ、何も入庫せずに理由を返す') : ng('納品書の扱いが違う', `${slipRes.status} ${JSON.stringify(slipBody).slice(0, 200)}`);

    const labels = await fetch(`${API}/v1/inventory/locations/labels.pdf`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    const labelHead = new TextDecoder().decode(new Uint8Array(await labels.arrayBuffer()).slice(0, 5));
    labels.status === 200 && labels.headers.get('content-type') === 'application/pdf' && labelHead === '%PDF-'
      ? ok('棚のラベル（QR）を A4 に並べた PDF を出せる') : ng(`ラベルの PDF を出せない（${labels.status}）`);
    // スマホ用のページ（第29.11.1節）。ラベルの QR の URL から棚を引ける・「スマホで開く」の QR を出せる
    const byUrl = await call('a', `/v1/inventory/lookup?code=${encodeURIComponent(`http://a.lvh.me:3100/m/inventory?shelf=${encodeURIComponent(shelfA?.labelKey ?? '')}`)}`, {}, 'member');
    const qr = await fetch(`${API}/v1/inventory/mobile-qr.svg`, { headers: { 'x-tenant': 'a', 'x-user': 'member@alpha.example.jp' } });
    const qrText = await qr.text();
    byUrl.body?.location?.id === shelfA?.id && qr.status === 200 && qrText.includes('<svg')
      ? ok('棚のラベルの QR（スマホ用のページの URL）から棚を引け、「スマホで開く」の QR を出せる') : ng('スマホ用のページの入口が働かない', `${JSON.stringify(byUrl.body?.location ?? null)} ${qr.status}`);

    // 秘書の在庫の問い（第29.15節）。推論に選ばせず、在庫の表を引いてその場で答える
    const { body: askStock } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: `${tag} ハンドクリームの在庫は？` }) }, 'member');
    askStock.layer === 'direct' && /使える数 8 個/.test(askStock.text ?? '')
      ? ok('秘書に在庫を尋ねると、在庫の表を引いてその場で答える') : ng('秘書が在庫を答えない', JSON.stringify(askStock));
    const { body: askPlace } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: `${place}店頭の在庫はいくつ？` }) }, 'member');
    askPlace.layer === 'direct' && /店頭にある品目は 1 件です/.test(askPlace.text ?? '') && /使える数 3 個/.test(askPlace.text ?? '')
      ? ok('場所を言われたら、その場所の数で答える') : ng('場所の数で答えない', JSON.stringify(askPlace));
    const { body: askNone } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: `${tag}ボールペンの在庫は？` }) }, 'member');
    /在庫管理にありません/.test(askNone.text ?? '') ? ok('無い品目は「ありません」と答え、推測しない') : ng('無い品目の答えが違う', askNone.text);

    // 予約との引き当て（第29.13節）。取り置くと使える数から引き、来たら使用・来なければ戻す
    await call('a', '/v1/admin/extensions/inventory/settings', { method: 'PUT', body: JSON.stringify({ features: { lots: true, units: true, reserve: true } }) });
    const setId = (await call('a', '/v1/inventory/items', { method: 'POST', body: JSON.stringify({ name: `${tag} 体験セット`, unit: '個', initialQty: 5 }) })).body?.item?.id;
    const held = await call('a', '/v1/inventory/bookings', { method: 'POST', body: JSON.stringify({ itemId: setId, qty: 2, startsAt: '2099-01-10 14:00', externalId: `${tag}-R1` }) }, 'member');
    const afterHold = (await call('a', `/v1/inventory/items/${setId}`, {}, 'member')).body?.item;
    held.status === 201 && afterHold?.onHand === 5 && afterHold?.available === 3
      ? ok('予約で取り置くと、ある数はそのままで使える数から引く') : ng('取り置きが使える数に効かない', `${held.status} ${JSON.stringify(afterHold)}`);
    const cancelled = await call('a', `/v1/inventory/bookings/${held.body?.booking?.id}/cancel`, { method: 'POST' }, 'member');
    const afterCancel = (await call('a', `/v1/inventory/items/${setId}`, {}, 'member')).body?.item;
    cancelled.status === 200 && afterCancel?.available === 5 ? ok('取り置きを取り消すと、使える数に戻る') : ng('取り消しで戻らない', JSON.stringify(afterCancel));
    // 予約の受け口（第29.13.1節）。作れるのは管理者だけで、URL は作ったときだけ返す
    const srcByMember = await call('a', '/v1/admin/extensions/inventory/booking-sources', { method: 'POST', body: JSON.stringify({ name: `${tag} 予約` }) }, 'member');
    const src = await call('a', '/v1/admin/extensions/inventory/booking-sources', { method: 'POST', body: JSON.stringify({ name: `${tag} 予約` }) });
    const hookKey = String(src.body?.url ?? '').split('/').pop();
    const { body: srcList } = await call('a', '/v1/admin/extensions/inventory/booking-sources');
    srcByMember.status === 403 && src.status === 201 && /\/v1\/hooks\/inventory\/[A-Za-z0-9_-]{32}$/.test(src.body?.url ?? '') && !JSON.stringify(srcList).includes(hookKey)
      ? ok('予約の受け口を作れるのは管理者だけで、送り先の URL は作ったときだけ返す') : ng('受け口の作り方が違う', `${srcByMember.status} ${src.status} ${src.body?.url}`);
    await call('a', '/v1/inventory/menus', { method: 'POST', body: JSON.stringify({ menu: `${tag} 体験コース`, items: [{ itemId: setId, qty: 1 }] }) }, 'member');
    const hook = (body) => fetch(`${API}/v1/hooks/inventory/${hookKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const pii = { id: `${tag}-EXT`, startsAt: '2099-01-11T10:00:00+09:00', menu: `${tag} 体験コース`, status: 'booked', customer: { name: '確認 花子', phone: '090-0000-0000' } };
    const h1 = await hook(pii);
    const h2 = await hook({ ...pii, startsAt: '2099-01-11T11:00:00+09:00' });
    const { rows: extRows } = await owner.query(`select row_to_json(b)::text as j, starts_at from inventory_bookings b where external_id = $1`, [`${tag}-EXT`]);
    const afterHook = (await call('a', `/v1/inventory/items/${setId}`, {}, 'member')).body?.item;
    h1.status === 200 && h2.status === 200 && extRows.length === 1 && new Date(extRows[0].starts_at).toISOString() === '2099-01-11T02:00:00.000Z' && afterHook?.available === 4
      ? ok('受け口に届いた予約を、覚えたメニューから取り置き、同じ予約は日時を直す') : ng('受け口の予約が合わない', `${h1.status} ${h2.status} ${extRows.length} ${afterHook?.available}`);
    extRows.length === 1 && !/確認 花子|090-0000-0000/.test(extRows[0].j) ? ok('予約した人の名前・電話番号は残さない') : ng('予約した人の情報が残った');
    const badKey = await fetch(`${API}/v1/hooks/inventory/${'x'.repeat(32)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pii) });
    badKey.status === 404 ? ok('知らない鍵の受け口は 404') : ng(`知らない鍵が通った（${badKey.status}）`);
    const extId = (await call('a', '/v1/inventory/bookings', {}, 'member')).body?.bookings?.find((b) => b.externalId === `${tag}-EXT`)?.id;
    const usedBooking = await call('a', `/v1/inventory/bookings/${extId}/use`, { method: 'POST' }, 'member');
    const afterUse = (await call('a', `/v1/inventory/items/${setId}`, {}, 'member')).body?.item;
    usedBooking.status === 200 && afterUse?.onHand === 4 && afterUse?.available === 4 ? ok('予約の人が来たら、取り置きを使用の記録にする') : ng('使ったが記録されない', JSON.stringify(afterUse));
    await call('a', `/v1/admin/extensions/inventory/booking-sources/${src.body?.source?.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'stopped' }) });
    const stopped = await hook({ ...pii, id: `${tag}-EXT2` });
    stopped.status === 404 ? ok('止めた受け口は受け取らない') : ng(`止めた受け口が受け取った（${stopped.status}）`);

    // 左のメニュー（第6.1.1節）と入り切り（第12.13節）
    const { body: mySettings } = await call('a', '/v1/me/settings', {}, 'member');
    const pin = await call('a', '/v1/me/settings/menu', { method: 'PUT', body: JSON.stringify({ ...mySettings.menu, pinned: ['inventory'] }) }, 'member');
    const { body: afterPin } = await call('a', '/v1/me/settings', {}, 'member');
    await call('a', '/v1/me/settings/menu', { method: 'PUT', body: JSON.stringify(mySettings.menu) }, 'member');
    pin.status === 200 && afterPin.menu?.pinned?.includes('inventory') ? ok('在庫管理も業務の 1 つとしてピン止めできる') : ng('ピン止めできない', JSON.stringify(afterPin.menu));
    await call('a', '/v1/admin/extensions/inventory/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    const offA = await call('a', `/v1/inventory/items/${itemId}`, {}, 'member');
    await call('a', '/v1/admin/extensions/inventory/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const backA = await call('a', `/v1/inventory/items/${itemId}`, {}, 'member');
    offA.status === 403 && backA.status === 200 && backA.body.item?.onHand === 8 ? ok('切ると使えず、入れ直すと記録が戻る') : ng('入り切りが効かない', `${offA.status} ${backA.status}`);
    const del2 = await call('a', '/v1/admin/extensions/inventory', { method: 'DELETE' });
    del2.status === 409 ? ok('内蔵の拡張は削除できない（スイッチで切る）') : ng(`削除できた（${del2.status}）`);
  } catch (err) {
    ng('在庫管理の確認が途中で止まった', String(err));
  } finally {
    // 確認用の品目と記録を消す（アプリからは消せないため、持ち主のつなぎで消す）
    const items = `select id from inventory_items where name like '${tag}%'`;
    await owner.query(`delete from inventory_reservations where item_id in (${items})`);
    await owner.query(`delete from inventory_bookings where external_id like '${tag}%'`);
    await owner.query(`delete from inventory_booking_sources where name like '${tag}%'`);
    await owner.query(`delete from inventory_menu_items where menu_key like '${tag}%'`);
    await owner.query(`delete from inventory_count_lines where item_id in (${items})`);
    await owner.query(`update inventory_items set supplier_id = null where name like '${tag}%'`);
    await owner.query(`delete from inventory_suppliers where name like '${tag}%'`);
    await owner.query(`delete from notifications where kind = 'inventory' and title like '%${tag}%'`);
    await owner.query(`delete from inventory_counts where tenant_id in ('t-alpha', 't-beta') and started_at >= $1`, [startedAt]);
    await owner.query(`delete from inventory_stock where item_id in (${items})`);
    await owner.query(`delete from inventory_moves where item_id in (${items})`);
    await owner.query(`delete from inventory_lots where item_id in (${items})`);
    await owner.query(`delete from inventory_codes where item_id in (${items})`);
    await owner.query(`delete from inventory_items where name like '${tag}%'`);
    // 確認の間にできた場所（既定の「倉庫」を含む）も消す。在庫の残る場所は残す
    await owner.query(`delete from inventory_locations l where tenant_id in ('t-alpha', 't-beta') and (warehouse = $1 or warehouse = $3 or created_at >= $2)
      and not exists (select 1 from inventory_moves m where m.from_location_id = l.id or m.to_location_id = l.id)`, [tag, startedAt, place]);
    for (const r of saved) await owner.query(`update tenant_settings set inventory = $2 where tenant_id = $1`, [r.tenant_id, r.inventory ? JSON.stringify(r.inventory) : null]);
    await owner.end();
  }
}

console.log('\n■ 61. 人事・給与（内蔵の拡張。第30章、段 1: 台帳と手続き）');
{
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const tag = `確認用人事${Date.now().toString(36)}`;
  const hrStartedAt = new Date().toISOString();
  const { rows: saved } = await owner.query(`select tenant_id, hr from tenant_settings where tenant_id in ('t-alpha', 't-beta')`);
  const { body: compsBefore } = await call('a', '/v1/admin/compartments');
  const hrComp = (compsBefore.items ?? []).find((c) => c.name === 'hr');
  try {
    // 既定は切り（第30.2節）。切っている会社では担当者の API も使えない
    await call('b', '/v1/admin/extensions/hr/enabled', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    const offB = await call('b', '/v1/hr/employees');
    offB.status === 403 ? ok('人事・給与を切っている会社では、担当者の API を使えない') : ng(`切っていても使える（${offB.status}）`);
    const on = await call('a', '/v1/admin/extensions/hr/enabled', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    const { body: meA } = await call('a', '/v1/me');
    const { body: comps } = await call('a', '/v1/admin/compartments');
    const hr = (comps.items ?? []).find((c) => c.name === 'hr');
    on.status === 200 && meA.hr === true && hr?.enabled
      ? ok('管理者が入れると、人事区画 hr を用意し、入れた管理者が担当者の画面を使える') : ng('入れても使えない', JSON.stringify({ status: on.status, hr: meA.hr, comp: hr }));
    const set = await call('a', '/v1/admin/extensions/hr/settings', { method: 'PUT', body: JSON.stringify({ pay: { closingDay: 20, payDay: 25, payMonth: 'same' }, procedures: 'sharoushi' }) });
    const setByMember = await call('a', '/v1/admin/extensions/hr/settings', { method: 'PUT', body: JSON.stringify({ procedures: 'self' }) }, 'member');
    set.body?.hr?.pay?.closingDay === 20 && setByMember.status === 403 ? ok('人事・給与の会社の設定を変えられるのは管理者だけ') : ng('設定が合わない', `${set.status} ${setByMember.status}`);

    // 台帳と入社の手続き（第30.5節・第30.5.2節）
    const made = await call('a', '/v1/hr/employees', { method: 'POST', body: JSON.stringify({
      name: `${tag} 花子`, code: `${tag}-1`, hiredOn: '2099-04-01', employment: 'part',
      terms: { wageType: 'hourly', wageAmount: 1200, weeklyHours: 25, weeklyDays: 4, socialInsurance: true, employmentInsurance: true, work: '受付' },
    }) });
    const empId = made.body?.employee?.id;
    const { body: detail } = await call('a', `/v1/hr/employees/${empId}`);
    const hireDue = Object.fromEntries((detail.tasks ?? []).map((t) => [t.code, [t.dueOn, t.title]]));
    made.status === 201 && hireDue['social-acquire']?.[0] === '2099-04-05' && hireDue['employment-acquire']?.[0] === '2099-05-10' && /^社会保険労務士へ依頼/.test(hireDue['social-acquire']?.[1] ?? '')
      ? ok('従業員を登録すると、入社の手続きを期限つきで作る（保険の手続きは社会保険労務士への依頼として）') : ng('入社の手続きが合わない', JSON.stringify(detail.tasks));
    const dup = await call('a', '/v1/hr/employees', { method: 'POST', body: JSON.stringify({ name: `${tag} 別`, code: `${tag}-1` }) });
    dup.status === 400 ? ok('社員番号は会社の中で重ならない') : ng(`重なった（${dup.status}）`);
    const terms = await call('a', `/v1/hr/employees/${empId}/terms`, { method: 'POST', body: JSON.stringify({ effectiveOn: '2099-10-01', wageAmount: 1300 }) });
    const { body: detail2 } = await call('a', `/v1/hr/employees/${empId}`);
    terms.status === 201 && detail2.terms?.length === 2 && detail2.terms[0].wageAmount === 1300 && detail2.terms[0].weeklyHours === 25
      ? ok('雇用条件は履歴として足し、前の条件を引き継ぐ') : ng('雇用条件の履歴が合わない', JSON.stringify(detail2.terms));
    const leave = await call('a', `/v1/hr/employees/${empId}/leave`, { method: 'POST', body: JSON.stringify({ leftOn: '2099-12-15', reason: '自己都合' }) });
    const { body: detail3 } = await call('a', `/v1/hr/employees/${empId}`);
    const leaveDue = Object.fromEntries((detail3.tasks ?? []).filter((t) => t.kind === 'leave').map((t) => [t.code, t.dueOn]));
    leave.status === 200 && leaveDue['social-lose'] === '2099-12-20' && leaveDue['employment-lose'] === '2099-12-25' && leaveDue['final-pay'] === '2099-12-25'
      ? ok('退職を記録すると、資格喪失届・最後の給与などの手続きを期限つきで作る') : ng('退職の手続きが合わない', JSON.stringify(leaveDue));
    const done = await call('a', `/v1/hr/tasks/${detail3.tasks[0].id}`, { method: 'PUT', body: JSON.stringify({ done: true }) });
    done.body?.task?.doneAt ? ok('手続きを済んだにできる') : ng('済んだにできない', JSON.stringify(done.body));

    // 取り込み（見出しの言い方が違っても読む。昔の入社の手続きは作らない）
    const form = new FormData();
    form.append('file', new Blob([`従業員氏名,社員番号,入社年月日,時給,雇用形態\n${tag} 太郎,${tag}-2,2015/4/1,1100,アルバイト\n${tag} 次郎,${tag}-3,2015/13/1,1000,パート\n`], { type: 'text/csv' }), 'staff.csv');
    const imp = await fetch(`${API}/v1/hr/import`, { method: 'POST', body: form, headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
    const impBody = await imp.json();
    const { body: list } = await call('a', '/v1/hr/employees');
    const taro = (list.employees ?? []).find((e) => e.code === `${tag}-2`);
    imp.status === 200 && impBody.created === 1 && impBody.skipped?.length === 1 && taro?.employment === 'arbeit' && taro?.openTasks === 0
      ? ok('表計算から取り込み、読めない日付の行は理由を返し、昔の入社の手続きは作らない') : ng('取り込みが合わない', JSON.stringify({ impBody, taro }));
    const roster = await fetch(`${API}/v1/hr/roster?format=csv`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
    const rosterText = new TextDecoder().decode(new Uint8Array(await roster.arrayBuffer()));
    roster.status === 200 && rosterText.includes('雇入れの年月日') && rosterText.includes(`${tag} 花子`) ? ok('労働者名簿を書き出せる') : ng(`労働者名簿を書き出せない（${roster.status}）`);

    // 見ただけでも監査ログに残す（第30.21節）。値は入れない
    const { body: audit } = await call('a', '/v1/admin/audit-events?category=hr');
    const actions = new Set((audit.items ?? []).map((x) => x.action));
    const leaks = JSON.stringify(audit.items ?? []).includes(`${tag} 花子`);
    ['hr.view', 'hr.list', 'hr.employee.create', 'hr.employee.leave', 'hr.import', 'hr.export'].every((a) => actions.has(a)) && !leaks
      ? ok('台帳を見ただけでも監査ログに残し、氏名は監査ログに出さない') : ng('監査ログが合わない', `${[...actions].join(',')} leaks=${leaks}`);

    // 人事区画を止めると、担当者の画面も使えない
    await call('a', `/v1/admin/compartments/${hr.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    const offComp = await call('a', '/v1/hr/employees');
    await call('a', `/v1/admin/compartments/${hr.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
    offComp.status === 403 ? ok('人事区画を止めると、人事・給与の担当者の画面も使えない') : ng(`区画を止めても使える（${offComp.status}）`);
    const cross = await call('b', `/v1/hr/employees/${empId}`);
    cross.status === 403 || cross.status === 404 ? ok('ほかの会社の従業員は見えない') : ng(`ほかの会社から見えた（${cross.status}）`);

    // 段 2: 勤怠と有給（第30.6.1節・第30.7.1節）。台帳のメールアドレスが同じ利用者は自動で結び付く
    const staff = await call('a', '/v1/hr/employees', { method: 'POST', body: JSON.stringify({
      name: `${tag} 勤怠`, email: 'member@alpha.example.jp', hiredOn: '2024-04-01',
      terms: { wageType: 'monthly', wageAmount: 250000, weeklyHours: 40, weeklyDays: 5, startTime: '09:00', endTime: '18:00', breakMinutes: 60 },
    }) });
    const staffId = staff.body?.employee?.id;
    const { body: meM } = await call('a', '/v1/me', {}, 'member');
    const noLink = await call('a', '/v1/me/hr');
    meM.hrSelf === true && noLink.status === 404 ? ok('台帳のメールアドレスが同じ利用者は自動で結び付き、載っていない人には給与・勤怠を出さない') : ng('結び付きが合わない', `${meM.hrSelf} ${noLink.status}`);
    const in1 = await call('a', '/v1/me/hr/punch', { method: 'POST', body: JSON.stringify({ kind: 'in' }) }, 'member');
    const in2 = await call('a', '/v1/me/hr/punch', { method: 'POST', body: JSON.stringify({ kind: 'in' }) }, 'member');
    const { body: sayIn } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: '出勤' }) }, 'member');
    in1.status === 201 && in2.status === 409 && /もう出勤しています/.test(sayIn.text ?? '') ? ok('打刻は状態を見て受け付け、秘書に「出勤」と言っても同じ決まりで扱う') : ng('打刻が合わない', `${in1.status} ${in2.status} ${sayIn.text}`);
    const fix = await call('a', '/v1/me/hr/days/2026-08-03', { method: 'PUT', body: JSON.stringify({ in: '09:00', out: '20:30', breaks: [{ start: '12:00', end: '13:00' }] }) }, 'member');
    const { body: aug } = await call('a', '/v1/hr/attendance?month=2026-08');
    const augRow = (aug.rows ?? []).find((r) => r.employeeId === staffId);
    fix.body?.day?.workMinutes === 630 && fix.body.day.overtimeMinutes === 150 && augRow?.totals?.overtimeMinutes === 150
      ? ok('打刻を直すと、日と期間の法定外（8 時間を超えた分）を決まったプログラムで出す') : ng('勤怠の集計が合わない', JSON.stringify({ day: fix.body?.day, totals: augRow?.totals }));
    const closed = await call('a', '/v1/hr/attendance/close', { method: 'POST', body: JSON.stringify({ month: '2026-08' }) });
    const fixClosed = await call('a', '/v1/me/hr/days/2026-08-03', { method: 'PUT', body: JSON.stringify({ in: '09:00', out: '18:00', breaks: [] }) }, 'member');
    const reopen = await call('a', `/v1/hr/attendance/closes/${closed.body?.close?.id}/reopen`, { method: 'POST' });
    closed.status === 201 && fixClosed.status === 400 && reopen.status === 200 ? ok('締めた期間は本人が直せず、担当者が締めを戻せる') : ng('締めが合わない', `${closed.status} ${fixClosed.status} ${reopen.status}`);
    const { body: myhr } = await call('a', '/v1/me/hr', {}, 'member');
    const leaveDay = new Date(Date.now() + 9 * 3_600_000 + 7 * 86_400_000).toISOString().slice(0, 10);
    const take = await call('a', '/v1/me/hr/leave', { method: 'POST', body: JSON.stringify({ date: leaveDay, days: 1 }) }, 'member');
    const takeDup = await call('a', '/v1/me/hr/leave', { method: 'POST', body: JSON.stringify({ date: leaveDay, days: 1 }) }, 'member');
    const { body: askLeave } = await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: '有給あと何日？' }) }, 'member');
    (myhr.leave?.grants ?? []).length >= 2 && take.status === 201 && takeDup.status === 400 && /有給の残りは/.test(askLeave.text ?? '')
      ? ok('有給は入社日から自動で付与し、本人が画面と秘書から取れる（同じ日は二度取れない）') : ng('有給が合わない', JSON.stringify({ grants: myhr.leave?.grants?.length, take: take.status, dup: takeDup.status, ask: askLeave.text }));
    const { body: staffNotes } = await call('a', '/v1/notifications');
    (staffNotes.items ?? []).some((n) => n.kind === 'attendance' && n.title.includes(`${tag} 勤怠`))
      ? ok('打刻の直しと有給の申請を、人事区画の人に知らせる（種類「勤怠」）') : ng('勤怠の知らせが届かない', JSON.stringify((staffNotes.items ?? []).slice(0, 3)));
    const book = await fetch(`${API}/v1/hr/attendance/book?month=2026-08&format=csv`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
    const register = await fetch(`${API}/v1/hr/leave/register?format=csv`, { headers: { 'x-tenant': 'a', 'x-user': 'admin@alpha.example.jp' } });
    book.status === 200 && register.status === 200 ? ok('出勤簿と年次有給休暇の管理簿を書き出せる') : ng(`帳簿を書き出せない（${book.status} ${register.status}）`);
  } catch (err) {
    ng('人事・給与の確認が途中で止まった', String(err));
  } finally {
    // 確認用の従業員を消す（アプリからは消せないため、持ち主のつなぎで消す）。打刻・有給は従業員と一緒に消える
    await owner.query(`delete from notifications where kind = 'attendance' and title like '%${tag}%'`);
    await owner.query(`delete from att_closes where tenant_id = 't-alpha' and closed_at >= $1`, [hrStartedAt]);
    await owner.query(`delete from hr_employees where name like '${tag}%'`);
    for (const r of saved) await owner.query(`update tenant_settings set hr = $2 where tenant_id = $1`, [r.tenant_id, r.hr ? JSON.stringify(r.hr) : null]);
    if (hrComp) {
      await call('a', `/v1/admin/compartments/${hrComp.id}/assignment`, { method: 'PUT', body: JSON.stringify({ groups: hrComp.groups, users: hrComp.users }) });
      await call('a', `/v1/admin/compartments/${hrComp.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: hrComp.enabled }) });
    }
    await owner.end();
  }
}

console.log('');
console.log(process.exitCode ? '\x1b[31m一部の確認に失敗しました\x1b[0m' : '\x1b[32mすべての確認を通過しました\x1b[0m');
console.log('');
