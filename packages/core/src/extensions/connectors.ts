/**
 * @file コネクタ（L2）の宣言の検証と、コネクタのツールの組み立て。
 *
 * 拡張機能の `connectors/*.json` は、外部の MCP サーバへの接続を宣言する。
 * ツールの実体は MCP サーバ（M2Office の外）にあり、M2Office は宣言されたツールだけを呼ぶ（不変則 I-7）。
 *
 * @see 仕様書 第12.11節 コネクタ（L2）の実装
 */

import { RISK_LEVELS, type RiskLevel } from '@m2office/shared';
import type { Tool, ToolArgsSchema } from '../tools/registry.js';
import type { McpClient } from '../connectors/mcp.js';

/**
 * コネクタの認証の方式（仕様書 第12.11.6.1節）。
 *
 * @remarks
 * `none` は認証なし、`oauth` は会社がアプリを登録し利用者ごとに認可する（基本）、`api_key` は会社の鍵で会社として動く。
 */
export const CONNECTOR_AUTH_TYPES = ['none', 'oauth', 'api_key'] as const;
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/**
 * コネクタの認証の設定。**秘密の値は持たない**（クライアント シークレットと会社の鍵は別の表に暗号化して持つ）。
 *
 * @see 仕様書 第12.11.6節
 */
export interface ConnectorAuth {
  type: ConnectorAuthType;
  /** よく使うサービスの型の ID（`slack` など。第12.11.6.7節）。 */
  preset?: string;
  /** `oauth`: 許可の画面の URL。無ければ相手のサーバの案内から見つける。 */
  authorizeUrl?: string;
  /** `oauth`: 認可を受け取る URL。 */
  tokenUrl?: string;
  /** `oauth`: 求める権限。 */
  scopes?: string[];
  /** `oauth`: 取り消しの URL（あれば、利用者が取り消すときに相手の側でも取り消す）。 */
  revokeUrl?: string;
  /** `oauth`: 許可したアカウントの表示名を問い合わせる URL（Slack の `auth.test` など）。 */
  accountUrl?: string;
  /** `api_key`: 鍵を載せる見出しの名前。既定は `Authorization`（`Bearer <鍵>` の形）。 */
  header?: string;
}

/** コネクタが提供するツールの宣言。 */
export interface ConnectorToolDeclaration {
  /** MCP サーバでのツールの名前。 */
  name: string;
  /** すること。導入の同意の画面とヘルプに出す。 */
  description: string;
  /** 推奨の危険度。導入の同意で管理者が認めたものを使う（仕様書 第12.11.2節）。 */
  risk: RiskLevel;
  /**
   * 引数の定義。MCP サーバの道具の一覧（`inputSchema`）から取る。推論への説明と、呼ぶ前の確かめに使う（第9.4.4節）。
   *
   * @remarks 無ければ推論は引数を知らずに呼ぶ。登録と「道具を取り直す」のときに入る
   */
  args?: ToolArgsSchema;
}

/** コネクタの宣言（`connectors/*.json`）。 */
export interface ConnectorDeclaration {
  id: string;
  name: string;
  description?: string;
  transport: 'http';
  url: string;
  auth: ConnectorAuth;
  tools: ConnectorToolDeclaration[];
}

/** 業務エージェントから使うときのツールの名前（`<コネクタの ID>.<ツールの名前>`）。 */
export function connectorToolName(connectorId: string, toolName: string): string {
  return `${connectorId}.${toolName}`;
}

/**
 * コネクタの宣言を確かめる。
 *
 * @param reserved 使えないコネクタの ID（内蔵のツールの名前の頭の部分と、ほかの拡張機能のコネクタ）
 * @returns 見つかった問題。空なら使える
 */
