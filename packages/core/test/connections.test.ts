/**
 * @file 接続の設定の単体テスト。秘密の値の暗号化、Google の OAuth の各呼び出し（手元の偽の Google で確かめる）、
 * 会社ごとの Gemini の選択。
 *
 * @see 仕様書 第14.3.3節 接続の設定
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SecretBox, StubLlmProvider, MockResearchProvider, TenantAiResolver, buildGoogleAuthUrl, createPkce,
  exchangeGoogleCode, googleGrantedScopes, googleScopeLabel, googleUserEmail, refreshGoogleAccessToken, revokeGoogleToken,
  GoogleOAuthError, type GoogleOAuthEndpoints, type Repository, type TenantCredential,
} from '../src/index.js';

test('秘密の値: 暗号化して戻せる。毎回ちがう暗号文になり、別の鍵や改ざんでは戻せない', () => {
  const box = new SecretBox('テスト用の鍵');
  const a = box.encrypt('AIzaSy-secret');
  const b = box.encrypt('AIzaSy-secret');
  assert.notEqual(a, b);
  assert.ok(!a.includes('AIzaSy'));
  assert.equal(box.decrypt(a), 'AIzaSy-secret');
  assert.throws(() => new SecretBox('別の鍵').decrypt(a));
  const parts = a.split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => box.decrypt(parts.join(':')));
});

test('認可の URL: ログインの権限と業務の権限、オフラインの利用、PKCE、state を付ける', () => {
  const { verifier, challenge } = createPkce();
  assert.ok(verifier.length >= 43);
  const url = new URL(buildGoogleAuthUrl({ clientId: 'c', redirectUri: 'http://localhost/cb', scopes: ['gmail.readonly', 'drive.file'], state: 's1', codeChallenge: challenge }));
  const q = url.searchParams;
  assert.equal(q.get('scope'), 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('code_challenge'), challenge);
  assert.equal(q.get('state'), 's1');
  assert.equal(googleScopeLabel('gmail.readonly'), 'メールを読む', '権限は業務の言葉で見せる');
});

/** 手元の偽の Google（トークン・tokeninfo・userinfo・取り消し）。 */
async function fakeGoogle() {
  const seen: { path: string; body: URLSearchParams; auth?: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const url = new URL(req.url!, 'http://x');
    const body = new URLSearchParams(raw);
    seen.push({ path: url.pathname, body, auth: req.headers.authorization });
    const json = (code: number, v: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (url.pathname === '/token' && body.get('grant_type') === 'authorization_code') {
      if (body.get('code') !== 'good' || !body.get('code_verifier')) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'at-1', refresh_token: 'rt-1', scope: 'openid https://www.googleapis.com/auth/gmail.readonly' });
    }
    if (url.pathname === '/token' && body.get('grant_type') === 'refresh_token') {
      return body.get('refresh_token') === 'rt-1' ? json(200, { access_token: 'at-2', expires_in: 3599 }) : json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    }
    if (url.pathname === '/tokeninfo') return json(200, { scope: 'openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file' });
    if (url.pathname === '/userinfo') return json(200, { email: 'sato@alpha.example.jp' });
    if (url.pathname === '/revoke') return json(200, {});
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: GoogleOAuthEndpoints = {
    auth: `${base}/auth`, token: `${base}/token`, tokeninfo: `${base}/tokeninfo`, userinfo: `${base}/userinfo`, revoke: `${base}/revoke`,
  };
  return { endpoints, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('OAuth: コードをトークンに換え、取り直し、実際に許可された範囲とメールアドレスを確かめ、取り消せる', async () => {
  const g = await fakeGoogle();
  try {
    const t = await exchangeGoogleCode({ clientId: 'c', clientSecret: 's', code: 'good', redirectUri: 'http://localhost/cb', codeVerifier: 'v' }, g.endpoints);
    assert.equal(t.refreshToken, 'rt-1');
    assert.equal(g.seen[0]!.body.get('code_verifier'), 'v', 'PKCE の検証用の値を送る');
    await assert.rejects(exchangeGoogleCode({ clientId: 'c', clientSecret: 's', code: 'bad', redirectUri: 'x', codeVerifier: 'v' }, g.endpoints), GoogleOAuthError);
    const r = await refreshGoogleAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt-1' }, g.endpoints);
    assert.equal(r.accessToken, 'at-2');
    await assert.rejects(refreshGoogleAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'old' }, g.endpoints), /expired or revoked/);
    assert.deepEqual(await googleGrantedScopes('at-2', g.endpoints), ['openid', 'gmail.readonly', 'drive.file']);
    assert.equal(await googleUserEmail('at-2', g.endpoints), 'sato@alpha.example.jp');
    assert.equal(g.seen.find((x) => x.path === '/userinfo')?.auth, 'Bearer at-2');
    assert.equal(await revokeGoogleToken('rt-1', g.endpoints), true);
  } finally {
    await g.close();
  }
});

test('会社ごとの Gemini: 自社の鍵を登録した会社はその鍵、ほかの会社は運営の設定を使う', async () => {
  const box = new SecretBox('k');
  const creds: TenantCredential[] = [{
    tenantId: 'a', kind: 'gemini', secretEnc: box.encrypt('AIzaSy-tenant-a'), meta: { mode: 'byok', models: { standard: 'gemini-2.5-flash' } },
    updatedBy: 'u', updatedAt: '2026-09-22T00:00:00Z',
  }];
  const repo = { getTenantCredential: async (t: string, k: string) => creds.find((c) => c.tenantId === t && c.kind === k) ?? null } as unknown as Repository;
  const fallback = new StubLlmProvider();
  const ai = new TenantAiResolver({
    repo, box, fallbackLlm: fallback, fallbackResearch: new MockResearchProvider(), platformKey: null,
    defaults: { fast: 'f', standard: 's', advanced: 'a', research: 'r', live: 'l' }, baseUrl: 'http://x',
  });
  const a = await ai.geminiFor('a');
  assert.deepEqual([a.source, a.apiKey, a.models.standard, a.models.fast], ['tenant', 'AIzaSy-tenant-a', 'gemini-2.5-flash', 'f']);
  assert.notEqual(await ai.llmFor('a'), fallback);
  assert.equal((await ai.llmFor('a')).name, 'gemini');
  assert.equal(await ai.llmFor('a'), await ai.llmFor('a'), '設定が変わるまで使い回す');
  const b = await ai.geminiFor('b');
  assert.deepEqual([b.source, b.apiKey], ['none', null]);
  assert.equal(await ai.llmFor('b'), fallback, '鍵の無い会社は既定（ここではスタブ）');
});
