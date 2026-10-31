/**
 * @file クラウドの形の社外の控えの様子（仕様書 第20.4.6節「控え」、ADR-0120）の確かめ。
 *
 * 結果のファイルの読み方と、運営の画面に出す形（止まっている・変更の記録を送れていない）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudBackupView, readCloudBackupRun, type CloudBackupRun } from '../src/index.js';

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
