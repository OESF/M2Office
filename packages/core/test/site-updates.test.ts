/**
 * @file サイトの更新の単体テスト（仕様書 第45章）。本文の分け方と組み直し・直し案を作って承認へ進める・承認の画面の文・
 * 承認した中身だけを入れる・ぶつかり（直し案の後に WordPress で直された）・公開のページでの確かめ・元に戻す・
 * ページビルダーのページ・権限の不足・ツールの使える範囲。偽の WordPress と偽の推論で確かめる。
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  categoryTarget, categoryAnswer, buildTermChanges, readTermPlan, asksToPublish,
  SiteUpdateService, MemorySiteEditStore, MemoryWordPressUserStore, stableJson, PostgresRepository, PostgresSiteEditStore, PostgresWordPressUserStore, SITE_UPDATE_TOOLS, applySiteEdits, segmentContent, looksLikePageBuilder, plainText, siteEditDigest,
  type LlmProvider, type LlmRequest, type Repository, type TenantCredential, type ToolContext,
} from '../src/index.js';

const SITE = 'https://www.example.jp';

const TOP = `<!-- wp:heading -->
<h2 class="wp-block-heading">営業時間</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>平日 <strong>9:00〜18:00</strong>（土日は休み）</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>電話: <a href="tel:0312345678">03-1234-5678</a></li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>メール</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->`;

type Page = { title: string; content: string; excerpt: string; link: string; status: string; modified: string };

/** 偽の WordPress（REST API と公開のページ）。 */
const FULL = { edit_pages: true, edit_published_pages: true, edit_others_pages: true, edit_posts: true, edit_published_posts: true, edit_others_posts: true };

function fakeWordPress(t: TestContext, pages: Record<string, Page>, opts: {
  caps?: Record<string, boolean>; staleCache?: boolean;
  /** 利用者ごとの役割と権限（利用者名 → 値）。無い利用者は通らない。会社の利用者 m2office は opts.caps */
  users?: Record<string, { name: string; roles: string[]; caps: Record<string, boolean> }>;
} = {}) {
  const writes: { id: string; body: Record<string, unknown>; user: string }[] = [];
  let tick = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const u = new URL(url);
    const auth = String((init?.headers as Record<string, string> | undefined)?.['authorization'] ?? '');
    const user = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')[0]! : '';
    if (u.pathname === '/wp-json/wp/v2/users/me') {
      if (user === 'm2office') return Response.json({ name: '会社', roles: ['editor'], capabilities: opts.caps ?? FULL });
      const who = opts.users?.[user];
      return who ? Response.json({ name: who.name, roles: who.roles, capabilities: who.caps }) : new Response('', { status: 401 });
    }
    if (u.pathname === '/wp-json/') return Response.json({ name: '見本の医院 &amp; 薬局', description: '駅から 5 分' });
    if (u.pathname === '/wp-json/wp/v2/posts') return Response.json([]);
    if (u.pathname === '/wp-json/wp/v2/pages') {
      const q = u.searchParams.get('search') ?? '';
      const list = Object.entries(pages).filter(([, p]) => !q || p.content.includes(q) || p.title.includes(q));
      return Response.json(list.map(([id, p]) => ({ id: Number(id), title: { raw: p.title }, link: p.link, status: p.status, type: 'page' })));
    }
    const m = /^\/wp-json\/wp\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (m) {
      const p = pages[m[1]!];
      if (!p) return new Response('', { status: 404 });
      if (method === 'POST') {
        const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
        writes.push({ id: m[1]!, body, user });
        if (typeof body['content'] === 'string') p.content = body['content'];
        if (typeof body['title'] === 'string') p.title = body['title'];
        if (typeof body['excerpt'] === 'string') p.excerpt = body['excerpt'];
        p.modified = `2026-11-12T10:00:${String(++tick).padStart(2, '0')}`;
        return Response.json({ modified_gmt: p.modified, link: p.link });
      }
      return Response.json({ id: Number(m[1]), title: { raw: p.title }, content: { raw: p.content }, excerpt: { raw: p.excerpt }, link: p.link, status: p.status, modified_gmt: p.modified });
    }
    // 公開のページ
    const hit = Object.values(pages).find((p) => p.link === `${u.origin}${u.pathname}`);
    if (hit) return new Response(`<html><body><h1>${hit.title}</h1>${opts.staleCache ? '' : hit.content}</body></html>`, { headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404 });
  });
  return { writes };
}

/** 偽の推論。ページを選ぶ問いと、直しを決める問いに、決めた答えを返す。 */
function fakeLlm(edits: unknown, pick: unknown = { pages: ['page:1'], words: ['営業時間'] }): LlmProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'fake', asked,
    async complete(req: LlmRequest) {
      const text = String(req.messages[0]!.content);
      asked.push(text);
      return { text: JSON.stringify(text.includes('本文から探す言葉') ? pick : edits), tokensUsed: 10 };
    },
  } as LlmProvider & { asked: string[] };
}

function setup(llm: LlmProvider, opts: { wordpress?: boolean; users?: MemoryWordPressUserStore } = {}) {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    siteUpdates: { enabled: true, adminApproval: false },
    webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, wordpress: opts.wordpress === false ? null : { siteUrl: SITE, username: 'm2office' } },
  };
  const creds = new Map<string, TenantCredential>();
  creds.set('wordpress', { tenantId: 't1', kind: 'wordpress', secretEnc: 'enc:abcd efgh', meta: {}, updatedBy: 'boss', updatedAt: '' } as TenantCredential);
  const audits: string[] = [];
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    getTenantCredential: async (_t: string, kind: string) => creds.get(kind) ?? null,
    listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Repository;
  const store = new MemorySiteEditStore();
  const submitted: string[] = [];
  const service = new SiteUpdateService({
    store, repo, users: opts.users ?? new MemoryWordPressUserStore(), box: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.slice(4) } as never,
    llmFor: async () => llm, submitter: async (_t, _u, id) => { submitted.push(id); return `run-${submitted.length}`; },
    sleep: async () => undefined,
  });
  return { service, store, audits, submitted, settings: () => settings, setSettings: (s: TenantSettings) => { settings = s; } };
}

const who = { tenantId: 't1', userId: 'u1' };
const top = (): Record<string, Page> => ({ 1: { title: 'トップ', content: TOP, excerpt: '', link: `${SITE}/`, status: 'publish', modified: '2026-11-01T00:00:00' } });

