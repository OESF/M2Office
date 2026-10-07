/**
 * @file 社外の控え（仕様書 第8.6.5節）の確かめ。
 *
 * restic の代わりの台本で、渡す引数（相対の道・親の控え・印でまとめた残し方）と、合言葉と鍵を引数に出さず環境変数だけで渡すことを見る。
 * restic が入っている機械では、手元の置き場で本物の restic を使い、送って・残し方を当てて・確かめて・戻せることまで見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOffsite, offsiteConfigFromEnv, parseBackupSummary, readOffsiteStatus, runOffsite, type OffsiteConfig } from '../src/index.js';

/** 社内の控えの 1 回分を作る。 */
function backupDir(): { dir: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), 'm2o-offsite-'));
  const name = '20261008-020000';
  mkdirSync(join(dir, name, 'files', 't-alpha'), { recursive: true });
  writeFileSync(join(dir, name, 'db.dump'), 'PGDMP'.padEnd(200, 'x'));
  writeFileSync(join(dir, name, 'files', 't-alpha', 'a.txt'), '中身');
  return { dir, name };
}

/** 引数・作業の場所・環境変数を書き残す restic の代わり。`FAIL` があれば失敗する。 */
function fakeRestic(dir: string): { bin: string; log: string } {
  const bin = join(dir, 'restic');
  const log = join(dir, 'calls.log');
  writeFileSync(bin, `#!/bin/bash
echo "$PWD|$*|$RESTIC_PASSWORD|$AWS_ACCESS_KEY_ID|$RESTIC_CACHE_DIR" >> "${log}"
[ -f "${join(dir, 'FAIL')}" ] && { echo 'Fatal: unable to open repository' >&2; exit 1; }
if [ "$1" = backup ]; then
  echo '{"message_type":"status","percent_done":1}'
  echo '{"message_type":"summary","snapshot_id":"snap-'"$RANDOM$RANDOM"'","data_added":1234}'
fi
exit 0
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

test('設定: S3 互換の置き場と合言葉と鍵がそろったときだけ', () => {
  const env = { M2O_OFFSITE_REPOSITORY: 's3:https://s3.example/bucket/m2o', M2O_OFFSITE_PASSWORD: 'pw', M2O_OFFSITE_ACCESS_KEY_ID: 'AK', M2O_OFFSITE_SECRET_ACCESS_KEY: 'SK' };
  assert.equal(offsiteConfigFromEnv({ ...env, M2O_OFFSITE_PASSWORD: '' }, '/m'), null);
  assert.equal(offsiteConfigFromEnv({ ...env, M2O_OFFSITE_REPOSITORY: 'sftp:host:/x' }, '/m'), null);
  const cfg = offsiteConfigFromEnv({ ...env, M2O_OFFSITE_REGION: 'ap-northeast-1' }, '/m')!;
  assert.equal(cfg.cacheDir, '/m/restic-cache');
  assert.equal(cfg.region, 'ap-northeast-1');
});

test('要約: restic の backup --json の最後の行から控えの番号と送った量を取る', () => {
  assert.deepEqual(parseBackupSummary('{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"abc","data_added":5}\n'), { snapshot: 'abc', bytesAdded: 5 });
  assert.deepEqual(parseBackupSummary('何か\n'), { snapshot: null, bytesAdded: 0 });
});

test('送る: 1 回分の中から相対の道で送り、2 回目は前の控えを親にする。残し方は印でまとめる。合言葉は引数に出さない', async () => {
  const { dir, name } = backupDir();
  const { bin, log } = fakeRestic(dir);
  const cfg: OffsiteConfig = { repository: 's3:https://s3.example/b', password: 'secret-pass', accessKeyId: 'AKID', secretAccessKey: 'SK', region: null, resticBin: bin, cacheDir: join(dir, 'cache') };
  const r1 = await runOffsite(dir, name, cfg, new Date('2026-10-07T17:00:00Z'));
  assert.equal(r1.ok, true);
  assert.equal(r1.bytesAdded, 1234);
  const r2 = await runOffsite(dir, name, cfg, new Date('2026-10-08T17:00:00Z'));
  assert.equal(r2.ok, true);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('|'));
  assert.equal(calls.length, 4);
  const [cwd1, args1, pass, ak, cache] = calls[0]!;
  assert.match(cwd1!, new RegExp(`${name}$`));
  assert.equal(args1, 'backup --json --tag m2office --host m2office db.dump files');
  assert.equal(pass, 'secret-pass');
  assert.equal(ak, 'AKID');
  assert.equal(cache, join(dir, 'cache'));
  assert.equal(calls[1]![1], 'forget --tag m2office --group-by host,tags --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune');
  assert.equal(calls[2]![1], `backup --json --tag m2office --host m2office --parent ${r1.snapshot} db.dump files`);
  for (const c of calls) assert.doesNotMatch(c[1]!, /secret-pass|SK/);
  assert.equal((await readOffsiteStatus(dir)).lastOkSnapshot, r2.snapshot);
});

test('失敗: 理由を残し、親は前のうまくいった控えのまま。確かめの失敗も残す', async () => {
  const { dir, name } = backupDir();
  const { bin } = fakeRestic(dir);
  const cfg: OffsiteConfig = { repository: 's3:https://s3.example/b', password: 'p', accessKeyId: 'a', secretAccessKey: 's', region: null, resticBin: bin, cacheDir: join(dir, 'cache') };
  const ok = await runOffsite(dir, name, cfg);
  writeFileSync(join(dir, 'FAIL'), '');
  const ng = await runOffsite(dir, name, cfg);
  assert.equal(ng.ok, false);
  assert.match(ng.error!, /unable to open repository/);
  const st = await readOffsiteStatus(dir);
  assert.equal(st.last?.ok, false);
  assert.equal(st.lastOkSnapshot, ok.snapshot);
  const c = await checkOffsite(dir, cfg);
  assert.equal(c.ok, false);
  assert.equal((await readOffsiteStatus(dir)).check?.ok, false);
});

const hasRestic = (() => { try { execFileSync('restic', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('本物の restic: 送って、確かめて、戻すと同じ中身になる', { skip: hasRestic ? false : 'restic が入っていません' }, async () => {
  const { dir, name } = backupDir();
  const repo = join(dir, 'repo');
  const cfg: OffsiteConfig = { repository: repo, password: 'test-pass', accessKeyId: 'x', secretAccessKey: 'x', region: null, resticBin: null, cacheDir: join(dir, 'cache') };
  const env = { ...process.env, RESTIC_REPOSITORY: repo, RESTIC_PASSWORD: 'test-pass', RESTIC_CACHE_DIR: cfg.cacheDir };
  execFileSync('restic', ['init'], { env, stdio: 'ignore' });
  const r1 = await runOffsite(dir, name, cfg);
  assert.equal(r1.ok, true, r1.error ?? '');
  writeFileSync(join(dir, name, 'files', 't-alpha', 'b.txt'), '足したもの');
  const r2 = await runOffsite(dir, name, cfg);
  assert.equal(r2.ok, true, r2.error ?? '');
  assert.ok(r2.bytesAdded < 10_000);
  assert.equal((await checkOffsite(dir, cfg)).ok, true);
  const target = join(dir, 'restored');
  execFileSync('restic', ['restore', 'latest', '--tag', 'm2office', '--target', target], { env, stdio: 'ignore' });
  assert.ok(existsSync(join(target, 'db.dump')));
  assert.equal(readFileSync(join(target, 'files', 't-alpha', 'b.txt'), 'utf8'), '足したもの');
});
