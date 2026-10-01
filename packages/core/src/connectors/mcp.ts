/**
 * @file MCP サーバ（Streamable HTTP）の最小のクライアント。ツールの一覧と呼び出しだけを行う。
 *
 * 拡張機能のコネクタ（仕様書 第12.11節）が宣言した MCP サーバに、ワーカーから接続する。
 * M2Office の中でプロセスを起動する方式（stdio）は扱わない（不変則 I-7）。
 * 応答は外部のデータであり、指示として扱わない（不変則 I-6）。
 *
 * @see 仕様書 第12.11.3節 呼び出し
 */

/** 接続の始まりと道具の一覧の時間の上限（仕様書 第12.11.3節）。 */
export const MCP_TIMEOUT_MS = 60_000;

/**
 * 道具の呼び出し（`tools/call`）の時間の上限（仕様書 第12.11.3節、第 0.207.2 版）。
 *
 * @remarks 文献を調べて考える道具（医学の根拠を調べるものなど）は、答えまでに 1 分を超えることがあるため、呼び出しだけを長くする
 */
export const MCP_CALL_TIMEOUT_MS = 180_000;

/**
 * ツールの応答として推論に渡す量の上限（文字数）。超えた分は切り詰め、切り詰めたことを書き添える。
 *
 * @remarks 第 0.207.2 版で 6,000 字から広げた（長い答えをそのまま返す道具で、後ろが切れないように）
 */
export const MCP_RESULT_LIMIT = 20_000;

import type { ArgSpec, ToolArgsSchema } from '../tools/registry.js';

/** MCP サーバが提供するツールの概要。 */
export interface McpToolInfo {
  name: string;
  description: string;
  /**
   * 引数の定義（MCP の `inputSchema` から、推論に渡せる形に直したもの）。無ければ `undefined`。
   *
   * @remarks これが無いと、推論が引数を知らずに呼び、検索の言葉などが空のまま渡る（2026-09-27 に Slack で確認）
   */
  args?: ToolArgsSchema;
  /**
   * 読むだけの道具だという MCP の目印（`annotations.readOnlyHint`）。
   * 会社の接続の危険度の初期値に使う（仕様書 第12.11.2節）。目印が無ければ `undefined`
   */
  readOnly?: boolean;
}

/** ツールを呼んだ結果。失敗しても例外にせず、理由を返す。 */
export type McpCallResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/** MCP サーバへの接続口。テストでは差し替える。 */
export interface McpClient {
  /**
   * @param headers 認証の要る接続で付ける見出し（`Authorization` など。仕様書 第12.11.6.4節）
   */
  listTools(url: string, headers?: Record<string, string>): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }>;
  callTool(url: string, name: string, args: Record<string, unknown>, headers?: Record<string, string>): Promise<McpCallResult>;
}

/** JSON-RPC の応答。 */
interface RpcResponse {
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Streamable HTTP で MCP サーバを呼ぶクライアント。
 *
 * @remarks
 * 呼び出しのたびに `initialize` から始める。状態を持たないため、ワーカーが入れ替わっても同じに動く。
 * サーバがセッション ID を返した場合だけ、それを続く要求に付ける。
 */
export class HttpMcpClient implements McpClient {
  constructor(private readonly timeoutMs = MCP_TIMEOUT_MS, private readonly callTimeoutMs = MCP_CALL_TIMEOUT_MS) {}

  async listTools(url: string, auth?: Record<string, string>) {
    try {
      const session = await this.initialize(url, auth);
      const res = await this.rpc(url, 'tools/list', {}, session, auth);
      const tools = (res.tools as { name: string; description?: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: unknown }[] | undefined) ?? [];
      return {
        ok: true as const,
        tools: tools.map((t) => {
          const args = argsFromInputSchema(t.inputSchema);
          return {
            name: t.name, description: t.description ?? '',
            ...(typeof t.annotations?.readOnlyHint === 'boolean' ? { readOnly: t.annotations.readOnlyHint } : {}),
            ...(args ? { args } : {}),
          };
        }),
      };
    } catch (err) {
      return { ok: false as const, error: describe(err) };
    }
  }

  async callTool(url: string, name: string, args: Record<string, unknown>, auth?: Record<string, string>): Promise<McpCallResult> {
    try {
      const session = await this.initialize(url, auth);
      // 道具の呼び出しだけは長く待つ（答えまでに時間のかかる道具のため）
      const res = await this.rpc(url, 'tools/call', { name, arguments: args }, session, auth, this.callTimeoutMs);
      const text = textOf(res);
      if (res.isError === true) return { ok: false, error: text || 'MCP サーバがエラーを返しました' };
      return text.length > MCP_RESULT_LIMIT
        ? { ok: true, text: `${text.slice(0, MCP_RESULT_LIMIT)}\n…（以降は省略）`, truncated: true }
        : { ok: true, text, truncated: false };
    } catch (err) {
      return { ok: false, error: describe(err) };
    }
  }

