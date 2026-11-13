/**
 * @file WordPress の投稿の種類（カスタム投稿タイプ）と、お知らせとコラムの入れ先の単体テスト（仕様書 第45.20節、ADR-0144）。
 * 種類の一覧を読む・お知らせらしい種類を選ぶ（1 つならそれを残す・2 つ以上で決められなければ聞き返す）・その種類の分類に入れる・
 * コラムにカテゴリーを付ける。偽の WordPress で確かめる。
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  AnnouncementService, MemoryAnnouncementStore, StubLlmProvider, SiteUpdateService, MemorySiteEditStore, MemoryWordPressUserStore,
  categoryFieldOf, createWordPressDraft, createWordPressPost, listPostTypes, parseWpRef, pickColumnTypes, pickNewsTypes, wpRef,
  type LlmProvider, type Repository, type TenantCredential,
} from '../src/index.js';

const SITE = 'https://www.example.jp';
const auth = { siteUrl: SITE, username: 'm2office', password: 'x' };

/** 偽の WordPress。`types` を差し替えられる。 */
function fakeWp(t: TestContext, types: Record<string, unknown>) {
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (u.pathname === '/wp-json/wp/v2/types') return Response.json(types);
    if (u.pathname === '/wp-json/wp/v2/taxonomies') {
      return Response.json({
        category: { name: 'カテゴリー', rest_base: 'categories', hierarchical: true },
        post_tag: { name: 'タグ', rest_base: 'tags', hierarchical: false },
        news_category: { name: 'お知らせの分類', rest_base: 'news_category', hierarchical: true },
      });
    }
    if (method === 'GET' && /^\/wp-json\/wp\/v2\/(categories|news_category)$/.test(u.pathname)) return Response.json([]);
    if (method === 'POST') {
      posted.push({ path: u.pathname, body });
      return Response.json({ id: 77, link: `${SITE}/news/77` }, { status: 201 });
    }
    return new Response('', { status: 404 });
  });
  return { posted };
}

const BASE_TYPES = {
  post: { name: '投稿', slug: 'post', rest_base: 'posts', taxonomies: ['category', 'post_tag'] },
  page: { name: '固定ページ', slug: 'page', rest_base: 'pages', taxonomies: [] },
  attachment: { name: 'メディア', slug: 'attachment', rest_base: 'media', taxonomies: [] },
};

test('種類の一覧: 記事でない種類を除き、お知らせらしい種類を名前と表示名で選び、その種類の分類を決める', async (t) => {
  fakeWp(t, { ...BASE_TYPES, news: { name: 'お知らせ', slug: 'news', rest_base: 'news', taxonomies: ['news_category'] }, works: { name: '施工事例', slug: 'works', rest_base: 'works', taxonomies: [] } });
  const types = await listPostTypes(auth);
  assert.ok(Array.isArray(types));
  assert.deepEqual(types.map((x) => x.slug), ['post', 'page', 'news', 'works'], 'メディアは扱わない');
  assert.deepEqual(pickNewsTypes(types).map((x) => x.restBase), ['news']);
  assert.ok(pickNewsTypes([{ slug: 'topics', name: 'Topics', restBase: 'topics', taxonomies: [] }]).length === 1);
  assert.ok(pickNewsTypes([{ slug: 'blog', name: '新着情報', restBase: 'blog', taxonomies: [] }]).length === 1, '表示名でも選ぶ');
  const taxes = [{ slug: 'news_category', name: 'お知らせの分類', restBase: 'news_category', hierarchical: true }];
  assert.equal(categoryFieldOf(types.find((x) => x.slug === 'news')!, taxes)?.restBase, 'news_category');
  assert.equal(categoryFieldOf(types.find((x) => x.slug === 'post')!, [])?.restBase, 'categories');
  assert.equal(categoryFieldOf(types.find((x) => x.slug === 'works')!, taxes), null);
});

