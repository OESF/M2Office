/**
 * @file 推論（Gemini）が設定されていない会社の「推論」。呼ばれたら、設定されていないことを伝える例外を投げる。
 *
 * M2Office は推論があって初めて成り立つ。推論が使えない会社では、秘書も業務も動かさない（仕様書 第20.2.4節、ADR-0030）。
 * 見本の応答（スタブ）で動いたように見せない。スタブは自動テストの中だけで使う。
 */

import type { LlmProvider, LlmResponse } from './provider.js';
import type { ResearchProvider, ResearchResult } from '../research/provider.js';

/** 推論が使えないときに、利用者へ伝える文（仕様書 第20.2.4節）。 */
export const AI_NOT_CONFIGURED_MESSAGE = 'Gemini の接続が設定されていません。管理者ページの「接続」で設定してください';

/** 推論が設定されていない。呼び出し側は、この文をそのまま利用者に伝える。 */
export class AiNotConfiguredError extends Error {
  constructor() {
    super(AI_NOT_CONFIGURED_MESSAGE);
    this.name = 'AiNotConfiguredError';
  }
}

/**
 * 推論が設定されていない会社の推論。呼ぶと {@link AiNotConfiguredError} を投げる。
 *
 * @remarks 呼び出し側は `name === 'unconfigured'` で先に見分け、推論を呼ばずに断ってよい
 */
export class UnconfiguredLlmProvider implements LlmProvider {
  readonly name = 'unconfigured';

  async complete(): Promise<LlmResponse> {
    throw new AiNotConfiguredError();
  }
}

/** 推論が設定されていない会社の Web の調べもの。呼ぶと {@link AiNotConfiguredError} を投げる。 */
export class UnconfiguredResearchProvider implements ResearchProvider {
  readonly name = 'unconfigured';

  async research(): Promise<ResearchResult> {
    throw new AiNotConfiguredError();
  }
}

/** 推論が使えるか（設定されていない会社の推論でないか）。 */
export const aiAvailable = (llm: Pick<LlmProvider, 'name'>): boolean => llm.name !== 'unconfigured';
