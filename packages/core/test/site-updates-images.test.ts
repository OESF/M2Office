/**
 * @file サイトの更新の段 2a の画像（仕様書 第45.18.2節）の試験。ページの中の画像を数えて 1 つだけ差し替える・代わりの文を直すこと、
 * 渡した画像・AI の挿絵を用意して承認の後に入れ、元に戻すこと、どの画像か分からなければ聞き返すこと。
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  SiteUpdateService, MemorySiteEditStore, MemoryWordPressUserStore, MemoryFileStore, saveFile, buildActions, readActionPlan, editPageImage, pageImages,
  type LlmProvider, type LlmRequest, type Repository, type StoredFile,
} from '../src/index.js';

const SITE = 'https://www.example.jp';

const HTML = `<!-- wp:heading -->
<h2>店の外観</h2>
<!-- /wp:heading -->

<!-- wp:image {"id":12,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="${SITE}/wp-content/uploads/shop-old.jpg" alt="" class="wp-image-12" srcset="${SITE}/a.jpg 300w" sizes="100vw"/></figure>
<!-- /wp:image -->

<!-- wp:paragraph -->
<p>本文はそのまま</p>
<!-- /wp:paragraph -->

<!-- wp:gallery -->
<figure class="wp-block-gallery"><figure class="wp-block-image"><img src="${SITE}/g1.jpg" alt="ギャラリー" class="wp-image-20"/></figure></figure>
<!-- /wp:gallery -->

<!-- wp:image {"id":13} -->
<figure class="wp-block-image"><img src="${SITE}/wp-content/uploads/staff.png" alt="" class="wp-image-13"/></figure>
<!-- /wp:image -->`;

test('画像を数える: 上から番号を振り、ファイル名・代わりの文・メディアの番号・すぐ前の見出しを持ち、ギャラリーの中を見分ける', () => {
  const imgs = pageImages(HTML);
  assert.deepEqual(imgs.map((i) => [i.index, i.file, i.mediaId, i.inGallery]), [[1, 'shop-old.jpg', 12, false], [2, 'g1.jpg', 20, true], [3, 'staff.png', 13, false]]);
  assert.equal(imgs[0]!.heading, '店の外観');
  assert.equal(imgs[1]!.alt, 'ギャラリー');
});

test('差し替え: その画像の src・メディアの番号・ブロックの印だけを直し、srcset を外す。外は 1 文字も変えない。ギャラリーの中は断る', () => {
  const r = editPageImage(HTML, 1, { media: { id: 99, url: `${SITE}/wp-content/uploads/shop-new.png` }, alt: '明るい店の入り口' });
  assert.ok('html' in r);
  assert.ok(r.html.includes('<!-- wp:image {"id":99,"sizeSlug":"large"} -->'), 'ブロックの印の番号を直す');
  assert.ok(r.html.includes(`<img src="${SITE}/wp-content/uploads/shop-new.png" alt="明るい店の入り口" class="wp-image-99"/>`), r.html);
  assert.ok(!r.html.includes('srcset'), '古い画像の候補を持ち越さない');
  const tail = (s: string) => s.slice(s.indexOf('<!-- wp:paragraph'));
  assert.equal(tail(r.html), tail(HTML), '後ろの部分は変えない');
  assert.ok(r.html.startsWith(HTML.slice(0, HTML.indexOf('<!-- wp:image'))), '前の部分は変えない');
  assert.ok('error' in editPageImage(HTML, 2, { media: { id: 1, url: 'x' } }), 'ギャラリーの中は扱わない');
  assert.ok('error' in editPageImage(HTML, 9, { alt: 'x' }), '無い番号は断る');
  const alt = editPageImage(HTML, 3, { alt: '受付の "スタッフ"' });
  assert.ok('html' in alt);
  assert.equal(alt.html, HTML.replace(`staff.png" alt=""`, `staff.png" alt="受付の &quot;スタッフ&quot;"`), '代わりの文だけを直す（引用符は印の中で崩さない）');
});

test('どの画像か: 番号・位置で決まらず、選ぶ手立ても無ければ、番号と手がかりを並べて聞き返す', async () => {
  const ctx = {
    now: new Date('2026-11-13T00:00:00Z'), revisions: async () => [],
    read: async () => ({ title: '会社案内', link: `${SITE}/about`, status: 'publish', date: '', modifiedGmt: 'm1', featuredMedia: 0, content: HTML, excerpt: '' }),
  };
  const plan = readActionPlan({ images: [{ kind: 'page', id: 41, which: 'スタッフじゃないほう', image: '', alt: '入り口' }] });
  const r = await buildActions(plan, '画像の代わりの文を直して', ctx);
  assert.ok(r.ask?.includes('画像が 2 枚あります') && r.ask.includes('1. shop-old.jpg') && r.ask.includes('見出し「店の外観」の下'), r.ask);
  const byNumber = await buildActions(readActionPlan({ images: [{ kind: 'page', id: 41, which: '3 番目', image: '', alt: '受付のスタッフ' }] }), '', ctx);
  assert.equal(byNumber.ask, undefined);
  const a = byNumber.actions[0]!;
  assert.ok(a.op === 'image' && a.edits[0]!.index === 3 && a.edits[0]!.altAfter === '受付のスタッフ', '聞き返しに出した番号（上から数えた番号）で選べる');
});

/** 偽の WordPress（固定ページ 41 と記事・メディア）と、サイトの画像。 */
function fakeSite(t: TestContext) {
  const pages = new Map<string, { title: string; content: string; modified: string; featured: number; kind: string; status: string }>([
    ['41', { title: '会社案内', content: HTML, modified: 'm41', featured: 0, kind: 'page', status: 'publish' }],
  ]);
  const media: { type: string; id: number }[] = [];
  let next = 700;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (u.pathname === '/wp-json/wp/v2/users/me') return Response.json({ name: '会社', roles: ['editor'], capabilities: { edit_pages: true, edit_published_pages: true, edit_others_pages: true, edit_posts: true, edit_published_posts: true, edit_others_posts: true } });
    if (u.pathname === '/wp-json/wp/v2/types') return Response.json({});
    if (u.pathname === '/wp-json/wp/v2/media' && method === 'POST') {
      const id = next++;
      media.push({ type: String((init?.headers as Record<string, string>)['content-type']), id });
      return Response.json({ id, source_url: `${SITE}/wp-content/uploads/new-${id}.png` }, { status: 201 });
    }
    if (/^\/wp-json\/wp\/v2\/media\/\d+$/.test(u.pathname)) return Response.json({});
    if (u.pathname.startsWith('/wp-content/uploads/')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    const list = /^\/wp-json\/wp\/v2\/(posts|pages)$/.exec(u.pathname);
    if (list) {
      const kind = list[1] === 'posts' ? 'post' : 'page';
      if (method === 'POST') {
        const id = String(next++);
        pages.set(id, { title: String(body['title']), content: String(body['content']), modified: `m${id}`, featured: Number(body['featured_media'] ?? 0), kind, status: String(body['status']) });
        return Response.json({ id: Number(id), link: `${SITE}/?p=${id}` }, { status: 201 });
      }
      return Response.json([...pages].filter(([, v]) => v.kind === kind).map(([id, v]) => ({ id: Number(id), title: { raw: v.title }, status: v.status, date: '2026-11-01T00:00:00', link: `${SITE}/?p=${id}` })));
    }
    const one = /^\/wp-json\/wp\/v2\/(posts|pages)\/(\d+)$/.exec(u.pathname);
    if (one) {
      const v = pages.get(one[2]!);
      if (!v) return new Response('', { status: 404 });
      if (method === 'DELETE') { v.status = 'trash'; return Response.json({}); }
      if (method === 'POST') {
        if (typeof body['content'] === 'string') v.content = body['content'];
        if (typeof body['featured_media'] === 'number') v.featured = body['featured_media'];
        v.modified = `m${next++}`;
        return Response.json({ modified_gmt: v.modified, link: `${SITE}/?p=${one[2]}` });
      }
      return Response.json({ id: Number(one[2]), title: { raw: v.title }, link: `${SITE}/?p=${one[2]}`, status: v.status, date: '2026-11-01T00:00:00', modified_gmt: v.modified, featured_media: v.featured, content: { raw: v.content }, excerpt: { raw: '' } });
    }
    return new Response('', { status: 404 });
  });
  return { pages, media };
}

