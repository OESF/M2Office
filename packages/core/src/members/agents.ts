/**
 * @file 会員とポイント（内蔵の拡張）の付属の業務と、拡張機能の一覧に並べるための形（仕様書 第40.2節・第40.7節）。
 *
 * 付属の業務「会員とポイント」は、秘書から頼まれた会員の照会・ポイントの調整・特典の作成を行う。社外には何も出さない（最上位の危険度は write-internal）。
 * お客様の情報を秘書の記憶と会社の知識に入れない（学ばない業務の印 `private`）。
 */

import { MEMBERS_EXTENSION_ID, type AgentDefinition } from '@m2office/shared';
import type { ExtensionPackage } from '../extensions/loader.js';

/** 内蔵の拡張の版。付属の業務やツールが変わったら上げる。 */
export const MEMBERS_EXTENSION_VERSION = '1.0.0';

/** 付属の業務「会員とポイント」（秘書から）。 */
export const MEMBER_DESK: AgentDefinition = {
  schemaVersion: 1,
  id: `${MEMBERS_EXTENSION_ID}:desk`,
  version: 1,
  name: '会員とポイント',
  category: 'sample',
  description: '会員の数・ポイント・来店の回数を答え（「会員は何人？」「しばらく来ていない会員は？」「田中さんのポイントは？」）、ポイントを足し（「田中さんに 5 ポイント足して」）、特典を作ります（「10 ポイントでドリンク 1 杯の特典を作って」）',
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
  tools: ['members.find', 'members.points', 'members.rewards'],
  steps: [
    {
      id: 'act',
      type: 'agent',
      tools: ['members.find', 'members.points', 'members.rewards'],
      label: '会員の台帳を扱う',
      instruction: [
        '依頼（request）に合わせて、ツールを 1 回だけ呼ぶ。',
        '「会員は何人？」は members.find（query 無し。total を答える）。「よく来た会員」は order に visits、「ポイントの多い会員」は points、「しばらく来ていない会員」は order に away と awayDays（言われなければ 60）。',
        '「〇〇さんのポイントは？」「会員番号 12 は？」は members.find の query に呼び名か番号を入れる。',
        '「〇〇さんに 5 ポイント足して」「3 ポイント引いて」は members.points（引くなら負の数）。理由（note）が言われなければ「秘書から」と入れる。',
        '特典の一覧・作る・直す・止めるは members.rewards。',
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
    ],
    notes: ['ポイントを付ける・特典を使うのは、店員がスマホの会員のページで行います', 'ポイントはお金ではありません。値引きの計算はレジで行います'],
  },
  face: 19,
};

/** 会員とポイントの付属の業務。 */
export const MEMBER_AGENTS: AgentDefinition[] = [MEMBER_DESK];

/** 会員とポイントを、拡張機能の一覧に並べるための形（第12.13節「公式・内蔵」）。 */
export const MEMBERS_PACKAGE: ExtensionPackage = {
  manifest: {
    id: MEMBERS_EXTENSION_ID,
    name: '会員とポイント',
    version: MEMBERS_EXTENSION_VERSION,
    description: 'お客様を会員にし、来店と購入のたびにポイントを貯めて、特典と交換できます。会員証は LINE とスマホ（紙のカードも印刷できます）。店員はスマホで QR を読むだけです',
    publisher: { name: 'M2Office', verified: true },
    platform_schema: '>=1 <2',
    permissions: { tools: ['members.find', 'members.points', 'members.rewards'], max_risk_level: 'write-internal' },
  },
  agents: MEMBER_AGENTS,
  connectors: [],
  readme: null,
  icon: '/extensions/members.png',
  dir: null,
};
