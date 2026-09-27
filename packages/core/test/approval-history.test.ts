/**
 * @file 判断したもの（承認の履歴）の単体テスト。
 *
 * 承認の段の記録から、承認のあとに実際に行った操作を業務の言葉にし、結果の相手のリンクと失敗の理由を取り出すこと、
 * 行っていない（却下・まだ）ときは何も出さないことを確かめる。
 *
 * @see 仕様書 第6.2.5節 判断したもの
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunStep } from '@m2office/shared';
import { executedCalls } from '../src/index.js';

const gate = (output: unknown, toolCalls: unknown): RunStep => ({
  id: 's1', runId: 'r1', seq: 1, stepId: 'approve', kind: 'approval', status: 'succeeded',
  input: { toolCalls }, output, startedAt: '', endedAt: '',
} as RunStep);

test('承認のあとに行った操作を業務の言葉にし、結果の中の相手のリンクを取り出す（エスケープされた JSON の文字の中も探す）', () => {
  const step = gate(
    {
      decision: 'approved', executed: true,
      tools: [
        { name: 'chat.post', result: { ok: true, url: 'https://chat.google.com/room/AAA/msg' } },
        { name: 'slack.slack_send_message', result: { text: '{"message_link":"https:\\/\\/m2office.slack.com\\/archives\\/C0C4\\/p179","ok":true}' } },
        { name: 'gmail.send', result: { error: '送れませんでした: 宛先が見つかりません' } },
      ],
    },
    [
      { name: 'chat.post', args: { space: 'spaces/AAA', text: '議事録を共有します' }, shown: '技術部' },
      { name: 'slack.slack_send_message', args: { channel_id: 'C0C4', message: '投稿テスト' } },
      { name: 'gmail.send', args: { to: ['a@example.jp'], subject: '見積', body: '…' } },
    ],
  );
  const done = executedCalls(step, {
    connectionOf: (n) => (n.startsWith('slack.') ? { service: 'Slack', tool: 'slack_send_message', risk: 'external-send' } : undefined),
  });
  assert.deepEqual(done, [
    { text: '**チャットのスペース「技術部」に投稿します**:', link: 'https://chat.google.com/room/AAA/msg', error: null },
    { text: '**Slackへ送ります**（slack_send_message）', link: 'https://m2office.slack.com/archives/C0C4/p179', error: null },
    { text: '**メールを送ります**: 宛先 a@example.jp／件名「見積」', link: null, error: '送れませんでした: 宛先が見つかりません' },
  ]);
});

test('まだ行っていない・記録が無いときは、何も出さない（推測で作らない）', () => {
  assert.deepEqual(executedCalls(gate({ decision: 'approved', executed: false }, [{ name: 'chat.post', args: {} }])), []);
  assert.deepEqual(executedCalls(gate(null, null)), []);
  assert.deepEqual(executedCalls(null), []);
});
