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
  /** 使うモデルの区分。既定は標準。向きのように標準のモデルが取り違えるものは高性能にする（名刺。第27.5節）。 */
  tier?: ModelTier;
}

/** 埋め込みの次元（仕様書 第11.7.6.1節、Q-81）。保存の列（`vector(768)`）と同じにする。 */
export const EMBEDDING_DIMENSIONS = 768;

/** 埋め込みの依頼（{@link LlmProvider.embed}。仕様書 第11.7.6.1節）。 */
export interface LlmEmbedRequest {
  /**
   * 埋め込む文。`document` は知識の節（`title` に見出しの経路）、`query` は質問。
   * 節と質問で書き方を変える（非対称の検索）。書き方は提供者が決める
   */
  items: { title?: string; text: string }[];
  kind: 'document' | 'query';
}

/** 埋め込みの結果。 */
export interface LlmEmbedResponse {
  /** 依頼の順の、{@link EMBEDDING_DIMENSIONS} 次元の並び。 */
  vectors: number[][];
  /** 作ったモデル（`gemini:gemini-embedding-2` のように提供者を前に付ける。違うモデルの埋め込みどうしを比べないため）。 */
  model: string;
  /** 入力のトークン数（分からなければ文字数で多めに見積もる）。費用に数える。 */
  inputTokens: number;
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
  /**
   * 画像を作る（Web のコラムのカバーの挿絵。仕様書 第32.18.2節）。
   *
   * @remarks 持たない提供者（見本・ローカル AI）では未定義にし、呼び出し側は「描けない」として型にする。
   * 作った画像は社外に出る前に、呼び出し側が確かめる
   */
  generateImage?(req: LlmImageGenerateRequest): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /**
   * 動画を作る（コラムの店頭サイネージ用の動画。仕様書 第32.18.6節）。数分かかる。
   *
   * @remarks 持たない提供者（見本・ローカル AI）では未定義にし、呼び出し側は「作れない」と伝える。
   * 安全の判定で止められたなど、動画が返らなければ `null`。延長できなければ最初の動画だけを返す（`extended: false`）
   */
  generateVideo?(req: LlmVideoRequest): Promise<{ bytes: Uint8Array; mimeType: 'video/mp4'; extended: boolean } | null>;
  /**
   * 文を埋め込む（知識の意味の検索。仕様書 第11.7.6.1節）。
   *
   * @remarks 持たない提供者では未定義にし、呼び出し側は言葉の検索（段階 2）だけで答える
   */
  embed?(req: LlmEmbedRequest): Promise<LlmEmbedResponse>;
}

/** 動画を作る依頼（{@link LlmProvider.generateVideo}）。 */
export interface LlmVideoRequest {
  /** 使うモデル（例: `veo-3.1-lite-generate-preview`）。 */
  model: string;
  /** 最初の 8 秒の指示（英語）。 */
  prompt: string;
  /** 始まりの絵。無ければ指示だけから作る。 */
  image?: { bytes: Uint8Array; mimeType: string };
  aspectRatio: '16:9' | '9:16';
  /** 延長（7 秒）の指示（英語）。あれば最初の動画を延長する。 */
  extendPrompt?: string;
}

/** 画像を作る依頼（{@link LlmProvider.generateImage}）。 */
export interface LlmImageGenerateRequest {
  /** 何を描くかの指示。 */
  prompt: string;
  /** 縦横の比（例: `16:9`）。 */
  aspectRatio: string;
  /** 使うモデル（例: `gemini-nano-banana-2.1`。既定は `imageModel()`）。 */
  model: string;
}
