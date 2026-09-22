/**
 * @file AG-02 議事録作成・共有のエージェント定義。
 *
 * @see 仕様書 第9.5.2節
 */

import type { AgentDefinition } from '@m2office/shared';

/**
 * AG-02 議事録作成・共有。
 *
 * プロトタイプで危険度の全レンジを 1 つで通す役割を持つ。
 * `read` → `draft` → 承認 → `write-internal` → 承認 → `external-send`
 * と進み、最後に組織知識へ登録される。
 *
 * @remarks
 * `chat.post` が `external-send` にあたるため、承認ゲートが必須である。
 * 承認ゲートを外した定義は導入時の検証で拒否される（第9.4節）。
 *
 * @see 仕様書 第24.3.3節
 */
export const AG02_MINUTES: AgentDefinition = {
  schemaVersion: 1,
  id: 'minutes',
  version: 1,
  name: '議事録作成・共有',
  category: 'meeting',
  description: '会議の記録から議事録を作り、タスクを起票して共有します',
  locale: 'ja-JP',
  compartment: null,
  inputs: {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', title: '会議名' },
      transcript: { type: 'string', title: '会議の記録', format: 'textarea' },
      space: { type: 'string', title: '共有先のスペース' },
    },
  },
  tools: ['meeting.get_transcript', 'document.create', 'tasks.create', 'chat.post'],
  knowledge: { collections: ['minutes'] },
  steps: [
    {
      id: 'fetch',
      type: 'agent',
      label: '取得',
      instruction: [
        '会議の記録を取得する。',
        '取得できない場合は推測で補わず、取得不可として報告する。',
      ].join('\n'),
      onEmpty: 'stop',
      onError: 'stop',
    },
    {
      id: 'draft',
      type: 'agent',
      label: '作成',
      instruction: [
        '記録から議題・決定事項・保留事項・担当と期限を構造化し、議事録を作成する。',
        '決まっていないことを決まったように書かない。',
      ].join('\n'),
    },
    {
      id: 'gate-content',
      type: 'approval',
      label: '内容の承認',
      approverRole: ['admin', 'approver'],
      present: '議事録の内容と、抽出した決定事項',
      onReject: 'stop',
    },
    {
      id: 'tasks',
      type: 'agent',
      label: '起票',
      instruction: '承認された決定事項を ToDo として起票する。',
    },
    {
      id: 'gate-share',
      type: 'approval',
      label: '共有の承認',
      approverRole: ['admin', 'approver'],
      present: '共有先のスペースと、投稿する本文',
      onReject: 'stop',
    },
    {
      id: 'share',
      type: 'agent',
      label: '共有',
      instruction: '承認された内容をチャットへ投稿する。',
    },
  ],
  constraints: [
    '決定していない事項を決定として書かない',
    '承認前に共有しない',
    '参加者の発言を創作しない',
  ],
  limits: { maxSteps: 20, maxTokens: 200_000, timeoutSec: 600 },
  evals: [
    {
      name: '記録が空の場合',
      input: { title: '定例', transcript: '' },
      expect: '取得不可として中断し、議事録を作らないこと',
    },
  ],
};
