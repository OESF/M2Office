/**
 * @file LLM 抽象化層のインターフェース。提供者を差し替えられるよう、M2Office 独自の形を定める。
 *
 * 共通形式は OpenAI 互換を土台とし、互換で表現できない提供者のみ個別のアダプタで吸収する。
 * モデル名を直接指定せず、「高速 / 標準 / 高性能」の役割で参照する。
 * 実際のモデル名は設定値として持ち、モデルの更新にコードが追随しなくて済むようにする。
 *
 * @see 仕様書 第20.2節 LLM 抽象化層
 */

/** モデルの役割。実際のモデル名は設定で解決する。 */
export type ModelTier = 'fast' | 'standard' | 'advanced';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  tier: ModelTier;
  messages: LlmMessage[];
  /** 生成の上限。実行の上限管理に使う（仕様書 第7.2節 limits）。 */
  maxOutputTokens?: number;
}

export interface LlmResponse {
  text: string;
  /** 消費トークン。原価の記録に使う（仕様書 第22.4節）。 */
  tokensUsed: number;
}

/**
 * LLM 提供者のインターフェース。
 *
 * @remarks
 * 実装は提供者ごとのアダプタに置く。呼び出し側は提供者を知らない。
 */
export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
