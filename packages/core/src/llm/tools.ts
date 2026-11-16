/**
 * @file 推論の道具呼び出しの機能（関数の定義を渡し、呼び出しを構造で受け取る）の共通の形（仕様書 第48.6節、ADR-0149）。
 *
 * 接続の業務（1 本の会話）は、相手の道具の引数の定義（JSON Schema）をそのまま推論に渡す。
 * それまでの文の約束（推論の文の中の ```tool の囲み。第20.2節）では、入れ子の引数を正しく作りにくかった。
 * Gemini もローカルの AI も OpenAI 互換の窓口を使うので、OpenAI 互換の `tools`・`tool_calls` の形を 1 つにまとめる。
 */

import type { ModelTier } from './provider.js';

/** 道具 1 つの定義（推論に渡すもの）。`parameters` は JSON Schema。 */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 推論が呼んだ道具 1 つ。`id` は会話の中で答えを結ぶための印。 */
export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * 推論が呼び出しに付けて返した、提供者ごとの付けたし（Gemini の考えの署名 `thought_signature` など）。
   * 次の依頼で、その呼び出しといっしょにそのまま返す（返さないと Gemini は 400 で断る。2026-11-15 に確認）
   */
  extra?: Record<string, unknown>;
}

/** 道具を使う会話の 1 つの発言。 */
export type LlmChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** 道具を使う依頼。 */
export interface LlmToolRequest {
  tier: ModelTier;
  messages: LlmChatMessage[];
  tools: LlmToolSpec[];
  maxOutputTokens?: number;
}

/**
 * 道具の名前を、推論の窓口が受け付ける形にする（英数字・下線・ハイフン、64 字まで）。
 *
 * @remarks 会社の接続の道具は `<接続の ID>.<道具>` で「.」を含むため、`__` に置き換える。戻すときは {@link fromWireName}
 */
export function toWireName(name: string): string {
  return name.replace(/\./g, '__').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** 窓口の名前を、元の道具の名前に戻す（渡した道具の中から引く）。見つからなければそのまま。 */
export function fromWireName(wire: string, names: readonly string[]): string {
  return names.find((n) => toWireName(n) === wire) ?? wire;
}

/** 推論の窓口が受け付けない JSON Schema の項目（確かめは M2Office の側で、元の定義で行う）。 */
const DROP_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties', 'propertyNames', 'patternProperties',
  'pattern', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
  'uniqueItems', 'default', 'examples', 'title', 'readOnly', 'writeOnly',
]);
/** 窓口が受け付ける `format`。ほかは落とす（日付の形などは説明に残る）。 */
const KEEP_FORMATS = new Set(['date-time', 'enum']);

/**
 * JSON Schema を、推論の窓口が受け付ける形に整える（入れ子・必須・列挙・説明は残す）。
 *
 * @remarks
 * 落とすのは、窓口が断る項目（長さ・パターン・`additionalProperties` など）だけ。M2Office は呼ぶ前に元の定義で確かめる（第48.6節）。
 * 型の並び（`["string","null"]`）は null 以外の 1 つにし、`nullable` を付ける。`const` は 1 つだけの `enum` にする
 */
export function sanitizeSchema(schema: unknown): Record<string, unknown> {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== 'object') return s;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === 'format' && !(typeof v === 'string' && KEEP_FORMATS.has(v))) continue;
      if (k === 'const') { out['enum'] = [v]; continue; }
      if (k === 'type' && Array.isArray(v)) {
        const real = v.filter((t) => t !== 'null');
        out['type'] = real[0] ?? 'string';
        if (v.includes('null')) out['nullable'] = true;
        continue;
      }
      if (k === 'properties' && v && typeof v === 'object') {
        out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, walk(pv)]));
        continue;
      }
      out[k] = walk(v);
    }
    // anyOf の中で null だけの枝は外す（窓口が断ることがある）
    if (Array.isArray(out['anyOf'])) {
      const branches = (out['anyOf'] as Record<string, unknown>[]).filter((b) => !(b && b['type'] === 'null'));
      if (branches.length === 1) { const only = branches[0]!; delete out['anyOf']; Object.assign(out, only); out['nullable'] = true; }
      else out['anyOf'] = branches;
    }
    return out;
  };
  const top = walk(schema) as Record<string, unknown> | undefined;
  return top && typeof top === 'object' && top['type'] === 'object' ? top : { type: 'object', properties: (top?.['properties'] as object | undefined) ?? {} };
}

/**
 * 引数を JSON Schema で確かめる（呼ぶ前。第48.6節）。型・必須・列挙・入れ子・`anyOf`・長さ・数の範囲を見る。
 *
 * @returns 合わない所（無ければ空）。読めない形の定義は確かめない
 */