test('分ける: 印と札はプログラムが持ち、文のかたまりだけに番号を振る', () => {
  const c = segmentContent(TOP);
  assert.deepEqual(c.segments.map((s) => [s.id, s.container, s.html]), [
    [1, 'h2', '営業時間'], [2, 'p', '平日 <strong>9:00〜18:00</strong>（土日は休み）'], [3, 'li', '電話: <a href="tel:0312345678">03-1234-5678</a>'], [4, 'li', 'メール'],
  ]);
  assert.equal(c.blocks, true);
});

test('組み直す: 頼まれた所だけを変え、消すときはブロックの印ごと外し、足すときはブロックの形で足す', () => {
  const c = segmentContent(TOP);
  const r = applySiteEdits(c, [
    { op: 'replace', id: 2, html: '平日 <strong>10:00〜18:00</strong>（土日は休み）' },
    { op: 'delete', id: 4 },
    { op: 'insert', after: 3, html: 'FAX: 03-1234-5679', kind: 'list-item' },
  ]);
  assert.ok(r.ok);
  assert.ok(r.raw.includes('<p>平日 <strong>10:00〜18:00</strong>（土日は休み）</p>'));
  assert.ok(!r.raw.includes('<li>メール</li>') && !/wp:list-item -->\s*<li>メール/.test(r.raw), '消した行は印ごと外す');
  assert.ok(r.raw.includes('<!-- wp:list-item -->\n<li>FAX: 03-1234-5679</li>\n<!-- /wp:list-item -->'), '足す行はブロックの形');
  assert.ok(r.raw.startsWith('<!-- wp:heading -->\n<h2 class="wp-block-heading">営業時間</h2>'), '頼まれていない所は 1 文字も変えない');
  assert.deepEqual(r.changed, [2, 3, 4]);
});

test('組み直す: スクリプト・見た目の指定・知らない札・表のますを消すことは断る', () => {
  const c = segmentContent(TOP);
  assert.equal((applySiteEdits(c, [{ op: 'replace', id: 2, html: 'x<script>alert(1)</script>' }]) as { error: string }).error, 'スクリプト・埋め込み・見た目の指定は足せません');
  assert.ok('error' in applySiteEdits(c, [{ op: 'replace', id: 2, html: '<span style="color:red">x</span>' }]));
  assert.ok('error' in applySiteEdits(c, [{ op: 'replace', id: 2, html: '<img src="x">' }]), '画像の札は足せない');
  assert.ok('error' in applySiteEdits(c, [{ op: 'replace', id: 2, html: '<a href="javascript:alert(1)">x</a>' }]));
  assert.ok(applySiteEdits(c, [{ op: 'replace', id: 2, html: '平日 <a href="https://www.example.jp/hours">10 時から</a>' }]).ok, 'https のリンクは足せる');
  const table = segmentContent('<table><tr><td>月</td><td>休み</td></tr></table>');
  assert.ok('error' in applySiteEdits(table, [{ op: 'delete', id: 2 }]), '表のますは消せない');
  assert.ok(applySiteEdits(table, [{ op: 'replace', id: 2, html: '10 時から' }]).ok);
});

test('ページビルダーを見分け、HTML から人が読む文を取り出す', () => {
  assert.ok(looksLikePageBuilder('[et_pb_section][et_pb_text]x[/et_pb_text][/et_pb_section]'));
  assert.ok(looksLikePageBuilder('<div class="elementor elementor-12">x</div>'));
  assert.equal(looksLikePageBuilder(TOP), null);
  assert.equal(plainText('<p>平日&nbsp;<b>9時</b></p><script>x()</script>'), '平日 9時');
});

test('直し案: ページと場所を探して直し案を作り、承認へ進める。承認の画面に直す前と後を出す', async (t) => {
  const pages = top();
  const { writes } = fakeWordPress(t, pages);
  const llm = fakeLlm({ pages: [{ key: 'page:1', title: null, excerpt: null, ops: [{ op: 'replace', id: 2, html: '平日 <strong>10:00〜18:00</strong>（土日は休み）' }] }], note: '' });
  const { service, store, submitted, audits } = setup(llm);
  const r = await service.propose(who, 'トップの営業時間を 10 時からにして');
  assert.ok('edit' in r, JSON.stringify(r));
  assert.equal(r.runId, 'run-1');
  assert.equal(r.edit.status, 'awaiting');
  assert.deepEqual(r.edit.pages[0]!.changes, [{ before: '平日 9:00〜18:00（土日は休み）', after: '平日 10:00〜18:00（土日は休み）' }]);
  assert.equal(writes.length, 0, '承認の前にはサイトに入れない');
  assert.deepEqual(submitted, [r.edit.id]);
  assert.deepEqual(audits, ['site_edit.propose']);
  // 推論には文のかたまりだけを渡す（ブロックの印は渡さない）
  assert.ok(!llm.asked[1]!.includes('<!-- wp:'), '印は渡さない');
  assert.ok(llm.asked[1]!.includes('頼み（データ）'), '頼みはデータとして渡す');

  const p = (await service.preview(who, r.edit.id))!;
  assert.ok(p.headline.startsWith('サイトの 1 ページを直します: トップ'));
  assert.ok(p.shown.includes('直す前: 平日 9:00〜18:00（土日は休み）') && p.shown.includes('直した後: 平日 10:00〜18:00（土日は休み）'));
  assert.ok(p.shown.includes('公開中のまま、すぐにサイトに出ます'));
  assert.equal(p.digest, siteEditDigest((await store.get('t1', r.edit.id))!));
});

test('入れる: 承認した中身だけを入れ、公開のページで確かめる。指紋が違えば入れない', async (t) => {
  const pages = top();
  const { writes } = fakeWordPress(t, pages);
  const { service, audits } = setup(fakeLlm({ pages: [{ key: 'page:1', title: null, excerpt: null, ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }));
  const r = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in r);
  const p = (await service.preview(who, r.edit.id))!;
  assert.ok('error' in await service.apply(who, r.edit.id, 'wrong'), '指紋が違えば入れない');
  assert.equal(writes.length, 0);
  assert.equal((await service.get(who, r.edit.id))!.status, 'failed', '入れられなかった直しは承認待ちのまま残さない');
  const r2 = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in r2);
  const a = await service.apply(who, r2.edit.id, (await service.preview(who, r2.edit.id))!.digest);
  assert.ok('edit' in a);
  assert.equal(a.edit.status, 'applied');
  assert.equal(a.edit.pages[0]!.result, 'applied', '公開のページで確かめた');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.body['status'], undefined, '公開の状態は変えない');
  assert.ok(pages[1]!.content.includes('<p>平日 10:00〜18:00</p>'));
  assert.ok(audits.includes('site_edit.apply'));
  assert.ok('error' in await service.apply(who, r2.edit.id, (await service.preview(who, r2.edit.id).catch(() => null))?.digest ?? p.digest), '2 度は入れない');
});

