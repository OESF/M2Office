/**
 * @file 定時実行の操作の単体テスト（仕様書 第6.1.7節・第10.9.8節）。
 *
 * 画面と秘書で共通の決まり（登録できる業務・必須の入力・再開と今すぐ実行）と、
 * 秘書が本人の定時実行を確かめ・止め・再開し・今すぐ実行することを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDefinition, AuditEvent, Schedule } from '@m2office/shared';
import {
  LOOKUP_AGENT_ID, OFFICIAL_AGENTS, answerSchedule, isSchedulable, missingInputs, triggeredNow, withEnabled,
  type Repository,
} from '../src/index.js';

const NOW = new Date('2026-09-26T03:00:00Z'); // 土曜 12:00（日本時間）

function schedule(id: string, agentId: string, over: Partial<Schedule> = {}): Schedule {
  return {
    id, tenantId: 't1', userId: 'u1', agentId, agentVersion: 1, input: {},
    rule: { kind: 'weekdays', hour: 7, minute: 30 }, timezone: 'Asia/Tokyo', enabled: true,
    nextRunAt: '2026-09-28T22:30:00Z', lastRunAt: null, createdBy: 'u1', createdAt: NOW.toISOString(), ...over,
  };
}

/** 定時実行と監査ログだけを持つ、偽のリポジトリ。 */
function fakeRepo(items: Schedule[]) {
  const audits: AuditEvent[] = [];
  const repo = {
    async listSchedules(tenantId: string, userId: string | null) {
      return items.filter((s) => s.tenantId === tenantId && (userId === null || s.userId === userId));
    },
    async updateSchedule(s: Schedule) {
      const i = items.findIndex((x) => x.id === s.id);
      items[i] = s;
    },
    async appendAudit(e: AuditEvent) { audits.push(e); },
  } as unknown as Repository;
  return { repo, items, audits };
}

const AGENTS = [
  { id: 'morning-brief', name: '朝のブリーフ' },
  { id: 'weekly-brief', name: '週次ブリーフ' },
  { id: 'inbox-triage', name: 'メール整理・下書き作成' },
];

test('ファイルを受け取る業務と秘書の調べものは、定時実行に登録できない', () => {
  const byId = (id: string) => OFFICIAL_AGENTS.find((a) => a.id === id) as AgentDefinition;
  assert.equal(isSchedulable(byId(LOOKUP_AGENT_ID)), false);
  const withFile = OFFICIAL_AGENTS.find((a) => Object.keys((a.inputs as { properties?: object }).properties ?? {}).includes('fileId'));
  assert.ok(withFile, 'ファイルを受け取る公式の業務がある');
  assert.equal(isSchedulable(withFile!), false);
  assert.equal(isSchedulable(byId('weekly-brief')), true);
});

test('必須の欄が空なら、その欄の題名を返す', () => {
  const def = {
    id: 'x', inputs: { properties: { topic: { title: '題材' }, note: { title: 'メモ' } }, required: ['topic'] },
  } as unknown as AgentDefinition;
  assert.deepEqual(missingInputs(def, {}), ['題材']);
  assert.deepEqual(missingInputs(def, { topic: '  ' }), ['題材']);
  assert.deepEqual(missingInputs(def, { topic: '新製品' }), []);
});

test('再開すると次回を今から求め直し、止めていた間の回は起動しない', () => {
  const stale = schedule('s1', 'morning-brief', { enabled: false, nextRunAt: '2026-09-20T22:30:00Z' });
  const resumed = withEnabled(stale, true, NOW);
  assert.equal(resumed.enabled, true);
  assert.ok(Date.parse(resumed.nextRunAt) > NOW.getTime(), '次回は今より後');
  assert.equal(resumed.nextRunAt, '2026-09-27T22:30:00.000Z', '次の平日（月曜）の 7:30');
  const paused = withEnabled(resumed, false, NOW);
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, resumed.nextRunAt);
  const now = triggeredNow(paused, NOW);
  assert.equal(now.enabled, true);
  assert.equal(now.nextRunAt, NOW.toISOString());
});

