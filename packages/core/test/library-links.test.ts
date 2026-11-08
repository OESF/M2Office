/**
 * @file 資料のつながり（第44.17.1節。段 5）のテスト。5 つの決まりと強さ・一般的すぎる語と大きすぎるフォルダを除くこと・
 * 取引先が同じだけでは線にしないこと・本人の資料だけをつなぐこと・関連する資料の理由・グラフの点と線・ローカルグラフ・秘書のツールに添えること。
 * タグ（第44.17.3節）: 取引先・案件・種類を区別しない同じタグのつながり・グラフのタグの点・名前のそろえ方・付け直し・タグでの絞り込み・人が直した値を守ること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type LibraryItem } from '@m2office/shared';
import {
  LIBRARY_TOOLS, LibraryService, MemoryFileStore, MemoryLibraryStore, MockWorkspaceConnector, alignLibraryTags, graphOf, libraryLinks, libraryLinkReason, libraryTagList,
  libraryItemTags, parseReadingFields, parseRetagFields, silentLogger,
  type LibraryLinkInput, type LibraryViewer, type LlmProvider, type Repository,
} from '../src/index.js';

let seq = 0;
/** 見本の資料（つながりの材料）。 */
function item(over: Partial<LibraryLinkInput> & { id?: string } = {}): LibraryLinkInput {
  seq += 1;
  const base: LibraryItem = {
    id: over.id ?? `lib-${seq}`, ownerId: 'u1', driveFileId: `d${seq}`, driveUrl: null, placed: true, originalName: `${seq}.pdf`, format: 'pdf', mime: 'application/pdf', sizeBytes: 1,
    entry: 'pc', title: `資料 ${seq}`, docType: '', counterparty: '', contactId: null, tags: [], docDate: null, receivedAt: `2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T00:00:00.000Z`,
    summary: '', keywords: [], readState: 'done', readNote: '', readScope: '', edited: [], shareScope: 'self', knowledgeId: null, verifiedAt: null, viewedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
  return { ...base, messageIds: [], folders: [], ...over } as LibraryLinkInput;
}
const kindOf = (links: ReturnType<typeof libraryLinks>, a: string, b: string) => links.get(a)?.find((l) => l.id === b) ?? null;

test('つながりの決まりと強さ（Q-314・Q-316）。強いほうを取る', () => {
  const filler = Array.from({ length: 10 }, () => item());
  const mailA = item({ id: 'm-a', messageIds: ['gm-1'] });
  const mailB = item({ id: 'm-b', messageIds: ['gm-1', 'gm-2'] });
  const v1 = item({ id: 'v-1', title: 'A 社 見積書', counterparty: 'A 社', docType: '見積' });
  const v2 = item({ id: 'v-2', title: 'A 社 見積書', counterparty: 'A 社', docType: '見積' });
  const w1 = item({ id: 'w-1', counterparty: 'B 社', keywords: ['棚卸', '修理'] });
  const w2 = item({ id: 'w-2', counterparty: 'C 社', keywords: ['棚卸', '修理'] });
  const w3 = item({ id: 'w-3', keywords: ['棚卸'] });
  const f1 = item({ id: 'f-1', folders: ['2026/提案'] });
  const f2 = item({ id: 'f-2', folders: ['2026/提案'] });
  const links = libraryLinks([...filler, mailA, mailB, v1, v2, w1, w2, w3, f1, f2]);
  assert.deepEqual(kindOf(links, 'm-a', 'm-b'), { id: 'm-b', kind: 'mail', strength: 4, shared: [] });
  assert.equal(kindOf(links, 'v-1', 'v-2')?.kind, 'version');
  assert.deepEqual(kindOf(links, 'w-1', 'w-2'), { id: 'w-2', kind: 'words', strength: 1, shared: ['棚卸', '修理'] });
  assert.equal(kindOf(links, 'w-1', 'w-3'), null, '語は 2 つ以上重ならないとつながらない');
  assert.equal(kindOf(links, 'f-1', 'f-2')?.kind, 'folder');
  assert.equal(libraryLinkReason(kindOf(links, 'w-1', 'w-2')!), '同じ語が出てくる（棚卸・修理）');
  assert.equal(libraryLinkReason(kindOf(links, 'm-a', 'm-b')!), '同じメールで届いた');
  // 強い順に並ぶ
  const both = item({ id: 'x-1', messageIds: ['gm-9'], tags: ['D 社', '保守'] });
  const both2 = item({ id: 'x-2', messageIds: ['gm-9'], tags: ['D 社', '保守'] });
  const again = libraryLinks([...filler, both, both2]);
  assert.equal(kindOf(again, 'x-1', 'x-2')?.kind, 'mail', '同じ組に 2 つのつながりがあれば強いほう');
});

test('一般的すぎる語と、大きすぎるフォルダはつながりにしない', () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ id: `c-${i}`, keywords: ['見積', i < 2 ? '特別案件' : `品${i}`, i < 2 ? '二つ目' : `別${i}`] }));
  const links = libraryLinks(many);
  assert.equal(kindOf(links, 'c-0', 'c-1')?.shared.join(), '特別案件,二つ目', '全部に出る「見積」は数えない');
  assert.equal(kindOf(links, 'c-2', 'c-3'), null);
  const folder = Array.from({ length: 31 }, (_, i) => item({ id: `big-${i}`, folders: ['ダウンロード'] }));
  assert.equal(libraryLinks(folder).get('big-0')!.length, 0, '30 件を超えるフォルダは除く');
});

