/**
 * @file ローカル AI（ローカル LLM）の口（仕様書 第16.3.7.1節、ADR-0059）。
 *
 * 社内の機械で動かす言語モデル（Ollama・LM Studio・MLX のサーバーなど）の、OpenAI 互換の口（`/chat/completions`）を呼ぶ。
 * M2Office とは別のプロセスとして動くものを HTTP で呼ぶだけで、M2Office の中で他社のプログラムを動かさない（不変則 I-7）。
 * 画像は、画像を読めるモデルのときだけ `image_url`（データ URL）で渡す。PDF はローカル AI では読めない（読めないと返す）。
 *
 * @see 仕様書 第8.6節 配備の形
 */

import { EMBEDDING_DIMENSIONS, type LlmEmbedRequest, type LlmEmbedResponse, type LlmExtractRequest, type LlmImageRequest, type LlmProvider, type LlmRequest, type LlmResponse, type ModelTier } from './provider.js';
import { LlmRequestError } from './gemini.js';

/** ローカル AI の設定。 */
export interface LocalLlmConfig {
  /** OpenAI 互換の口（例: `http://127.0.0.1:11434/v1`）。 */
  baseUrl: string;
  /** 役割ごとのモデル。1 つのモデルを全部に使ってよい。 */
  models: Record<ModelTier, string>;
  /** 口が鍵を求めるときだけ。 */
  apiKey?: string;
  /** 1 回の問い合わせを待つ時間（ミリ秒）。社内の機械は応答が遅いことがある。 */
  timeoutMs?: number;
  /**
   * 埋め込みのモデル（例: EmbeddingGemma。768 次元のもの。仕様書 第11.7.6節）。
   * 無ければ埋め込みを作らず、知識は言葉の検索だけで探す（外部の AI に節を渡さないため、クラウドで代えない）
   */
  embedModel?: string;
}

/** ローカル AI の設定を環境変数から読む。口が無ければ `null`。 */
export function localLlmFromEnv(env: Record<string, string | undefined>): LocalLlmConfig | null {
  const baseUrl = env['LOCAL_LLM_URL']?.trim();
  const model = env['LOCAL_LLM_MODEL']?.trim();
  if (!baseUrl || !model) return null;
  const pick = (tier: string) => env[`LOCAL_LLM_MODEL_${tier.toUpperCase()}`]?.trim() || model;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    models: { fast: pick('fast'), standard: pick('standard'), advanced: pick('advanced') },
    ...(env['LOCAL_LLM_KEY'] ? { apiKey: env['LOCAL_LLM_KEY'] } : {}),
    timeoutMs: Number(env['LOCAL_LLM_TIMEOUT_MS'] ?? 300_000),
    ...(env['LOCAL_LLM_EMBED_MODEL']?.trim() ? { embedModel: env['LOCAL_LLM_EMBED_MODEL'].trim() } : {}),
  };
}

/**
 * ローカル AI。
 *
 * @remarks 名前は `local`。実行の記録と監査ログに、ローカル AI を使ったことを残すのに使う
 */
export class LocalLlmProvider implements LlmProvider {
  readonly name = 'local';
  /** 埋め込み（設定に埋め込みのモデルがあるときだけ）。 */
  readonly embed?: (req: LlmEmbedRequest) => Promise<LlmEmbedResponse>;

  constructor(private readonly config: LocalLlmConfig) {
    const model = config.embedModel;
    if (model) this.embed = (req) => this.embedWith(model, req);
  }

