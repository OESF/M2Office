/**
 * @file Web の振り返りの段 1・段 2 の単体テスト（仕様書 第34.18節・第34.19節）。期間の決め方・サイトの選び方・月の便りの数字（プログラムが計算する）・
 * 秘書の問い（決まった一覧の外は呼ばない）・担当の許可とサイトの自動の選択・月に 1 回の便りと知らせ・ツール・
 * 直すべき所（6 つの種類・依頼文・状態・また見つかったとき）・コラムごとの数字。見本の口（MockWebData）で確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Notification, type TenantCredential, type TenantSettings } from '@m2office/shared';
import {
  MemoryWebReviewStore, MockWebData, WebReviewService, WEB_REVIEW_TOOLS, accessRequestDraft, answerAsk, checkAsk, monthFigures, periodRange, pickSite, plainWebReport,
  findIssues, rankBand, requestDraftFor, type WebReviewColumns,
  type Repository, type ToolContext,
} from '../src/index.js';

function setup(opts: { website?: string; columns?: WebReviewColumns } = {}) {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', shortName: 'アルファ', website: opts.website ?? 'https://www.alpha.example.jp/' },
    webReview: { ...DEFAULT_TENANT_SETTINGS.webReview, enabled: true },
  };
  const creds = new Map<string, TenantCredential>();
  const notes: Notification[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'admin2', email: 'a2@alpha.example.jp', displayName: '管理者 2', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '社員', roles: ['member'], status: 'active' },
  ];
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    getTenantCredential: async (_t: string, kind: string) => creds.get(kind) ?? null,
    saveTenantCredential: async (c: TenantCredential) => { creds.set(c.kind, c); },
    deleteTenantCredential: async (_t: string, kind: string) => creds.delete(kind),
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    listUserGroupIds: async () => [],
    listTenantIds: async () => ['t1'],
    getUserSettings: async (_t: string, id: string) => ({ notifications: { kinds: { webReview: id !== 'admin2' } } }),
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryWebReviewStore();
  const service = new WebReviewService({
    store, repo, llmFor: async () => null, ...(opts.columns ? { columns: opts.columns } : {}),
    data: { repo, box: { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) } as never, sourceFor: () => 'mock' },
  });
  return { service, store, notes, audits, creds, settings: () => settings };
}

const boss = { tenantId: 't1', userId: 'boss' };
const OCT4 = new Date('2026-10-04T01:00:00Z'); // 日本時間 10 月 4 日 10 時

test('期間: 先月は前の月と比べ、先週は月曜から日曜。読めない日付は扱わない', () => {
  assert.deepEqual(periodRange('lastMonth', OCT4), { start: '2026-09-01', end: '2026-09-30', label: '9 月', compare: { start: '2026-08-01', end: '2026-08-31' } });
  const week = periodRange('lastWeek', OCT4)!;
  assert.deepEqual([week.start, week.end, week.compare.start, week.compare.end], ['2026-09-21', '2026-09-27', '2026-09-14', '2026-09-20']);
  assert.deepEqual(periodRange('last7Days', OCT4)!.end, '2026-10-03', '今日はまだ数字が無いので昨日まで');
  assert.equal(periodRange('custom', OCT4, { start: '2026-09-31', end: 'x' }), null);
  // 1 月の先月は前の年の 12 月
  assert.equal(periodRange('lastMonth', new Date('2027-01-10T00:00:00Z'))!.start, '2026-12-01');
});

test('サイトの選び方: 会社の Web サイトのホスト名で決まった規則で選び、決められなければ選ばない', () => {
  const props = [
    { id: 'properties/1', name: '本店', account: 'A', uris: ['https://www.alpha.example.jp/'] },
    { id: 'properties/2', name: 'ほかの店', account: 'A', uris: ['https://beta.example.jp'] },
  ];
  const sites = [{ siteUrl: 'https://www.alpha.example.jp/', permission: 'siteOwner' }, { siteUrl: 'sc-domain:alpha.example.jp', permission: 'siteOwner' }];
  const p = pickSite('alpha.example.jp', props, sites);
  assert.equal(p.property?.id, 'properties/1');
  assert.equal(p.site?.siteUrl, 'sc-domain:alpha.example.jp', 'ドメインのプロパティを先にする');
  assert.deepEqual(pickSite('https://gamma.example.jp', props, sites), { property: null, site: null }, '合うものが無く、いくつもあれば選ばない');
  assert.equal(pickSite('', [props[1]!], []).property?.id, 'properties/2', '見られるものが 1 つだけならそれ');
});

test('月の便りの数字: プログラムが計算し、前の月・前の年と比べる。キーイベントが無ければ問い合わせのページで数える', async () => {
  const f = await monthFigures(new MockWebData(), '2026-09', { propertyId: 'properties/100001', siteUrl: 'sc-domain:alpha.example.jp' });
  assert.equal(f.start, '2026-09-01');
  assert.equal(f.end, '2026-09-30');
  assert.ok(f.analytics && f.search);
  assert.ok(f.analytics.users.value! > 100 && f.analytics.users.previous !== null && f.analytics.users.lastYear !== null);
  assert.equal(f.few, false);
  assert.equal(f.analytics.inquiries.basis, 'pages', 'キーイベントが無ければ問い合わせのページで数える');
  assert.ok(f.analytics.inquiries.value! > 0);
  assert.equal(f.analytics.sources[0]!.label, '検索', 'どこから来たかは言い換える');
  assert.equal(f.analytics.regions[0]!.label, '東京都', '都道府県は日本語にする');
  assert.ok(f.analytics.mobileShare! > 0.5);
  assert.equal(f.search.topQueries.length, 5);
  assert.deepEqual(f.missing, []);
  // 選んでいないものは推し量らず、理由を残す
  const none = await monthFigures(new MockWebData(), '2026-09', { propertyId: null, siteUrl: 'sc-domain:alpha.example.jp' });
  assert.equal(none.analytics, null);
  assert.ok(none.missing.some((m) => /プロパティを選んでいません/.test(m)));
});

test('決まった形の便り: 来た人が少ない月は上がり下がりを書かず、取れなかった数字を書く', async () => {
  const f = await monthFigures(new MockWebData(), '2026-09', { propertyId: 'properties/100001', siteUrl: null });
  const text = plainWebReport({ ...f, few: true });
  assert.ok(!/前の月より [+-]/.test(text.summary));
  assert.match(text.good, /少ない/);
  assert.match(plainWebReport(f).concern, /取得できなかった数字/);
  assert.ok(plainWebReport(f).next.length >= 1);
});

test('秘書の問い: 決まった指標と切り口の組み合わせだけ。数字・期間・比べた相手を返す', async () => {
  assert.equal(checkAsk({ metric: 'users', breakdown: 'searchQuery', period: 'lastMonth' }), 'その切り口は扱っていません');
  assert.equal(checkAsk({ metric: 'bounce' as never, breakdown: 'none', period: 'lastMonth' }), 'その指標は扱っていません');
  const target = { propertyId: 'properties/100001', siteUrl: 'sc-domain:alpha.example.jp' };
  const src = await answerAsk(new MockWebData(), target, { metric: 'users', breakdown: 'source', period: 'lastMonth' }, OCT4);
  assert.ok(!('error' in src));
  if (!('error' in src)) {
    assert.deepEqual(src.period, { start: '2026-09-01', end: '2026-09-30', label: '9 月' });
    assert.equal(src.rows[0]!.label, '検索');
    assert.ok(src.value! > 0 && src.change !== null);
  }
  const page = await answerAsk(new MockWebData(), target, { metric: 'pageViews', breakdown: 'none', period: 'lastMonth', contains: 'price' }, OCT4);
  assert.ok(!('error' in page) && page.value! > 0);
  const word = await answerAsk(new MockWebData(), target, { metric: 'searchClicks', breakdown: 'searchQuery', period: 'lastMonth', contains: '料金' }, OCT4);
  assert.ok(!('error' in word) && word.source === 'Search Console' && word.rows.every((r) => r.label.includes('料金')));
  const noSite = await answerAsk(new MockWebData(), { propertyId: 'properties/100001', siteUrl: null }, { metric: 'searchClicks', breakdown: 'none', period: 'lastMonth' }, OCT4);
  assert.deepEqual(noSite, { error: 'Search Console のサイトを選んでいません' });
});

test('担当の許可: つなぐと会社の Web サイトに合うプロパティとサイトを選び、外すとすぐ読まなくなる', async () => {
  const { service, settings, creds, audits } = setup();
  assert.equal((await service.status('t1')).state, 'notConnected');
  const st = await service.connect(boss, { email: 'Boss@alpha.example.jp', refreshToken: null });
  assert.equal(st.state, 'ready');
  assert.equal(settings().webReview.connection?.email, 'boss@alpha.example.jp');
  assert.equal(settings().webReview.property?.id, 'properties/100001');
  assert.equal(settings().webReview.siteUrl, 'sc-domain:alpha.example.jp');
  assert.ok(creds.has('web_review'));
  assert.ok(audits.some((a) => a.action === 'web_review.connect') && audits.some((a) => a.action === 'web_review.select'));
  assert.equal(await service.select(boss, { siteUrl: 'sc-domain:other.example.jp' }), 'そのサイトは見られません', '見られるものの中からだけ選べる');
  await service.disconnect(boss);
  assert.equal(settings().webReview.connection, null);
  assert.equal(creds.has('web_review'), false);
  assert.ok('error' in (await service.ask('t1', { metric: 'users', breakdown: 'none', period: 'lastMonth' })));
  // 合うものを決められなければ、選ぶのを待つ
  const other = setup({ website: 'https://gamma.example.jp' });
  assert.equal((await other.service.connect(boss, { email: 'boss@alpha.example.jp', refreshToken: null })).state, 'ready', '見られるものが 1 つだけならそれを選ぶ');
});

test('制作会社への依頼文: 担当のアドレスを閲覧者と制限付きユーザーに足してもらう（送らない）', () => {
  const d = accessRequestDraft('boss@alpha.example.jp', 'アルファ', 'https://www.alpha.example.jp/');
  assert.match(d.body, /boss@alpha\.example\.jp を、このサイトのプロパティの「閲覧者」/);
  assert.match(d.body, /「制限付きユーザー」/);
});

test('月の便り: 3 日の 8 時を過ぎたら先月分を 1 回だけ作り、担当と管理者に知らせる（切っている人には知らせない）', async () => {
  const { service, store, notes, audits } = setup();
  await service.connect(boss, { email: 'boss@alpha.example.jp', refreshToken: null });
  assert.equal((await service.tick(new Date('2026-10-02T22:59:00Z'))).created, 0, '日本時間 3 日の 7 時 59 分は作らない');
  assert.equal((await service.tick(new Date('2026-10-03T00:00:00Z'))).created, 1);
  assert.equal((await service.tick(new Date('2026-10-03T01:00:00Z'))).created, 0, '月に 1 回だけ');
  const r = (await store.get('t1', '2026-09'))!;
  assert.ok(r.summary.length > 0 && r.next.length >= 1);
  assert.equal(r.figures.analytics?.users.value !== null, true);
  assert.deepEqual(notes.filter((n) => /便り/.test(n.title)).map((n) => [n.userId, n.kind, n.title]), [['boss', 'webReview', '9 月の Web の便りが届きました']], '担当と管理者に。切っている管理者には届けない');
  assert.ok(audits.some((a) => a.action === 'web_review.report'));
  assert.equal((await service.recentSummary('t1', new Date(Date.parse(r.createdAt) + 86_400_000)))?.month, '2026-09');
  assert.equal(await service.recentSummary('t1', new Date(Date.parse(r.createdAt) + 9 * 86_400_000)), null, '週次ブリーフには 8 日のうちだけ');
});

test('ツール: 使えない人には使えないと返し、選び直しは管理者だけ', async () => {
  const { service } = setup();
  await service.connect(boss, { email: 'boss@alpha.example.jp', refreshToken: null });
  const ctx = (userId: string, on = true) => ({ tenantId: 't1', userId, webReview: { service, access: async () => (on ? { enabled: true } : null) } }) as unknown as ToolContext;
  const tool = (name: string) => WEB_REVIEW_TOOLS.find((t) => t.name === name)!;
  assert.equal((await tool('web_review.ask').invoke({ metric: 'users' }, ctx('u1', false)) as { available: boolean }).available, false);
  const ans = await tool('web_review.ask').invoke({ metric: 'users', breakdown: 'device' }, ctx('u1')) as { available: boolean; rows: { label: string }[] };
  assert.equal(ans.available, true);
  assert.equal(ans.rows[0]!.label, 'スマホ');
  const out = await tool('web_review.ask').invoke({ metric: 'users', breakdown: 'searchQuery' }, ctx('u1')) as { available: boolean; reason: string };
  assert.equal(out.reason, 'その切り口は扱っていません');
  assert.equal((await tool('web_review.select').invoke({ site: 'alpha' }, ctx('u1')) as { reason: string }).reason, '選び直せるのは管理者だけです');
  assert.equal((await tool('web_review.select').invoke({ site: 'alpha' }, ctx('boss')) as { available: boolean }).available, true);
  const report = await tool('web_review.report').invoke({}, ctx('u1')) as { report: null; note: string };
  assert.match(report.note, /毎月 3 日/);
  for (const t of WEB_REVIEW_TOOLS) assert.ok(t.risk === 'read' || t.risk === 'write-internal', '社外には何も出さない');
});

const COLUMN_URL = 'https://www.alpha.example.jp/column/spring/';
const fakeColumns: WebReviewColumns = { published: async () => [{ id: 'col-1', title: '春のコラム', url: COLUMN_URL }] };

test('直すべき所: 6 つの種類を決まった基準で見つけ、コラムには依頼文を作らず、ほかには制作会社への依頼文を下書きする', async () => {
  assert.equal(rankBand(3.2), 0, '平均の順位は四捨五入して区切る');
  assert.equal(rankBand(8), 2);
  const r = await findIssues(new MockWebData(), {
    propertyId: 'properties/100001', siteUrl: 'sc-domain:alpha.example.jp', origin: 'https://www.alpha.example.jp', companyNames: ['見本の会社'],
    columns: [{ id: 'col-1', title: '春のコラム', url: COLUMN_URL }],
  }, 'アルファ', OCT4);
  const by = (k: string) => r.findings.filter((f) => f.kind === k).map((f) => f.target);
  assert.deepEqual(by('lowCtr'), ['/service/']);
  assert.deepEqual(by('nearFirstPage').sort(), ['/column/spring/', '/price/']);
  assert.deepEqual(by('missingContent'), ['冬 乾燥 対策'], '会社の名前を含む言葉は除く');
  assert.deepEqual(by('notIndexed'), ['/company/']);
  assert.deepEqual(by('slowMobile'), ['/price/']);
  assert.deepEqual(by('fading'), ['/column/winter/']);
  const spring = r.findings.find((f) => f.target === '/column/spring/')!;
  assert.equal(spring.columnId, 'col-1');
  assert.equal(spring.requestDraft, null, 'コラムは書き直しを頼むので依頼文を作らない');
  const slow = r.findings.find((f) => f.kind === 'slowMobile')!;
  assert.match(slow.advice, /38 点/);
  assert.match(slow.requestDraft!.body, /ページ: https:\/\/www\.alpha\.example\.jp\/price\//);
  assert.match(slow.requestDraft!.body, /スマホでの表示を速くしていただけますでしょうか/);
  assert.equal(r.findings.find((f) => f.kind === 'missingContent')!.requestDraft, null);
  assert.deepEqual(r.pageMetrics.map((m) => m.path), ['/column/spring/']);
  assert.ok(r.pageMetrics[0]!.views! > 0 && r.pageMetrics[0]!.readSeconds! > 0 && r.pageMetrics[0]!.queries.length > 0);
  assert.deepEqual(r.missing, []);
  // 推論の案があるときだけ「上の案を参考に」と頼む
  assert.match(requestDraftFor('lowCtr', { url: 'u', title: 't' }, '理由\n案:\n題名: x', 'ア').body, /上の案を参考に/);
  assert.doesNotMatch(requestDraftFor('lowCtr', { url: 'u', title: 't' }, '理由', 'ア').body, /上の案/);
});

test('直すべき所の見回り: 初めては見回り、また見つかっても新しいにしない。見送りはそのまま、済んだは 28 日を過ぎたら新しいに戻す', async () => {
  const { service, store, notes, audits } = setup({ columns: fakeColumns });
  await service.connect(boss, { email: 'boss@alpha.example.jp', refreshToken: null });
  const first = (await service.checkFindings('t1', OCT4))!;
  assert.equal(first.found, 7);
  assert.equal(first.fresh, 7);
  assert.ok(notes.some((n) => n.userId === 'boss' && /直すべき所が 7 件/.test(n.title)), '担当に知らせる');
  assert.ok(audits.some((a) => a.action === 'web_review.check'));
  assert.equal((await service.columnMetrics('t1', 'col-1'))?.path, '/column/spring/', 'コラムの数字を置く');
  const list = await service.findings('t1');
  const slow = list.find((f) => f.kind === 'slowMobile')!;
  const fade = list.find((f) => f.kind === 'fading')!;
  assert.equal(await service.setFindingStatus({ tenantId: 't1', userId: 'u1' }, slow.id, 'dismissed'), null);
  assert.equal(await service.setFindingStatus({ tenantId: 't1', userId: 'u1' }, fade.id, 'done'), null);
  assert.equal(await service.setFindingStatus({ tenantId: 't1', userId: 'u1' }, 'nope', 'done'), '直すべき所が見つかりません');
  const again = (await service.checkFindings('t1', new Date(OCT4.getTime() + 7 * 86_400_000)))!;
  assert.equal(again.fresh, 0, 'また見つかっても新しいにしない');
  assert.equal((await store.finding('t1', slow.id))!.status, 'dismissed', '見送りはそのまま');
  assert.equal((await service.findings('t1')).some((f) => f.id === fade.id), false, '済んだは一覧（新しい・見た）に出さない');
  // 済んだにして 28 日を過ぎてからまた見つかったら、新しいに戻す
  const later = (await service.checkFindings('t1', new Date(Date.now() + 40 * 86_400_000)))!;
  assert.equal(later.fresh, 1);
  assert.equal((await store.finding('t1', fade.id))!.status, 'new');
});

test('直すべき所の見回りの番: 頼まれた・初めてならすぐ、ふだんは月曜の 5 時を過ぎて前から 6 日より経ったとき', async () => {
  const { service, settings } = setup();
  await service.connect(boss, { email: 'boss@alpha.example.jp', refreshToken: null });
  assert.equal((await service.tick(new Date('2026-10-04T01:00:00Z'))).checked, 1, '初めては日曜でも見回る');
  assert.equal((await service.tick(new Date('2026-10-04T02:00:00Z'))).checked, 0);
  assert.equal(await service.requestCheck(boss), null);
  assert.ok(settings().webReview.checkRequestedAt);
  assert.equal((await service.tick(new Date('2026-10-04T03:00:00Z'))).checked, 1, '今すぐチェック');
  assert.equal(settings().webReview.checkRequestedAt, null);
  assert.equal((await service.tick(new Date('2026-10-11T19:00:00Z'))).checked, 0, '日本時間の月曜 4 時はまだ');
  assert.equal((await service.tick(new Date('2026-10-11T21:00:00Z'))).checked, 1, '日本時間の月曜 6 時');
});

test('ツール: 直すべき所を理由と依頼文つきで返す（送らない）', async () => {
  const { service } = setup({ columns: fakeColumns });
  await service.connect(boss, { email: 'boss@alpha.example.jp', refreshToken: null });
  const ctx = { tenantId: 't1', userId: 'u1', webReview: { service, access: async () => ({ enabled: true, checkedAt: null }) } } as unknown as ToolContext;
  const tool = WEB_REVIEW_TOOLS.find((t) => t.name === 'web_review.findings')!;
  assert.equal(tool.risk, 'read');
  assert.match((await tool.invoke({}, ctx) as { note: string }).note, /まだ見回っていません/);
  await service.checkFindings('t1', OCT4);
  const r = await tool.invoke({ kind: 'slowMobile' }, ctx) as { items: { kind: string; requestDraft: { subject: string } | null }[] };
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.kind, 'スマホで遅いページ');
  assert.match(r.items[0]!.requestDraft!.subject, /Web サイトの直しのお願い/);
});

