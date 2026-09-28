/**
 * @file LLM 抽象化層のインターフェース。提供者を差し替えられるよう、M2Office 独自の形を定める。
 *
 * 共通形式は OpenAI 互換を土台とし、互換で表現できない提供者のみ個別のアダプタで吸収する。
 * モデル名を直接指定せず、「高速 / 標準 / 高性能」の役割で参照する。
 * 実際のモデル名は設定値として持ち、モデルの更新にコードが追随しなくて済むようにする。
 *
 * @see 仕様書 第20.2節 LLM 抽象化層
 */

import type { EvalCase } from '@m2office/shared';

/** モデルの役割。実際のモデル名は設定で解決する。 */
export type ModelTier = 'fast' | 'standard' | 'advanced';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  tier: ModelTier;
  messages: LlmMessage[];
  /** 生成の上限。実行の上限管理に使う（仕様書 第9.2節 limits）。 */
  maxOutputTokens?: number;
  /**
   * どの業務エージェントのどのステップか。**提供者へは送らない。**
   * 開発用のスタブが見本の応答を探すために使う（仕様書 第12.9.4節）。
   */
  context?: {
    agentId: string;
    stepId: string;
    input: Record<string, unknown>;
    /** 業務エージェントの評価のケース。スタブが見本の応答を再生するのに使う（仕様書 第12.9.4節）。 */
    evals?: EvalCase[];
    /** 終わったステップのツールの結果（ステップ ID → 文字列）。見本の応答の `{{ステップ ID}}` に差し込む。 */
    stepResults?: Record<string, string>;
  };
}

export interface LlmResponse {
  text: string;
  /** 消費トークン（入力＋出力）。実行の合計として記録する。 */
  tokensUsed: number;
  /**
   * 入力のトークン数。分かるときだけ入れる。
   *
   * @remarks 入力と出力は単価が違う（出力は 5〜10 倍）。費用の計算に要る（仕様書 第21.4節）。
   */
  inputTokens?: number;
  /** 出力のトークン数。分かるときだけ入れる。 */
  outputTokens?: number;
  /** 実際に使ったモデル名。費用の単価を引くのに使う。分からなければ入れない。 */
  model?: string;
}

/**
 * LLM 提供者のインターフェース。
 *
 * @remarks
 * 実装は提供者ごとのアダプタに置く。呼び出し側は提供者を知らない。
 */
/**
 * 画像や PDF から文字を読み取る依頼（OCR。仕様書 第9.4.1節、Q-56）。
 *
 * @remarks PDF は、文字を取り出せなかったページだけを抜き出したものを渡す。
 */
export interface LlmImageRequest {
  bytes: Uint8Array;
  /** `image/png`・`application/pdf` などの種類。 */
  mimeType: string;
}

/**
 * 画像から、決まった形（JSON）で項目を取り出す依頼（名刺の読み取り。仕様書 第27.5節）。
 *
 * @remarks OCR（{@link LlmImageRequest}）と違い、文字をまとめて書き出させずに項目ごとに分けて返させる
 */
export interface LlmExtractRequest {
  bytes: Uint8Array;
  /** `image/png`・`image/jpeg`・`image/heic`・`image/webp`・`application/pdf` など。 */
  mimeType: string;
  /** 何をどの形で取り出すかの指示。返す JSON の形もここに書く。 */
  prompt: string;
  /** 出力の上限。 */
  maxOutputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /**
   * 画像や PDF から文字を読み取る（OCR。仕様書 第9.4.1節、Q-56、ADR-0017）。
   *
   * @remarks
   * 読み取りは推論であり、確かなものとして扱わない。持たない提供者（見本など）では未定義にし、
   * 呼び出し側は「読み取れなかった」として扱う。
   */
  readImage?(req: LlmImageRequest): Promise<LlmResponse>;
  /**
   * 画像から、指示の形の JSON で項目を取り出す（名刺の読み取り。仕様書 第27.5節）。
   *
   * @remarks 持たない提供者では未定義にし、呼び出し側は「読み取る準備ができていない」として扱う。返す文は JSON（解釈は呼び出し側）
   */
  extractFromImage?(req: LlmExtractRequest): Promise<LlmResponse>;
}
