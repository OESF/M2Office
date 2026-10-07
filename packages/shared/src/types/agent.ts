/**
 * @file エージェント定義のスキーマ（`schema_version: 1`）と、危険度の定数。
 *
 * 定義は宣言的であり、任意のコードを含まない。条件分岐と繰り返しは持たず、
 * 制御は `onEmpty` / `onError` / `onReject` の 3 つの宣言だけで表す。
 *
 * @see 仕様書 第9.2節 エージェント定義のスキーマ
 */

import { ANNOUNCEMENTS_EXTENSION_ID } from './announcements.js';
import { CARDS_EXTENSION_ID } from './cards.js';
import { COMPETITORS_EXTENSION_ID } from './competitors.js';
import { CONTRACTS_EXTENSION_ID } from './contracts.js';
import { HR_EXTENSION_ID } from './hr.js';
import { INQUIRIES_EXTENSION_ID } from './inquiries.js';
import { INVENTORY_EXTENSION_ID } from './inventory.js';
import { MEMBERS_EXTENSION_ID } from './members.js';
import { PRINT_DESIGNS_EXTENSION_ID } from './print-designs.js';
import { RESERVATIONS_EXTENSION_ID } from './reservations.js';
import { SIGNAGE_EXTENSION_ID } from './signage.js';
import { SUBSIDIES_EXTENSION_ID } from './subsidies.js';
import { WEB_COLUMNS_EXTENSION_ID } from './web-columns.js';
import { WEB_REVIEW_EXTENSION_ID } from './web-review.js';

/** ツールの危険度。承認の要否を決める（仕様書 第9.4節）。 */
export const RISK_LEVELS = [
  'read',
  'draft',
  'write-internal',
  'external-send',
  'financial',
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * 危険度の強さ。大きいほど制限が強い。
 *
 * @remarks
 * `external-send` 以上は、テナント設定によっても承認を省略できない。
 */
export const RISK_ORDER: Record<RiskLevel, number> = {
  read: 0,
  draft: 1,
  'write-internal': 2,
  'external-send': 3,
  financial: 4,
};

/** 承認が必ず必要な危険度かどうかを判定する。 */
export function alwaysRequiresApproval(risk: RiskLevel): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER['external-send'];
}

/** `agent` ステップ。推論で処理を進める。 */
export interface AgentStep {
  id: string;
  type: 'agent';
  /** 画面に出す短い名前（例: 取得）。省略時はステップ ID（仕様書 第9.2.4節）。 */
  label?: string;
  /** 推論に与える指示。Markdown で記述する。 */
  instruction: string;
  /**
   * この段で使えるツール（仕様書 第9.2.7節）。定義の `tools` の一部。省略時は定義の `tools` のすべて。
   *
   * @remarks **段の区切りを推論の行儀に頼らないため**に宣言する。宣言した段では、それ以外を呼ばせない。
   */
  tools?: string[];
  /**
   * この段で必ず呼ぶツール（仕様書 第9.2.7節）。呼ばずに終えようとしたら、エンジンが一度だけ呼ぶよう促す。
   *
   * @remarks 推論が呼び忘れると業務の目的が欠けるツールに付ける（議事録の知識への登録など）。`tools` の中から選ぶ
   */
  required?: string[];
  /** 結果が空だった場合の扱い。既定は `continue`。 */
  onEmpty?: 'continue' | 'stop';
  /** 失敗した場合の扱い。既定は `stop`。 */
  onError?: 'stop' | 'continue';
}

/** `approval` ステップ。人の承認を待って中断する。 */
export interface ApprovalStep {
  id: string;
  type: 'approval';
  /** 画面に出す短い名前。省略時は「承認」（仕様書 第9.2.4節）。 */
  label?: string;
  /**
   * 誰が判断するか。既定は `role`（仕様書 第9.2.3節）。
   * `requester` では実行を依頼した本人だけが判断でき、`approverRole` は使わない。
   */
  approver?: 'role' | 'requester';
  /** 承認できるロール。`approver` が `role` のときに使う。 */
  approverRole: string[];
  /** 承認画面に提示する内容の説明。 */
  present: string;
  /** 却下された場合の扱い。既定は `stop`。 */
  onReject?: 'stop' | { restartFrom: string };
  /**
   * 会社の設定が入なら、本人（`requester`）が承認したあとに、同じ段で管理者の承認を加える（仕様書 第9.2.3節）。
   *
   * @remarks 公式・内蔵の業務だけが使う。条件で段を分ける仕組みではない（段の並びは変わらない）
   */
  adminAlsoWhen?: AdminApprovalSetting;
}

