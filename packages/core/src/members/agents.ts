/**
 * @file 会員とポイント（内蔵の拡張）の付属の業務と、拡張機能の一覧に並べるための形（仕様書 第40.2節・第40.7節）。
 *
 * 付属の業務「会員とポイント」は、秘書から頼まれた会員の照会・ポイントの調整・特典の作成を行う。社外には何も出さない（最上位の危険度は write-internal）。
 * お客様の情報を秘書の記憶と会社の知識に入れない（学ばない業務の印 `private`）。
 */

import { MEMBERS_EXTENSION_ID, type AgentDefinition } from '@m2office/shared';
import type { ExtensionPackage } from '../extensions/loader.js';

/** 内蔵の拡張の版。付属の業務やツールが変わったら上げる。 */
export const MEMBERS_EXTENSION_VERSION = '1.2.0';

/** 付属の業務「会員とポイント」（秘書から）。 */
export const MEMBER_DESK: AgentDefinition = {
  schemaVersion: 1,
  id: `${MEMBERS_EXTENSION_ID}:desk`,
  version: 1,
  name: '会員とポイント',
  category: 'sample',
  description: '会員の数・ポイント・来店の回数を答え（「会員は何人？」「しばらく来ていない会員は？」「田中さんのポイントは？」）、ポイントを足し（「田中さんに 5 ポイント足して」）、特典を作り（「10 ポイントでドリンク 1 杯の特典を作って」）、ランクを答えます（「ゴールドの会員は何人？」）',
  locale: 'ja-JP',
  compartment: null,
  menu: false,
  private: true,
  inputs: {
    type: 'object',
    required: ['request'],
    properties: {
      request: { type: 'string', title: '頼みたいこと', format: 'textarea', examples: ['会員は何人？', '10 ポイントでドリンク 1 杯の特典を作って'] },
      context: { type: 'string', title: 'これまでの会話', format: 'textarea' },
    },
  },
  tools: ['members.find', 'members.points', 'members.rewards', 'members.rank'],
  steps: [
    {
      id: 'act',
      type: 'agent',
      tools: ['members.find', 'members.points', 'members.rewards', 'members.rank'],
      label: '会員の台帳を扱う',
      instruction: [
        '依頼（request）に合わせて、ツールを 1 回だけ呼ぶ。',
        '「会員は何人？」は members.find（query 無し。total を答える）。「よく来た会員」は order に visits、「ポイントの多い会員」は points、「しばらく来ていない会員」は order に away と awayDays（言われなければ 60）。',
        '「〇〇さんのポイントは？」「会員番号 12 は？」は members.find の query に呼び名か番号を入れる。',
        '「〇〇さんに 5 ポイント足して」「3 ポイント引いて」は members.points（引くなら負の数）。理由（note）が言われなければ「秘書から」と入れる。',
        '特典の一覧・作る・直す・止めるは members.rewards（「ゴールドの会員だけの特典」は minRank に gold、「シルバー以上」は silver）。',
        '「ゴールドの会員は？」は members.find の rank に gold。「ランクの決め方は？」「ゴールドは年 20 回にして」「ランクを自動に戻して」は members.rank（show・set・auto）。',
      ].join('\n'),
      onError: 'stop',
    },
    {
      id: 'answer',
      type: 'agent',
      tools: [],
      label: '結果を伝える',
      instruction: [
        '結果を短く伝え、会員には [会員を開く](path) を添える。電話や個人のことは書かない。',
        'ポイントは来店と購入のおまけで、お金ではない。現金との交換や値引きの計算はしない（レジで行う）。',
        '特典の価値の上限（景品表示法の決まり）を聞かれたら、一般的な目安にとどめ、判断は会社がすることを添える。',
      ].join('\n'),
    },
  ],
  constraints: ['社外に何も出さない', 'お客様の電話を答えに書かない', 'お客様の情報を記憶に入れない', 'お金を扱わない'],
  limits: { maxSteps: 6, maxTokens: 30_000, timeoutSec: 180 },
  help: {
    summary: '会員の数・ポイント・来店の回数を答え、ポイントを足し、特典を作ります。',
    examples: [
      { title: '会員を聞く', input: { request: 'しばらく来ていない会員は？' } },
      { title: 'ポイントを足す', input: { request: '会員番号 12 に 5 ポイント足して' } },
      { title: '特典を作る', input: { request: '10 ポイントでドリンク 1 杯の特典を作って' } },
      { title: 'ランクを聞く', input: { request: 'ゴールドの会員は何人？' } },
    ],
    notes: ['ポイントを付ける・特典を使うのは、店員がスマホの会員のページで行います', 'ポイントはお金ではありません。値引きの計算はレジで行います'],
  },
  face: 19,
};

