/**
 * @file 補助金・助成金の案内の段 1 の単体テスト（仕様書 第39.17節）。所在地は市区町村まで・従業員の数は幅・jGrants の読み方と地域の絞り込み・
 * 推論が使えないときの見立て・推論の見立て（出典の無い制度と締め切りの過ぎた制度を出さない、jGrants の金額と日付は API のまま）・
 * 1 日 1 回・見送りは出し直さない・中身が変われば出し直す・月の調べものと案内・締め切りの 14 日前と 3 日前・関心は管理者だけ・ツール。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  MemorySubsidyStore, MockJGrants, SUBSIDY_TOOLS, SubsidyService, areaMatches, employeesBand, keywordsOf, readJGrantsItem, regionOf,
  type JGrantsItem, type LlmProvider, type Repository, type ResearchProvider, type SubsidySource, type ToolContext,
} from '../src/index.js';

/** 2026-10-06（火）9:00（日本時間） */
const NOW = new Date('2026-10-06T00:00:00Z');

function setup(opts: { llm?: LlmProvider | null; research?: ResearchProvider; source?: SubsidySource; employees?: number | null } = {}) {
  let clock = NOW;
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', address: '大阪府大阪市北区梅田一丁目 1 番 1 号' },
    subsidies: { ...DEFAULT_TENANT_SETTINGS.subsidies, enabled: true },
  };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '総務', roles: ['member'], status: 'active' },
  ];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const notes: { userId: string; kind: string; title: string; body: string }[] = [];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: { subsidy: true } } }),
    createNotification: async (n: { userId: string; kind: string; title: string; body: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemorySubsidyStore();
  const mock = new MockJGrants(() => clock);
  const service = new SubsidyService({
    store, repo, sourceFor: () => opts.source ?? mock, llmFor: async () => opts.llm ?? null,
    ...(opts.research ? { researchFor: async () => opts.research! } : {}),
    employeesOf: async () => opts.employees ?? null, now: () => clock,
  });
  return { service, store, mock, audits, notes, settings: () => settings, setClock: (d: Date) => { clock = d; } };
}

const boss = { tenantId: 't1', userId: 'boss' };
const u1 = { tenantId: 't1', userId: 'u1' };

/** 決まった答えを返す推論。渡されたメッセージを控える。 */
function fakeLlm(reply: (prompt: string) => string): LlmProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake', prompts,
    async complete(req) {
      const p = req.messages.map((m) => m.content).join('\n');
      prompts.push(p);
      return { text: reply(p), tokensUsed: 1 };
    },
  } as LlmProvider & { prompts: string[] };
}

test('会社のこと: 所在地は都道府県と市区町村だけ、従業員の数は幅、対象の地域と関心の言葉', () => {
  assert.equal(regionOf('大阪府大阪市北区梅田一丁目 1 番 1 号'), '大阪府大阪市');
  assert.equal(regionOf('東京都千代田区丸の内 1-1'), '東京都千代田区');
  assert.equal(regionOf('北海道札幌市中央区北 1 条'), '北海道札幌市');
  assert.equal(regionOf('長野県北佐久郡軽井沢町 1-2'), '長野県北佐久郡軽井沢町');
  assert.equal(regionOf('住所不明'), '');
  assert.equal(employeesBand(null), '');
  assert.equal(employeesBand(3), '1〜5 人');
  assert.equal(employeesBand(12), '6〜20 人');
  assert.equal(employeesBand(450), '301 人以上');
  assert.equal(areaMatches('全国', '大阪府大阪市'), true);
  assert.equal(areaMatches('大阪府 / 兵庫県', '大阪府大阪市'), true);
  assert.equal(areaMatches('東京都', '大阪府大阪市'), false);
  assert.equal(areaMatches('', '大阪府大阪市'), true);
  const k = keywordsOf({ industry: '歯科医院', region: '', employees: '' }, 'IT導入、採用');
  assert.deepEqual(k, ['IT導入', '採用', '中小企業']);
  assert.deepEqual(keywordsOf({ industry: '', region: '', employees: '' }, ''), ['中小企業']);
});

