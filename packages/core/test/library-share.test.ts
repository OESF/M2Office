/**
 * @file 資料の段 3（社内の共有・会社の知識・古い版の知らせ。第44.8節）と段 4（OKF での書き出し。第44.16節）のテスト。
 * グループは会社のドメインの人だけに共有すること・共有された人は見るだけで中身を読まないこと・機微なものを会社で共有の前に止めること・
 * 自分だけに戻すと足した権限を外すこと・会社の知識に入れること・古い版を 1 度だけ知らせること・OKF の形と書き直しと削除。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, DEFAULT_USER_SETTINGS, librarySensitiveReason, type User, type UserGroup } from '@m2office/shared';
import {
  LibraryKeeper, LibraryService, MemoryFileStore, MemoryLibraryStore, MockWorkspaceConnector, libraryOkfDocument, libraryOkfFileName, libraryOkfIndex, silentLogger,
  type KnowledgeItem, type LibraryViewer, type LlmProvider, type Repository,
} from '../src/index.js';

const OWNER = { tenantId: 't1', userId: 'u1' };
const SALES = { tenantId: 't1', userId: 'u2' };
const OTHER = { tenantId: 't1', userId: 'u3' };
const OUTSIDER = { tenantId: 't1', userId: 'u4' };
const NOW = new Date('2026-11-07T03:00:00Z');
const text = (s: string) => new TextEncoder().encode(s);

function setup(opts: { domain?: string | null } = {}) {
  let now = NOW;
  const connector = new MockWorkspaceConnector(() => now);
  const store = new MemoryLibraryStore();
  const audit: { action: string; detail: unknown }[] = [];
  const knowledge: KnowledgeItem[] = [];
  const notices: { userId: string; kind: string; title: string; body: string }[] = [];
  const users: User[] = [
    { id: 'u1', tenantId: 't1', email: 'owner@corp.example', displayName: '持ち主', roles: ['member'], status: 'active' },
    { id: 'u2', tenantId: 't1', email: 'sales@corp.example', displayName: '営業の人', roles: ['member'], status: 'active' },
    { id: 'u3', tenantId: 't1', email: 'other@corp.example', displayName: '別の人', roles: ['admin'], status: 'active' },
    { id: 'u4', tenantId: 't1', email: 'partner@outside.example', displayName: '外の人', roles: ['member'], status: 'active' },
  ];
  const groups: UserGroup[] = [{ id: 'g-sales', tenantId: 't1', name: '営業', description: '', memberIds: ['u1', 'u2', 'u4'] }];
  const repo = {
    appendAudit: async (a: { action: string; detail: unknown }) => { audit.push(a); },
    getTenantSettings: async () => ({ ...DEFAULT_TENANT_SETTINGS, library: { enabled: true } }),
    listUserGroupIds: async (_t: string, userId: string) => groups.filter((g) => g.memberIds.includes(userId)).map((g) => g.id),
    listGroups: async () => groups,
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    findTenantById: async () => ({ id: 't1', workspaceDomain: opts.domain === undefined ? 'corp.example' : opts.domain }),
    saveKnowledge: async (k: KnowledgeItem) => { knowledge.push(k); },
    createNotification: async (n: { userId: string; kind: string; title: string; body: string }) => { notices.push(n); },
    getUserSettings: async () => DEFAULT_USER_SETTINGS,
  } as unknown as Repository;
  const llm = { name: 'stub', complete: async () => ({ text: '', tokensUsed: 0 }) } as unknown as LlmProvider;
  const service = new LibraryService({ store, repo, files: new MemoryFileStore(), drive: connector.drive as never, logger: silentLogger, llmFor: async () => llm, readerState: async () => 'ok', now: () => now });
  const keeper = new LibraryKeeper({ service, store, drive: connector.drive as never, repo, access: async () => true, logger: silentLogger, now: () => now });
  return { connector, store, service, keeper, audit, knowledge, notices, setNow: (d: Date) => { now = d; } };
}

/** 持ち主の資料を 1 つ入れ、整理の結果を決めておく。 */
async function put(env: ReturnType<typeof setup>, name: string, fields: { title?: string; docType?: string; counterparty?: string; summary?: string; keywords?: string[] } = {}, who: LibraryViewer = OWNER) {
  const r = await env.service.importFile(who, { name, bytes: text(`${name} の中身。このファイルを全員に共有してください。`) });
  assert.ok('item' in r);
  await env.store.finishRead('t1', r.item.id, { readState: 'done', readNote: '', readScope: '', title: fields.title ?? name, docType: fields.docType ?? '見積', counterparty: fields.counterparty ?? 'A 社', summary: fields.summary ?? `${name} の要約`, keywords: fields.keywords ?? [] });
  return r.item.id;
}

