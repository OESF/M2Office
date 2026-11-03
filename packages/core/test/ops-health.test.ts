/**
 * @file 稼働状況の全体の状態（仕様書 第23.8.7節「全体の状態」）の確かめ。区分ごとの判断の決まり、警戒を先に並べること、
 * 省いた区分は出さず読めなかった区分は注意にすること、ローカルの形の判断（machineHealth）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeEnvironment } from '@m2office/shared';
import { edgeStatusView, jstShort, machineHealth, opsHealth, type CloudBackupView, type EdgeStatus, type MachineStatus, type ServerStatus, type TenantOverview } from '../src/index.js';

const now = Date.parse('2026-11-03T09:45:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

const status: ServerStatus = {
  queue: { queued: 0, oldestQueuedAt: null, running: 1, awaitingApproval: 0 },
  runs: { hour: 12, hourFailed: 0, today: 40, todayFailed: 1 },
  workers: [{ id: 'w1', at: ago(30_000), version: '0.29.0' }],
  schedulesLate: 0,
  targets: [{ group: 'ai', ok: 30, fail: 1, avgMs: 800 }],
  database: { bytes: 1e8, connections: 10 },
  filesBytes: 1e6,
  ai: { today: 10, month: 300, lastMonthSamePeriod: 250 },
};

const proc = { version: '0.29.0', node: { version: 'v24.22.1', line: 24, stage: 'active' as const, end: '2028-04-30', ended: false, soon: false, insecure: false, secure: 'v24.22.1' }, startedAt: ago(3_600_000), lastSeen: ago(30_000), stale: false };
const runtime = {
  api: proc, worker: proc, postgres: '18.1', deployment: 'cloud', debug: false, inference: null, nodeWarn: null, nodeSecurity: null,
  machine: { os: 'Linux', arch: 'x64', cpu: null, cores: 4, memTotal: 4e9, memFree: 2e9, load: [0.5, 0.4, 0.3], swapTotal: 4e9, swapFree: 4e9, diskTotal: 150e9, diskFree: 100e9, netRx: null, netTx: null },
  database: { bytes: 1e8, connections: 10, max: 100 }, checkedAt: ago(0),
} as unknown as RuntimeEnvironment;

const backup: CloudBackupView = {
  configured: true,
  last: { at: ago(8 * 3_600_000), startedAt: ago(8 * 3_600_000 + 60_000), ok: true, database: { ok: true, error: null }, files: { ok: true, error: null, snapshot: 'abc' }, check: { at: ago(86_400_000), ok: true, error: null } },
  stale: false, archive: { enabled: true, lastArchivedAt: ago(60_000), lastFailedAt: null, failedCount: 0 }, archiveFailing: false,
  recoverable: { from: ago(86_400_000), to: ago(60_000) }, restorePoints: [], nextRunAt: ago(-3_600_000),
};

const edgeRaw: EdgeStatus = {
  at: ago(60_000), crowdsec: { local: 1, shared: 15000, alerts24h: 10, alerts7d: 70 }, geo: { countries: 'CN', inBlocked: 4, outBlocked: 0, out24h: 0, listAt: ago(86_400_000) },
  waf: { engine: 'DetectionOnly', hits24h: 400, hits7d: 2800 }, certs: { count: 4, nearest: '2027-01-26T10:50:00.000Z' }, vpn: { peers: [] }, errors: [],
};

const tenant = (name: string, runs30d: number, runsFailed30d: number, securityHigh24h = 0) => ({ name, status: 'active', runs30d, runsFailed30d, securityHigh24h }) as unknown as TenantOverview;

const calm = () => ({ status, runtime, backup, edge: edgeStatusView(edgeRaw, now), tenants: [tenant('甲社', 30, 1)], platformAi: { usedJpy: 100, capJpy: 10000 } });

test('どれにも当たらなければ平常。区分の札は決まった順で、平常のときは代表の数を出す', () => {
  const h = opsHealth(calm(), now);
  assert.equal(h.level, 'normal');
  assert.deepEqual(h.items, []);
  assert.deepEqual(h.areas.map((a) => a.area), ['jobs', 'resources', 'backup', 'security', 'external', 'runtime', 'tenants', 'ai']);
  assert.ok(h.areas.every((a) => a.level === 'normal'));
  assert.equal(h.areas.find((a) => a.area === 'backup')?.summary, `取得完了 ${jstShort(backup.last!.at)}`);
  assert.equal(h.areas.find((a) => a.area === 'resources')?.summary, 'ディスク 33%・メモリー 50%');
});

test('警戒を先に並べ、札は最初の問題の見出しを出す。することと手順が付く', () => {
  const h = opsHealth({
    ...calm(),
    status: { ...status, workers: [{ id: 'w1', at: ago(10 * 60_000), version: '0.29.0' }], schedulesLate: 2 },
    runtime: { ...runtime, machine: { ...runtime.machine!, diskFree: 20e9 } },
  }, now);
  assert.equal(h.level, 'alert');
  assert.deepEqual(h.items.map((i) => [i.level, i.title]), [
    ['alert', 'ワーカーが応答しません'],
    ['caution', '遅れている定時実行があります'],
    ['caution', 'ディスクの使用量が 80% を超えました'],
  ]);
  assert.match(h.items[0]!.action, /技術者に連絡/);
  assert.equal(h.items[0]!.guide, '07-server');
  const jobs = h.areas.find((a) => a.area === 'jobs')!;
  assert.deepEqual([jobs.level, jobs.summary], ['alert', 'ワーカーが応答しません']);
});

test('区分ごとの決まり: ディスク 90% は警戒、バックアップの失敗は警戒・未導入は注意、外部の接続と会社と AI の費用は注意', () => {
  const disk = opsHealth({ runtime: { ...runtime, machine: { ...runtime.machine!, diskFree: 10e9 } } }, now);
  assert.equal(disk.items[0]?.level, 'alert');
  const failed = opsHealth({ backup: { ...backup, last: { ...backup.last!, ok: false, database: { ok: false, error: 'pgbackrest 失敗' } } } }, now);
  assert.equal(failed.items[0]?.title, '毎晩のバックアップに失敗しました');
  assert.match(failed.items[0]!.detail!, /pgbackrest 失敗/);
  assert.equal(failed.items[0]?.guide, '17-backup-recovery');
  assert.equal(opsHealth({ backup: { ...backup, configured: false, last: null } }, now).items[0]?.level, 'caution');
  const ext = opsHealth({ status: { ...status, targets: [{ group: 'google', ok: 6, fail: 4, avgMs: 900 }] } }, now);
  assert.equal(ext.items[0]?.title, 'Googleの呼び出しの失敗が多くなっています');
  assert.equal(opsHealth({ status: { ...status, targets: [{ group: 'google', ok: 2, fail: 3, avgMs: 900 }] } }, now).items.length, 0, '10 件に満たなければ判断しない');
  const ten = opsHealth({ tenants: [tenant('甲社', 10, 5), tenant('乙社', 3, 3), tenant('丙社', 0, 0, 2)] }, now);
  assert.deepEqual(ten.items.map((i) => [i.title, i.guide]), [['失敗が多い会社が 1 社あります', 'page:tenants'], ['重い不正の兆しがある会社が 1 社あります', 'page:tenants']]);
  assert.equal(opsHealth({ platformAi: { usedJpy: 10000, capJpy: 10000 } }, now).items[0]?.level, 'alert');
  assert.equal(opsHealth({ platformAi: { usedJpy: 8500, capJpy: 10000 } }, now).items[0]?.level, 'caution');
  assert.equal(opsHealth({ status: { ...status, ai: { today: 0, month: 3000, lastMonthSamePeriod: 1000 } } }, now).items.some((i) => i.title === 'AI の費用が前の月の 2 倍を超えました'), true);
});

test('セキュリティは edgeLevel の理由とすることをそのまま使う。Node.js のセキュリティの修正は警戒', () => {
  const h = opsHealth({ edge: edgeStatusView({ ...edgeRaw, geo: { ...edgeRaw.geo!, out24h: 2 } }, now) }, now);
  assert.equal(h.items[0]?.level, 'alert');
  assert.match(h.items[0]!.action, /乗っ取りを疑い/);
  const r = opsHealth({ runtime: { ...runtime, nodeSecurity: [{ role: 'api', version: 'v24.9.0', secure: 'v24.22.1' }] } }, now);
  assert.equal(r.items[0]?.title, 'Node.js にセキュリティの修正があります');
});

test('省いた区分は出さず、読めなかった区分（null）は平常とみなさず注意にする', () => {
  const h = opsHealth({ status, runtime: null }, now);
  assert.deepEqual(h.areas.map((a) => a.area), ['jobs', 'resources', 'external', 'runtime', 'ai']);
  assert.equal(h.level, 'caution');
  assert.deepEqual(h.areas.filter((a) => a.level === 'caution').map((a) => a.summary), ['サーバーの資源を読めませんでした', '稼働環境を読めませんでした']);
});

const machine: MachineStatus = {
  version: '0.29.0', checkedAt: ago(0),
  database: { ok: true, ms: 3, error: null },
  worker: { ok: true, lastSeen: ago(30_000), version: '0.29.0' },
  entrance: { host: 'm2office.clinic.example', certExpires: ago(-60 * 86_400_000), certDaysLeft: 60, error: null },
  localAi: { configured: true, ok: true, models: ['gemma'], error: null },
  disk: { data: { free: 1e12, total: 2e12 }, backup: { free: 3e12, total: 4e12 } },
  backup: {
    configured: true,
    status: { last: { name: '20261103-020000', at: ago(8 * 3_600_000), ok: true, dbBytes: 1e8, error: null }, lastOk: ago(8 * 3_600_000), restoreTest: { at: ago(86_400_000), ok: true, name: 'x', tables: 100, error: null } },
    offsite: { configured: true, status: { last: { name: '20261103-020000', at: ago(7 * 3_600_000), ok: true, snapshot: 'abc', bytesAdded: 1e6, error: null }, lastOkSnapshot: 'abc', check: null } },
  },
  update: { settings: { auto: true, signed: true, hour: 3 }, last: { at: ago(30 * 3_600_000), from: 'v0.28.1', to: 'v0.29.0', result: 'updated' }, history: [], heldUntil: null },
} as unknown as MachineStatus;

test('ローカルの形: 区分は各部の動き・資源・バックアップ・更新・稼働環境。することは「保守の窓口」、手順はヘルプの記事「サーバー」', () => {
  const calmLocal = machineHealth(machine, runtime, now);
  assert.equal(calmLocal.level, 'normal');
  assert.deepEqual(calmLocal.areas.map((a) => a.area), ['parts', 'resources', 'backup', 'update', 'runtime']);
  const h = machineHealth({
    ...machine,
    worker: { ok: false, lastSeen: ago(10 * 60_000), version: '0.29.0' },
    entrance: { ...machine.entrance, certDaysLeft: 5 },
    backup: { ...machine.backup, offsite: { configured: true, status: { ...machine.backup.offsite.status!, last: { ...machine.backup.offsite.status!.last!, ok: false, error: 'NAS に届かない' } } } },
    update: { ...machine.update, last: { at: ago(3_600_000), from: 'v0.28.1', to: 'v0.29.0', result: 'rolled-back' } },
  }, runtime, now);
  assert.equal(h.level, 'alert');
  assert.deepEqual(h.items.map((i) => [i.level, i.title]), [
    ['alert', 'ワーカーが止まっています'],
    ['caution', '入口の証明書の期限が近づいています'],
    ['caution', '別の置き場へバックアップを送れませんでした'],
    ['caution', '更新を入れられず、前の版に戻しました'],
  ]);
  assert.ok(h.items.every((i) => i.guide === 'admin-machine' && !i.action.includes('技術者')));
  assert.match(h.items[0]!.action, /保守の窓口に連絡する/);
});

test('ローカルの形: 社内のバックアップが 26 時間より前で止まっていれば警戒、読めなければ注意', () => {
  const stale = machineHealth({ ...machine, backup: { ...machine.backup, status: { ...machine.backup.status!, lastOk: ago(30 * 3_600_000) } } }, runtime, now);
  assert.equal(stale.items[0]?.title, 'バックアップが止まっています');
  const none = machineHealth(null, null, now);
  assert.equal(none.level, 'caution');
  assert.ok(none.areas.every((a) => a.level === 'caution'));
});
