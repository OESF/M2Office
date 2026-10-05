/**
 * @file 推論の呼び出しの成否と時間を、接続先の健全性に残す包み（仕様書 第6.7.6節）。
 *
 * 推論の窓口そのものは会社を知らないため、会社ごとの推論を渡すところ（`TenantAiResolver`）で包む。
 * 依頼と応答の中身は残さない。
 */

import { LlmRequestError } from '../llm/gemini.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../llm/provider.js';
import { recordHealth } from './recorder.js';

/**
 * 推論の失敗を健全性の種類に直す。
 *
 * @remarks 状態の符号だけを見る（応答の文は見ない）
 */
export function llmHealthKind(err: unknown): string {
  const m = err instanceof LlmRequestError ? /\((\d{3})\)/.exec(err.message) : null;
  const status = m ? Number(m[1]) : null;
  if (err instanceof LlmRequestError && /届きませんでした/.test(err.message)) return 'unreachable';
  if (status === 429) return 'busy';
  if (status === 408) return 'timeout';
  if (status !== null && status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  return 'error';
}

/**
 * 会社の推論を包み、呼び出しごとの成否と時間を `ai` として残す。
 *
 * @remarks 設定されていない・方針で止めている推論は包まない（呼び出しではないため）。持たない操作（画像の読み取りなど）は持たないまま
 */
export function observeLlm(tenantId: string, inner: LlmProvider): LlmProvider {
  if (inner.name === 'unconfigured') return inner;
  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const out = await fn();
      recordHealth(tenantId, 'ai', true, Date.now() - started);
      return out;
    } catch (err) {
      recordHealth(tenantId, 'ai', false, Date.now() - started, llmHealthKind(err));
      throw err;
    }
  };
  const wrapped: LlmProvider = {
    name: inner.name,
    complete: (req: LlmRequest): Promise<LlmResponse> => timed(() => inner.complete(req)),
  };
  if (inner.readImage) wrapped.readImage = (req) => timed(() => inner.readImage!(req));
  if (inner.extractFromImage) wrapped.extractFromImage = (req) => timed(() => inner.extractFromImage!(req));
  if (inner.generateImage) wrapped.generateImage = (req) => inner.generateImage!(req);
  if (inner.generateVideo) wrapped.generateVideo = (req) => inner.generateVideo!(req);
  return wrapped;
}
