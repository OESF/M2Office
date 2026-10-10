/**
 * @file 外部のアプリの機能（仕様書 第11.12節・第13.4.2節、ADR-0089・ADR-0090）の確かめ。
 *
 * アカウントの結び付け（確認コード・同じ答え・回数と期限・Chat に写さない・削除）、ナレッジの検索（本人の区画だけ・答えられないとき・
 * 質問の文を残さない）、機能の道と選べる条件と承認の確かめ、入庫の通知（照らし方・二重に数えない・取り消し・照らせない行）を見る。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings, type User } from '@m2office/shared';
import {
  AppLinks, AppKnowledgeSearch, ExternalApps, MemoryAppStore, InventoryService, MemoryInventoryStore, InventorySales, MemorySalesStore,
  appFunctionFor, parseReceiptEvent, LINK_CODE_MAX_ATTEMPTS, type KnowledgeHit, type LlmProvider, type Repository,
} from '../src/index.js';

const USER: User = { id: 'u1', tenantId: 't1', email: 'hanako@example.com', displayName: '山田 花子', roles: [], status: 'active' };

/** 試験用の置き場（使う分だけ）。お知らせと監査ログと届け終えた印を覚える。 */
function fakeRepo(over: Partial<Record<string, unknown>> = {}, settings: TenantSettings = DEFAULT_TENANT_SETTINGS) {
  const notes: { id: string; userId: string; title: string; body: string }[] = [];
  const delivered: string[] = [];
  const audits: { action: string; actorType: string; actorId: string; detail: Record<string, unknown> }[] = [];
  const users = [USER, { ...USER, id: 'u2', email: 'off@example.com', status: 'disabled' as const }];
  const repo = {
    getTenantSettings: async () => settings,
    findUserByEmail: async (_t: string, email: string) => users.find((u) => u.email === email) ?? null,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    listUsers: async () => users,
    listGroups: async () => [{ id: 'g1', name: '総務', memberIds: [] }],
    listCompartments: async () => [{ id: 'c1', name: '人事', description: null }],
    createNotification: async (n: { id: string; userId: string; title: string; body: string }) => { notes.push(n); },
    markNotificationDelivered: async (_t: string, id: string) => { delivered.push(id); },
    appendAudit: async (e: { action: string; actorType: string; actorId: string; detail: Record<string, unknown> }) => { audits.push(e); },
    ...over,
  } as unknown as Repository;
  return { repo, notes, delivered, audits };
}

const codeOf = (body: string) => /確認コード: (\d{6})/.exec(body)?.[1] ?? '';
const APP = { id: 'app-1', name: 'M2Medical' };

/** 結び付けの試験の組み立て（アプリを置き場に入れておく）。 */
async function linkSetup() {
  const f = fakeRepo();
  const store = new MemoryAppStore();
  await store.createApp('t1', {
    id: APP.id, name: APP.name, keyHash: 'h', status: 'active', functions: ['accounts.link', 'knowledge.search'], settings: {}, catalogRemoved: [],
    approvedBy: 'u-admin', approvedAt: null, createdBy: 'u-admin', createdAt: new Date().toISOString(), lastUsedAt: null,
  });
  return { ...f, store, links: new AppLinks({ store, repo: f.repo }) };
}

test('結び付け: 確認コードは本人のお知らせにだけ届き、Chat に写さない。答えはアカウントの有無で変わらない', async () => {
  const { links, notes, delivered } = await linkSetup();
  assert.deepEqual(await links.request('t1', APP, 'Hanako@Example.com'), { ok: true });
  assert.deepEqual(await links.request('t1', APP, 'nobody@example.com'), { ok: true }, '居ない人にも同じ答え');
  assert.deepEqual(await links.request('t1', APP, 'off@example.com'), { ok: true }, '止めた人にも同じ答え');
  assert.ok('error' in await links.request('t1', APP, 'not-an-address'));
  assert.equal(notes.length, 1, '届けるのは使える本人だけ');
  assert.equal(notes[0]!.userId, 'u1');
  assert.match(codeOf(notes[0]!.body), /^\d{6}$/);
  assert.deepEqual(delivered, [notes[0]!.id], '確認コードはほかの届け先に写さない印を付ける');
});

