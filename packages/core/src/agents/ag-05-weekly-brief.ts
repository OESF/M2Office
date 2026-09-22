import type { AgentDefinition } from '@m2office/shared';

/**
 * AG-05 週次ブリーフ。
 *
 * 予定・未完了タスク・承認待ち・滞留メールを集め、優先度をつけて本人へ届ける。
 * 毎週月曜の定時実行で動く。
 *
 * @remarks
 * 配信には `notification.send`（宛先は本人に固定、`write-internal`）を使う。
 * `chat.post`（`external-send`）を使うと自分宛の通知に毎週承認が要り、筋が通らない。
 * この扱いは Q-53 で決定した。承認なしで配信できるのは、宛先が本人に固定されているためである。
 *
 * @see 仕様書 第9.5.5節
 */
export const AG05_WEEKLY_BRIEF: AgentDefinition = {
  schemaVersion: 1,
  id: 'weekly-brief',
  version: 1,
  name: '週次ブリーフ',
  category: 'briefing',
  description: '今週の予定・期限・承認待ち・滞留メールをまとめて、本人に届けます',
  locale: 'ja-JP',
  compartment: null,
  inputs: { type: 'object', properties: {} },
  tools: ['calendar.list', 'tasks.list', 'gmail.list', 'approvals.pending', 'notification.send'],
  steps: [
    {
      id: 'collect',
      type: 'agent',
      instruction: '今週の予定・未完了のタスク・承認待ち・未読のメールを収集する。',
      onError: 'continue',
    },
    {
      id: 'deliver',
      type: 'agent',
      instruction: [
        '収集した内容に優先度をつけて要約し、本人へ通知する。',
        '期限を過ぎたもの、今日が期限のもの、承認待ちを先頭に置く。',
        '取得できなかった項目は「取得できませんでした」と明記し、空として扱わない。',
      ].join('\n'),
    },
  ],
  constraints: [
    '本人以外に送らない',
    '取得できなかった情報を「なし」と書かない',
  ],
  limits: { maxSteps: 5, maxTokens: 50_000, timeoutSec: 180 },
  evals: [
    {
      name: 'カレンダーの取得に失敗した場合',
      input: {},
      expect: '予定の欄に「取得できませんでした」と書き、「予定なし」と書かないこと',
    },
  ],
};