test('入れる: 直し案の後に WordPress で直されていれば上書きしない。表示が変わらなければそう伝える', async (t) => {
  const pages = top();
  fakeWordPress(t, pages, { staleCache: true });
  const { service } = setup(fakeLlm({ pages: [{ key: 'page:1', title: null, excerpt: null, ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }));
  const r = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in r);
  const p = (await service.preview(who, r.edit.id))!;
  pages[1]!.modified = '2026-11-12T09:00:00';
  const a = await service.apply(who, r.edit.id, p.digest);
  assert.ok('edit' in a);
  assert.equal(a.edit.status, 'failed');
  assert.equal(a.edit.pages[0]!.result, 'conflict');

  // 表示が変わらない（キャッシュ）
  const again = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in again);
  const p2 = (await service.preview(who, again.edit.id))!;
  const b = await service.apply(who, again.edit.id, p2.digest);
  assert.ok('edit' in b);
  assert.equal(b.edit.pages[0]!.result, 'unverified');
  assert.equal(b.edit.status, 'applied', '入れたことは入れた');
  assert.ok(b.edit.pages[0]!.reason.includes('表示がまだ変わっていません'));
});

test('元に戻す: 直す前の文に戻す案を承認へ進め、入れたら元の直しを「元に戻した」にする。人が直した後は戻さない', async (t) => {
  const pages = top();
  fakeWordPress(t, pages);
  const { service } = setup(fakeLlm({ pages: [{ key: 'page:1', title: 'ホーム', excerpt: null, ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }));
  const r = await service.propose(who, '営業時間を 10 時からにして、題名をホームに');
  assert.ok('edit' in r);
  await service.apply(who, r.edit.id, (await service.preview(who, r.edit.id))!.digest);
  assert.equal(pages[1]!.title, 'ホーム');
  const back = await service.revert(who, r.edit.id);
  assert.ok('edit' in back, JSON.stringify(back));
  assert.equal(back.edit.revertOf, r.edit.id);
  const pv = (await service.preview(who, back.edit.id))!;
  assert.ok(pv.headline.includes('元に戻します'));
  await service.apply(who, back.edit.id, pv.digest);
  assert.equal(pages[1]!.content, TOP, '直す前の本文に戻る');
  assert.equal(pages[1]!.title, 'トップ', '題名も戻る');
  assert.equal((await service.get(who, r.edit.id))!.status, 'reverted');
  assert.equal((await service.get(who, r.edit.id))!.revertible, false);

  // 入れた後に人が直したら戻さない
  const r2 = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in r2);
  await service.apply(who, r2.edit.id, (await service.preview(who, r2.edit.id))!.digest);
  pages[1]!.content += '\n<p>人が足した</p>';
  const blocked = await service.revert(who, r2.edit.id);
  assert.ok('error' in blocked && blocked.error.includes('入れた後に WordPress で直されています'));
});

test('90 日を過ぎた直しは、本文を消して元に戻せなくする', async (t) => {
  fakeWordPress(t, top());
  const { service, store } = setup(fakeLlm({ pages: [{ key: 'page:1', title: null, excerpt: null, ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }));
  const r = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in r);
  await service.apply(who, r.edit.id, (await service.preview(who, r.edit.id))!.digest);
  store.setCreatedAt(r.edit.id, new Date(Date.now() - 91 * 86_400_000).toISOString());
  assert.equal(await service.purgeOld('t1'), 1);
  const e = (await service.get(who, r.edit.id))!;
  assert.equal(e.purged, true);
  assert.equal(e.revertible, false);
  assert.deepEqual(e.pages[0]!.changes, [], '直す前と後の文は消す');
  assert.ok('error' in await service.revert(who, r.edit.id));
});

test('直せないとき: ページビルダーのページは直さず依頼文の例を返す。権限の不足・未接続・直す所が無いときは理由を返す', async (t) => {
  const builder: Record<string, Page> = { 1: { title: 'トップ', content: '[et_pb_section][et_pb_text]営業時間 9 時[/et_pb_text][/et_pb_section]', excerpt: '', link: `${SITE}/`, status: 'publish', modified: 'x' } };
  fakeWordPress(t, builder);
  const s1 = setup(fakeLlm({ pages: [] }));
  const r1 = await s1.service.propose(who, '営業時間を 10 時からにして');
  assert.ok('error' in r1 && r1.error.includes('ページビルダー') && r1.error.includes('制作会社に頼む'), JSON.stringify(r1));
  assert.equal(s1.submitted.length, 0);

  const s2 = setup(fakeLlm({ pages: [] }), { wordpress: false });
  const r2 = await s2.service.propose(who, '営業時間を 10 時からにして');
  assert.ok('error' in r2 && r2.error.includes('WordPress がつながっていません'));
  t.mock.restoreAll();

  fakeWordPress(t, top(), { caps: { edit_posts: true } });
  const s3 = setup(fakeLlm({ pages: [] }));
  const r3 = await s3.service.propose(who, '営業時間を 10 時からにして');
  assert.ok('error' in r3 && r3.error.includes('「編集者」'), JSON.stringify(r3));
  t.mock.restoreAll();

  fakeWordPress(t, top());
  const s4 = setup(fakeLlm({ pages: [], note: '営業時間はどこにも書いてありません' }));
  const r4 = await s4.service.propose(who, '定休日を足して');
  assert.ok('error' in r4 && r4.error === '営業時間はどこにも書いてありません');
});

test('直し案: 決まりに合わない答えは理由を添えて 1 度だけ作り直させる', async (t) => {
  fakeWordPress(t, top());
  let n = 0;
  const llm = {
    name: 'fake',
    async complete(req: LlmRequest) {
      const text = String(req.messages[0]!.content);
      if (text.includes('本文から探す言葉')) return { text: JSON.stringify({ pages: ['page:1'], words: [] }), tokensUsed: 1 };
      n++;
      const ops = n === 1 ? [{ op: 'replace', id: 2, html: '<script>x</script>' }] : [{ op: 'replace', id: 2, html: '平日 10 時から' }];
      if (n === 2) assert.ok(text.includes('前の答えは、次の理由で使えなかった'));
      return { text: JSON.stringify({ pages: [{ key: 'page:1', ops }] }), tokensUsed: 1 };
    },
  } as LlmProvider;
  const { service } = setup(llm);
  const r = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in r, JSON.stringify(r));
  assert.equal(n, 2);
});

test('ツール: 使えない会社・人には使えないと返し、入れるツールは承認の前に直す前と後を組み立てる', async (t) => {
  fakeWordPress(t, top());
  const { service, setSettings, settings } = setup(fakeLlm({ pages: [{ key: 'page:1', ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }));
  const tool = (name: string) => SITE_UPDATE_TOOLS.find((x) => x.name === name)!;
  let usable = true;
  const ctx = { tenantId: 't1', userId: 'u1', siteUpdates: { service, access: async () => (usable ? settings().siteUpdates : null) } } as unknown as ToolContext;
  const proposed = await tool('site_updates.propose').invoke({ request: '営業時間を 10 時からにして' }, ctx) as { available: boolean; editId: string };
  assert.equal(proposed.available, true);
  const prepared = await tool('site_updates.apply').prepare!({ editId: proposed.editId }, ctx);
  assert.equal(prepared.kind, 'ready');
  assert.ok(prepared.kind === 'ready' && prepared.shown!.includes('直した後: 平日 10:00〜18:00') && typeof prepared.args['digest'] === 'string');
  assert.equal(tool('site_updates.apply').risk, 'external-send');
  assert.equal(tool('site_updates.propose').risk, 'write-internal');
  usable = false;
  assert.equal((await tool('site_updates.list').invoke({}, ctx) as { available: boolean }).available, false);
  setSettings({ ...settings(), siteUpdates: { enabled: false, adminApproval: false } });
});

test('つないでいるサイト: 名前・URL・利用者と、直せるか（権限）を返す。つないでいなければそう返す', async (t) => {
  fakeWordPress(t, top());
  const { service } = setup(fakeLlm({ pages: [] }));
  assert.deepEqual(await service.site(who), {
    connected: true, siteUrl: SITE, account: { kind: 'company', username: 'm2office', displayName: '会社', roles: ['編集者'] },
    name: '見本の医院 & 薬局', description: '駅から 5 分', missing: [], problem: null,
  });
  t.mock.restoreAll();
  fakeWordPress(t, top(), { caps: { edit_posts: true, edit_pages: true } });
  const s2 = await setup(fakeLlm({ pages: [] })).service.site(who);
  assert.deepEqual(s2.missing, ['edit_published_pages', 'edit_others_pages', 'edit_published_posts', 'edit_others_posts']);
  const none = await setup(fakeLlm({ pages: [] }), { wordpress: false }).service.site(who);
  assert.equal(none.connected, false);
});

test('本人の WordPress の利用者: つないだら本人の利用者で直し案を作って入れる。つないでいない人は会社の利用者で直す', async (t) => {
  const pages = top();
  const { writes } = fakeWordPress(t, pages, { users: { bb: { name: '編集の B', roles: ['editor'], caps: FULL } } });
  const users = new MemoryWordPressUserStore();
  const { service, audits } = setup(fakeLlm({ pages: [{ key: 'page:1', ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }), { users });
  const b = { tenantId: 't1', userId: 'user-b' };
  const bad = await service.connectWordPressUser(b, { username: 'nobody', password: 'x' });
  assert.ok('error' in bad && bad.error.includes('アプリケーションパスワード'), '通らなければ預けない');
  const ok = await service.connectWordPressUser(b, { username: 'bb', password: 'abcd efgh' });
  assert.ok(!('error' in ok) && ok.connected && ok.roles[0] === '編集者' && ok.displayName === '編集の B');
  assert.equal((await users.get('t1', 'user-b'))!.secretEnc, 'enc:abcd efgh', 'パスワードは暗号化して預ける');
  assert.ok(audits.includes('connection.wordpress_user'));
  assert.deepEqual((await service.site(b)).account, { kind: 'user', username: 'bb', displayName: '編集の B', roles: ['編集者'] });

  const r = await service.propose(b, '営業時間を 10 時からにして');
  assert.ok('edit' in r);
  assert.deepEqual(r.edit.account, { kind: 'user', username: 'bb' });
  await service.apply(b, r.edit.id, (await service.preview(b, r.edit.id))!.digest);
  assert.equal(writes.at(-1)!.user, 'bb', '本人の利用者で入れる');

  // つないでいない人は会社の利用者（直す前に戻しておく）
  pages[1]!.content = TOP;
  const c = await service.propose(who, '営業時間を 10 時からにして');
  assert.ok('edit' in c);
  assert.deepEqual(c.edit.account, { kind: 'company', username: 'm2office' });
  await service.apply(who, c.edit.id, (await service.preview(who, c.edit.id))!.digest);
  assert.equal(writes.at(-1)!.user, 'm2office');
});

test('本人の WordPress の利用者: 権限が足りなければ会社の利用者に切り替えずに断る。直し案の後に外したら入れない。サイトが変われば使わない', async (t) => {
  fakeWordPress(t, top(), { users: { aa: { name: 'A', roles: ['author'], caps: { edit_posts: true } }, bb: { name: 'B', roles: ['editor'], caps: FULL } } });
  const users = new MemoryWordPressUserStore();
  const { service, settings, setSettings } = setup(fakeLlm({ pages: [{ key: 'page:1', ops: [{ op: 'replace', id: 2, html: '平日 10:00〜18:00' }] }] }), { users });
  const a = { tenantId: 't1', userId: 'user-a' };
  const connected = await service.connectWordPressUser(a, { username: 'aa', password: 'p' });
  assert.ok(!('error' in connected) && connected.missing.length > 0, '権限が足りないことを、つないだときに知らせる');
  const r = await service.propose(a, '営業時間を 10 時からにして');
  assert.ok('error' in r && r.error.includes('あなたの WordPress の利用者（aa）では'), JSON.stringify(r));

  const b = { tenantId: 't1', userId: 'user-b' };
  await service.connectWordPressUser(b, { username: 'bb', password: 'p' });
  const e = await service.propose(b, '営業時間を 10 時からにして');
  assert.ok('edit' in e);
  const digest = (await service.preview(b, e.edit.id))!.digest;
  await service.disconnectWordPressUser(b);
  const applied = await service.apply(b, e.edit.id, digest);
  assert.ok('error' in applied && applied.error.includes('あなたの WordPress の接続が外された'), '会社の利用者に切り替えない');

  await service.connectWordPressUser(b, { username: 'bb', password: 'p' });
  setSettings({ ...settings(), webColumns: { ...settings().webColumns, wordpress: { siteUrl: 'https://other.example.jp', username: 'm2office' } } });
  assert.equal((await service.wordpressUser(b)).connected, false, 'ほかのサイトの接続は使わない');
  assert.deepEqual(await service.wordpressUsers('t1'), [], '管理者の一覧にも出さない');
  assert.equal(await service.removeAllWordPressUsers('t1'), 2);
});

// 本物の PostgreSQL の置き場（2026-11-12 に、リポジトリが日時を文字で受け取る設定を全体に入れるため、日時を Date のつもりで読んで落ちた）
const APP = process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office';
const dbReady = await (async () => {
  const c = new pg.Client({ connectionString: APP, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.query(`select set_config('app.tenant_id', 't-alpha', false)`);
    await c.query('select 1 from user_wordpress_connections limit 1');
    await c.query('select auth_kind from site_edits limit 1');
    return true;
  } catch { return false; } finally { await c.end().catch(() => undefined); }
})();

test('置き場（PostgreSQL）: リポジトリと同じ接続の設定でも、本人の接続と直しの記録を読み書きできる', { skip: dbReady ? false : '開発のデータベース（移行 199 まで）が動いていません' }, async () => {
  const repo = new PostgresRepository(APP); // 日時を文字で受け取る設定が入る
  const users = new PostgresWordPressUserStore(APP);
  const edits = new PostgresSiteEditStore(APP);
  const tenant = 't-alpha';
  const userId = `test-site-updates-${Date.now()}`;
  try {
    await users.save(tenant, { userId, siteUrl: SITE, username: 'bb', secretEnc: 'enc:x', displayName: 'B', roles: ['editor', 'author'], connectedAt: '2026-11-12T00:00:00.000Z' });
    const got = await users.get(tenant, userId);
    assert.deepEqual(got, { userId, siteUrl: SITE, username: 'bb', secretEnc: 'enc:x', displayName: 'B', roles: ['editor', 'author'], connectedAt: '2026-11-12T00:00:00.000Z' });
    assert.ok((await users.list(tenant)).some((u) => u.userId === userId));
    assert.equal(await users.get('t-beta', userId), null, 'ほかの会社からは見えない');

    const id = await edits.create(tenant, { requestedBy: userId, request: 'テスト', revertOf: null, pages: [], terms: [], actions: [], digest: 'd', authKind: 'user', wpUsername: 'bb' });
    const e = (await edits.get(tenant, id))!;
    assert.equal(typeof e.createdAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(e.createdAt)));
    assert.deepEqual([e.authKind, e.wpUsername, e.appliedAt], ['user', 'bb', null]);
    await edits.update(tenant, id, { status: 'applied', appliedAt: '2026-11-12T01:00:00.000Z' });
    assert.equal((await edits.get(tenant, id))!.appliedAt, '2026-11-12T01:00:00.000Z');
    assert.ok((await edits.list(tenant, 5)).some((x) => x.id === id));
    const c = new pg.Client({ connectionString: APP });
    await c.connect();
    await c.query('begin');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
    await c.query('delete from site_edits where tenant_id = $1 and id = $2', [tenant, id]);
    await c.query('commit');
    await c.end();
  } finally {
    await users.remove(tenant, userId);
    await users.close();
    await edits.close();
    await (repo as unknown as { close?: () => Promise<void> }).close?.();
  }
});

/** 偽の WordPress のカテゴリー・タグ・記事。 */
function fakeTerms(t: TestContext) {
  const terms = new Map<string, { taxonomy: 'category' | 'tag'; name: string; parent: number; count: number }>([
    ['1', { taxonomy: 'category', name: '未分類', parent: 0, count: 2 }],
    ['5', { taxonomy: 'category', name: '旅', parent: 0, count: 1 }],
    ['9', { taxonomy: 'tag', name: '温泉', parent: 0, count: 1 }],
  ]);
  const posts = new Map<string, { title: string; categories: number[]; tags: number[]; modified: string }>([
    ['21', { title: '箱根の温泉に行った', categories: [1], tags: [9], modified: '2026-11-01T00:00:00' }],
    ['22', { title: '秋の紅葉', categories: [1], tags: [], modified: '2026-11-02T00:00:00' }],
  ]);
  let next = 100;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${u.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (u.pathname === '/wp-json/wp/v2/users/me') return Response.json({ name: '会社', roles: ['editor'], capabilities: { ...FULL, manage_categories: true } });
    const tx = /^\/wp-json\/wp\/v2\/(categories|tags)(?:\/(\d+))?$/.exec(u.pathname);
    if (tx) {
      const taxonomy = tx[1] === 'categories' ? 'category' : 'tag';
      if (!tx[2] && method === 'GET') return Response.json([...terms].filter(([, v]) => v.taxonomy === taxonomy).map(([id, v]) => ({ id: Number(id), name: v.name, parent: v.parent, count: v.count })));
      if (!tx[2] && method === 'POST') {
        if ([...terms.values()].some((v) => v.taxonomy === taxonomy && v.name === body['name'])) return Response.json({ code: 'term_exists' }, { status: 400 });
        const id = String(next++);
        terms.set(id, { taxonomy, name: String(body['name']), parent: Number(body['parent'] ?? 0), count: 0 });
        return Response.json({ id: Number(id) }, { status: 201 });
      }
      const v = terms.get(tx[2]!);
      if (!v) return new Response('', { status: 404 });
      if (method === 'GET') return Response.json({ id: Number(tx[2]), name: v.name, parent: v.parent, count: v.count });
      if (method === 'POST') { v.name = String(body['name']); return Response.json({ id: Number(tx[2]) }); }
      if (method === 'DELETE') { terms.delete(tx[2]!); return Response.json({ deleted: true }); }
    }
    if (u.pathname === '/wp-json/wp/v2/posts') {
      const q = u.searchParams.get('search') ?? '';
      return Response.json([...posts].filter(([, p]) => !q || p.title.includes(q)).map(([id, p]) => ({ id: Number(id), title: { raw: p.title }, link: `${SITE}/?p=${id}`, date: '2026-11-01T00:00:00', categories: p.categories, tags: p.tags, modified_gmt: p.modified })));
    }
    const pm = /^\/wp-json\/wp\/v2\/posts\/(\d+)$/.exec(u.pathname);
    if (pm) {
      const p = posts.get(pm[1]!);
      if (!p) return new Response('', { status: 404 });
      if (method === 'POST') {
        const recount = () => { for (const [id, v] of terms) v.count = [...posts.values()].filter((x) => (v.taxonomy === 'category' ? x.categories : x.tags).includes(Number(id))).length; };
        p.categories = (body['categories'] as number[]).length ? body['categories'] as number[] : [1];
        p.tags = body['tags'] as number[];
        p.modified = `2026-11-12T00:00:${String(next++).slice(-2)}`;
        recount();
        return Response.json({ modified_gmt: p.modified });
      }
      return Response.json({ id: Number(pm[1]), title: { raw: p.title }, link: `${SITE}/?p=${pm[1]}`, date: '2026-11-01T00:00:00', categories: p.categories, tags: p.tags, modified_gmt: p.modified });
    }
    return new Response('', { status: 404 });
  });
  return { terms, posts, calls };
}

test('「カテゴリー」の見分け: 手がかりでサイト・メール・ナレッジ・知識を分け、無ければ分からないとする。聞き返しへの答えを読む', () => {
  assert.equal(categoryTarget('ブログに「旅行」というカテゴリーを作って'), 'site');
  assert.equal(categoryTarget('この記事のタグを外して'), 'site');
  assert.equal(categoryTarget('このメールは採用のカテゴリーに入れて'), 'mail');
  assert.equal(categoryTarget('この資料のタグを直して'), 'library');
  assert.equal(categoryTarget('規程のカテゴリーは？'), 'knowledge');
  assert.equal(categoryTarget('採用というカテゴリーを作って'), 'unknown');
  assert.equal(categoryTarget('今日の予定は？'), 'none');
  assert.equal(categoryAnswer('サイトの'), 'site');
  assert.equal(categoryAnswer('メールのほう'), 'mail');
  assert.equal(categoryAnswer('どちらでも'), null);
});

test('サイトのカテゴリーとタグの案: もうある名前は作らず、似た名前を添え、無い名前は付けず、作る名前は付けられる', () => {
  const terms = [
    { taxonomy: 'category' as const, id: '1', name: '未分類', parent: null, count: 2 },
    { taxonomy: 'category' as const, id: '5', name: '旅', parent: null, count: 1 },
  ];
  const posts = [{ id: '21', title: '箱根', link: '', date: '', categories: ['1'], tags: [], modifiedGmt: 'm' }];
  const plan = readTermPlan({
    create: [{ taxonomy: 'category', name: '旅行' }, { taxonomy: 'category', name: '旅' }],
    rename: [{ taxonomy: 'category', id: 5, name: '未分類' }],
    assign: [{ post: 21, add: [{ taxonomy: 'category', name: '旅行' }, { taxonomy: 'tag', name: 'ない' }], remove: [{ taxonomy: 'category', name: '未分類' }] }],
  });
  const r = buildTermChanges(plan, terms, posts);
  assert.deepEqual(r.changes.map((c) => c.op), ['create', 'assign']);
  assert.ok(r.notes.some((n) => n.includes('「旅」はもうある')));
  assert.ok(r.notes.some((n) => n.includes('似た') && n.includes('「旅」')));
  assert.ok(r.notes.some((n) => n.includes('「未分類」はもうある')), '名前の重なる変更はしない');
  assert.ok(r.notes.some((n) => n.includes('「ない」が無い')));
  const a = r.changes[1]!;
  assert.ok(a.op === 'assign' && a.add[0]!.id === null && a.remove[0]!.id === '1');
});

test('サイトのカテゴリーとタグ: 作って記事に付けるまでを承認へ進め、入れ、元に戻すと付け直して作ったものを消す', async (t) => {
  const wp = fakeTerms(t);
  const llm = {
    name: 'fake',
    async complete(req: LlmRequest) {
      const text = String(req.messages[0]!.content);
      if (text.includes('記事を探すための')) return { text: JSON.stringify({ words: ['温泉'] }), tokensUsed: 1 };
      return { text: JSON.stringify({ create: [{ taxonomy: 'category', name: '旅行', parent: null }], assign: [{ post: 21, add: [{ taxonomy: 'category', name: '旅行' }], remove: [{ taxonomy: 'category', name: '未分類' }] }] }), tokensUsed: 1 };
    },
  } as LlmProvider;
  const { service } = setup(llm);
  const r = await service.proposeTerms(who, '温泉の記事を新しい「旅行」カテゴリーに入れて');
  assert.ok('edit' in r, JSON.stringify(r));
  assert.ok(r.notes.some((n) => n.includes('似た')), '「旅」に似ていることを添える');
  const p = (await service.preview(who, r.edit.id))!;
  assert.ok(p.headline.startsWith('サイトのカテゴリーとタグを直します'));
  assert.ok(p.shown.includes('サイトのカテゴリー「旅行」を作る') && p.shown.includes('記事「箱根の温泉に行った」に、サイトのカテゴリー「旅行」を付ける・サイトのカテゴリー「未分類」を外す'));
  assert.ok(!wp.calls.some((c) => c.startsWith('POST')), '承認の前には何も入れない');
  const a = await service.apply(who, r.edit.id, p.digest);
  assert.ok('edit' in a);
  assert.equal(a.edit.status, 'applied');
  const made = [...wp.terms].find(([, v]) => v.name === '旅行')!;
  assert.deepEqual(wp.posts.get('21')!.categories, [Number(made[0])]);

  const back = await service.revert(who, r.edit.id);
  assert.ok('edit' in back, JSON.stringify(back));
  const pv = (await service.preview(who, back.edit.id))!;
  assert.ok(pv.shown.includes('「旅行」を消す'));
  await service.apply(who, back.edit.id, pv.digest);
  assert.deepEqual(wp.posts.get('21')!.categories, [1], '前のカテゴリーに戻す');
  assert.equal([...wp.terms.values()].some((v) => v.name === '旅行'), false, '記事の付いていない作ったものは消す');
  assert.equal((await service.get(who, r.edit.id))!.status, 'reverted');
});

test('サイトのカテゴリーとタグ: 名前を変えてもスラッグは送らない。分からなければ聞き返す。記事が付いていれば消さない', async (t) => {
  const wp = fakeTerms(t);
  const answers: unknown[] = [
    { rename: [{ taxonomy: 'category', id: 5, name: '旅行' }] },
    { question: 'どの記事のことですか？' },
  ];
  const llm = {
    name: 'fake',
    async complete(req: LlmRequest) {
      const text = String(req.messages[0]!.content);
      if (text.includes('記事を探すための')) return { text: '{"words":[]}', tokensUsed: 1 };
      return { text: JSON.stringify(answers.shift()), tokensUsed: 1 };
    },
  } as LlmProvider;
  const { service } = setup(llm);
  const r = await service.proposeTerms(who, '「旅」を「旅行」にして');
  assert.ok('edit' in r);
  const sent: Record<string, unknown>[] = [];
  const orig = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && /categories\/5$/.test(new URL(String(input)).pathname)) sent.push(JSON.parse(String(init!.body)));
    return orig(input, init);
  });
  await service.apply(who, r.edit.id, (await service.preview(who, r.edit.id))!.digest);
  assert.deepEqual(sent, [{ name: '旅行' }], '名前だけを送る（スラッグは変えない）');
  assert.equal(wp.terms.get('5')!.name, '旅行');

  const ask = await service.proposeTerms(who, 'あの記事を旅行に入れて');
  assert.deepEqual(ask, { ask: 'どの記事のことですか？' });
});

/** 偽の WordPress の記事・固定ページ・前の版・メディア（段 2a）。 */
function fakeSite(t: TestContext) {
  type Item = { kind: 'post' | 'page'; title: string; content: string; excerpt: string; status: string; date: string; modified: string; featured: number; revisions: { id: number; date: string; title: string; content: string }[] };
  const items = new Map<string, Item>([
    ['31', { kind: 'post', title: '秋の営業', content: '<p>秋も営業します</p>', excerpt: '', status: 'publish', date: '2026-11-01T09:00:00', modified: 'm31', featured: 0, revisions: [] }],
    ['41', { kind: 'page', title: '会社案内', content: '<p>新しい会社案内</p>', excerpt: '', status: 'publish', date: '2026-01-01T00:00:00', modified: 'm41', featured: 0,
      revisions: [{ id: 412, date: '2026-11-10T00:00:00', title: '会社案内', content: '<p>新しい会社案内</p>' }, { id: 411, date: '2026-11-01T00:00:00', title: '会社案内', content: '<p>前の会社案内</p>' }] }],
  ]);
  const media: string[] = [];
  let next = 500;
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (u.pathname === '/wp-json/wp/v2/users/me') return Response.json({ name: '会社', roles: ['editor'], capabilities: FULL });
    if (u.pathname === '/wp-json/wp/v2/media' && method === 'POST') { media.push(String((init?.headers as Record<string, string>)['content-type'])); return Response.json({ id: next++ }, { status: 201 }); }
    if (/^\/wp-json\/wp\/v2\/media\/\d+$/.test(u.pathname)) return Response.json({});
    const list = /^\/wp-json\/wp\/v2\/(posts|pages)$/.exec(u.pathname);
    if (list) {
      const kind = list[1] === 'posts' ? 'post' : 'page';
      if (method === 'POST') {
        const id = String(next++);
        items.set(id, { kind, title: String(body['title']), content: String(body['content']), excerpt: String(body['excerpt'] ?? ''), status: String(body['status']), date: String(body['date'] ?? ''), modified: `m${id}`, featured: Number(body['featured_media'] ?? 0), revisions: [] });
        return Response.json({ id: Number(id), link: `${SITE}/?p=${id}` }, { status: 201 });
      }
      return Response.json([...items].filter(([, v]) => v.kind === kind && v.status !== 'trash').map(([id, v]) => ({ id: Number(id), title: { raw: v.title }, status: v.status, date: v.date, link: `${SITE}/?p=${id}` })));
    }
    const rev = /^\/wp-json\/wp\/v2\/(posts|pages)\/(\d+)\/revisions$/.exec(u.pathname);
    if (rev) return Response.json((items.get(rev[2]!)?.revisions ?? []).map((r) => ({ id: r.id, date: r.date, title: { raw: r.title }, content: { raw: r.content }, excerpt: { raw: '' } })));
    const one = /^\/wp-json\/wp\/v2\/(posts|pages)\/(\d+)$/.exec(u.pathname);
    if (one) {
      const v = items.get(one[2]!);
      if (!v) return new Response('', { status: 404 });
      if (method === 'DELETE') { v.status = 'trash'; v.modified = `m${next++}`; return Response.json({ id: Number(one[2]) }); }
      if (method === 'POST') {
        if (typeof body['status'] === 'string') v.status = body['status'];
        if (typeof body['date'] === 'string') v.date = body['date'];
        if (typeof body['content'] === 'string') v.content = body['content'];
        if (typeof body['title'] === 'string') v.title = body['title'];
        if (typeof body['featured_media'] === 'number') v.featured = body['featured_media'];
        v.modified = `m${next++}`;
        return Response.json({ modified_gmt: v.modified, link: `${SITE}/?p=${one[2]}` });
      }
      return Response.json({ id: Number(one[2]), title: { raw: v.title }, link: `${SITE}/?p=${one[2]}`, status: v.status, date: v.date, modified_gmt: v.modified, featured_media: v.featured, content: { raw: v.content }, excerpt: { raw: v.excerpt } });
    }
    return new Response('', { status: 404 });
  });
  return { items, media };
}

