/**
 * @file 調べものの持ち越しの単体テスト（仕様書 第10.11.7節）。
 *
 * 二度伝えないこと、日が経ちすぎたものを蒸し返さないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Repository } from '@m2office/core';
import { CARRY_OVER_DAYS, claimUntold, listLookups } from '../src/secretary/lookups.js';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** 調べもの 1 件ぶんの実行と依頼。 */
const lookup = (id: string, status: string, endedAt: string | null) => ({
  run: { id, status, endedAt, failureReason: null },
  job: { agentId: 'secretary-lookup', input: { request: `依頼 ${id}` } },
});

function fake(rows: ReturnType<typeof lookup>[]) {
  // 記録できたかを返す。二度目は false（取り合いに負けた側）
  const told = new Set<string>();
  const claims: string[] = [];
  const repo = {
    listRunsWithJobs: async () => rows,
    listRunSteps: async () => [{ stepId: 'answer', status: 'succeeded', output: { text: '答えです' } }],
    listToldLookups: async (_t: string, ids: string[]) => ids.filter((i) => told.has(i)),
    claimLookupDelivery: async (_t: string, runId: string) => {
      claims.push(runId);
      if (told.has(runId)) return false;
      told.add(runId);
      return true;
    },
  } as unknown as Repository;
  return { repo, told, claims };
}

test('まだ伝えていない調べものを返し、伝えたことを記録する', async () => {
  const { repo, told } = fake([lookup('r1', 'completed', ago(0))]);

  const first = await claimUntold(repo, 't', 'u1', NOW);
  assert.deepEqual(first.map((x) => x.runId), ['r1']);
  assert.equal(first[0]!.text, '答えです');
  assert.equal(told.has('r1'), true);
});

test('二度目は返さない（画面を開き直しても、同じ答えを繰り返さない）', async () => {
  const { repo } = fake([lookup('r1', 'completed', ago(0))]);

  await claimUntold(repo, 't', 'u1', NOW);
  const second = await claimUntold(repo, 't', 'u1', NOW);
  assert.deepEqual(second, []);
});

test('記録を先に取るため、同時に呼ばれても一方だけが伝える', async () => {
  // 画面と音声の双方から同時に呼ばれる場合にあたる
  const { repo } = fake([lookup('r1', 'completed', ago(0))]);

  const [a, b] = await Promise.all([
    claimUntold(repo, 't', 'u1', NOW),
    claimUntold(repo, 't', 'u1', NOW),
  ]);
  assert.equal(a.length + b.length, 1, '伝えるのは一方だけ');
});

test(`終わってから ${CARRY_OVER_DAYS} 日を過ぎたものは伝えない`, async () => {
  const { repo, told } = fake([
    lookup('r-new', 'completed', ago(CARRY_OVER_DAYS - 1)),
    lookup('r-old', 'completed', ago(CARRY_OVER_DAYS + 1)),
  ]);

  const out = await claimUntold(repo, 't', 'u1', NOW);
  assert.deepEqual(out.map((x) => x.runId), ['r-new']);
  // 古いものも記録は取る。以降も蒸し返さないため
  assert.equal(told.has('r-old'), true);
});

test('動いている途中のものは、伝えも記録もしない', async () => {
  const { repo, claims } = fake([lookup('r1', 'running', null)]);

  const out = await claimUntold(repo, 't', 'u1', NOW);
  assert.deepEqual(out, []);
  assert.deepEqual(claims, [], '終わっていないものは記録しない');
});

test('失敗したものも伝える（黙って終わらせない）', async () => {
  const { repo } = fake([lookup('r1', 'failed', ago(0))]);

  const out = await claimUntold(repo, 't', 'u1', NOW);
  assert.deepEqual(out.map((x) => x.status), ['failed']);
});

test('一覧には、伝えたかどうかが付く', async () => {
  const { repo } = fake([lookup('r1', 'completed', ago(0))]);

  const before = await listLookups(repo, 't', 'u1');
  assert.equal(before[0]!.told, false);

  await claimUntold(repo, 't', 'u1', NOW);
  const after = await listLookups(repo, 't', 'u1');
  assert.equal(after[0]!.told, true);
});
