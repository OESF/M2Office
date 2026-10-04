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
import type { Logger } from '../log/logger.js';
import type { AgentDefinition, AiPolicyMode, EvalCase } from '@m2office/shared';
import { LocalLlmProvider, type LocalLlmConfig } from '../llm/local.js';
import {
  AiPolicyBlockedError, LOCAL_AI_NOT_CONFIGURED, PolicyBlockedLlmProvider, PolicyBlockedResearchProvider, effectiveAiPolicy, externalAiAllowed,
  isLocalPolicy, type AiKind, type Deployment,
} from '../llm/policy.js';
import type { ToolRegistry } from '../tools/registry.js';

/** 役割ごとのモデル名。 */
export interface GeminiModels {
  fast: string;
  standard: string;
  advanced: string;
  research: string;
  live: string;
  /** 失敗したときに最初に試す退避先（仕様書 第20.2.5節）。空なら、ほかの役割のモデルだけに退避する。 */
  fallback?: string;
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
  /** 配備の形（仕様書 第8.6節）。既定はクラウド。 */
  deployment?: Deployment;
  /** ローカル AI（ローカル LLM）の口。ローカルの形で、ローカルの方針の会社が使う（第16.3.7.1節）。無ければ `null`。 */
  local?: LocalLlmConfig | null;
  /** ローカル AI の代わり（自動テスト用）。与えれば `local` より優先する。 */
  localLlm?: LlmProvider;
  /** 別のモデルへ退避したことを残すロガー（仕様書 第20.2.5節）。 */
  logger?: Pick<Logger, 'warn'>;
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
  logger?: Pick<Logger, 'warn'>,
): { llm: LlmProvider; research: ResearchProvider; platformKey: string | null; testMode: boolean; baseUrl: string } {
  const baseUrl = env['GEMINI_BASE_URL'] ?? 'https://generativelanguage.googleapis.com/v1beta/openai';
  if ((env['LLM_PROVIDER'] ?? 'gemini') === 'stub') {
    return { llm: new StubLlmProvider(evalsFor), research: new MockResearchProvider(), platformKey: null, testMode: true, baseUrl };
  }
  const key = env['GEMINI_API_KEY'] ?? '';
  if (key) {
    const models = defaultGeminiModels();
    return {
      llm: new OpenAiCompatibleProvider(key, models, baseUrl, 'gemini', logger), research: new GeminiResearchProvider(key, models.research),
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

  /** 配備の形。 */
  deployment(): Deployment {
    return this.deps.deployment ?? 'cloud';
  }

  /** 実際に効く会社の AI の方針（ローカルの形でだけローカルの方針が効く。第16.3.7.1節）。 */
  async policyFor(tenantId: string): Promise<AiPolicyMode> {
    if (this.deployment() !== 'onsite') return 'cloud';
    return effectiveAiPolicy('onsite', await this.deps.repo.getTenantSettings(tenantId));
  }

  /** ローカル AI。設定が無ければ、使えないことを伝える推論。 */
  localLlm(): LlmProvider {
    if (this.deps.localLlm) return this.deps.localLlm;
    return this.deps.local ? (this.localProvider ??= new LocalLlmProvider(this.deps.local)) : new PolicyBlockedLlmProvider(LOCAL_AI_NOT_CONFIGURED);
  }

  private localProvider: LocalLlmProvider | undefined;

  /**
   * 会社の推論。**ローカルの方針の会社ではローカル AI を返す**（秘書・記憶・名刺の読み取りなど、業務の外の推論はすべてこれを使う）。
   * クラウドの方針の会社では、会社の鍵があればその鍵、無ければ既定。
   */
  async llmFor(tenantId: string): Promise<LlmProvider> {
    if (isLocalPolicy(await this.policyFor(tenantId))) return this.localLlm();
    return this.cloudLlm(tenantId);
  }

  /**
   * 業務の 1 回の実行に使う推論と、その種類（第16.3.7.1節「途中で切り替えない」）。
   *
   * @remarks ローカルを既定の会社では、「外部の AI を使ってよい」印があり、会社のデータを読むツールとファイルの欄を持たない業務だけ外部の AI。
   * それ以外と、ローカルだけの会社はローカル AI
   */
  async llmForRun(
    tenantId: string, def: AgentDefinition, registry: Pick<ToolRegistry, 'get'>, previous?: AiKind,
  ): Promise<{ llm: LlmProvider; kind: AiKind; note?: string }> {
    const mode = await this.policyFor(tenantId);
    // 1 つの実行の中で AI を切り替えない。前の段がローカル AI なら、方針が変わってもローカル AI のまま続ける。
    // 前の段が外部の AI でも、いまの方針が外部を許さなければ続けない（厳しい方を採る）
    if (previous === 'local') return { llm: this.localLlm(), kind: 'local' };
    if (previous && isLocalPolicy(mode) && !(mode === 'local-first' && previous === 'external')) {
      return { llm: new PolicyBlockedLlmProvider('会社の AI の方針が変わったため、外部の AI で始めたこの業務は続けられません。もう一度依頼してください'), kind: previous };
    }
    if (mode === 'cloud') return { llm: await this.cloudLlm(tenantId), kind: 'cloud' };
    if (mode === 'local-first' && def.externalAi) {
      const check = externalAiAllowed(def, registry);
      if (check.ok) return { llm: await this.cloudLlm(tenantId), kind: 'external' };
      return { llm: this.localLlm(), kind: 'local', note: check.reason };
    }
    return { llm: this.localLlm(), kind: 'local' };
  }

  /**
   * 会社の接続（社外のサービス）に送ってよいか（第16.3.7.1節「外部のサービスへの接続」）。
   *
   * @returns 送れなければ理由。クラウドの方針の会社と、管理者が「個人を特定する情報を除いて送ってよい」と決めた接続は `null`
   */
  async connectionBlocked(tenantId: string, connectionId: string): Promise<string | null> {
    if (!isLocalPolicy(await this.policyFor(tenantId))) return null;
    const conn = (await this.deps.repo.listConnections(tenantId)).find((c) => c.id === connectionId);
    if (conn?.sendPolicy === 'deidentified') return null;
    return 'ローカルの方針のため、この接続（社外のサービス）には送りません。送ってよい場合は、管理者ページの「接続」で決めてください';
  }

  /** クラウドの AI（Gemini）。会社の鍵があればその鍵、無ければ既定。 */
  private async cloudLlm(tenantId: string): Promise<LlmProvider> {
    return (await this.entry(tenantId))?.llm ?? this.deps.fallbackLlm;
  }

  /**
   * 会社の音声の対話（仕様書 第10.5節、ADR-0018）。
   *
   * @remarks 鍵があれば Gemini Live。無ければ始めない（仕様書 第20.2.4節）。見本の実装は自動テストのときだけ
   * @throws {AiNotConfiguredError} 鍵が無いとき（自動テストを除く）
   */
  async voiceFor(tenantId: string): Promise<VoiceProvider> {
    // 音声の秘書は外部の音声のサービスを使う。ローカルの方針の会社では使わない（第8.6節、Q-157）
    if (isLocalPolicy(await this.policyFor(tenantId))) {
      throw new AiPolicyBlockedError('ローカルの方針のため、音声の秘書は使えません（外部の音声のサービスを使うため）。文字で話しかけてください');
    }
    const g = await this.geminiFor(tenantId);
    if (!g.apiKey) {
      if (this.deps.testMode) return new MockVoiceProvider();
      throw new AiNotConfiguredError();
    }
    return new GeminiLiveProvider({ apiKey: g.apiKey, model: g.models.live });
  }

  /**
   * 会社の Web の調査。調べる言葉だけを外部（Google）に送る。ローカルだけの会社では使わない（第16.3.7.1節）。
   */
  async researchFor(tenantId: string): Promise<ResearchProvider> {
    if ((await this.policyFor(tenantId)) === 'local-only') {
      return new PolicyBlockedResearchProvider('ローカルだけの方針のため、Web の調べものは使えません');
    }
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
      llm: new OpenAiCompatibleProvider(key, { fast: models.fast, standard: models.standard, advanced: models.advanced, fallback: models.fallback ?? '' }, this.deps.baseUrl, 'gemini', this.deps.logger),
      research: new GeminiResearchProvider(key, models.research),
    };
    this.cache.set(tenantId, next);
    return next;
  }
}

function dropEmpty(o: Partial<GeminiModels>): Partial<GeminiModels> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) as Partial<GeminiModels>;
}
