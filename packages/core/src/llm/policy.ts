/**
 * @file 配備の形と会社の AI の方針から、使う AI を決める（仕様書 第8.6節・第16.3.7.1節、ADR-0059）。
 *
 * 顧客の個人の情報を外部の AI に渡さないことを、決まりではなく仕組みで守る。
 * ローカルを既定の会社では、秘書と、会社のデータやファイルを読む業務はローカル AI で動かし、
 * 外部の AI は「外部の AI を使ってよい」印を付け、かつ会社のデータを読むツールとファイルの欄を持たない業務だけに使う。
 * 中身を見て振り分けることはしない（取りこぼしがそのまま漏えいになるため）。
 */

import type { AgentDefinition, AiPolicyMode, TenantSettings } from '@m2office/shared';
import type { ToolRegistry } from '../tools/registry.js';
import type { LlmProvider, LlmResponse } from './provider.js';
import type { ResearchProvider, ResearchResult } from '../research/provider.js';

/** 配備の形。`cloud` はいまの形（多数の会社）、`onsite` は会社の中の 1 台に 1 社だけ。 */
export type Deployment = 'cloud' | 'onsite';

/** 実行に使った AI。`cloud` はクラウドの方針の会社の AI、`external` はローカルを既定の会社が外部の AI を使ったもの、`local` はローカル AI。 */
export type AiKind = 'cloud' | 'external' | 'local';

/** 環境変数 `M2O_DEPLOYMENT` から配備の形を読む。既定はクラウド。 */
export function deploymentFromEnv(env: Record<string, string | undefined>): Deployment {
  return env['M2O_DEPLOYMENT']?.trim() === 'onsite' ? 'onsite' : 'cloud';
}

/**
 * 実際に効く会社の AI の方針。ローカルを既定・ローカルだけは、ローカルの形でだけ効く（クラウドの形からはローカル AI に届かないため）。
 */
export function effectiveAiPolicy(deployment: Deployment, settings: Pick<TenantSettings, 'aiPolicy'>): AiPolicyMode {
  return deployment === 'onsite' ? settings.aiPolicy.mode : 'cloud';
}

/** ローカルの方針か（ローカルを既定・ローカルだけ）。 */
export const isLocalPolicy = (mode: AiPolicyMode) => mode === 'local-first' || mode === 'local-only';

/**
 * 業務が外部の AI を使ってよいかを、定義から機械的に確かめる（第16.3.7.1節「印を付けられる条件」）。
 *
 * @returns 使ってよければ `{ ok: true }`。だめなら理由（印を無視してローカル AI で動かす）
 */
export function externalAiAllowed(def: AgentDefinition, registry: Pick<ToolRegistry, 'get'>): { ok: true } | { ok: false; reason: string } {
  if (!def.externalAi) return { ok: false, reason: '外部の AI を使ってよい印がありません' };
  if (def.compartment) return { ok: false, reason: '権限区画の業務は外部の AI を使えません' };
  const props = ((def.inputs as { properties?: Record<string, { format?: string }> }).properties) ?? {};
  if (Object.values(props).some((p) => p.format === 'file')) return { ok: false, reason: 'ファイルの欄を持つ業務は外部の AI を使えません' };
  const unsafe = def.tools.filter((name) => !registry.get(name)?.externalSafe);
  if (unsafe.length > 0) return { ok: false, reason: `会社のデータを読むツールを持つため外部の AI を使えません（${unsafe.join('、')}）` };
  return { ok: true };
}

/** 方針で使えない AI。呼ばれたら理由を伝える（推論を始めない）。 */
export class PolicyBlockedLlmProvider implements LlmProvider {
  /** 使えないことを表す名前（`aiAvailable` が偽を返す）。 */
  readonly name = 'unconfigured';

  constructor(readonly unavailableReason: string) {}

  async complete(): Promise<LlmResponse> {
    throw new AiPolicyBlockedError(this.unavailableReason);
  }
}

/** 方針で使えない Web の調べもの。 */
export class PolicyBlockedResearchProvider implements ResearchProvider {
  readonly name = 'unconfigured';

  constructor(private readonly reason: string) {}

  async research(): Promise<ResearchResult> {
    throw new AiPolicyBlockedError(this.reason);
  }
}

/** 会社の AI の方針で使えないことを表す。 */
export class AiPolicyBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiPolicyBlockedError';
  }
}

/** ローカル AI が設定されていないときの理由。 */
export const LOCAL_AI_NOT_CONFIGURED = 'ローカル AI が設定されていません。社内の機械で言語モデルを動かし、M2Office の設定（LOCAL_LLM_URL・LOCAL_LLM_MODEL）を確かめてください';