function setup(llm: LlmProvider, settingsPatch: Partial<TenantSettings['webColumns']> = {}) {
  const settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS, siteUpdates: { enabled: true, adminApproval: false },
    webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, wordpress: { siteUrl: SITE, username: 'm2office' }, ...settingsPatch },
  };
  const fileMeta = new Map<string, StoredFile>();
  const repo = {
    getTenantSettings: async () => settings,
    getTenantCredential: async () => ({ tenantId: 't1', kind: 'wordpress', secretEnc: 'enc:x', meta: {}, updatedBy: 'b', updatedAt: '' }),
    listUserGroupIds: async () => [], appendAudit: async () => undefined,
    createFile: async (m: StoredFile) => { fileMeta.set(m.id, m); },
    getFile: async (_t: string, id: string) => fileMeta.get(id) ?? null,
  } as unknown as Repository;
  const files = new MemoryFileStore();
  let used = 0;
  const store = new MemorySiteEditStore();
  const service = new SiteUpdateService({
    store, users: new MemoryWordPressUserStore(), repo, files, box: { encrypt: (v: string) => v, decrypt: (v: string) => v.slice(4) } as never,
    llmFor: async () => llm, submitter: async () => 'run-1', sleep: async () => undefined,
    aiUsage: async () => ({ used, limit: 100 }),
  });
  return { service, repo, files, store, setUsed: (n: number) => { used = n; } };
}

