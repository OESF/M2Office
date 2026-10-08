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
import { checkNewTenant, machineFlags, operatorCan, OpsRuleError, OpsStore, parseMachineReport, welcomeText, type MachineReport } from '../src/index.js';

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

test('ロール: 運営管理者はすべて、サポートは会社まで、監視は見るだけ', () => {
  assert.equal(operatorCan('admin', 'operator.manage'), true);
  assert.equal(operatorCan('support', 'tenant.create'), true);
  assert.equal(operatorCan('support', 'machine.manage'), false);
  assert.equal(operatorCan('monitor', 'view'), true);
  assert.equal(operatorCan('monitor', 'tenant.status'), false);
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
  } finally {
    await owner.query('delete from tenants where id = $1', [`t-${sub}`]);
    await owner.end();
    await pool.end();
  }
});