  /**
   * OpenAI 互換の `/embeddings` で埋め込む（仕様書 第11.7.6節）。書き方は EmbeddingGemma の検索の書き方にそろえる。
   *
   * @throws {LlmRequestError} 届かない・次元が {@link EMBEDDING_DIMENSIONS} でない
   */
  private async embedWith(model: string, req: LlmEmbedRequest): Promise<LlmEmbedResponse> {
    const input = req.items.map((x) => (req.kind === 'query'
      ? `task: search result | query: ${x.text}`
      : `title: ${x.title?.trim() || 'none'} | text: ${x.text}`));
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 300_000),
      });
    } catch (err) {
      throw new LlmRequestError('ローカル AI に届きませんでした', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw new LlmRequestError(`ローカル AI の埋め込みに失敗しました (${res.status})`, await res.text().catch(() => ''));
    const json = await res.json() as { data?: { embedding?: number[]; index?: number }[]; usage?: { prompt_tokens?: number } };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = data.map((d) => d.embedding ?? []);
    if (vectors.length !== input.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new LlmRequestError(`ローカル AI の埋め込みは ${EMBEDDING_DIMENSIONS} 次元のモデルにしてください`, `${vectors[0]?.length ?? 0} 次元`);
    }
    return { vectors, model: `local:${model}`, inputTokens: json.usage?.prompt_tokens ?? input.reduce((n, t) => n + t.length, 0) };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = this.config.models[req.tier];
    const json = await this.post({ model, messages: req.messages, ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}) });
    return this.toResponse(json, model);
  }

  /** 画像から文字を読む（OCR）。画像を読めるモデルのときだけ働く。PDF は読めない。 */
  async readImage(req: LlmImageRequest): Promise<LlmResponse> {
    if (req.mimeType === 'application/pdf') throw new LlmRequestError('ローカル AI では PDF を読めません', '');
    const model = this.config.models.standard;
    const json = await this.post({
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '画像に書かれている文字を、書かれているとおりにすべて書き出してください。注釈や説明は付けないでください。' },
        { type: 'image_url', image_url: { url: dataUrl(req.bytes, req.mimeType) } },
      ] }],
      max_tokens: 2000,
    });
    return this.toResponse(json, model);
  }

  /** 画像から、指示の形の JSON で項目を取り出す（名刺の読み取りなど）。画像を読めるモデルのときだけ働く。 */
  async extractFromImage(req: LlmExtractRequest): Promise<LlmResponse> {
    if (req.mimeType === 'application/pdf') throw new LlmRequestError('ローカル AI では PDF を読めません', '');
    const model = this.config.models[req.tier ?? 'standard'];
    const json = await this.post({
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: `${req.prompt}\nJSON だけを返してください。` },
        { type: 'image_url', image_url: { url: dataUrl(req.bytes, req.mimeType) } },
      ] }],
      max_tokens: req.maxOutputTokens ?? 2000,
    });
    return this.toResponse(json, model);
  }

  /** ローカル AI に届くか（管理者ページの確認）。届けば使えるモデルの名前を返す。 */
  async check(): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${this.config.baseUrl}/models`, {
        headers: this.headers(), signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = await res.json() as { data?: { id?: string }[] };
      return { ok: true, models: (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) };
  }

  private async post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 300_000),
      });
    } catch (err) {
      throw new LlmRequestError('ローカル AI に届きませんでした', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw new LlmRequestError(`ローカル AI の呼び出しに失敗しました (${res.status})`, await res.text().catch(() => ''));
    return await res.json() as Record<string, unknown>;
  }

  private toResponse(json: Record<string, unknown>, model: string): LlmResponse {
    const choices = json['choices'] as { message?: { content?: string } }[] | undefined;
    const used = (json['usage'] ?? {}) as { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    return {
      text: choices?.[0]?.message?.content ?? '',
      tokensUsed: used.total_tokens ?? (used.prompt_tokens ?? 0) + (used.completion_tokens ?? 0),
      ...(used.prompt_tokens !== undefined ? { inputTokens: used.prompt_tokens } : {}),
      ...(used.completion_tokens !== undefined ? { outputTokens: used.completion_tokens } : {}),
      model: typeof json['model'] === 'string' ? json['model'] : model,
    };
  }
}

function dataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}
