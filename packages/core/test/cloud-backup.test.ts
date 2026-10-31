/**
 * @file クラウドの形の社外の控えの様子（仕様書 第20.4.6節「控え」、ADR-0120）の確かめ。
 *
 * 結果のファイルの読み方と、運営の画面に出す形（止まっている・変更の記録を送れていない・戻せる範囲・更新の前の戻す点・次の予定）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudBackupView, nextNightlyRun, readCloudBackupRun, readRestorePoints, type CloudBackupRun } from '../src/index.js';

const run = (at: string, ok = true): CloudBackupRun => ({
  at, startedAt: at, ok, database: { ok, error: ok ? null : '送れません' }, files: { ok: true, error: null, snapshot: 'abc' }, check: null,
});

test('結果のファイル: 無い・壊れているときは null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-cloud-backup-'));
  assert.equal(await readCloudBackupRun(join(dir, 'none.json')), null);
  writeFileSync(join(dir, 'bad.json'), '{');
  assert.equal(await readCloudBackupRun(join(dir, 'bad.json')), null);
  writeFileSync(join(dir, 'ok.json'), JSON.stringify(run('2026-10-31T17:10:00Z')));
  assert.equal((await readCloudBackupRun(join(dir, 'ok.json')))?.files.snapshot, 'abc');
});

test('入れていない・止まっている・送れていないを見分ける', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(cloudBackupView(null, { enabled: false, lastArchivedAt: null, lastFailedAt: null, failedCount: 0 }, now).configured, false);
  const fresh = cloudBackupView(run('2026-11-01T02:10:00Z'), { enabled: true, lastArchivedAt: '2026-11-01T11:58:00Z', lastFailedAt: null, failedCount: 0 }, now);
  assert.deepEqual([fresh.configured, fresh.stale, fresh.archiveFailing], [true, false, false]);
  assert.equal(cloudBackupView(run('2026-10-31T02:10:00Z'), null, now).stale, true);
  const failing = cloudBackupView(run('2026-11-01T02:10:00Z'), { enabled: true, lastArchivedAt: '2026-11-01T10:00:00Z', lastFailedAt: '2026-11-01T11:59:00Z', failedCount: 3 }, now);
  assert.equal(failing.archiveFailing, true);
  // 失敗の後に送れていれば、いまは送れている
  assert.equal(cloudBackupView(null, { enabled: true, lastArchivedAt: '2026-11-01T11:59:30Z', lastFailedAt: '2026-11-01T11:59:00Z', failedCount: 1 }, now).archiveFailing, false);
});

test('戻せる範囲と更新の前の戻す点（第23.8.7節「控えの様子」）', async () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const last: CloudBackupRun = {
    ...run('2026-11-01T02:10:00Z'),
    inventory: { location: { kind: 'gcs', bucket: 'b', project: 'p' }, database: { count: 14, oldest: '2026-10-19T17:20:00Z', newest: '2026-11-01T17:20:00Z', bytes: 1 }, files: null },
  };
  const archive = { enabled: true, lastArchivedAt: '2026-11-01T11:58:00Z', lastFailedAt: null, failedCount: 0 };
  const v = cloudBackupView(last, archive, now, [
    { name: 'update-v0.27.0', at: '2026-10-10T01:00:00Z', lsn: null },
    { name: 'update-v0.28.0', at: '2026-10-30T01:00:00Z', lsn: '0/3000000' },
  ]);
  assert.deepEqual(v.recoverable, { from: '2026-10-19T17:20:00Z', to: '2026-11-01T11:58:00Z' });
  // 新しい順。いちばん古いまるごとの控えより前の点は、もう戻せない
  assert.deepEqual(v.restorePoints.map((p) => [p.name, p.restorable]), [['update-v0.28.0', true], ['update-v0.27.0', false]]);
  // 前の版の結果（一覧が無い）では、戻せる範囲の始まりが分からず、点はどれも戻せるとは言わない
  const old = cloudBackupView(run('2026-11-01T02:10:00Z'), archive, now, [{ name: 'update-v0.28.0', at: '2026-10-30T01:00:00Z', lsn: null }]);
  assert.deepEqual([old.recoverable.from, old.restorePoints[0]?.restorable], [null, false]);

  const dir = mkdtempSync(join(tmpdir(), 'm2o-restore-points-'));
  assert.deepEqual(await readRestorePoints(join(dir, 'none.json')), []);
  writeFileSync(join(dir, 'rp.json'), JSON.stringify([{ name: 'update-v0.28.0', at: '2026-10-30T01:00:00Z', lsn: null }, { bad: 1 }]));
  assert.equal((await readRestorePoints(join(dir, 'rp.json'))).length, 1);
});

test('次の毎晩の控えは、日本時間の 2 時', () => {
  // 日本時間 11/1 21:00 → 11/2 2:00
  assert.equal(nextNightlyRun(Date.parse('2026-11-01T12:00:00Z')), '2026-11-01T17:00:00.000Z');
  // 日本時間 11/2 1:59 → 同じ日の 2:00
  assert.equal(nextNightlyRun(Date.parse('2026-11-01T16:59:00Z')), '2026-11-01T17:00:00.000Z');
  // ちょうど 2:00 なら次の日
  assert.equal(nextNightlyRun(Date.parse('2026-11-01T17:00:00Z')), '2026-11-02T17:00:00.000Z');
});