test('jGrants の 1 件を読む（形が違えば捨てる）', () => {
  const i = readJGrantsItem({
    id: 'a0W000001', name: 'S-0001', title: '見本の補助金', institution_name: '見本庁', target_area_search: '全国',
    subsidy_max_limit: 1500000, acceptance_start_datetime: '2026-09-01T00:00:00Z', acceptance_end_datetime: '2026-11-30T08:00:00Z', target_number_of_employees: '20名以下',
  });
  assert.deepEqual(i, {
    id: 'a0W000001', title: '見本の補助金', institution: '見本庁', area: '全国', maxLimit: 1500000,
    start: '2026-09-01T00:00:00Z', end: '2026-11-30T08:00:00Z', employees: '20名以下',
  });
  assert.equal(readJGrantsItem({ title: 'ID が無い' }), null);
  assert.equal(readJGrantsItem('x'), null);
  assert.equal(readJGrantsItem({ id: 'b', title: 't', subsidy_max_limit: 0 })?.maxLimit, null);
});

test('推論が使えないとき: 地域が合う受付中の jGrants の公募を「条件を確かめたい」で出し、金額と日付は API のまま。1 日 1 回まで', async () => {
  const s = setup({ employees: 12 });
  const r = await s.service.search(u1);
  assert.ok('added' in r);
  // 見本の 3 件のうち、大阪府の会社には全国の 2 件と大阪府の 1 件が合う
  assert.equal(r.added.length, 3);
  const it = r.added.find((x) => x.name.includes('IT 導入'))!;
  assert.equal(it.fit, 'check');
  assert.equal(it.origin, 'jgrants');
  assert.equal(it.amount, '上限 4,500,000 円');
  assert.equal(it.rate, '');
  assert.equal(it.deadline, '2026-11-15');
  assert.match(it.sourceUrl, /^https:\/\/www\.jgrants-portal\.go\.jp\/subsidy\/mock-it-01$/);
  assert.match(it.reason, /大阪府大阪市/);
  assert.deepEqual(s.settings().subsidies.profile, { industry: '', region: '大阪府大阪市', employees: '6〜20 人' });
  assert.ok(s.audits.some((a) => a.action === 'subsidy.search'));

  const again = await s.service.search(u1);
  assert.ok('already' in again);
  // 頼みに関心があれば、その日のうちでも調べ直す（同じ制度は 2 度出さない）
  const more = await s.service.search(u1, '省エネ');
  assert.ok('added' in more);
  assert.equal(more.added.length, 0);
  assert.equal(s.store.rows.size, 3);
});

test('見送りにした制度は出し直さず、締め切りや中身が変われば出し直す', async () => {
  const items: JGrantsItem[] = [
    { id: 'j1', title: '見本 A の補助金', institution: '見本庁', area: '全国', maxLimit: 1_000_000, start: '', end: '2026-12-01T08:00:00Z', employees: '' },
    { id: 'j2', title: '見本 B の補助金', institution: '見本庁', area: '全国', maxLimit: 2_000_000, start: '', end: '2026-12-10T08:00:00Z', employees: '' },
  ];
  const s = setup({ source: { search: async () => items.map((x) => ({ ...x })) } });
  await s.service.search(u1);
  const [a, b] = await s.service.list(u1);
  assert.equal(await s.service.mark(u1, a!.id, 'skipped'), null);
  assert.equal(await s.service.mark(u1, b!.id, 'interested'), null);
  items[0]!.maxLimit = 3_000_000;
  items[1]!.end = '2026-12-20T08:00:00Z';
  s.setClock(new Date('2026-10-07T00:00:00Z'));
  await s.service.search(u1);
  const after = await s.service.list(u1);
  assert.equal(after.find((x) => x.id === a!.id)!.amount, '上限 1,000,000 円');
  assert.equal(after.find((x) => x.id === a!.id)!.status, 'skipped');
  assert.equal(after.find((x) => x.id === b!.id)!.deadline, '2026-12-20');
  assert.equal(after.find((x) => x.id === b!.id)!.status, 'interested');
});