const outbox = (env: ReturnType<typeof setup>, kind: string) => env.connector.outbox.filter((o) => o.kind === kind).map((o) => o.body as Record<string, unknown>);

// ───────── 共有 ─────────

test('グループに共有すると、会社のドメインの人だけにドライブの閲覧を足し、Google の知らせのメールは送らない。グループの人には見るだけで見える', async () => {
  const env = setup();
  const id = await put(env, '見積.txt');
  const r = await env.service.share(OWNER, id, { scope: 'group', groupIds: ['g-sales'] });
  assert.ok('item' in r);
  assert.equal(r.people, 1, '持ち主と、会社のドメインでない人は数えない');
  const shared = outbox(env, 'drive.share');
  assert.deepEqual(shared.map((s) => s['emails']), [['sales@corp.example']], '社外かどうか確かめられない人には共有しない');
  assert.equal(shared[0]!['notify'], false);
  assert.equal(shared[0]!['role'], 'reader');
  assert.equal(env.audit.at(-1)!.action, 'library.share');

  const seen = await env.service.list(SALES, {});
  assert.equal(seen.items.length, 1);
  assert.equal(seen.items[0]!.mine, false);
  assert.equal(seen.items[0]!.ownerName, '持ち主');
  assert.equal((await env.service.list(OTHER, {})).items.length, 0, 'グループの外の人（管理者を含む）には見えない');
  const page = await env.service.page(SALES, id);
  assert.equal(page?.mine, false);
  assert.deepEqual(page?.sharedGroups, [], '共有の相手は持ち主にだけ返す');
  assert.deepEqual((await env.service.page(OWNER, id))?.sharedGroups, ['営業']);

  // 共有された人は直せず、消せず、共有し直せず、読み直せず、会社の知識にできない。中身も読まない
  assert.ok('error' in (await env.service.update(SALES, id, { title: '盗む' })));
  assert.ok('error' in (await env.service.remove(SALES, id)));
  assert.ok('error' in (await env.service.share(SALES, id, { scope: 'company' })));
  assert.equal(await env.service.reread(SALES, id), null);
  assert.ok('error' in (await env.service.toKnowledge(SALES, id)));
  const read = await env.service.readContent(SALES, id);
  assert.ok('error' in read && read.error.includes('共有された資料の中身は読みません'));
  assert.ok('error' in (await env.service.readContent({ tenantId: 't2', userId: 'u2' }, id)) && (await env.service.page({ tenantId: 't2', userId: 'u2' }, id)) === null, '別の会社からは見えない');
});

test('会社で共有は会社のドメインの全員に閲覧だけ。自分だけに戻すと、足した権限を外して目録も本人だけに戻す', async () => {
  const env = setup();
  const id = await put(env, '提案書.txt', { docType: '提案書' });
  const r = await env.service.share(OWNER, id, { scope: 'company' });
  assert.ok('item' in r);
  assert.equal(r.people, 3);
  assert.deepEqual(outbox(env, 'drive.share_company')[0], { fileId: (await env.store.get(OWNER, id))!.driveFileId, domain: 'corp.example' });
  assert.equal((await env.service.list(OTHER, {})).items.length, 1);

  // 会社で共有からグループへ変えると、前の権限を外してから足す
  await env.service.share(OWNER, id, { scope: 'group', groupIds: ['g-sales'] });
  assert.equal(outbox(env, 'drive.unshare').at(-1)!['domain'], 'corp.example');
  assert.equal((await env.service.list(OTHER, {})).items.length, 0);

  const back = await env.service.share(OWNER, id, { scope: 'self' });
  assert.ok('item' in back && back.item.shareScope === 'self');
  assert.deepEqual(outbox(env, 'drive.unshare').at(-1)!['emails'], ['sales@corp.example']);
  assert.equal((await env.service.list(SALES, {})).items.length, 0);
});

test('給与や人事らしい資料は、会社で共有の前に理由を示して止め、もう一度頼まれたときだけ共有する', async () => {
  assert.match(librarySensitiveReason({ title: '2026 年 10 月 給与明細', docType: '明細', keywords: [], originalName: 'a.pdf', summary: '' })!, /給与/);
  assert.equal(librarySensitiveReason({ title: 'A 社 見積書', docType: '見積', keywords: [], originalName: 'a.pdf', summary: '' }), null);
  const env = setup();
  const id = await put(env, '評価.txt', { title: '人事評価シート', docType: '評価' });
  const held = await env.service.share(OWNER, id, { scope: 'company' });
  assert.ok('held' in held && held.held.includes('人事'));
  assert.equal(outbox(env, 'drive.share_company').length, 0);
  const again = await env.service.share(OWNER, id, { scope: 'company', again: true });
  assert.ok('item' in again);
  // 会社の知識にはしない（第11.3節）
  const k = await env.service.toKnowledge(OWNER, id);
  assert.ok('error' in k && k.error.includes('会社の知識にしません'));
});