export function checkConnector(c: ConnectorDeclaration, reserved: ReadonlySet<string>): string[] {
  const p: string[] = [];
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
    p.push('id は英小文字・数字・ハイフンで書いてください（例: deepwiki）');
  } else if (reserved.has(c.id)) {
    p.push(`id ${c.id} はすでに使われています（内蔵のツールかほかのコネクタと重なります）`);
  }
  if (!c.name) p.push('name がありません');
  if (c.transport !== 'http') {
    p.push('transport は http だけを使えます。M2Office の中でプログラムを起動する方式（stdio）は使えません');
  }
  if (!isAllowedUrl(c.url)) p.push('url は https で書いてください（開発用の localhost だけは http を使えます）');
  if (!CONNECTOR_AUTH_TYPES.includes(c.auth?.type)) {
    p.push(`auth.type は ${CONNECTOR_AUTH_TYPES.join('・')} のいずれかです`);
  } else {
    // 認可の口は https に限る（開発用の localhost を除く。第12.11.6.2節）
    for (const k of ['authorizeUrl', 'tokenUrl', 'revokeUrl', 'accountUrl'] as const) {
      const v = c.auth[k];
      if (v !== undefined && !isAllowedUrl(v)) p.push(`auth.${k} は https で書いてください`);
    }
    if (c.auth.scopes !== undefined && (!Array.isArray(c.auth.scopes) || c.auth.scopes.some((s) => typeof s !== 'string' || !/^[\w:.\/-]+$/.test(s)))) {
      p.push('auth.scopes は権限の名前の並びで書いてください');
    }
    if (c.auth.header !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(c.auth.header)) {
      p.push('auth.header は見出しの名前（英数字とハイフン）で書いてください');
    }
  }
  // 認証の要る接続は、登録した直後は道具が分からない（認可のあとで問い合わせる。第12.11.6.2節）
  const needsAuth = c.auth?.type === 'oauth' || c.auth?.type === 'api_key';
  if (!Array.isArray(c.tools) || (c.tools.length === 0 && !needsAuth)) {
    p.push('tools に使うツールを 1 つ以上宣言してください');
  } else {
    const seen = new Set<string>();
    for (const t of c.tools) {
      if (!t.name || !/^[A-Za-z0-9_-]+$/.test(t.name)) p.push(`tools: 名前 ${String(t.name)} は英数字・下線・ハイフンで書いてください`);
      if (seen.has(t.name)) p.push(`tools: ${t.name} が重なっています`);
      seen.add(t.name);
      if (!t.description) p.push(`tools: ${t.name} の description（すること）がありません`);
      if (!RISK_LEVELS.includes(t.risk)) p.push(`tools: ${t.name} の risk は ${RISK_LEVELS.join('・')} のいずれかです`);
    }
  }
  return p;
}

function isAllowedUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * コネクタの宣言から、業務エージェントが呼べるツールを作る。
 *
 * @param client MCP サーバへの接続口。省略すると、呼ぶと「接続されていません」を返すツールになる（検証用）
 *
 * @remarks
 * 危険度は宣言の推奨の危険度（導入の同意で管理者が認めたもの）。承認・操作の確認・監査ログは
 * 内蔵のツールと同じくエンジンが扱う（仕様書 第12.11.3節）。
 * 応答は外部のデータとして返し、失敗は「取得できませんでした」として返す。推測で埋めない。
 */
/** 会社の接続の道具の名前の形（`<接続の ID>.<道具>`）。 */
const CONNECTION_TOOL = /^[a-z0-9][a-z0-9-]*\.[A-Za-z0-9_-]+$/;

/**
 * 会社の接続の道具を指す名前か（仕様書 第12.11.0節）。内蔵の道具の頭の部分（`gmail` など）で始まるものは違う。
 *
 * @param builtinPrefixes 内蔵の道具の名前の頭の部分
 */
export function isConnectionToolName(name: string, builtinPrefixes: ReadonlySet<string>): boolean {
  return CONNECTION_TOOL.test(name) && !builtinPrefixes.has(name.split('.')[0]!);
}