test('推論の見立て: 合わないものは出さず、出典の無い制度と締め切りの過ぎた制度は捨て、jGrants の名前・金額・日付は API のまま', async () => {
  const research: ResearchProvider = {
    name: 'gemini',
    research: async () => ({
      source: 'gemini', text: '大阪市の見本の設備の補助金（上限 100 万円・補助率 2/3・締め切り 2026-11-20）。見本の雇用の助成金。', queries: [], tokensUsed: 1,
      sources: [{ title: '大阪市 見本の設備の補助金', url: 'https://www.city.example.jp/hojo' }, { title: '見本の労働局', url: 'https://jsite.example.jp/josei' }],
    }),
  };
  const llm = fakeLlm((p) => (p.includes('業種を短い言葉') ? '卸売業' : JSON.stringify({
    items: [
      { ref: 'J1', name: '書き換えた名前', amount: '上限 1 億円', deadline: '2030-01-01', kind: 'subsidy', fit: 'likely', reason: '中小企業の IT の導入が対象', conditions: '登録の支援事業者と組むこと' },
      { ref: '', name: '大阪市 見本の設備の補助金', provider: '大阪市', kind: 'subsidy', fit: 'check', reason: '市内の中小企業が対象', conditions: '市内に事業所', amount: '上限 100 万円', rate: '2/3', startOn: '', deadline: '2026-11-20', source: 'S1' },
      { ref: '', name: '出典の無い制度', provider: '?', kind: 'grant', fit: 'likely', reason: 'x', conditions: '', source: '' },
      { ref: '', name: '過ぎた制度', provider: '見本の労働局', kind: 'grant', fit: 'check', reason: 'x', conditions: '', deadline: '2026-09-30', source: 'S2' },
    ],
  })));
  const s = setup({ llm, research, employees: 30 });
  const r = await s.service.search(u1, '人の採用');
  assert.ok('added' in r);
  assert.deepEqual(r.added.map((x) => x.name).sort(), ['大阪市 見本の設備の補助金', '見本 IT 導入の補助金（通常枠）'].sort());
  const it = r.added.find((x) => x.origin === 'jgrants')!;
  assert.equal(it.fit, 'likely');
  assert.equal(it.amount, '上限 4,500,000 円');
  assert.equal(it.deadline, '2026-11-15');
  const city = r.added.find((x) => x.origin === 'web')!;
  assert.equal(city.sourceUrl, 'https://www.city.example.jp/hojo');
  assert.equal(city.rate, '2/3');
  // 推論に渡すのは業種・市区町村まで・人数の幅・関心だけ（番地や会社の名前は見立てに渡さない）
  const judge = llm.prompts.find((p) => p.includes('会社に合いそうな補助金'))!;
  assert.match(judge, /業種 卸売業／所在地 大阪府大阪市／従業員の数 21〜50 人／関心 人の採用/);
  assert.doesNotMatch(judge, /梅田|一丁目/);
});

test('月の調べもの: 1 日の 8 時を過ぎたら月に 1 回だけ調べ、新しい候補があれば管理者に知らせる', async () => {
  const s = setup();
  assert.deepEqual(await s.service.tick(new Date('2026-10-20T00:00:00Z')), { searched: 1, reminded: 0 });
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0]!.userId, 'boss');
  assert.equal(s.notes[0]!.kind, 'subsidy');
  assert.match(s.notes[0]!.title, /合いそうな補助金・助成金が 3 件あります/);
  assert.match(s.notes[0]!.body, /出典で確かめてください/);
  // 10 月分は済み。11/1 の 7 時（日本時間）はまだ（11 月分は 8 時から）
  assert.deepEqual(await s.service.tick(new Date('2026-10-31T22:30:00Z')), { searched: 0, reminded: 0 });
  assert.deepEqual(await s.service.tick(new Date('2026-11-01T00:00:00Z')), { searched: 1, reminded: 0 });
  // 新しい候補が無ければ知らせない
  assert.equal(s.notes.length, 1);
  assert.deepEqual(await s.service.tick(new Date('2026-11-02T00:00:00Z')), { searched: 0, reminded: 0 });
});