/** 管理者の承認を加えるかを決める会社の設定（{@link ApprovalStep.adminAlsoWhen}）。 */
export type AdminApprovalSetting = 'cards.bulkMailAdminApproval';

export type Step = AgentStep | ApprovalStep;

/** 実行上の上限。いずれかに達したら実行を打ち切る。 */
export interface Limits {
  maxSteps: number;
  maxTokens: number;
  timeoutSec: number;
}

/**
 * 利用者向けのヘルプの補足（仕様書 第9.2.5節）。
 *
 * @remarks
 * 業務のヘルプの大部分は定義の他の項目から自動で作る（第6.10.5節）。
 * ここには定義から読み取れないことだけを書く。
 */
export interface AgentHelp {
  /** 1〜2 文の概要。業務のカードに出す。 */
  summary: string;
  /** 実行例。押すと入力欄に入る。 */
  examples?: { title: string; input: Record<string, unknown> }[];
  /** 注意点。止まる条件や、できないこと。 */
  notes?: string[];
  faq?: { q: string; a: string }[];
  /**
   * 書き手が書いた利用者向けの説明（Markdown。スキルの `HELP.md`。仕様書 第12.12.4節）。
   *
   * @remarks あれば業務の説明の本文にし、ツールの説明から作る「この業務がすること」と「進み方」は出さない
   */
  body?: string;
}

/** 品質検証用のテストケース（仕様書 第18.2節）。 */
export interface EvalCase {
  name: string;
  input: Record<string, unknown>;
  expect: string;
  /**
   * 見本の応答。ステップ ID ごとの、ツールの呼び出し（仕様書 第12.9.4節）。
   *
   * @remarks
   * LLM の鍵が無い開発環境で、スタブが入力の一致したケースの見本を再生する。
   * 本物の LLM は使わない。定義の一部ではなく、開発と試験のためのもの。
   */
  stub?: Record<string, { name: string; args: Record<string, unknown> }[]>;
  /**
   * 決まった規則での採点（本物の推論に通したときに使う。仕様書 第28.15節「評価を自動で回す」）。
   *
   * @remarks `mention` は「どれか 1 つが答えに出ること」の組の並び。`avoid` は答えに出てはならない言い回し
   */
  checks?: { mention?: string[][]; avoid?: string[] };
}

/**
 * 同梱している業務エージェントの絵の数（仕様書 第6.7.4.3節）。
 *
 * @remarks
 * `packages/web/public/agents/agent01.png`〜`agent50.png` に対応する（第 0.140.1 版で 25 から 50 に増やした）。
 * **ここを増やすときは、画像を先に置くこと。** 番号だけ増やすと、絵の出ない業務ができる。
 */
export const AGENT_FACE_COUNT = 50;

/**
 * エージェント定義の本体。
 *
 * @remarks
 * 定義から指定できないものがある（仕様書 第9.2.2節）。
 * モデル階層・ツールの危険度・承認ゲートの省略は基盤側が決め、
 * 定義から上書きできない。
 */
