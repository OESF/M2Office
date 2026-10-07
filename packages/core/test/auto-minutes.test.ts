/**
 * @file 会議が終わったら議事録を作り始める見回りの単体テスト（仕様書 第9.5.2.1節、ADR-0081）。
 * 本人が主催し・文字起こしがあり・10 分以上の会議だけ始める、同じ会議は 2 度始めない、共有先は同じ題名の前の共有先、
 * 本人が止めた（全部・題名ごと）会議は始めない、AI の利用の上限なら始めない、会話の言い方の見分けを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, type AgentDefinition, type Job, type UserSettings } from '@m2office/shared';
import {
  AiLimitError, AutoMinutes, autoMinutesRequest, meetingTitleKey, setEnqueueAiGuard,
  type EndedMeeting, type Repository, type WorkspaceConnector,
} from '../src/index.js';

const NOW = new Date('2026-10-07T06:00:00Z');
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const def = { id: 'minutes', version: 1, name: '議事録の作成・共有' } as unknown as AgentDefinition;

function setup(meetings: EndedMeeting[], secretary: Partial<UserSettings['secretary']> = {}, pastJobs: Partial<Job>[] = []) {
  const jobs: Job[] = pastJobs.map((j, i) => ({ id: `j${i}`, tenantId: 't1', agentId: 'minutes', agentVersion: 1, requestedBy: 'u1', origin: 'menu', input: {}, createdAt: at(10_000), ...j }) as Job);
  const audits: string[] = [];
  const repo = {
    listTenantIds: async () => ['t1'],
    listUsers: async () => [{ id: 'u1', status: 'active' }],
    getUserSettings: async () => ({ ...structuredClone(DEFAULT_USER_SETTINGS), secretary: { ...DEFAULT_USER_SETTINGS.secretary, ...secretary } }),
    listRunsWithJobs: async () => jobs.map((job) => ({ run: { id: `r-${job.id}` }, job })),
    createJob: async (j: Job) => { jobs.push(j); },
    createRun: async () => undefined,
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Repository;
  const connector = { meet: { transcript: async () => null, ended: async () => meetings } } as unknown as WorkspaceConnector;
  const auto = new AutoMinutes({ repo, connector, agentFor: async () => def });
  return { auto, jobs, audits };
}

const meeting = (over: Partial<EndedMeeting> = {}): EndedMeeting => ({
  id: 'c1', title: '営業定例', startedAt: at(90), endedAt: at(30), organizerSelf: true, hasTranscript: true, ...over,
});

test('始める: 主催し・文字起こしがあり・10 分以上の会議だけ。同じ会議は 2 度始めない', async () => {
  const s = setup([
    meeting(),
    meeting({ id: 'c2', title: '参加しただけ', organizerSelf: false }),
    meeting({ id: 'c3', title: '文字起こし無し', hasTranscript: false }),
    meeting({ id: 'c4', title: '短い', startedAt: at(35), endedAt: at(30) }),
  ]);
  assert.equal(await s.auto.tick(NOW), 1);
  const started = s.jobs.filter((j) => j.requestedBy === 'u1' && j.input['title']);
  assert.deepEqual(started.map((j) => j.input), [{ title: '営業定例（10/7）' }]);
  assert.ok(s.audits.includes('minutes.auto_start'));
  assert.equal(await s.auto.tick(NOW), 0, '同じ会議は始めない');
});

test('共有先: 同じ題名の会議で前に共有したスペースを使う', async () => {
  const s = setup([meeting()], {}, [{ input: { title: '営業定例（9/30）', space: '営業部' } }]);
  assert.equal(await s.auto.tick(NOW), 1);
  assert.deepEqual(s.jobs[s.jobs.length - 1]!.input, { title: '営業定例（10/7）', space: '営業部' });
  assert.equal(meetingTitleKey('営業定例（9/30）'), meetingTitleKey('営業定例'));
});

test('止める: 全部止めた人・止めた題名の会議は始めない。AI の利用の上限なら始めない', async () => {
  assert.equal(await setup([meeting()], { autoMinutes: false }).auto.tick(NOW), 0);
  assert.equal(await setup([meeting()], { noMinutes: ['定例'] }).auto.tick(NOW), 0);
  setEnqueueAiGuard(async () => { throw new AiLimitError('上限', 'company'); });
  try {
    assert.equal(await setup([meeting()]).auto.tick(NOW), 0);
  } finally {
    setEnqueueAiGuard(null);
  }
});

test('会話: 全部止める・戻す・題名ごとに止めるを見分ける', () => {
  assert.deepEqual(autoMinutesRequest('会議の後に議事録を作らないで'), { kind: 'off' });
  assert.deepEqual(autoMinutesRequest('会議のあとに議事録を作って'), { kind: 'on' });
  assert.deepEqual(autoMinutesRequest('朝会の会議は議事録を作らないで'), { kind: 'skip', title: '朝会' });
  assert.equal(autoMinutesRequest('営業定例の議事録を作って'), null);
});
