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
  official.length === 5
    ? ok(`公式の業務エージェントが 5 件（${official.map((a) => a.name).join(' / ')}）`)
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
  routed.suggestedAgent?.id === 'inbox-triage'
    ? ok('作業の依頼は照会と取り違えず、受信箱整理へ取り次いだ')
    : ng('依頼を照会として処理してしまう', JSON.stringify(routed).slice(0, 160));
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
  const invitedEarly = run.steps.flatMap((s) => s.output?.tools ?? []).some((t) => t.name === 'calendar.create' && !t.error);
  run.run.status === 'awaiting_approval' && !invitedEarly
    ? ok('空きを取得し、招待の前で止まった')
    : ng(`承認待ちにならない（${run.run.status}）`);

  const approval = await approvalFor('a', body.runId, 'member');
  approval?.approverUserId === 'u-a-member'
    ? ok('依頼した本人の承認トレイに出た') : ng('本人の承認トレイに出ない');

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
  await call('a', `/v1/schedules/${brief.id}/trigger`, { method: 'POST' }, 'member');
  const deadline = Date.now() + 40000;
  let done = false;
  while (Date.now() < deadline && !done) {
    const { body: j } = await call('a', '/v1/jobs', {}, 'member');
    const latest = j.items.find((i) => i.job.agentId === 'weekly-brief');
    done = latest && Date.parse(latest.run.startedAt) > Date.now() - 45000 && latest.run.status === 'completed';
    if (!done) await sleep(1000);
  }
  const { body: after } = await call('a', '/v1/notifications', {}, 'member');
  done && after.items.length === before.items.length
    ? ok('受け取らないと決めた種類の通知は届かない') : ng('設定に反して届いた、または実行が終わらない');
  await put('notifications', { kinds: { brief: true, run: true, approval: true, failure: true }, quietHours: null });

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

  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { message: 'こんにちは' } }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  done.artifacts?.[0]?.body === 'Hello World'
    ? ok('「こんにちは」に「Hello World」と返す（見本の応答を再生）') : ng('返事が違う', JSON.stringify(done.artifacts));

  const { body: bMenu } = await call('b', '/v1/agents');
  const bRun = await call('b', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { message: 'こんにちは' } }) });
  !bMenu.agents.some((x) => x.id === AG) && bRun.status === 404
    ? ok('他の会社には現れず、実行もできない') : ng('他の会社から使えてしまう');

  const { body: helpText } = await call('a', `/v1/help/agents/${encodeURIComponent(AG)}`, {}, 'member');
  helpText.safeguards?.some((x) => x.includes('送ることはありません'))
    ? ok('拡張機能の業務にも、説明が定義から自動で付く') : ng('説明が付かない');

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

  const bad = await upload('a', await zipDir(DIR, { 'tools/run.js': 'console.log(1)' }));
  bad.status === 400 && bad.body.problems?.some((x) => x.includes('入れてはならないファイル'))
    ? ok('プログラムを含むファイルは取り込めない（400）') : ng(`取り込めてしまう（${bad.status}）`, JSON.stringify(bad.body));

  const official = await upload('a', await zipDir(new URL('../extensions/hello-world/', import.meta.url).pathname));
  official.status === 400 && official.body.problems?.some((x) => x.includes('公式の拡張機能と同じ ID'))
    ? ok('公式の拡張機能と同じ ID のファイルは取り込めない') : ng(`取り込めてしまう（${official.status}）`);

  const imp = await upload('a', await zipDir(DIR));
  imp.status === 200 && imp.body.item?.origin === 'private' && !imp.body.item.installed
    ? ok('ファイルから取り込むと、自社専用として一覧に出る（まだ導入はされない）') : ng('取り込めない', JSON.stringify(imp.body));

  const notYet = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { week: '今週' } }) });
  notYet.status === 404 ? ok('取り込んだだけでは使えない（同意して導入が必要）') : ng(`使えてしまう（${notYet.status}）`);

  const { body: bList } = await call('b', '/v1/admin/extensions');
  !bList.items?.some((x) => x.id === EXT) ? ok('取り込んだファイルは、ほかの会社には見えない') : ng('ほかの会社に見える');

  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { week: '今週' } }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  done.run?.status === 'completed' && done.artifacts?.[0]?.title === '週報の下書き（今週）'
    ? ok('同意して導入すると、取り込んだ業務が動く（週報の下書き）') : ng('動かない', JSON.stringify(done.run));

  const off = await call('a', `/v1/admin/extensions/${EXT}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  const { body: menuOff } = await call('a', '/v1/agents', {}, 'member');
  const runOff = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input: { week: '今週' } }) }, 'member');
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
    const check = await call('a', `/v1/admin/extensions/${DW}/connectors/deepwiki/check`, { method: 'POST' });
    check.body.ok && check.body.tools.every((t) => t.provided)
      ? ok('コネクタの接続を確かめられる（宣言したツールが提供されている）') : ng('接続を確かめられない', JSON.stringify(check.body));
    await call('a', `/v1/admin/extensions/${DW}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
    const input = { repo: 'modelcontextprotocol/typescript-sdk', question: 'このリポジトリは何をするものですか？' };
    const { body: j } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: `${DW}:research`, input }) }, 'member');
    const r = await waitFor('a', j.runId, ['completed', 'failed'], 90000, 'member');
    const body = r.artifacts?.[0]?.body ?? '';
    r.run?.status === 'completed' && body.length > 50 && !body.startsWith('取得できませんでした')
      ? ok('コネクタで外部に問い合わせ、その結果を資料に残す（鍵なし）') : ng('問い合わせの結果が残らない', body.slice(0, 200));
    await call('a', `/v1/admin/extensions/${DW}`, { method: 'DELETE' });
  } else {
    console.log('  - DeepWiki への実際の問い合わせは省略（SMOKE_EXTERNAL=1 で実行）');
  }
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

  await call('a', `/v1/admin/compartments/${comp.id}/assignment`, { method: 'PUT', body: JSON.stringify({ groups: [], users: [] }) });
  await call('a', `/v1/admin/groups/${legal.id}`, { method: 'DELETE' });
}