/**
 * 同梱していない会社の接続の道具を、業務を組み立てるときだけの仮の道具にする（仕様書 第12.11.2節、ADR-0037）。
 *
 * @remarks
 * 危険度は組み立てのときには分からない。業務の組み立て（`compileSkill`）が作業の段と送る段の両方に置き、
 * 実行のときは会社の接続（管理者が決めた危険度）の道具に置き換わる。会社に接続が無ければ、その業務は使えない
 */
export function connectionPlaceholder(name: string): Tool {
  const [id, tool] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
  return {
    name, risk: 'read',
    description: `会社の接続「${id}」の道具 ${tool}`,
    activityLabel: `${id}に問い合わせています`,
    helpText: `会社の接続「${id}」の道具 ${tool} を使います（接続は管理者ページの「接続」で登録します）`,
    async invoke() {
      return { error: `取得できませんでした: 会社の接続「${id}」が登録されていません` };
    },
  };
}

/**
 * 認証の要る接続で、呼ぶときに付ける見出しを渡す口（仕様書 第12.11.6.4節）。
 *
 * @remarks
 * `oauth` は**依頼した本人の認可**、`api_key` は会社の鍵を返す。ほかの人の認可で代わりに呼ばない（不変則 I-9）。
 * 認可はワーカーの中だけで使い、推論にも画面にも渡さない。
 */
export interface ConnectionAuthProvider {
  /** 呼ぶときに付ける見出し。付けられなければ、利用者に伝える理由を返す。 */
  headersFor(tenantId: string, userId: string, c: ConnectorDeclaration): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }>;
  /**
   * 相手に断られた（401）ときに呼ぶ。更新できれば新しい見出しを返し、できなければ認可を消して理由を返す。
   *
   * @remarks 更新は 1 回だけ試す（第12.11.6.4節）。
   */
  onRejected(tenantId: string, userId: string, c: ConnectorDeclaration): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }>;
}

/** 相手に断られた（認証が要る・認可が無効）とみなす応答か。 */
function isAuthRejected(error: string): boolean {
  return /401|認証が必要/.test(error);
}

export function connectorTools(c: ConnectorDeclaration, client?: McpClient, auth?: ConnectionAuthProvider): Tool[] {
  return c.tools.map((t) => ({
    name: connectorToolName(c.id, t.name),
    risk: t.risk,
    description: `${t.description}（${c.name}）`,
    activityLabel: `${c.name}に問い合わせています`,
    helpText: `${t.description}（外部のサービス「${c.name}」を使います）`,
    ...(t.args ? { args: t.args } : {}),
    async invoke(args: Record<string, unknown>, ctx) {
      if (!client) return { error: '取得できませんでした: コネクタが接続されていません' };
      let headers: Record<string, string> | undefined;
      if (c.auth.type !== 'none') {
        if (!auth) return { error: '取得できませんでした: 認証の要る接続を使う準備がありません', connector: c.id };
        const h = await auth.headersFor(ctx.tenantId, ctx.userId, c);
        if (!h.ok) return { error: `取得できませんでした: ${h.error}`, connector: c.id, needsConnection: c.id };
        headers = h.headers;
      }
      let res = await client.callTool(c.url, t.name, args, headers);
      // 断られたら、認可を更新して 1 回だけ呼び直す（第12.11.6.4節）
      if (!res.ok && c.auth.type !== 'none' && auth && isAuthRejected(res.error)) {
        const again = await auth.onRejected(ctx.tenantId, ctx.userId, c);
        if (!again.ok) return { error: `取得できませんでした: ${again.error}`, connector: c.id, needsConnection: c.id };
        res = await client.callTool(c.url, t.name, args, again.headers);
      }
      if (!res.ok) return { error: `取得できませんでした: ${res.error}`, connector: c.id };
      // 外部のデータであり、指示ではない（不変則 I-6）
      return { source: 'external', connector: c.id, text: res.text, truncated: res.truncated };
    },
  }));
}
