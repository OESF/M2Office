/**
 * @file 認証の要る会社の接続（`oauth`・`api_key`）の単体テスト。
 *
 * 道具を呼ぶときに依頼した本人の認可を付けること、接続していなければ「接続が要ります」で止めること、
 * 断られたら更新して 1 回だけ呼び直すこと、更新できなければ認可を消して本人に知らせること、
 * 会社の鍵を見出しに載せること、許可の流れ（相手の案内の発見・許可の画面の URL・認可の受け取り）、
 * Slack の型が道具から権限と危険度を決めることを確かめる。
 *
 * @see 仕様書 第12.11.6節 認証の要る接続
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_PRESETS, ConnectionCredentials, SecretBox, argsFromInputSchema, buildConnectionAuthUrl, describeCall, checkConnector, connectorTools,
  discoverOAuthEndpoints, exchangeConnectionCode, presetById, presetRisk, resolveArgNames, scopesForTools,
  type ConnectionAuthProvider, type ConnectionSecret, type ConnectorDeclaration, type McpClient, type Repository, type UserConnection,
} from '../src/index.js';

const box = new SecretBox('test-secret-key-for-connection-auth-000');
const NOW = new Date('2026-09-27T03:00:00.000Z');

const slack: ConnectorDeclaration = {
  id: 'slack', name: 'Slack', transport: 'http', url: 'https://mcp.slack.com/mcp',
  auth: { type: 'oauth', preset: 'slack', authorizeUrl: 'https://slack.com/oauth/v2_user/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.user.access' },
  tools: [{ name: 'slack_search_public', description: '検索', risk: 'read' }],
};
const ctx = { tenantId: 't', userId: 'u' } as never;

/** 呼ばれた見出しを控え、決めた順に応答する MCP の接続口。 */
function fakeMcp(results: ({ ok: true; text: string } | { ok: false; error: string })[]) {
  const calls: (Record<string, string> | undefined)[] = [];
  const client: McpClient = {
    listTools: async () => ({ ok: true, tools: [] }),
    callTool: async (_u, _n, _a, headers) => {
      calls.push(headers);
      const r = results.shift() ?? { ok: true as const, text: 'ok' };
      return r.ok ? { ...r, truncated: false } : r;
    },
  };
  return { client, calls };
}

test('認証の要る接続の道具は、依頼した本人の認可を付けて呼ぶ', async () => {
  const seen: string[] = [];
  const auth: ConnectionAuthProvider = {
    headersFor: async (_t, userId) => { seen.push(userId); return { ok: true, headers: { Authorization: `Bearer token-of-${userId}` } }; },
    onRejected: async () => ({ ok: false, error: 'x' }),
  };
  const { client, calls } = fakeMcp([{ ok: true, text: '結果' }]);
  const [tool] = connectorTools(slack, client, auth);
  const out = await tool!.invoke({ query: 'a' }, ctx) as Record<string, unknown>;
  assert.equal(out['text'], '結果');
  assert.deepEqual(seen, ['u'], 'ほかの人の認可で代わりに呼ばない');
  assert.deepEqual(calls[0], { Authorization: 'Bearer token-of-u' });
});

test('接続していなければ呼ばずに「接続が要ります」を返す。断られたら更新して 1 回だけ呼び直す', async () => {
  const missing: ConnectionAuthProvider = {
    headersFor: async () => ({ ok: false, error: '「Slack」との接続が要ります' }),
    onRejected: async () => ({ ok: false, error: 'x' }),
  };
  const none = fakeMcp([]);
  const out = await connectorTools(slack, none.client, missing)[0]!.invoke({}, ctx) as Record<string, unknown>;
  assert.match(String(out['error']), /接続が要ります/);
  assert.equal(out['needsConnection'], 'slack');
  assert.equal(none.calls.length, 0, 'MCP サーバは呼ばない');

  const refreshed: ConnectionAuthProvider = {
    headersFor: async () => ({ ok: true, headers: { Authorization: 'Bearer old' } }),
    onRejected: async () => ({ ok: true, headers: { Authorization: 'Bearer new' } }),
  };
  const retry = fakeMcp([{ ok: false, error: '認証が必要です（401）' }, { ok: true, text: '二回目' }]);
  const again = await connectorTools(slack, retry.client, refreshed)[0]!.invoke({}, ctx) as Record<string, unknown>;
  assert.equal(again['text'], '二回目');
  assert.deepEqual(retry.calls.map((h) => h?.['Authorization']), ['Bearer old', 'Bearer new']);
});

