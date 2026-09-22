/**
 * @file OpenAI 互換のエンドポイントを使う LLM アダプタ。既定は Gemini の互換エンドポイント。
 *
 * @see 仕様書 第20.2節 LLM 抽象化層
 */

import type { LlmProvider, LlmRequest, LlmResponse, ModelTier } from './provider.js';

/** 役割ごとのモデル名。設定で差し替えられる（仕様書 第21.2節）。 */
export interface GeminiModelMap {
  fast: string;
  standard: string;
  advanced: string;
}

/**
 * Gemini の OpenAI 互換エンドポイントを用いるアダプタ。
 *
 * @param apiKey Gemini の API 鍵
 * @param models 役割から実モデル名への対応
 * @param baseUrl 互換エンドポイントの基点
 *
 * @remarks
 * 共通形式を OpenAI 互換としたため、この実装は他の互換提供者にも流用できる。
 * ただしツール呼び出し・構造化出力・ストリーミングの対応範囲は
 * 提供者ごとに差があるため、利用前に確認すること（仕様書 第21.2.1節）。
 *
 * @see 仕様書 第21.2節 LLM 抽象化層
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly models: GeminiModelMap,
    private readonly baseUrl: string,
    name = 'gemini',
  ) {
    this.name = name;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.resolveModel(req.tier),
        messages: req.messages,
        max_tokens: req.maxOutputTokens,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new LlmRequestError(`LLM 呼び出しに失敗しました (${res.status})`, body);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      tokensUsed: json.usage?.total_tokens ?? 0,
    };
  }

  private resolveModel(tier: ModelTier): string {
    return this.models[tier];
  }
}

/** LLM の呼び出しに失敗したことを表す。 */
export class LlmRequestError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = 'LlmRequestError';
  }
}
