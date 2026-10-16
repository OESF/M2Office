/**
 * @file AG-16 採用支援（仕様書 第9.6.6節、Q-239、ADR-0103）の単体テスト。
 *
 * 求人原稿の点検（性別・年齢を限る書き方・明示事項の抜け）、要約と質問の点検（公正な採用選考で使ってはならない事柄）、
 * 業務が人事区画に属すること、保持期間を過ぎた実行の中身と応募書類を消すことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HR_COMPARTMENT, type AuditEvent } from '@m2office/shared';
import { MemoryFileStore, OFFICIAL_AGENTS, RECRUITING_KEEP_MS, checkRecruitText, purgeRecruitingRuns, type Repository } from '../src/index.js';

test('求人原稿: 性別・年齢を限る書き方と、明示事項の抜けを示す', () => {
  const r = checkRecruitText('posting', '営業マン募集。35 歳以下の若手歓迎。女性活躍中。月給 25 万円。勤務地は本社。', '株式会社テスト');
  assert.deepEqual(r.problems.map((p) => p.word).sort(), ['35 歳以下', '女性活躍中', '営業マン', '若手'].sort());
  assert.ok(r.missing.includes('試用期間'));
  assert.ok(r.missing.includes('受動喫煙を防ぐ措置'));
  assert.ok(r.missing.includes('募集する会社の名前'));
  assert.ok(!r.missing.includes('賃金'));
  assert.ok(!r.missing.includes('就業の場所'));
  const full = checkRecruitText('posting', '株式会社テスト。仕事内容: 受発注（変更の範囲: 会社の定める業務）。契約期間: 期間の定めなし。試用期間 3 か月。勤務地: 本社（変更の範囲: 本社のみ）。勤務時間 9:00〜18:00、休憩 60 分、休日 土日祝、時間外 月 10 時間程度。月給 25 万円。社会保険完備。屋内禁煙。', '株式会社テスト');
  assert.deepEqual(full, { problems: [], missing: [] });
});

test('要約と面接の質問: 本人に責任の無いことや思想信条を使っていれば示す', () => {
  const s = checkRecruitText('summary', '山田さん: 営業 5 年。既婚で子ども 2 人。出身地は大阪。簿記 2 級。');
  assert.deepEqual(s.problems.map((p) => p.word), ['既婚', '子ども', '出身地']);
  const q = checkRecruitText('questions', '前職で一番成果を上げた仕事は？ ご両親のお仕事は？ 支持政党は？');
  assert.deepEqual(q.problems.map((p) => p.word), ['両親', '支持政党']);
  assert.deepEqual(checkRecruitText('summary', '営業 5 年。簿記 2 級。受発注の経験あり。').problems, []);
});

test('採用支援は人事区画に属し、送るツールを持たない', () => {
  const def = OFFICIAL_AGENTS.find((a) => a.id === 'recruiting')!;
  assert.equal(def.compartment, HR_COMPARTMENT);
  assert.ok(!def.tools.some((t) => /send|post|share|create_draft/.test(t)), '応募者に送らない');
  assert.ok(!def.tools.includes('web.research'), '書類の外の情報を調べない');
});

test('保持期間を過ぎた実行の中身と、入力に渡した応募書類を消す', async () => {
  const store = new MemoryFileStore();
  await store.put('t1', 'f-made1', new Uint8Array([1]));
  await store.put('t1', 'f-cv1', new Uint8Array([2]));
  await store.put('t1', 'f-cv2', new Uint8Array([3]));
  const purged: string[] = [];
  const deletedFiles: string[] = [];
  const audits: AuditEvent[] = [];
  let askedBefore = '';
  const repo = {
    listTenantIds: async () => ['t1'],
    listRunsToPurge: async (_t: string, agentId: string, before: string) => {
      askedBefore = before;
      return agentId === 'recruiting' ? [{ runId: 'r1', jobId: 'j1', input: { request: '要約して', fileId: 'f-cv1', moreFileIds: 'f-cv2' } }] : [];
    },
    purgeRunContents: async (_t: string, runId: string) => { purged.push(runId); return ['f-made1']; },
    deleteFile: async (_t: string, id: string) => { deletedFiles.push(id); },
    appendAudit: async (e: AuditEvent) => { audits.push(e); },
  } as unknown as Repository;
  const now = new Date('2026-10-16T00:00:00Z');
  assert.equal(await purgeRecruitingRuns(repo, store, now), 1);
  assert.equal(askedBefore, new Date(now.getTime() - RECRUITING_KEEP_MS).toISOString());
  assert.deepEqual(purged, ['r1']);
  assert.deepEqual(deletedFiles, ['f-cv1', 'f-cv2']);
  for (const id of ['f-made1', 'f-cv1', 'f-cv2']) assert.equal(await store.get('t1', id), null);
  assert.equal(audits[0]?.action, 'recruiting.purge');
});