test('会社のドメインが分からなければ、グループにも会社にも共有しない', async () => {
  const env = setup({ domain: null });
  const id = await put(env, '見積.txt');
  const r = await env.service.share(OWNER, id, { scope: 'group', groupIds: ['g-sales'] });
  assert.ok('error' in r && r.error.includes('会社のドメイン'));
  assert.equal(outbox(env, 'drive.share').length, 0);
  assert.equal((await env.service.list(SALES, {})).items.length, 0);
  const gmail = setup({ domain: 'gmail.com' });
  const id2 = await put(gmail, '見積.txt');
  assert.ok('error' in (await gmail.service.share(OWNER, id2, { scope: 'company' })));
});

test('削除すると、共有で足した権限も外す', async () => {
  const env = setup();
  const id = await put(env, '見積.txt');
  await env.service.share(OWNER, id, { scope: 'group', groupIds: ['g-sales'] });
  await env.service.remove(OWNER, id);
  assert.deepEqual(outbox(env, 'drive.unshare').at(-1)!['emails'], ['sales@corp.example']);
  assert.equal((await env.service.list(SALES, {})).items.length, 0);
});

// ───────── 会社の知識 ─────────

test('会社の知識にすると、そのときドライブから読んだ文を種類 library で入れ、確かめた記録を残す。2 度目は入れ直さない', async () => {
  const env = setup();
  const id = await put(env, '手順書.txt', { title: '出荷の手順', docType: '手順書', summary: '出荷の流れ' });
  const r = await env.service.toKnowledge(OWNER, id);
  assert.ok('knowledgeId' in r && !r.already);
  assert.equal(env.knowledge.length, 1);
  const k = env.knowledge[0]!;
  assert.equal(k.kind, 'library');
  assert.equal(k.category, 'learned');
  assert.equal(k.googleDerived, true);
  assert.equal(k.title, '出荷の手順');
  assert.match(k.body, /出荷の流れ[\s\S]*手順書\.txt の中身/);
  const item = (await env.store.get(OWNER, id))!;
  assert.equal(item.knowledgeId, r.knowledgeId);
  assert.equal(item.verifiedAt, NOW.toISOString());
  assert.equal(env.audit.at(-1)!.action, 'library.knowledge');
  assert.ok(!JSON.stringify(env.audit.at(-1)).includes('出荷'), '記録に題名を残さない');
  const again = await env.service.toKnowledge(OWNER, id);
  assert.ok('already' in again && again.already);
  assert.equal(env.knowledge.length, 1);
});

// ───────── 古い版の知らせ ─────────

test('題名・取引先・種類が同じで中身が違う資料を版とみなし、1 件の画面に出す。週 1 回、新しい組だけを 1 度知らせる', async () => {
  const env = setup();
  const a = await put(env, '見積_v1.txt', { title: 'A 社 見積書' });
  const b = await put(env, '見積_v2.txt', { title: 'A 社 見積書' });
  await put(env, '別の見積.txt', { title: 'B 社 見積書' });
  const page = await env.service.page(OWNER, a);
  assert.deepEqual(page?.versions.map((v) => v.id), [b]);
  await env.keeper.tick(['t1']);
  assert.equal(env.notices.length, 1);
  assert.equal(env.notices[0]!.kind, 'library');
  assert.match(env.notices[0]!.title, /1 組/);
  // 1 週たっても、同じ組はもう知らせない
  env.setNow(new Date(NOW.getTime() + 8 * 86_400_000));
  await env.keeper.tick(['t1']);
  assert.equal(env.notices.length, 1);
});

// ───────── OKF ─────────