function setup() {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    announcements: { enabled: true, webPublish: 'publish', webCategory: 'お知らせ', screens: null },
    webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, wordpress: { siteUrl: SITE, username: 'm2office' } },
  };
  const creds = new Map<string, TenantCredential>([['wordpress', { tenantId: 't1', kind: 'wordpress', secretEnc: 'enc:x', meta: {}, updatedBy: 'boss', updatedAt: '' } as TenantCredential]]);
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    getTenantCredential: async (_t: string, kind: string) => creds.get(kind) ?? null,
    listUserGroupIds: async () => [],
    appendAudit: async () => undefined,
  } as unknown as Repository;
  const service = new AnnouncementService({
    store: new MemoryAnnouncementStore(), repo, box: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.slice(4) } as never,
    llmFor: async () => new StubLlmProvider(),
  });
  return { service, settings: () => settings };
}

test('お知らせの入れ先: お知らせらしい種類が 1 つならそれを選んで残し、その種類の分類で入れる', async (t) => {
  const wp = fakeWp(t, { ...BASE_TYPES, news: { name: 'お知らせ', slug: 'news', rest_base: 'news', taxonomies: ['news_category'] } });
  const { service, settings } = setup();
  const target = await service.webTarget('t1', auth, settings().announcements);
  assert.ok(!('ask' in target));
  assert.equal(target.type.restBase, 'news');
  assert.equal(target.taxonomy?.restBase, 'news_category');
  assert.equal(settings().announcements.webPostType, 'news', '選んだ入れ先を設定に残す');
  const r = await createWordPressPost(auth, { title: '年末年始', html: '<p>休みます</p>', status: 'publish', restBase: 'news', terms: { field: 'news_category', ids: [5] } });
  assert.ok(!('error' in r));
  assert.equal(wp.posted.at(-1)!.path, '/wp-json/wp/v2/news');
  assert.deepEqual(wp.posted.at(-1)!.body['news_category'], [5], 'その種類の分類に付ける');
});

test('お知らせの入れ先: 候補が 2 つ以上で決められなければ聞き返す。設定で決めればそれを使う。無ければ投稿', async (t) => {
  fakeWp(t, { ...BASE_TYPES, news: { name: 'ニュース', slug: 'news', rest_base: 'news', taxonomies: [] }, topics: { name: '新着情報', slug: 'topics', rest_base: 'topics', taxonomies: [] } });
  const { service, settings } = setup();
  const asked = await service.webTarget('t1', auth, settings().announcements);
  assert.ok('ask' in asked && asked.ask.includes('「ニュース（news）」') && asked.ask.includes('「新着情報（topics）」'), JSON.stringify(asked));
  const chosen = await service.webTarget('t1', auth, { ...settings().announcements, webPostType: 'topics' });
  assert.ok(!('ask' in chosen) && chosen.type.restBase === 'topics');
  t.mock.restoreAll();
  fakeWp(t, BASE_TYPES);
  const plain = await service.webTarget('t1', auth, settings().announcements);
  assert.ok(!('ask' in plain) && plain.type.restBase === 'posts' && plain.taxonomy?.restBase === 'categories', 'お知らせらしい種類が無ければ、いまどおり投稿');
});

test('コラム: 下書きにカテゴリーを付けて入れる', async (t) => {
  const wp = fakeWp(t, BASE_TYPES);
  const r = await createWordPressDraft(auth, { title: 'コラム', html: '<p>本文</p>', excerpt: '', categories: [12] });
  assert.ok(!('error' in r));
  assert.equal(wp.posted.at(-1)!.path, '/wp-json/wp/v2/posts');
  assert.deepEqual(wp.posted.at(-1)!.body['categories'], [12]);
  assert.equal(wp.posted.at(-1)!.body['status'], 'draft');
});