/** 認可を記憶に持つ永続化層。 */
function repoOf(secret: Partial<ConnectionSecret> | null, user: Partial<UserConnection> | null) {
  const state = {
    secret: secret ? { tenantId: 't', connectionId: 'slack', clientId: null, clientSecretEnc: null, apiKeyEnc: null, updatedBy: 'a', updatedAt: '', ...secret } as ConnectionSecret : null,
    user: user ? {
      tenantId: 't', userId: 'u', connectionId: 'slack', accessTokenEnc: box.encrypt('access-1'), refreshTokenEnc: null,
      expiresAt: null, scopes: [], accountLabel: '', clientId: 'client-1', connectedAt: '', updatedAt: '', ...user,
    } as UserConnection : null,
    audits: [] as string[], notes: [] as string[],
  };
  const repo = {
    getConnectionSecret: async () => state.secret,
    getUserConnection: async () => state.user,
    saveUserConnection: async (c: UserConnection) => { state.user = c; },
    deleteUserConnection: async () => { const had = !!state.user; state.user = null; return had; },
    appendAudit: async (e: { action: string }) => { state.audits.push(e.action); },
    createNotification: async (n: { title: string }) => { state.notes.push(n.title); },
  } as unknown as Repository;
  return { repo, state };
}

const oauthSecret = { clientId: 'client-1', clientSecretEnc: box.encrypt('secret-1') };

test('会社の鍵（api_key）を見出しに載せる。既定は Bearer、指定があればその見出し', async () => {
  const { repo } = repoOf({ apiKeyEnc: box.encrypt('KEY') }, null);
  const creds = new ConnectionCredentials({ repo, box });
  const c: ConnectorDeclaration = { ...slack, id: 'crm', auth: { type: 'api_key' } };
  assert.deepEqual(await creds.headersFor('t', 'u', c), { ok: true, headers: { Authorization: 'Bearer KEY' } });
  assert.deepEqual(await creds.headersFor('t', 'u', { ...c, auth: { type: 'api_key', header: 'X-API-Key' } }), { ok: true, headers: { 'X-API-Key': 'KEY' } });
  const empty = new ConnectionCredentials({ repo: repoOf({}, null).repo, box });
  const r = await empty.headersFor('t', 'u', c);
  assert.ok(!r.ok && /鍵が登録されていません/.test(r.error));
});

test('oauth: 接続していない・会社の設定が無いときは理由を返す。接続していれば本人の認可を返す', async () => {
  const noUser = await new ConnectionCredentials({ repo: repoOf(oauthSecret, null).repo, box }).headersFor('t', 'u', slack);
  assert.ok(!noUser.ok && /接続が要ります/.test(noUser.error));
  const noClient = await new ConnectionCredentials({ repo: repoOf(null, {}).repo, box }).headersFor('t', 'u', slack);
  assert.ok(!noClient.ok && /設定が済んでいません/.test(noClient.error));
  const ok = await new ConnectionCredentials({ repo: repoOf(oauthSecret, {}).repo, box }).headersFor('t', 'u', slack);
  assert.deepEqual(ok, { ok: true, headers: { Authorization: 'Bearer access-1' } });
});

test('oauth: 期限が近ければ更新して保存する。更新できなければ認可を消し、本人に知らせる', async () => {
  const { repo, state } = repoOf(oauthSecret, { refreshTokenEnc: box.encrypt('refresh-1'), expiresAt: '2026-09-27T03:00:30.000Z' });
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(JSON.stringify({ ok: true, access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 43200 }), { status: 200 });
  }) as typeof fetch;
  const creds = new ConnectionCredentials({ repo, box, fetchImpl, now: () => NOW });
  assert.deepEqual(await creds.headersFor('t', 'u', slack), { ok: true, headers: { Authorization: 'Bearer access-2' } });
  assert.match(bodies[0]!, /grant_type=refresh_token/);
  assert.match(bodies[0]!, /client_secret=secret-1/);
  assert.equal(box.decrypt(state.user!.refreshTokenEnc!), 'refresh-2');
  assert.equal(state.user!.expiresAt, '2026-09-27T15:00:00.000Z');

  const failing = repoOf(oauthSecret, { refreshTokenEnc: box.encrypt('refresh-1') });
  const bad = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_refresh_token' }), { status: 200 })) as unknown as typeof fetch;
  const r = await new ConnectionCredentials({ repo: failing.repo, box, fetchImpl: bad, now: () => NOW }).onRejected('t', 'u', slack);
  assert.ok(!r.ok && /接続が切れました/.test(r.error));
  assert.equal(failing.state.user, null, '保存した認可を消す');
  assert.deepEqual(failing.state.audits, ['connection.oauth.lost']);
  assert.deepEqual(failing.state.notes, ['Slackとの接続が切れました']);
});

