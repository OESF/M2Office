/**
 * @file よく使うサービスの登録の型（仕様書 第12.11.6.7節）。最初は Slack。
 *
 * 中小企業の管理者が、相手のサービスの認可の細かい決まり（認可の口・権限の名前）を調べなくて済むようにする。
 * 型は宣言であり、プログラムは持たない。相手の変更に合わせて直し、確認日を書く。
 */

import type { RiskLevel } from '@m2office/shared';
import type { ConnectorAuth } from '../extensions/connectors.js';

/** 登録の型。 */
export interface ConnectionPreset {
  id: string;
  name: string;
  description: string;
  /** MCP サーバの URL。 */
  url: string;
  auth: ConnectorAuth;
  /** 道具の名前に含まれる語と、その道具が要る権限。上から順に当てはめ、当たったものをすべて足す。 */
  scopeRules: { match: RegExp; scopes: string[] }[];
  /** 道具がまだ分からないとき（最初の接続）に求める権限。 */
  defaultScopes: string[];
  /** 読むだけの道具とみなす名前（MCP の目印が無いときの危険度の初期値に使う）。 */
  readOnly: RegExp;
  /** 相手の側で要ること（管理者に示す）。 */
  setup: string[];
  /** 出典と確認日。 */
  source: string;
  checkedAt: string;
}

/**
 * Slack の公式の MCP サーバ（仕様書 第12.11.6.7節）。
 *
 * @remarks
 * 会社がワークスペースに社内向けのアプリを作り、利用者ごとにユーザートークンを受け取る。
 * 投稿などの書く道具は、社外の人がいる Slack コネクトのチャンネルがありうるため `external-send` を既定にする（第9.4.0節）。
 */
const SLACK: ConnectionPreset = {
  id: 'slack',
  name: 'Slack',
  description: 'Slack のメッセージ・チャンネル・キャンバスを検索し、読み、送ります',
  url: 'https://mcp.slack.com/mcp',
  auth: {
    type: 'oauth', preset: 'slack',
    authorizeUrl: 'https://slack.com/oauth/v2_user/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.user.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    accountUrl: 'https://slack.com/api/auth.test',
  },
  scopeRules: [
    { match: /search.*file|file.*search/, scopes: ['search:read.files'] },
    { match: /search.*user|user.*search/, scopes: ['search:read.users'] },
    { match: /search/, scopes: ['search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im'] },
    { match: /read_(channel|thread)|history/, scopes: ['channels:history', 'groups:history', 'mpim:history', 'im:history'] },
    { match: /read_file|get_file(?!_upload)/, scopes: ['files:read'] },
    { match: /upload/, scopes: ['files:write'] },
    { match: /emoji/, scopes: ['emoji:read'] },
    { match: /send_message|schedule|draft/, scopes: ['chat:write'] },
    { match: /create_(channel|conversation)/, scopes: ['channels:write', 'groups:write', 'im:write', 'mpim:write'] },
    { match: /add_reaction/, scopes: ['reactions:write'] },
    { match: /get_reaction/, scopes: ['reactions:read'] },
    { match: /read_canvas/, scopes: ['canvases:read'] },
    { match: /(create|update)_canvas/, scopes: ['canvases:read', 'canvases:write'] },
    { match: /user_profile|read_user/, scopes: ['users:read', 'users:read.email'] },
    { match: /channel_members|user_channels|list_channels/, scopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read'] },
    { match: /_list|list_/, scopes: ['lists:read', 'lists:write'] },
  ],
  defaultScopes: [
    'search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im', 'search:read.users',
    'channels:history', 'groups:history', 'mpim:history', 'im:history',
    'channels:read', 'groups:read', 'users:read', 'canvases:read', 'chat:write',
  ],
  readOnly: /search|read|get_(?!file_upload)|list_(?!.*(create|update))|emoji/,
  setup: [
    'Slack のワークスペースに社内向けのアプリを作る（非掲載のアプリは Slack の MCP を使えません）',
    'アプリの「OAuth & Permissions」に、この画面の戻り先の URL を登録する',
    'アプリの User Token Scopes に、この画面に出る権限を足す',
    'アプリの設定の「Agents & AI Apps」（app-assistant）で、Slack の MCP サーバの利用をオンにする（オフのままだと「App is not enabled for Slack MCP server access」で断られます）',
    'ワークスペースの管理者がアプリを承認する運用なら、承認を受ける',
  ],
  source: 'Slack Developer Docs「Slack MCP server overview」https://docs.slack.dev/ai/slack-mcp-server/',
  checkedAt: '2026-09-27',
};

/** M2Office が持つ登録の型。 */
export const CONNECTION_PRESETS: readonly ConnectionPreset[] = [SLACK];

/** 型を ID で引く。無ければ `undefined`。 */
export function presetById(id: string | undefined): ConnectionPreset | undefined {
  return id ? CONNECTION_PRESETS.find((p) => p.id === id) : undefined;
}

/**
 * 有効な道具が要る権限を、型の規則から求める（第12.11.6.2節「会社で使う道具が要るものだけ」）。
 *
 * @param toolNames 有効な道具の名前。空なら、型の最初に求める権限を返す
 */
export function scopesForTools(preset: ConnectionPreset, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [...preset.defaultScopes];
  const out = new Set<string>();
  for (const name of toolNames) {
    for (const r of preset.scopeRules) if (r.match.test(name)) r.scopes.forEach((s) => out.add(s));
  }
  return out.size > 0 ? [...out] : [...preset.defaultScopes];
}

/**
 * MCP の目印が無い道具の危険度の初期値（第12.11.2節）。読むだけの名前なら `read`、ほかは `external-send`。
 */
export function presetRisk(preset: ConnectionPreset, toolName: string): RiskLevel {
  return preset.readOnly.test(toolName) ? 'read' : 'external-send';
}
