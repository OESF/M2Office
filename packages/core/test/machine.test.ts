/**
 * @file ローカルの形の「機械」の単体テスト（仕様書 第8.6.5節・第8.6.7節）。
 * 控えの名前（日本時間）、残す控えの選び方（毎日 14 回・毎週 8 回・毎月 12 回）、控えの頼みの置き方と取り方、
 * 環境変数からの設定（控えはローカルの形で置き場があるときだけ・入口の名前）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupConfigFromEnv, backupName, backupsToKeep, machineConfigFromEnv, requestBackup, takeBackupRequest } from '../src/index.js';

test('控えの名前: 日本時間の日付と時刻', () => {
  assert.equal(backupName(new Date('2026-10-06T17:05:09Z')), '20261007-020509');
});

test('残す控え: 毎日 14 回・毎週 8 回・毎月 12 回（同じ日は新しいものだけ）', () => {
  const names: string[] = [];
  // 2025-10-01 から 2026-10-07 まで毎日 2 時と 3 時に取った
  for (let t = Date.UTC(2025, 9, 1); t <= Date.UTC(2026, 9, 7); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
    names.push(`${d}-020000`, `${d}-030000`);
  }
  const keep = backupsToKeep([...names, 'not-a-backup']);
  // 新しい 14 日（それぞれの日の新しい方）
  assert.ok(keep.has('20261007-030000') && !keep.has('20261007-020000'));
  assert.ok(keep.has('20260924-030000'));
  assert.ok(!keep.has('not-a-backup'));
  // 月ごとに 1 つ（12 か月）
  const months = new Set([...keep].map((n) => n.slice(0, 6)));
  assert.equal(months.size, 12);
  assert.ok(keep.size <= 14 + 8 + 12);
  assert.ok(!keep.has('20251001-030000'), '13 か月より前は残さない');
});

test('今すぐ控えを取る: 頼みを置き、ワーカーが 1 回だけ取る', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm2o-backup-'));
  try {
    assert.equal(await takeBackupRequest(dir), false);
    await requestBackup(dir, 'u1');
    assert.equal(await takeBackupRequest(dir), true);
    assert.equal(await takeBackupRequest(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('設定: 控えは置き場があるときだけ。入口の名前は APP_BASE_URL から（会社の名前の入った形は使わない）', () => {
  assert.equal(backupConfigFromEnv({}), null);
  const b = backupConfigFromEnv({ M2O_BACKUP_DIR: '/Volumes/Backup/M2Office', M2O_PG_BIN: '/Library/M2Office/app/runtime/postgres/bin' });
  assert.equal(b?.dir, '/Volumes/Backup/M2Office');
  assert.equal(b?.pgBin, '/Library/M2Office/app/runtime/postgres/bin');
  assert.equal(machineConfigFromEnv({ APP_BASE_URL: 'https://office.example.jp' }, '1.0.0').host, 'office.example.jp');
  assert.equal(machineConfigFromEnv({ APP_BASE_URL: 'https://{tenant}.m2office.online' }, '1.0.0').host, null);
  assert.deepEqual(machineConfigFromEnv({ LOCAL_LLM_URL: 'http://127.0.0.1:11434/v1', LOCAL_LLM_MODEL: 'gemma3' }, '1').localLlm, { url: 'http://127.0.0.1:11434/v1', model: 'gemma3' });
});
