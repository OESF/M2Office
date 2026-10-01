/**
 * @file ダッシュボードの「業務の状態」のまとまりの単体テスト。数の合わせ方・並び・囲みの中に出す業務。
 *
 * @see 仕様書 第6.7.4.2.1節 業務のまとまり
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAgents, type AgentLoad } from '../src/agent-groups.js';

const load = (agentId: string, group: { id: string; name: string } | undefined, over: Partial<AgentLoad> = {}): AgentLoad => ({
  agentId, name: agentId, face: agentId.length, ...(group ? { group } : {}),
  running: 0, awaiting: 0, queued: 0, todayRuns: 0, todayFailed: 0, ...over,
});
const CARDS = { id: 'ext:cards', name: '名刺管理' };
const MAIL = { id: 'cat:mail', name: 'メール' };

test('まとまり: 同じまとまりの受け持ちと今日の件数を足し、絵は定義の順で最初の業務のもの', () => {
  const groups = groupAgents([
    load('取り込み', CARDS, { todayRuns: 3 }),
    load('修正', CARDS, { running: 1, todayRuns: 1 }),
    load('まとめてのメール', CARDS, { awaiting: 2, todayFailed: 1 }),
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0]!;
  assert.deepEqual([g.name, g.face, g.running, g.awaiting, g.queued, g.todayRuns, g.todayFailed], ['名刺管理', '取り込み'.length, 1, 2, 0, 4, 1]);
  assert.deepEqual(g.items.map((a) => a.agentId), ['まとめてのメール', '修正', '取り込み'], '中も忙しい順。同じなら今日の件数の多い順');
  assert.deepEqual(g.active.map((a) => a.agentId), ['まとめてのメール', '修正'], '囲みの中に出すのは受け持ちのある業務と失敗した業務だけ');
});

test('まとまりの並び: 忙しい順、同じなら今日の件数の多い順。group の無い業務はその業務だけのまとまり', () => {
  const groups = groupAgents([
    load('メール整理', MAIL, { todayRuns: 5 }),
    load('取り込み', CARDS),
    load('返信待ち', MAIL, { todayRuns: 1 }),
    load('古い API の業務', undefined, { queued: 1 }),
  ]);
  assert.deepEqual(groups.map((g) => [g.id, g.items.length]), [['agent:古い API の業務', 1], ['cat:mail', 2], ['ext:cards', 1]]);
  assert.equal(groups[0]!.name, '古い API の業務');
  assert.deepEqual(groups[1]!.active, [], '待機だけのまとまりは囲みの中に業務を出さない');
});
