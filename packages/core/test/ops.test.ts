/**
 * @file マスター管理画面（仕様書 第23.8.15節）の決まりと、運営の専用のロールの確かめ。
 *
 * 決まり（入力の確かめ・ロール・稼働の知らせの形・機械の印）は純粋な関数で見る。
 * 開発のデータベース（3105 番）が動いていれば、運営のロール `m2office_ops` が顧客の表と関数に届かないこと、
 * 決めた関数で会社を作り・数え・切り替えられることを本物で見る（動いていなければ飛ばす）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { checkNewTenant, machineFlags, operatorCan, OpsAppSide, OpsRuleError, OpsStore, parseMachineReport, proxyAllowed, ProxyAccessStore, tenantsCsv, welcomeText, type MachineReport } from '../src/index.js';

test('会社を作る入力: 整え、規則・予約語・ドメインを確かめる', () => {
  const ok = checkNewTenant({ subdomain: ' Acme ', name: 'アクメ', domain: '@ACME.example', admin: 'Boss@acme.example' });
  assert.deepEqual(ok, { ok: true, value: { subdomain: 'acme', name: 'アクメ', domain: 'acme.example', admin: 'boss@acme.example', status: 'trial' } });
  assert.equal(checkNewTenant({ subdomain: 'ab', name: 'x', domain: 'x.example', admin: 'a@x.example' }).ok, false);
  assert.equal(checkNewTenant({ subdomain: '-abc', name: 'x', domain: 'x.example', admin: 'a@x.example' }).ok, false);
  assert.equal(checkNewTenant({ subdomain: 'admin', name: 'x', domain: 'x.example', admin: 'a@x.example' }).ok, false);
  assert.equal(checkNewTenant({ subdomain: 'abc', name: 'x', domain: 'x.example', admin: 'a@y.example' }).ok, false);
  assert.equal(checkNewTenant({ subdomain: 'abc', name: 'x', domain: 'x.example', admin: 'a@x.example', status: 'suspended' }).ok, false);
  assert.match(welcomeText({ name: 'アクメ', loginUrl: 'https://acme.example/', admin: 'boss@acme.example', domain: 'acme.example' }), /https:\/\/acme\.example\//);
});

test('CSV: 引用符と改行を囲み、式として読まれる値には印を付ける。表計算のために BOM を付ける', () => {
  const row = { name: '=HYPERLINK("x")', subdomain: 'acme', workspaceDomain: null, status: 'trial', createdAt: '2026-10-08T00:00:00Z', usersActive: 1, usersInvited: 1,
    users30d: 0, lastUsedAt: null, runsToday: 0, runs30d: 0, runsFailed30d: 0, conversations30d: 0, aiCostMonth: 12.6, filesBytes: 0, extensions: 0, googleConnections: 0 };
  const csv = tenantsCsv([row, { ...row, name: 'A, "B"\nC' }]);
  assert.ok(csv.startsWith('\ufeff会社名,'));
  const lines = csv.split('\r\n');
  assert.match(lines[1]!, /^"'=HYPERLINK\(""x""\)",acme,,trial,/);
  assert.match(lines[1]!, /,13,0,0,0\s*$/);
  assert.match(csv, /"A, ""B""\nC"/);
});

test('代理アクセスの道: 見るだけ。管理者ページの範囲は知識・書き出し・サポートの閲覧と実行の中身を通さない', () => {
  assert.equal(proxyAllowed('admin', 'GET', '/v1/me'), true);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/admin/runs'), true);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/admin/audit-events'), true);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/admin/audit-events/export'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/admin/knowledge'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/admin/support'), false);
  assert.equal(proxyAllowed('admin', 'POST', '/v1/admin/settings/company'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/secretary/lookups'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/me/settings'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/cards'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/files/f-1'), false);
  assert.equal(proxyAllowed('admin', 'GET', '/v1/runs/r-1'), false);
  assert.equal(proxyAllowed('runs', 'GET', '/v1/runs/r-1'), true);
  assert.equal(proxyAllowed('runs', 'POST', '/v1/runs/r-1/cancel'), false);
  assert.equal(proxyAllowed('admin', 'POST', '/v1/auth/logout'), true);
});

test('ロール: 運営管理者はすべて、サポートは会社まで、監視は見るだけ', () => {
  assert.equal(operatorCan('admin', 'operator.manage'), true);
  assert.equal(operatorCan('support', 'tenant.create'), true);
  assert.equal(operatorCan('support', 'machine.manage'), false);
  assert.equal(operatorCan('monitor', 'view'), true);
  assert.equal(operatorCan('monitor', 'tenant.status'), false);
  assert.equal(operatorCan('support', 'settings.manage'), false);
  assert.equal(operatorCan('admin', 'settings.manage'), true);
  assert.equal(operatorCan('monitor', 'tenant.lock'), true);
  assert.equal(operatorCan('monitor', 'tenant.suspend'), false);
  assert.equal(operatorCan('support', 'tenant.suspend'), true);
});

const report = (over: Partial<MachineReport> = {}): MachineReport => ({
  machineId: 'm-1', version: '0.18.0', at: '2026-10-08T01:00:00Z',
  parts: { database: true, worker: true, entrance: true, localAi: null },
  backup: { configured: true, lastAt: '2026-10-08T00:00:00Z', lastOk: true, restoreOk: true, offsite: { configured: true, lastAt: null, lastOk: true, checkOk: null } },
  disk: { dataFree: 500, dataTotal: 1000, backupFree: 100 }, cert: { daysLeft: 60 }, update: { lastAt: null, lastResult: 'updated', version: '0.18.0' },
  ...over,
});

test('稼働の知らせ: 決めた項目だけを残し、形の違うものは受けない', () => {
  const parsed = parseMachineReport({ ...report(), extra: 'x', parts: { database: true, worker: 'yes', entrance: true, localAi: null, hack: 1 } });
  assert.ok(parsed);
  assert.equal('extra' in parsed, false);
  assert.equal(parsed.parts.worker, false);
  assert.equal('hack' in parsed.parts, false);
  assert.equal(parseMachineReport({ machineId: 'x' }), null);
  assert.equal(parseMachineReport('文字'), null);
});

test('機械の印: 3 時間来ない・止まった部分・控えの失敗・空き・証明書・更新の失敗', () => {
  const now = new Date('2026-10-08T02:00:00Z');
  assert.deepEqual(machineFlags(null, null, now), ['never']);
  assert.deepEqual(machineFlags('2026-10-08T01:30:00Z', report(), now), []);
  assert.deepEqual(machineFlags('2026-10-07T20:00:00Z', report(), now), ['silent']);
  const bad = report({
    parts: { database: true, worker: false, entrance: true, localAi: false },
    backup: { configured: true, lastAt: '2026-10-08T00:00:00Z', lastOk: false, restoreOk: true, offsite: { configured: true, lastAt: null, lastOk: false, checkOk: null } },
    disk: { dataFree: 50, dataTotal: 1000, backupFree: null }, cert: { daysLeft: 5 }, update: { lastAt: null, lastResult: 'rolled-back', version: null },
  });
  assert.deepEqual(machineFlags('2026-10-08T01:30:00Z', bad, now), ['part-down', 'backup-failed', 'offsite-failed', 'disk-low', 'cert-soon', 'update-failed']);
});

const OWNER = process.env['MIGRATION_DATABASE_URL'] ?? 'postgres://m2office:m2office@localhost:3105/m2office';
const OPS = 'postgres://m2office_ops:m2office_ops@localhost:3105/m2office';
const APP = process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office';
const dbReady = await (async () => {
  const c = new pg.Client({ connectionString: OPS, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.query('select 1 from ops.operators limit 1'); return true; } catch { return false; } finally { await c.end().catch(() => undefined); }
})();

test('運営のロール: 顧客の表と関数に届かず、決めた関数で会社を作り・数え・切り替える', { skip: dbReady ? false : '開発のデータベース（移行 111 まで）が動いていません' }, async () => {
  const pool = new pg.Pool({ connectionString: OPS, max: 2 });
  const owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  const sub = `zz-ops-${Date.now().toString(36)}`;
  try {
    await assert.rejects(pool.query('select count(*) from tenants'), /permission denied/);
    await assert.rejects(pool.query('select count(*) from public.users'), /permission denied/);
    await assert.rejects(pool.query('select * from m2o_inventory_publication($1)', ['x']), /permission denied/);
    await assert.rejects(pool.query('select * from m2o_claim_next_run()'), /permission denied/);
    const store = new OpsStore(pool);
    const id = await store.createTenant({ subdomain: sub, name: '確かめ', domain: `${sub}.example`, admin: `boss@${sub}.example`, status: 'trial' }, 'op-test');
    assert.equal(id, `t-${sub}`);
    await assert.rejects(store.createTenant({ subdomain: sub, name: 'x', domain: `other-${sub}.example`, admin: `a@other-${sub}.example`, status: 'trial' }, 'op-test'),
      (e: unknown) => e instanceof OpsRuleError && e.code === 'subdomain_taken');
    const row = (await store.tenantOverview()).find((t) => t.id === id);
    assert.equal(row?.usersActive, 1);
    assert.equal(row?.usersInvited, 1);
    assert.equal(row?.status, 'trial');
    assert.equal(await store.setTenantStatus(id, 'active', 'op-test'), 'trial');
    const audit = await owner.query(`select action from audit_events where tenant_id = $1 order by occurred_at`, [id]);
    assert.deepEqual(audit.rows.map((r) => r.action), ['tenant.create', 'tenant.status']);
    // 機械の鍵は SHA-256 だけを持ち、鍵で知らせを受ける
    const { machine, token } = await store.addMachine(`確かめ ${sub}`, 'op-test');
    assert.equal(await store.receiveReport('違う鍵', report()), null);
    assert.equal(await store.receiveReport(token, report()), machine.id);
    assert.equal((await store.listMachines()).find((m) => m.id === machine.id)?.report?.version, '0.18.0');
    assert.equal(await store.removeMachine(machine.id), true);
    // 会社の詳細: 数と状態と、シートの氏名とロール。先方の管理者だけ連絡先を出す
    const detail = await store.tenantDetail(id);
    assert.equal(detail?.tenant.subdomain, sub);
    assert.equal(detail?.seats.length, 1);
    assert.equal(detail?.seats[0]?.email, `boss@${sub}.example`);
    assert.deepEqual(detail?.history.map((h) => h.action).sort(), ['tenant.create', 'tenant.status']);
    assert.equal(await store.tenantDetail('t-none'), null);
    const server = await store.serverStatus();
    assert.equal(typeof server.queue.queued, 'number');
    // アプリのロールの側: 毎晩の数を運営の表へ書き、ワーカーの知らせを書く。顧客の側は運営主体を読むだけ
    const appPool = new pg.Pool({ connectionString: APP, max: 1 });
    try {
      const side = new OpsAppSide(appPool);
      assert.ok((await side.recordDaily('2026-10-01')) >= 1);
      const daily = await owner.query('select users_active from ops.tenant_daily where tenant_id = $1 and day = $2', [id, '2026-10-01']);
      assert.equal(daily.rows[0]?.users_active, 1);
      await side.beat(`test-${sub}`, '0.0.0');
      assert.ok((await store.serverStatus()).workers.some((w) => w.id === `test-${sub}`));
      await assert.rejects(appPool.query('select * from ops.operator_profile'), /permission denied/);
      await assert.rejects(appPool.query('select * from ops.tenant_daily'), /permission denied/);
    } finally {
      await owner.query('delete from worker_beats where id = $1', [`test-${sub}`]);
      await owner.query('delete from ops.tenant_daily where tenant_id = $1', [id]);
      await appPool.end();
    }
  } finally {
    await owner.query('delete from tenants where id = $1', [`t-${sub}`]);
    await owner.end();
    await pool.end();
  }
});

test('停止と再開: 2 人の承認・7 日の予告・期限で止める・緊急停止はすぐ止めて別の人が確かめる', { skip: dbReady ? false : '開発のデータベース（移行 113 まで）が動いていません' }, async () => {
  const pool = new pg.Pool({ connectionString: OPS, max: 2 });
  const appPool = new pg.Pool({ connectionString: APP, max: 1 });
  const owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  const sub = `zz-stop-${Date.now().toString(36)}`;
  const store = new OpsStore(pool);
  const side = new OpsAppSide(appPool);
  const status = async () => (await owner.query('select status from tenants where id = $1', [`t-${sub}`])).rows[0]?.status;
  try {
    const id = await store.createTenant({ subdomain: sub, name: '停止の確かめ', domain: `${sub}.example`, admin: `boss@${sub}.example`, status: 'active' }, 'op-a');
    await assert.rejects(store.requestStatus(id, 'suspend', 'unpaid', ' ', 'op-a'), (e: unknown) => e instanceof OpsRuleError && e.code === 'reason_required');
    const req = await store.requestStatus(id, 'suspend', 'unpaid', '3 か月の未入金', 'op-a');
    await assert.rejects(store.requestStatus(id, 'suspend', 'unpaid', '重ねて', 'op-b'), (e: unknown) => e instanceof OpsRuleError && e.code === 'already_requested');
    await assert.rejects(store.decideStatus(req, true, 'op-a'), (e: unknown) => e instanceof OpsRuleError && e.code === 'same_operator');
    assert.equal(await store.decideStatus(req, true, 'op-b'), 'scheduled');
    const at = await side.suspendAt(id);
    assert.ok(at && Date.parse(at) - Date.now() > 6.9 * 86_400_000);
    // 期限の前は止めない。期限が来たら止める
    await side.applyDueSuspensions();
    assert.equal(await status(), 'active');
    await owner.query(`update ops.status_requests set effective_at = now() - interval '1 minute' where id = $1`, [req]);
    assert.ok((await side.applyDueSuspensions()) >= 1);
    assert.equal(await status(), 'suspended');
    assert.equal(await side.suspendAt(id), null);
    // 再開も 2 人の承認。止める前の状態に戻す
    const resume = await store.requestStatus(id, 'resume', 'resolved', '入金を確かめた', 'op-b');
    assert.equal(await store.decideStatus(resume, true, 'op-a'), 'done');
    assert.equal(await status(), 'active');
    // 緊急停止はすぐに止め、申請した人とは別の人が確かめる
    const lock = await store.requestStatus(id, 'lock', 'takeover', '管理者のアカウントの乗っ取りの疑い', 'op-c');
    assert.equal(await status(), 'locked');
    await assert.rejects(store.confirmLock(lock, 'op-c'), (e: unknown) => e instanceof OpsRuleError && e.code === 'same_operator');
    await store.confirmLock(lock, 'op-a');
    const list = await store.listStatusRequests(id);
    assert.equal(list.find((r) => r.id === lock)?.confirmedBy, 'op-a');
    assert.equal(list[0]?.tenantName, '停止の確かめ');
    const notes = await owner.query(`select title from notifications where tenant_id = $1 and kind = 'service' order by created_at`, [id]);
    assert.deepEqual(notes.rows.map((r) => r.title), ['ご利用の停止の予告', 'ご利用を停止しました', 'ご利用を再開しました']);
    const audit = await owner.query(`select action from audit_events where tenant_id = $1 and action like 'tenant.%' order by occurred_at`, [id]);
    assert.ok(['tenant.suspend_scheduled', 'tenant.suspend', 'tenant.resume', 'tenant.lock', 'tenant.lock_confirmed'].every((a) => audit.rows.some((r) => r.action === a)));
  } finally {
    await owner.query('delete from ops.status_requests where tenant_id = $1', [`t-${sub}`]);
    await owner.query('delete from tenants where id = $1', [`t-${sub}`]);
    await owner.end();
    await appPool.end();
    await pool.end();
  }
});

test('代理アクセス: 申請・許す・1 回だけの券で入る・切る・終わりを知らせる', { skip: dbReady ? false : '開発のデータベース（移行 114 まで）が動いていません' }, async () => {
  const pool = new pg.Pool({ connectionString: OPS, max: 2 });
  const appPool = new pg.Pool({ connectionString: APP, max: 2 });
  const owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  const sub = `zz-proxy-${Date.now().toString(36)}`;
  const store = new OpsStore(pool);
  const proxy = new ProxyAccessStore(appPool);
  const side = new OpsAppSide(appPool);
  try {
    const id = await store.createTenant({ subdomain: sub, name: '閲覧の確かめ', domain: `${sub}.example`, admin: `boss@${sub}.example`, status: 'active' }, 'op-a');
    const admin = (await owner.query('select id from users where tenant_id = $1', [id])).rows[0].id as string;
    await assert.rejects(store.requestProxy(id, 'admin', ' ', 'op-a', 'a@ops.example'), (e: unknown) => e instanceof OpsRuleError && e.code === 'reason_required');
    const g = await store.requestProxy(id, 'runs', '業務が止まる問い合わせの調べ', 'op-a', 'a@ops.example');
    // 許される前は入れない
    await assert.rejects(store.proxyTicket(g, 'op-a'), (e: unknown) => e instanceof OpsRuleError && e.code === 'not_pending');
    // 会社の側（アプリのロール）で許す。ほかの会社からは見えない
    assert.equal((await proxy.list('t-alpha')).some((x) => x.id === g), false);
    const approved = await proxy.decide(id, g, true, 4, admin);
    assert.equal(approved?.state, 'approved');
    assert.equal(approved?.hours, 4);
    // 券は申請した運営者だけが出せる。1 回だけ使える
    await assert.rejects(store.proxyTicket(g, 'op-b'), (e: unknown) => e instanceof OpsRuleError && e.code === 'same_operator');
    const { ticket, subdomain } = await store.proxyTicket(g, 'op-a');
    assert.equal(subdomain, sub);
    assert.equal(await proxy.exchange('t-alpha', ticket), null);
    const entered = await proxy.exchange(id, ticket);
    assert.ok(entered);
    assert.equal(await proxy.exchange(id, ticket), null);
    const session = await proxy.findSession(id, entered.token);
    assert.equal(session?.grant.scope, 'runs');
    assert.equal(session?.grant.decidedBy, admin);
    // 会社の管理者が切ると、閲覧のログイン状態も消え、終わりの知らせが届く
    assert.ok(await proxy.revoke(id, g, admin));
    assert.equal(await proxy.findSession(id, entered.token), null);
    assert.ok((await side.sweepProxy()) >= 1);
    const notes = await owner.query(`select title from notifications where tenant_id = $1 and kind = 'support' order by created_at`, [id]);
    assert.deepEqual(notes.rows.map((r) => r.title), ['サポートからの閲覧の申請', 'サポートの閲覧が終わりました']);
    const ops = await store.listProxy(id);
    assert.equal(ops[0]?.state, 'revoked');
  } finally {
    await owner.query('delete from tenants where id = $1', [`t-${sub}`]);
    await owner.end();
    await appPool.end();
    await pool.end();
  }
});