const llmAnswer = (answer: unknown): LlmProvider => ({ name: 'fake', async complete() { return { text: JSON.stringify(answer), tokensUsed: 1 }; } } as LlmProvider);

test('段 2a: 頼みに公開が無ければ下書きで作る。アイキャッチを作ってメディアに入れて付け、元に戻すとゴミ箱に入れる', async (t) => {
  const site = fakeSite(t);
  assert.equal(asksToPublish('お知らせの記事を作って'), false);
  assert.equal(asksToPublish('お知らせの記事を作って公開して'), true);
  const { service } = setup(llmAnswer({ create: [{ kind: 'post', title: '年末年始の営業', body: '## 営業日\n\n12/28 まで営業します。', excerpt: '年末年始の営業', publish: 'publish', eyecatch: true }] }));
  const r = await service.proposeActions(who, '年末年始の営業のお知らせの記事を作って、アイキャッチも付けて');
  assert.ok('edit' in r, JSON.stringify(r));
  assert.ok(r.notes.some((n) => n.includes('下書きで作ります')), '公開と言われていないので下書き');
  const p = (await service.preview(who, r.edit.id))!;
  assert.ok(p.shown.includes('記事「年末年始の営業」を作る（下書き）。アイキャッチを作って付ける'));
  assert.ok(p.shown.includes('12/28 まで営業します'), '本文の初めを承認の画面に出す');
  assert.equal(site.media.length, 0, '承認の前には何も入れない');
  const a = await service.apply(who, r.edit.id, p.digest);
  assert.ok('edit' in a && a.edit.status === 'applied');
  const made = [...site.items].find(([, v]) => v.title === '年末年始の営業')!;
  assert.equal(made[1].status, 'draft');
  assert.ok(made[1].featured > 0 && site.media[0] === 'image/png', 'アイキャッチの PNG を入れて付ける');
  assert.ok(made[1].content.includes('12/28 まで営業します'));

  const back = await service.revert(who, r.edit.id);
  assert.ok('edit' in back, JSON.stringify(back));
  const pv = (await service.preview(who, back.edit.id))!;
  assert.ok(pv.shown.includes('ゴミ箱にする'));
  await service.apply(who, back.edit.id, pv.digest);
  assert.equal(made[1].status, 'trash', '作ったものはゴミ箱に入れる（完全には消さない）');
});