export interface AgentDefinition {
  schemaVersion: 1;
  id: string;
  version: number;
  name: string;
  category: string;
  description: string;
  locale: string;
  /** 権限区画。区画外は `null`（仕様書 第16.3.6節）。 */
  compartment: string | null;
  /**
   * 秘書が取次の候補にしてよいか（仕様書 第10.9.4.1節）。既定は `true`。
   *
   * @remarks
   * `false` にすると、秘書はこの業務を提案しない。メニューからは使える。
   * **秘書が自分で答えられることには使う。** ひと言の照会に本人の確認を求めると、会話にならない。
   */
  secretaryRoute?: boolean;
  /**
   * 外部の AI を使ってよい業務（仕様書 第16.3.7.1節、ADR-0059）。会社の AI の方針が「ローカルを既定」のときだけ意味を持つ。
   *
   * @remarks 会社のデータを読むツールとファイルの欄を持たない業務だけに効く。満たさなければ印は無視してローカル AI で動かす。
   * スキルでは `metadata.m2office-external-ai: true`
   */
  externalAi?: boolean;
  /**
   * メニューに出すか（仕様書 第12.12.2節）。既定は `true`。スキルの `user-invocable: false` で `false` になる。
   *
   * @remarks `false` の業務は、秘書が取り次いだときだけ使う
   */
  menu?: boolean;
  /**
   * 学ばない業務（仕様書 第12.12.3節 `m2office-private`）。契約書など機密の中身を扱う業務に付ける。
   *
   * @remarks `true` の業務の結果からは、秘書が学ばず（第10.13節）、秘書の答えに結果の要点を添えない（第10.7.3節）
   */
  private?: boolean;
  /** 段の推論の強さ（仕様書 第20.2.2節）。既定は `standard`。スキルの `effort` から決まる。 */
  tier?: 'fast' | 'standard' | 'advanced';
  /**
   * スキルの形式（SKILL.md）から組み立てた業務の、実行のときに使うもの（仕様書 第12.12節）。
   *
   * @remarks
   * `arguments` は指示の `$名前`・`$N` を入力で置き換えるための欄の名前の並び。
   * `files` は本文から参照する補助のファイル（読むだけのツール `skill.read` で開く）
   */
  skill?: { arguments: string[]; files: { path: string; text: string }[] };
  /** 入力フォームを自動生成するための JSON Schema。 */
  inputs: Record<string, unknown>;
  /** 呼び出しを許可するツール。ここにないものは呼べない。 */
  tools: string[];
  /** 参照する知識のまとまり。 */
  knowledge?: { collections: string[] };
  steps: Step[];
  /** 常時プロンプトへ注入される禁止事項。 */
  constraints: string[];
  limits: Limits;
  evals?: EvalCase[];
  /** 利用者向けのヘルプの補足。拡張機能では必須（仕様書 第9.2.5節）。 */
  help?: AgentHelp;
  /**
   * ダッシュボードに出す絵の番号（1〜{@link AGENT_FACE_COUNT}。仕様書 第6.7.4.3節）。
   *
   * @remarks
   * **業務を 1 つ足すたびに、まだ使っていない番号を 1 つ割り当てる。**
   * 省いたときは ID から機械的に決めるため、絵は必ず出るが、
   * 他の業務と重なることがある。公式のカタログでは必ず書く。
   */
  face?: number;
}

/**
 * 業務の入力のうち、ファイルを受け取る欄の名前（仕様書 第10.10.3節）。無ければ `null`。
 *
 * @remarks
 * 公式の業務は `fileId`、スキルの業務は `m2office-inputs` で型を `file` にした欄（名前は「契約書」など）。
 * 秘書に渡したファイルは、この欄に入れる
 */
export function fileInputKey(def: Pick<AgentDefinition, 'inputs'>): string | null {
  const props = ((def.inputs as { properties?: Record<string, { format?: string }> }).properties) ?? {};
  if ('fileId' in props) return 'fileId';
  return Object.entries(props).find(([, p]) => p?.format === 'file')?.[0] ?? null;
}

/** 秘書に一度に渡せるファイルの数（仕様書 第10.10.2節・第10.10.7節）。 */
export const SECRETARY_FILES_MAX = 5;

/**
 * 業務の入力のうち、2 つ目のファイルの欄の名前（契約書チェックの「前の版」など。仕様書 第28.13節）。無ければ `null`。
 *
 * @remarks
 * 秘書に渡したファイルは 1 つ目の欄（{@link fileInputKey}）に入る。2 つ目の欄は、本人が「前の版と比べて」と頼んだときに、
 * 同じ業務に前に渡したファイルで秘書が埋める
 */
export function secondFileInputKey(def: Pick<AgentDefinition, 'inputs'>): string | null {
  const first = fileInputKey(def);
  const props = ((def.inputs as { properties?: Record<string, { format?: string }> }).properties) ?? {};
  return Object.entries(props).find(([k, p]) => k !== first && p?.format === 'file')?.[0] ?? null;
}


/**
 * ダッシュボードの「業務の状態」で、公式の業務をまとめる分野の名前（仕様書 第6.7.4.2.1節、ADR-0061）。
 *
 * @remarks
 * 鍵はエージェント定義の `category`。ここに無い分野の公式の業務は、業務 1 つの囲みで出す。
 * 拡張機能の業務は分野ではなく、その拡張機能でまとめる
 */
export const AGENT_GROUP_LABELS: Readonly<Record<string, string>> = {
  mail: 'メール',
  calendar: '予定',
  meeting: '会議',
  briefing: 'ブリーフ',
  document: '資料',
  knowledge: '知識と調べもの',
};