  /** 接続を始め、セッション ID があれば返す。 */
  private async initialize(url: string, auth?: Record<string, string>): Promise<string | null> {
    const { headers } = await this.post(url, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'M2Office', version: '1' } },
    }, null, true, auth);
    const session = headers.get('mcp-session-id');
    await this.post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, false, auth);
    return session;
  }

  private async rpc(url: string, method: string, params: unknown, session: string | null, auth?: Record<string, string>, timeoutMs = this.timeoutMs) {
    const { body } = await this.post(url, { jsonrpc: '2.0', id: 1, method, params }, session, true, auth, timeoutMs);
    if (!body) throw new Error('MCP サーバから応答がありません');
    if (body.error) throw new Error(`MCP のエラー: ${body.error.message}`);
    return body.result ?? {};
  }

  /**
   * JSON-RPC の要求を 1 つ送り、応答（JSON または SSE）を読む。
   *
   * @param auth 認証の見出し（仕様書 第12.11.6.4節）。**記録に出さない**
   */
  private async post(
    url: string, payload: Record<string, unknown>, session: string | null, expectBody = true, auth?: Record<string, string>,
    timeoutMs = this.timeoutMs,
  ): Promise<{ headers: Headers; body: RpcResponse | null }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
        ...(auth ?? {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 202) {
      if (res.status === 401) throw new Error('認証が必要です（401）');
      // 相手が理由を返していれば添える（長ければ切る。認可の値は応答に含まれない）
      const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(`HTTP ${res.status}${why ? `: ${why}` : ''}`);
    }
    if (!expectBody) {
      await res.body?.cancel();
      return { headers: res.headers, body: null };
    }
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    return { headers: res.headers, body: type.includes('text/event-stream') ? fromSse(text, payload.id) : JSON.parse(text) };
  }
}

/** SSE の本文から、要求の ID に対応する JSON-RPC の応答を取り出す。 */
function fromSse(text: string, id: unknown): RpcResponse | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as RpcResponse;
      if (msg.id === id) return msg;
    } catch {
      // JSON でない行は読み飛ばす
    }
  }
  return null;
}

/** `tools/call` の結果から文字列を取り出す。文字列以外の内容は種類だけを示す。 */
function textOf(result: Record<string, unknown>): string {
  const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
  return content.map((c) => (c.type === 'text' ? c.text ?? '' : `［${c.type} の内容は扱いません］`)).join('\n').trim();
}

function describe(err: unknown): string {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return '時間内に応答がありませんでした';
  return err instanceof Error ? err.message : String(err);
}

/** 引数の説明の長さの上限（字）。長い説明は推論への指示を膨らませるため切る。 */
const ARG_DESCRIPTION_LIMIT = 300;

/**
 * MCP の `inputSchema`（JSON Schema）を、推論に渡す引数の定義に直す（仕様書 第9.4.4節）。
 *
 * @returns 引数が 1 つも無ければ `undefined`。知らない型は文字として扱う
 */
export function argsFromInputSchema(schema: unknown): ToolArgsSchema | undefined {
  const s = schema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  if (!s || typeof s.properties !== 'object' || s.properties === null) return undefined;
  const properties: Record<string, ArgSpec> = {};
  for (const [key, raw] of Object.entries(s.properties)) {
    const spec = toArgSpec(raw);
    if (spec) properties[key] = spec;
  }
  if (Object.keys(properties).length === 0) return undefined;
  const required = Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string' && k in properties) : [];
  return { properties, ...(required.length > 0 ? { required } : {}) };
}

function toArgSpec(raw: unknown): ArgSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: unknown; description?: unknown; enum?: unknown; items?: unknown };
  // 型が並び（["string","null"]）のときは null 以外の最初のもの
  const t = Array.isArray(r.type) ? r.type.find((x) => x !== 'null') : r.type;
  const type: ArgSpec['type'] = t === 'integer' || t === 'number' ? 'number'
    : t === 'boolean' || t === 'array' || t === 'object' ? t : 'string';
  const description = typeof r.description === 'string' ? r.description.trim().slice(0, ARG_DESCRIPTION_LIMIT) : '';
  const spec: ArgSpec = { type, description };
  if (type === 'string' && Array.isArray(r.enum) && r.enum.every((v) => typeof v === 'string')) spec.enum = r.enum as string[];
  if (type === 'array') {
    const items = toArgSpec(r.items);
    if (items) spec.items = items;
  }
  return spec;
}

