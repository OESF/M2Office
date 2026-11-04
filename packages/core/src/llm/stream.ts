/**
 * @file OpenAI 互換の窓口（`/chat/completions` の `stream: true`）の応答を、少しずつ読む（仕様書 第43.11.2節「推論のストリーム」）。
 * Gemini の OpenAI 互換の窓口と、ローカル AI（OpenAI 互換）の両方で使う。
 */

import type { LlmMessage, LlmResponse, LlmTextSink } from './provider.js';

/** 1 つの切れ端（`data:` の行の JSON）。 */
interface ChatChunk {
  model?: string;
  choices?: { delta?: { content?: string | null } }[];
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | null;
}

/**
 * 使った量が応答に無いときの見積もり。日本語は 1 字がおよそ 1 トークンなので、文字数をそのままトークン数とする（少なく数えないため）。
 */
export function estimateTokens(messages: LlmMessage[], text: string): { input: number; output: number } {
  return { input: messages.reduce((n, m) => n + m.content.length, 0), output: text.length };
}

/**
 * サーバー送信イベントの形の応答を読み、届いた文を `onText` に渡す。
 *
 * @param messages 送った依頼（使った量が応答に無いときの見積もりに使う）
 * @param fallbackModel 応答にモデル名が無いときの名前
 * @returns 全文と使った量
 * @remarks 1 行が途中で切れて届いても、改行までためてから読む。読めない行は飛ばす
 */
export async function readChatStream(res: Response, messages: LlmMessage[], fallbackModel: string, onText: LlmTextSink): Promise<LlmResponse> {
  let text = '';
  let model = fallbackModel;
  let usage: ChatChunk['usage'] = null;
  const handle = (line: string) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: ChatChunk;
    try { chunk = JSON.parse(data) as ChatChunk; } catch { return; }
    if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const piece = chunk.choices?.[0]?.delta?.content;
    if (typeof piece === 'string' && piece) {
      text += piece;
      onText(piece);
    }
  };
  if (!res.body) {
    for (const line of (await res.text()).split('\n')) handle(line);
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    buf += decoder.decode();
    if (buf) handle(buf);
  }
  const used = usage as ChatChunk['usage'];
  const est = estimateTokens(messages, text);
  const input = used?.prompt_tokens ?? est.input;
  const output = used?.completion_tokens ?? est.output;
  return { text, tokensUsed: used?.total_tokens ?? input + output, inputTokens: input, outputTokens: output, model };
}
