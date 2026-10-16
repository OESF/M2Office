/**
 * @file 社外の参加者を含む日程調整（仕様書 第9.5.3.1節、Q-52、ADR-0103）の単体テスト。
 *
 * 社内と社外の見分け、候補のメールと仮押さえ、返事の読み分け（推論なしの読み方）、返事の見張り（選ばれた → 招待の業務を始める・
 * どれも合わない → 本人に知らせる・送る前の返事は見ない・7 日たったら仮押さえを消す）、招待で仮押さえを消すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, AuditEvent, Job, Notification } from '@m2office/shared';
import {
  BUILTIN_TOOLS, MockWorkspaceConnector, OFFICIAL_AGENTS, ScheduleReplyWatcher, guessScheduleReply, splitAttendees,
  type Repository, type ScheduleRequest, type ToolContext,
} from '../src/index.js';

const tool = (name: string) => BUILTIN_TOOLS.find((t) => t.name === name)!;
const future = (days: number, hour = 5) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
const cands = [2, 3, 4].map((d) => ({ start: future(d), end: future(d, 6) }));

function world() {
  const requests = new Map<string, ScheduleRequest>();
  const notes: Notification[] = [];
  const jobs: Job[] = [];
  const audits: AuditEvent[] = [];
  const repo = {
    listTenantIds: async () => ['t1'],
    findTenantById: async () => ({ id: 't1', workspaceDomain: 'alpha.example.jp' }),
    createScheduleRequest: async (r: ScheduleRequest) => { requests.set(r.id, r); },
    getScheduleRequest: async (_t: string, id: string) => requests.get(id) ?? null,
    listWaitingScheduleRequests: async () => [...requests.values()].filter((r) => r.status === 'waiting'),
    updateScheduleRequest: async (_t: string, id: string, patch: Partial<ScheduleRequest>) => { requests.set(id, { ...requests.get(id)!, ...patch }); },
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: AuditEvent) => { audits.push(e); },
    createJob: async (j: Job) => { jobs.push(j); },
    createRun: async () => undefined,
  } as unknown as Repository;
  const connector = new MockWorkspaceConnector();
  const ctx = { tenantId: 't1', userId: 'u1', runId: 'r1', compartment: null, repo, connector } as unknown as ToolContext;
  const confirm = OFFICIAL_AGENTS.find((a) => a.id === 'scheduling-confirm') as AgentDefinition;
  const watcher = new ScheduleReplyWatcher({ repo, connector, llmFor: async () => null, agentFor: async () => confirm });
  return { repo, connector, ctx, requests, notes, jobs, audits, watcher };
}

test('会社の Workspace のドメインで社内と社外を分ける', async () => {
  const { ctx } = world();
  assert.deepEqual(await splitAttendees(ctx, ['me@alpha.example.jp', 'tanaka@customer.example.jp']), { internal: ['me@alpha.example.jp'], external: ['tanaka@customer.example.jp'] });
});

test('返事の読み分け（推論なし）: 「1 つ目」・日付・どれも合わない', () => {
  const c = cands.map((x) => ({ ...x, holdEventId: null }));
  assert.equal(guessScheduleReply(c, '1 つ目の日時でお願いいたします。').choice, 0);
  assert.equal(guessScheduleReply(c, '第2候補でお願いします').choice, 1);
  const d = new Date(Date.parse(c[2]!.start) + 9 * 3_600_000);
  assert.equal(guessScheduleReply(c, `${d.getUTCMonth() + 1}/${d.getUTCDate()} で大丈夫です`).choice, 2);
  const no = guessScheduleReply(c, 'あいにくどれも都合がつきません。再来週はいかがでしょうか。');
  assert.equal(no.choice, null);
  assert.match(no.note ?? '', /再来週/);
});

test('社外の人に候補を送ると、仮押さえを入れ、返事を待つ記録を作る。社内の人だけなら使わない', async () => {
  const { ctx, requests, connector } = world();
  const prepared = await tool('schedule.send_candidates').prepare!({ title: '打ち合わせ', attendees: ['me@alpha.example.jp'], candidates: cands, subject: 's', body: 'b' }, ctx);
  assert.equal(prepared.kind, 'problem', '社外の人がいなければ使わない');
  const ready = await tool('schedule.send_candidates').prepare!({ title: '打ち合わせ', attendees: ['me@alpha.example.jp', 'tanaka@customer.example.jp'], candidates: cands, subject: 's', body: 'b' }, ctx);
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.kind === 'ready' && ready.audience, 'external', '承認を自動で通さない');
  const r = await tool('schedule.send_candidates').invoke({ title: '打ち合わせ', attendees: ['me@alpha.example.jp', 'tanaka@customer.example.jp'], candidates: cands, subject: '日程のご相談', body: '候補です' }, ctx) as Record<string, unknown>;
  assert.equal(r['sent'], true);
  assert.equal(r['holds'], 3);
  const req = requests.get(String(r['requestId']))!;
  assert.deepEqual(req.externalAttendees, ['tanaka@customer.example.jp']);
  assert.deepEqual(req.internalAttendees, ['me@alpha.example.jp']);
  assert.ok(req.threadId);
  const mail = connector.outbox.find((o) => o.kind === 'mail')?.body as { to: string[] };
  assert.deepEqual(mail.to, ['tanaka@customer.example.jp'], '候補のメールは社外の人だけに送る');
});

test('返事で候補が選ばれたら、招待の業務を始める。招待で予定を作り、仮押さえを消す', async () => {
  const { ctx, requests, jobs, watcher, connector } = world();
  const r = await tool('schedule.send_candidates').invoke({ title: '打ち合わせ', attendees: ['me@alpha.example.jp', 'tanaka@customer.example.jp'], candidates: cands, subject: 's', body: 'b' }, ctx) as Record<string, unknown>;
  const out = await watcher.tick(new Date(Date.now() + 5 * 60_000));
  assert.equal(out.chosen, 1);
  const req = requests.get(String(r['requestId']))!;
  assert.equal(req.status, 'chosen');
  assert.equal(req.chosenIndex, 0, '見本の返事は 1 つ目を選ぶ');
  assert.equal(jobs[0]?.agentId, 'scheduling-confirm');
  assert.deepEqual(jobs[0]?.input['requestId'], req.id);
  const prepared = await tool('schedule.invite').prepare!({ requestId: req.id }, ctx);
  assert.equal(prepared.kind === 'ready' && prepared.audience, 'external');
  const inv = await tool('schedule.invite').invoke({ requestId: req.id }, ctx) as Record<string, unknown>;
  assert.equal(inv['invited'], true);
  assert.equal(requests.get(req.id)?.status, 'done');
  assert.equal(connector.outbox.filter((o) => o.kind === 'event.cancel').length, 3, '仮押さえは 3 つとも消す');
});

test('どれも合わない返事なら本人に知らせる。7 日たったら仮押さえを消して知らせる', async () => {
  const w = world();
  await tool('schedule.send_candidates').invoke({ title: '打ち合わせ', attendees: ['me@alpha.example.jp', 'decline@customer.example.jp'], candidates: cands, subject: 's', body: 'b' }, w.ctx);
  const out = await w.watcher.tick(new Date(Date.now() + 5 * 60_000));
  assert.equal(out.other, 1);
  assert.match(w.notes[0]?.body ?? '', /再来週/);
  assert.equal(w.jobs.length, 0, '選ばれていなければ招待しない');

  const x = world();
  await tool('schedule.send_candidates').invoke({ title: '打ち合わせ', attendees: ['me@alpha.example.jp', 'noreply@customer.example.jp'], candidates: cands, subject: 's', body: 'b' }, x.ctx);
  assert.equal((await x.watcher.tick(new Date(Date.now() + 5 * 60_000))).chosen, 0, '返事が無ければ待つ');
  const later = await x.watcher.tick(new Date(Date.now() + 8 * 86_400_000));
  assert.equal(later.expired, 1);
  assert.equal(x.connector.outbox.filter((o) => o.kind === 'event.cancel').length, 3);
  assert.match(x.notes[0]?.title ?? '', /返事がありませんでした/);
});
