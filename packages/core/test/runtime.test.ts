/**
 * @file 動いている環境（仕様書 第8.6.7.1節）のテスト。Node.js の版から段階・サポートの終わり・知らせるかを決めること、
 * セキュリティの修正の下限との比べ方（数として比べる）、macOS の使えるメモリーの数え方、
 * API とワーカーの知らせから環境を組み立てること（止まった知らせ・更新の知らせ・セキュリティの修正・取れなかった値）を見る。
 * M2Medical の同じテスト（packages/core/test/runtime.test.ts）を写して足した。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_RELEASE_LINES, compareNodeVersions, nodeSupport, type RuntimeBeat } from '@m2office/shared';
import { availableMemoryOf, inferenceText, runtimeEnvironment, workerDown, WORKER_BEAT_INTERVAL_MS, WORKER_DOWN_MS, isTransientDbError } from '../src/index.js';

test('段階: Current → LTS → 保守の段階 → サポートの終わり', () => {
  assert.equal(nodeSupport('v26.12.1', '2026-10-22').stage, 'current');
  assert.equal(nodeSupport('v26.12.1', '2026-10-28').stage, 'lts');
  assert.equal(nodeSupport('v24.22.1', '2026-10-22').stage, 'maintenance', '24 系は 2026-10-20 から保守の段階');
  assert.equal(nodeSupport('v24.22.1', '2026-10-19').stage, 'lts');
  assert.equal(nodeSupport('v22.14.0', '2027-04-30').stage, 'eol');
  assert.equal(nodeSupport('v24.22.1', '2026-10-22').codename, 'Krypton');
  assert.equal(nodeSupport('v26.0.0', '2026-06-01').codename, null, 'LTS になる前は名前を出さない');
});

test('奇数の系は LTS にならない。表に無い系は「表にない」で知らせない', () => {
  assert.equal(nodeSupport('v25.1.0', '2026-05-01').stage, 'current');
  assert.equal(nodeSupport('v25.1.0', '2026-06-01').stage, 'eol');
  const x = nodeSupport('v99.0.0', '2026-10-22');
  assert.deepEqual([x.stage, x.end, x.warn], ['unknown', null, false]);
  assert.equal(nodeSupport('壊れた値', '2026-10-22').major, null);
});

test('サポートの終わりの 6 か月前から知らせ、終わったら expired', () => {
  assert.equal(nodeSupport('v22.23.4', '2026-10-29').warn, false);
  assert.equal(nodeSupport('v22.23.4', '2026-10-30').warn, true, '2027-04-30 の 6 か月前');
  assert.equal(nodeSupport('v22.23.4', '2026-10-30').expired, false);
  assert.equal(nodeSupport('v22.23.4', '2027-04-30').expired, true);
  assert.equal(nodeSupport('v24.22.1', '2026-10-22').warn, false);
});

test('セキュリティの修正の下限: 版は数として比べ、下限より古ければ知らせる（2026-10-21 の発表）', () => {
  assert.ok(compareNodeVersions('v24.9.0', 'v24.22.1')! < 0, '文字の並びでは v24.9.0 のほうが後になるが、数としては古い');
  assert.equal(compareNodeVersions('v24.22.1', '24.22.1'), 0);
  assert.ok(compareNodeVersions('v24.22.10', 'v24.22.9')! > 0);
  assert.equal(compareNodeVersions('v24.22.1-rc.1', 'v24.22.1'), null, '読めない版は比べない');
  assert.deepEqual(NODE_RELEASE_LINES.map((x) => [x.major, x.secure]), [[20, null], [22, 'v22.23.4'], [24, 'v24.22.1'], [25, null], [26, 'v26.12.1'], [27, null]], 'M2Medical と同じ値');
  const old = nodeSupport('v24.9.0', '2026-10-23');
  assert.deepEqual([old.secure, old.insecure], ['v24.22.1', true]);
  assert.equal(nodeSupport('v24.22.1', '2026-10-23').insecure, false, '下限と同じ版は直してある');
  assert.equal(nodeSupport('v22.23.3', '2026-10-23').insecure, true);
  assert.equal(nodeSupport('v26.13.0', '2026-10-23').insecure, false);
  assert.equal(nodeSupport('v20.19.0', '2026-10-23').insecure, false, 'サポートの終わった系は下限を持たない（サポートの終わりで知らせる）');
  assert.equal(nodeSupport('壊れた値', '2026-10-23').insecure, false);
});

test('表は系の順に並び、日付の前後が正しい', () => {
  for (const [i, x] of NODE_RELEASE_LINES.entries()) {
    if (i > 0) assert.ok(x.major > NODE_RELEASE_LINES[i - 1]!.major);
    assert.ok(x.released < x.end);
    if (x.lts) assert.ok(x.released < x.lts && x.lts < (x.maintenance ?? x.end));
    // 26 系までは偶数の系だけが LTS。27 系からは、どの系も LTS になる（公式の予定。2026-10-22 に見比べた）
    if (x.major <= 26) assert.equal(x.lts !== null, x.major % 2 === 0, '26 系までは偶数の系だけ LTS');
    else assert.ok(x.lts !== null, '27 系からはどの系も LTS');
  }
});

test('macOS の使えるメモリー: 空き・使っていない・先読み・捨てられるページを足す', () => {
  const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                3811.\nPages active:                             57281.\nPages inactive:                           51410.\nPages speculative:                         4904.\nPages purgeable:                              0.\n';
  assert.equal(availableMemoryOf(vm), (3811 + 51410 + 4904) * 16384);
  assert.equal(availableMemoryOf('読めない'), null);
});

const machine = { os: 'macOS 26.1', arch: 'arm64', cpu: 'Apple M2', cores: 8, memTotal: 8 * 1024 ** 3, memFree: 1.2 * 1024 ** 3 };
const beat = (role: 'api' | 'worker', node: string, at: string, version = '0.19.0'): RuntimeBeat => ({ role, version, node, startedAt: '2026-10-22T00:00:00Z', at, machine });

test('API とワーカーの知らせから組み立てる: 止まった知らせ・違う版・更新の知らせ・取れなかった値', () => {
  const now = new Date('2026-11-01T03:00:00Z');
  const env = runtimeEnvironment([beat('api', 'v24.22.1', '2026-11-01T02:58:00Z'), beat('worker', 'v22.23.4', '2026-11-01T02:40:00Z', '0.18.0')], '17.6', {
    deployment: 'onsite', debug: false, inference: 'ローカル AI（gemma）', now,
  });
  assert.equal(env.api?.node.stage, 'maintenance');
  assert.equal(env.api?.stale, false);
  assert.equal(env.worker?.stale, true, '12 分より古い知らせは止まっているかもしれない');
  assert.equal(env.worker?.version, '0.18.0');
  assert.deepEqual(env.nodeWarn, { expired: false, end: '2027-04-30', version: 'v22.23.4' }, 'ワーカーの 22 系は 6 か月を切った');
  assert.equal(env.nodeSecurity, null, 'どちらも下限以上');
  assert.equal(env.machine?.cores, 8);
  assert.equal(env.postgres, '17.6');
  const none = runtimeEnvironment([], null, { deployment: 'cloud', debug: true, inference: null, now });
  assert.deepEqual([none.api, none.worker, none.machine, none.postgres, none.nodeWarn], [null, null, null, null, null], '取れなかった値は推測で埋めない');
});

test('下限より古い部分を、API・ワーカーごとに知らせる。起動は止めない', () => {
  const now = new Date('2026-10-23T03:00:00Z');
  const env = runtimeEnvironment([beat('api', 'v24.9.0', '2026-10-23T02:58:00Z'), beat('worker', 'v24.22.1', '2026-10-23T02:58:00Z')], null, {
    deployment: 'cloud', debug: false, inference: null, now,
  });
  assert.deepEqual(env.nodeSecurity, [{ role: 'api', version: 'v24.9.0', secure: 'v24.22.1' }]);
  assert.equal(env.api?.node.insecure, true);
  const both = runtimeEnvironment([beat('api', 'v24.9.0', '2026-10-23T02:58:00Z'), beat('worker', 'v22.1.0', '2026-10-23T02:58:00Z')], null, { deployment: 'onsite', debug: false, inference: null, now });
  assert.deepEqual(both.nodeSecurity?.map((x) => `${x.role}:${x.secure}`), ['api:v24.22.1', 'worker:v22.23.4']);
});

test('推論の説明に、秘密の値や口の URL を入れない', () => {
  const t = inferenceText({ baseUrl: 'http://127.0.0.1:11434/v1', models: { fast: 'gemma3', standard: 'gemma3', advanced: 'gemma3:27b' } as never, apiKey: 'secret-key' }, 'onsite');
  assert.match(t, /ローカル AI（gemma3・gemma3:27b）/);
  assert.ok(!t.includes('secret-key') && !t.includes('127.0.0.1'));
});

test('ワーカーが止まっているか: 知らせが無いか 3 分より古ければ止まっている（第8.6.7.1節「ワーカーが止まったら」）', () => {
  const now = new Date('2026-10-25T14:00:00.000Z');
  const beat = (role: 'api' | 'worker', at: string) => ({
    role, version: '0.20.0', node: 'v24.22.1', startedAt: '2026-10-25T13:00:00.000Z', at,
    machine: { os: null, arch: null, cpu: null, cores: null, memTotal: null, memFree: null },
  });
  assert.equal(workerDown([beat('api', '2026-10-25T13:59:50.000Z')], now), true, 'ワーカーの知らせが無い');
  assert.equal(workerDown([beat('worker', '2026-10-25T13:58:00.000Z')], now), false, '2 分前なら動いている');
  assert.equal(workerDown([beat('worker', '2026-10-25T13:56:30.000Z')], now), true, '3 分より古ければ止まっている');
  assert.ok(WORKER_BEAT_INTERVAL_MS * 2 < WORKER_DOWN_MS, '知らせ 1 回の遅れでは止まったと言わない');
});

test('一時的なデータベースの例外: 切断・立て直しの途中は続け、ほかの例外は続けない（第8.6.7.1節「止まらないように」）', () => {
  assert.equal(isTransientDbError(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isTransientDbError(Object.assign(new Error('the database system is in recovery mode'), { code: '57P03' })), true);
  assert.equal(isTransientDbError(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })), true);
  assert.equal(isTransientDbError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })), true);
  assert.equal(isTransientDbError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isTransientDbError(Object.assign(new Error('duplicate key value'), { code: '23505' })), false);
});
