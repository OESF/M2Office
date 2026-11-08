/**
 * @file 資料のつながり（第44.17.1節。段 5）のテスト。5 つの決まりと強さ・一般的すぎる語と大きすぎるフォルダを除くこと・
 * 取引先が同じだけでは線にしないこと・本人の資料だけをつなぐこと・関連する資料の理由・グラフの点と線・ローカルグラフ・秘書のツールに添えること。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type LibraryItem } from '@m2office/shared';
import {
  LIBRARY_TOOLS, LibraryService, MemoryFileStore, MemoryLibraryStore, MockWorkspaceConnector, graphOf, libraryLinks, libraryLinkReason, silentLogger,
  type LibraryLinkInput, type LibraryViewer, type LlmProvider, type Repository,
} from '../src/index.js';

let seq = 0;
/** 見本の資料（つながりの材料）。 */
function item(over: Partial<LibraryLinkInput> & { id?: string } = {}): LibraryLinkInput {
  seq += 1;
  const base: LibraryItem = {
    id: over.id ?? `lib-${seq}`, ownerId: 'u1', driveFileId: `d${seq}`, driveUrl: null, placed: true, originalName: `${seq}.pdf`, format: 'pdf', mime: 'application/pdf', sizeBytes: 1,
    entry: 'pc', title: `資料 ${seq}`, docType: '', counterparty: '', contactId: null, docDate: null, receivedAt: `2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T00:00:00.000Z`,
    summary: '', keywords: [], readState: 'done', readNote: '', readScope: '', edited: [], shareScope: 'self', knowledgeId: null, verifiedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
  return { ...base, messageIds: [], folders: [], ...over } as LibraryLinkInput;
}
const kindOf = (links: ReturnType<typeof libraryLinks>, a: string, b: string) => links.get(a)?.find((l) => l.id === b) ?? null;

test('つながりの 5 つの決まりと強さ（Q-314）。強いほうを取る', () => {
  const filler = Array.from({ length: 10 }, () => item());
  const mailA = item({ id: 'm-a', messageIds: ['gm-1'] });
  const mailB = item({ id: 'm-b', messageIds: ['gm-1', 'gm-2'] });
  const v1 = item({ id: 'v-1', title: 'A 社 見積書', counterparty: 'A 社', docType: '見積' });
  const v2 = item({ id: 'v-2', title: 'A 社 見積書', counterparty: 'A 社', docType: '見積' });
  const p1 = item({ id: 'p-1', counterparty: 'サンプル商事', keywords: ['サーバー保守', '監視'] });
  const p2 = item({ id: 'p-2', counterparty: 'サンプル商事', keywords: ['サーバー保守', '監視', 'バックアップ'] });
  const p3 = item({ id: 'p-3', counterparty: 'サンプル商事', keywords: ['倉庫'] });
  const w1 = item({ id: 'w-1', counterparty: 'B 社', keywords: ['棚卸', '修理'] });
  const w2 = item({ id: 'w-2', counterparty: 'C 社', keywords: ['棚卸', '修理'] });
  const w3 = item({ id: 'w-3', keywords: ['棚卸'] });
  const f1 = item({ id: 'f-1', folders: ['2026/提案'] });
  const f2 = item({ id: 'f-2', folders: ['2026/提案'] });
  const links = libraryLinks([...filler, mailA, mailB, v1, v2, p1, p2, p3, w1, w2, w3, f1, f2]);
  assert.deepEqual(kindOf(links, 'm-a', 'm-b'), { id: 'm-b', kind: 'mail', strength: 4, shared: [] });
  assert.equal(kindOf(links, 'v-1', 'v-2')?.kind, 'version');
  assert.deepEqual(kindOf(links, 'p-1', 'p-2'), { id: 'p-2', kind: 'project', strength: 3, shared: ['サーバー保守', '監視'] }, '重なる語 2 つで 2 + 1');
  assert.equal(kindOf(links, 'p-1', 'p-3'), null, '取引先が同じだけでは線にしない');
  assert.deepEqual(kindOf(links, 'w-1', 'w-2'), { id: 'w-2', kind: 'words', strength: 1, shared: ['棚卸', '修理'] });
  assert.equal(kindOf(links, 'w-1', 'w-3'), null, '取引先が違えば、語が 2 つ以上重ならないとつながらない');
  assert.equal(kindOf(links, 'f-1', 'f-2')?.kind, 'folder');
  assert.equal(libraryLinkReason(kindOf(links, 'p-1', 'p-2')!), '同じ取引先の同じ案件（サーバー保守・監視）');
  assert.equal(libraryLinkReason(kindOf(links, 'm-a', 'm-b')!), '同じメールで届いた');
  // 強い順に並ぶ
  const both = item({ id: 'x-1', messageIds: ['gm-9'], counterparty: 'D 社', keywords: ['保守', '点検'] });
  const both2 = item({ id: 'x-2', messageIds: ['gm-9'], counterparty: 'D 社', keywords: ['保守', '点検'] });
  const weak = item({ id: 'x-3', folders: ['x'] });
  const weak2 = item({ id: 'x-4', folders: ['x'], messageIds: [] });
  const again = libraryLinks([...filler, both, both2, weak, weak2]);
  assert.equal(kindOf(again, 'x-1', 'x-2')?.kind, 'mail', '同じ組に 2 つのつながりがあれば強いほう');
});

test('一般的すぎる語と、大きすぎるフォルダはつながりにしない', () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ id: `c-${i}`, counterparty: 'E 社', keywords: ['見積', i < 2 ? '特別案件' : `品${i}`] }));
  const links = libraryLinks(many);
  assert.equal(kindOf(links, 'c-0', 'c-1')?.shared.join(), '特別案件', '全部に出る「見積」は数えない');
  assert.equal(kindOf(links, 'c-2', 'c-3'), null);
  const folder = Array.from({ length: 31 }, (_, i) => item({ id: `big-${i}`, folders: ['ダウンロード'] }));
  assert.equal(libraryLinks(folder).get('big-0')!.length, 0, '30 件を超えるフォルダは除く');
});

