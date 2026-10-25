/**
 * @file 作ったスライドの扱い（覚える・直す・共有する・削除・一覧）の単体テスト。
 *
 * @see 仕様書 第9.4.2節「作ったスライドの扱い」、Q-264、ADR-0108
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TOOLS, InMemorySlideDeckStore, MockWorkspaceConnector, SlideDeckService, ToolRegistry, slideDeckLinks, type SlideDeck, type ToolContext,
} from '../src/index.js';

const registry = new ToolRegistry();
for (const t of BUILTIN_TOOLS) registry.register(t);

const PLAN = {
  title: '新しい道具の導入', notes: '表紙で話す', imagePrompt: '朝の光が差す整った机',
  slides: [
    { layout: 'SECTION', number: '01', title: 'いまの課題', notes: '課題を話す', imagePrompt: '積み上がった書類の山' },
    { layout: 'STATEMENT', title: '', message: '手間を半分にする', notes: 'まとめを話す' },
    { layout: 'KPI', title: '効果は 3 つの数字に出る', notes: '数字を話す', stats: [{ value: '50', unit: '%', label: '手間' }, { value: '2', unit: '倍', label: '速さ' }] },
  ],
};

/** 記録する見本のスライドの接続口。 */
function fakeSlides() {
  const calls = {
    created: [] as { rebuild?: string; reuseImages?: Record<string, string>; images: string[] }[],
    shared: [] as { id: string; domain: string | null }[],
    trashed: [] as string[],
  };
  const state = new Map<string, { modifiedTime: string; trashed: boolean }>();
  let n = 0;
  const slides = {
    readTemplate: async () => null,
    createPresentation: async (_p: unknown, input: { rebuild?: string; reuseImages?: Record<string, string>; images?: Record<string, unknown> }) => {
      calls.created.push({ ...(input.rebuild ? { rebuild: input.rebuild } : {}), ...(input.reuseImages ? { reuseImages: input.reuseImages } : {}), images: Object.keys(input.images ?? {}) });
      const id = input.rebuild ?? `DECK${++n}`;
      state.set(id, { modifiedTime: new Date().toISOString(), trashed: false });
      return { presentationId: id, ...slideDeckLinks(id), templateApplied: false, pages: 4, warnings: [] };
    },
    fileState: async (_p: unknown, id: string) => state.get(id) ?? null,
    share: async (_p: unknown, id: string, domain: string | null) => { calls.shared.push({ id, domain }); return state.has(id); },
    trash: async (_p: unknown, id: string) => { calls.trashed.push(id); const s = state.get(id); if (s) s.trashed = true; return !!s; },
  };
  return { slides, calls, state };
}

const USERS: Record<string, { id: string; email: string; displayName: string }> = {
  u: { id: 'u', email: 'u@example.co.jp', displayName: '見本 太郎' },
  v: { id: 'v', email: 'v@example.co.jp', displayName: '見本 花子' },
  g: { id: 'g', email: 'g@gmail.example', displayName: '個人の人' },
};

