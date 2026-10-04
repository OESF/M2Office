/**
 * @file 競合の分析の段 1 の単体テスト（仕様書 第36.18節）。robots.txt・社内のアドレスを断る・HTML の読み方・
 * 探す（地図で近くの同業。自社と遠い店を外す）・読む（robots.txt に従う）・事実とレポート・入れる・外す（入れ直さない）・ツール。
 * 見本の地図とサイトで確かめ、外には何も読みに行かない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, REPORT_MAP_SOURCE_LINE, gatherMapSource, type TenantSettings } from '@m2office/shared';
import {
  CompetitorService, CompetitorWatch, MemoryCompetitorStore, MockPageFetcher, MOCK_SITES, StubLlmProvider, COMPETITOR_TOOLS,
  checkUrl, crawlerUserAgent, isBlockedAddress, parseRobots, readHtml, robotsAllows,
  type Repository, type ToolContext,
  suggestAnnouncements, competitorLinksFrom,
} from '../src/index.js';

function setup(over: Partial<TenantSettings['company']> = {}) {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', address: '東京都千代田区丸の内一丁目', ...over },
    competitors: { enabled: true, areaOverride: null, mapKey: null, autoMax: 10, watch: 'monthly' },
  };
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const notes: { title: string; body: string; userId?: string }[] = [];
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '受付', roles: ['member'], status: 'active' },
  ];
  const repo = {
    listUsers: async () => users,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    findTenantById: async () => ({ id: 't1', name: '株式会社アルファ商事' }),
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: { competitor: true } } }),
    createNotification: async (n: { title: string; body: string; userId: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryCompetitorStore();
  const pages = { ...MOCK_SITES };
  const fetcher = new MockPageFetcher(pages);
  const service = new CompetitorService({
    store, repo, llmFor: async () => new StubLlmProvider(), placesKeyFor: async () => null, sourceFor: () => 'mock',
    userAgent: 'test', fetcherFor: () => fetcher,
  });
  const watch = new CompetitorWatch({ service, store, repo });
  return { service, store, watch, fetcher, pages, audits, notes, settings: () => settings, setCompany: (c: Partial<TenantSettings['company']>) => { settings = { ...settings, company: { ...settings.company, ...c } }; } };
}

const who = { tenantId: 't1', userId: 'u1' };

test('robots.txt: いちばん長く当てはまる規則が勝ち、同じ長さなら Allow。自分の名前のまとまりを先に使う', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/open\n\nUser-agent: OtherBot\nDisallow: /');
  assert.equal(robotsAllows(rules, '/'), true);
  assert.equal(robotsAllows(rules, '/private/price'), false);
  assert.equal(robotsAllows(rules, '/private/open/a'), true);
  const mine = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: M2Office\nDisallow: /news$\nDisallow: /*.php');
  assert.equal(robotsAllows(mine, '/news'), false);
  assert.equal(robotsAllows(mine, '/news/1'), true);
  assert.equal(robotsAllows(mine, '/a/b.php?x=1'), false);
  assert.equal(robotsAllows({ disallowAll: true, rules: [] }, '/'), false);
});

test('読む口: 社内・自分自身・クラウドの管理用のアドレスと、http(s) 以外を断る', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(typeof checkUrl('http://localhost/'), 'string');
  assert.equal(typeof checkUrl('http://169.254.169.254/latest'), 'string');
  assert.equal(typeof checkUrl('file:///etc/passwd'), 'string');
  assert.equal(typeof checkUrl('https://user:pw@example.jp/'), 'string');
  assert.equal(typeof checkUrl('https://example.jp:8080/'), 'string');
  assert.equal(typeof checkUrl('http://intranet/'), 'string');
  assert.ok(checkUrl('https://www.example.jp/menu') instanceof URL);
  assert.match(crawlerUserAgent('0.13.0', 'https://example.jp/about'), /M2Office\/0\.13\.0; \+https:\/\/example\.jp\/about/);
  assert.doesNotMatch(crawlerUserAgent('0.13.0', 'javascript:alert(1)'), /javascript/);
});

test('HTML: 題名・見出し・本文を取り出し、同じサイトのリンクだけを集める（台本と画像は読まない）', () => {
  const p = readHtml('<html><head><title>店 &amp; 料金</title><script>alert(1)</script></head><body><h1>見出し</h1><p>本文</p>'
    + '<a href="/menu">料金</a><a href="https://other.example.jp/">外</a><a href="/a.pdf">資料</a><a href="#top">上へ</a></body></html>', 'https://shop.example.jp/');
  assert.equal(p.title, '店 & 料金');
  assert.deepEqual(p.headings, ['見出し']);
  assert.ok(!p.text.includes('alert'));
  assert.deepEqual(p.links.map((l) => l.url), ['https://shop.example.jp/menu']);
  assert.match(p.hash, /^[0-9a-f]{32}$/);
});

test('探す: 地図で半径の中の同業を近い順に覚え、自社と遠い店は外す。地図の名前と URL は残さず引き直す。読んでレポートを作る', async () => {
  const { service, store, watch, fetcher, audits, notes } = setup();
  const { jobId } = await service.requestDiscover(who);
  assert.ok(jobId);
  assert.equal((await service.requestDiscover(who)).already, true, '同じ作業を 2 度受け付けない');
  assert.equal(await watch.tick({ wait: true }), 1);
  const o = await service.overview(who);
  assert.equal(o.profile?.area.local, true);
  assert.equal(o.profile?.website, 'https://www.alpha.example.jp/', '会社情報に無ければ地図の自社のサイトを読む');
  assert.equal('geo' in (o.profile ?? {}), false, '自社の位置は画面に出さない');
  assert.deepEqual(o.competitors.map((c) => c.name), ['見本の競合 A', '見本の競合 B']);
  assert.ok(o.competitors.every((c) => c.origin === 'map' && c.distanceM !== null && c.distanceM < 2000));
  // 評価と件数は地図から表示のたびに引き直し、残さない（第 0.238.0 版）
  assert.deepEqual(o.competitors.map((c) => [c.rating, c.ratingCount]), [[4.3, 52], [3.9, 40]]);
  assert.deepEqual(o.selfRating, { rating: 4.2, count: 39 });
  assert.equal('selfPlaceId' in (o.profile ?? {}), false, '自社の place ID は画面に出さない');
  const stored = await store.list('t1');
  assert.ok(stored.every((c) => c.name === '' && c.url === '' && c.placeId), '地図の名前と URL は残さない');
  assert.ok(!JSON.stringify(stored).includes('4.3') && !JSON.stringify(await store.profile('t1')).includes('4.2'), '評価は残さない');
  // robots.txt で断られたページは読まない
  assert.ok(fetcher.requested.includes('https://shop-b.example.jp/service'));
  assert.ok(!fetcher.requested.includes('https://shop-b.example.jp/private/price'));
  assert.ok(!fetcher.requested.some((u) => u.endsWith('/login')), 'ログインのページは選ばない');
  const a = o.competitors[0]!;
  assert.ok(a.factCount > 0);
  const facts = await service.facts(who, a.id);
  assert.ok(facts.every((f) => f.sourceUrl.startsWith('https://shop-a.example.jp/')), '事実に出典の URL');
  assert.ok(facts.every((f) => f.text.length <= 160), '相手の文章を写さず短い事実にする');
  const [report] = await service.reports(who);
  assert.match(report!.text, /## 自社との違い/);
  assert.match(report!.text, /見本の競合 A/, 'レポートには名前を書いて残してよい（第 0.235.2 版）');
  assert.ok(audits.some((x) => x.action === 'competitor.discover'));
  assert.equal(notes.filter((n) => /探し終えました/.test(n.title)).length, 1);
});

test('外す・入れる: 外したものは探し直しても入れない。URL で入れるとトップを読んで確かめ、10 社を超えない', async () => {
  const { service, watch } = setup();
  await service.requestDiscover(who);
  await watch.tick({ wait: true });
  const [a] = (await service.overview(who)).competitors;
  assert.equal(await service.remove(who, a!.id), true);
  await service.requestDiscover(who);
  await watch.tick({ wait: true });
  assert.deepEqual((await service.overview(who)).competitors.map((c) => c.name), ['見本の競合 B'], '外した競合を入れ直さない');
  assert.match((await service.add(who, 'https://unknown.example.jp/') as { error: string }).error, /読めません/);
  assert.match((await service.add(who, 'http://127.0.0.1/') as { error: string }).error, /社内のアドレス/);
  // 人が入れ直すと戻る
  const back = await service.add(who, '見本の競合 A');
  assert.ok('id' in back);
  await watch.tick({ wait: true });
  const names = (await service.overview(who)).competitors.map((c) => c.name).sort();
  assert.deepEqual(names, ['見本の競合 A', '見本の競合 B']);
});

test('商圏の上書き: 「全国で」と言われたら地図を使わず、推論が使えなければ作り出さずに理由を返す', async () => {
  const { service, watch, settings, store } = setup();
  await service.requestDiscover(who, { local: false, radiusM: null });
  assert.deepEqual(settings().competitors.areaOverride, { local: false, radiusM: null });
  await watch.tick({ wait: true });
  const o = await service.overview(who);
  assert.equal(o.profile?.area.local, false);
  assert.equal(o.competitors.length, 0);
  assert.match((await store.lastJob('t1'))!.message, /URL を入れてください/);
});

test('ツール: 切っている会社では使えない。一覧・違い・レポート・外すを秘書に返す', async () => {
  const { service, watch } = setup();
  await service.requestDiscover(who);
  await watch.tick({ wait: true });
  const ctx = (on: boolean) => ({ tenantId: 't1', userId: 'u1', competitors: { service, access: async () => (on ? { enabled: true, areaOverride: null, mapKey: null, autoMax: 10, watch: 'monthly' } : null) } } as unknown as ToolContext);
  const tool = (name: string) => COMPETITOR_TOOLS.find((t) => t.name === name)!;
  assert.deepEqual(await tool('competitors.list').invoke({}, ctx(false)), { available: false, reason: '競合の分析は使えません（会社で切っているか、利用範囲の外です）' });
  const list = await tool('competitors.list').invoke({}, ctx(true)) as { competitors: { name: string; source: string | null }[] };
  assert.equal(list.competitors[0]?.source, 'Google Maps');
  const facts = await tool('competitors.facts').invoke({ q: '競合 A' }, ctx(true)) as { competitors: { facts: unknown[] }[]; self: unknown[] };
  assert.equal(facts.competitors.length, 1);
  assert.ok(facts.self.length > 0);
  const report = await tool('competitors.report').invoke({}, ctx(true)) as { report: string };
  assert.match(report.report, /前の回からの動き/);
  const removed = await tool('competitors.remove').invoke({ q: '競合 B' }, ctx(true)) as { removed: string };
  assert.equal(removed.removed, '見本の競合 B');
  assert.equal(tool('competitors.discover').risk, 'write-internal');
});

test('地図の鍵の断り: Gemini 専用の鍵・Places API が切り・鍵の制限を、直せる言葉にする', async () => {
  const { placesRefusal } = await import('../src/index.js');
  assert.match(placesRefusal('{"error":{"message":"API keys are not supported by this API."}}', 'AIzaX'), /Gemini 専用/);
  assert.match(placesRefusal('', 'AQ.Ab'), /AIza で始まる/);
  assert.match(placesRefusal('{"error":{"details":[{"reason":"SERVICE_DISABLED"}]}}', 'AIzaX'), /有効になっていません/);
  assert.match(placesRefusal('{"error":{"details":[{"reason":"API_KEY_SERVICE_BLOCKED"}]}}', 'AIzaX'), /API の制限/);
});

test('地図の鍵: 預けた鍵を先に使い、無ければ昔の形（AIza）の Gemini の鍵だけを使う。Gemini 専用の鍵では理由を出す', async () => {
  const creds = new Map<string, { secretEnc: string }>();
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, competitors: { enabled: true, areaOverride: null, mapKey: null, autoMax: 10, watch: 'monthly' } };
  const audits: string[] = [];
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    getTenantCredential: async (_t: string, kind: string) => creds.get(kind) ?? null,
    saveTenantCredential: async (c: { kind: string; secretEnc: string }) => { creds.set(c.kind, c); },
    deleteTenantCredential: async (_t: string, kind: string) => creds.delete(kind),
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
    listTenantIds: async () => ['t1'],
  } as unknown as Repository;
  let gemini = 'AQ.gemini-only';
  const service = new CompetitorService({
    store: new MemoryCompetitorStore(), repo, llmFor: async () => new StubLlmProvider(), placesKeyFor: async () => gemini, sourceFor: () => 'real',
    userAgent: 'test', box: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.slice(4) } as never,
  });
  const key = (svc: CompetitorService) => (svc as unknown as { mapKey(t: string): Promise<string | null> }).mapKey('t1');
  assert.equal(await key(service), null, 'Gemini 専用の鍵は地図に使わない');
  assert.match((await service.overview(who)).mapNote, /地図の鍵がありません/);
  gemini = 'AIzaOldStyleKey';
  assert.equal(await key(service), 'AIzaOldStyleKey');
  assert.match(await service.setMapKey(who, 'AQ.xyz', false) ?? '', /Gemini 専用/);
  assert.equal(await service.setMapKey(who, 'AIzaMapKey', true), null);
  assert.equal(await key(service), 'AIzaMapKey', '預けた鍵を先に使う');
  assert.equal(settings.competitors.mapKey?.setBy, 'u1');
  assert.ok(!JSON.stringify(settings).includes('AIzaMapKey'), '鍵そのものは設定に置かない');
  await service.removeMapKey(who);
  assert.equal(settings.competitors.mapKey, null);
  assert.equal(await key(service), 'AIzaOldStyleKey');
  assert.deepEqual(audits, ['competitor.map_key_set', 'competitor.map_key_remove']);
});

test('自社の見分け: 地図の名前がかな書きでも、Web サイトが同じなら自社として外す。業種の言葉の検索と種類の検索を合わせる', async () => {
  const { setup: _s } = { setup };
  const ctx = setup({ website: 'https://www.alpha.example.jp/' });
  const center = { lat: 35.68, lng: 139.76 };
  const hit = (id: string, name: string, website: string, dLat: number, primaryType = 'doctor') => ({ id, name, website, lat: center.lat + dLat, lng: center.lng, primaryType, attributions: [] });
  const self = hit('place-self-000000', 'あるふぁしょうじ', 'https://alpha.example.jp/', 0);
  const calls: string[] = [];
  const places = {
    search: async (q: string) => { calls.push(`search:${q}`); return q.includes('アルファ') ? [self] : [self, hit('place-kw-0000001', 'ショップ A', 'https://shop-a.example.jp/', 0.003)]; },
    nearby: async () => { calls.push('nearby'); return [self, hit('place-ty-0000002', 'ショップ B', 'https://shop-b.example.jp/', 0.004)]; },
    details: async (id: string) => [self, hit('place-kw-0000001', 'ショップ A', 'https://shop-a.example.jp/', 0.003), hit('place-ty-0000002', 'ショップ B', 'https://shop-b.example.jp/', 0.004)].find((h) => h.id === id) ?? null,
  };
  const service = new CompetitorService({
    store: ctx.store, repo: (ctx.service as unknown as { deps: { repo: Repository } }).deps.repo, llmFor: async () => new StubLlmProvider(), placesKeyFor: async () => null, sourceFor: () => 'real',
    userAgent: 'test', fetcherFor: () => ctx.fetcher, placesFor: async () => places,
  });
  await service.requestDiscover(who);
  await new CompetitorWatch({ service, store: ctx.store, repo: (ctx.service as unknown as { deps: { repo: Repository } }).deps.repo }).tick({ wait: true });
  const names = (await service.overview(who)).competitors.map((c) => c.name).sort();
  assert.deepEqual(names, ['ショップ A', 'ショップ B'], '自社（かな書き）を外し、言葉と種類の両方の検索から拾う');
  assert.ok(calls.includes('nearby') && calls.some((c) => c.startsWith('search:') && !c.includes('アルファ')));
});

test('上限: 自動で覚える数は既定 10 社で、管理者が 1〜20 社に変えられる。全体はその数 + 5 社', async () => {
  const shared = await import('@m2office/shared');
  assert.equal(shared.COMPETITORS_AUTO_MAX, 10);
  assert.equal(shared.COMPETITORS_MAX, 15);
  assert.equal(shared.competitorAutoMax({ autoMax: 99 }), 10, '範囲の外は既定');
  assert.equal(shared.competitorAutoMax(undefined), 10, '古い設定は既定');
  const { service, watch, settings, audits } = setup();
  assert.match(await service.setAutoMax(who, 0) ?? '', /1〜20 社/);
  assert.match(await service.setAutoMax(who, 21) ?? '', /1〜20 社/);
  assert.equal(await service.setAutoMax(who, 1), null);
  assert.equal(settings().competitors.autoMax, 1);
  await service.requestDiscover(who);
  await watch.tick({ wait: true });
  assert.deepEqual((await service.overview(who)).competitors.map((c) => c.name), ['見本の競合 A'], '1 社にすると、いちばん近い 1 社だけ覚える');
  assert.ok(audits.some((a) => a.action === 'competitor.settings'));
});

test('見回りの回: 毎月は 1 日、毎週は月曜の、日本時間 3 時に始まる', async () => {
  const { watchPeriodStart, nextWatchStart } = await import('../src/index.js');
  // 2026-10-04（日）12:00 JST
  const now = new Date('2026-10-04T03:00:00Z');
  assert.equal(watchPeriodStart('monthly', now).toISOString(), '2026-09-30T18:00:00.000Z', '10 月 1 日 3 時（日本）');
  assert.equal(nextWatchStart('monthly', now).toISOString(), '2026-10-31T18:00:00.000Z', '11 月 1 日 3 時（日本）');
  assert.equal(watchPeriodStart('weekly', now).toISOString(), '2026-09-27T18:00:00.000Z', '9 月 28 日（月）3 時（日本）');
  assert.equal(nextWatchStart('weekly', now).toISOString(), '2026-10-04T18:00:00.000Z');
  // 1 日の 2 時（日本）はまだ前の回
  assert.equal(watchPeriodStart('monthly', new Date('2026-09-30T17:00:00Z')).toISOString(), '2026-08-31T18:00:00.000Z');
});

test('定期の見回り: 探した回は行わず、次の回に見回る。90 日を過ぎたら探し直し、会社情報の住所が変わったらすぐ探し直す。しないなら行わない', async () => {
  const { service, watch, store, settings, setCompany } = setup();
  assert.equal(await service.scheduleIfDue('t1'), null, '一度も探していなければ行わない');
  await service.requestDiscover(who);
  await watch.tick({ wait: true });
  const day = 86_400_000;
  assert.equal(await service.scheduleIfDue('t1', new Date()), null, '探した回は行わない');
  assert.equal(await service.scheduleIfDue('t1', new Date(Date.now() + 35 * day)), 'check', '次の回は見回る');
  const job = await store.activeJob('t1');
  assert.deepEqual([job?.kind, job?.args['scheduled'], job?.requestedBy], ['check', true, 'system']);
  assert.equal(await service.scheduleIfDue('t1', new Date(Date.now() + 35 * day)), null, '動いている作業があれば受け付けない');
  await watch.tick({ wait: true, now: new Date(Date.now() + 35 * day) });
  assert.equal(await service.scheduleIfDue('t1', new Date(Date.now() + 100 * day)), 'discover', '90 日を過ぎたら探し直す');
  await watch.tick({ wait: true, now: new Date(Date.now() + 100 * day) });
  setCompany({ address: '東京都江東区' });
  assert.equal(await service.scheduleIfDue('t1', new Date(Date.now() + 2 * 3_600_000)), 'discover', '住所が変わったらすぐ探し直す');
  await watch.tick({ wait: true });
  assert.equal(settings().competitors.watch, 'monthly');
  assert.equal(await service.setSettings(who, { watch: 'off' }), null);
  assert.equal(await service.scheduleIfDue('t1', new Date(Date.now() + 40 * day)), null, 'しないなら行わない');
  assert.match(await service.setSettings(who, { watch: 'daily' }) ?? '', /毎月・毎週・しない/);
});

test('変わったかの見分け: 印が同じページは前の回の事実を使い、動きにしない。ページが変わったら動きとして管理者に届ける', async () => {
  const { service, watch, store, pages, notes } = setup();
  await service.requestDiscover(who);
  await watch.tick({ wait: true });
  const [a] = (await service.overview(who)).competitors;
  const day = 86_400_000;
  // 次の回（ページは変わっていない）
  await service.scheduleIfDue('t1', new Date(Date.now() + 35 * day));
  // 回は見回った日にするため、同じ日の中で比べられるよう、前の回の事実と印を前の日にずらす
  const shift = async (cid: string | null) => {
    const facts = await store.facts('t1', cid);
    const pg = await store.pages('t1', cid);
    const today = facts[0]?.period ?? pg[0]?.period;
    if (!today) return;
    await store.replaceFacts('t1', cid, '2026-01-01', facts.filter((f) => f.period === today).map((f) => ({ kind: f.kind, text: f.text, sourceUrl: f.sourceUrl, pageHash: f.pageHash })));
    await store.replacePages('t1', cid, '2026-01-01', pg.filter((p) => p.period === today));
    await store.replaceFacts('t1', cid, today, []);
    await store.replacePages('t1', cid, today, []);
  };
  for (const c of await store.list('t1')) await shift(c.id);
  await shift(null);
  await watch.tick({ wait: true, now: new Date(Date.now() + 35 * day) });
  const [r1] = await service.reports(who);
  assert.equal(r1!.changes, 0, 'ページが変わっていなければ動きにしない');
  assert.ok((await service.facts(who, a!.id)).some((f) => f.period === new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)), '前の回の事実を今の回に引き継ぐ');
  const toBoss = notes.filter((n) => n.userId === 'boss' && /競合の動き/.test(n.title));
  assert.equal(toBoss.length, 1, '定期の見回りは管理者に届ける');
  assert.match(toBoss[0]!.body, /大きな動きはありませんでした/);
  assert.equal(notes.filter((n) => n.userId === 'u1' && /競合の動き/.test(n.title)).length, 0, '管理者でない人には届けない');
  // ページが変わった（キャンペーンの中身が変わった）
  pages['https://shop-a.example.jp/campaign'] = { body: '<html><head><title>キャンペーン</title></head><body><h2>11 月のキャンペーン 2 回目 30% 引き</h2></body></html>' };
  for (const c of await store.list('t1')) await shift(c.id);
  await shift(null);
  await service.requestCheck({ tenantId: 't1', userId: 'system' });
  const job = await store.activeJob('t1');
  job!.args['scheduled'] = true;
  await store.finishJob('t1', job!.id, 'done', '');
  await store.addJob('t1', { kind: 'check', args: { scheduled: true }, requestedBy: 'system' });
  await watch.tick({ wait: true });
  const [r2] = await service.reports(who);
  assert.ok(r2!.changes >= 1, '変わったページの新しい事実を動きとして数える');
  const last = notes.filter((n) => n.userId === 'boss' && /競合の動き/.test(n.title)).at(-1);
  assert.match(last!.body, /件の動き.*見本の競合 A/);
  // コラムの話題（第36.20節）: 動きから作り、競合の名前は入れない
  assert.ok(r2!.themes.length >= 1, '動きがあればコラムの話題を添える');
  assert.ok(r2!.themes.every((t) => !t.includes('見本の競合')), '話題に競合の名前を入れない');
});

test('問い合わせとのつなぎ: 「どこで知ったか」に競合の名前が出た件数だけをレポートに添える', async () => {
  const ctx = setup();
  const repo = (ctx.service as unknown as { deps: { repo: Repository } }).deps.repo;
  const service = new CompetitorService({
    store: ctx.store, repo, llmFor: async () => new StubLlmProvider(), placesKeyFor: async () => null, sourceFor: () => 'mock',
    userAgent: 'test', fetcherFor: () => ctx.fetcher,
    inquirySources: async () => ['見本の競合 A と比べて', 'Web 検索', '見本の競合 A の紹介', '紹介'],
  });
  await service.requestDiscover(who);
  await new CompetitorWatch({ service, store: ctx.store, repo }).tick({ wait: true });
  const [r] = await service.reports(who);
  assert.match(r!.text, /## 問い合わせで名前が出た競合\n- 見本の競合 A: 2 件/);
  assert.doesNotMatch(r!.text, /見本の競合 B: /, '名前が出ていない競合は書かない');
});

test('コラムの赤入れ: 他社と比べる表現（景品表示法の比較広告）を指摘する', async () => {
  const { ruleReview } = await import('../src/columns/review.js');
  const items = ruleReview('当店は他店より安く、地域最安です。', [], 1);
  assert.ok(items.some((i) => /比較広告/.test(i.reason)));
});

test('お知らせの案: 営業時間・キャンペーン・サービスの動きから 2 つまで挙げ、競合の名前を入れない。動きが無ければ出さない（第36.21節）', async () => {
  const subject = (facts: { kind: 'hours' | 'campaign' | 'news'; text: string }[], previous: typeof facts) => ({
    name: '見本の店', url: 'https://rival.example.jp', distanceM: 300, rating: null, ratingCount: null, readNote: '',
    facts: facts.map((f) => ({ ...f, sourceUrl: 'https://rival.example.jp/news' })), previous: previous.map((f) => ({ ...f, sourceUrl: 'https://rival.example.jp/news' })),
  });
  const moved = subject([{ kind: 'hours', text: '見本の店は年末年始 12/29〜1/3 休み' }, { kind: 'campaign', text: '冬のキャンペーン 10% 引き' }], [{ kind: 'news', text: '前の回の事実' }]);
  const ideas = await suggestAnnouncements(null, { business: '見本の業種' }, [moved], ['見本の店']);
  assert.equal(ideas.length, 2);
  assert.ok(ideas.every((x) => !x.text.includes('見本の店') && !x.why.includes('見本の店')));
  assert.match(ideas[0]!.text, /営業時間/);
  assert.deepEqual(await suggestAnnouncements(null, null, [subject([{ kind: 'news', text: 'お知らせ' }], [{ kind: 'news', text: 'お知らせ' }])], []), [], '動きが無ければ出さない');
});

test('ほかの拡張へのつなぎ: 月の動きの数を種類ごとに数え、話題を載せている競合の数だけを返す（名前は渡さない）', async () => {
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, competitors: { ...DEFAULT_TENANT_SETTINGS.competitors, enabled: true } };
  const repo = { getTenantSettings: async () => settings } as unknown as Repository;
  const store = new MemoryCompetitorStore();
  await store.addReport('t1', { period: '2026-09', text: '', changes: 3, themes: [], changeKinds: { campaign: 2, hours: 1 }, createdBy: 'boss' });
  const links = competitorLinksFrom({ store, repo });
  const month = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 7);
  assert.deepEqual(await links.monthMoves('t1', month), { changes: 3, kinds: [{ label: 'キャンペーン', count: 2 }, { label: '営業時間', count: 1 }] });
  assert.equal(await links.monthMoves('t1', '2001-01'), null);
  const id = await store.add('t1', { name: '', url: 'https://rival.example.jp', origin: 'manual', status: 'watching' } as never);
  await store.replaceFacts('t1', id, '2026-09', [{ kind: 'service', text: '冬の乾燥 対策 の相談', sourceUrl: 'https://rival.example.jp/s' }] as never);
  const counts = await links.topicCounts('t1', ['冬 乾燥 対策', '花粉']);
  assert.equal(counts.get('冬 乾燥 対策'), 1);
  assert.equal(counts.get('花粉'), 0);
  settings = { ...settings, competitors: { ...settings.competitors, enabled: false } };
  assert.equal(await links.monthMoves('t1', month), null, '切っている会社では返さない');
});

test('レポートの表の中の「出典: Google Maps」は、表の下に 1 度だけまとめる（第36.8節）', () => {
  const text = [
    '## 自社との違い',
    '| 会社 | Google の評価と件数 |',
    '|---|---|',
    '| 自社 | 4.5（120 件、出典: Google Maps） |',
    '| A 社 | 4.1（80 件）出典：Google Maps |',
    '## 相手の強み',
  ].join('\n');
  const out = gatherMapSource(text);
  assert.ok(!out.split('\n').filter((l) => l.startsWith('|')).some((l) => l.includes('Google Maps')));
  assert.ok(out.includes('| 自社 | 4.5（120 件） |'));
  assert.equal(out.split(REPORT_MAP_SOURCE_LINE).length - 1, 1);
  // 表と出典の行のあいだは空行（表の行に取り込まれないため）
  assert.ok(out.includes(`| A 社 | 4.1（80 件） |\n\n${REPORT_MAP_SOURCE_LINE}\n## 相手の強み`));
});

test('表の下にすでに出典の行があれば、もう 1 行は足さない。表に出典が無ければ変えない', () => {
  const already = '| a | 4.0（出典: Google Maps） |\n\nGoogle の評価と件数の出典: Google Maps';
  assert.equal(gatherMapSource(already).split('Google Maps').length - 1, 1);
  const plain = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert.equal(gatherMapSource(plain), plain);
});
