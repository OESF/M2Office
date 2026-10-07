/**
 * @file 販促物の作成の Canva とのつなぎの単体テスト（仕様書 第41.19.3節）。
 * 本物の口（許可の画面の URL・トークンの取り替え・取り込みと書き出しを待つ・書き出しの置き場の外へは取りに行かない）、
 * 本人ごとの接続（リフレッシュ トークンは 1 回で替わる・同時に取り直しても 1 回だけ使う・切れた許可は消す・切断）、
 * 販促物から Canva で仕上げて戻す（新しい版・その版は会話や文面で直せない・入稿用の PDF は作れない・サイネージは書き出した PNG）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { CANVA_TEMPLATE, DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  CanvaError, CanvaService, HttpCanvaApi, MemoryCanvaConnectionStore, MemoryFileStore, MemoryPrintDesignStore, MockCanvaApi, PrintDesignService, SecretBox,
  isCanvaDownloadUrl, renderCover, shrinkPng,
  type AnnouncementSignage, type CanvaApi, type LlmProvider, type Repository,
} from '../src/index.js';

const who = { tenantId: 't1', userId: 'u1' };
const samplePng = () => renderCover({ title: '見本', background: { kind: 'template', pattern: 'dots', color: '#335577' } });

test('本物の口: 許可の画面の URL・トークンの取り替え（Basic 認証）・取り込みと書き出しを待つ・置き場の外へ取りに行かない', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let polls = 0;
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/oauth/token')) return json({ access_token: 'at', refresh_token: 'rt2', expires_in: 3600 });
    if (u.endsWith('/imports')) return json({ job: { id: 'imp1', status: 'in_progress' } });
    if (u.endsWith('/imports/imp1')) {
      polls += 1;
      return json(polls < 2 ? { job: { id: 'imp1', status: 'in_progress' } } : { job: { id: 'imp1', status: 'success', result: { designs: [{ id: 'D1', urls: { edit_url: 'https://www.canva.com/design/D1/edit' } }] } } });
    }
    if (u.endsWith('/exports')) return json({ job: { id: 'exp1', status: 'in_progress' } });
    if (u.endsWith('/exports/exp1')) return json({ job: { id: 'exp1', status: 'success', urls: ['https://export-download.canva.com/x/1.pdf'] } });
    if (u.startsWith('https://export-download.canva.com/')) return new Response(pdf);
    return json({ message: 'not found' }, 404);
  }) as typeof fetch;
  const api = new HttpCanvaApi({ clientId: 'cid', clientSecret: 'sec', fetchImpl, sleep: async () => undefined });
  const url = new URL(api.authorizeUrl({ redirectUri: 'https://a.example.jp/v1/oauth/canva/callback', state: 'st', codeChallenge: 'ch' }));
  assert.equal(url.origin + url.pathname, 'https://www.canva.com/api/oauth/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.equal(url.searchParams.get('scope'), 'design:content:write design:content:read design:meta:read');
  const t = await api.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'https://a.example.jp/cb' });
  assert.deepEqual(t, { accessToken: 'at', refreshToken: 'rt2', expiresIn: 3600 });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['authorization'], `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.match(String(calls[0]!.init.body), /grant_type=authorization_code/);
  const d = await api.importPdf('at', '春の決算セール', pdf);
  assert.deepEqual(d, { designId: 'D1', editUrl: 'https://www.canva.com/design/D1/edit' });
  const imp = calls.find((c) => c.url.endsWith('/imports'))!;
  const meta = JSON.parse((imp.init.headers as Record<string, string>)['import-metadata']!);
  assert.equal(Buffer.from(meta.title_base64, 'base64').toString('utf8'), '春の決算セール');
  assert.equal(meta.mime_type, 'application/pdf');
  assert.deepEqual(await api.exportDesign('at', 'D1', 'pdf'), [pdf]);
  // 置き場の外の URL が返されたら取りに行かない
  const evil = new HttpCanvaApi({
    clientId: 'c', clientSecret: 's', sleep: async () => undefined,
    fetchImpl: (async (u: string | URL) => new Response(JSON.stringify(String(u).endsWith('/exports') ? { job: { id: 'e' } } : { job: { status: 'success', urls: ['https://evil.example.com/x.pdf'] } }))) as typeof fetch,
  });
  await assert.rejects(evil.exportDesign('at', 'D1', 'pdf'), CanvaError);
  assert.equal(isCanvaDownloadUrl('https://export-download.canva.com/a'), true);
  assert.equal(isCanvaDownloadUrl('http://export-download.canva.com/a'), false);
  assert.equal(isCanvaDownloadUrl('https://canva.com.evil.example/a'), false);
  // 失敗した処理は理由を返す
  const failing = new HttpCanvaApi({
    clientId: 'c', clientSecret: 's', sleep: async () => undefined,
    fetchImpl: (async (u: string | URL) => new Response(JSON.stringify(String(u).endsWith('/imports') ? { job: { id: 'i' } } : { job: { status: 'failed', error: { message: 'invalid_file' } } }))) as typeof fetch,
  });
  await assert.rejects(failing.importPdf('at', 'x', pdf), /invalid_file/);
});

test('本人ごとの接続: つなぐ・リフレッシュ トークンは 1 回で替わる・同時に取り直しても 1 回だけ・切れた許可は消す・切断', async () => {
  const api = new MockCanvaApi();
  let refreshes = 0;
  const counting: CanvaApi = Object.assign(Object.create(Object.getPrototypeOf(api)), api, {
    refresh: async (rt: string) => { refreshes += 1; return api.refresh(rt); },
  });
  const store = new MemoryCanvaConnectionStore();
  const box = new SecretBox('k');
  let now = 0;
  const svc = new CanvaService({ api: counting, store, box, redirectUri: 'https://a.example.jp/cb', now: () => now });
  assert.deepEqual(await svc.status(who), { connected: false, connectedAt: null });
  assert.match((await svc.importPdf(who, 'x', new Uint8Array([1])) as { error: string }).error, /つないでいません/);
  const url = new URL(svc.authorizeUrl('st', 'challenge123'));
  await svc.finishConnect(who, url.searchParams.get('code')!, 'v');
  assert.equal((await svc.status(who)).connected, true);
  // 保存はリフレッシュ トークンを暗号化したもの
  assert.doesNotMatch(store.rows.get('t1:u1')!.refreshTokenEnc, /mock-refresh/);
  // 切れたら取り直す。同時に 2 つ頼んでも、取り直しは 1 回
  now = 5 * 3_600_000;
  const [a, b] = await Promise.all([svc.importPdf(who, 'a', new Uint8Array([0x25, 0x50])), svc.importPdf(who, 'b', new Uint8Array([0x25, 0x50]))]);
  assert.ok(!('error' in a) && !('error' in b));
  assert.equal(refreshes, 1);
  // 取り直したリフレッシュ トークンを持つ（前のは使えない）
  assert.equal(api.revoked.length, 1);
  // 許可が取り消されていたら、接続を消してつなぎ直してもらう
  now = 10 * 3_600_000;
  api.revoked.push(box.decrypt(store.rows.get('t1:u1')!.refreshTokenEnc));
  assert.match((await svc.exportDesign(who, 'mock-design-1') as { error: string }).error, /つなぎ直して/);
  assert.equal((await svc.status(who)).connected, false);
  // 切断
  await svc.finishConnect(who, 'mock-code-x', 'v');
  assert.equal(await svc.disconnect(who), true);
  assert.equal(await svc.disconnect(who), false);
});

test('販促物: Canva で仕上げて戻すと新しい版になり、その版は会話や文面で直せず、入稿用の PDF は作れない', async () => {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, printDesigns: { enabled: true } };
  const audits: string[] = [];
  const repo = {
    findUserById: async () => ({ id: 'u1', displayName: '店員', roles: ['member'], status: 'active' }),
    getTenantSettings: async () => settings, listTenantIds: async () => ['t1'], listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string }) => { audits.push(e.action); }, getFile: async () => null,
  } as unknown as Repository;
  const stub = { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  const api = new MockCanvaApi();
  const canva = new CanvaService({ api, store: new MemoryCanvaConnectionStore(), box: new SecretBox('k'), redirectUri: 'https://a.example.jp/cb' });
  const pushed: Uint8Array[] = [];
  const signage: AnnouncementSignage = {
    enabled: async () => true, screens: async () => [{ id: 's1', name: '入口' }],
    addImage: async (_t, _u, png) => { pushed.push(png); return { assetId: `a${pushed.length}` }; },
    addToFlows: async () => ['入口'], removeAsset: async () => undefined,
  };
  const files = new MemoryFileStore();
  const svc = new PrintDesignService({ store: new MemoryPrintDesignStore(), repo, files, llmFor: async () => stub, canva, signage });
  const r = await svc.create(who, { request: '秋のセールのチラシ' });
  assert.ok(!('error' in r));
  assert.equal((await svc.links(who)).canva, 'connect');
  await canva.finishConnect(who, 'mock-code-1', 'v');
  assert.equal((await svc.links(who)).canva, 'ready');
  assert.match((await svc.openInCanva(who, r.design.id) as { error: string }).error, /案を 1 つ選んで/);
  assert.match((await svc.pullFromCanva(who, r.design.id) as { error: string }).error, /取り込んでいません/);
  await svc.choose(who, r.design.id, r.versions[1]!.id);
  const opened = await svc.openInCanva(who, r.design.id);
  assert.ok(!('error' in opened));
  assert.match(opened.editUrl, /^https:\/\/www\.canva\.com\/design\//);
  // 取り込んだのは選んだ版の PDF（実寸）
  const imported = [...api.designs.values()][0]!;
  assert.equal((await PDFDocument.load(imported.pdf)).getPageCount(), 1);
  const linked = (await svc.get(who, r.design.id))!.design.canva!;
  assert.equal(linked.versionNo, r.versions[1]!.no);
  await svc.toSignage(who, r.design.id);
  const pulled = await svc.pullFromCanva(who, r.design.id);
  assert.ok(!('error' in pulled));
  const v = pulled.versions.at(-1)!;
  assert.equal(v.template, CANVA_TEMPLATE);
  assert.equal(pulled.design.currentVersionId, v.id);
  // 書き出し: PDF と PNG は Canva から書き出したもの、入稿用の PDF は作れない
  const pdf = (await svc.export(who, r.design.id, v.id, 'pdf'))!;
  assert.ok(!('error' in pdf) && Buffer.from(pdf.bytes).equals(Buffer.from(imported.pdf)));
  assert.match((await svc.export(who, r.design.id, v.id, 'bleed') as { error: string }).error, /入稿用の PDF を作れません/);
  const thumb = (await svc.thumb(who, r.design.id))!;
  assert.equal(thumb.bytes[0], 0x89);
  // 流している画像は、Canva から書き出した PNG に差し替わる
  assert.equal(pushed.length, 2);
  assert.ok(Buffer.from(pushed[1]!).equals(Buffer.from((await files.get('t1', `print-${v.id}-canvapng`))!)));
  // 会話・文面・作り直しはできない。前の版に戻せば直せる
  assert.match((await svc.revise(who, r.design.id, '見出しをもっと大きく') as { error: string }).error, /Canva で直した版/);
  assert.match((await svc.editCopy(who, r.design.id, { headline: 'x' }) as { error: string }).error, /Canva で直した版/);
  assert.match((await svc.remake(who, r.design.id, '') as { error: string }).error, /Canva で直した版/);
  await svc.choose(who, r.design.id, r.versions[1]!.id);
  assert.ok(!('error' in (await svc.revise(who, r.design.id, '見出しをもっと大きく'))));
  assert.ok(audits.includes('print.canva.open') && audits.includes('print.canva.pull'));
  // Canva を設定していない会社では出さない
  const plain = new PrintDesignService({ store: new MemoryPrintDesignStore(), repo, files, llmFor: async () => stub });
  assert.equal((await plain.links(who)).canva, 'none');
  // 大きな PNG は案の小さな画像に縮める
  const big = renderCover({ title: '大', background: { kind: 'template', pattern: 'dots', color: '#335577' } });
  assert.ok(shrinkPng(big, 300).length < big.length);
  // 幅が足りていれば、そのまま返す
  const small = samplePng();
  assert.equal(shrinkPng(small, 5000), small);
});

test('Canva 用の PDF: 地と写真は画像、字は字のまま（同じ位置・太さ）で書く。印刷用の PDF は字を持たない（第41.19.3節）', async () => {
  const { layout, toCanvaPdf, toPdf, splitSvgText } = await import('../src/index.js');
  const { extractPdfText } = await import('../src/files/pdf.js');
  const company = { name: '見本商店', address: '東京都千代田区1-1', phone: '03-1234-5678', website: 'https://www.example.jp' };
  const pages = layout({
    size: 'A4', template: 'band', color: '#1f8a80', palette: 0, headlineScale: 1,
    copy: { headline: '秋の感謝祭', sub: '全品 1 割引', body: '10 月 1 日から 10 日まで\n皆さまのご来店をお待ちしています', period: '', price: '', note: '', qrUrl: '' },
    image: null, logo: null, qr: null, company,
  });
  const { lines, base } = splitSvgText(pages[0]!.svg);
  assert.ok(lines.some((l) => l.text === '秋の感謝祭' && l.weight === 700));
  assert.doesNotMatch(base, /<text/);
  const canva = await toCanvaPdf(pages, 'A4');
  const text = (await extractPdfText(canva)).pages.map((p) => p.text).join('');
  assert.match(text.replace(/\s/g, ''), /秋の感謝祭/);
  assert.match(text.replace(/\s/g, ''), /ご来店をお待ちしています/);
  // 書体の名前は素の形（Canva が同じ書体と見分けるため）
  // 波ダッシュは、Canva の書体にある全角のチルダにする
  const { forCanva } = await import('../src/index.js');
  assert.equal(forCanva('午後2時〜5時'), '午後2時～5時');
  const { PDFDict, PDFName } = await import('pdf-lib');
  const loaded = await PDFDocument.load(canva);
  const names = new Set(loaded.context.enumerateIndirectObjects()
    .map(([, o]) => (o instanceof PDFDict ? o.get(PDFName.of('BaseFont')) : undefined)).filter(Boolean).map((n) => String(n)));
  assert.ok(names.has('/NotoSansJP-Bold') && names.has('/NotoSansJP-Regular'), [...names].join(','));
  const print = await toPdf(pages, 'A4', 'trim');
  assert.doesNotMatch((await extractPdfText(print)).pages.map((p) => p.text).join(''), /感謝祭/);
});
