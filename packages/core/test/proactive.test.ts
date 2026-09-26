/**
 * @file 秘書の先回りの単体テスト（仕様書 第10.12節、ADR-0036）。
 *
 * 会議の直前の準備・前日の移動の知らせを、要るときだけ一度起こすこと、見本の会社と「控えめ」の人には行わないこと、
 * 「あとで〇〇する」を本人の ToDo に入れることを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS } from '@m2office/shared';
import {
  OFFICIAL_AGENTS, ProactiveWatcher, Secretary, hasPlace, isMeetingSoon, type CalendarEvent, type LlmProvider, type Repository,
} from '../src/index.js';

const at = (iso: string) => new Date(iso);
const ev = (o: Partial<CalendarEvent> & { start: string }): CalendarEvent => ({
  id: o.id ?? 'e1', title: o.title ?? '営業定例', start: o.start, end: o.end ?? o.start,
  attendees: o.attendees ?? ['me@x.jp', 'yamada@x.jp'], location: o.location ?? null, ...(o.allDay ? { allDay: true } : {}),
});

function world(o: { source?: 'google' | 'mock'; proactivity?: 'low' | 'normal'; events: CalendarEvent[] }) {
  const jobs: { agentId: string; input: Record<string, unknown>; origin: string }[] = [];
  const repo = {
    listTenantIds: async () => ['t'],
    getTenantSettings: async () => ({ agents: { disabled: [] } }),
    listGoogleConnections: async () => [{ userId: 'u' }],
    listUsers: async () => [{ id: 'u', email: 'me@x.jp', status: 'active' }],
    getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS, secretary: { ...DEFAULT_USER_SETTINGS.secretary, proactivity: o.proactivity ?? 'normal' } }),
    listRunsWithJobs: async () => jobs.map((job) => ({ job, run: {} })),
    createJob: async (j: { agentId: string; input: Record<string, unknown>; origin: string }) => { jobs.push(j); },
    createRun: async () => undefined,
    appendAudit: async () => undefined,
  } as unknown as Repository;
  const connector = {
    sourceFor: () => o.source ?? 'google',
    calendar: { list: async () => o.events },
  } as never;
  const w = new ProactiveWatcher({ repo, connector, agentsFor: async () => OFFICIAL_AGENTS });
  return { w, jobs };
}

test('ほかの人のいる会議の 20〜60 分前に、会議の準備を一度だけ起こす', async () => {
  const now = at('2026-09-28T01:00:00Z'); // 10:00（日本時間）
  const { w, jobs } = world({ events: [ev({ start: '2026-09-28T01:30:00Z' })] });
  await w.tick(now);
  assert.deepEqual(jobs.map((j) => [j.agentId, j.input['meeting'], j.input['trigger'], j.origin]), [['meeting-prep', '営業定例（2026-09-28 10:30）', '先回り', 'secretary']]);
  await w.tick(new Date(now.getTime() + 10 * 60_000));
  assert.equal(jobs.length, 1, '同じ会議は二度起こさない');
});

test('ひとりの予定・終日の予定・まだ先の会議には起こさない', () => {
  const now = at('2026-09-28T01:00:00Z');
  assert.equal(isMeetingSoon(ev({ start: '2026-09-28T01:30:00Z', attendees: ['me@x.jp'] }), 'me@x.jp', now), false);
  assert.equal(isMeetingSoon(ev({ start: '2026-09-28T01:30:00Z', allDay: true }), 'me@x.jp', now), false);
  assert.equal(isMeetingSoon(ev({ start: '2026-09-28T02:30:00Z' }), 'me@x.jp', now), false, '90 分後はまだ');
  assert.equal(isMeetingSoon(ev({ start: '2026-09-28T01:10:00Z' }), 'me@x.jp', now), false, '10 分後は近すぎる');
});

test('17 時以降に、翌日の場所のある予定の出発時刻と行き方を一度だけ調べる。題名は渡さない', async () => {
  const now = at('2026-09-28T09:00:00Z'); // 18:00（日本時間）
  const { w, jobs } = world({
    events: [
      ev({ id: 'a', title: '極秘の商談', start: '2026-09-29T01:00:00Z', location: '大阪市中央区道頓堀 1-1' }),
      ev({ id: 'b', title: 'オンライン定例', start: '2026-09-29T05:00:00Z', location: 'https://meet.google.com/abc' }),
    ],
  });
  await w.tick(now);
  const travel = jobs.find((j) => j.agentId === 'secretary-lookup')!;
  assert.match(String(travel.input['request']), /^【明日の移動】9\/29（火）の次の予定に間に合う出発時刻と行き方/);
  assert.match(String(travel.input['request']), /- 10:00〜 大阪市中央区道頓堀 1-1/);
  assert.doesNotMatch(String(travel.input['request']), /極秘の商談|meet\.google/, '題名とオンライン会議は入れない');
  await w.tick(new Date(now.getTime() + 10 * 60_000));
  assert.equal(jobs.filter((j) => j.agentId === 'secretary-lookup').length, 1, '同じ日の移動は一度だけ');
  assert.equal(hasPlace(ev({ start: 'x', location: 'Zoom https://zoom.us/j/1' })), false);
});

test('17 時より前は移動の知らせを起こさない。見本の会社と「控えめ」の人には何もしない', async () => {
  const tomorrow = ev({ start: '2026-09-29T01:00:00Z', location: '大阪' });
  const early = world({ events: [tomorrow] });
  await early.w.tick(at('2026-09-28T06:00:00Z')); // 15:00
  assert.equal(early.jobs.length, 0);
  const soon = ev({ start: '2026-09-28T01:30:00Z' });
  for (const o of [{ source: 'mock' as const }, { proactivity: 'low' as const }]) {
    const x = world({ ...o, events: [soon, tomorrow] });
    await x.w.tick(at('2026-09-28T01:00:00Z'));
    await x.w.tick(at('2026-09-28T09:00:00Z'));
    assert.equal(x.jobs.length, 0, JSON.stringify(o));
  }
});

function secretary(todoAnswer: string, proactivity: 'low' | 'normal' = 'normal') {
  const tasks: { title: string; due: string | null }[] = [];
  const repo = {
    getTenantSettings: async () => ({ agents: { disabled: [] }, access: { scopes: {} }, company: { legalName: '', shortName: '' } }),
    getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS, secretary: { ...DEFAULT_USER_SETTINGS.secretary, proactivity }, memory: { ...DEFAULT_USER_SETTINGS.memory, keepConversations: false } }),
    findUserById: async () => ({ id: 'u', displayName: '三浦' }),
    listMemories: async () => [], listUserCompartments: async () => [], listConversationsOfDay: async () => [],
    searchKnowledge: async () => ({ hits: [], rewrites: [] }), appendAudit: async () => undefined,
  } as unknown as Repository;
  const llm = {
    name: 'fake',
    complete: async (req: { messages: { content: string }[] }) => {
      const sys = req.messages[0]?.content ?? '';
      if (sys.startsWith('本人の発言から、本人自身がこれからする用事')) return { text: todoAnswer, tokensUsed: 1 };
      if (sys.startsWith('依頼に最も合う業務')) return { text: 'none', tokensUsed: 1 };
      return { text: 'わかりました', tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const connector = { tasks: { create: async (_p: unknown, t: { title: string; due: string | null }) => { tasks.push(t); return { taskId: 'x' }; } } } as never;
  return { s: new Secretary({ repo, llm, connector, agents: [] }), tasks };
}

test('「あとで〇〇する」は本人の ToDo に入れ、答えに一言添える', async () => {
  const { s, tasks } = secretary('{"todo":"山田さんに見積もりを送る","due":"2026-09-29"}');
  const reply = await s.respond('t', 'u', 'あとで山田さんに見積もりを送らないと');
  assert.deepEqual(tasks, [{ title: '山田さんに見積もりを送る', due: '2026-09-29' }]);
  assert.match(reply.text, /（ToDo に「山田さんに見積もりを送る」を入れました。期限は 9\/29）$/);
});

test('秘書への依頼・本人の用事でないもの・「控えめ」の人は ToDo に入れない', async () => {
  const asked = secretary('{"todo":"見積もりを送る","due":null}');
  await asked.s.respond('t', 'u', 'あとで見積もりを送っておいてください');
  assert.equal(asked.tasks.length, 0, '秘書への依頼は ToDo ではない');
  const none = secretary('{"todo":null}');
  await none.s.respond('t', 'u', '山田さんは明日までに見積もりを出すそうです');
  assert.equal(none.tasks.length, 0, '推論が本人の用事でないと判断したら入れない');
  const low = secretary('{"todo":"資料を作る","due":null}', 'low');
  await low.s.respond('t', 'u', '明日までに資料を作らないと');
  assert.equal(low.tasks.length, 0);
});