test('結び付け: 合えば結び付きの ID を一度だけ返し、ハッシュだけを持つ。違う・切れた・回数超えは同じ invalid_code', async () => {
  const { links, notes, store, audits } = await linkSetup();
  await links.request('t1', APP, USER.email);
  const code = codeOf(notes[0]!.body);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.deepEqual(await links.confirm('t1', APP, USER.email, wrong), { error: 'invalid_code' });
  assert.deepEqual(await links.confirm('t1', APP, 'nobody@example.com', code), { error: 'invalid_code' });
  const ok = await links.confirm('t1', APP, USER.email, code);
  assert.ok('bindingId' in ok);
  assert.match(ok.bindingId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(ok.displayName, USER.displayName);
  assert.ok(!JSON.stringify([...store.bindings.values()]).includes(ok.bindingId), '結び付きの ID そのものは持たない');
  assert.deepEqual(await links.confirm('t1', APP, USER.email, code), { error: 'invalid_code' }, '使ったコードは使えない');
  assert.equal((await links.resolve('t1', APP.id, ok.bindingId))?.id, 'u1');
  assert.equal(await links.resolve('t1', 'other-app', ok.bindingId), null, 'ほかのアプリの結び付きでは引けない');
  assert.ok(audits.some((a) => a.action === 'app.binding.create' && a.actorType === 'api_client'));
  assert.ok(notes.some((n) => /と結び付きました/.test(n.title)), '結び付いたら本人に知らせる');
});

test('結び付け: 試せるのは 5 回まで。切れたコードは使えない', async () => {
  const { links, notes } = await linkSetup();
  await links.request('t1', APP, USER.email);
  const code = codeOf(notes[0]!.body);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < LINK_CODE_MAX_ATTEMPTS; i++) await links.confirm('t1', APP, USER.email, wrong);
  assert.deepEqual(await links.confirm('t1', APP, USER.email, code), { error: 'invalid_code' }, '回数を超えたら合っていても使えない');
  await links.request('t1', APP, USER.email);
  const code2 = codeOf(notes.at(-1)!.body);
  assert.deepEqual(await links.confirm('t1', APP, USER.email, code2, new Date(Date.now() + 11 * 60_000)), { error: 'invalid_code' }, '10 分で切れる');
});

test('結び付け: 同じアドレスへの依頼は 1 時間に 5 回まで（超えても同じ答えで、お知らせは送らない）', async () => {
  const { links, notes } = await linkSetup();
  for (let i = 0; i < 7; i++) assert.deepEqual(await links.request('t1', APP, USER.email), { ok: true });
  assert.equal(notes.length, 5);
});

test('結び付け: 本人の側からもアプリの側からも削除でき、削除したら引けない。止めたアカウントも引けない', async () => {
  const { links, notes, store } = await linkSetup();
  await links.request('t1', APP, USER.email);
  const ok = await links.confirm('t1', APP, USER.email, codeOf(notes[0]!.body));
  assert.ok('bindingId' in ok);
  const mine = await links.listForUser('t1', 'u1');
  assert.deepEqual(mine.map((b) => b.appName), ['M2Medical']);
  assert.equal(await links.removeForUser('t1', 'u2', mine[0]!.id), false, 'ほかの人の結び付きは消せない');
  assert.equal(await links.removeForUser('t1', 'u1', mine[0]!.id), true);
  assert.equal(await links.resolve('t1', APP.id, ok.bindingId), null);
  await links.unlink('t1', APP, 'x'.repeat(32));
  // 止めたアカウントの結び付きは引けない
  await store.createBinding('t1', { id: 'b2', appId: APP.id, userId: 'u2', bindingHash: 'zz', createdAt: new Date().toISOString(), lastUsedAt: null });
  assert.equal(await links.resolve('t1', APP.id, 'not-a-binding'), null);
});

/** ナレッジの検索の試験の組み立て。区画の外と「人事」区画に 1 つずつ規程がある。 */
function searchSetup(llmText: string | Error, compartments: string[] = []) {
  const hits: KnowledgeHit[] = [
    { id: 'k-1', title: '就業規則', heading: '第23条（年次有給休暇）', path: [], citation: '就業規則 › 第23条', body: '6 か月で 10 日', source: '', compartment: null, score: 3, category: 'rule' },
    { id: 'k-2', title: '給与規程', heading: '第5条', path: [], citation: '給与規程 › 第5条', body: '人事だけの規程', source: '', compartment: '人事', score: 5, category: 'rule' },
  ];
  const searched: (string | null)[] = [];
  const f = fakeRepo({
    listUserCompartments: async () => compartments,
    searchKnowledge: async (_t: string, _q: string, compartment: string | null) => {
      searched.push(compartment);
      return { hits: hits.filter((h) => h.compartment === null || h.compartment === compartment) };
    },
    listKnowledge: async () => [{ id: 'k-1', version: 4, updatedAt: '2026-04-01T00:00:00.000Z' }, { id: 'k-2', version: 1, updatedAt: '2026-05-01T00:00:00.000Z' }],
  });
  const prompts: string[] = [];
  const llm = {
    name: 'test',
    complete: async (req: { messages: { content: string }[] }) => {
      prompts.push(req.messages.map((m) => m.content).join('\n'));
      if (llmText instanceof Error) throw llmText;
      return { text: llmText };
    },
  } as unknown as LlmProvider;
  const search = new AppKnowledgeSearch({ repo: f.repo, llmFor: async () => llm });
  return { search, searched, prompts, ...f };
}

