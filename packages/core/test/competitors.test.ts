/**
 * @file 競合の分析の段 1 の単体テスト（仕様書 第36.18節）。robots.txt・社内のアドレスを断る・HTML の読み方・
 * 探す（地図で近くの同業。自社と遠い店を外す）・読む（robots.txt に従う）・事実とレポート・入れる・外す（入れ直さない）・ツール。
 * 見本の地図とサイトで確かめ、外には何も読みに行かない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  CompetitorService, CompetitorWatch, MemoryCompetitorStore, MockPageFetcher, MOCK_SITES, StubLlmProvider, COMPETITOR_TOOLS,
  checkUrl, crawlerUserAgent, isBlockedAddress, parseRobots, readHtml, robotsAllows,
  type Repository, type ToolContext,
} from '../src/index.js';

function setup(over: Partial<TenantSettings['company']> = {}) {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', address: '東京都千代田区丸の内一丁目', ...over },
    competitors: { enabled: true, areaOverride: null },
  };
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const notes: { title: string; body: string }[] = [];
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    findTenantById: async () => ({ id: 't1', name: '株式会社アルファ商事' }),
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: { competitor: true } } }),
    createNotification: async (n: { title: string; body: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryCompetitorStore();
  const fetcher = new MockPageFetcher(MOCK_SITES);
  const service = new CompetitorService({
    store, repo, llmFor: async () => new StubLlmProvider(), placesKeyFor: async () => null, sourceFor: () => 'mock',
    userAgent: 'test', fetcherFor: () => fetcher,
  });
  const watch = new CompetitorWatch({ service, store, repo });
  return { service, store, watch, fetcher, audits, notes, settings: () => settings };
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
  const stored = await store.list('t1');
  assert.ok(stored.every((c) => c.name === '' && c.url === '' && c.placeId), '地図の名前と URL は残さない');
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
  const ctx = (on: boolean) => ({ tenantId: 't1', userId: 'u1', competitors: { service, access: async () => (on ? { enabled: true, areaOverride: null } : null) } } as unknown as ToolContext);
  const tool = (name: string) => COMPETITOR_TOOLS.find((t) => t.name === name)!;
  assert.deepEqual(await tool('competitors.list').invoke({}, ctx(false)), { available: false, reason: '競合の分析は使えません（会社で切っているか、利用範囲の外です）' });
  const list = await tool('competitors.list').invoke({}, ctx(true)) as { competitors: { name: string; source: string | null }[] };
  assert.equal(list.competitors[0]?.source, 'Google Maps');
  const facts = await tool('competitors.facts').invoke({ q: '競合 A' }, ctx(true)) as { competitors: { facts: unknown[] }[]; self: unknown[] };
  assert.equal(facts.competitors.length, 1);
  assert.ok(facts.self.length > 0);
  const report = await tool('competitors.report').invoke({}, ctx(true)) as { report: string };
  assert.match(report.report, /今月の動き/);
  const removed = await tool('competitors.remove').invoke({ q: '競合 B' }, ctx(true)) as { removed: string };
  assert.equal(removed.removed, '見本の競合 B');
  assert.equal(tool('competitors.discover').risk, 'write-internal');
});