test('同じタグ（第44.17.3節）: 取引先・案件・種類を区別しない。少ない資料のタグは 2、ほかは 1 で足し、2 以上でつなぐ', () => {
  const filler = Array.from({ length: 30 }, () => item());
  const a = item({ id: 'a', tags: ['Aster', '議事録'] });
  const b = item({ id: 'b', tags: ['ａｓｔｅｒ', '認証'] });
  const c = item({ id: 'c', tags: ['サンプル建設', '見積'] });
  const d = item({ id: 'd', tags: ['サンプル建設', '工程表'] });
  const links = libraryLinks([...filler, a, b, c, d]);
  assert.deepEqual(kindOf(links, 'a', 'b'), { id: 'b', kind: 'tag', strength: 2, shared: ['Aster'] }, '正規化して同じタグは同じ。少ない資料のタグ 1 つで 2');
  assert.equal(kindOf(links, 'c', 'd')?.kind, 'tag', '取引先の名前のタグも、ほかのタグと同じに扱う');
  assert.equal(libraryLinkReason(kindOf(links, 'a', 'b')!), '同じタグ（Aster）');
  // 多くの資料に付くタグは 1 と数え、1 つだけではつながらない。2 つ重なればつながる
  const wide = Array.from({ length: 12 }, (_, i) => item({ id: `wd-${i}`, tags: ['議事録', ...(i < 2 ? ['週報'] : [])] }));
  const wl = libraryLinks([...filler, ...wide]);
  assert.equal(kindOf(wl, 'wd-2', 'wd-3'), null, '12 件に付くタグ 1 つでは弱い');
  assert.equal(kindOf(wl, 'wd-0', 'wd-1')?.strength, 3, '多いタグ 1 と少ないタグ 2');
  // 資料の半分を超えて付くタグは数えない
  const half = Array.from({ length: 24 }, (_, i) => item({ id: `h-${i}`, tags: ['社内'] }));
  assert.equal(libraryLinks(half).get('h-0')!.length, 0);
});

