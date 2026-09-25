/**
 * @file エージェント定義のスキーマ（`schema_version: 1`）と、危険度の定数。
 *
 * 定義は宣言的であり、任意のコードを含まない。条件分岐と繰り返しは持たず、
 * 制御は `onEmpty` / `onError` / `onReject` の 3 つの宣言だけで表す。
 *
 * @see 仕様書 第9.2節 エージェント定義のスキーマ
 */

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
   * この段で使える道具（仕様書 第9.2.7節）。定義の `tools` の一部。省略時は定義の `tools` のすべて。
   *
   * @remarks **段の区切りを推論の行儀に頼らないため**に宣言する。宣言した段では、それ以外を呼ばせない。
   */
  tools?: string[];
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
}

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
}

/**
 * 同梱している業務エージェントの絵の数（仕様書 第6.7.4.3節）。
 *
 * @remarks
 * `packages/web/public/agents/agent01.png`〜`agent25.png` に対応する。
 * **ここを増やすときは、画像を先に置くこと。** 番号だけ増やすと、絵の出ない業務ができる。
 */
export const AGENT_FACE_COUNT = 25;

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
