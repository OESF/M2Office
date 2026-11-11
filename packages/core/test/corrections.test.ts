/**
 * @file 直しから学び、直しを数える（仕様書 第11.13.7節、ADR-0134。秘書の成長 段 4）の単体テスト。
 *
 * 作り直しの頼み・差し戻しを数え、次からもの直しだけを業務ごとの好みとして覚えること、業務に渡す好みの選び方、
 * 取り次ぎの好み（覚える・当てる）、頼み直しの見分け、週ごとの数（メールを含む・100 件あたり）を確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS } from '@m2office/shared';
import {
  StubLlmProvider, correctionLine, correctionProgress, learnFromCorrection, learningWeek, parseCorrectionVerdict, phraseKey,
  preferencesForAgent, rememberRoute, routeHints, routingPhrase, type Memory, type Repository,
} from '../src/index.js';
import { rerouteRest } from '../src/secretary/secretary.js';

const T = 't-learn';
const U = 'u-learn';

/** 記憶と週ごとの数を持つ偽の置き場。 */
function fakeRepo(opts: { learning?: boolean } = {}) {
  const memories: Memory[] = [];
  const counts: { week: string; kind: string; count: number }[] = [];
  const repo = {
    memories, counts,
    getUserSettings: async () => ({ ...DEFAULT_USER_SETTINGS, memory: { ...DEFAULT_USER_SETTINGS.memory, learning: opts.learning ?? true } }),
    listMemories: async () => memories.filter((m) => m.kind !== 'routing'),
    listRoutingMemories: async () => memories.filter((m) => m.kind === 'routing'),
    createMemory: async (m: Memory) => { memories.unshift(m); },
    deleteMemory: async (_t: string, _u: string, id: string) => { const i = memories.findIndex((m) => m.id === id); if (i >= 0) memories.splice(i, 1); return i >= 0; },
    touchMemories: async () => undefined,
    addLearningCount: async (_t: string, _u: string, week: string, kind: string, n: number) => {
      const r = counts.find((x) => x.week === week && x.kind === kind);
      if (r) r.count += n; else counts.push({ week, kind, count: n });
    },
    learningCounts: async (_t: string, _u: string, since: string) => counts.filter((x) => x.week >= since),
  };
  return repo as typeof repo & Repository;
}

const llm = new StubLlmProvider();
const deps = (repo: ReturnType<typeof fakeRepo>) => ({ repo, llmFor: async () => llm });

test('作り直しの頼み: 次からもの直しは業務ごとの好みとして覚え、その場かぎりの直しは数えるだけ', async () => {
  const repo = fakeRepo();
  const now = new Date('2026-11-11T03:00:00Z');
  assert.equal(await learnFromCorrection(deps(repo), { tenantId: T, userId: U, kind: 'remake', agentId: 'quote', agentName: '見積書の作成', correction: '3 枚目の数字を最新に' }, now), null);
  const kept = await learnFromCorrection(deps(repo), { tenantId: T, userId: U, kind: 'reject', agentId: 'quote', agentName: '見積書の作成', correction: 'いつも税込みで出す' }, now);
  assert.equal(kept, '税込みで出す');
  assert.deepEqual(repo.memories.map((m) => [m.kind, m.agentId, m.text]), [['preference', 'quote', '税込みで出す']]);
  // 同じ好みは重ねて覚えない
  await learnFromCorrection(deps(repo), { tenantId: T, userId: U, kind: 'remake', agentId: 'quote', agentName: '見積書の作成', correction: 'いつも税込みで出す' }, now);
  assert.equal(repo.memories.length, 1);
  assert.deepEqual(repo.counts.map((c) => [c.kind, c.count]).sort(), [['reject', 1], ['remake', 2]], '直しは覚えなくても数える');
});

test('覚えることを止めている人は、直しを数えるだけで覚えない', async () => {
  const repo = fakeRepo({ learning: false });
  assert.equal(await learnFromCorrection(deps(repo), { tenantId: T, userId: U, kind: 'remake', agentId: 'mail', agentName: 'メール', correction: '次からは短く' }), null);
  assert.equal(repo.memories.length, 0);
  assert.equal(repo.counts[0]?.count, 1);
});