function setup(workspaceDomain: string | null = 'example.co.jp') {
  const store = new InMemorySlideDeckStore();
  const fake = fakeSlides();
  const connector = new MockWorkspaceConnector();
  (connector as unknown as { slides: unknown }).slides = fake.slides;
  const artifacts: { kind: string; body: string; slideDeckId?: string | null }[] = [];
  const repo = {
    createArtifact: async (a: { kind: string; body: string; slideDeckId?: string | null }) => { artifacts.push(a); },
    getTenantSettings: async () => ({ slides: { templates: [], defaultDesign: null }, company: { legalName: '株式会社見本', shortName: '見本' } }),
    findTenantById: async () => ({ id: 't', subdomain: 'a', name: '見本', workspaceDomain, status: 'active' }),
    findUserById: async (_t: string, id: string) => USERS[id] ?? null,
    getGoogleConnection: async () => null,
  };
  const service = new SlideDeckService({ store, repo: repo as never, connector });
  // Google の接続口として振る舞う（見本の接続口の扱いにしない）
  (connector as unknown as { sourceFor: () => string }).sourceFor = () => 'google';
  const generated: string[] = [];
  const ctx = (userId = 'u'): ToolContext => ({
    tenantId: 't', userId, runId: `r-${userId}`, compartment: null, repo: repo as never, connector, files: {} as never, slideDecks: service,
    slideImages: { generate: async (prompt) => { generated.push(prompt); return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' }; } },
  });
  return { store, fake, service, ctx, artifacts, generated };
}

const create = (c: ToolContext, args: Record<string, unknown>) => registry.get('slides.create')!.invoke(args, c) as Promise<Record<string, unknown>>;

test('slides.create: 作ったスライドを作った人ごとに覚え、成果物に結び付ける。成果物の文に URL を書かない', async () => {
  const s = setup();
  const out = await create(s.ctx(), { ...structuredClone(PLAN), request: '新しい道具の導入を 4 ページで' });
  const deck = (await s.store.get('t', String(out['deckId'])))!;
  assert.equal(deck.userId, 'u');
  assert.equal(deck.presentationId, 'DECK1');
  assert.equal(deck.sharing, 'private');
  assert.equal(deck.request, '新しい道具の導入を 4 ページで');
  assert.equal(deck.plan.slides.length, 3);
  assert.deepEqual(deck.imagePrompts, { cover: '朝の光が差す整った机', m2slide1: '積み上がった書類の山' });
  assert.equal(s.artifacts[0]!.slideDeckId, deck.id);
  assert.doesNotMatch(s.artifacts[0]!.body, /https?:\/\//, 'リンクはボタンにする');
});

test('slides.create: 直すときは同じファイルを作り直し、同じ頼みの画像は使い回し、頼みを積み重ねる', async () => {
  const s = setup();
  const first = await create(s.ctx(), { ...structuredClone(PLAN), request: '最初の頼み' });
  s.generated.length = 0;
  const changed = structuredClone(PLAN);
  changed.slides[0]!.imagePrompt = '整理された書棚';
  const out = await create(s.ctx(), { ...changed, deckId: first['deckId'], request: '区切りの画像を変えて' });
  assert.equal(out['deckId'], first['deckId'], '同じスライドとして覚える');
  assert.equal(out['rebuilt'], true);
  const call = s.fake.calls.created[1]!;
  assert.equal(call.rebuild, 'DECK1', '同じファイルを作り直す');
  assert.deepEqual(call.reuseImages, { cover: 'cover' }, '表紙は前の画像を使い回す');
  assert.deepEqual(s.generated.map((p) => p.split('。')[0]), ['整理された書棚'], '変えた画像だけ作る');
  const deck = (await s.store.get('t', String(out['deckId'])))!;
  assert.equal(deck.request, '最初の頼み\n直す頼み: 区切りの画像を変えて');
  assert.deepEqual(deck.imagePrompts, { cover: '朝の光が差す整った机', m2slide1: '整理された書棚' });
});

test('slides.create: 人が Google スライドで手を入れた後なら上書きせず、新しいファイルに作る', async () => {
  const s = setup();
  const first = await create(s.ctx(), { ...structuredClone(PLAN) });
  s.fake.state.get('DECK1')!.modifiedTime = new Date(Date.now() + 10 * 60_000).toISOString();
  const out = await create(s.ctx(), { ...structuredClone(PLAN), deckId: first['deckId'], request: '5 ページに' });
  assert.notEqual(out['deckId'], first['deckId'], '別のスライドとして覚える');
  assert.equal(s.fake.calls.created[1]!.rebuild, undefined);
  assert.ok((out['warnings'] as string[]).some((w) => w.includes('手で直した跡')));
  assert.equal((await s.store.listMine('t', 'u', 10)).length, 2, '前のものも一覧に残す');
});

test('slides.create: ほかの人のスライドは直せない。ドライブに無ければ新しいファイルに作る', async () => {
  const s = setup();
  const first = await create(s.ctx(), { ...structuredClone(PLAN) });
  const other = await create(s.ctx('v'), { ...structuredClone(PLAN), deckId: first['deckId'] });
  assert.match(String(other['error']), /作った人だけ/);
  s.fake.state.delete('DECK1');
  const out = await create(s.ctx(), { ...structuredClone(PLAN), deckId: first['deckId'] });
  assert.equal(out['deckId'], first['deckId']);
  assert.equal(s.fake.calls.created.at(-1)!.rebuild, undefined);
  assert.ok((out['warnings'] as string[]).some((w) => w.includes('見つからなかった')));
});

test('共有: 会社の Workspace のドメインへの閲覧だけ。ドメインを確かめられなければ共有しない（境界 2）', async () => {
  const s = setup();
  const made = await create(s.ctx(), { ...structuredClone(PLAN) });
  const id = String(made['deckId']);
  const shared = await s.service.share({ tenantId: 't', userId: 'u' }, id, 'company');
  assert.ok(!('error' in shared) && shared.sharing === 'company');
  assert.deepEqual(s.fake.calls.shared, [{ id: 'DECK1', domain: 'example.co.jp' }]);
  // ほかの人には一覧の「会社で共有」に出て、読める。直す・共有・削除はできない
  const listed = await s.service.list({ tenantId: 't', userId: 'v' });
  assert.deepEqual(listed.shared.map((d) => [d.title, d.ownerName, d.mine]), [['新しい道具の導入', '見本 太郎', false]]);
  assert.ok(await s.service.get({ tenantId: 't', userId: 'v' }, id));
  assert.ok('error' in await s.service.share({ tenantId: 't', userId: 'v' }, id, 'private'));
  assert.equal(await s.service.remove({ tenantId: 't', userId: 'v' }, id), 'スライドが見つかりません');
  // 自分だけに戻す
  const back = await s.service.share({ tenantId: 't', userId: 'u' }, id, 'private');
  assert.ok(!('error' in back) && back.sharing === 'private');
  assert.deepEqual(s.fake.calls.shared.at(-1), { id: 'DECK1', domain: null });
  assert.equal(await s.service.get({ tenantId: 't', userId: 'v' }, id), null, '自分だけのものは、ほかの人は読めない');

  // 作った人のアカウントが会社のドメインでない・会社のドメインが無い
  const g = await create(s.ctx('g'), { ...structuredClone(PLAN) });
  const refused = await s.service.share({ tenantId: 't', userId: 'g' }, String(g['deckId']), 'company');
  assert.ok('error' in refused && refused.error.includes('会社のドメイン'));
  const none = setup(null);
  const m = await create(none.ctx(), { ...structuredClone(PLAN) });
  const r2 = await none.service.share({ tenantId: 't', userId: 'u' }, String(m['deckId']), 'company');
  assert.ok('error' in r2 && r2.error.includes('ドメインが決まっていない'));
  assert.equal(none.fake.calls.shared.length, 0);
});

test('slides.share: 会社の中の共有は write-internal。会社で共有の言葉で切り替える', async () => {
  const s = setup();
  const made = await create(s.ctx(), { ...structuredClone(PLAN) });
  const tool = registry.get('slides.share')!;
  assert.equal(tool.risk, 'write-internal');
  const out = await tool.invoke({ deckId: made['deckId'], sharing: '会社で共有' }, s.ctx()) as Record<string, unknown>;
  assert.equal(out['sharing'], '会社で共有');
  const list = await registry.get('slides.list')!.invoke({}, s.ctx()) as { mine: { id: string; sharing: string }[] };
  assert.deepEqual(list.mine.map((d) => d.sharing), ['会社で共有']);
  const got = await registry.get('slides.get')!.invoke({ deckId: made['deckId'] }, s.ctx()) as { plan: { title: string }; mine: boolean };
  assert.equal(got.plan.title, '新しい道具の導入');
  assert.equal(got.mine, true);
});

test('削除: ファイルはドライブのごみ箱へ移し、一覧から消す。ドライブで先に消されていても一覧から消せる', async () => {
  const s = setup();
  const a = await create(s.ctx(), { ...structuredClone(PLAN) });
  const b = await create(s.ctx(), { ...structuredClone(PLAN) });
  assert.equal(await s.service.remove({ tenantId: 't', userId: 'u' }, String(a['deckId'])), null);
  assert.deepEqual(s.fake.calls.trashed, ['DECK1']);
  s.fake.state.delete('DECK2');
  assert.equal(await s.service.remove({ tenantId: 't', userId: 'u' }, String(b['deckId'])), null);
  assert.equal((await s.service.list({ tenantId: 't', userId: 'u' })).mine.length, 0);
});

test('置き場: 会社をまたいで読めない・書けない', async () => {
  const store = new InMemorySlideDeckStore();
  const deck: SlideDeck = {
    id: 'd1', tenantId: 't', userId: 'u', presentationId: 'P', title: 'x', design: null, template: null, theme: null, sharing: 'company', request: '',
    plan: { title: 'x', slides: [] }, imagePrompts: {}, runId: null, builtAt: '2026-10-25T00:00:00.000Z', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
  };
  await store.save(deck);
  assert.equal(await store.get('other', 'd1'), null);
  assert.deepEqual(await store.listShared('other', 'z', 10), []);
  await store.save({ ...deck, tenantId: 'other', title: '書き換え' });
  assert.equal((await store.get('t', 'd1'))!.title, 'x');
  await store.remove('other', 'd1');
  assert.ok(await store.get('t', 'd1'));
});
