/**
 * @file コラムの作成の段 2 の単体テスト（仕様書 第32.18.4節）。予定表の回・テーマ案（材料・重ならない・書き直しの案・知らせ）・
 * テーマ案から書く・先回りと飛ばす回・予約（承認の後に待ち、その日時に入れる・承認の後に直したら入れない）・取り下げ・
 * 貼るだけのページ・似すぎの確かめ・ツール。記憶だけの置き場と見本の推論・調べもので確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type Notification, type TenantSettings, type WebColumnSettings } from '@m2office/shared';
import {
  ColumnService, ColumnPlanner, MemoryColumnStore, MemoryFileStore, StubLlmProvider, MockResearchProvider, COLUMN_TOOLS,
  monthSlots, plainThemes, writeThemes, overlapRatio, similarityReview, slotTime,
  type ColumnThemeMaterials, type PageFetcher, type Repository, type ToolContext,
} from '../src/index.js';

function setup(opts: { columns?: Partial<WebColumnSettings>; materials?: ColumnThemeMaterials } = {}) {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '見本株式会社', shortName: '見本' },
    webColumns: { ...DEFAULT_TENANT_SETTINGS.webColumns, enabled: true, topics: ['歯みがき'], ...opts.columns },
  };
  const notes: Notification[] = [];
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  const users = [
    { id: 'boss', roles: ['admin'], status: 'active', displayName: '責任者' },
    { id: 'ok', roles: ['approver'], status: 'active', displayName: '承認者' },
    { id: 'u1', roles: ['member'], status: 'active', displayName: '担当' },
    { id: 'u2', roles: ['member'], status: 'active', displayName: 'ほかの人' },
  ];
  const fileMetas = new Map<string, unknown>();
  const repo = {
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    createFile: async (f: { id: string }) => { fileMetas.set(f.id, f); },
    getFile: async (_t: string, id: string) => fileMetas.get(id) ?? null,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    listUserGroupIds: async () => [],
    listUsers: async () => users,
    listTenantIds: async () => ['t1'],
    findTenantById: async () => null,
    getRun: async () => null,
    getTenantCredential: async () => null,
    getUserSettings: async () => ({ notifications: { kinds: { column: true } } }),
    createNotification: async (n: Notification) => { notes.push(n); },
    appendAudit: async (e: { action: string; detail: Record<string, unknown> }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryColumnStore();
  const service = new ColumnService({
    store, repo, files: new MemoryFileStore(), box: { encrypt: (s: string) => s, decrypt: (s: string) => s } as never,
    llmFor: async () => new StubLlmProvider(), researchFor: async () => new MockResearchProvider(),
  });
  const planner = new ColumnPlanner({ service, store, repo, llmFor: async () => null, ...(opts.materials ? { materials: opts.materials } : {}) });
  return { service, planner, store, notes, audits, settings: () => settings };
}

const who = { tenantId: 't1', userId: 'u1' };
/** 書き上がるまで待つ（書き上げは裏で進む）。 */
async function settled(store: MemoryColumnStore, id: string) {
  for (let i = 0; i < 100; i++) {
    const c = await store.get('t1', id);
    if (c && c.status !== 'writing') return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('書き上がらない');
}

test('予定表の回: 月に 1 本は最初の曜日、2 本は 1 回目と 3 回目、毎週はすべて（公開は 9 時）', () => {
  assert.deepEqual(monthSlots({ perMonth: 1, weekday: 3 }, '2026-10'), ['2026-10-07']);
  assert.deepEqual(monthSlots({ perMonth: 2, weekday: 3 }, '2026-10'), ['2026-10-07', '2026-10-21']);
  assert.deepEqual(monthSlots({ perMonth: 4, weekday: 3 }, '2026-10'), ['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28']);
  assert.equal(slotTime('2026-10-07'), '2026-10-07T00:00:00.000Z');
});

test('テーマ案（推論なし）: 検索の言葉・よく来る質問・競合の話題・季節から作り、出したものと重ねない。分野が無ければ作らない', async () => {
  const m = { topics: ['歯みがき'], audience: '', today: '2026-10-04', searchWords: ['冬 乾燥 対策'], competitorThemes: ['自社の強みのご紹介'], questions: ['子どもの歯みがきの始め方'], existing: ['子どもの歯みがきの始め方'] };
  const t = plainThemes(m, 5);
  assert.deepEqual(t.map((x) => x.source), ['search', 'competitor', 'season']);
  assert.ok(!t.some((x) => x.theme === '子どもの歯みがきの始め方'), '出したものと同じ問いは出さない');
  assert.deepEqual(await writeThemes(null, { ...m, topics: [] }, 5), []);
});

test('テーマ案の作成: 材料から作り、書き直しの案を足し、管理者・承認者・書いた人に知らせる。もう一度作っても同じ案を重ねない', async () => {
  const { planner, service, store, notes, settings, audits } = setup({ materials: {
    searchWords: async () => ['冬 乾燥 対策'], questions: async () => ['仕上げみがきのコツ'], competitorThemes: async () => [],
    rewrites: async () => [{ columnId: 'col-x', theme: '「春のコラム」の書き直し', why: 'この 3 か月に見られた回数が半分未満です' }],
  } });
  const c = await service.create(who, { theme: '前に書いたテーマ' }, true);
  const r = await planner.generateThemes('t1', 'u1', new Date('2026-10-05T00:00:00Z'));
  assert.ok('added' in r);
  if (!('added' in r)) return;
  assert.ok(r.added.some((t) => t.source === 'search') && r.added.some((t) => t.source === 'question'));
  assert.ok(r.added.some((t) => t.source === 'rewrite' && t.columnId === 'col-x'));
  assert.ok(settings().webColumns.themesAt);
  assert.deepEqual([...new Set(notes.map((n) => n.userId))].sort(), ['boss', 'ok', 'u1'], 'この 90 日に書いていない人には知らせない');
  assert.ok(audits.some((a) => a.action === 'column.themes'));
  const again = await planner.generateThemes('t1', 'u1');
  assert.ok('added' in again && again.added.every((t) => !r.added.some((x) => x.theme === t.theme)), '同じ案を重ねない');
  assert.ok(c);
  // 案から書く: 案は使ったにし、なぜ今かをリクエストにする
  const search = r.added.find((t) => t.source === 'search')!;
  const w = await planner.writeFromTheme(who, search.id);
  assert.ok('columnId' in w);
  if ('columnId' in w) assert.equal((await settled(store, w.columnId)).memo, search.why);
  assert.ok(!(await planner.themes('t1')).some((t) => t.id === search.id));
  assert.equal(await planner.dismissTheme(who, search.id), 'テーマ案が見つかりません');
});

test('先回りと飛ばす回: 7 日前の空いている回にテーマ案で書き始め、承認されないまま公開の日時を過ぎたら飛ばす', async () => {
  const now = new Date('2026-10-05T00:00:00Z'); // 月曜
  const { planner, store, notes, audits } = setup({ columns: { plan: { perMonth: 4, weekday: 3 } } });
  const r = await planner.tick(now);
  assert.equal(r.prepared, 1, '10 月 7 日の回だけ（7 日のうち）');
  const slot = (await planner.plan('t1', now)).find((s) => s.date === '2026-10-07')!;
  assert.ok(slot.columnId);
  const c = await settled(store, slot.columnId!);
  assert.equal(c.plannedFor, '2026-10-07');
  assert.equal(c.publishAt, slotTime('2026-10-07'));
  assert.ok(notes.some((n) => /10 月 7 日のコラムの下書き/.test(n.title)));
  assert.ok(audits.some((a) => a.action === 'column.prepare'));
  assert.ok(r.themes >= 1, '月曜の 6 時を過ぎたらテーマ案を作る');
  // 公開の日時を過ぎても承認されていなければ飛ばす（下書きは残す）
  const later = await planner.tick(new Date('2026-10-07T01:00:00Z'));
  assert.equal(later.skipped, 1);
  const after = (await store.get('t1', slot.columnId!))!;
  assert.equal(after.plannedFor, null);
  assert.equal(after.status, 'draft');
  assert.ok(notes.some((n) => /10 月 7 日のコラムの回を飛ばしました/.test(n.title)));
});

test('予約: 承認の後に日時が先なら予約にして待ち、その日時に入れる。承認の後に直したら入れない。取り下げると貼るだけのページから外す', async () => {
  const { service, planner, store, notes, settings } = setup();
  const c = await service.create(who, { theme: '予約のテーマ' }, true);
  if (!('id' in c)) throw new Error('書けない');
  const at = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(await service.setPublishAt(who, c.id, new Date(Date.now() - 1000).toISOString()), '公開の日時は、これからの日時にしてください');
  assert.equal(await service.setPublishAt(who, c.id, at), null);
  const p = (await service.preview(who, c.id))!;
  assert.equal(p.publishAt, at);
  assert.match(p.destination, /予約/);
  const placed = await service.place(who, c.id, p.digest);
  assert.ok('scheduledAt' in placed && placed.scheduledAt === at);
  assert.equal((await store.get('t1', c.id))!.status, 'scheduled');
  assert.equal(await service.setPublishAt(who, c.id, null), '下書きのときだけ、公開の日時を変えられます');
  // まだ日時の前なら入れない
  assert.equal((await planner.tick(new Date())).placed, 0);
  // 貼るだけのページを入れる
  const { key } = await planner.enablePage({ tenantId: 't1', userId: 'boss' });
  store.pageKeys.set(key, 't1');
  assert.equal((await planner.pageByKey(key))!.columns.length, 0, '予約の間は出さない');
  const r = await planner.tick(new Date(Date.parse(at) + 1000));
  assert.equal(r.placed, 1);
  assert.equal((await store.get('t1', c.id))!.status, 'approved', 'WordPress が無ければ承認済み（貼るだけのページに出る）');
  assert.ok(notes.some((n) => /予約のコラム「.*」を出しました/.test(n.title)));
  const page = (await planner.pageByKey(key, new Date(Date.parse(at) + 2000)))!;
  assert.equal(page.columns.length, 1);
  assert.match(page.columns[0]!.html, /<h|<p/);
  assert.equal(page.company, '見本');
  assert.equal(await planner.pageByKey('x'.repeat(32)), null, '鍵が違えば無い');
  // 取り下げる
  assert.equal(await service.withdraw(who, c.id), null);
  assert.equal((await planner.pageByKey(key))!.columns.length, 0);
  await planner.disablePage({ tenantId: 't1', userId: 'boss' });
  assert.equal(settings().webColumns.pastePage, null);
  assert.equal(await planner.pageByKey(key), null, '止めたらすぐ無い');
  // 承認の後に直したら、日時が来ても入れない
  const d = await service.create(who, { theme: '直されるテーマ' }, true);
  if (!('id' in d)) throw new Error('書けない');
  const at2 = new Date(Date.now() + 3_600_000).toISOString();
  await service.setPublishAt(who, d.id, at2);
  await service.place(who, d.id, (await service.preview(who, d.id))!.digest);
  await store.update('t1', d.id, { publishAt: new Date(Date.now() + 7_200_000).toISOString() });
  await planner.tick(new Date(Date.parse(at2) + 7_300_000));
  assert.equal((await store.get('t1', d.id))!.status, 'draft');
  assert.ok(notes.some((n) => /入れられませんでした/.test(n.title)));
});

test('似すぎ: 出典の文と 10 字のまとまりの 7 割以上が重なる文を指摘し、読めない出典は確かめない', async () => {
  const src = '歯みがきは一日に二回、やわらかい歯ブラシで小さく動かしながら、一本ずつ丁寧にみがくことが勧められています。';
  assert.ok(overlapRatio(src, src) > 0.9);
  assert.ok(overlapRatio('まったく違う話題について、自分の言葉で書いた文章をここに置いています。', src) < 0.2);
  const fetcher: PageFetcher = {
    delayMs: 0,
    get: async (url) => {
      if (url.endsWith('/robots.txt')) return { url, status: 404, contentType: 'text/plain', text: '' };
      if (url.includes('down')) throw new Error('届かない');
      return { url, status: 200, contentType: 'text/html', text: `<html><body><p>${src}</p></body></html>` };
    },
  };
  const body = `## みがき方\n${src}\nうちでは、仕上げみがきの時間を短くする工夫を伝えています。お子さんが嫌がらないように声をかけます。`;
  const items = await similarityReview(body, [{ title: '手引き', url: 'https://example.jp/guide' }, { title: '止まっている', url: 'https://down.example.jp/' }], fetcher);
  assert.equal(items.length, 1);
  assert.match(items[0]!.reason, /出典（手引き）の文とほぼ同じです/);
  assert.equal(items[0]!.kind, 'source');
  assert.deepEqual(await similarityReview(body, [{ title: '止まっている', url: 'https://down.example.jp/' }], fetcher), []);
});

test('ツール: テーマ案と予定表を返し、本数を言われたらテーマ案で書き始めて空いている回に入れる', async () => {
  const { service, planner, store } = setup({ columns: { plan: { perMonth: 4, weekday: 3 } } });
  const ctx = (withPlanner: boolean) => ({ tenantId: 't1', userId: 'u1', columns: { service, access: async () => ({ enabled: true }), ...(withPlanner ? { planner } : {}) } }) as unknown as ToolContext;
  const tool = (name: string) => COLUMN_TOOLS.find((t) => t.name === name)!;
  assert.equal((await tool('columns.themes').invoke({}, ctx(false)) as { available: boolean }).available, false);
  const made = await tool('columns.prepare').invoke({}, ctx(true)) as { available: boolean; themes: unknown[] };
  assert.ok(made.available && made.themes.length >= 1);
  const prepared = await tool('columns.prepare').invoke({ count: 1 }, ctx(true)) as { available: boolean; columns: { plannedFor: string | null }[] };
  assert.equal(prepared.columns.length, 1);
  assert.ok(prepared.columns[0]!.plannedFor, '予定表の空いている回に入れる');
  const listed = await tool('columns.themes').invoke({}, ctx(true)) as { plan: { status: string }[] };
  assert.ok(listed.plan.some((s) => s.status !== '空き'));
  assert.equal(tool('columns.prepare').risk, 'write-internal');
  for (const c of await store.list('t1')) await settled(store, c.id);
});
