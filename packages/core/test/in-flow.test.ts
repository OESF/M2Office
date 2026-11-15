/**
 * @file 一連の流れの中の承認の見分けの単体テスト（仕様書 第47.5節、ADR-0148）。
 *
 * 本人が操作して起こした業務（秘書に頼んだ・画面で承認へ進めた・段取りの段）の承認は、12 時間の内は承認トレイに出さない。
 * ほかの人の依頼・システムが起こした業務（定時実行・自動の議事録・相手からの返事・外部のアプリ）・時間がたったものは承認トレイに出す。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueJob, isInFlowApproval, type Repository } from '../src/index.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const at = (hoursAgo: number) => ({ createdAt: new Date(now - hoursAgo * 3_600_000).toISOString() });

test('本人が起こした業務の承認は、秘書からでも画面からでも、12 時間の内は流れの中', () => {
  assert.equal(isInFlowApproval(at(1), { requestedBy: 'u1', origin: 'secretary', startedBy: 'user' }, 'u1', now), true);
  assert.equal(isInFlowApproval(at(1), { requestedBy: 'u1', origin: 'menu', startedBy: 'user' }, 'u1', now), true, '画面で「承認へ進む」を押したもの');
  assert.equal(isInFlowApproval(at(13), { requestedBy: 'u1', origin: 'menu', startedBy: 'user' }, 'u1', now), false, '時間がたったものは承認トレイ');
});

test('ほかの人の依頼・システムが起こした業務・定時実行の承認は、承認トレイ', () => {
  assert.equal(isInFlowApproval(at(1), { requestedBy: 'u2', origin: 'menu', startedBy: 'user' }, 'u1', now), false, 'ほかの人の依頼（承認者として見ている）');
  assert.equal(isInFlowApproval(at(1), { requestedBy: 'u1', origin: 'secretary', startedBy: 'system' }, 'u1', now), false, '自動の議事録・相手からの返事など');
  assert.equal(isInFlowApproval(at(1), { requestedBy: 'u1', origin: 'schedule', startedBy: null }, 'u1', now), false, '定時実行');
  assert.equal(isInFlowApproval(at(1), null, 'u1', now), false);
  assert.equal(isInFlowApproval(at(1), { requestedBy: 'u1', origin: 'menu', startedBy: null }, 'u1', now), true, '記録の無い古い依頼は、定時実行でなければ本人のもの');
});

test('業務を起こすとき、起こした人（本人かシステムか）を記録する。段取りの段は本人の流れとして渡せる', async () => {
  const jobs: { startedBy?: string | null }[] = [];
  const repo = { createJob: async (j: { startedBy?: string | null }) => { jobs.push(j); }, createRun: async () => undefined, appendAudit: async () => undefined } as unknown as Repository;
  const def = { schemaVersion: 1, id: 'x', version: 1, name: 'x' } as never;
  await enqueueJob(repo, { tenantId: 't', requestedBy: 'u1', def, input: {}, origin: 'menu', actor: { type: 'user', id: 'u1' } });
  await enqueueJob(repo, { tenantId: 't', requestedBy: 'u1', def, input: {}, origin: 'secretary', actor: { type: 'system', id: 'auto-minutes' } });
  await enqueueJob(repo, { tenantId: 't', requestedBy: 'u1', def, input: {}, origin: 'secretary', actor: { type: 'system', id: 'secretary-plan' }, startedBy: 'user' });
  assert.deepEqual(jobs.map((j) => j.startedBy), ['user', 'system', 'user']);
});

test('承認の後に実行した操作が失敗したかを、ツールの答えの形から読む（失敗なら業務を失敗にする）', async () => {
  const { recordedCallFailure } = await import('../src/index.js');
  assert.equal(recordedCallFailure({ name: 'columns.place', result: { available: false, reason: 'カバー画像を WordPress に入れられませんでした（401）' } }), 'カバー画像を WordPress に入れられませんでした（401）');
  assert.equal(recordedCallFailure({ name: 'x', error: '許可されていないツールです' }), '許可されていないツールです');
  assert.equal(recordedCallFailure({ name: 'x', result: { error: '取得できませんでした: 401' } }), '取得できませんでした: 401');
  assert.equal(recordedCallFailure({ name: 'columns.place', result: { available: true, placed: true } }), null);
  assert.equal(recordedCallFailure(null), null);
});
