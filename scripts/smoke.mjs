/**
 * @file 通しの動作確認。API とワーカーを起動した状態で、主要な経路と境界を端から端まで確かめる。
 *
 * とくに、承認ゲートで中断し、承認後に別のワーカーが再開して完了する経路を確かめる。
 * あわせてテナント分離・権限・ログイン・データベースの分離・設定・ファイルも確かめる。
 *
 * 使い方: `npm run dev` を起動した状態で `npm run smoke`
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

  const { body: before } = await call('a', '/v1/notifications', {}, 'member');
  await call('a', `/v1/schedules/${brief.id}/trigger`, { method: 'POST' }, 'member');
  ok('次の回を今にした（ワーカーの見回りを待つ）');

  const deadline = Date.now() + 40000;
  let after;
  while (Date.now() < deadline) {
    ({ body: after } = await call('a', '/v1/notifications', {}, 'member'));
    if (after.items.length > before.items.length) break;
    await sleep(1000);
  }
  const latest = after.items[0];
  after.items.length > before.items.length && latest.kind === 'brief'
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

console.log('');
console.log(process.exitCode ? '\x1b[31m一部の確認に失敗しました\x1b[0m' : '\x1b[32mすべての確認を通過しました\x1b[0m');
console.log('');
