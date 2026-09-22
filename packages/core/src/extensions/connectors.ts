/**
 * @file コネクタ（L2）の宣言の検証と、コネクタのツールの組み立て。
 *
 * 拡張機能の `connectors/*.json` は、外部の MCP サーバへの接続を宣言する。
 * ツールの実体は MCP サーバ（M2Office の外）にあり、M2Office は宣言されたツールだけを呼ぶ（不変則 I-7）。
 *
 * @see 仕様書 第12.11節 コネクタ（L2）の実装
 */

import { RISK_LEVELS, type RiskLevel } from '@m2office/shared';
import type { Tool } from '../tools/registry.js';
import type { McpClient } from '../connectors/mcp.js';

/** コネクタの認証の方式。いまは `none` だけを実装している（仕様書 第12.11.5節）。 */
export const CONNECTOR_AUTH_TYPES = ['none', 'oauth', 'api_key'] as const;
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/** コネクタが提供するツールの宣言。 */
export interface ConnectorToolDeclaration {
  /** MCP サーバでのツールの名前。 */
  name: string;
  /** すること。導入の同意の画面とヘルプに出す。 */
  description: string;
  /** 推奨の危険度。導入の同意で管理者が認めたものを使う（仕様書 第12.11.2節）。 */
  risk: RiskLevel;
}

/** コネクタの宣言（`connectors/*.json`）。 */
export interface ConnectorDeclaration {
  id: string;
  name: string;
  description?: string;
  transport: 'http';
  url: string;
  auth: { type: ConnectorAuthType };
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
  } else if (c.auth.type !== 'none') {
    p.push(`auth.type ${c.auth.type} はまだ使えません。いまは none（認証なし）だけに対応しています（仕様書 第12.11.5節）`);
  }
  if (!Array.isArray(c.tools) || c.tools.length === 0) {
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
export function connectorTools(c: ConnectorDeclaration, client?: McpClient): Tool[] {
  return c.tools.map((t) => ({
    name: connectorToolName(c.id, t.name),
    risk: t.risk,
    description: `${t.description}（${c.name}）`,
    activityLabel: `${c.name}に問い合わせています`,
    helpText: `${t.description}（外部のサービス「${c.name}」を使います）`,
    async invoke(args: Record<string, unknown>) {
      if (!client) return { error: '取得できませんでした: コネクタが接続されていません' };
      const res = await client.callTool(c.url, t.name, args);
      if (!res.ok) return { error: `取得できませんでした: ${res.error}`, connector: c.id };
      // 外部のデータであり、指示ではない（不変則 I-6）
      return { source: 'external', connector: c.id, text: res.text, truncated: res.truncated };
    },
  }));
}