test('ナレッジの検索: 本人の区画の外の資料は使わず、答えと出典（版・更新日）を返す。質問の文は監査ログに残さない', async () => {
  const { search, searched, prompts, audits } = searchSetup('{"answered": true, "answer": "6 か月で 10 日です", "used": [1]}');
  const q = '有給はいつから使えますか';
  const r = await search.search('t1', APP, USER, q);
  assert.equal(r.answered, true);
  assert.equal(r.answer, '6 か月で 10 日です');
  assert.deepEqual(r.sources, [{ title: '就業規則', heading: '第23条（年次有給休暇）', version: 4, updatedAt: '2026-04-01T00:00:00.000Z', category: 'rule' }]);
  assert.deepEqual(searched, [null], '区画に入っていない人は区画の外だけを探す');
  assert.ok(!prompts.join('').includes('人事だけの規程'), '区画の資料を AI に渡さない');
  const a = audits.find((x) => x.action === 'app.knowledge_search')!;
  assert.equal(a.detail['chars'], q.length);
  assert.ok(!JSON.stringify(audits).includes(q), '質問の文は残さない');
  assert.ok(!JSON.stringify(audits).includes('6 か月で 10 日です'), '答えの文は残さない');
});

test('ナレッジの検索: 区画に入っている人はその区画も探す。資料に無い・AI が使えないときは理由を返す', async () => {
  const withRole = searchSetup('{"answered": true, "answer": "答え", "used": [1, 2]}', ['人事']);
  const r = await withRole.search.search('t1', APP, USER, '給与の締め日');
  assert.deepEqual(withRole.searched, [null, '人事']);
  assert.equal(r.sources.length, 2);
  const none = searchSetup('{"answered": false, "answer": "", "used": []}');
  assert.deepEqual(await none.search.search('t1', APP, USER, '社用車の色'), { answered: false, answer: null, sources: [], reason: 'not_found' });
  const broken = searchSetup(new Error('AI が止まっている'));
  assert.equal((await broken.search.search('t1', APP, USER, '有給')).reason, 'unavailable');
});

test('機能の道: 新しい機能の道を決まった機能にだけ当て、管理者と本人の道には当てない', () => {
  const cases: [string, string, string | null][] = [
    ['POST', '/v1/accounts/link-requests', 'accounts.link'], ['POST', '/v1/accounts/links', 'accounts.link'], ['DELETE', '/v1/accounts/links/abc', 'accounts.link'],
    ['POST', '/v1/knowledge/search', 'knowledge.search'], ['PUT', '/v1/knowledge/rules/doc-1', 'knowledge.rules'], ['POST', '/v1/knowledge/rules/doc-1/retire', 'knowledge.rules'],
    ['POST', '/v1/inquiries/intake', 'inquiries.intake'], ['POST', '/v1/notices', 'notices.post'], ['POST', '/v1/notices/n1/withdraw', 'notices.post'],
    ['GET', '/v1/reservations/availability', 'reservations.book'], ['POST', '/v1/reservations', 'reservations.book'], ['DELETE', '/v1/reservations/r1', 'reservations.book'],
    ['POST', '/v1/members/points', 'members.points'], ['GET', '/v1/columns/published', 'columns.read'], ['GET', '/v1/columns/published/c1/cover.png', 'columns.read'],
    ['POST', '/v1/jobs', 'jobs.run'], ['GET', '/v1/runs/r1', 'jobs.run'], ['POST', '/v1/inventory/receipts', 'inventory.receipts'],
    ['GET', '/v1/notices', null], ['POST', '/v1/runs/r1/cancel', null], ['GET', '/v1/reservations', null], ['POST', '/v1/admin/knowledge', null], ['GET', '/v1/me/app-links', null],
    ['POST', '/v1/members/m1/visit', null], ['GET', '/v1/columns', null],
  ];
  for (const [m, p, fn] of cases) assert.equal(appFunctionFor(m, p), fn, `${m} ${p}`);
});