test('段 2a: 公開の状態を変えて元に戻す。前の版に戻して元に戻す。直し案の後に変えられていれば上書きしない', async (t) => {
  const site = fakeSite(t);
  const { service } = setup(llmAnswer({ status: [{ kind: 'post', id: 31, to: 'draft' }], revision: [{ kind: 'page', id: 41 }] }));
  const r = await service.proposeActions(who, '秋の営業の記事を下書きに戻して、会社案内は前の版に戻して');
  assert.ok('edit' in r, JSON.stringify(r));
  const p = (await service.preview(who, r.edit.id))!;
  assert.ok(p.shown.includes('「秋の営業」を公開から下書きにする'));
  assert.ok(p.shown.includes('「会社案内」を前の版（2026-11-01 00:00）に戻す') && p.shown.includes('前の会社案内'));
  await service.apply(who, r.edit.id, p.digest);
  assert.equal(site.items.get('31')!.status, 'draft');
  assert.equal(site.items.get('41')!.content, '<p>前の会社案内</p>', 'いまと同じ版を飛ばして、1 つ前の版に戻す');

  const back = await service.revert(who, r.edit.id);
  assert.ok('edit' in back);
  await service.apply(who, back.edit.id, (await service.preview(who, back.edit.id))!.digest);
  assert.equal(site.items.get('31')!.status, 'publish');
  assert.equal(site.items.get('41')!.content, '<p>新しい会社案内</p>');

  // ぶつかり
  const again = await service.proposeActions(who, '秋の営業の記事を下書きに戻して');
  assert.ok('edit' in again);
  const p2 = (await service.preview(who, again.edit.id))!;
  site.items.get('31')!.status = 'private';
  const c = await service.apply(who, again.edit.id, p2.digest);
  assert.ok('edit' in c && c.edit.actions[0]!.result === 'conflict');
});

