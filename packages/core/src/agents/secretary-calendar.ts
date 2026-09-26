/**
 * @file 予定の登録（秘書が頼む業務）のエージェント定義。
 *
 * 秘書に「さっきの行程をカレンダーに入れて」と頼んだときの受け皿（仕様書 第10.9.7節、ADR-0033）。
 * メニューからも使える。
 *
 * @see 仕様書 第10.9.7節 予定の登録
 */

import type { AgentDefinition } from '@m2office/shared';

/**
 * 予定の登録。
 *
 * @remarks
 * `calendar.create` は相手に招待が届きうるため `external-send` の道具で、承認の段を置く。
 * **本人だけ・社内の人だけの予定は自動で通り**、社外の人を招くときだけ本人が承認する（第9.4.0節、ADR-0028）。
 * 承認の前の組み立て（ADR-0023）で、入れる予定を記録してから判断する。
 */
export const SECRETARY_CALENDAR: AgentDefinition = {
  schemaVersion: 1,
  id: 'calendar-register',
  version: 1,
  name: '予定の登録',
  category: 'calendar',
  description: '本人のカレンダーに予定を入れます（出張の行程・外出・作業の時間など。複数可）。社外の人を招くときだけ確認します',
  locale: 'ja-JP',
  compartment: null,
  inputs: {
    type: 'object',
    required: ['request'],
    properties: {
      request: {
        type: 'string', title: '入れる予定（日時・題名・場所）', format: 'textarea',
        examples: ['10/1 7:30〜9:57 東京→新大阪（のぞみ）、10:00〜15:00 大阪で会議'],
      },
    },
  },
  tools: ['calendar.list', 'calendar.create'],
  steps: [
    {
      id: 'check',
      type: 'agent',
      label: '確認',
      tools: ['calendar.list'],
      instruction: [
        '依頼に書かれた予定を、1 件ずつ（題名・開始・終了・場所）に分ける。日付が年を持たなければ、今日以降でいちばん近い日にする。',
        '入れる日の本人の予定を calendar.list で見て、重なるものがあれば答えに書く（重なっても、依頼どおりに入れる）。',
        '入れる予定の一覧を、日時の順に答えに書く。',
      ].join('\n'),
      onError: 'stop',
    },
    {
      id: 'approve',
      type: 'approval',
      label: '承認',
      // 本人の予定なので本人が判断する（社外の人を招くときだけ人に回る）
      approver: 'requester',
      approverRole: [],
      present: '入れる予定',
      onReject: 'stop',
    },
    {
      id: 'create',
      type: 'agent',
      label: '登録',
      tools: ['calendar.create'],
      required: ['calendar.create'],
      instruction: [
        '確認の段の一覧のとおりに、calendar.create で 1 件ずつ予定を入れる。時刻は日本時間の ISO 形式（+09:00）で渡す。',
        '依頼に参加者が書かれていなければ attendees を渡さない（本人だけの予定にする）。',
        '場所は題名の後ろに括弧で添える。',
      ].join('\n'),
    },
  ],
  constraints: [
    '依頼に書かれていない人を招待しない',
    '依頼に書かれていない予定を足さない',
  ],
  limits: { maxSteps: 8, maxTokens: 60_000, timeoutSec: 300 },
  evals: [
    {
      name: '出張の行程を入れる',
      input: { request: '10/1 7:30〜9:57 東京→新大阪、10:00〜15:00 大阪で会議、15:50〜18:20 新大阪→東京' },
      expect: '3 件の予定を、参加者なしで本人のカレンダーに入れること',
    },
  ],
  help: {
    summary: '本人のカレンダーに予定を入れます。秘書に「カレンダーに入れて」と頼めば、秘書がこの業務に頼みます。',
    examples: [
      { title: '出張の行程を入れる', input: { request: '10/1 7:30〜9:57 東京→新大阪（のぞみ）、10:00〜15:00 大阪で会議、15:50〜18:20 新大阪→東京' } },
    ],
    notes: [
      '本人だけ・社内の人だけの予定は、確認を待たずに入れます。社外の人を招くときだけ、あなたが承認します',
      '予定が重なっていても、頼まれたとおりに入れ、重なりをお知らせします',
    ],
  },
  face: 7,
};
