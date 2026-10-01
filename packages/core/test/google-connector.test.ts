/**
 * @file 接続口の `google` 実装の単体テスト（仕様書 第14.3.4節、ADR-0022）。
 *
 * 手元の偽の Google（トークン・Gmail・カレンダー）で、呼び方・値の直し方・断り方を確かめる。
 * 本物の Google での確かめは、開発サーバーで `oesf` の接続を使って別に行う。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS, type AgentDefinition, type Job, type Run,
} from '@m2office/shared';
import {
  BUILTIN_TOOLS, ConnectorUnavailableError, GoogleWorkspaceConnector, MemoryFileStore, MockWorkspaceConnector,
  RunEngine, SecretBox, TenantRoutingConnector, ToolRegistry, buildConnector,
  type GoogleApiEndpoints, type LlmProvider, type LlmRequest, type Repository, type WorkspaceConnector,
} from '../src/index.js';
import {
  buildRawMessage, decodeHeaderWords, decodeText, extractBody, htmlToText, MAX_BODY_CHARS,
} from '../src/connectors/google/mime.js';
import { MAX_CHAT_CHARS, pickSpace, spaceIdOf, toChatText } from '../src/connectors/google/chat.js';

const P = { tenantId: 't-real', userId: 'u1' };
const b64url = (s: string | Uint8Array) => Buffer.from(s).toString('base64url');
const sjis = (s: string) => new Uint8Array(Buffer.from(
  // 「見積」を Shift_JIS にしたもの
  s === '見積' ? [0x8c, 0xa9, 0x90, 0xcf] : [],
));
/** 「こんにちは」を ISO-2022-JP にしたもの。 */
const ISO2022_KONNICHIWA = Buffer.from([0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41, 0x24, 0x4f, 0x1b, 0x28, 0x42]);

// ─── メールの中身 ────────────────────────────────────────────────────

test('MIME: 宣言された文字コードで戻す（ISO-2022-JP・Shift_JIS）。宣言が誤っていれば UTF-8 で読み直す', () => {
  assert.equal(decodeText(ISO2022_KONNICHIWA, 'iso-2022-jp'), 'こんにちは');
  assert.equal(decodeText(sjis('見積'), 'shift_jis'), '見積');
  assert.equal(decodeText(sjis('見積'), 'x-sjis'), '見積', '古い名前も読む');
  assert.equal(decodeText(Buffer.from('請求書', 'utf-8'), 'iso-2022-jp'), '請求書', '宣言と中身が違えば UTF-8 で読み直す');
  assert.equal(decodeText(Buffer.from('abc'), 'x-unknown-charset'), 'abc', '知らない名前は UTF-8');
});

test('MIME: 見出しの符号化された語（B・Q）を戻し、符号化されていなければそのまま', () => {
  assert.equal(decodeHeaderWords('=?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?='), 'こんにちは');
  assert.equal(decodeHeaderWords('=?UTF-8?Q?=E8=A6=8B=E7=A9=8D?= =?UTF-8?B?5pu4?='), '見積書', '語の間の空白は捨てる');
  assert.equal(decodeHeaderWords('Re: 打ち合わせ'), 'Re: 打ち合わせ');
});

test('MIME: 本文は text/plain を優先し、無ければ HTML から文字だけ。添付は読まず、長ければ切る', () => {
  const plainAndHtml = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-2022-JP"' }], body: { data: b64url(ISO2022_KONNICHIWA) } },
      { mimeType: 'text/html', body: { data: b64url('<p>HTML の方</p>') } },
    ],
  };
  assert.equal(extractBody(plainAndHtml), 'こんにちは');

  const htmlOnly = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/html', body: { data: b64url('<style>p{}</style><p>1 行目<br>2 行目</p><script>alert(1)</script><div>A &amp; B &#x3042;</div>') } },
      { mimeType: 'application/pdf', filename: '請求書.pdf', body: { attachmentId: 'att1', size: 100 } },
      { mimeType: 'text/plain', filename: 'memo.txt', body: { data: b64url('添付の中身') } },
    ],
  };
  const body = extractBody(htmlOnly);
  assert.equal(body, '1 行目\n2 行目\nA & B あ');
  assert.equal(body.includes('添付の中身'), false, '添付は読まない');
  assert.equal(body.includes('alert'), false, 'script の中身は捨てる');

  const long = extractBody({ mimeType: 'text/plain', body: { data: b64url('あ'.repeat(MAX_BODY_CHARS + 10)) } });
  assert.ok(long.startsWith('あ'.repeat(MAX_BODY_CHARS)));
  assert.match(long, /ここで切りました/);
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
});