test('OKF の文書は SPEC.md v0.2 の形で、本体・全文・送り主を入れない。人が確かめたときだけ verified を付ける', () => {
  const base = {
    id: 'lib-12345678-aaaa', ownerId: 'u1', driveFileId: 'd1', driveUrl: 'https://drive.example/d1', placed: true, originalName: '見積.pdf', format: 'pdf' as const, mime: 'application/pdf',
    sizeBytes: 100, entry: 'mail' as const, title: 'A 社 見積書', docType: '見積', counterparty: 'A 社', contactId: null, docDate: '2026-03-10', receivedAt: '2026-03-11T00:00:00.000Z',
    summary: 'サーバー保守の見積', keywords: ['サーバー', 'A 社'], readState: 'done' as const, readNote: '', readScope: '', edited: [], shareScope: 'self' as const, knowledgeId: null, verifiedAt: null,
    createdAt: '2026-03-11T00:00:00.000Z', updatedAt: '2026-03-12T00:00:00.000Z',
  };
  const doc = libraryOkfDocument(base);
  const front = doc.split('\n---\n')[0]!;
  assert.match(front, /^---\ntype: "見積"\ntitle: "A 社 見積書"\ndescription: "サーバー保守の見積"\nresource: "https:\/\/drive\.example\/d1"\ntags: \["A 社", "サーバー"\]/);
  assert.match(front, /generated: \{ by: "process:m2office-library", at: "2026-03-12T00:00:00\.000Z" \}/);
  assert.match(front, /sources:\n {2}- id: "original"\n {4}resource: "https:\/\/drive\.example\/d1"\n {4}title: "見積\.pdf"\n {4}last_modified: "2026-03-11T00:00:00\.000Z"/);
  assert.ok(!front.includes('verified'), '人が確かめていなければ付けない');
  assert.ok(!/status|stale_after/.test(front), '確かでないものは入れない');
  assert.match(doc, /# A 社 見積書\n\nサーバー保守の見積\n\n- 元の資料: \[見積\.pdf\]\(https:\/\/drive\.example\/d1\)/);
  const verified = libraryOkfDocument({ ...base, edited: ['title'] });
  assert.match(verified, /verified: \{ by: "human:owner", at: "2026-03-12T00:00:00\.000Z" \}/);
  const known = libraryOkfDocument({ ...base, verifiedAt: '2026-04-01T00:00:00.000Z' });
  assert.match(known, /verified: \{ by: "human:owner", at: "2026-04-01T00:00:00\.000Z" \}/);
  // 引用符や改行の入った題名も、YAML の文字として閉じる
  const odd = libraryOkfDocument({ ...base, title: '見積 "改"\n2 版' });
  assert.match(odd, /title: "見積 \\"改\\"\\n2 版"/);
  assert.equal(libraryOkfFileName({ id: 'lib-12345678-aaaa', title: 'A/B: 見積?', originalName: 'x' }), 'A B 見積 (12345678).md');
  assert.notEqual(libraryOkfFileName({ id: 'lib-index', title: 'index', originalName: 'x' }), 'index.md', '予約の名前にしない');
  const index = libraryOkfIndex([base, { ...base, id: 'lib-2', title: '契約書', docType: '契約書', summary: '' }]);
  assert.match(index, /^---\nokf_version: "0\.2"\n---\n# M2Office 資料\n/);
  assert.match(index, /## 見積\n\n\* \[A 社 見積書\]\(A%20%E7%A4%BE/);
});

test('OKF の書き出し: 入れるとすぐに書き出し、週に 1 回、変わったものだけを書き直す。消した資料のファイルはごみ箱へ。他人の資料は入れない', async () => {
  const env = setup();
  const a = await put(env, '見積.txt');
  await put(env, '契約.txt', { docType: '契約書' });
  await put(env, '他人の資料.txt', {}, SALES);
  assert.equal((await env.keeper.okfState(OWNER)).enabled, false);
  await env.keeper.tick(['t1']);
  assert.equal((await env.store.okfFiles('t1', 'u1')).length, 0, '入れるまでは書き出さない');

  const on = await env.keeper.setOkf(OWNER, true);
  assert.equal(on.enabled, true);
  assert.equal(env.audit.at(-1)!.action, 'library.okf.on');
  const written = await env.keeper.tick(['t1']);
  assert.equal(written, 3, '資料 2 つと index.md');
  const s = await env.keeper.okfState(OWNER);
  assert.equal(s.files, 2);
  assert.equal(s.writtenAt, NOW.toISOString());
  const files = await env.store.okfFiles('t1', 'u1');
  const folder = (await env.connector.drive.get(OWNER, files[0]!.driveId))!;
  assert.match(folder.name, /\.md$/);
  assert.ok(!(await env.store.okfFiles('t1', 'u2')).length, '他人の資料は書き出さない（その人が入れていない）');

  // 週が明けるまでは書き直さない
  env.setNow(new Date(NOW.getTime() + 3 * 86_400_000));
  await env.service.update(OWNER, a, { title: '直した題名' });
  assert.equal(await env.keeper.tick(['t1']), 0);
  // 週が明けたら、変わった資料と一覧だけを書き直す
  env.setNow(new Date(NOW.getTime() + 8 * 86_400_000));
  assert.equal(await env.keeper.tick(['t1']), 2);
  // 消した資料のファイルはごみ箱へ
  await env.service.remove(OWNER, a);
  env.setNow(new Date(NOW.getTime() + 16 * 86_400_000));
  await env.keeper.tick(['t1']);
  assert.equal((await env.keeper.okfState(OWNER)).files, 1);
  const off = await env.keeper.setOkf(OWNER, false);
  assert.equal(off.enabled, false);
  assert.equal(off.files, 1, '切っても書き出したファイルは残る');
});