test('締め切り: 「気になる」にした制度は 14 日前と 3 日前に、気になるにした人へ 1 回ずつ知らせる', async () => {
  const s = setup();
  await s.service.search(u1);
  const eco = (await s.service.list(u1)).find((x) => x.name.includes('省エネ'))!;
  assert.equal(eco.deadline, '2026-10-26');
  assert.equal(await s.service.mark(u1, eco.id, 'interested'), null);
  await s.service.saveSettings(boss, {});
  const settings = s.settings().subsidies;
  // 月の調べものは済んだことにする
  await (s.service.deps.repo.saveTenantSettings('t1', 'subsidies', { ...settings, monthlyMonth: '2026-10' }, 'x'));
  assert.deepEqual(await s.service.tick(new Date('2026-10-11T00:00:00Z')), { searched: 0, reminded: 0 });
  assert.deepEqual(await s.service.tick(new Date('2026-10-12T00:00:00Z')), { searched: 0, reminded: 1 });
  assert.deepEqual(await s.service.tick(new Date('2026-10-12T05:00:00Z')), { searched: 0, reminded: 0 });
  assert.equal(s.notes.at(-1)!.userId, 'u1');
  assert.match(s.notes.at(-1)!.title, /締め切りまであと 14 日（2026-10-26）/);
  assert.deepEqual(await s.service.tick(new Date('2026-10-23T00:00:00Z')), { searched: 0, reminded: 1 });
  assert.deepEqual(await s.service.tick(new Date('2026-10-24T00:00:00Z')), { searched: 0, reminded: 0 });
});

test('関心と業種を直せるのは管理者だけ。直した業種で調べる', async () => {
  const s = setup();
  assert.match((await s.service.saveSettings(u1, { interest: 'IT の導入' })) ?? '', /管理者だけ/);
  assert.equal(await s.service.saveSettings(boss, { interest: ' IT の導入 ', industry: '歯科医院' }), null);
  assert.equal(s.settings().subsidies.interest, 'IT の導入');
  assert.equal((await s.service.profileOf('t1')).industry, '歯科医院');
  assert.ok(s.audits.some((a) => a.action === 'subsidy.settings'));
});

test('ツール: 使えない人には使えないと答え、候補を引いて出典つきで返し、見送りにする（申請書の注意を添える）', async () => {
  const s = setup();
  await s.service.search(u1);
  const tool = (name: string) => SUBSIDY_TOOLS.find((t) => t.name === name)!;
  const ctx = (on: boolean) => ({ tenantId: 't1', userId: 'u1', subsidies: { service: s.service, access: async () => (on ? s.settings().subsidies : null) } }) as unknown as ToolContext;
  const off = await tool('subsidies.find').invoke({}, ctx(false)) as { available: boolean };
  assert.equal(off.available, false);
  const found = await tool('subsidies.find').invoke({ query: '省エネ' }, ctx(true)) as { untrusted: boolean; count: number; items: { name: string; rate: string; source: { url: string } }[]; note: string };
  assert.equal(found.untrusted, true);
  assert.equal(found.count, 1);
  assert.equal(found.items[0]!.rate, '不明（出典で確かめてください）');
  assert.match(found.note, /申請書は作りません/);
  const skipped = await tool('subsidies.mark').invoke({ query: '省エネ', status: 'skipped' }, ctx(true)) as { available: boolean; status: string };
  assert.equal(skipped.status, '見送り');
  const left = await tool('subsidies.find').invoke({}, ctx(true)) as { count: number };
  assert.equal(left.count, 2);
  const many = await tool('subsidies.mark').invoke({ query: '見本', status: 'interested' }, ctx(true)) as { available: boolean };
  assert.equal(many.available, false);
});
