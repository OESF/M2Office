/**
 * @file AG-03 日程調整のエージェント定義。
 *
 * @see 仕様書 第9.5.3節
 */

import type { AgentDefinition } from '@m2office/shared';

/**
 * AG-03 日程調整。
 *
 * 参加者の空きから候補を 3 つ作り、承認を経て予定を作成・招待する。
 *
 * @remarks
 * 招待は相手に届くため `external-send` にあたり、承認を省略できない。
 * 承認は**依頼した本人**が行う（`approver: requester`）。承認者や管理者の手は煩わせない。
 * **Phase 1 は社内の参加者のみを対象とする**（Q-52 で決定）。
 * 社外の参加者は空きが見えず、相手の返事を待つ別の仕組みが要るため。
 *
 * @see 仕様書 第9.5.3節
 */
export const AG03_SCHEDULING: AgentDefinition = {
  schemaVersion: 1,
  id: 'scheduling',
  version: 1,
  name: '日程調整',
  category: 'calendar',
  description: '社内の参加者の空きから候補を出し、承認後に予定を作って招待します',
  locale: 'ja-JP',
  compartment: null,
  inputs: {
    type: 'object',
    required: ['title', 'attendees'],
    properties: {
      title: { type: 'string', title: '目的・件名', examples: ['新製品の企画打ち合わせ'] },
      attendees: {
        type: 'string', title: '参加者（社内のみ）',
        examples: ['yamada@example.co.jp, sato@example.co.jp'],
      },
      durationMin: { type: 'string', title: '所要時間（分）', examples: ['60'] },
      period: { type: 'string', title: '希望する期間', examples: ['来週の午後'] },
      // 会議と一緒に会議室を取る（予約を使っている会社。第37.18節）
      room: { type: 'string', title: '会議室（任意）', examples: ['会議室も取る', '会議室 A'] },
    },
  },
  tools: ['calendar.freebusy', 'calendar.create'],
  steps: [
    {
      id: 'freebusy',
      type: 'agent',
      // この段で使えるツール（仕様書 第9.2.7節）。段の区切りを推論の行儀に頼らない
      tools: ['calendar.freebusy'],
      label: '空き確認',
      instruction: '参加者全員の空きを取得する。',
      onEmpty: 'stop',
      onError: 'stop',
    },
    {
      id: 'propose',
      type: 'agent',
      // この段で使えるツール（仕様書 第9.2.7節）。段の区切りを推論の行儀に頼らない
      tools: [],
      label: '候補作成',
      instruction: [
        '全員が空いている時間帯から候補を 3 つ挙げ、招待の文面を用意する。',
        '会社の営業日でない日（companyClosed。営業しない曜日・祝日・休業の期間）には候補を出さない。依頼で日にちを指定されたときは、その日が休業日であることを添える。',
        '空きが見つからない場合は候補を作らず、その旨を報告する。',
      ].join('\n'),
    },
    {
      id: 'gate-invite',
      type: 'approval',
      label: '承認',
      // 本人の用件なので本人が最終確認する（仕様書 第9.2.3節）
      approver: 'requester',
      approverRole: [],
      present: '予定の候補と招待の文面',
      onReject: 'stop',
    },
    {
      id: 'create',
      type: 'agent',
      // この段で使えるツール（仕様書 第9.2.7節）。段の区切りを推論の行儀に頼らない
      tools: ['calendar.create'],
      label: '招待',
      instruction: [
        '承認された候補の第一案で予定を作成し、参加者を招待する。',
        '会議室（room）が入っていれば、calendar.create の room に会議室の名前を入れる（「会議室も取る」のようにどれでもよいときは「会議室」）。結果の room に取れた会議室か取れなかった理由があれば、報告に添える。',
      ].join('\n'),
    },
  ],
  constraints: [
    '社外の参加者を招待しない（Phase 1）',
    '空いていない時間帯に予定を入れない',
    '承認前に招待を送らない',
  ],
  limits: { maxSteps: 10, maxTokens: 50_000, timeoutSec: 300 },
  evals: [
    {
      name: '全員の空きが無い場合',
      input: { title: '定例', attendees: 'a@example.jp' },
      expect: '候補を作らず、空きが無いと報告すること',
    },
  ],
  help: {
    summary: '社内の参加者の空いている時間から候補を出し、第一案で予定を登録して招待します。',
    examples: [{
      title: '来週の企画会議を調整する',
      input: { title: '企画会議', attendees: '（社内のメールアドレスをカンマ区切りで）', durationMin: '30', period: '来週' },
    }],
    notes: [
      '今は社内の参加者だけが対象です。社外の方との調整は今後対応します',
      '招く人が社内の人だけなら、確認を待たずに第一案で招待します。社外の人が入るときだけ、あなたが確認します',
      '全員が空いている時間が無いときは、候補を作らずにお知らせします',
      '会社の営業日でない日（営業しない曜日・休みの祝日・お知らせで出した休業の期間）には、候補を出しません',
      '予約を使っている会社では、「会議室も取って」と頼むと、決まった時間に空いている会議室を取って予定の場所に入れます',
    ],
    faq: [
      { q: '確認せずに招待が送られることはありますか', a: '社内の人だけなら、確認を待たずに送ります。社外の人を招くときは、必ずあなたの承認のあとに送ります' },
    ],
  },
  face: 4,
};