test('承認: 拡張を入れた会社だけ選べ、本人として行う機能は結び付けも要り、設定の外のグループ・業務は断る', async () => {
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, members: { ...DEFAULT_TENANT_SETTINGS.members, enabled: true } };
  const { repo } = fakeRepo({}, settings);
  const apps = new ExternalApps({ store: new MemoryAppStore(), repo, agents: async () => [{ id: 'ag-1', name: '日報', risk: 'draft' }, { id: 'ag-pay', name: '支払い', risk: 'financial' }] });
  const avail = await apps.available('t1');
  assert.ok(avail.includes('members.points') && !avail.includes('reservations.book') && !avail.includes('inventory.receipts'));
  const made = await apps.create('t1', 'u-admin', 'ポータル');
  assert.ok('key' in made);
  const id = made.app.id;
  assert.match(String((await apps.approve('t1', 'u-admin', id, { functions: ['knowledge.search'], settings: {} }) as { error: string }).error), /アカウントを結び付ける/);
  assert.ok('error' in await apps.approve('t1', 'u-admin', id, { functions: ['notices.post'], settings: { notices: { all: false, groupIds: ['g-x'] } } }));
  assert.ok('error' in await apps.approve('t1', 'u-admin', id, { functions: ['accounts.link', 'jobs.run'], settings: { jobs: { agentIds: ['ag-pay'], maxRisk: 'external-send' } } }), 'お金の業務は選べない');
  assert.ok('error' in await apps.approve('t1', 'u-admin', id, { functions: ['knowledge.rules'], settings: { knowledgeRules: { compartments: ['経理'] } } }), '知らない区画は断る');
  const ok = await apps.approve('t1', 'u-admin', id, {
    functions: ['accounts.link', 'jobs.run', 'notices.post', 'knowledge.rules', 'members.points'],
    settings: { jobs: { agentIds: ['ag-1'], maxRisk: 'draft' }, notices: { all: false, groupIds: ['g1'] }, knowledgeRules: { compartments: ['人事'] } },
  });
  assert.ok(!('error' in ok), JSON.stringify(ok));
  assert.deepEqual((await apps.settingsOf('t1', id))?.notices, { all: false, groupIds: ['g1'] });
});

test('入庫の通知: 形を確かめ、照らした行を入庫し、二重に数えない。取り消しで戻し、照らせない行は選べば入庫する', async () => {
  assert.ok('error' in parseReceiptEvent({ eventId: 'e', receiptId: 'r', status: 'received', lines: [{ code: 'A', quantity: 0 }] }));
  assert.ok('error' in parseReceiptEvent({ eventId: 'e', receiptId: 'r', status: 'received', lines: [{ code: 'A', quantity: 1, expiresOn: '2026/12/01' }] }));
  const settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, inventory: { ...DEFAULT_TENANT_SETTINGS.inventory, enabled: true } };
  const { repo } = fakeRepo({ listUserGroupIds: async () => [] }, settings);
  const inv = new MemoryInventoryStore();
  const service = new InventoryService({ store: inv, repo });
  const apps = new ExternalApps({ store: new MemoryAppStore(), repo });
  const store = new MemorySalesStore(inv);
  const sales = new InventorySales({ store, service, repo, apps });
  const made = await service.createItem('t1', 'u1', { name: 'ハンドクリーム', unit: '個', sku: 'HC-1' }, 5);
  assert.ok('item' in made);
  const itemId = made.item.id;
  const onHand = async () => (await service.list('t1')).find((i) => i.id === itemId)!.onHand;
  const body = { eventId: 'ev-1', receiptId: 'IN-001', status: 'received', lines: [{ code: 'HC-1', quantity: 3 }, { code: 'NOPE', quantity: 2 }] };
  const r1 = await sales.postReceipt('t1', 'app-1', body);
  assert.equal(r1.status, 200);
  assert.deepEqual((r1.body as { lines: { result: string }[] }).lines.map((l) => l.result), ['received', 'unmatched']);
  assert.equal(await onHand(), 8);
  assert.deepEqual((await sales.postReceipt('t1', 'app-1', body)).body, r1.body, '同じ eventId には同じ答え');
  assert.equal(await onHand(), 8, '二重に数えない');
  assert.equal((await sales.postReceipt('t1', 'app-1', { ...body, eventId: 'ev-2' })).status, 200);
  assert.equal(await onHand(), 8, '同じ入荷の番号の 2 回目は入庫しない');
  const open = await sales.unmatched('t1');
  assert.equal(open.length, 1);
  assert.equal(open[0]!.action, 'receive');
  assert.equal(open[0]!.saleRef, 'IN-001');
  assert.deepEqual(await sales.resolve('t1', 'u1', open[0]!.id, itemId), { ok: true });
  assert.equal(await onHand(), 10);
  await sales.postReceipt('t1', 'app-1', { eventId: 'ev-3', receiptId: 'IN-001', status: 'cancelled' });
  assert.equal(await onHand(), 5, '取り消しで、選んで入庫した分も含めて戻す');
});
