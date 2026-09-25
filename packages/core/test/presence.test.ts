/**
 * @file ダッシュボードの人の状態の単体テスト。
 *
 * 状態の決め方（強い順）、中身を持たないこと、粒度の見せ方を確かめる。
 *
 * @see 仕様書 第6.7.4.1節・第6.7.4.4節、ADR-0013
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Approval, Job, Run, RunStep, User } from '@m2office/shared';
import {
  ACTIVE_WINDOW_MIN, PRESENCE_LABELS, VOICE_WINDOW_MIN, activityOf, buildPresence, deviceOf, summarizePresence, voiceOpen,
} from '../src/index.js';

const NOW = new Date('2026-09-23T02:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const users: User[] = [
  { id: 'u-admin', tenantId: 't', email: 'a@x', displayName: '管理者', roles: ['admin', 'approver'], status: 'active' },
  { id: 'u-member', tenantId: 't', email: 'm@x', displayName: '一般', roles: ['member'], status: 'active' },
  { id: 'u-gone', tenantId: 't', email: 'g@x', displayName: '停止', roles: ['member'], status: 'disabled' },
];

const run = (id: string, status: Run['status']): Run => ({
  id, jobId: `j-${id}`, tenantId: 't', status, cursor: 1, startedAt: ago(3), endedAt: null,
  tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null,
});
const job = (runId: string, requestedBy: string): Job => ({
  id: `j-${runId}`, tenantId: 't', agentId: 'minutes', agentVersion: 1, requestedBy,
  origin: 'menu', input: {}, createdAt: ago(3),
});
const step = (input: unknown): RunStep => ({
  id: 's1', runId: 'r1', seq: 0, stepId: 'draft', kind: 'agent', status: 'running',
  input: input as RunStep['input'], output: null, startedAt: ago(1), endedAt: null,
});
const approval = (approverRole: string[], approverUserId: string | null): Approval => ({
  id: 'a1', runStepId: 's1', tenantId: 't', approverRole, approverUserId, present: '内容',
  decision: null, decidedBy: null, comment: null, decidedAt: null, createdAt: ago(5),
});

function build(over: Partial<Parameters<typeof buildPresence>[0]> = {}) {
  return buildPresence({
    now: NOW, users, sessions: [], liveRuns: [], stepsByRun: new Map(), pending: [],
    secretaryEvents: [], agentName: () => '議事録作成・共有', ...over,
  });
}

test('ログイン状態から、オンラインと端末の種類を決める', () => {
  const people = build({
    sessions: [
      { userId: 'u-admin', lastSeenAt: ago(1), userAgent: 'Mozilla/5.0 (Macintosh)' },
      { userId: 'u-member', lastSeenAt: ago(ACTIVE_WINDOW_MIN + 1), userAgent: 'Mozilla/5.0 (iPhone)' },
    ],
  });
  assert.deepEqual(people.map((p) => p.state), ['idle', 'offline']);
  assert.deepEqual(people.map((p) => p.device), ['パソコン', null]);
  assert.equal(people[0]!.route, '画面');
  assert.equal(people[1]!.route, null, 'オフラインでは経路を出さない');
  assert.equal(people.length, 2, '停止した利用者は出さない');
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS)'), 'スマートフォン');
  assert.equal(deviceOf(null), null);
});

test('強い順に決める: 承認の依頼 → 活動中 → 実行中 → 秘書と会話中 → 待機', () => {
  const sessions = [
    { userId: 'u-admin', lastSeenAt: ago(1), userAgent: null },
    { userId: 'u-member', lastSeenAt: ago(1), userAgent: null },
  ];
  // 管理者は承認の依頼あり、一般は自分の業務が活動中
  const people = build({
    sessions,
    pending: [approval(['approver'], null)],
    liveRuns: [{ run: run('r1', 'running'), job: job('r1', 'u-member') }],
    stepsByRun: new Map([['r1', [step({ activity: 'リサーチ中' })]]]),
  });
  assert.deepEqual(people.map((p) => p.state), ['approval', 'activity']);
  assert.equal(people[0]!.detail, '承認の依頼 1 件');
  assert.equal(people[1]!.detail, 'リサーチ中');
  assert.equal(people[1]!.agentName, '議事録作成・共有');

  // 活動の表示名が無ければ「業務を実行中」
  const running = build({
    sessions,
    liveRuns: [{ run: run('r1', 'running'), job: job('r1', 'u-member') }],
    stepsByRun: new Map([['r1', [step({ instruction: '作成する' })]]]),
  });
  assert.equal(running[1]!.state, 'running');
  assert.equal(running[1]!.detail, '議事録作成・共有を実行中');

  // 業務が無く、直近に秘書へ依頼していれば「秘書と会話中」
  const talking = build({ sessions, secretaryEvents: [{ actorId: 'u-member', occurredAt: ago(1) }] });
  assert.equal(talking[1]!.state, 'talking');
  assert.equal(talking[1]!.detail, PRESENCE_LABELS.talking);

  // 3 分前の依頼は「会話中」にしない
  const idle = build({ sessions, secretaryEvents: [{ actorId: 'u-member', occurredAt: ago(3) }] });
  assert.equal(idle[1]!.state, 'idle');
});

test('承認の依頼は、判断できる人にだけ出す', () => {
  const people = build({
    sessions: [{ userId: 'u-member', lastSeenAt: ago(1), userAgent: null }],
    // 依頼した本人が判断する承認（approver: requester）
    pending: [approval([], 'u-member')],
  });
  assert.equal(people.find((p) => p.userId === 'u-member')!.state, 'approval');
  assert.equal(people.find((p) => p.userId === 'u-admin')!.state, 'offline', 'ほかの人には出さない');
});

test('人の状態に中身を持たせない', () => {
  const people = build({
    sessions: [{ userId: 'u-member', lastSeenAt: ago(1), userAgent: null }],
    liveRuns: [{ run: run('r1', 'running'), job: job('r1', 'u-member') }],
    stepsByRun: new Map([['r1', [step({ instruction: '秘密の指示', activity: 'メールを確認中' })]]]),
  });
  const json = JSON.stringify(people);
  assert.equal(json.includes('秘密の指示'), false, 'ステップの入力を含めない');
  assert.equal(json.includes('メールを確認中'), true, '活動の表示名だけを出す');
  assert.equal(activityOf([step({})]), null);
});

test('粒度が「人数と業務だけ」なら、誰かを示さない', () => {
  const people = build({
    sessions: [{ userId: 'u-member', lastSeenAt: ago(1), userAgent: null }],
    liveRuns: [{ run: run('r1', 'running'), job: job('r1', 'u-member') }],
    stepsByRun: new Map([['r1', [step({})]]]),
  });
  const summary = summarizePresence(people);
  assert.equal(JSON.stringify(summary).includes('一般'), false, '名前を含めない');
  assert.deepEqual(summary.agents, ['議事録作成・共有']);
  assert.equal(summary.counts.find((x) => x.state === 'running')?.n, 1);
  assert.equal(summary.counts.length, 7, '人数 0 の状態も落とさない');
});

test('本人がオフラインでも、秘書は定時実行の業務を進めていると示す（本人と秘書の 1 組）', () => {
  const people = build({
    liveRuns: [
      { run: run('r1', 'running'), job: { ...job('r1', 'u-member'), origin: 'schedule' } },
      { run: run('r2', 'queued'), job: job('r2', 'u-member') },
    ],
    stepsByRun: new Map([['r1', [step({})]]]),
  });
  const member = people.find((p) => p.userId === 'u-member')!;
  assert.deepEqual(member.self, { state: 'offline', detail: 'オフライン' });
  assert.deepEqual(member.secretary, { state: 'running', detail: '議事録作成・共有を実行中（ほか 1 件）', busy: true });
  const admin = people.find((p) => p.userId === 'u-admin')!;
  assert.deepEqual(admin.secretary, { state: 'idle', detail: '待機', busy: false }, '何も無ければ秘書は待機');
});

test('秘書の状態は強い順に決める: 活動中 → 実行中 → 承認待ち → 順番待ち → 音声 → 応対中', () => {
  const sessions = [{ userId: 'u-member', lastSeenAt: ago(1), userAgent: null }];
  const secretaryOfMember = (over: Partial<Parameters<typeof buildPresence>[0]>) =>
    build({ sessions, ...over }).find((p) => p.userId === 'u-member')!.secretary;

  assert.equal(secretaryOfMember({
    liveRuns: [{ run: run('r1', 'running'), job: job('r1', 'u-member') }],
    stepsByRun: new Map([['r1', [step({ activity: 'メールを確認中' })]]]),
  }).detail, 'メールを確認中');
  assert.deepEqual(secretaryOfMember({ liveRuns: [{ run: run('r1', 'awaiting_approval'), job: job('r1', 'u-member') }] }),
    { state: 'awaiting', detail: '議事録作成・共有の承認を待っています', busy: true });
  assert.deepEqual(secretaryOfMember({ liveRuns: [{ run: run('r1', 'queued'), job: job('r1', 'u-member') }] }),
    { state: 'queued', detail: '議事録作成・共有の順番待ち', busy: true });
  assert.deepEqual(secretaryOfMember({ secretaryEvents: [{ actorId: 'u-member', occurredAt: ago(1) }] }),
    { state: 'talking', detail: '応対中', busy: true });
});

test('承認の依頼は本人の状態に、業務の進み具合は秘書の状態に出す', () => {
  const people = build({
    sessions: [{ userId: 'u-member', lastSeenAt: ago(1), userAgent: null }],
    pending: [approval([], 'u-member')],
    liveRuns: [{ run: run('r1', 'awaiting_approval'), job: job('r1', 'u-member') }],
  });
  const member = people.find((p) => p.userId === 'u-member')!;
  assert.equal(member.state, 'approval', '1 組全体の状態は強い順のまま');
  assert.equal(member.self.detail, '承認の依頼 1 件');
  assert.equal(member.secretary.state, 'awaiting');
});

test('音声の対話は、始まりがあり終わりが無いあいだだけ「音声で会話中」とする', () => {
  const since = NOW.getTime() - VOICE_WINDOW_MIN * 60_000;
  const start = (min: number) => ({ actorId: 'u-member', occurredAt: ago(min), targetId: 'start' });
  const end = (min: number) => ({ actorId: 'u-member', occurredAt: ago(min), targetId: 'end' });
  assert.equal(voiceOpen([start(5)], 'u-member', since), true);
  assert.equal(voiceOpen([start(5), end(1)], 'u-member', since), false, '終わっていれば会話中にしない');
  assert.equal(voiceOpen([start(20), end(10), start(2)], 'u-member', since), true, '次の対話が開いている');
  assert.equal(voiceOpen([start(VOICE_WINDOW_MIN + 1)], 'u-member', since), false, '古い始まりは数えない（異常終了に備える）');
  assert.equal(voiceOpen([start(5)], 'u-admin', since), false, 'ほかの人の対話を数えない');

  const people = build({ voiceEvents: [start(3)] });
  const member = people.find((p) => p.userId === 'u-member')!;
  assert.equal(member.state, 'voice');
  assert.equal(member.route, '音声');
  assert.deepEqual(member.self, { state: 'voice', detail: '音声で会話中' });
  assert.deepEqual(member.secretary, { state: 'voice', detail: '音声で応対中', busy: true });
});