const who = { tenantId: 't1', userId: 'u1' };

test('渡した画像: 新しい記事のアイキャッチと、ページの最初の画像の差し替えに使い、代わりの文の無い画像には AI が見て書く。元に戻すと直す前の本文', async (t) => {
  const site = fakeSite(t);
  const looked: number[] = [];
  const llm = {
    name: 'fake',
    async complete(req: LlmRequest) {
      const text = String(req.messages[0]!.content);
      assert.ok(text.includes('1. shop.png'), '渡された画像を推論に伝える');
      return {
        text: JSON.stringify({
          create: [{ kind: 'post', title: '新しいお店', body: '新しいお店ができました。', excerpt: '', publish: 'draft', eyecatch: true, image: 'file:1' }],
          images: [{ kind: 'page', id: 41, which: '最初', image: 'file:1', alt: null }, { kind: 'page', id: 41, which: 'missing', image: '', alt: null }],
        }), tokensUsed: 1,
      };
    },
    async extractFromImage(req: { bytes: Uint8Array }) {
      looked.push(req.bytes.byteLength);
      return { text: JSON.stringify({ description: req.bytes.byteLength === 4 ? '受付に立つスタッフ' : '明るい店の入り口', hasPeople: false }), tokensUsed: 1 };
    },
  } as unknown as LlmProvider;
  const { service, repo, files } = setup(llm);
  const shop = await saveFile(repo, files, { tenantId: 't1', ownerUserId: 'u1', name: 'shop.png', kind: 'png', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), origin: 'upload', runId: null });
  const other = await saveFile(repo, files, { tenantId: 't1', ownerUserId: 'u2', name: 'other.png', kind: 'png', bytes: new Uint8Array([9]), origin: 'upload', runId: null });

  const r = await service.proposeActions(who, 'この写真で新しいお店の記事を作ってアイキャッチに。会社案内の最初の画像もこの写真にして、代わりの文の無い画像に代わりの文を付けて', [shop.id, other.id]);
  assert.ok('edit' in r, JSON.stringify(r));
  assert.ok(r.notes.some((n) => n.includes('画像（PNG・JPEG・WebP）でないものは使いません')), 'ほかの人のファイルは使わない');
  const p = (await service.preview(who, r.edit.id))!;
  assert.ok(p.shown.includes('記事「新しいお店」を作る（下書き）。アイキャッチに渡した画像「shop.png」を付ける'), p.shown);
  assert.ok(p.shown.includes('1 番目（shop-old.jpg）を渡した画像「shop.png」に差し替える（代わりの文「明るい店の入り口」）'), p.shown);
  assert.ok(p.shown.includes('3 番目（staff.png）の代わりの文を「なし」から「受付に立つスタッフ」にする'), 'サイトの画像を読んで書く');
  assert.equal(site.media.length, 0, '承認の前には何も入れない');
  assert.deepEqual(r.edit.actions.map((a) => a.images), [[shop.id], [shop.id]], '画面に見本を出す');
  assert.ok(await service.imageFile(who, r.edit.id, shop.id), '直しが使う画像は返す');
  assert.equal(await service.imageFile(who, r.edit.id, other.id), null, '直しが使わない画像は返さない');

  const a = await service.apply(who, r.edit.id, p.digest);
  assert.ok('edit' in a && a.edit.status === 'applied', JSON.stringify(a));
  assert.equal(site.media.length, 2);
  const post = [...site.pages.values()].find((v) => v.title === '新しいお店')!;
  assert.equal(post.featured, site.media[0]!.id, 'アイキャッチに付ける');
  const page = site.pages.get('41')!;
  const newId = site.media[1]!.id;
  assert.ok(page.content.includes(`<!-- wp:image {"id":${newId},"sizeSlug":"large"} -->`) && page.content.includes(`src="${SITE}/wp-content/uploads/new-${newId}.png" alt="明るい店の入り口" class="wp-image-${newId}"`), page.content);
  assert.ok(page.content.includes('alt="受付に立つスタッフ" class="wp-image-13"'));
  assert.ok(page.content.includes('alt="ギャラリー"'), 'ギャラリーは変えない');

  const back = await service.revert(who, r.edit.id);
  assert.ok('edit' in back, JSON.stringify(back));
  const pv = (await service.preview(who, back.edit.id))!;
  assert.ok(pv.shown.includes('「会社案内」を、直す前の本文に戻す'), pv.shown);
  await service.apply(who, back.edit.id, pv.digest);
  assert.equal(site.pages.get('41')!.content, HTML, '直す前の本文に戻す（入れたメディアは消さない）');
  assert.equal(post.status, 'trash');
});