test('MIME: 組むメールは UTF-8。件名を符号化し、見出しに改行を差し込ませない。返信はスレッドをつなぐ', () => {
  const raw = buildRawMessage({
    to: ['山田 太郎 <yamada@example.jp>', 'sato@example.jp\r\nBcc: evil@example.com'],
    cc: [], subject: 'お見積りの件\r\nBcc: evil@example.com', body: '1 行目\n2 行目',
    inReplyTo: '<abc@mail.example>', references: '<x@mail.example> <abc@mail.example>',
  });
  const text = Buffer.from(raw, 'base64url').toString('utf-8');
  const [head, bodyPart] = text.split('\r\n\r\n');
  const heads = head!.split('\r\n');
  assert.equal(heads.some((h) => /^Bcc:/i.test(h)), false, '改行で見出しを差し込ませない');
  assert.ok(heads.some((h) => h.startsWith('To: =?UTF-8?B?') && h.includes('<yamada@example.jp>')), '名前だけを符号化する');
  const subject = heads.find((h) => h.startsWith('Subject: '))!.slice('Subject: '.length);
  assert.equal(decodeHeaderWords(subject), 'お見積りの件 Bcc: evil@example.com');
  assert.ok(heads.includes('In-Reply-To: <abc@mail.example>'));
  assert.ok(heads.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.equal(Buffer.from(bodyPart!.replace(/\r\n/g, ''), 'base64').toString('utf-8'), '1 行目\r\n2 行目');
  assert.equal(heads.some((h) => /^From:/i.test(h)), false, 'From は Gmail に任せる');
});

// ─── 偽の Google ────────────────────────────────────────────────────

interface Seen { method: string; path: string; query: URLSearchParams; body: any; auth?: string }

/** 手元の偽の Google。`behave` で応答を差し替えられる。 */
async function fakeGoogle(behave: (s: Seen) => { status: number; json?: unknown } | undefined = () => undefined) {
  const seen: Seen[] = [];
  let refreshes = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const url = new URL(req.url!, 'http://x');
    const isForm = (req.headers['content-type'] ?? '').includes('form');
    const s: Seen = {
      method: req.method!, path: url.pathname, query: url.searchParams, auth: req.headers.authorization,
      body: raw ? (isForm ? new URLSearchParams(raw) : JSON.parse(raw)) : null,
    };
    seen.push(s);
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    const custom = behave(s);
    if (custom) return send(custom.status, custom.json);
    if (s.path === '/oauth/token') {
      refreshes += 1;
      const rt = (s.body as URLSearchParams).get('refresh_token');
      if (rt === 'revoked') return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return send(200, { access_token: `at-${refreshes}`, expires_in: 3599 });
    }
    // Gmail
    if (s.path === '/gmail/users/me/messages' && s.method === 'GET') {
      return send(200, { messages: [{ id: 'm1' }, { id: 'gone' }, { id: 'm2' }] });
    }
    if (s.path === '/gmail/users/me/messages/gone') return send(404, { error: { code: 404, status: 'NOT_FOUND' } });
    if (s.path.startsWith('/gmail/users/me/messages/m') && s.method === 'GET') {
      const id = s.path.split('/').pop()!;
      return send(200, {
        id, threadId: `th-${id}`, labelIds: id === 'm1' ? ['INBOX', 'UNREAD'] : ['INBOX'],
        snippet: 'ご確認ください &#39;至急&#39; &amp; よろしく', internalDate: '1790000000000',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: '山田 <yamada@example.jp>' },
            { name: 'Subject', value: id === 'm1' ? '=?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=' : '見積のお願い' },
            { name: 'Message-ID', value: `<${id}@mail.example>` },
            { name: 'Content-Type', value: 'text/plain; charset=ISO-2022-JP' },
          ],
          body: { data: b64url(ISO2022_KONNICHIWA) },
        },
      });
    }
    if (s.path === '/gmail/users/me/messages/send') return send(200, { id: 'sent-1', threadId: 'th-m1' });
    if (s.path === '/gmail/users/me/drafts') return send(200, { id: 'draft-1' });
    // カレンダー
    if (s.path === '/cal/calendars/primary/events' && s.method === 'GET') {
      return send(200, {
        items: [
          { id: 'e1', summary: '朝会', start: { dateTime: '2026-09-26T09:00:00+09:00' }, end: { dateTime: '2026-09-26T09:15:00+09:00' }, attendees: [{ email: 'a@x.example' }], location: '会議室 A' },
          { id: 'e2', start: { date: '2026-09-27' }, end: { date: '2026-09-28' } },
        ],
      });
    }
    if (s.path === '/cal/freeBusy') {
      return send(200, {
        calendars: {
          'a@x.example': { busy: [{ start: '2026-09-26T01:00:00Z', end: '2026-09-26T02:00:00Z' }] },
          'outside@other.example': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] },
        },
      });
    }
    if (s.path === '/cal/calendars/primary/events' && s.method === 'POST') return send(200, { id: 'new-1' });
    if (s.path === '/cal/calendars/primary/events/gone') return send(410, { error: { code: 410 } });
    if (s.path.startsWith('/cal/calendars/primary/events/') && s.method === 'PATCH') return send(200, { id: s.path.split('/').pop() });
    if (s.path.startsWith('/cal/calendars/primary/events/') && s.method === 'DELETE') return send(204);
    // ToDo（既定のリスト）
    if (s.path === '/tasks/lists/@default/tasks' && s.method === 'GET') {
      const items = [
        { id: 't1', title: '見積書を送る', status: 'needsAction', due: '2026-09-26T00:00:00.000Z' },
        { id: 't2', title: '', status: 'needsAction' },
        { id: 't3', title: '済んだもの', status: 'completed', due: '2026-09-20T00:00:00.000Z' },
      ];
      return send(200, { items: s.query.get('showCompleted') === 'true' ? items : items.filter((t) => t.status !== 'completed') });
    }
    if (s.path === '/tasks/lists/@default/tasks' && s.method === 'POST') return send(200, { id: 'task-new' });
    if (s.path === '/tasks/lists/@default/tasks/gone') return send(404, { error: { code: 404 } });
    // 本物の Google は、形の違う ID に 404 でなく 400 を返す（2026-09-25 に確認）
    if (s.path === '/tasks/lists/@default/tasks/bad-shape') return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT' } });
    if (s.path.startsWith('/tasks/lists/@default/tasks/') && s.method === 'PATCH') return send(200, { id: s.path.split('/').pop(), status: 'completed' });
    // Chat
    if (s.path === '/chat/spaces' && s.method === 'GET') {
      if (!s.query.get('pageToken')) {
        return send(200, { spaces: [{ name: 'spaces/SALES', displayName: '営業部' }, { name: 'spaces/DUP1', displayName: '総務' }], nextPageToken: 'p2' });
      }
      return send(200, { spaces: [{ name: 'spaces/DUP2', displayName: '総務 ' }, { name: 'spaces/DEV', displayName: 'Dev Team', externalUserAllowed: true }] });
    }
    if (s.path === '/chat/spaces/GONE/messages') return send(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Space not found' } });
    // 1 つのスペースを見る（承認の前の確かめ。ADR-0024）
    if (s.path === '/chat/spaces/SALES' && s.method === 'GET') return send(200, { name: 'spaces/SALES', displayName: '営業部' });
    if (s.path === '/chat/spaces/GONE' && s.method === 'GET') return send(404, { error: { code: 404, status: 'NOT_FOUND' } });
    // 存在しない ID には、形が正しくても 400 が返る（2026-09-25 に本物で確認）
    if (s.path === '/chat/spaces/NOSUCH' && s.method === 'GET') return send(400, { error: { code: 400, status: 'INVALID_ARGUMENT' } });
    if (s.path === '/chat/spaces/OUTSIDER' && s.method === 'GET') return send(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } });
    if (s.path.startsWith('/chat/spaces/') && s.path.endsWith('/messages') && s.method === 'POST') {
      return send(200, { name: `${s.path.slice('/chat/'.length, -'/messages'.length)}/messages/m1` });
    }
    send(404, { error: { code: 404 } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: GoogleApiEndpoints = {
    gmail: `${base}/gmail`, calendar: `${base}/cal`, tasks: `${base}/tasks`, chat: `${base}/chat`,
    drive: `${base}/drive`, driveUpload: `${base}/upload`, docs: `${base}/docs`, sheets: `${base}/sheets`, slides: `${base}/slides`,
    oauth: { auth: `${base}/oauth/auth`, token: `${base}/oauth/token`, tokeninfo: `${base}/oauth/tokeninfo`, userinfo: `${base}/oauth/userinfo`, revoke: `${base}/oauth/revoke` },
  };
  return { endpoints, seen, refreshes: () => refreshes, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** 接続口が読むところだけを持つ永続化層。 */
function repoWith(opts: { connected?: boolean; client?: boolean; refreshToken?: string } = {}) {
  const box = new SecretBox('テストの鍵');
  const repo = {
    getGoogleConnection: async () => (opts.connected === false ? null : {
      tenantId: P.tenantId, userId: P.userId, refreshTokenEnc: box.encrypt(opts.refreshToken ?? 'rt-good'),
      googleEmail: 'u1@x.example', scopes: [], connectedAt: '', checkedAt: '',
    }),
    getTenantCredential: async () => (opts.client === false ? null : {
      tenantId: P.tenantId, kind: 'google_oauth', secretEnc: box.encrypt('secret'), meta: { clientId: 'cid' }, updatedBy: 'x', updatedAt: '',
    }),
  };
  return { repo: repo as unknown as Repository, box };
}

async function withConnector<T>(
  fn: (c: GoogleWorkspaceConnector, g: Awaited<ReturnType<typeof fakeGoogle>>) => Promise<T>,
  opts: Parameters<typeof repoWith>[0] = {}, behave?: Parameters<typeof fakeGoogle>[0],
): Promise<T> {
  const g = await fakeGoogle(behave);
  const { repo, box } = repoWith(opts);
  try {
    return await fn(new GoogleWorkspaceConnector(repo, box, g.endpoints), g);
  } finally {
    await g.close();
  }
}

const kindOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ConnectorUnavailableError ? e.kind : `other:${String(e)}`));

// ─── 本人の許可 ─────────────────────────────────────────────────────

test('許可: 本人のトークンで呼び、期限まで使い回す。401 なら 1 回だけ取り直す', async () => {
  let first401 = true;
  await withConnector(async (c, g) => {
    await c.mail.list(P, {});
    await c.calendar.list(P, { from: '2026-09-26T00:00:00+09:00', to: '2026-09-27T00:00:00+09:00' });
    assert.equal(g.refreshes(), 2, '1 回目は取得、401 のあと 1 回だけ取り直す');
    const refresh = g.seen.find((s) => s.path === '/oauth/token')!.body as URLSearchParams;
    assert.equal(refresh.get('refresh_token'), 'rt-good', '本人の保存したトークンで取り直す');
    assert.equal(refresh.get('client_id'), 'cid', '会社のクライアントで取り直す');
    assert.ok(g.seen.filter((s) => s.path.startsWith('/gmail')).every((s) => s.auth === 'Bearer at-1'));
  }, {}, (s) => {
    if (s.path.startsWith('/cal/') && first401) { first401 = false; return { status: 401, json: { error: { code: 401 } } }; }
    return undefined;
  });
});

test('許可: 接続していない・会社のクライアントが無い・取り消された、をそれぞれの理由で断る', async () => {
  await withConnector(async (c) => assert.equal(await kindOf(c.mail.list(P, {})), 'not-connected'), { connected: false });
  await withConnector(async (c) => assert.equal(await kindOf(c.mail.list(P, {})), 'no-client'), { client: false });
  await withConnector(async (c) => {
    const err = await c.mail.list(P, {}).catch((e: unknown) => e as ConnectorUnavailableError);
    assert.equal(err.kind, 'revoked');
    assert.match(err.message, /接続し直してください/);
  }, { refreshToken: 'revoked' });
});

test('許可: 権限が足りない・API が無効・混み合っている、を見分ける。断りの文に応答の中身を入れない', async () => {
  await withConnector(async (c) => assert.equal(await kindOf(c.mail.list(P, {})), 'insufficient-scope'), {},
    (s) => (!s.path.startsWith('/gmail') ? undefined : {
      status: 403,
      json: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
    }));
  await withConnector(async (c) => {
    const err = await c.calendar.list(P, { from: '2026-09-26', to: '2026-09-27' }).catch((e: unknown) => e as ConnectorUnavailableError);
    assert.equal(err.kind, 'api-disabled');
    assert.match(err.message, /カレンダー の API が有効になっていません/);
  }, {}, (s) => (s.path.startsWith('/cal') ? { status: 403, json: { error: { code: 403, message: '件名: 秘密の商談', errors: [{ reason: 'accessNotConfigured' }] } } } : undefined));
  await withConnector(async (c) => {
    const err = await c.mail.list(P, {}).catch((e: unknown) => e as Error);
    assert.equal((err as ConnectorUnavailableError).kind, 'unreachable');
    assert.equal(err.message.includes('秘密の商談'), false, '応答の中身を断りの文に入れない');
  }, {}, (s) => (s.path.startsWith('/gmail') ? { status: 503, json: { error: { message: '秘密の商談' } } } : undefined));
});

// ─── Gmail ──────────────────────────────────────────────────────────

test('Gmail: 受信トレイの「メイン」を新しい順に。件数は 50 まで、以降は after: で絞る。消えたメールは飛ばす', async () => {
  await withConnector(async (c, g) => {
    const items = await c.mail.list(P, { since: '2026-09-20T00:00:00+09:00', limit: 500 });
    const q = g.seen.find((s) => s.path === '/gmail/users/me/messages')!.query;
    assert.equal(q.get('maxResults'), '50', '上限は 50');
    assert.equal(q.get('q'), `in:inbox category:primary after:${Math.floor(Date.parse('2026-09-20T00:00:00+09:00') / 1000)}`,
      'プロモーションなどに振り分けられたものは含めない（2026-09-26 に oesf で確認）');
    assert.deepEqual(items.map((m) => m.id), ['m1', 'm2'], '消えたメール（404）は飛ばし、順は保つ');
    assert.equal(items[0]!.subject, 'こんにちは', '符号化された件名を戻す');
    assert.equal(items[0]!.unread, true);
    assert.equal(items[1]!.unread, false);
    assert.equal(items[0]!.snippet, "ご確認ください '至急' & よろしく", '抜粋の文字の参照を戻す');
    assert.equal(items[0]!.receivedAt, new Date(1790000000000).toISOString());
    assert.equal('body' in items[0]!, false, '一覧に本文は入れない');
  });
});

test('Gmail: 未読は受信トレイの「メイン」だけを数え、新しいものを返す', async () => {
  await withConnector(async (c, g) => {
    const r = await c.mail.unread(P, { limit: 5 });
    const q = g.seen.filter((s) => s.path === '/gmail/users/me/messages').at(-1)!.query;
    assert.equal(q.get('q'), 'in:inbox category:primary is:unread');
    assert.equal(r.more, false);
    assert.ok(r.total >= r.items.length);
  });
});

test('Gmail: 1 通の本文を宣言どおりの文字コードで。検索は Gmail の書き方をそのまま渡す', async () => {
  await withConnector(async (c, g) => {
    const m = await c.mail.get(P, 'm2');
    assert.equal(m?.body, 'こんにちは');
    assert.equal(await c.mail.get(P, 'gone'), null, '無ければ null');
    await c.mail.search(P, { query: 'from:yamada 見積', limit: 5 });
    const q = g.seen.filter((s) => s.path === '/gmail/users/me/messages').at(-1)!.query;
    assert.equal(q.get('q'), 'from:yamada 見積');
    assert.equal(q.get('labelIds'), null, '検索は受信箱に限らない');
  });
});

test('Gmail: 下書きと送信は、返信なら元のメールのスレッドにつなぐ', async () => {
  await withConnector(async (c, g) => {
    const d = await c.mail.createDraft(P, { replyTo: 'm1', to: 'yamada@example.jp', subject: 'Re: こんにちは', body: '承知しました' });
    assert.equal(d.draftId, 'draft-1');
    const draft = g.seen.find((s) => s.path === '/gmail/users/me/drafts')!.body;
    assert.equal(draft.message.threadId, 'th-m1');
    const mime = Buffer.from(draft.message.raw, 'base64url').toString('utf-8');
    assert.match(mime, /In-Reply-To: <m1@mail\.example>/);
    assert.match(mime, /References: <m1@mail\.example>/);

    const s = await c.mail.send(P, { to: ['a@x.example'], cc: ['b@x.example'], subject: '新しい件', body: '本文', replyTo: null });
    assert.equal(s.messageId, 'sent-1');
    const sent = g.seen.find((x) => x.path === '/gmail/users/me/messages/send')!.body;
    assert.equal(sent.threadId, undefined, '返信でなければスレッドを指定しない');
    assert.match(Buffer.from(sent.raw, 'base64url').toString('utf-8'), /Cc: b@x\.example/);
  });
});

// ─── カレンダー ─────────────────────────────────────────────────────

test('カレンダー: 繰り返しを展開して開始順に。終日の予定は日本時間の 0 時で表す', async () => {
  await withConnector(async (c, g) => {
    const items = await c.calendar.list(P, { from: '2026-09-26T00:00:00+09:00', to: '2026-09-29T00:00:00+09:00' });
    const q = g.seen.find((s) => s.path === '/cal/calendars/primary/events')!.query;
    assert.equal(q.get('singleEvents'), 'true');
    assert.equal(q.get('orderBy'), 'startTime');
    assert.equal(q.get('timeMin'), '2026-09-25T15:00:00.000Z');
    assert.deepEqual(items[0], {
      id: 'e1', title: '朝会', start: '2026-09-26T09:00:00+09:00', end: '2026-09-26T09:15:00+09:00',
      attendees: ['a@x.example'], location: '会議室 A',
    });
    assert.deepEqual(items[1], {
      id: 'e2', title: '（件名なし）', start: '2026-09-27T00:00:00+09:00', end: '2026-09-28T00:00:00+09:00',
      attendees: [], location: null, allDay: true,
    });
  });
});

test('カレンダー: 見られなかった人を「空き」とみなさない', async () => {
  await withConnector(async (c) => {
    const r = await c.calendar.freeBusy(P, { emails: ['a@x.example', 'outside@other.example', 'missing@x.example'], from: '2026-09-26', to: '2026-09-27' });
    assert.deepEqual(r.busy, [{ email: 'a@x.example', start: '2026-09-26T01:00:00Z', end: '2026-09-26T02:00:00Z' }]);
    assert.deepEqual(r.unknown, ['outside@other.example', 'missing@x.example']);
  });
});

test('カレンダー: 作成・変更・取り消しは参加者に知らせる。無い予定は null', async () => {
  await withConnector(async (c, g) => {
    const made = await c.calendar.create(P, { title: '定例', start: '2026-09-30T10:00:00+09:00', end: '2026-09-30T11:00:00+09:00', attendees: ['a@x.example'] });
    assert.equal(made.eventId, 'new-1');
    const post = g.seen.find((s) => s.method === 'POST' && s.path === '/cal/calendars/primary/events')!;
    assert.equal(post.query.get('sendUpdates'), 'all');
    assert.deepEqual(post.body.attendees, [{ email: 'a@x.example' }]);
    assert.deepEqual(await c.calendar.update(P, { eventId: 'e1', title: '変更' }), { eventId: 'e1' });
    assert.deepEqual(g.seen.find((s) => s.method === 'PATCH')!.body, { summary: '変更' }, '渡したものだけを変える');
    assert.deepEqual(await c.calendar.cancel(P, { eventId: 'e1' }), { eventId: 'e1' });
    assert.equal(await c.calendar.cancel(P, { eventId: 'gone' }), null, '取り消し済み（410）は見つからない扱い');
  });
});

test('ToDo: 本人の既定のリストを使う。期限は日付の終わり（日本時間）として扱う', async () => {
  await withConnector(async (c, g) => {
    const open = await c.tasks.list(P, {});
    assert.deepEqual(open, [
      { id: 't1', title: '見積書を送る', due: '2026-09-26T23:59:59+09:00', completed: false },
      { id: 't2', title: '（無題）', due: null, completed: false },
    ], 'Google の期限（日付だけ・UTC の 0 時）を、その日の終わり（日本時間）にする');
    const q = g.seen.find((s) => s.path === '/tasks/lists/@default/tasks')!.query;
    assert.equal(q.get('showCompleted'), 'false', '既定は未完了だけ');
    assert.equal((await c.tasks.list(P, { includeCompleted: true })).length, 3);

    assert.deepEqual(await c.tasks.create(P, { title: '資料を作る（担当: 山田）', due: '2026-10-01' }), { taskId: 'task-new' });
    const post = () => g.seen.filter((s) => s.method === 'POST' && s.path === '/tasks/lists/@default/tasks').at(-1)!.body;
    assert.deepEqual(post(), { title: '資料を作る（担当: 山田）', due: '2026-10-01T00:00:00.000Z' }, '期限は日付だけを渡す');
    await c.tasks.create(P, { title: '夜に決めた', due: '2026-10-01T23:30:00+09:00' });
    assert.equal(post().due, '2026-10-01T00:00:00.000Z', '時刻つきなら日本時間の日付にする');
    await c.tasks.create(P, { title: '期限なし', due: null });
    assert.equal('due' in post(), false);
    await c.tasks.create(P, { title: '読めない期限', due: '来週のどこか' });
    assert.equal('due' in post(), false, '読めない期限は推測せず、期限なしで登録する');

    assert.deepEqual(await c.tasks.complete(P, { taskId: 't1' }), { taskId: 't1' });
    assert.deepEqual(g.seen.find((s) => s.method === 'PATCH' && s.path.startsWith('/tasks/'))!.body, { status: 'completed' });
    assert.equal(await c.tasks.complete(P, { taskId: 'gone' }), null, '無い ToDo は「見つかりません」');
    assert.equal(await c.tasks.complete(P, { taskId: 'bad-shape' }), null, '形の違う ID（400）も「見つかりません」');
  });
});

test('Chat: 投稿先のリンク・ID を読み、名前はちょうど 1 つ一致したときだけ選ぶ', () => {
  assert.equal(spaceIdOf('spaces/AAAAxyz_1'), 'spaces/AAAAxyz_1');
  assert.equal(spaceIdOf('https://chat.google.com/room/AAAAabc?cls=7'), 'spaces/AAAAabc');
  assert.equal(spaceIdOf('https://mail.google.com/chat/u/0/#chat/space/AAAAdef'), 'spaces/AAAAdef');
  assert.equal(spaceIdOf('営業部'), null, '名前は ID ではない');
  const list = [{ name: 'spaces/A', displayName: '営業部' }, { name: 'spaces/B', displayName: 'Ｄｅｖ　Team' }, { name: 'spaces/C', displayName: '総務' }, { name: 'spaces/D', displayName: '総務' }];
  assert.deepEqual(pickSpace(' 営業部 ', list), { space: 'spaces/A', displayName: '営業部', external: false });
  assert.deepEqual(pickSpace('dev team', list), { space: 'spaces/B', displayName: 'Ｄｅｖ　Team', external: false }, '全角と半角・大小・空白は区別しない');
  assert.match((pickSpace('営業', list) as { reason: string }).reason, /見つかりません/, '似た名前に推測で投稿しない');
  assert.match((pickSpace('総務', list) as { reason: string }).reason, /2 つあります.*リンク/);
});

test('Chat: 承認の前に投稿先を探す。投稿はしない（ADR-0024）', async () => {
  await withConnector(async (c, g) => {
    assert.deepEqual(await c.chat.findSpace(P, '営業部'), { space: 'spaces/SALES', displayName: '営業部', external: false }, '社外の人を入れる印が無ければ社内');
    assert.deepEqual(await c.chat.findSpace(P, 'Dev Team'), { space: 'spaces/DEV', displayName: 'Dev Team', external: true }, '社外の人を入れるスペース（仕様書 第9.4.0節）');
    assert.deepEqual(await c.chat.findSpace(P, 'https://chat.google.com/room/SALES'), { space: 'spaces/SALES', displayName: '営業部', external: false }, 'リンクなら、そのスペースを見て名前を得る');
    assert.match((await c.chat.findSpace(P, '総務') as { reason: string }).reason, /2 つあります/);
    assert.match((await c.chat.findSpace(P, '人事') as { reason: string }).reason, /見つかりません/);
    assert.match((await c.chat.findSpace(P, 'spaces/GONE') as { reason: string }).reason, /リンクのチャットのスペースが見つかりません/);
    assert.match((await c.chat.findSpace(P, 'spaces/OUTSIDER') as { reason: string }).reason, /見られません.*入っているか/, '入っていないスペース（403）');
    assert.match((await c.chat.findSpace(P, 'spaces/NOSUCH') as { reason: string }).reason, /リンクのチャットのスペースが見つかりません/, '存在しない ID（400）');
    assert.match((await c.chat.findSpace(P, '  ') as { reason: string }).reason, /指定されていません/);
    assert.equal(g.seen.filter((s) => s.method === 'POST' && s.path.startsWith('/chat/')).length, 0, '確かめるだけで、投稿しない');
  });
  await withConnector(async (c) => {
    const err = await c.chat.findSpace(P, '営業部').catch((e: unknown) => e as ConnectorUnavailableError);
    assert.equal(err.kind, 'api-disabled', 'Chat アプリの設定が無いことは、理由の文でなく例外で知らせる');
  }, {}, (s) => (s.path.startsWith('/chat/') ? {
    status: 404, json: { error: { code: 404, status: 'NOT_FOUND', message: 'Google Chat app not found.' } },
  } : undefined));
});

test('Chat: 本文を Chat の書式に直し、長ければ切る', () => {
  assert.equal(toChatText('## 決定事項\n- **資料**を作る\n### 保留 ###'), '*決定事項*\n- *資料*を作る\n*保留*');
  const long = toChatText('あ'.repeat(MAX_CHAT_CHARS + 5));
  assert.ok(long.startsWith('あ'.repeat(MAX_CHAT_CHARS)));
  assert.match(long, /続きは M2Office で見られます/);
});

test('Chat: 名前で探して本人として投稿する。見つからない・複数・アプリ未設定を見分ける', async () => {
  await withConnector(async (c, g) => {
    assert.deepEqual(await c.chat.post(P, { space: '営業部', text: '## 議事録\n決まったこと' }), { messageId: 'spaces/SALES/messages/m1' });
    const list = g.seen.find((s) => s.path === '/chat/spaces')!;
    assert.equal(list.query.get('filter'), 'spaceType = "SPACE"', '名前のあるスペースだけを探す');
    const post = g.seen.find((s) => s.method === 'POST' && s.path === '/chat/spaces/SALES/messages')!;
    assert.deepEqual(post.body, { text: '*議事録*\n決まったこと' });

    await c.chat.post(P, { space: 'dev team', text: 'x' });
    assert.ok(g.seen.some((s) => s.path === '/chat/spaces/DEV/messages'), '2 ページ目まで探す');
    const before = g.seen.filter((s) => s.path === '/chat/spaces').length;
    await c.chat.post(P, { space: 'https://chat.google.com/room/LINKED', text: 'x' });
    assert.equal(g.seen.filter((s) => s.path === '/chat/spaces').length, before, 'リンクなら一覧を読まない');

    await assert.rejects(c.chat.post(P, { space: '総務', text: 'x' }), /2 つあります/);
    await assert.rejects(c.chat.post(P, { space: '人事', text: 'x' }), /見つかりません/);
    await assert.rejects(c.chat.post(P, { space: 'spaces/GONE', text: 'x' }), /スペースが見つかりません/);
    await assert.rejects(c.chat.post(P, { space: '', text: 'x' }), /指定されていません/);
    assert.equal(g.seen.filter((s) => s.method === 'POST' && s.path.includes('総務')).length, 0);
  });
  await withConnector(async (c) => {
    const err = await c.chat.post(P, { space: 'spaces/AAAA', text: 'x' }).catch((e: unknown) => e as ConnectorUnavailableError);
    assert.equal(err.kind, 'api-disabled');
    assert.match(err.message, /Chat アプリが設定されていません/);
  }, {}, (s) => (s.path.startsWith('/chat/') ? {
    status: 404,
    json: { error: { code: 404, status: 'NOT_FOUND', message: 'Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.' } },
  } : undefined));
  await withConnector(async (c) => {
    assert.equal(await kindOf(c.chat.post(P, { space: '営業部', text: 'x' })), 'insufficient-scope', '一覧の許可が無い（接続し直す前）');
  }, {}, (s) => (s.path === '/chat/spaces' ? {
    status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
  } : undefined));
});

test('400 を「見つからない」に丸めるのは ToDo の完了だけ（ほかでは組み立ての誤りを隠さない）', async () => {
  await withConnector(async (c) => {
    await assert.rejects(c.calendar.update(P, { eventId: 'e1', title: 'x' }), /要求を受け付けませんでした（HTTP 400・INVALID_ARGUMENT）/);
  }, {}, (s) => (s.method === 'PATCH' ? { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT' } } } : undefined));
});

test('準備中のサービスは、見本で代えずに断る（ADR-0022）', async () => {
  await withConnector(async (c) => {
    assert.equal(await kindOf(c.directory.search(P, { query: '山田' })), 'not-implemented');
    const err = await c.meet.transcript(P, { query: '定例' }).catch((e: unknown) => e as Error);
    assert.match(err.message, /Meet はまだ Google につないでいません（準備中）/, '英字で終わる名前の後ろに空白を入れる');
    assert.equal(c.sourceFor('t-real'), 'google');
  });
});

// ─── 会社ごとの振り分け（開発だけ） ─────────────────────────────────

test('振り分け: 指定した会社だけ見本、ほかは本物。本番で指定したら起動を拒否する', async () => {
  const calls: string[] = [];
  const real = { sourceFor: () => 'google', mail: { list: async () => { calls.push('real'); return []; } } } as unknown as WorkspaceConnector;
  const r = new TenantRoutingConnector(new Set(['t-alpha']), new MockWorkspaceConnector(), real);
  assert.equal(r.sourceFor('t-alpha'), 'mock');
  assert.equal(r.sourceFor('t-oesf'), 'google');
  const mockItems = await r.mail.list({ tenantId: 't-alpha', userId: 'u' }, {});
  assert.ok(mockItems.length > 0, '見本の会社は見本のメール');
  await r.mail.list({ tenantId: 't-oesf', userId: 'u' }, {});
  assert.deepEqual(calls, ['real'], '本物の会社だけが本物を呼ぶ');

  const { repo, box } = repoWith();
  assert.throws(() => buildConnector('google', { repo, box, mockTenants: ['t-alpha'], production: true }), /開発だけの設定/);
  assert.equal(buildConnector('google', { repo, box, mockTenants: [''] }).sourceFor('t-alpha'), 'google', '空の指定は無いのと同じ');
  assert.throws(() => buildConnector('google'), /データベースと暗号の箱/);
});

// ─── エンジン: 断られたときの扱い ────────────────────────────────────

class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly seen: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly replies: string[]) {}
  async complete(req: LlmRequest) {
    this.seen.push(req);
    return { text: this.replies[Math.min(this.i++, this.replies.length - 1)] ?? '', tokensUsed: 10 };
  }
}

const CALL = (name: string, args: Record<string, unknown> = {}) => '```tool\n' + JSON.stringify({ name, args }) + '\n```';

function engineWith(tools: string[], llm: LlmProvider, connector: WorkspaceConnector) {
  const def: AgentDefinition = {
    schemaVersion: 1, id: 'g-test', version: 1, name: 'テスト', category: 'test', description: 'テスト',
    locale: 'ja-JP', compartment: null, inputs: {}, tools,
    steps: [{ id: 'work', type: 'agent', instruction: '進める' }],
    constraints: [], limits: { maxSteps: 10, maxTokens: 10_000, timeoutSec: 60 },
  };
  const steps: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const job: Job = { id: 'j1', tenantId: 't', agentId: def.id, agentVersion: 1, requestedBy: 'u1', origin: 'menu', input: {}, createdAt: now };
  const run: Run = { id: 'r1', jobId: 'j1', tenantId: 't', status: 'running', cursor: 0, startedAt: now, endedAt: null, tokensUsed: 0, costJpy: 0, savedMinutes: 0, failureReason: null };
  const repo = {
    steps,
    getJob: async () => job, getRun: async () => run, updateRun: async () => undefined,
    listRunSteps: async () => steps,
    appendRunStep: async (_t: string, s: Record<string, unknown>) => { steps.push(s); },
    updateRunStep: async (_t: string, s: Record<string, unknown>) => { steps[steps.findIndex((x) => x['id'] === s['id'])] = s; },
    createApproval: async () => undefined, listRunApprovals: async () => [], listApprovalsForFileInput: async () => [],
    appendAudit: async () => undefined, createNotification: async () => undefined,
    findUserById: async () => ({ id: 'u1', tenantId: 't', displayName: '利用者', roles: ['member'] }),
    listUsers: async () => [], listNotifications: async () => [], listArtifacts: async () => [], createArtifact: async () => undefined,
    getTenantSettings: async () => DEFAULT_TENANT_SETTINGS, getUserSettings: async () => DEFAULT_USER_SETTINGS,
    listUserCompartments: async () => [], listUserGroupIds: async () => [], listGroupsOfUser: async () => [],
  };
  const registry = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) registry.register(t);
  const engine = new RunEngine({
    repo: repo as unknown as Repository, llm, registry, connector, files: new MemoryFileStore(), resolveDefinition: () => def,
  });
  return { engine, run, steps };
}

/** メールも下書きも「接続していない」と断る接続口。 */
function refusing(): WorkspaceConnector {
  const no = async () => { throw new ConnectorUnavailableError('not-connected', 'Google と接続していません。個人設定の「Google 連携」で接続してください'); };
  const base = new MockWorkspaceConnector();
  return Object.assign(Object.create(base), {
    sourceFor: () => 'google',
    mail: { ...base.mail, list: no, createDraft: no },
  }) as WorkspaceConnector;
}

test('エンジン: 読むツールで断られたら、止めずに「取得できませんでした」と理由を推論に返す', async () => {
  const llm = new ScriptedLlm([CALL('gmail.list'), 'メールを取得できませんでした。']);
  const { engine, run, steps } = engineWith(['gmail.list'], llm, refusing());
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'completed');
  const second = llm.seen[1]!.messages.map((m) => m.content).join('\n');
  assert.match(second, /取得できませんでした: Google と接続していません/);
  assert.equal((steps[0]!['status']), 'succeeded');
});

test('エンジン: 書くツールで断られたら、ステップを失敗にする（書いたつもりで進ませない）', async () => {
  const llm = new ScriptedLlm([CALL('gmail.create_draft', { to: 'a@x.example', subject: '件', body: '本文' }), '下書きを作りました。']);
  const { engine, run, steps } = engineWith(['gmail.create_draft'], llm, refusing());
  const res = await engine.advance(run);
  assert.equal(res.outcome, 'failed');
  assert.equal(steps[0]!['status'], 'failed');
  assert.match(String((steps[0]!['output'] as { error: string }).error), /Google と接続していません/);
});