test('グラフ: タグを同じ形の点にし、2 件以上に付いたものだけを出す。同じタグの資料どうしは線にしない', () => {
  const a = item({ id: 'h-a', tags: ['Aster', '認証'] });
  const b = item({ id: 'h-b', tags: ['Aster', '画面'], keywords: ['棚卸', '修理'] });
  const c = item({ id: 'h-c', tags: ['ひとつだけ'], keywords: ['棚卸', '修理'] });
  const links = libraryLinks([a, b, c, ...Array.from({ length: 6 }, () => item())]);
  const g = graphOf([a, b, c], links);
  const hub = g.nodes.find((n) => n.kind === 'tag')!;
  assert.equal(hub.label, 'Aster');
  assert.equal(hub.degree, 2);
  assert.deepEqual(g.links.filter((l) => l.hub).map((l) => l.target).sort(), ['h-a', 'h-b']);
  assert.ok(!g.nodes.some((n) => n.label === 'ひとつだけ' || n.label === '認証'), '1 件だけのタグは点にしない');
  assert.ok(!g.links.some((l) => !l.hub && l.kind === 'tag'), '同じタグは資料どうしの線にしない');
  assert.equal(g.links.filter((l) => !l.hub && l.kind === 'words').length, 1, 'ほかのつながりは線にする');
});

test('タグの整え方・名前のそろえ方・取引先と種類も同列のタグにする・AI の答えの読み方', () => {
  assert.deepEqual(libraryTagList('Aster、 設計 ,aster,#認証'), ['Aster', '設計', '認証']);
  assert.deepEqual(libraryTagList([1, ' ', 'A', 'B,C']), ['A', 'B C']);
  assert.deepEqual(libraryTagList(Array.from({ length: 12 }, (_, i) => `t${i}`)).length, 10);
  assert.deepEqual(alignLibraryTags(['ＡＳＴＥＲ', '新しいタグ'], ['Aster']), ['Aster', '新しいタグ']);
  assert.deepEqual(alignLibraryTags(['サンプル商事株式会社', '(株)テスト工業'], ['サンプル商事', 'テスト工業']), ['サンプル商事', 'テスト工業'], '会社の形の語は無視して見分ける');
  assert.deepEqual(libraryTagList(['株式会社', 'A 社', 'A社']), ['株式会社', 'A 社'], '会社の形の語だけのタグは残す');
  assert.deepEqual(libraryItemTags(['Aster', '認証'], { counterparty: 'サンプル 建設', docType: '議事録' }, ['サンプル建設']), ['Aster', '認証', 'サンプル建設', '議事録']);
  assert.deepEqual(libraryItemTags(['本社ビルの改修', 'サンプル建設'], { counterparty: 'サンプル建設株式会社 工事部', docType: '議事録' }, []), ['本社ビルの改修', 'サンプル建設', '議事録'], '部署つきの取引先は、会社のタグがあれば足さない');
  const f = parseReadingFields('{"title":"t","docType":"","counterparty":"","docDate":null,"summary":"","keywords":[],"tags":["Aster","Aster","認証"]}', '2026-11-08')!;
  assert.deepEqual(f.tags, ['Aster', '認証']);
  const r = parseRetagFields('答え {"items":[{"n":1,"tags":["X"]},{"n":9,"tags":["Y"]},{"n":"2","tags":"T"}]}', 2)!;
  assert.deepEqual([...r.entries()], [[1, ['X']], [2, ['T']]]);
  assert.equal(parseRetagFields('読めない', 2), null);
});

// ───────── 処理とツール ─────────

const A: LibraryViewer = { tenantId: 't1', userId: 'u1' };
const B: LibraryViewer = { tenantId: 't1', userId: 'u2' };