test('oauth: 会社がクライアント ID を替えたら、前の認可は使わずに消す', async () => {
  const { repo, state } = repoOf({ clientId: 'client-2', clientSecretEnc: box.encrypt('s') }, {});
  const r = await new ConnectionCredentials({ repo, box, now: () => NOW }).headersFor('t', 'u', slack);
  assert.ok(!r.ok && /接続が切れました/.test(r.error));
  assert.equal(state.user, null);
});

test('許可の流れ: 相手の案内から口を見つけ、許可の画面の URL を作り、Slack の形の応答から認可を取り出す', async () => {
  const docs: Record<string, unknown> = {
    'https://mcp.slack.com/.well-known/oauth-protected-resource': { authorization_servers: ['https://mcp.slack.com'], scopes_supported: ['chat:write'] },
    'https://mcp.slack.com/.well-known/oauth-authorization-server': {
      authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize', token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
      code_challenge_methods_supported: ['S256'],
    },
  };
  const fetchDocs = (async (url: string) => docs[url] ? new Response(JSON.stringify(docs[url])) : new Response('', { status: 404 })) as typeof fetch;
  const found = await discoverOAuthEndpoints('https://mcp.slack.com/mcp', fetchDocs);
  assert.deepEqual(found, {
    authorizeUrl: 'https://slack.com/oauth/v2_user/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.user.access',
    scopesSupported: ['chat:write'], pkce: true,
  });
  assert.equal(await discoverOAuthEndpoints('https://none.example/mcp', fetchDocs), null, '見つからなければ null');

  const url = new URL(buildConnectionAuthUrl({
    authorizeUrl: found!.authorizeUrl, clientId: 'c', redirectUri: 'https://m2o.example/v1/oauth/connection/callback',
    scopes: ['search:read.public', 'chat:write'], state: 'st', codeChallenge: 'ch',
  }));
  assert.equal(url.searchParams.get('scope'), 'search:read.public chat:write');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  const exchange = (async () => new Response(JSON.stringify({
    ok: true, access_token: 'xoxp-1', token_type: 'user', authed_user: { id: 'U1', scope: 'search:read.public,chat:write' }, team: { id: 'T1' },
  }))) as unknown as typeof fetch;
  const tokens = await exchangeConnectionCode({ tokenUrl: 'https://t', clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', codeVerifier: 'v' }, exchange, NOW);
  assert.deepEqual(tokens, { accessToken: 'xoxp-1', refreshToken: null, expiresAt: null, scopes: ['search:read.public', 'chat:write'] });
  const refused = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }))) as unknown as typeof fetch;
  await assert.rejects(exchangeConnectionCode({ tokenUrl: 'https://t', clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }, refused), /invalid_code/);
});

test('Slack の型: 有効な道具から権限を決め、目印の無い書く道具は external-send にする', () => {
  const preset = presetById('slack')!;
  assert.ok(CONNECTION_PRESETS.includes(preset));
  assert.deepEqual(new Set(scopesForTools(preset, ['slack_search_public', 'slack_read_channel'])),
    new Set(['search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im', 'channels:history', 'groups:history', 'mpim:history', 'im:history']));
  assert.ok(scopesForTools(preset, ['slack_send_message']).includes('chat:write'));
  assert.deepEqual(scopesForTools(preset, []), preset.defaultScopes, '道具が分からないときは最初の権限');
  assert.equal(presetRisk(preset, 'slack_search_public'), 'read');
  assert.equal(presetRisk(preset, 'slack_read_channel'), 'read');
  assert.equal(presetRisk(preset, 'slack_send_message'), 'external-send');
  assert.equal(presetRisk(preset, 'slack_create_canvas'), 'external-send');
  // 型の宣言そのものが接続の検証を通る（道具は認可のあとで問い合わせるため空でよい）
  assert.deepEqual(checkConnector({ id: 'slack', name: 'Slack', transport: 'http', url: preset.url, auth: preset.auth, tools: [] }, new Set()), []);
});

