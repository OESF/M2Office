/**
 * @file Google ドライブとドキュメントの接続口の単体テスト。手元の偽の Google に向けて呼ぶ。
 *
 * `drive.file` の範囲で探す・読む・フォルダ・共有、文書の作成（Markdown を書式にして取り込む）と追記を確かめる。
 * リンクによる公開を作らないこと、見えないファイルに触れないことも確かめる。
 *
 * @see 仕様書 第14.3.4節「ドライブ」「ドキュメント」
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GoogleWorkspaceConnector, SecretBox, renderPdf, type GoogleApiEndpoints, type Repository,
} from '../src/index.js';
import { markdownToDocHtml } from '../src/connectors/google/doc-html.js';
import { DRIVE_READ_MAX_BYTES, kindOf, quoteDriveQuery } from '../src/connectors/google/drive.js';

const P = { tenantId: 't1', userId: 'u1' };
const G = 'application/vnd.google-apps.';

interface Seen { method: string; path: string; query: URLSearchParams; contentType: string; body: string }

const FILES: Record<string, { name: string; mimeType: string; trashed?: boolean }> = {
  DOC1: { name: '営業定例の議事録', mimeType: `${G}document` },
  SHEET1: { name: '顧客一覧', mimeType: `${G}spreadsheet` },
  SLIDE1: { name: '提案', mimeType: `${G}presentation` },
  PDF1: { name: '請求書.pdf', mimeType: 'application/pdf' },
  TXT1: { name: 'メモ.txt', mimeType: 'text/plain' },
  FORM1: { name: 'アンケート', mimeType: `${G}form` },
  FOLDER1: { name: '議事録', mimeType: `${G}folder` },
  ZIP1: { name: '資料.zip', mimeType: 'application/zip' },
  BIG1: { name: '大きい.pdf', mimeType: 'application/pdf' },
  OLD1: { name: '消した文書', mimeType: `${G}document`, trashed: true },
};

async function fakeDrive(pdf: Uint8Array) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const url = new URL(req.url!, 'http://x');
    const s: Seen = { method: req.method!, path: url.pathname, query: url.searchParams, contentType: req.headers['content-type'] ?? '', body: raw };
    seen.push(s);
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    const bytes = (b: Uint8Array | string, type: string, length?: number) => {
      res.writeHead(200, { 'content-type': type, 'content-length': String(length ?? Buffer.byteLength(b as string)) });
      res.end(b);
    };
    const meta = (id: string) => ({ id, ...FILES[id], modifiedTime: '2026-09-25T01:00:00.000Z', webViewLink: `https://docs.example/${id}` });

    if (s.path === '/oauth/token') return json(200, { access_token: 'at', expires_in: 3599 });
    if (s.path === '/drive/files' && s.method === 'GET') return json(200, { files: [meta('DOC1'), meta('SHEET1')] });
    if (s.path === '/drive/files' && s.method === 'POST') {
      const b = JSON.parse(s.body) as { name: string; parents?: string[] };
      if (b.parents?.[0] === 'NOPE') return json(404, { error: { code: 404 } });
      return json(200, { id: 'NEWFOLDER', name: b.name, mimeType: `${G}folder`, modifiedTime: '2026-09-25T02:00:00.000Z' });
    }
    const exp = /^\/drive\/files\/([^/]+)\/export$/.exec(s.path);
    if (exp) {
      const id = exp[1]!;
      if (id === 'DOC1') return bytes('﻿営業定例の議事録\n決定: A 案で進める', 'text/plain; charset=utf-8');
      if (id === 'SHEET1') return bytes('会社\t担当\n見本商事\t佐藤', 'text/tab-separated-values');
      if (id === 'SLIDE1') return bytes('提案\n価格は据え置き', 'text/plain');
    }
    const perm = /^\/drive\/files\/([^/]+)\/permissions$/.exec(s.path);
    if (perm && s.method === 'POST') {
      const b = JSON.parse(s.body) as { emailAddress?: string };
      if (b.emailAddress?.endsWith('@outside.example')) {
        return json(403, { error: { code: 403, errors: [{ reason: 'publishOutNotPermitted' }], message: 'Sharing outside not permitted' } });
      }
      return json(200, { id: 'perm1' });
    }
    const file = /^\/drive\/files\/([^/]+)$/.exec(s.path);
    if (file && s.method === 'GET') {
      const id = file[1]!;
      if (!FILES[id]) return json(404, { error: { code: 404 } });
      if (s.query.get('alt') === 'media') {
        if (id === 'PDF1') return bytes(pdf, 'application/pdf', pdf.byteLength);
        if (id === 'TXT1') return bytes('手書きのメモ①', 'text/plain');
        if (id === 'BIG1') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(DRIVE_READ_MAX_BYTES + 1) }); return res.end(); }
      }
      return json(200, meta(id));
    }
    if (s.path === '/upload/files' && s.method === 'POST') {
      return json(200, { id: 'NEWDOC', name: '作った文書', mimeType: `${G}document`, modifiedTime: '2026-09-25T03:00:00.000Z', webViewLink: 'https://docs.example/NEWDOC' });
    }
    if (s.path === '/docs/documents/DOC1:batchUpdate' && s.method === 'POST') return json(200, { documentId: 'DOC1' });
    json(404, { error: { code: 404 } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: GoogleApiEndpoints = {
    gmail: `${base}/gmail`, calendar: `${base}/cal`, tasks: `${base}/tasks`, chat: `${base}/chat`,
    drive: `${base}/drive`, driveUpload: `${base}/upload`, docs: `${base}/docs`,
    oauth: { auth: `${base}/oauth/auth`, token: `${base}/oauth/token`, tokeninfo: `${base}/oauth/tokeninfo`, userinfo: `${base}/oauth/userinfo`, revoke: `${base}/oauth/revoke` },
  };
  return { endpoints, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function withDrive(fn: (c: GoogleWorkspaceConnector, seen: Seen[]) => Promise<void>) {
  const pdf = await renderPdf({ title: '請求書', to: '株式会社アルファ 御中', from: ['見本'], fields: [], rows: [{ name: '利用料', quantity: 1, unitPrice: 3000 }], notes: [] });
  const g = await fakeDrive(pdf);
  const box = new SecretBox('テストの鍵');
  const repo = {
    getGoogleConnection: async () => ({ tenantId: P.tenantId, userId: P.userId, refreshTokenEnc: box.encrypt('rt'), googleEmail: 'u1@x.jp', scopes: [], connectedAt: '', checkedAt: '' }),
    getTenantCredential: async () => ({ tenantId: P.tenantId, kind: 'google_oauth', secretEnc: box.encrypt('s'), meta: { clientId: 'cid' }, updatedBy: 'x', updatedAt: '' }),
  } as unknown as Repository;
  try { await fn(new GoogleWorkspaceConnector(repo, box, g.endpoints), g.seen); } finally { await g.close(); }
}

test('ドライブ: 名前で探す。ごみ箱を除き、新しい順。検索の文字は逃がす', async () => {
  await withDrive(async (c, seen) => {
    const items = await c.drive.search(P, { query: "山田's 議事録", limit: 500 });
    assert.deepEqual(items.map((f) => [f.id, f.kind, f.url]), [['DOC1', 'document', 'https://docs.example/DOC1'], ['SHEET1', 'spreadsheet', 'https://docs.example/SHEET1']]);
    const q = seen.find((s) => s.path === '/drive/files')!.query;
    assert.equal(q.get('q'), "trashed = false and name contains '山田\\'s 議事録'");
    assert.equal(q.get('orderBy'), 'modifiedTime desc');
    assert.equal(q.get('pageSize'), '50', '50 件まで');
    await c.drive.search(P, { query: '  ' });
    assert.equal(seen.filter((s) => s.path === '/drive/files').at(-1)!.query.get('q'), 'trashed = false', '空なら見えるものすべて');
  });
  assert.equal(quoteDriveQuery('a\\b'), "'a\\\\b'");
  assert.equal(kindOf(`${G}presentation`), 'presentation');
  assert.equal(kindOf('image/png'), 'other');
});

test('ドライブ: 種類ごとに文字で読む。読めないものは推測で埋めず、そう返す', async () => {
  await withDrive(async (c, seen) => {
    assert.equal((await c.drive.read(P, 'DOC1'))!.text, '営業定例の議事録\n決定: A 案で進める', 'ドキュメントは書き出して読む（BOM は除く）');
    assert.equal(seen.find((s) => s.path === '/drive/files/DOC1/export')!.query.get('mimeType'), 'text/plain');
    assert.equal((await c.drive.read(P, 'SHEET1'))!.text, '会社\t担当\n見本商事\t佐藤', 'スプレッドシートはタブ区切り');
    assert.match((await c.drive.read(P, 'SLIDE1'))!.text, /価格は据え置き/);
    assert.match((await c.drive.read(P, 'PDF1'))!.text, /請求書/, 'PDF は取り出して文字を抜く');
    assert.equal((await c.drive.read(P, 'TXT1'))!.text, '手書きのメモ①');
    assert.match((await c.drive.read(P, 'FORM1'))!.text, /フォームは文字で読めません/);
    assert.match((await c.drive.read(P, 'ZIP1'))!.text, /この種類のファイル（application\/zip）は文字で読めません/);
    assert.match((await c.drive.read(P, 'BIG1'))!.text, /大きすぎるため読みませんでした。5 MB まで/);
    assert.equal(await c.drive.read(P, 'FOLDER1'), null, 'フォルダは読まない');
    assert.equal(await c.drive.read(P, 'OLD1'), null, 'ごみ箱のものは見つからない扱い');
    assert.equal(await c.drive.read(P, 'NOPE'), null, '見えないファイル（404）');
    assert.equal(await c.drive.read(P, ' '), null);
  });
});

test('ドライブ: フォルダを作る。共有は指定した人にだけで、リンクによる公開はしない', async () => {
  await withDrive(async (c, seen) => {
    const folder = await c.drive.createFolder(P, { name: '2026 年の議事録', parentId: null });
    assert.equal(folder.kind, 'folder');
    assert.deepEqual(JSON.parse(seen.find((s) => s.path === '/drive/files' && s.method === 'POST')!.body), { name: '2026 年の議事録', mimeType: `${G}folder` });
    await assert.rejects(c.drive.createFolder(P, { name: 'x', parentId: 'NOPE' }), /親のフォルダが見つかりません/);

    assert.deepEqual(await c.drive.share(P, { fileId: 'DOC1', emails: ['a@x.jp', ' ', 'b@x.jp'], role: 'commenter' }), { fileId: 'DOC1', sharedWith: ['a@x.jp', 'b@x.jp'] });
    const perms = seen.filter((s) => s.path === '/drive/files/DOC1/permissions');
    assert.deepEqual(perms.map((s) => JSON.parse(s.body)), [
      { type: 'user', role: 'commenter', emailAddress: 'a@x.jp' }, { type: 'user', role: 'commenter', emailAddress: 'b@x.jp' },
    ]);
    assert.ok(perms.every((s) => !s.body.includes('anyone')), 'リンクを知っている全員への公開は作らない');
    assert.equal(await c.drive.share(P, { fileId: 'NOPE', emails: ['a@x.jp'], role: 'reader' }), null, '見えないファイルは共有しない');
    await assert.rejects(c.drive.share(P, { fileId: 'DOC1', emails: ['z@outside.example'], role: 'reader' }), /要求を受け付けませんでした（HTTP 403・publishOutNotPermitted）/, '社外への共有を会社が禁じていれば、Google が断る');
  });
});

test('ドライブ: 会社の全員に閲覧だけで共有する。検索には出さず、知らせのメールは送らない（ADR-0025）', async () => {
  await withDrive(async (c, seen) => {
    assert.deepEqual(await c.drive.shareWithDomain(P, { fileId: 'DOC1', domain: 'oesf.jp' }), { fileId: 'DOC1', domain: 'oesf.jp' });
    const perm = seen.find((s) => s.path === '/drive/files/DOC1/permissions')!;
    assert.deepEqual(JSON.parse(perm.body), { type: 'domain', role: 'reader', domain: 'oesf.jp', allowFileDiscovery: false });
    assert.equal(perm.query.get('sendNotificationEmail'), 'false');
    assert.equal(await c.drive.shareWithDomain(P, { fileId: 'NOPE', domain: 'oesf.jp' }), null, '見えないファイルは共有しない');
    assert.equal(await c.drive.shareWithDomain(P, { fileId: 'OLD1', domain: 'oesf.jp' }), null, 'ごみ箱のものは共有しない');
    assert.deepEqual(await c.drive.get(P, 'SHEET1'), { id: 'SHEET1', name: '顧客一覧', kind: 'spreadsheet', modifiedAt: '2026-09-25T01:00:00.000Z', url: 'https://docs.example/SHEET1' });
    assert.equal(await c.drive.get(P, 'NOPE'), null);
  });
});

test('ドキュメント: 本文の Markdown を書式にして取り込ませる。追記は文書にだけ', async () => {
  await withDrive(async (c, seen) => {
    const file = await c.docs.create(P, { title: '議事録', body: '## 決定事項\n- **A 案**で進める', folderId: 'FOLDER1' });
    assert.deepEqual([file.id, file.kind, file.url], ['NEWDOC', 'document', 'https://docs.example/NEWDOC']);
    const up = seen.find((s) => s.path === '/upload/files')!;
    assert.equal(up.query.get('uploadType'), 'multipart');
    assert.match(up.contentType, /^multipart\/related; boundary=/);
    assert.match(up.body, /"name":"議事録","mimeType":"application\/vnd\.google-apps\.document","parents":\["FOLDER1"\]/);
    assert.match(up.body, /Content-Type: text\/html; charset=UTF-8\r\n\r\n<html><body><h2>決定事項<\/h2>\n<ul><li><b>A 案<\/b>で進める<\/li><\/ul><\/body><\/html>/);

    assert.deepEqual(await c.docs.append(P, { documentId: 'DOC1', text: '追記です' }), { documentId: 'DOC1' });
    const upd = seen.find((s) => s.path === '/docs/documents/DOC1:batchUpdate')!;
    assert.deepEqual(JSON.parse(upd.body), { requests: [{ insertText: { endOfSegmentLocation: {}, text: '\n追記です' } }] });
    assert.equal(await c.docs.append(P, { documentId: 'SHEET1', text: 'x' }), null, '文書でないものには追記しない');
    assert.equal(await c.docs.append(P, { documentId: 'OLD1', text: 'x' }), null, 'ごみ箱のものには追記しない');
    assert.equal(await c.docs.append(P, { documentId: 'NOPE', text: 'x' }), null);
    assert.equal(seen.filter((s) => s.path.includes(':batchUpdate')).length, 1);
  });
});

test('文書の HTML: 見出し・太字・入れ子の箇条書き・番号・引用・表・コードを書式にし、中身はエスケープする', () => {
  const html = markdownToDocHtml([
    '# 題 <script>', '', '段落の 1 行目', '2 行目 `a<b` と [リンク](https://example.jp) と [悪い](javascript:x)', '',
    '1. 最初', '   - 下の項目', '2. 次', '', '> 引用の **太字**', '', '| 項目 | 金額 |', '|---|---|', '| 利用料 | 3,000 |', '', '```', '<code> のまま', '```', '---',
  ].join('\n'));
  assert.match(html, /<h1>題 &lt;script&gt;<\/h1>/);
  assert.match(html, /<p>段落の 1 行目<br>2 行目 <code>a&lt;b<\/code> と <a href="https:\/\/example.jp">リンク<\/a> と \[悪い\]\(javascript:x\)<\/p>/, 'http(s) 以外のリンクは押せるようにしない');
  assert.match(html, /<ol><li>最初<ul><li>下の項目<\/li><\/ul><\/li><li>次<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>引用の <b>太字<\/b><\/p><\/blockquote>/);
  assert.match(html, /<table[^>]*>\n<tr><th>項目<\/th><th>金額<\/th><\/tr>\n<tr><td>利用料<\/td><td>3,000<\/td><\/tr>\n<\/table>/);
  assert.match(html, /<pre>&lt;code&gt; のまま<\/pre>/);
  assert.match(html, /<hr>/);
});