test('業務に渡す好み: その業務の好みと、業務を決めない好みを分けて選ぶ', () => {
  const m = (i: number, agentId: string | null): Memory => ({ id: `m${i}`, tenantId: T, userId: U, text: `好み${i}`, source: 'learned', kind: 'preference', agentId, createdAt: '' });
  const memories = [...Array.from({ length: 25 }, (_, i) => m(i, 'quote')), ...Array.from({ length: 15 }, (_, i) => m(100 + i, null)), m(200, 'slides'),
    { id: 'f', tenantId: T, userId: U, text: '事実', source: 'learned', kind: 'fact', createdAt: '' } as Memory];
  const picked = preferencesForAgent(memories, 'quote');
  assert.equal(picked.filter((x) => x.agentId === 'quote').length, 20);
  assert.equal(picked.filter((x) => !x.agentId).length, 10);
  assert.ok(picked.every((x) => x.kind === 'preference' && x.agentId !== 'slides'), 'ほかの業務の好みと事実は渡さない');
});

test('取り次ぎの好み: 覚えると同じ言い方の古いものを置き換え、言い方がほぼ同じなら、その業務に取り次ぐ', async () => {
  const repo = fakeRepo();
  assert.ok(await rememberRoute(repo, T, U, '来月の予定をまとめて', 'weekly-brief', '週次ブリーフ'));
  assert.ok(await rememberRoute(repo, T, U, '来月の予定をまとめて', 'monthly-plan', '月の計画'));
  const routing = repo.memories.filter((m) => m.kind === 'routing');
  assert.equal(routing.length, 1, '同じ言い方は置き換える');
  assert.equal(routingPhrase(routing[0]!.text), '来月の予定をまとめて');
  assert.equal(routeHints(routing, '来月の予定をまとめてください').direct, 'monthly-plan');
  const other = routeHints(routing, '見積を作って');
  assert.equal(other.direct, null);
  assert.equal(other.hints.length, 1, '合わなくても、例として推論に渡す');
  assert.equal(phraseKey('見積を作って。'), phraseKey('見積を作ってください'));
});

test('頼み直しの見分け: 「それじゃなくて〇〇」の〇〇を取り出す（目印は文の頭の近くだけ）', () => {
  assert.equal(rerouteRest('それじゃなくて、見積書を作って'), '見積書を作って');
  assert.equal(rerouteRest('そうではなくて議事録'), '議事録');
  assert.equal(rerouteRest('見積書を作って'), null);
  assert.equal(rerouteRest('先週の会議で話したのは見積じゃなくて請求書'), null, '文の途中の「じゃなくて」は頼み直しにしない');
});

test('週ごとの数: メールの直しと外れを足し、頼んだ 100 件あたりも出す。週次ブリーフの 1 行', async () => {
  const repo = fakeRepo();
  const now = new Date('2026-11-11T03:00:00Z');
  const week = learningWeek(now);
  const last = learningWeek(new Date(now.getTime() - 7 * 86_400_000));
  assert.equal(week, '2026-11-09');
  repo.counts.push({ week, kind: 'remake', count: 2 }, { week, kind: 'requests', count: 50 }, { week: last, kind: 'reroute', count: 3 }, { week: last, kind: 'requests', count: 20 });
  const p = await correctionProgress(repo, T, U, now, [{ week, corrections: 1, misses: 1 }]);
  assert.deepEqual(p.thisWeek.byKind, { remake: 2, mail: 2 });
  assert.equal(p.thisWeek.total, 4);
  assert.equal(p.thisWeek.per100, 8);
  assert.equal(p.lastWeek?.total, 3);
  assert.equal(correctionLine(p), '今週の秘書への直しは 4 回でした（頼んだ 100 件あたり 8 回。先週は 3 回）。');
});

test('推論の答えが読めなければ、覚えない', () => {
  assert.deepEqual(parseCorrectionVerdict('分かりません'), { keep: false, preference: '' });
  assert.equal(parseCorrectionVerdict('{"keep": true, "preference": ""}').keep, false, '文が空なら覚えない');
  assert.equal(parseCorrectionVerdict('前置き {"keep": true, "preference": "表紙はロゴだけ"} ').preference, '表紙はロゴだけ');
});