test('段 2a: 分からなければ聞き返す。予約の日時が過ぎていれば予約しない。前の版が無ければそう言う', async (t) => {
  fakeSite(t);
  const ask = await setup(llmAnswer({ question: 'どの記事のことですか？' })).service.proposeActions(who, 'あれを公開して');
  assert.deepEqual(ask, { ask: 'どの記事のことですか？' });
  const past = await setup(llmAnswer({ status: [{ kind: 'post', id: 31, to: 'future', date: '2020-01-01T00:00:00' }] })).service.proposeActions(who, '秋の営業を予約にして');
  assert.ok('error' in past && past.error.includes('予約の日時'));
  const none = await setup(llmAnswer({ revision: [{ kind: 'post', id: 31 }] })).service.proposeActions(who, '秋の営業を前の版に戻して');
  assert.ok('error' in none && none.error.includes('戻せる前の版がありません'));
});

/** 項目の並びを、奥まで逆にする（PostgreSQL の jsonb が並びを入れ替えるのをまねる）。 */
function reorder<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reorder) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorder(x)])) as T;
  return v;
}

test('指紋: 保存で項目の並びが入れ替わっても同じ指紋になり、承認の後に入れられる（2026-11-13 に、並びが変わって入れられなかった）', async (t) => {
  const site = fakeSite(t);
  assert.equal(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  const { service, store } = setup(llmAnswer({ create: [{ kind: 'post', title: '冬の営業', body: '営業します', publish: 'draft', eyecatch: true }] }));
  const r = await service.proposeActions(who, '冬の営業の記事を作って、アイキャッチも付けて');
  assert.ok('edit' in r);
  // 置き場が並びを入れ替えたことにする
  const saved = (await store.get('t1', r.edit.id))!;
  await store.update('t1', r.edit.id, { actions: reorder(saved.actions), pages: reorder(saved.pages), terms: reorder(saved.terms) });
  const a = await service.apply(who, r.edit.id, (await service.preview(who, r.edit.id))!.digest);
  assert.ok('edit' in a && a.edit.status === 'applied', JSON.stringify(a));
  assert.ok([...site.items.values()].some((v) => v.title === '冬の営業'));
});

test('入れるツール: 入れられなければ例外を投げて実行を失敗にする（「済んだ」と伝えない）', async (t) => {
  fakeSite(t);
  const { service, settings } = setup(llmAnswer({ create: [{ kind: 'post', title: '冬の営業', body: '営業します', publish: 'draft' }] }));
  const r = await service.proposeActions(who, '冬の営業の記事を作って');
  assert.ok('edit' in r);
  const ctx = { tenantId: 't1', userId: 'u1', siteUpdates: { service, access: async () => settings().siteUpdates } } as unknown as ToolContext;
  const apply = SITE_UPDATE_TOOLS.find((x) => x.name === 'site_updates.apply')!;
  await assert.rejects(apply.invoke({ editId: r.edit.id, digest: 'wrong' }, ctx), /入れませんでした/);
});