test('コラムの入れ先: コラムらしい種類を選び、種類を含めた参照で記録する（前からの ID は投稿として読む）', async (t) => {
  const wp = fakeWp(t, { ...BASE_TYPES, blog: { name: 'ブログ', slug: 'blog', rest_base: 'blog', taxonomies: ['category'] } });
  const types = await listPostTypes(auth);
  assert.ok(Array.isArray(types));
  assert.deepEqual(pickColumnTypes(types).map((x) => x.restBase), ['blog']);
  assert.equal(wpRef('blog', '9'), 'blog:9');
  assert.equal(wpRef('posts', '9'), '9');
  assert.deepEqual(parseWpRef('blog:9'), { restBase: 'blog', id: '9' });
  assert.deepEqual(parseWpRef('9'), { restBase: 'posts', id: '9' }, '前から入っている ID は投稿');
  const r = await createWordPressDraft(auth, { title: 'コラム', html: '<p>本文</p>', excerpt: '', restBase: 'blog', terms: { field: 'categories', ids: [3] } });
  assert.ok(!('error' in r));
  assert.equal(wp.posted.at(-1)!.path, '/wp-json/wp/v2/blog');
});

test('サイトの更新: カスタム投稿タイプ（news）の記事も作れる', async (t) => {
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (u.pathname === '/wp-json/wp/v2/users/me') return Response.json({ name: '会社', roles: ['editor'], capabilities: { edit_pages: true, edit_published_pages: true, edit_others_pages: true, edit_posts: true, edit_published_posts: true, edit_others_posts: true } });
    if (u.pathname === '/wp-json/wp/v2/types') return Response.json({ ...BASE_TYPES, news: { name: 'お知らせ', slug: 'news', rest_base: 'news', taxonomies: [] } });
    if (method === 'GET' && /^\/wp-json\/wp\/v2\/(posts|pages|news)$/.test(u.pathname)) return Response.json([]);
    if (method === 'POST') { posted.push({ path: u.pathname, body: JSON.parse(String(init!.body)) }); return Response.json({ id: 88, link: `${SITE}/news/88` }, { status: 201 }); }
    return new Response('', { status: 404 });
  });
  let seen = '';
  const llm = { name: 'fake', async complete(req: { messages: { content: string }[] }) { seen = String(req.messages[0]!.content); return { text: JSON.stringify({ create: [{ kind: 'news', title: '臨時休業', body: '休みます', publish: 'draft' }] }), tokensUsed: 1 }; } } as unknown as LlmProvider;
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, siteUpdates: { enabled: true, adminApproval: false }, webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, wordpress: { siteUrl: SITE, username: 'm2office' } } };
  const repo = {
    getTenantSettings: async () => settings,
    getTenantCredential: async () => ({ tenantId: 't1', kind: 'wordpress', secretEnc: 'enc:x', meta: {}, updatedBy: 'b', updatedAt: '' }),
    listUserGroupIds: async () => [], appendAudit: async () => undefined,
  } as unknown as Repository;
  const service = new SiteUpdateService({
    store: new MemorySiteEditStore(), users: new MemoryWordPressUserStore(), repo, box: { encrypt: (v: string) => v, decrypt: (v: string) => v.slice(4) } as never,
    llmFor: async () => llm, submitter: async () => 'run-1', sleep: async () => undefined,
  });
  const r = await service.proposeActions({ tenantId: 't1', userId: 'u1' }, 'お知らせに臨時休業の記事を作って');
  assert.ok('edit' in r, JSON.stringify(r));
  assert.ok(seen.includes('お知らせ（kind "news"）'), '推論にサイトの種類を伝える');
  const p = (await service.preview({ tenantId: 't1', userId: 'u1' }, r.edit.id))!;
  assert.ok(p.shown.includes('記事（news）「臨時休業」を作る（下書き）'));
  await service.apply({ tenantId: 't1', userId: 'u1' }, r.edit.id, p.digest);
  assert.equal(posted.at(-1)!.path, '/wp-json/wp/v2/news');
});