console.log('\n■ 24. 調べてスライドにまとめる（web.research・slides.create）');
{
  const EXT = 'jp.m2office.samples.research-slides';
  const AG = `${EXT}:research-slides`;
  const input = { topic: 'ローカルで動く LLM の最近の製品動向', pages: '8' };
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
  const research = done.steps?.find((x) => x.stepId === 'research')?.output?.tools?.[0]?.result;
  research?.source === 'mock' && /実際には調べていません/.test(research.text)
    ? ok('鍵が無い環境の調査は、見本であることを明示する') : ng('見本の調査の扱いが違う', JSON.stringify(research));
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
  const { default: JSZip } = await import('jszip');
  const EXT = 'jp.example.smoke-google-tools';
  const AG = `${EXT}:memo-to-sheet`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const tools = ['drive.search', 'drive.read', 'sheets.create', 'sheets.append', 'gmail.send'];
  const agent = (steps) => ({
    schemaVersion: 1, id: 'memo-to-sheet', version: 1, name: '確認用: 会議メモを表にして送る', category: 'test',
    description: '確認用', locale: 'ja-JP', compartment: null,
    inputs: { type: 'object', required: ['memo'], properties: { memo: { type: 'string', title: 'メモの名前' } } },
    tools, steps, constraints: [], limits: { maxSteps: 8, maxTokens: 20000, timeoutSec: 120 },
    help: { summary: '確認用の拡張機能です' },
  });
  const steps = [
    { id: 'find', type: 'agent', instruction: 'メモを探す' },
    { id: 'read', type: 'agent', instruction: 'メモを読む' },
    { id: 'table', type: 'agent', instruction: '表にする' },
    { id: 'gate', type: 'approval', approver: 'requester', approverRole: [], present: '送る内容' },
    { id: 'send', type: 'agent', instruction: '送る' },
  ];
  const input = { memo: '営業会議メモ' };
  const stub = {
    find: [{ name: 'drive.search', args: { query: '営業会議メモ' } }],
    read: [{ name: 'drive.read', args: { fileId: 'mock-file-t-alpha-1' } }],
    table: [
      { name: 'sheets.create', args: { title: '決定事項（確認用）', columns: ['内容'], rows: [['{{read}}']] } },
      { name: 'sheets.append', args: { spreadsheetId: 'x' } },
    ],
    send: [{ name: 'gmail.send', args: { to: ['sato@customer.example.jp'], subject: '決定事項（確認用）', body: '確認用の本文' } }],
  };
  const pack = async (agentDef) => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({
      id: EXT, name: '確認用: Google のツール', version: '1.0.0', publisher: { name: '確認用' }, platform_schema: '>=1 <2',
      permissions: { tools, max_risk_level: 'external-send' },
    }));
    zip.file('agents/memo-to-sheet.json', JSON.stringify(agentDef));
    zip.file('evals/memo-to-sheet.json', JSON.stringify({ agent: 'memo-to-sheet', cases: [{ name: '確認', input, stub }] }));
    return zip.generateAsync({ type: 'uint8array' });
  };
  const upload = async (data) => call('a', '/v1/admin/extensions/import', { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });

  const noGate = await upload(await pack(agent(steps.filter((x) => x.id !== 'gate'))));
  noGate.status === 400 && noGate.body.problems?.some((p) => p.includes('承認ゲートが必要'))
    ? ok('メールを送る業務は、承認ステップが無ければ取り込めない') : ng('承認なしで取り込めてしまう', JSON.stringify(noGate.body));

  const imp = await upload(await pack(agent(steps)));
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const waiting = await waitFor('a', job.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  const out = (id) => waiting.steps?.find((x) => x.stepId === id)?.output?.tools ?? [];
  const read = out('read')[0]?.result;
  const [created, badAppend] = out('table');
  imp.status === 200 && read?.untrusted === true && /佐藤様への提案/.test(read.text) && out('find')[0]?.result?.count >= 1
    ? ok('ドライブのファイルを探して読める（中身はデータの印つき）') : ng('探す・読むができない', JSON.stringify(out('read')));
  created?.result?.created === true && created.result.file.kind === 'spreadsheet'
    ? ok('読んだ内容からスプレッドシートを作れる') : ng('スプレッドシートを作れない', JSON.stringify(created));
  /引数が正しくありません: rows がありません/.test(badAppend?.error ?? '')
    ? ok('必須の引数が無い呼び出しは、ツールを呼ばずに理由を返す') : ng('引数の検証が効かない', JSON.stringify(badAppend));
  waiting.run?.status === 'awaiting_approval' && out('send').length === 0
    ? ok('メールの送信の手前で、承認を待つ') : ng('承認を待たない', waiting.run?.status);

  const ap = await approvalFor('a', job.runId, 'member');
  await call('a', `/v1/approvals/${ap.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const sent = done.steps?.find((x) => x.stepId === 'send')?.output?.tools?.[0]?.result;
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
  const { default: JSZip } = await import('jszip');
  const EXT = 'jp.example.smoke-google-tools-2';
  const AG = `${EXT}:meeting-share`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const tools = ['meet.transcript', 'directory.search', 'docs.create', 'drive.share'];
  const def = {
    schemaVersion: 1, id: 'meeting-share', version: 1, name: '確認用: 会議の記録を共有する', category: 'test',
    description: '確認用', locale: 'ja-JP', compartment: null,
    inputs: { type: 'object', required: ['meeting'], properties: { meeting: { type: 'string', title: '会議の題名' } } },
    tools, constraints: [], limits: { maxSteps: 8, maxTokens: 20000, timeoutSec: 120 }, help: { summary: '確認用の拡張機能です' },
    steps: [
      { id: 'fetch', type: 'agent', instruction: '文字起こしを取る' },
      { id: 'who', type: 'agent', instruction: '共有する相手を探す' },
      { id: 'write', type: 'agent', instruction: '記録を作る' },
      { id: 'gate', type: 'approval', approver: 'requester', approverRole: [], present: '共有する相手と文書' },
      { id: 'share', type: 'agent', instruction: '共有する' },
    ],
  };
  const input = { meeting: '営業定例' };
  const stub = {
    fetch: [{ name: 'meet.transcript', args: { query: '営業定例' } }],
    who: [{ name: 'directory.search', args: { query: '営業部' } }],
    write: [{ name: 'docs.create', args: { title: '営業定例の記録（確認用）', body: '{{fetch}}' } }],
  };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    id: EXT, name: '確認用: 第 2 弾', version: '1.0.0', publisher: { name: '確認用' }, platform_schema: '>=1 <2',
    permissions: { tools, max_risk_level: 'external-send' },
  }));
  zip.file('agents/meeting-share.json', JSON.stringify(def));
  zip.file('evals/meeting-share.json', JSON.stringify({ agent: 'meeting-share', cases: [{ name: '確認', input, stub }] }));
  await call('a', '/v1/admin/extensions/import', { method: 'POST', body: await zip.generateAsync({ type: 'uint8array' }), headers: { 'content-type': 'application/octet-stream' } });
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const w = await waitFor('a', job.runId, ['awaiting_approval', 'completed', 'failed'], 20000, 'member');
  const out = (id) => w.steps?.find((x) => x.stepId === id)?.output?.tools?.[0]?.result;
  out('fetch')?.untrusted === true && /佐藤様への提案/.test(out('fetch')?.text ?? '')
    ? ok('Meet の会議の文字起こしを取れる（中身はデータの印つき）') : ng('文字起こしを取れない', JSON.stringify(out('fetch')));
  out('who')?.people?.[0]?.department === '営業部' ? ok('社内の人を部署で探せる') : ng('社内の人を探せない', JSON.stringify(out('who')));
  const docId = out('write')?.file?.id;
  w.run?.status === 'awaiting_approval' && docId ? ok('記録の文書を作り、共有の手前で承認を待つ') : ng('承認を待たない', w.run?.status);
  // 共有する文書の ID は実行中に決まるため、承認の前に見本の応答を差し替えずに、共有のステップの引数に反映できない。
  // ここでは承認のあとに「作っていないファイル」を共有しようとして断られることを確かめる
  const ap = await approvalFor('a', job.runId, 'member');
  await call('a', `/v1/approvals/${ap.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  done.run?.status === 'completed' ? ok('承認のあとに共有のステップへ進む') : ng('共有のステップへ進まない', JSON.stringify(done.run));
  const { body: perms } = await call('a', '/v1/admin/google-permissions');
  ['meetings.space.readonly', 'directory.readonly'].every((sc) => perms.items?.some((p) => p.scope === sc && p.level === 'sensitive'))
    ? ok('第 2 弾の権限（Meet・ディレクトリ）が、段階つきで一覧に出る') : ng('権限の一覧に出ない', JSON.stringify(perms.items));
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
}

console.log('\n■ 27. Google Workspace のツール（第 3 弾: フォームの回答）');
{
  const { default: JSZip } = await import('jszip');
  const EXT = 'jp.example.smoke-google-tools-3';
  const AG = `${EXT}:survey-summary`;
  await call('a', `/v1/admin/extensions/${EXT}`, { method: 'DELETE' });
  const tools = ['drive.search', 'forms.responses', 'sheets.create'];
  const def = {
    schemaVersion: 1, id: 'survey-summary', version: 1, name: '確認用: アンケートを表にまとめる', category: 'test',
    description: '確認用', locale: 'ja-JP', compartment: null,
    inputs: { type: 'object', required: ['form'], properties: { form: { type: 'string', title: 'フォームの名前' } } },
    tools, constraints: [], limits: { maxSteps: 6, maxTokens: 20000, timeoutSec: 120 }, help: { summary: '確認用の拡張機能です' },
    steps: [
      { id: 'find', type: 'agent', instruction: 'フォームを探す' },
      { id: 'collect', type: 'agent', instruction: '回答を集める' },
      { id: 'table', type: 'agent', instruction: '表にまとめる' },
    ],
  };
  const input = { form: '研修のアンケート' };
  const stub = {
    find: [{ name: 'drive.search', args: { query: 'アンケート' } }],
    collect: [{ name: 'forms.responses', args: { formId: 'mock-file-t-alpha-3' } }],
    table: [{ name: 'sheets.create', args: { title: 'アンケートの集計（確認用）', columns: ['回答'], rows: [['{{collect}}']] } }],
  };
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    id: EXT, name: '確認用: 第 3 弾', version: '1.0.0', publisher: { name: '確認用' }, platform_schema: '>=1 <2',
    permissions: { tools, max_risk_level: 'draft' },
  }));
  zip.file('agents/survey-summary.json', JSON.stringify(def));
  zip.file('evals/survey-summary.json', JSON.stringify({ agent: 'survey-summary', cases: [{ name: '確認', input, stub }] }));
  await call('a', '/v1/admin/extensions/import', { method: 'POST', body: await zip.generateAsync({ type: 'uint8array' }), headers: { 'content-type': 'application/octet-stream' } });
  await call('a', `/v1/admin/extensions/${EXT}/install`, { method: 'POST', body: JSON.stringify({ consent: true }) });
  const { body: job } = await call('a', '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: AG, input }) }, 'member');
  const done = await waitFor('a', job.runId, ['completed', 'failed'], 20000, 'member');
  const out = (id) => done.steps?.find((x) => x.stepId === id)?.output?.tools?.[0]?.result;
  out('find')?.items?.[0]?.kind === 'form' ? ok('ドライブの検索でフォームが見つかる') : ng('フォームが見つからない', JSON.stringify(out('find')));
  const r = out('collect');
  r?.untrusted === true && r.count === 3 && r.form?.questions?.includes('満足度')
    ? ok('フォームの回答を、質問の文つきで取れる（データの印つき）') : ng('回答を取れない', JSON.stringify(r));
  done.run?.status === 'completed' && out('table')?.created === true
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
  bad.status === 400 ? ok('形式の違う鍵は登録できない') : ng(`登録できてしまう（${bad.status}）`);
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
  await call('a', '/v1/admin/connections/google', { method: 'PUT', body: JSON.stringify({ clientId: '123456-smoke.apps.googleusercontent.com', clientSecret: 'GOCSPX-smoke-secret' }) });
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

console.log('\n■ 30. 言い換えの登録（第11.7.7節）');
{
  const qa = async (question, tenant = 'a') => {
    const { body: job } = await call(tenant, '/v1/jobs', { method: 'POST', body: JSON.stringify({ agentId: 'knowledge-qa', input: { question } }) });
    const run = await waitFor(tenant, job.runId, ['completed', 'failed']);
    return run.steps.find((x) => x.stepId === 'search')?.output?.tools?.[0]?.result ?? {};
  };
  const put = (value, tenant = 'a', who = 'admin') =>
    call(tenant, '/v1/admin/settings/knowledge', { method: 'PUT', body: JSON.stringify(value) }, who);

  const std = await qa('育休はいつまで？');
  std.hits?.[0]?.heading === '第34条（育児休業）' && std.note === '「育休」を「育児休業」と読み替えて探しました'
    ? ok('標準の言い換えで「育休」から「育児休業」の条を見つけ、読み替えを示す') : ng('標準の言い換えが効かない', JSON.stringify(std).slice(0, 200));

  const bad = await put({ standardSynonyms: true, synonyms: '育休、育児休業\n育休、育児' });
  bad.status === 400 && /2 行目/.test(bad.body.error ?? '') ? ok('同じ語を 2 つの組に入れると、行番号とともに断る') : ng(`断らない（${bad.status}）`);
  const member = await put({ standardSynonyms: true, synonyms: '' }, 'a', 'member');
  member.status === 403 ? ok('言い換えは管理者だけが変えられる') : ng(`管理者以外が変えられる（${member.status}）`);

  const saved = await put({ standardSynonyms: false, synonyms: '始業、出社の時刻' });
  const off = await qa('育休はいつまで？');
  const own = await qa('出社の時刻は何時？');
  saved.status === 200 && (off.hits ?? []).length === 0 && own.hits?.[0]?.heading === '第15条（始業・終業の時刻）'
    ? ok('標準を無効にすると使わず、自社の組は使う') : ng('設定が効いていない', JSON.stringify({ off: off.hits?.length, own: own.hits?.[0] }));
  const bOwn = await qa('出社の時刻は何時？', 'b');
  !(bOwn.hits ?? []).some((h) => h.heading?.includes('始業')) ? ok('言い換えはほかの会社に効かない') : ng('ほかの会社に効いている');

  const { body: audits } = await call('a', '/v1/admin/audit-events');
  (audits.items ?? []).some((e) => e.action === 'knowledge.synonyms.save') ? ok('言い換えの変更を監査ログに残す') : ng('監査ログに残らない');
  await put({ standardSynonyms: true, synonyms: '' });
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
  saved.status === 200 && after && toolNames.includes('gmail.list') && after.steps.every((st) => st.input === null)
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
  const settings = { kinds: { brief: true, run: true, approval: true, failure: true }, quietHours: null, channels: { chat: true, email: true } };
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
    body: JSON.stringify({ ...settings, channels: { chat: false, email: false } }),
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
  const allowed = ['userId', 'name', 'state', 'detail', 'agentName', 'route', 'device'];
  (live.people ?? []).every((p) => Object.keys(p).every((k) => allowed.includes(k)))
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

console.log('\n■ 39. 対話からの学習（記憶の候補。第11.5.2節）');
{
  const who = 'member';
  // 候補を作るのは夜間のワーカーで、鍵の無い環境では作らない。ここでは候補の採否を確かめる
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
  await owner.connect();
  const { rows: [user] } = await owner.query(`select id from users where email = 'member@alpha.example.jp'`);
  const { rows: [tenant] } = await owner.query(`select id from tenants where subdomain = 'a'`);
  const ids = ['smoke-cand-1', 'smoke-cand-2'];
  await owner.query(`delete from memory_candidates where id = any($1)`, [ids]);
  for (const [i, id] of ids.entries()) {
    await owner.query(
      `insert into memory_candidates (id, tenant_id, user_id, text, status, source_day)
       values ($1,$2,$3,$4,'pending','2026-09-22')`,
      [id, tenant.id, user.id, `確認用の候補 ${i + 1}`]);
  }

  const { body: pending } = await call('a', '/v1/me/memory-candidates', {}, who);
  (pending.items ?? []).length === 2 ? ok('記憶の候補を本人に示す') : ng('候補が出ない', String((pending.items ?? []).length));

  const { body: other } = await call('a', '/v1/me/memory-candidates', {}, 'admin');
  (other.items ?? []).every((c) => !c.text.startsWith('確認用の候補'))
    ? ok('ほかの人の候補は見えない') : ng('他人の候補が見えている');

  await call('a', `/v1/me/memory-candidates/${ids[0]}/accept`, { method: 'POST', body: '{}' }, who);
  await call('a', `/v1/me/memory-candidates/${ids[1]}/dismiss`, { method: 'POST', body: '{}' }, who);
  const [{ body: memories }, { body: left }] = await Promise.all([
    call('a', '/v1/me/memories', {}, who),
    call('a', '/v1/me/memory-candidates', {}, who),
  ]);
  (memories.items ?? []).some((m) => m.text === '確認用の候補 1' && m.source === 'conversation')
    ? ok('「覚える」を押した候補だけが記憶になる') : ng('記憶にならない', JSON.stringify(memories.items ?? []).slice(0, 120));
  (left.items ?? []).length === 0 ? ok('判断した候補は一覧から消える') : ng('候補が残る');

  const { rows: [dismissed] } = await owner.query(`select status from memory_candidates where id = $1`, [ids[1]]);
  dismissed?.status === 'dismissed'
    ? ok('「不要」とした文は、同じ文を再び候補にしないために残す') : ng('残らない', JSON.stringify(dismissed ?? null));

  // 後片付け
  await call('a', '/v1/me/memories', { method: 'DELETE' }, who);
  await owner.query(`delete from memory_candidates where id = any($1)`, [ids]);
  await owner.end();
}

console.log('\n■ 40. 昇華（個人の記憶を会社の知識へ。第11.3.1節）');
{
  const who = 'member';
  await call('a', '/v1/me/memories', { method: 'DELETE' }, who);
  await call('a', '/v1/secretary', { method: 'POST', body: JSON.stringify({ message: '経費の精算は佐藤さんに出すと覚えておいて' }) }, who);
  const { body: memories } = await call('a', '/v1/me/memories', {}, who);
  const memory = (memories.items ?? [])[0];

  const { status: promoted } = await call('a', `/v1/me/memories/${memory.id}/promote`, { method: 'POST', body: '{}' }, who);
  const { body: pending } = await call('a', '/v1/admin/promotions');
  const proposal = (pending.items ?? []).find((p) => p.text === memory.text);
  promoted === 200 && proposal?.canDecide
    ? ok(`提案が管理者の承認待ちに並ぶ（${proposal.proposedBy}さんの提案）`) : ng('承認待ちに並ばない', JSON.stringify(pending.items ?? []));

  // 提案した本人は判断できない（二重の承認）
  const { status: bySelf } = await call('a', `/v1/admin/promotions/${proposal.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) }, who);
  bySelf === 403 ? ok('提案した本人は判断できない') : ng(`判断できてしまう（${bySelf}）`);

  await call('a', `/v1/admin/promotions/${proposal.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approved', comment: null }) });
  const { body: knowledge } = await call('a', '/v1/admin/knowledge');
  const registered = (knowledge.items ?? []).find((k) => k.body === memory.text);
  registered && /昇華/.test(registered.source)
    ? ok(`承認すると、その文のまま会社の知識になる（${registered.source}）`) : ng('知識にならない', JSON.stringify(registered ?? null));

  const { body: history } = await call('a', '/v1/me/promotions', {}, who);
  (history.items ?? []).some((p) => p.status === 'approved')
    ? ok('本人は昇華の履歴を見られる') : ng('履歴が見えない');

  const { body: notes } = await call('a', '/v1/notifications', {}, who);
  (notes.items ?? []).some((n) => n.title === '提案が会社の知識になりました')
    ? ok('判断を本人に知らせる') : ng('知らせない');

  const { body: mine } = await call('a', '/v1/me/memories', {}, who);
  (mine.items ?? []).length === 1 ? ok('昇華しても、本人の記憶は残る') : ng('記憶が消えている');

  // 後片付け
  if (registered) await call('a', `/v1/admin/knowledge/${registered.id}`, { method: 'DELETE' });
  await call('a', '/v1/me/memories', { method: 'DELETE' }, who);
  await call('a', '/v1/me/conversations', { method: 'DELETE' }, who);
}

console.log('');
console.log(process.exitCode ? '\x1b[31m一部の確認に失敗しました\x1b[0m' : '\x1b[32mすべての確認を通過しました\x1b[0m');
console.log('');