/** ダッシュボードの「業務の状態」の 1 つの囲みにまとめる分野（仕様書 第6.7.4.2.1節、ADR-0075）。 */
export interface AgentArea {
  id: string;
  name: string;
  /** 公式の業務の分野（エージェント定義の `category`） */
  categories: readonly string[];
  /** 拡張機能の ID（内蔵の拡張と公式の拡張機能） */
  extensions: readonly string[];
}

/**
 * ダッシュボードで業務をまとめる分野（運営が持つ。第 0.292.0 版）。
 *
 * @remarks
 * オーナーが「いま何が行われているか」を一瞥でつかむための区切り。1 つの囲みに業務を詰め込みすぎない（目安は 6 業務まで）。
 * ここに無い拡張機能（取り込んだスキルなど）の業務は、名前と説明から「調べもの」「資料の作成」に入れ（{@link agentAreaOf}）、
 * どちらでもなければ、これまでどおりその拡張機能の囲み（ADR-0061）
 */
export const AGENT_AREAS: readonly AgentArea[] = [
  { id: 'mail', name: 'メール', categories: ['mail'], extensions: [] },
  { id: 'schedule', name: '予定と会議', categories: ['calendar', 'meeting'], extensions: [] },
  { id: 'briefing', name: 'ブリーフ', categories: ['briefing'], extensions: [] },
  { id: 'documents', name: '資料の作成', categories: ['document'], extensions: [] },
  { id: 'research', name: '調べもの', categories: ['knowledge'], extensions: [] },
  { id: 'cards', name: '名刺管理', categories: [], extensions: [CARDS_EXTENSION_ID] },
  { id: 'customers', name: '問い合わせと会員', categories: [], extensions: [INQUIRIES_EXTENSION_ID, MEMBERS_EXTENSION_ID] },
  { id: 'columns', name: 'コラムの作成', categories: [], extensions: [WEB_COLUMNS_EXTENSION_ID] },
  { id: 'promotion', name: 'お知らせと販促', categories: [], extensions: [ANNOUNCEMENTS_EXTENSION_ID, PRINT_DESIGNS_EXTENSION_ID, SIGNAGE_EXTENSION_ID] },
  { id: 'market', name: 'Webと競合の分析', categories: [], extensions: [WEB_REVIEW_EXTENSION_ID, COMPETITORS_EXTENSION_ID] },
  {
    id: 'admin', name: '契約と総務', categories: [],
    // 契約書チェックは公式の拡張機能（jp.m2office.legal.contract-review）
    extensions: [CONTRACTS_EXTENSION_ID, 'jp.m2office.legal.contract-review', RESERVATIONS_EXTENSION_ID, SUBSIDIES_EXTENSION_ID],
  },
  { id: 'inventory', name: '在庫管理', categories: [], extensions: [INVENTORY_EXTENSION_ID] },
  { id: 'hr', name: '人事・給与', categories: [], extensions: [HR_EXTENSION_ID] },
];

/** 調べものの業務とみなす言葉（取り込んだスキルの名前と説明から）。 */
const RESEARCH_WORDS = /調べ|調査|リサーチ|尋ね|質問し|論文|文献|検索/;
/** 資料の作成の業務とみなす言葉（名前から）。 */
const DOCUMENT_WORDS = /資料|スライド|文書|表の作成|報告書/;

/**
 * 業務の分野を返す（純粋な関数）。
 *
 * @param extensionId 業務が入っている拡張機能の ID（公式の業務なら `null`）
 * @param def 業務の名前と説明（分野の決まっていない拡張機能の業務を、言葉から「調べもの」「資料の作成」に入れる）
 * @returns 分野の ID（`area:<id>`）と名前。どの分野にも入らなければ `null`
 */
export function agentAreaOf(category: string, extensionId: string | null, def?: { name: string; description: string }): { id: string; name: string } | null {
  const view = (id: string) => { const a = AGENT_AREAS.find((x) => x.id === id)!; return { id: `area:${a.id}`, name: a.name }; };
  const a = AGENT_AREAS.find((x) => (extensionId ? x.extensions.includes(extensionId) : x.categories.includes(category)));
  if (a) return view(a.id);
  if (!extensionId || !def) return null;
  // 名前を先に見る（「スライドの作成」は Web で調べても資料の作成）。名前で決まらなければ説明を見る
  if (RESEARCH_WORDS.test(def.name)) return view('research');
  if (DOCUMENT_WORDS.test(def.name)) return view('documents');
  if (RESEARCH_WORDS.test(def.description)) return view('research');
  return null;
}
