/**
 * エージェント定義のスキーマ（`schema_version: 1`）。
 *
 * 仕様書 第7.2節に対応する。定義は宣言的であり、任意のコードを含まない。
 * 条件分岐と繰り返しは持たず、制御は `onEmpty` / `onError` / `onReject` の
 * 3 つの宣言だけで表す（第7.2.1節）。
 *
 * @see 仕様書 第7.2節 エージェント定義のスキーマ
 */

/** ツールの危険度。承認の要否を決める（仕様書 第7.4節）。 */
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
  /** 推論に与える指示。Markdown で記述する。 */
  instruction: string;
  /** 結果が空だった場合の扱い。既定は `continue`。 */
  onEmpty?: 'continue' | 'stop';
  /** 失敗した場合の扱い。既定は `stop`。 */
  onError?: 'stop' | 'continue';
}

/** `approval` ステップ。人の承認を待って中断する。 */
export interface ApprovalStep {
  id: string;
  type: 'approval';
  /** 承認できるロール。 */
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

/** 品質検証用のテストケース（仕様書 第20.2節）。 */
export interface EvalCase {
  name: string;
  input: Record<string, unknown>;
  expect: string;
}

/**
 * エージェント定義の本体。
 *
 * @remarks
 * 定義から指定できないものがある（仕様書 第7.2.2節）。
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
}