test('グラフ: 取引先を点にしてその資料を細い線で集め、描く資料の間の線だけを使う', () => {
  const a = item({ id: 'g-a', counterparty: 'サンプル商事', keywords: ['保守', '監視'] });
  const b = item({ id: 'g-b', counterparty: 'サンプル商事', keywords: ['保守'] });
  const c = item({ id: 'g-c', counterparty: '', keywords: [] });
  const links = libraryLinks([a, b, c, ...Array.from({ length: 6 }, () => item())]);
  const g = graphOf([a, b], links);
  const party = g.nodes.find((n) => n.kind === 'party')!;
  assert.equal(party.label, 'サンプル商事');
  assert.equal(party.degree, 2);
  assert.deepEqual(g.links.filter((l) => l.kind === 'party').map((l) => l.target).sort(), ['g-a', 'g-b']);
  assert.equal(g.links.filter((l) => l.kind === 'project').length, 1);
  assert.ok(!g.nodes.some((n) => n.id === 'g-c'), '描かない資料は入れない');
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
  const llm = { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  const service = new LibraryService({ store, repo, files: new MemoryFileStore(), drive: connector.drive as never, logger: silentLogger, llmFor: async () => llm, readerState: async () => 'ok' });
  return { store, service };
}

async function put(env: ReturnType<typeof setup>, who: LibraryViewer, name: string, fields: { counterparty?: string; keywords?: string[]; docType?: string }) {
  const r = await env.service.importFile(who, { name, bytes: new TextEncoder().encode(`${name} の中身`), folder: '' });
  assert.ok('item' in r);
  await env.store.finishRead(who.tenantId, r.item.id, { readState: 'done', readNote: '', readScope: '', title: name, docType: fields.docType ?? '見積', counterparty: fields.counterparty ?? '', summary: '', keywords: fields.keywords ?? [] });
  return r.item.id;
}

test('関連する資料・グラフ・ローカルグラフは本人の資料だけ。目録が変わったら計算し直す。秘書の答えにも添える', async () => {
  const env = setup();
  const est = await put(env, A, '見積.txt', { counterparty: 'サンプル商事', keywords: ['サーバー保守'] });
  const con = await put(env, A, '契約.txt', { counterparty: 'サンプル商事', keywords: ['サーバー保守'], docType: '契約書' });
  for (let i = 0; i < 4; i++) await put(env, A, `ほか${i}.txt`, { keywords: [`語${i}`] });
  const other = await put(env, B, '他人の見積.txt', { counterparty: 'サンプル商事', keywords: ['サーバー保守'] });

  const rel = await env.service.related(A, est, 8);
  assert.deepEqual(rel.map((r) => [r.id, r.kind, r.reason]), [[con, 'project', '同じ取引先の同じ案件（サーバー保守）']]);
  assert.ok(!rel.some((r) => r.id === other), '他人の資料とはつながない');
  assert.deepEqual(await env.service.related(A, other, 8), [], '他人の資料の関連は返さない');

  const g = await env.service.graph(A, { q: '契約' });
  assert.equal(g.shown, 6);
  assert.ok(!g.nodes.some((n) => n.id === other));
  assert.deepEqual(g.matched, [con], '言葉は絞り込まず、当たる資料を光らせる');
  const narrowed = await env.service.graph(A, { docType: '契約書' });
  assert.equal(narrowed.total, 1);

  const local = await env.service.localGraph(A, est);
  assert.deepEqual(local?.nodes.filter((n) => n.kind === 'item').map((n) => n.id).sort(), [est, con].sort());
  assert.equal(await env.service.localGraph(A, other), null);

  // 目録が変わったら計算し直す
  const third = await put(env, A, '請求.txt', { counterparty: 'サンプル商事', keywords: ['サーバー保守'], docType: '請求書' });
  assert.ok((await env.service.related(A, est, 8)).some((r) => r.id === third));

  const search = LIBRARY_TOOLS.find((t) => t.name === 'library.search')!;
  const out = await search.invoke({ query: '見積' }, { tenantId: 't1', userId: 'u1', library: { service: env.service, access: async () => ({ enabled: true }) } } as never) as { items: { id: string; related?: { title: string; reason: string }[] }[] };
  const hit = out.items.find((i) => i.id === est);
  assert.ok(hit?.related?.some((r) => r.title === '契約.txt' && r.reason.includes('サーバー保守')), '上位の資料に関連する資料を添える');
});
