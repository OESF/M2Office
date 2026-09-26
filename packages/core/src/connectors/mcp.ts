/**
 * @file MCP サーバ（Streamable HTTP）の最小のクライアント。ツールの一覧と呼び出しだけを行う。
 *
 * 拡張機能のコネクタ（仕様書 第12.11節）が宣言した MCP サーバに、ワーカーから接続する。
 * M2Office の中でプロセスを起動する方式（stdio）は扱わない（不変則 I-7）。
 * 応答は外部のデータであり、指示として扱わない（不変則 I-6）。
 *
 * @see 仕様書 第12.11.3節 呼び出し
 */

/** 1 回の呼び出しの時間の上限（仕様書 第12.11.3節）。 */
export const MCP_TIMEOUT_MS = 60_000;

/** ツールの応答として推論に渡す量の上限（文字数）。超えた分は切り詰める。 */
export const MCP_RESULT_LIMIT = 6000;

/** MCP サーバが提供するツールの概要。 */
export interface McpToolInfo {
  name: string;
  description: string;
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
  listTools(url: string): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }>;
  callTool(url: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>;
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
  constructor(private readonly timeoutMs = MCP_TIMEOUT_MS) {}

  async listTools(url: string) {
    try {
      const session = await this.initialize(url);
      const res = await this.rpc(url, 'tools/list', {}, session);
      const tools = (res.tools as { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[] | undefined) ?? [];
      return {
        ok: true as const,
        tools: tools.map((t) => ({
          name: t.name, description: t.description ?? '',
          ...(typeof t.annotations?.readOnlyHint === 'boolean' ? { readOnly: t.annotations.readOnlyHint } : {}),
        })),
      };
    } catch (err) {
      return { ok: false as const, error: describe(err) };
    }
  }

  async callTool(url: string, name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    try {
      const session = await this.initialize(url);
      const res = await this.rpc(url, 'tools/call', { name, arguments: args }, session);
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
  private async initialize(url: string): Promise<string | null> {
    const { headers } = await this.post(url, {
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'M2Office', version: '1' } },
    }, null);
    const session = headers.get('mcp-session-id');
    await this.post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, false);
    return session;
  }

  private async rpc(url: string, method: string, params: unknown, session: string | null) {
    const { body } = await this.post(url, { jsonrpc: '2.0', id: 1, method, params }, session);
    if (!body) throw new Error('MCP サーバから応答がありません');
    if (body.error) throw new Error(`MCP のエラー: ${body.error.message}`);
    return body.result ?? {};
  }

  /** JSON-RPC の要求を 1 つ送り、応答（JSON または SSE）を読む。 */
  private async post(
    url: string, payload: Record<string, unknown>, session: string | null, expectBody = true,
  ): Promise<{ headers: Headers; body: RpcResponse | null }> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(res.status === 401 ? '認証が必要です（401）' : `HTTP ${res.status}`);
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