/**
 * 付属の業務「会員に LINE で知らせる」（第40.18節）。管理者が用意した知らせ（失効の前の知らせは仕組みが用意する）を、
 * 管理者か承認者の承認の後に、会員に LINE で 1 人ずつ送る。
 */
export const MEMBER_LINE_SEND: AgentDefinition = {
  schemaVersion: 1,
  id: `${MEMBERS_EXTENSION_ID}:line-send`,
  version: 1,
  name: '会員に LINE で知らせる',
  category: 'sample',
  description: '用意した会員への知らせ（失効の前の知らせ・しばらく来ていない会員へのご案内など）を、承認の後に LINE で 1 人ずつ送ります',
  locale: 'ja-JP',
  compartment: null,
  menu: false,
  private: true,
  inputs: { type: 'object', required: ['messageId'], properties: { messageId: { type: 'string', title: '知らせ' } } },
  tools: ['members.send_line'],
  steps: [
    { id: 'gate', type: 'approval', label: '会員への知らせの承認', approverRole: ['admin', 'approver'], present: '宛先の人数・1 人目に届く文・LINE の今月の残り', onReject: 'stop' },
    {
      id: 'send', type: 'agent', tools: ['members.send_line'], required: ['members.send_line'], label: '送る',
      instruction: '入力の messageId で members.send_line を 1 回だけ呼び、送れた数と送れなかった数を短く伝える。',
      onError: 'stop',
    },
  ],
  constraints: ['承認の前に送らない', '承認の後に中身が変わったら送らない'],
  limits: { maxSteps: 4, maxTokens: 10_000, timeoutSec: 600 },
  help: {
    summary: '会員への LINE の知らせを、承認の後に 1 人ずつ送ります。',
    examples: [],
    notes: ['会員の画面の「LINE で知らせる」から用意します。失効が近い会員への知らせは、週に 1 回、仕組みが用意して承認待ちにします'],
  },
  face: 20,
};

/** 会員とポイントの付属の業務。 */
export const MEMBER_AGENTS: AgentDefinition[] = [MEMBER_DESK, MEMBER_LINE_SEND];

/** 会員とポイントを、拡張機能の一覧に並べるための形（第12.13節「公式・内蔵」）。 */
export const MEMBERS_PACKAGE: ExtensionPackage = {
  manifest: {
    id: MEMBERS_EXTENSION_ID,
    name: '会員とポイント',
    version: MEMBERS_EXTENSION_VERSION,
    description: 'お客様を会員にし、来店と購入のたびにポイントを貯めて、特典と交換できます。会員証は LINE とスマホ（紙のカードも印刷できます）。店員はスマホで QR を読むだけです。よく来るお客様はゴールド・シルバーになり、ランクだけの特典も作れます',
    publisher: { name: 'M2Office', verified: true },
    platform_schema: '>=1 <2',
    permissions: { tools: ['members.find', 'members.points', 'members.rewards', 'members.rank', 'members.send_line'], max_risk_level: 'external-send' },
  },
  agents: MEMBER_AGENTS,
  connectors: [],
  readme: null,
  icon: '/extensions/members.png',
  dir: null,
};
