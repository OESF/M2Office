/**
 * @file 会社ごとの Gemini の選択。会社が自社の鍵（BYOK）を登録していればそれを、無ければ運営の設定を使う。
 *
 * 業務の推論・秘書・Web の調査・音声が、会社ごとにどの鍵とモデルを使うかをここで決める。
 * 鍵は復号してこの中だけで使い、ほかへ渡さない（推論にも渡さない）。
 *
 * @see 仕様書 第14.3.3節「Gemini」
 * @see 仕様書 第21.3節 顧客の自社契約（BYOK）
 */

import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { OpenAiCompatibleProvider } from '../llm/gemini.js';
import { GeminiResearchProvider, type ResearchProvider } from '../research/provider.js';
import type { SecretBox } from './box.js';
import type { VoiceProvider } from '../voice/provider.js';
import { GeminiLiveProvider } from '../voice/gemini-live.js';
import { MockVoiceProvider } from '../voice/mock.js';
import { MockResearchProvider } from '../research/provider.js';
import { StubLlmProvider } from '../llm/stub.js';
import { AiNotConfiguredError, UnconfiguredLlmProvider, UnconfiguredResearchProvider } from '../llm/unconfigured.js';
import { defaultGeminiModels } from '../llm/models.js';
import type { EvalCase } from '@m2office/shared';

/** 役割ごとのモデル名。 */
export interface GeminiModels {
  fast: string;
  standard: string;
  advanced: string;
  research: string;
  live: string;
}

/** 会社の Gemini の設定（`tenant_credentials.meta`）。 */
export interface GeminiSettingsMeta {
  mode?: 'platform' | 'byok';
  models?: Partial<GeminiModels>;
}

/** 会社が使う Gemini。`source` は鍵の出どころ。 */
export interface ResolvedGemini {
  source: 'tenant' | 'platform' | 'none';
  apiKey: string | null;
  models: GeminiModels;
}

export interface TenantAiResolverDeps {
  repo: Repository;
  box: SecretBox;
  /** 会社の鍵が無いときの推論（運営の鍵か、設定されていないことを伝えるもの。自動テストではスタブ）。 */
  fallbackLlm: LlmProvider;
  fallbackResearch: ResearchProvider;
  /** 運営の鍵。無ければ `null`。 */
  platformKey: string | null;
  /** 既定のモデル。 */
  defaults: GeminiModels;
  /** OpenAI 互換の窓口。 */
  baseUrl: string;
  /** 自動テストか（`LLM_PROVIDER=stub`）。見本の音声を使ってよいのはこのときだけ（仕様書 第20.2.4節）。 */
  testMode?: boolean;
}

/**
 * 運営の設定（環境変数）から、会社の鍵が無いときに使う推論と調べものを決める（仕様書 第20.2.4節、ADR-0030）。
 *
 * @param evalsFor 自動テストの見本の応答（評価のケース）を引く。スタブのときだけ使う
 * @returns 運営の鍵があれば Gemini、`LLM_PROVIDER=stub` なら自動テスト用のスタブ、どちらでもなければ「設定されていない」
 */
export function platformAi(
  env: Record<string, string | undefined>,
  evalsFor?: (agentId: string) => EvalCase[] | undefined,
): { llm: LlmProvider; research: ResearchProvider; platformKey: string | null; testMode: boolean; baseUrl: string } {
  const baseUrl = env['GEMINI_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta/openai';
  if ((env['LLM_PROVIDER'] ?? 'gemini') === 'stub') {
    return { llm: new StubLlmProvider(evalsFor), research: new MockResearchProvider(), platformKey: null, testMode: true, baseUrl };
  }
  const key = env['GEMINI_API_KEY'] ?? '';
  if (key) {
    const models = defaultGeminiModels();
    return {
      llm: new OpenAiCompatibleProvider(key, models, baseUrl), research: new GeminiResearchProvider(key, models.research),
      platformKey: key, testMode: false, baseUrl,
    };
  }
  return { llm: new UnconfiguredLlmProvider(), research: new UnconfiguredResearchProvider(), platformKey: null, testMode: false, baseUrl };
}

export class TenantAiResolver {
  private readonly cache = new Map<string, { stamp: string; llm: LlmProvider; research: ResearchProvider }>();

  constructor(private readonly deps: TenantAiResolverDeps) {}

  /** 既定のモデル（会社が指定しないときに使う）。 */
  defaults(): GeminiModels {
    return { ...this.deps.defaults };
  }

  /** 運営の鍵があるか（「運営一括」を選んだときに推論できるか）。 */
  hasPlatformKey(): boolean {
    return !!this.deps.platformKey;
  }

  /** 会社が使う Gemini の鍵とモデル。 */
  async geminiFor(tenantId: string): Promise<ResolvedGemini> {
    const cred = await this.deps.repo.getTenantCredential(tenantId, 'gemini');
    const meta = (cred?.meta ?? {}) as GeminiSettingsMeta;
    const models = { ...this.deps.defaults, ...dropEmpty(meta.models ?? {}) };
    if (meta.mode === 'byok' && cred?.secretEnc) {
      return { source: 'tenant', apiKey: this.deps.box.decrypt(cred.secretEnc), models };
    }
    return { source: this.deps.platformKey ? 'platform' : 'none', apiKey: this.deps.platformKey, models };
  }

  /** 会社の推論。会社の鍵があればその鍵、無ければ既定。 */
  async llmFor(tenantId: string): Promise<LlmProvider> {
    return (await this.entry(tenantId))?.llm ?? this.deps.fallbackLlm;
  }

  /**
   * 会社の音声の対話（仕様書 第10.5節、ADR-0018）。
   *
   * @remarks 鍵があれば Gemini Live。無ければ始めない（仕様書 第20.2.4節）。見本の実装は自動テストのときだけ
   * @throws {AiNotConfiguredError} 鍵が無いとき（自動テストを除く）
   */
  async voiceFor(tenantId: string): Promise<VoiceProvider> {
    const g = await this.geminiFor(tenantId);
    if (!g.apiKey) {
      if (this.deps.testMode) return new MockVoiceProvider();
      throw new AiNotConfiguredError();
    }
    return new GeminiLiveProvider({ apiKey: g.apiKey, model: g.models.live });
  }

  /** 会社の Web の調査。 */
  async researchFor(tenantId: string): Promise<ResearchProvider> {
    return (await this.entry(tenantId))?.research ?? this.deps.fallbackResearch;
  }

  /** 会社の鍵のときだけ、会社用の提供者を作る（設定の更新日時が変わるまで使い回す）。 */
  private async entry(tenantId: string) {
    const cred = await this.deps.repo.getTenantCredential(tenantId, 'gemini');
    const meta = (cred?.meta ?? {}) as GeminiSettingsMeta;
    if (!cred || meta.mode !== 'byok' || !cred.secretEnc) return null;
    const stamp = `${cred.updatedAt}`;
    const hit = this.cache.get(tenantId);
    if (hit && hit.stamp === stamp) return hit;
    const key = this.deps.box.decrypt(cred.secretEnc);
    const models = { ...this.deps.defaults, ...dropEmpty(meta.models ?? {}) };
    const next = {
      stamp,
      llm: new OpenAiCompatibleProvider(key, { fast: models.fast, standard: models.standard, advanced: models.advanced }, this.deps.baseUrl),
      research: new GeminiResearchProvider(key, models.research),
    };
    this.cache.set(tenantId, next);
    return next;
  }
}

function dropEmpty(o: Partial<GeminiModels>): Partial<GeminiModels> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) as Partial<GeminiModels>;
}
