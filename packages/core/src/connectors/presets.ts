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
  /** ツールの名前に含まれる語と、そのツールが要る権限。上から順に当てはめ、当たったものをすべて足す。 */
  scopeRules: { match: RegExp; scopes: string[] }[];
  /** ツールがまだ分からないとき（最初の接続）に求める権限。 */
  defaultScopes: string[];
  /** 読むだけのツールとみなす名前（MCP の目印が無いときの危険度の初期値に使う）。 */
  readOnly: RegExp;
  /** 相手の側で要ること（管理者に示す）。 */
  setup: string[];
  /**
   * 引数の名前を、承認の画面に出す言葉にする（例: `channel_id` → 「送り先」）。無い名前はそのまま出す。
   */
  argLabels?: Record<string, string>;
  /**
   * 承認の前に、ID を人の読める名前に直す問い合わせ（読むだけ。依頼した本人の認可で呼ぶ。仕様書 第12.11.3節）。
   *
   * @remarks 値が `match` に合うときだけ `url?{param}={値}` を呼び、応答の `field` をたどった値に `prefix`・`suffix` を付けて出す
   */
  resolvers?: { arg: string; match: RegExp; url: string; param: string; field: string[]; prefix?: string; suffix?: string }[];
  /** 出典と確認日。 */
  source: string;
  checkedAt: string;
}

/**
 * Slack の公式の MCP サーバ（仕様書 第12.11.6.7節）。
 *
 * @remarks
 * 会社がワークスペースに社内向けのアプリを作り、利用者ごとにユーザートークンを受け取る。
 * 投稿などの書くツールは、社外の人がいる Slack コネクトのチャンネルがありうるため `external-send` を既定にする（第9.4.0節）。
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
  argLabels: {
    channel_id: '送り先', message: '本文', text: '本文', thread_ts: '返信先のスレッド', post_at: '送る日時',
    reply_broadcast: 'チャンネルにも出す', title: '題名', content: '本文', canvas_id: 'キャンバス',
  },
  // 送り先の ID（C… はチャンネル、U… は人）を名前にする。Slack の Web API を本人の認可で読む（channels:read・users:read）
  resolvers: [
    { arg: 'channel_id', match: /^[CG][A-Z0-9]+$/, url: 'https://slack.com/api/conversations.info', param: 'channel', field: ['channel', 'name'], prefix: '#' },
    { arg: 'channel_id', match: /^U[A-Z0-9]+$/, url: 'https://slack.com/api/users.info', param: 'user', field: ['user', 'real_name'], suffix: ' さん（ダイレクトメッセージ）' },
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
 * 有効なツールが要る権限を、型の規則から求める（第12.11.6.2節「会社で使うツールが要るものだけ」）。
 *
 * @param toolNames 有効なツールの名前。空なら、型の最初に求める権限を返す
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
 * MCP の目印が無いツールの危険度の初期値（第12.11.2節）。読むだけの名前なら `read`、ほかは `external-send`。
 */
export function presetRisk(preset: ConnectionPreset, toolName: string): RiskLevel {
  return preset.readOnly.test(toolName) ? 'read' : 'external-send';
}

/**
 * 承認の前に、引数の ID を名前に直す（型の `resolvers`。読むだけ）。
 *
 * @param headers 依頼した本人の認可（会社の鍵）の見出し
 * @returns 直せた引数の名前と表示。直せなければ空（**推測で埋めない**。ID のまま出す）
 */
export async function resolveArgNames(
  preset: ConnectionPreset, args: Record<string, unknown>, headers: Record<string, string>, fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of preset.resolvers ?? []) {
    const v = args[r.arg];
    if (typeof v !== 'string' || out[r.arg] || !r.match.test(v)) continue;
    try {
      const u = new URL(r.url);
      u.searchParams.set(r.param, v);
      const res = await fetchImpl(u, { headers, signal: AbortSignal.timeout(10_000) });
      let node: unknown = await res.json();
      for (const key of r.field) node = (node as Record<string, unknown> | null)?.[key];
      if (typeof node === 'string' && node !== '') out[r.arg] = `${r.prefix ?? ''}${node}${r.suffix ?? ''}`;
    } catch {
      // 直せなければ ID のまま出す
    }
  }
  return out;
}