function setup() {
  const connector = new MockWorkspaceConnector(() => new Date('2026-11-08T00:00:00Z'));
  const store = new MemoryLibraryStore();
  const repo = {
    appendAudit: async () => undefined, getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, library: { enabled: true } }),
    listUserGroupIds: async () => [], listGroups: async () => [], findUserById: async () => null,
  } as unknown as Repository;
  const calls: string[] = [];
  const llm = { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  /** 付け直しの答えを返す AI（名前が m2 で始まる資料に、書き方のゆれた「ａｓｔｅｒ」と「認証」を返す）。 */
  const smart = {
    name: 'test', complete: async (req: { messages: { content: string }[] }) => {
      const user = req.messages.at(-1)!.content;
      calls.push(user);
      const items = [...user.matchAll(/\{"n":(\d+),"name":"([^"]*)"/g)].map((m) => ({ n: Number(m[1]), tags: m[2]!.startsWith('m2') ? ['ａｓｔｅｒ', '認証'] : ['認証'] }));
      return { text: JSON.stringify({ items }), tokensUsed: 10 };
    },
  } as unknown as LlmProvider;
  let current: LlmProvider = llm;
  const service = new LibraryService({ store, repo, files: new MemoryFileStore(), drive: connector.drive as never, logger: silentLogger, llmFor: async () => current, readerState: async () => 'ok' });
  return { store, service, calls, useSmart: () => { current = smart; } };
}

async function put(env: ReturnType<typeof setup>, who: LibraryViewer, name: string, fields: { counterparty?: string; keywords?: string[]; docType?: string; tags?: string[] }) {
  const r = await env.service.importFile(who, { name, bytes: new TextEncoder().encode(`${name} の中身`), folder: '' });
  assert.ok('item' in r);
  await env.store.finishRead(who.tenantId, r.item.id, {
    readState: 'done', readNote: '', readScope: '', title: name, docType: fields.docType ?? '見積', counterparty: fields.counterparty ?? '', summary: '', keywords: fields.keywords ?? [],
    ...(fields.tags ? { tags: fields.tags } : {}),
  });
  return r.item.id;
}

test('関連する資料・グラフ・ローカルグラフは本人の資料だけ。目録が変わったら計算し直す。秘書の答えにも添える', async () => {
  const env = setup();
  const est = await put(env, A, '見積.txt', { tags: ['サンプル商事', 'サーバー保守'] });
  const con = await put(env, A, '契約.txt', { tags: ['サンプル商事', 'サーバー保守'], docType: '契約書' });
  for (let i = 0; i < 4; i++) await put(env, A, `ほか${i}.txt`, { keywords: [`語${i}`] });
  const other = await put(env, B, '他人の見積.txt', { tags: ['サンプル商事', 'サーバー保守'] });

  const rel = await env.service.related(A, est, 8);
  assert.deepEqual(rel.map((r) => [r.id, r.kind, r.reason]), [[con, 'tag', '同じタグ（サンプル商事・サーバー保守）']]);
  assert.ok(!rel.some((r) => r.id === other), '他人の資料とはつながない');
  assert.deepEqual(await env.service.related(A, other, 8), [], '他人の資料の関連は返さない');

  const g = await env.service.graph(A, { q: '契約' });
  assert.equal(g.shown, 6);
  assert.ok(!g.nodes.some((n) => n.id === other));
  assert.deepEqual(g.matched, [con], '言葉は絞り込まず、当たる資料を光らせる');
  const narrowed = await env.service.graph(A, { tags: ['サンプル商事'] });
  assert.equal(narrowed.total, 2, 'タグで絞り込める');

  const local = await env.service.localGraph(A, est);
  assert.deepEqual(local?.nodes.filter((n) => n.kind === 'item').map((n) => n.id).sort(), [est, con].sort());
  assert.equal(await env.service.localGraph(A, other), null);

  // 目録が変わったら計算し直す
  const third = await put(env, A, '請求.txt', { tags: ['サンプル商事', 'サーバー保守'], docType: '請求書' });
  assert.ok((await env.service.related(A, est, 8)).some((r) => r.id === third));

  const search = LIBRARY_TOOLS.find((t) => t.name === 'library.search')!;
  const ctx = { tenantId: 't1', userId: 'u1', library: { service: env.service, access: async () => ({ enabled: true }) } } as never;
  const out = await search.invoke({ query: '見積' }, ctx) as { items: { id: string; tags?: string[]; related?: { title: string; reason: string }[] }[] };
  const hit = out.items.find((i) => i.id === est);
  assert.ok(hit?.related?.some((r) => r.title === '契約.txt' && r.reason.includes('サーバー保守')), '上位の資料に関連する資料を添える');
  assert.deepEqual(hit?.tags, ['サンプル商事', 'サーバー保守'], '秘書にもタグを返す');
  const byTag = await search.invoke({ tags: ['サーバー保守', 'サンプル商事'] }, ctx) as { total: number };
  assert.equal(byTag.total, 3, '秘書もタグで探せる（全部を持つもの）');
});

test('もう入っている資料にタグを付け直す（保存した項目だけ・20 件ずつ・名前をそろえる・取引先と種類も足す・人が直した値は守る）', async () => {
  const env = setup();
  const ids: string[] = [];
  for (let i = 0; i < 22; i++) ids.push(await put(env, A, `m2-${i}.txt`, { keywords: [`語${i}`], counterparty: i === 1 ? 'サンプル商事' : '' }));
  await env.store.update(A, ids[0]!, { tags: ['Aster'] });
  env.useSmart();
  assert.equal(await env.service.tick(['t1']), 20, '1 回の見回りで 20 件まで');
  assert.equal(env.calls.length, 1, '20 件をまとめて 1 回で頼む');
  assert.ok(env.calls[0]!.includes('これまでに付けたタグ（データ）: ["Aster"]'), 'もう使っているタグを渡す');
  assert.ok(!env.calls[0]!.includes('の中身'), '本文は渡さない');
  assert.equal(await env.service.tick(['t1']), 2);
  assert.equal(await env.service.tick(['t1']), 0, '付け終えたら頼まない');
  const all = await env.store.allOf('t1', 'u1');
  const byId = new Map(all.map((i) => [i.id, i]));
  assert.deepEqual(byId.get(ids[2]!)!.tags, ['Aster', '認証', '見積'], 'AI の書き方をもう使っているタグにそろえ、種類も同列のタグにする');
  assert.deepEqual(byId.get(ids[1]!)!.tags, ['Aster', '認証', 'サンプル商事', '見積'], '取引先も同列のタグにする');
  assert.deepEqual(byId.get(ids[0]!)!.tags, ['Aster'], '人が直したタグは書き換えない');

  // タグで絞り込める・選択肢に出る・言葉でも当たる
  assert.equal((await env.service.list(A, { tags: ['Aster'] })).total, 22);
  assert.equal((await env.service.list(A, { tags: ['Aster', 'サンプル商事'] })).total, 1, '全部を持つものに絞る');
  const facetTags = (await env.service.facets(A)).tags;
  assert.equal(facetTags[0], 'Aster', '多く付いたタグから並ぶ');
  assert.ok(facetTags.includes('認証') && facetTags.includes('サンプル商事'));
  assert.ok((await env.service.list(A, { q: '認証' })).items[0]!.why.some((w) => w.startsWith('タグ')));
  const g = await env.service.graph(A, {});
  assert.ok(g.nodes.some((n) => n.kind === 'tag' && n.label === 'Aster'));
});

test('タグを人が直す・秘書が直す。読み直すと付け直しの順番に戻る', async () => {
  const env = setup();
  const id = await put(env, A, 'a.txt', {});
  const r = await env.service.update(A, id, { tags: 'Aster、設計、#認証' });
  assert.ok(!('error' in r));
  assert.deepEqual(r.tags, ['Aster', '設計', '認証']);
  assert.ok(r.edited.includes('tags'));
  const tool = LIBRARY_TOOLS.find((t) => t.name === 'library.update')!;
  const out = await tool.invoke({ id, tags: ['本社ビルの改修'] }, { tenantId: 't1', userId: 'u1', library: { service: env.service, access: async () => ({ enabled: true }) } } as never) as { item: { tags: string[] } };
  assert.deepEqual(out.item.tags, ['本社ビルの改修']);
  await env.service.reread(A, id);
  assert.equal(env.store.rows.get(id)!.tagged, false);
});
