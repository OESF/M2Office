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

console.log('\n■ 1. 疎通と一覧');
{
  const health = await fetch(`${API}/health`).then((r) => r.json());
  health.ok ? ok('API が応答する') : ng('API が応答しない');

  const { body } = await call('a', '/v1/agents');
  body.agents?.length === 5
    ? ok(`エージェントが 5 件（${body.agents.map((a) => a.name).join(' / ')}）`)
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

  const { body: mine } = await call('a', '/v1/approvals', {}, 'member');
  const approval = mine.items.find((a) => a.present.includes('招待'));
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

console.log('');
console.log(process.exitCode ? '\x1b[31m一部の確認に失敗しました\x1b[0m' : '\x1b[32mすべての確認を通過しました\x1b[0m');
console.log('');