export function checkJsonArgs(schema: unknown, value: unknown, path = ''): string[] {
  const s = schema as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return [];
  const at = path || '引数';
  if (Array.isArray(s['anyOf'])) {
    const ok = (s['anyOf'] as unknown[]).some((b) => checkJsonArgs(b, value, path).length === 0);
    return ok ? [] : [`${at} の形が合いません`];
  }
  if (value === null && (s['type'] === 'null' || (Array.isArray(s['type']) && (s['type'] as unknown[]).includes('null')))) return [];
  const type = Array.isArray(s['type']) ? (s['type'] as string[]).find((t) => t !== 'null') : s['type'] as string | undefined;
  const problems: string[] = [];
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type === 'object') {
    if (kind !== 'object') return [`${at} はオブジェクトです`];
    const v = value as Record<string, unknown>;
    for (const r of (s['required'] as string[] | undefined) ?? []) if (v[r] === undefined) problems.push(`${path ? `${path}.` : ''}${r} が要ります`);
    const props = (s['properties'] as Record<string, unknown> | undefined) ?? {};
    for (const [k, pv] of Object.entries(v)) if (props[k]) problems.push(...checkJsonArgs(props[k], pv, path ? `${path}.${k}` : k));
    return problems;
  }
  if (type === 'array') {
    if (kind !== 'array') return [`${at} は並びです`];
    const arr = value as unknown[];
    if (typeof s['maxItems'] === 'number' && arr.length > s['maxItems']) problems.push(`${at} は ${s['maxItems']} 件までです`);
    if (s['items']) arr.forEach((x, i) => problems.push(...checkJsonArgs(s['items'], x, `${at}[${i}]`)));
    return problems;
  }
  if (type === 'string') {
    if (kind !== 'string') return [`${at} は文字です`];
    const str = value as string;
    if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(str)) problems.push(`${at} は ${(s['enum'] as unknown[]).join('・')} のどれかです`);
    if (typeof s['maxLength'] === 'number' && str.length > s['maxLength']) problems.push(`${at} は ${s['maxLength']} 字までです`);
    if (typeof s['minLength'] === 'number' && str.length < s['minLength']) problems.push(`${at} は ${s['minLength']} 字以上です`);
    if (typeof s['pattern'] === 'string') {
      try { if (!new RegExp(s['pattern']).test(str)) problems.push(`${at} の形が合いません`); } catch { /* 読めない形は確かめない */ }
    }
    return problems;
  }
  if (type === 'integer' || type === 'number') {
    if (kind !== 'number' || (type === 'integer' && !Number.isInteger(value))) return [`${at} は${type === 'integer' ? '整数' : '数'}です`];
    const n = value as number;
    if (typeof s['minimum'] === 'number' && n < s['minimum']) problems.push(`${at} は ${s['minimum']} 以上です`);
    if (typeof s['maximum'] === 'number' && n > s['maximum']) problems.push(`${at} は ${s['maximum']} 以下です`);
    if (typeof s['exclusiveMinimum'] === 'number' && n <= s['exclusiveMinimum']) problems.push(`${at} は ${s['exclusiveMinimum']} より大きい数です`);
    return problems;
  }
  if (type === 'boolean') return kind === 'boolean' ? [] : [`${at} は真偽です`];
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(value)) return [`${at} は ${(s['enum'] as unknown[]).join('・')} のどれかです`];
  return [];
}

/** OpenAI 互換の窓口に送る `messages` と `tools` を作る。 */
export function openAiToolBody(req: LlmToolRequest): { messages: unknown[]; tools: unknown[] } {
  return {
    messages: req.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
          role: 'assistant', content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id, type: 'function', function: { name: toWireName(c.name), arguments: JSON.stringify(c.args) },
            // 考えの署名などの付けたしは、受け取ったまま返す
            ...(c.extra ? { extra_content: c.extra } : {}),
          })),
        };
      }
      return { role: m.role, content: m.content };
    }),
    tools: req.tools.map((t) => ({ type: 'function', function: { name: toWireName(t.name), description: t.description.slice(0, 4000), parameters: sanitizeSchema(t.parameters) } })),
  };
}

/** OpenAI 互換の窓口の答えから、文と道具の呼び出しを取り出す。 */
export function openAiToolCalls(message: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }[] } | undefined, names: readonly string[]): { text: string; toolCalls: LlmToolCall[] } {
  const toolCalls: LlmToolCall[] = [];
  for (const [i, c] of (message?.tool_calls ?? []).entries()) {
    const wire = c.function?.name ?? '';
    if (!wire) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(c.function?.arguments || '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch { /* 読めない引数は空にする。確かめで理由を返す */ }
    const extra = c.extra_content && typeof c.extra_content === 'object' ? c.extra_content as Record<string, unknown> : undefined;
    toolCalls.push({ id: c.id || `call_${i}`, name: fromWireName(wire, names), args, ...(extra ? { extra } : {}) });
  }
  return { text: message?.content ?? '', toolCalls };
}