test('AI の挿絵: 設定が入で上限の内なら描いて差し替えに使い、月の数に数える。設定が切りなら描かずに理由を返す', async (t) => {
  fakeSite(t);
  let drew = 0;
  const llm = {
    name: 'fake',
    async complete() { return { text: JSON.stringify({ images: [{ kind: 'page', id: 41, which: '1', image: 'ai', alt: '店の入り口のイラスト' }] }), tokensUsed: 1 }; },
    async generateImage() { drew += 1; return { bytes: new Uint8Array([7, 7, 7]), mimeType: 'image/png' }; },
  } as unknown as LlmProvider;
  const on = setup(llm, { aiIllustration: true });
  const r = await on.service.proposeActions(who, '会社案内の最初の画像を AI の絵にして');
  assert.ok('edit' in r, JSON.stringify(r));
  assert.equal(drew, 1);
  const p = (await on.service.preview(who, r.edit.id))!;
  assert.ok(p.shown.includes('1 番目（shop-old.jpg）を AI の挿絵に差し替える（代わりの文「店の入り口のイラスト」）'), p.shown);
  const saved = (await on.store.get('t1', r.edit.id))!.actions[0]!;
  assert.equal('aiAttempts' in saved ? saved.aiAttempts : 0, 1, '描いた数を月の上限に数える');

  on.setUsed(100);
  const full = await on.service.proposeActions(who, '会社案内の最初の画像を AI の絵にして');
  assert.ok('error' in full && full.error.includes('今月の AI の挿絵の上限（100 枚）'), JSON.stringify(full));
  assert.equal(drew, 1, '上限に達したら描かない');

  const off = setup(llm, { aiIllustration: false });
  const r2 = await off.service.proposeActions(who, '会社案内の最初の画像を AI の絵にして');
  assert.ok('error' in r2 && r2.error.includes('AI で挿絵を描く設定が切りです'), JSON.stringify(r2));
});
