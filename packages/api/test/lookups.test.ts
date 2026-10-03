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

test('秘書が頼んだ業務も並べ、名前・承認待ち・成果物のリンクを添える。伝えた結果は会話ログに残す（第10.9.6節）', async () => {
  const rows = [
    { run: { id: 's1', status: 'completed', endedAt: ago(0), failureReason: null }, job: { agentId: 'jp.x:research-slides', origin: 'secretary', input: { request: 'ローカル LLM を 6 ページで' } } },
    { run: { id: 's2', status: 'awaiting_approval', endedAt: null, failureReason: null }, job: { agentId: 'minutes', origin: 'secretary', input: { title: '定例' } } },
    { run: { id: 's3', status: 'completed', endedAt: ago(0), failureReason: null }, job: { agentId: 'minutes', origin: 'menu', input: { title: '別件' } } },
  ];
  const logged: { message: string; reply: string; runId: string }[] = [];
  const told = new Set<string>();
  const repo = {
    listRunsWithJobs: async () => rows,
    listRunSteps: async () => [{ stepId: 'work', status: 'succeeded', output: { text: 'スライドを作りました' } }],
    listArtifacts: async (_t: string, runId: string) => (runId === 's1' ? [{ title: 'ローカル LLM', body: '開く: https://docs.google.com/presentation/d/X/edit\n...' }] : []),
    listToldLookups: async () => [...told],
    claimLookupDelivery: async (_t: string, runId: string) => { told.add(runId); return true; },
    getUserSettings: async () => ({ memory: { keepConversations: true } }),
    appendConversation: async (c: { message: string; reply: string; runId: string }) => { logged.push(c); },
  } as unknown as Repository;
  const names = (id: string) => (id === 'jp.x:research-slides' ? 'スライドの作成' : id === 'minutes' ? '議事録の作成・共有' : undefined);
  const list = await listLookups(repo, 't', 'u', names);
  assert.deepEqual(list.map((x) => x.runId), ['s1', 's2'], 'メニューから起こした業務は並べない');
  assert.equal(list[0]!.agentName, 'スライドの作成');
  assert.match(list[0]!.text!, /スライドを作りました\n\n作ったもの:\n- ローカル LLM https:\/\/docs\.google\.com\/presentation\/d\/X\/edit/);
  assert.equal(list[1]!.progress, '承認を待っています');
  assert.equal(list[1]!.request, '定例', '依頼の文が無ければ最初の入力');
  const claimed = await claimUntold(repo, 't', 'u', NOW, names);
  assert.deepEqual(claimed.map((x) => x.runId), ['s1'], '承認待ちはまだ伝えない');
  assert.equal(logged.length, 1);
  assert.match(logged[0]!.message, /「スライドの作成」に頼んだ結果/);
  assert.equal(logged[0]!.runId, 's1');
});

test('朝のブリーフは、その日のうちだけ伝える（前の日のものは言い出さない）', async () => {
  const rows = [
    { run: { id: 'b1', status: 'completed', endedAt: '2026-09-22T22:40:00.000Z', failureReason: null }, job: { agentId: 'morning-brief', origin: 'schedule', input: {} } },
    { run: { id: 'b2', status: 'completed', endedAt: '2026-09-23T00:10:00.000Z', failureReason: null }, job: { agentId: 'morning-brief', origin: 'schedule', input: {} } },
  ];
  const told = new Set<string>();
  const repo = {
    listRunsWithJobs: async () => rows,
    listRunSteps: async () => [{ stepId: 'write', status: 'succeeded', output: { text: 'おはようございます' } }],
    listArtifacts: async () => [],
    listToldLookups: async () => [...told],
    claimLookupDelivery: async (_t: string, runId: string) => { told.add(runId); return true; },
  } as unknown as Repository;
  // NOW は 2026-09-23 21:00（日本時間）。b1 は 09-23 7:40、b2 は 09-23 9:10（どちらも日本時間）
  const claimed = await claimUntold(repo, 't', 'u', new Date('2026-09-23T12:00:00.000Z'));
  assert.deepEqual(claimed.map((x) => [x.runId, x.request]), [['b1', '今朝のブリーフ'], ['b2', '今朝のブリーフ']]);
  const next = await claimUntold(repo, 't', 'u', new Date('2026-09-24T01:00:00.000Z'));
  assert.deepEqual(next, []);
  told.clear();
  const late = await claimUntold(repo, 't', 'u', new Date('2026-09-24T01:00:00.000Z'));
  assert.deepEqual(late, [], '翌日には伝えない');
});

test('動いている段の、いま呼んでいるツールの言葉と、その動きを始めた時刻を返す（経過した時間を数える。第10.11.6節）', async () => {
  const { currentActivity } = await import('../src/secretary/lookups.js');
  const started = '2026-10-01T03:00:00.000Z';
  // ツールを呼んでいる間は、ツールの言葉と、呼び始めた時刻
  assert.deepEqual(currentActivity([
    { status: 'succeeded', input: {}, startedAt: '2026-10-01T02:59:00.000Z' },
    { status: 'running', input: { activity: 'evidencemd に問い合わせています', activityAt: '2026-10-01T03:00:05.000Z' }, startedAt: started },
  ]), { activity: 'evidencemd に問い合わせています', since: '2026-10-01T03:00:05.000Z' });
  // ツールを呼んでいない間（推論が考えている）は、言葉は無く、段を始めた時刻
  assert.deepEqual(currentActivity([{ status: 'running', input: {}, startedAt: new Date(started) }]), { activity: null, since: started });
  // 動いている段が無ければ null
  assert.equal(currentActivity([{ status: 'succeeded', input: {}, startedAt: started }]), null);
});
