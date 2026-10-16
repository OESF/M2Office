/**
 * @file 社外との日程調整の招待（AG-03 の続き。仕様書 第9.5.3.1節、ADR-0103）。
 */

import type { AgentDefinition } from '@m2office/shared';

/**
 * 社外の相手が返事で候補を選んだあと、その日時で予定を作って招く業務。返事の見張り（ワーカー）が、依頼した本人の依頼として始める。
 *
 * @remarks
 * 招待は相手に届くため `external-send`。依頼した本人が承認する（`approver: requester`）。メニューには出さない（返事の後にだけ始まる）。
 * 業務の流れは分岐を持たない（第9.2.1節）ため、候補を送る AG-03 と、返事の後の招待を別の業務にした
 *
 * @see 仕様書 第9.5.3.1節
 */
export const SCHEDULING_CONFIRM: AgentDefinition = {
  schemaVersion: 1,
  id: 'scheduling-confirm',
  version: 1,
  name: '日程調整の招待',
  category: 'calendar',
  description: '社外の方が返事で選んだ日時で予定を作り、あなたの確認の後に招待します',
  locale: 'ja-JP',
  compartment: null,
  menu: false,
  inputs: {
    type: 'object',
    required: ['requestId'],
    properties: {
      requestId: { type: 'string', title: '日程調整の ID' },
      title: { type: 'string', title: '件名' },
    },
  },
  tools: ['schedule.confirm_prepare', 'schedule.invite'],
  steps: [
    {
      id: 'check',
      type: 'agent',
      tools: ['schedule.confirm_prepare'],
      label: '日時の確認',
      instruction: [
        'schedule.confirm_prepare に requestId を渡し、相手が選んだ日時（when）と招く人を短く書く。',
        'available が false なら、何も書かずに終える。',
      ].join('\n'),
      onEmpty: 'stop',
      onError: 'stop',
    },
    {
      id: 'gate-invite',
      type: 'approval',
      label: '招待の確認',
      approver: 'requester',
      approverRole: [],
      present: '相手が選んだ日時と、招く人（相手に招待が届きます）',
      onReject: 'stop',
    },
    {
      id: 'invite',
      type: 'agent',
      tools: ['schedule.invite'],
      label: '招待',
      instruction: 'schedule.invite に requestId を渡して、予定を作って招待する。結果の when と招いた人を報告する。',
    },
  ],
  constraints: ['承認の前に招待を送らない', '相手が選んでいない日時で予定を作らない'],
  limits: { maxSteps: 6, maxTokens: 20_000, timeoutSec: 120 },
  help: {
    summary: '社外の方が日程の候補から選んだあと、その日時で予定を作り、あなたの確認の後に招待します。',
    examples: [{ title: '返事で選ばれた日時で招待する（返事が届くと自動で始まります）', input: { requestId: '（日程調整の ID）', title: '見本商事様と打ち合わせ' } }],
    notes: ['日程調整で社外の方に候補を送ると、返事が届いたときに自動で始まります。メニューからは始めません'],
  },
  face: 23,
};