test('MCP の道具の引数の定義（inputSchema）を推論に渡す形に直し、道具に付ける（引数なしで呼ばないため）', () => {
  const args = argsFromInputSchema({
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索の言葉' },
      limit: { type: 'integer', description: '件数' },
      sort: { type: 'string', enum: ['score', 'timestamp'] },
      channels: { type: 'array', items: { type: 'string' } },
      cursor: { type: ['string', 'null'] },
    },
    required: ['query', 'unknown'],
  });
  assert.deepEqual(args, {
    properties: {
      query: { type: 'string', description: '検索の言葉' },
      limit: { type: 'number', description: '件数' },
      sort: { type: 'string', description: '', enum: ['score', 'timestamp'] },
      channels: { type: 'array', description: '', items: { type: 'string', description: '' } },
      cursor: { type: 'string', description: '' },
    },
    required: ['query'],
  }, '知らない必須の名前は落とす');
  assert.equal(argsFromInputSchema({ type: 'object', properties: {} }), undefined);
  const [tool] = connectorTools({ ...slack, auth: { type: 'none' }, tools: [{ ...slack.tools[0]!, args }] });
  assert.deepEqual(tool!.args, args);
});

test('承認の画面: 会社の接続の道具は、サービスと道具の名前と、送り先を含むすべての引数を出す（相手の長い説明は出さない）', () => {
  const [tool] = connectorTools({ ...slack, auth: { type: 'none' }, tools: [{ name: 'slack_send_message', description: 'Sends a message to a Slack channel or user. '.repeat(20), risk: 'external-send' }] });
  assert.equal(tool!.helpText, '外部のサービス「Slack」の道具「slack_send_message」を使います');
  assert.deepEqual(tool!.connection, { id: 'slack', name: 'Slack', tool: 'slack_send_message' });
  const text = describeCall(
    { name: 'slack.slack_send_message', args: { channel_id: 'C0C4WEH1TNY', message: 'M2Office からの投稿テストです' } },
    { helpText: () => tool!.helpText, connectionOf: () => ({ service: 'Slack', tool: 'slack_send_message', risk: 'external-send' }) },
  );
  assert.equal(text, '**Slackへ送ります**（slack_send_message）\n- channel_id: C0C4WEH1TNY\n- message: M2Office からの投稿テストです');
  assert.ok(!text.includes('Sends a message'));
});

test('承認の前に、Slack の送り先の ID をチャンネル名に直し、引数の名前を「送り先」「本文」にする（読むだけ・本人の認可）', async () => {
  const preset = presetById('slack')!;
  const seen: string[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    seen.push(`${url.toString()} ${(init.headers as Record<string, string>)['Authorization']}`);
    return new Response(JSON.stringify(url.pathname.endsWith('conversations.info') ? { ok: true, channel: { name: '研究開発' } } : { ok: false }));
  }) as unknown as typeof fetch;
  const names = await resolveArgNames(preset, { channel_id: 'C0C4WEH1TNY', message: 'x' }, { Authorization: 'Bearer tok-u' }, fetchImpl);
  assert.deepEqual(names, { channel_id: '#研究開発' });
  assert.deepEqual(seen, ['https://slack.com/api/conversations.info?channel=C0C4WEH1TNY Bearer tok-u']);
  assert.deepEqual(await resolveArgNames(preset, { channel_id: 'U123' }, {}, fetchImpl), {}, '直せなければ ID のまま（推測で埋めない）');

  const text = describeCall(
    { name: 'slack.slack_send_message', args: { channel_id: 'C0C4WEH1TNY', message: '投稿テスト' }, shown: JSON.stringify(names) },
    { connectionOf: () => ({ service: 'Slack', tool: 'slack_send_message', risk: 'external-send', labels: preset.argLabels }) },
  );
  assert.equal(text, '**Slackへ送ります**（slack_send_message）\n- 送り先: #研究開発（C0C4WEH1TNY）\n- 本文: 投稿テスト');
});
