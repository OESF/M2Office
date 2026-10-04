/**
 * @file Google の許可がなくなったときの後始末（業務を止める、承認を外す、知らせる）と、定時実行を飛ばす規則の単体テスト。
 *
 * @see 仕様書 第6.5.2.1節 許可がなくなったときの業務の扱い（Q-54）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, Approval, Job, Notification, Run, RunStep, Schedule } from '@m2office/shared';
import { DEFAULT_TENANT_SETTINGS } from '@m2office/shared';
import {
  BUILTIN_TOOLS, GoogleRevocation, SCHEDULE_SKIP_TITLE, Scheduler, ToolRegistry, agentUsesGoogle, silentLogger,
  type Repository,
} from '../src/index.js';

const at = '2026-09-23T00:00:00.000Z';
const run = (id: string, status: Run['status']): Run =>
  ({ id, jobId: `j-${id}`, tenantId: 't', status, cursor: 0, startedAt: at, endedAt: null, tokensUsed: 0, costJpy: 0, failureReason: null } as Run);
const job = (id: string, agentId: string, requestedBy = 'u-member'): Job =>
  ({ id: `j-${id}`, tenantId: 't', agentId, agentVersion: 1, requestedBy, origin: 'menu', input: {}, createdAt: at });

function fake() {
  const state = {
    live: [
      { run: run('r-inbox', 'running'), job: job('r-inbox', 'inbox-triage') },
      { run: run('r-minutes', 'awaiting_approval'), job: job('r-minutes', 'minutes') },
      { run: run('r-kb', 'queued'), job: job('r-kb', 'knowledge-qa') },
      { run: run('r-other', 'running'), job: job('r-other', 'inbox-triage', 'u-other') },
    ],
    approvals: [{ id: 'a1', runStepId: 's-min', tenantId: 't', approverRole: ['approver'], approverUserId: null, present: '', decision: null, decidedBy: null, comment: null, decidedAt: null, createdAt: at }] as Approval[],
    steps: {
      'r-minutes': [{ id: 's-min', runId: 'r-minutes', output: { tools: [{ name: 'document.create', result: { url: 'https://docs.google.com/document/d/abc/edit' } }] } }],
    } as Record<string, Partial<RunStep>[]>,
    notifications: [] as Notification[],
  };
  const repo = {
    listLiveRuns: async () => state.live,
    getRun: async (_t: string, id: string) => state.live.find((l) => l.run.id === id)?.run ?? null,
    updateRun: async (r: Run) => { state.live = state.live.map((l) => (l.run.id === r.id ? { ...l, run: r } : l)); },
    listRunApprovals: async (_t: string, runId: string) => (runId === 'r-minutes' ? state.approvals : []),
    updateApproval: async (a: Approval) => { state.approvals = state.approvals.map((x) => (x.id === a.id ? a : x)); },
    listRunSteps: async (_t: string, runId: string) => state.steps[runId] ?? [],
    listUsers: async () => [
      { id: 'u-member', roles: ['member'], status: 'active' },
      { id: 'u-approver', roles: ['approver'], status: 'active' },
      { id: 'u-gone', roles: ['approver'], status: 'disabled' },
    ],
    listSchedules: async () => [
      { agentId: 'weekly-brief', agentVersion: 1, enabled: true },
      { agentId: 'knowledge-qa', agentVersion: 1, enabled: true },
      { agentId: 'inbox-triage', agentVersion: 1, enabled: false },
    ],
    appendAudit: async () => undefined,
    createNotification: async (n: Notification) => { state.notifications.push(n); },
  } as unknown as Repository;
  // 知識の Q&A だけが Google を使わない業務
  const usesGoogle = async (_t: string, agentId: string) => agentId !== 'knowledge-qa';
  return { repo, state, r: new GoogleRevocation({ repo, usesGoogle, logger: silentLogger }) };
}

test('取り消す前に、止まる業務（Google を使うもの）と飛ばす定時実行の数を示す', async () => {
  const { r } = fake();
  const impact = await r.impact('t', 'u-member');
  assert.deepEqual(impact.runs.map((x) => x.runId), ['r-inbox', 'r-minutes'], '本人の、Google を使う業務だけ');
  assert.equal(impact.schedules, 1, '有効で Google を使う定時実行だけ');
});

test('Google を使う動いている途中の業務を止め、承認を外し、依頼者と承認する人に知らせる', async () => {
  const { r, state } = fake();
  const stopped = await r.stopUserRuns('t', 'u-member', 'disconnect', new Date(at));
  assert.deepEqual(stopped, ['r-inbox', 'r-minutes']);
  const byId = Object.fromEntries(state.live.map((l) => [l.run.id, l.run]));
  assert.equal(byId['r-inbox']!.status, 'cancelled');
  assert.equal(byId['r-inbox']!.failureReason, 'Google との連携を解除したため止めました');
  assert.equal(byId['r-kb']!.status, 'queued', 'Google を使わない業務は止めない');
  assert.equal(byId['r-other']!.status, 'running', 'ほかの人の業務は止めない');
  assert.equal(state.approvals[0]!.decision, 'cancelled', '承認トレイから外す');
  const to = state.notifications.map((n) => n.userId);
  assert.deepEqual(to.sort(), ['u-approver', 'u-member', 'u-member'].sort(), '停止中の承認者には知らせない');
  assert.ok(state.notifications.some((n) => n.body.includes('https://docs.google.com/document/d/abc/edit')), '作りかけの文書のリンクを添える');
});

test('業務が Google を使うかは、定義のツールの権限の宣言で決める', () => {
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  assert.equal(agentUsesGoogle({ tools: ['gmail.list'] } as AgentDefinition, registry), true);
  assert.equal(agentUsesGoogle({ tools: ['knowledge.search'] } as AgentDefinition, registry), false);
});

test('Google と接続していない人の、Google を使う定時実行は飛ばし、未読の同じ知らせがなければ一度だけ知らせる', async () => {
  const def = { id: 'weekly-brief', name: '週次ブリーフ', compartment: null, tools: ['gmail.list'] } as unknown as AgentDefinition;
  const due: Schedule = {
    id: 'sc1', tenantId: 't', userId: 'u-member', agentId: 'weekly-brief', agentVersion: 1, input: {},
    rule: { kind: 'weekly', weekday: 1, time: '08:00' } as Schedule['rule'], timezone: 'Asia/Tokyo', enabled: true,
    nextRunAt: at, lastRunAt: null, createdBy: 'u-member', createdAt: at,
  };
  let claimed = 0;
  const notifications: Notification[] = [];
  const audits: { action: string; detail: unknown }[] = [];
  const repo = {
    claimDueSchedule: async () => (claimed++ % 2 === 0 ? due : null),
    findUserById: async () => ({ id: 'u-member', status: 'active' }),
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS,
    listUserGroupIds: async () => [],
    listUserCompartments: async () => [],
    appendAudit: async (e: { action: string; detail: unknown }) => { audits.push(e); },
    listNotifications: async () => notifications,
    createNotification: async (n: Notification) => { notifications.push(n); },
  } as unknown as Repository;
  const scheduler = new Scheduler({ repo, resolveDefinition: () => def, missingGoogleConnection: async () => true });
  assert.deepEqual(await scheduler.tick(new Date(at)), [], '起動しない');
  assert.deepEqual(await scheduler.tick(new Date(at)), []);
  assert.equal(audits.filter((a) => a.action === 'schedule.skip').length, 2, '飛ばしたことは毎回記録する');
  assert.equal(notifications.filter((n) => n.title === SCHEDULE_SKIP_TITLE).length, 1, '知らせは一度だけ');
});

test('Google の側で外されたら、接続を消し、業務を止め、中身を消し、本人に一度だけ知らせる（第6.5.2.1節 経路 2・3）', async () => {
  const { repo, state } = fake();
  let conn: string | null = 'enc-old';
  const audits: string[] = [];
  const purged: string[] = [];
  Object.assign(repo, {
    deleteGoogleConnectionIf: async (_t: string, _u: string, enc: string) => {
      if (conn !== enc) return false;
      conn = null;
      return true;
    },
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  });
  const r = new GoogleRevocation({
    repo, usesGoogle: async (_t, agentId) => agentId !== 'knowledge-qa', logger: silentLogger,
    purgeUser: async (_t, userId) => { purged.push(userId); return 2; },
  });
  assert.equal(await r.lostGrant('t', 'u-member', 'enc-old', new Date(at)), true);
  assert.equal(conn, null, '保存しているトークンを消す');
  const byId = Object.fromEntries(state.live.map((l) => [l.run.id, l.run]));
  assert.equal(byId['r-inbox']!.status, 'cancelled');
  assert.equal(byId['r-inbox']!.failureReason, 'Google の側で M2Office への許可が外されたため止めました');
  assert.equal(byId['r-kb']!.status, 'queued', 'Google を使わない業務は止めない');
  assert.deepEqual(purged, ['u-member'], '終わった実行から Google 由来の中身を消す');
  const lost = state.notifications.filter((n) => n.title === 'Google との接続が切れました');
  assert.equal(lost.length, 1);
  assert.equal(lost[0]!.userId, 'u-member');
  assert.match(lost[0]!.body, /接続し直してください/);
  assert.ok(audits.includes('connection.google.lost'));

  // 重ねて呼ばれても、後始末は 1 回だけ
  assert.equal(await r.lostGrant('t', 'u-member', 'enc-old', new Date(at)), false);
  assert.equal(state.notifications.filter((n) => n.title === 'Google との接続が切れました').length, 1);
});

test('取り直しのあとで接続し直していれば、新しい接続は消さず、何もしない', async () => {
  const { repo, state } = fake();
  Object.assign(repo, { deleteGoogleConnectionIf: async (_t: string, _u: string, enc: string) => enc === 'enc-new' });
  const r = new GoogleRevocation({ repo, usesGoogle: async () => true, logger: silentLogger });
  assert.equal(await r.lostGrant('t', 'u-member', 'enc-old', new Date(at)), false);
  assert.equal(state.notifications.length, 0);
  assert.ok(state.live.every((l) => l.run.status !== 'cancelled'), '業務は止めない');
});
