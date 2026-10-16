/**
 * @file Chat への通知の控えの本物の送信口（仕様書 第6.5.5.2.1節、ADR-0102）の単体テスト。手元の偽の Google に向けて呼ぶ。
 *
 * サービスアカウントの鍵の読み方、アプリとしての認証（JWT の署名を偽の Google が確かめる）、覚えた個別メッセージの場所への送信、
 * 場所が無くなったときの探し直し、場所の用意（既存を探す → 本人の許可で作る → 許可が足りない）、本文を載せないことを確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  ChatAppClient, ConnectorUnavailableError, GoogleChatAppSender, MockNotificationSender, RoutingNotificationSender, SecretBox,
  chatNotificationText, ensureChatDm, parseServiceAccountKey, type Repository, type WorkspaceConnector,
} from '../src/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  type: 'service_account', project_id: 'm2o-example', client_email: 'notify@m2o-example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.googleapis.com/token',
});

async function fakeGoogle(opts: { dm?: string | null; dead?: string[] } = {}) {
  const posts: { space: string; text: string }[] = [];
  let tokens = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const url = new URL(req.url!, 'http://x');
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (url.pathname === '/token') {
      const assertion = new URLSearchParams(raw).get('assertion') ?? '';
      const [h, p, sig] = assertion.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
      const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as { scope: string; iss: string };
      if (!ok || claims.scope !== 'https://www.googleapis.com/auth/chat.bot') return json(400, { error: 'invalid_grant' });
      tokens++;
      return json(200, { access_token: 'app-token', expires_in: 3600 });
    }
    if ((req.headers['authorization'] ?? '') !== 'Bearer app-token') return json(401, {});
    if (url.pathname === '/chat/spaces:findDirectMessage') {
      return opts.dm ? json(200, { name: opts.dm }) : json(404, { error: { code: 404 } });
    }
    const m = /^\/chat\/(spaces\/[A-Za-z0-9_-]+)\/messages$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      if ((opts.dead ?? []).includes(m[1]!)) return json(404, { error: { code: 404 } });
      posts.push({ space: m[1]!, text: (JSON.parse(raw) as { text: string }).text });
      return json(200, { name: `${m[1]}/messages/1` });
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { endpoints: { chat: `${base}/chat`, token: `${base}/token` }, posts, tokens: () => tokens, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function repoWith(box: SecretBox, opts: { key?: boolean; space?: string | null } = {}) {
  const spaces = new Map<string, string>();
  if (opts.space) spaces.set('t1/u1', opts.space);
  const repo = {
    getTenantCredential: async (_t: string, kind: string) => (kind === 'google_chat_app' && opts.key !== false
      ? { tenantId: 't1', kind, secretEnc: box.encrypt(KEY_JSON), meta: {}, updatedBy: 'x', updatedAt: '' } : null),
    getChatDmSpace: async (t: string, u: string) => spaces.get(`${t}/${u}`) ?? null,
    setChatDmSpace: async (t: string, u: string, s: string | null) => { if (s) spaces.set(`${t}/${u}`, s); else spaces.delete(`${t}/${u}`); },
  } as unknown as Repository;
  return { repo, spaces };
}

const ENV = { tenantId: 't1', userId: 'u1', email: 'u1@example.jp', kindLabel: '承認依頼', title: '営業定例の議事録', link: 'https://a.example/approvals' };

test('サービスアカウントの鍵を読み分け、違う形は理由つきで断る', () => {
  const k = parseServiceAccountKey(KEY_JSON);
  assert.ok(!('error' in k) && k.clientEmail === 'notify@m2o-example.iam.gserviceaccount.com' && k.projectId === 'm2o-example');
  assert.match((parseServiceAccountKey('{') as { error: string }).error, /読めません/);
  assert.match((parseServiceAccountKey(JSON.stringify({ type: 'authorized_user' })) as { error: string }).error, /サービスアカウントの鍵ではありません/);
  assert.match((parseServiceAccountKey(JSON.stringify({ ...JSON.parse(KEY_JSON), token_uri: 'https://evil.example/token' })) as { error: string }).error, /token_uri/);
});

test('アプリとして認証し（JWT の署名）、トークンを使い回す', async () => {
  const g = await fakeGoogle({ dm: 'spaces/DM1' });
  try {
    const k = parseServiceAccountKey(KEY_JSON);
    assert.ok(!('error' in k));
    const c = new ChatAppClient(k, g.endpoints);
    assert.equal(await c.findDirectMessage('u1@example.jp'), 'spaces/DM1');
    assert.equal(await c.post('spaces/DM1', 'x'), true);
    assert.equal(g.tokens(), 1, 'トークンは 1 度だけ取る');
    assert.equal(await c.post('../evil', 'x'), false, '形の違う場所には送らない');
  } finally { await g.close(); }
});

test('覚えた場所に、種類・題名・リンクだけを送る（本文は載せない）', async () => {
  const g = await fakeGoogle();
  const box = new SecretBox('テストの鍵');
  try {
    const { repo } = repoWith(box, { space: 'spaces/DM1' });
    await new GoogleChatAppSender({ repo, box, endpoints: g.endpoints }).chat(ENV);
    assert.deepEqual(g.posts, [{ space: 'spaces/DM1', text: '【承認依頼】営業定例の議事録\n<https://a.example/approvals|画面で開く>' }]);
    assert.equal(chatNotificationText({ kindLabel: 'x', title: 'a<b>|c', link: 'https://l' }), '【x】a b  c\n<https://l|画面で開く>', 'リンクの書き方を崩す字は空白にする');
  } finally { await g.close(); }
});

test('覚えた場所が無くなったら探し直し、見つからなければ忘れて理由つきで止める', async () => {
  const box = new SecretBox('テストの鍵');
  const g1 = await fakeGoogle({ dm: 'spaces/DM2', dead: ['spaces/OLD'] });
  try {
    const { repo, spaces } = repoWith(box, { space: 'spaces/OLD' });
    await new GoogleChatAppSender({ repo, box, endpoints: g1.endpoints }).chat(ENV);
    assert.equal(g1.posts[0]?.space, 'spaces/DM2');
    assert.equal(spaces.get('t1/u1'), 'spaces/DM2', '見つけた場所を覚え直す');
  } finally { await g1.close(); }
  const g2 = await fakeGoogle({ dm: null, dead: ['spaces/OLD'] });
  try {
    const { repo, spaces } = repoWith(box, { space: 'spaces/OLD' });
    await assert.rejects(new GoogleChatAppSender({ repo, box, endpoints: g2.endpoints }).chat(ENV), /個別メッセージの場所がありません/);
    assert.equal(spaces.has('t1/u1'), false, '無くなった場所は忘れる');
    const { repo: noKey } = repoWith(box, { key: false });
    await assert.rejects(new GoogleChatAppSender({ repo: noKey, box, endpoints: g2.endpoints }).chat(ENV), /鍵が登録されていません/);
  } finally { await g2.close(); }
});

test('場所の用意: 既存を探し、無ければ本人の許可で作り、許可が足りなければそう返す', async () => {
  const box = new SecretBox('テストの鍵');
  const connector = (setup: () => Promise<string>, source: 'google' | 'mock' = 'google') =>
    ({ sourceFor: () => source, chat: { setupAppDm: setup } }) as unknown as WorkspaceConnector;
  const g = await fakeGoogle({ dm: null });
  try {
    const { repo, spaces } = repoWith(box);
    const made = await ensureChatDm({ repo, box, connector: connector(async () => 'spaces/NEW'), endpoints: g.endpoints }, ENV);
    assert.deepEqual(made, { space: 'spaces/NEW' });
    assert.equal(spaces.get('t1/u1'), 'spaces/NEW');
    const scope = await ensureChatDm({ repo, box, connector: connector(async () => { throw new ConnectorUnavailableError('insufficient-scope', 'x'); }), endpoints: g.endpoints }, ENV);
    assert.deepEqual(scope, { needsScope: true });
    const { repo: noKey } = repoWith(box, { key: false });
    assert.match((await ensureChatDm({ repo: noKey, box, connector: connector(async () => 'spaces/X'), endpoints: g.endpoints }, ENV) as { error: string }).error, /鍵が登録されていません/);
    const mock = await ensureChatDm({ repo: noKey, box, connector: connector(async () => 'spaces/mockdm-1', 'mock'), endpoints: g.endpoints }, ENV);
    assert.deepEqual(mock, { space: 'spaces/mockdm-1' }, '見本の会社は鍵が無くても見本の場所');
  } finally { await g.close(); }
  const found = await fakeGoogle({ dm: 'spaces/HAS' });
  try {
    const { repo } = repoWith(box);
    let called = false;
    const r = await ensureChatDm({ repo, box, connector: connector(async () => { called = true; return 'spaces/NEW'; }), endpoints: found.endpoints }, ENV);
    assert.deepEqual(r, { space: 'spaces/HAS' });
    assert.equal(called, false, 'アプリを追加済みなら、本人の許可を求めない');
  } finally { await found.close(); }
});

test('見本の接続口の会社は見本の送信口に、ほかは本物に振り分ける', async () => {
  const mock = new MockNotificationSender();
  const sent: string[] = [];
  const real = { source: 'google' as const, chat: async () => { sent.push('real'); } };
  const r = new RoutingNotificationSender((t) => t === 't-alpha', mock, real);
  await r.chat({ ...ENV, tenantId: 't-alpha' });
  await r.chat({ ...ENV, tenantId: 't-oesf' });
  assert.equal(mock.outbox.length, 1);
  assert.deepEqual(sent, ['real']);
  assert.equal(r.sourceFor('t-alpha'), 'mock');
  assert.equal(r.sourceFor('t-oesf'), 'google');
});
