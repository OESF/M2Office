/**
 * @file AG-04 社内ナレッジ Q&A のエージェント定義。
 *
 * @see 仕様書 第9.5.4節
 */

import type { AgentDefinition } from '@m2office/shared';

/**
 * AG-04 社内ナレッジ Q&A。
 *
 * 承認ゲートを持たない最短の経路であり、プロトタイプでは
 * 秘書 → 知識検索 → 応答の流れを検証する役割を持つ。
 *
 * @see 仕様書 第9.5節 初期エージェントカタログ
 * @see 仕様書 第24.3.3節 プロトタイプで実装するエージェント
 */
export const AG04_KNOWLEDGE_QA: AgentDefinition = {
  schemaVersion: 1,
  id: 'knowledge-qa',
  version: 1,
  name: '社内ナレッジ Q&A',
  category: 'knowledge',
  description: '社内規程や議事録から、出典つきで回答します',
  locale: 'ja-JP',
  compartment: null,
  inputs: {
    type: 'object',
    required: ['question'],
    properties: {
      question: { type: 'string', title: '知りたいこと' },
    },
  },
  tools: ['knowledge.search'],
  knowledge: { collections: ['internal-rules', 'minutes'] },
  steps: [
    {
      id: 'search',
      type: 'agent',
      instruction: [
        '利用者の質問に答えるため、組織知識を検索する。',
        '該当する知識が見つからない場合は、推測せず「見つからない」と報告する。',
      ].join('\n'),
      onEmpty: 'stop',
      onError: 'stop',
    },
    {
      id: 'answer',
      type: 'agent',
      instruction: [
        '検索結果をもとに回答をまとめる。',
        '必ず参照した文書名を添えること。出典のない断定をしない。',
      ].join('\n'),
    },
  ],
  constraints: [
    '出典のない回答をしない',
    '規程に書かれていないことを推測で補わない',
  ],
  limits: { maxSteps: 10, maxTokens: 50_000, timeoutSec: 120 },
  evals: [
    {
      name: '該当する規程がある場合',
      input: { question: '有給休暇の付与日数は' },
      expect: '規程名を出典として示したうえで日数を答えること',
    },
  ],
};