test('秘書: 「朝のブリーフを止めて」で止め、朝のブリーフの実行には取り次がない', async () => {
  const { repo, items, audits } = fakeRepo([schedule('s1', 'morning-brief'), schedule('s2', 'weekly-brief')]);
  const a = await answerSchedule(repo, 't1', 'u1', '朝のブリーフを止めて', AGENTS, NOW);
  assert.equal(a?.action, 'pause');
  assert.match(a!.text, /「朝のブリーフ」.*を止めました/);
  assert.equal(items[0]!.enabled, false);
  assert.equal(items[1]!.enabled, true, 'ほかの定時実行は止めない');
  assert.equal(audits[0]?.action, 'schedule.update');
  assert.equal(audits[0]?.actorType, 'secretary');
  const again = await answerSchedule(repo, 't1', 'u1', '朝のブリーフを止めて', AGENTS, NOW);
  assert.match(again!.text, /もう止まっています/);
});

test('秘書: 再開と今すぐ実行', async () => {
  const { repo, items, audits } = fakeRepo([schedule('s1', 'morning-brief', { enabled: false, nextRunAt: '2026-09-20T22:30:00Z' })]);
  const r = await answerSchedule(repo, 't1', 'u1', '止めていた朝のブリーフを再開して', AGENTS, NOW);
  assert.equal(r?.action, 'resume');
  assert.match(r!.text, /再開しました。次回は 9\/28（月）7:30 です/);
  assert.equal(items[0]!.enabled, true);
  const run = await answerSchedule(repo, 't1', 'u1', '朝のブリーフを今すぐ実行して', AGENTS, NOW);
  assert.equal(run?.action, 'run');
  assert.equal(items[0]!.nextRunAt, NOW.toISOString());
  assert.equal(audits.at(-1)?.action, 'schedule.trigger');
});

test('秘書: 定時実行の状態を並べる。推論を使わない', async () => {
  const { repo } = fakeRepo([
    schedule('s1', 'morning-brief'),
    schedule('s2', 'weekly-brief', { enabled: false, rule: { kind: 'weekly', weekday: 1, hour: 8, minute: 0 } }),
  ]);
  const a = await answerSchedule(repo, 't1', 'u1', '定時実行はどうなってる？', AGENTS, NOW);
  assert.equal(a?.action, 'status');
  assert.match(a!.text, /定時実行は 2 件です/);
  assert.match(a!.text, /朝のブリーフ: 毎平日（月〜金） 7:30・有効・次回/);
  assert.match(a!.text, /週次ブリーフ: 毎週月曜 8:00・停止中/);
});

test('秘書: どれか決められなければ実行せずに聞き、登録・削除は画面を案内する', async () => {
  const { repo, items } = fakeRepo([schedule('s1', 'morning-brief'), schedule('s2', 'weekly-brief')]);
  const ask = await answerSchedule(repo, 't1', 'u1', '定時実行を止めて', AGENTS, NOW);
  assert.equal(ask?.action, 'ask');
  assert.match(ask!.text, /どの定時実行を止めますか/);
  assert.ok(items.every((s) => s.enabled), '何も止めない');
  const edit = await answerSchedule(repo, 't1', 'u1', '定時実行を追加して', AGENTS, NOW);
  assert.equal(edit?.action, 'edit');
  assert.match(edit!.text, /「定時実行」の画面/);
});

test('秘書: 定時実行の話でなければ答えない（業務の依頼・予定の確認）', async () => {
  const { repo } = fakeRepo([schedule('s1', 'morning-brief')]);
  assert.equal(await answerSchedule(repo, 't1', 'u1', '朝のブリーフを作って', AGENTS, NOW), null);
  assert.equal(await answerSchedule(repo, 't1', 'u1', '今日のスケジュールは？', AGENTS, NOW), null);
  assert.equal(await answerSchedule(repo, 't1', 'u1', '会議を止めてほしいと伝えて', AGENTS, NOW), null);
});

test('秘書: ほかの人の定時実行は見ない・触らない', async () => {
  const { repo, items } = fakeRepo([schedule('s1', 'morning-brief', { userId: 'u2' })]);
  const a = await answerSchedule(repo, 't1', 'u1', '朝のブリーフを止めて', AGENTS, NOW);
  assert.equal(a, null, '本人の定時実行に名前が当たらない');
  const s = await answerSchedule(repo, 't1', 'u1', '定時実行の一覧を見せて', AGENTS, NOW);
  assert.match(s!.text, /定時実行はありません/);
  assert.equal(items[0]!.enabled, true);
});
