/**
 * @file 契約の管理の段 1 の単体テスト（仕様書 第38.17節）。申し出の決まりの読み方・決まった言い方での読み取り・
 * 契約書から入れる（置き場・同じ契約・他人のファイル）・手で入れる・直したときの期限の計算し直し・
 * 期限の見張り（60・30・7 日前を 1 回ずつ、自動更新の繰り越し、終わりの 30 日前、解約を申し出た契約の終了）・削除の権限・ツール。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  CONTRACT_TOOLS, ContractService, MemoryContractStore, MemoryFileStore, MockWorkspaceConnector, contractFileName,
  kindOf, noticeDaysOf, noticeDeadline, readContractByRule, renewMonthsOf, saveFile,
  type Repository, type ToolContext,
} from '../src/index.js';

const SAMPLE = [
  'サーバー保守契約書',
  '株式会社アルファ商事（以下「甲」という。）と株式会社ベータ保守（以下「乙」という。）は、次のとおり契約を結ぶ。',
  '第5条 本契約の期間は、2027年4月1日から2028年3月31日までとする。',
  '期間満了の3か月前までに甲乙いずれからも書面による申し出がないときは、同一条件でさらに1年間延長し、以後も同様とする。',
  '2027年3月15日',
].join('\n');

function setup() {
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事' },
    contracts: { enabled: true, storage: null },
  };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '総務', roles: ['member'], status: 'active' },
    { id: 'u2', email: 'u2@alpha.example.jp', displayName: '営業', roles: ['member'], status: 'active' },
  ];
  const audits: { action: string; targetId: string }[] = [];
  const notes: { userId: string; kind: string; title: string; body: string }[] = [];
  const files: Record<string, unknown>[] = [];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: { contract: true } } }),
    createNotification: async (n: { userId: string; kind: string; title: string; body: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; targetId: string }) => { audits.push(e); },
    createFile: async (f: Record<string, unknown>) => { files.push(f); },
    getFile: async (_t: string, id: string) => files.find((f) => f['id'] === id) ?? null,
    listApprovalsForFileInput: async () => [],
  } as unknown as Repository;
  const store = new MemoryContractStore();
  const fileStore = new MemoryFileStore();
  const connector = new MockWorkspaceConnector();
  const service = new ContractService({ store, repo, files: fileStore, drive: connector.drive, llmFor: async () => null });
  /** 契約書を上げる（表の形で文字にできるものを使う。読み方は PDF と同じ） */
  const upload = async (owner: string, text: string, name = '契約書.csv') =>
    (await saveFile(repo, fileStore, { tenantId: 't1', ownerUserId: owner, name, kind: 'csv', bytes: new TextEncoder().encode(text), origin: 'upload', runId: null })).id;
  return { service, store, repo, connector, audits, notes, upload, settings: () => settings };
}

const u1 = { tenantId: 't1', userId: 'u1' };
const boss = { tenantId: 't1', userId: 'boss' };
/** 日本の時刻のその日の正午 */
const at = (d: string) => new Date(`${d}T03:00:00Z`);

test('申し出の決まりの日数・更新の期間・種類・期限の計算', () => {
  assert.equal(noticeDaysOf('期間満了の3か月前までに'), 90);
  assert.equal(noticeDaysOf('満了日の三ヶ月前までに書面で'), 90);
  assert.equal(noticeDaysOf('30日前までに通知'), 30);
  assert.equal(noticeDaysOf('2週間前'), 14);
  assert.equal(noticeDaysOf('1年前までに'), 365);
  assert.equal(noticeDaysOf('いつでも解約できる'), null);
  assert.equal(renewMonthsOf('同一条件でさらに1年間延長し'), 12);
  assert.equal(renewMonthsOf('6か月ごとに自動的に更新する'), 6);
  assert.equal(renewMonthsOf('協議のうえ定める'), null);
  assert.equal(kindOf('秘密保持契約書'), 'nda');
  assert.equal(kindOf('複合機リース契約'), 'lease');
  assert.equal(kindOf('事務所賃貸借契約書'), 'lease_property');
  assert.equal(kindOf('覚書'), 'other');
  assert.equal(noticeDeadline('2028-03-31', 90), '2028-01-01');
  assert.equal(noticeDeadline('2028-03-31', null), null);
  assert.equal(noticeDeadline(null, 90), null);
  assert.equal(contractFileName({ party: '株式会社 ベータ/保守', kind: 'maintenance', signedOn: '2027-03-15' }, 'pdf'), '株式会社ベータ保守_保守_2027-03-15.pdf');
});

test('推論が使えないときは決まった言い方で読み、読めない項目は「不明」の印を付ける（推測で埋めない）', () => {
  const r = readContractByRule(SAMPLE, '株式会社アルファ商事');
  assert.equal(r.party, '株式会社ベータ保守');
  assert.equal(r.kind, 'maintenance');
  assert.equal(r.title, 'サーバー保守契約書');
  assert.equal(r.startOn, '2027-04-01');
  assert.equal(r.endOn, '2028-03-31');
  assert.equal(r.signedOn, '2027-03-15');
  assert.equal(r.autoRenew, true);
  assert.equal(r.noticeDays, 90);
  assert.equal(r.renewMonths, 12);
  assert.match(r.noticeRule, /3か月前/);
  assert.deepEqual(r.unknown, []);

  const thin = readContractByRule('業務委託契約書\n甲と乙は業務を委託する。', '株式会社アルファ商事');
  assert.equal(thin.party, '');
  assert.equal(thin.endOn, null);
  assert.equal(thin.autoRenew, false);
  assert.deepEqual([...thin.unknown].sort(), ['endOn', 'party', 'signedOn', 'startOn']);
});

test('契約書から入れる: 置き場が無ければ台帳だけに入れて理由を返し、つないだ後はドライブに置いて開ける', async () => {
  const s = setup();
  const first = await s.service.importFile(u1, await s.upload('u1', SAMPLE));
  assert.ok(!('error' in first));
  assert.equal(first.contract.party, '株式会社ベータ保守');
  assert.equal(first.contract.noticeDeadline, '2028-01-01');
  assert.equal(first.contract.ownerId, 'u1');
  assert.equal(first.contract.ownerName, '総務');
  assert.equal(first.contract.driveFileId, null);
  assert.match(first.fileNote ?? '', /置き場をつないでいない/);

  // 同じ契約（相手・種類・締結日が同じ）は 2 回入れない
  const again = await s.service.importFile(u1, await s.upload('u1', SAMPLE));
  assert.ok('error' in again);
  assert.match(again.error, /もう台帳にあります/);

  // 置き場をつなげるのは管理者だけ
  assert.ok('error' in (await s.service.connectStorage(u1)));
  const conn = await s.service.connectStorage(boss);
  assert.ok(!('error' in conn));
  assert.equal(s.settings().contracts.storage?.connectedBy, 'boss');

  const nda = SAMPLE.replace('サーバー保守契約書', '秘密保持契約書').replace('2027年3月15日', '2027年3月20日');
  const second = await s.service.importFile(u1, await s.upload('u1', nda, 'NDA.csv'));
  assert.ok(!('error' in second));
  assert.equal(second.fileNote, null);
  assert.equal(second.contract.kind, 'nda');
  assert.equal(second.contract.driveFileName, '株式会社ベータ保守_秘密保持NDA_2027-03-20.csv');
  // 置き場をつないだ管理者の許可でドライブから読むので、入れた人以外（利用範囲の人）も開ける
  const opened = await s.service.openFile({ tenantId: 't1', userId: 'u2' }, second.contract.id);
  assert.ok(!('error' in opened));
  assert.match(new TextDecoder().decode(opened.bytes), /秘密保持契約書/);
  assert.ok(s.audits.some((a) => a.action === 'contract.open'));
  // ドライブに置いていない契約は開けないと答える
  const none = await s.service.openFile(u1, first.contract.id);
  assert.ok('error' in none);
});

test('他人のファイルからは入れられない。文字がほとんど無ければ撮り直しを頼む', async () => {
  const s = setup();
  const theirs = await s.upload('u2', SAMPLE);
  const r = await s.service.importFile(u1, theirs);
  assert.ok('error' in r);
  assert.equal(r.error, 'ファイルが見つかりません');
  const blank = await s.service.importFile(u1, await s.upload('u1', '契約書'));
  assert.ok('error' in blank);
  assert.match(blank.error, /ほとんど読めません/);
  assert.equal(s.store.rows.size, 0);
});

test('契約書チェックの実行から入れる: 頼んだ本人の実行の契約書だけを使う', async () => {
  const s = setup();
  const fileId = await s.upload('u1', SAMPLE);
  const service = new ContractService({
    ...s.service.deps,
    reviewFile: async (_t, userId, runId) => (userId === 'u1' && runId === 'run-1' ? fileId : null),
    latestReview: async (_t, userId) => (userId === 'u1' ? 'run-1' : null),
  });
  const r = await service.importReview(u1, null);
  assert.ok(!('error' in r));
  assert.equal(r.contract.reviewRunId, 'run-1');
  const other = await service.importReview({ tenantId: 't1', userId: 'u2' }, 'run-1');
  assert.ok('error' in other);
});

test('手で入れる・直す: 直したら期限を計算し直し、直した項目の「不明」の印を外し、知らせ直す', async () => {
  const s = setup();
  assert.ok('error' in (await s.service.create(u1, { title: '名前だけ' })));
  assert.ok('error' in (await s.service.create(u1, { party: '株式会社ガンマ', endOn: '2027/03/31' })));
  const made = await s.service.create(u1, { party: '株式会社ガンマ', title: '複合機リース契約', startOn: '2027-01-01', endOn: '2031-12-31', autoRenew: true, noticeDays: 60, renewMonths: 12 });
  assert.ok(!('error' in made));
  const c = made.contract;
  assert.equal(c.kind, 'lease');
  assert.equal(c.noticeDeadline, '2031-11-01');

  await s.store.update('t1', c.id, { unknown: ['endOn', 'party'], notified: ['notice:60'] }, 'u1');
  assert.equal(await s.service.update(u1, c.id, { endOn: '2032-12-31' }), null);
  const after = (await s.store.get('t1', c.id))!;
  assert.equal(after.noticeDeadline, '2032-11-01');
  assert.deepEqual(after.unknown, ['party']);
  assert.deepEqual(after.notified, []);

  // 申し出の決まりの文だけを直したら、日数を読み直す
  assert.equal(await s.service.update(u1, c.id, { noticeRule: '満了の1か月前までに申し出る' }), null);
  assert.equal((await s.store.get('t1', c.id))!.noticeDeadline, '2032-12-01');

  assert.match((await s.service.update(u1, c.id, { endOn: '2026-01-01' })) ?? '', /始めより前/);
  assert.match((await s.service.update(u1, c.id, { ownerId: 'nobody' })) ?? '', /担当にできない/);
  assert.equal(await s.service.update(u1, c.id, { ownerId: 'u2' }), null);
  assert.equal((await s.service.get(u1, c.id))!.ownerName, '営業');
  assert.equal(await s.service.update(u1, 'ctr-none', { note: 'x' }), '契約が見つかりません');
});

test('見張り: 申し出の期限の 60・30・7 日前に 1 回ずつ知らせ、終わりを過ぎたら次の期間に進める', async () => {
  const s = setup();
  const made = await s.service.create(u1, { party: '株式会社ベータ保守', title: 'サーバー保守契約', startOn: '2027-04-01', endOn: '2028-03-31', autoRenew: true, noticeDays: 90, renewMonths: 12 });
  assert.ok(!('error' in made));
  const id = made.contract.id;
  assert.equal(made.contract.noticeDeadline, '2028-01-01');

  // 期限の 61 日前はまだ知らせない
  assert.deepEqual(await s.service.tick(at('2027-11-01')), { notified: 0, renewed: 0 });
  // 60 日前に知らせる。同じ日に何度見ても 1 回だけ
  assert.deepEqual(await s.service.tick(at('2027-11-02')), { notified: 1, renewed: 0 });
  assert.deepEqual(await s.service.tick(at('2027-11-02')), { notified: 0, renewed: 0 });
  assert.equal(s.notes[0]!.userId, 'u1');
  assert.equal(s.notes[0]!.kind, 'contract');
  assert.match(s.notes[0]!.title, /あと 60 日（1\/1）/);
  assert.deepEqual(await s.service.tick(at('2027-12-02')), { notified: 1, renewed: 0 });
  assert.deepEqual(await s.service.tick(at('2027-12-25')), { notified: 1, renewed: 0 });
  assert.deepEqual(await s.service.tick(at('2027-12-26')), { notified: 0, renewed: 0 });
  assert.deepEqual((await s.store.get('t1', id))!.notified, ['notice:60', 'notice:30', 'notice:7']);

  // 終わりを過ぎて解約の申し出が無ければ、次の期間に進め、知らせ直せるようにする
  assert.deepEqual(await s.service.tick(at('2028-04-01')), { notified: 0, renewed: 1 });
  const next = (await s.store.get('t1', id))!;
  assert.equal(next.startOn, '2028-04-01');
  assert.equal(next.endOn, '2029-03-31');
  assert.equal(next.noticeDeadline, '2028-12-31');
  assert.equal(next.renewedCount, 1);
  assert.deepEqual(next.notified, []);
  assert.match(s.notes.at(-1)!.title, /自動で更新しました/);
  assert.ok(s.audits.some((a) => a.action === 'contract.renewed' && a.targetId === id));
});

test('見張り: 入れたのが期限の近くなら、いちばん近い知らせだけを 1 回送る。何年も過ぎた契約は今の期間まで進める', async () => {
  const s = setup();
  const near = await s.service.create(u1, { party: '株式会社デルタ', title: 'ソフトウェア利用契約', startOn: '2027-01-01', endOn: '2027-12-31', autoRenew: true, noticeDays: 30, renewMonths: 12 });
  assert.ok(!('error' in near));
  // 期限（2027-12-01）の 5 日前に初めて見た
  assert.deepEqual(await s.service.tick(at('2027-11-26')), { notified: 1, renewed: 0 });
  assert.deepEqual(await s.service.tick(at('2027-11-27')), { notified: 0, renewed: 0 });
  assert.equal(s.notes.length, 1);

  assert.deepEqual(await s.service.tick(at('2030-06-01')), { notified: 0, renewed: 1 });
  const c = (await s.store.get('t1', near.contract.id))!;
  assert.equal(c.endOn, '2030-12-31');
  assert.equal(c.renewedCount, 3);
});

test('見張り: 自動更新の無い契約は終わりの 30 日前に知らせ、終わったら「終了」。解約を申し出た契約は進めずに「終了」', async () => {
  const s = setup();
  const fixed = await s.service.create(u1, { party: '株式会社イプシロン', title: '業務委託契約', startOn: '2027-01-01', endOn: '2027-06-30' });
  const cancel = await s.service.create(u1, { party: '株式会社ゼータ', title: '保守契約', startOn: '2027-01-01', endOn: '2027-06-30', autoRenew: true, noticeDays: 30, renewMonths: 12 });
  assert.ok(!('error' in fixed) && !('error' in cancel));
  assert.equal(await s.service.update(u1, cancel.contract.id, { status: 'cancel_requested' }), null);
  assert.ok(s.audits.some((a) => a.action === 'contract.status'));

  assert.deepEqual(await s.service.tick(at('2027-05-30')), { notified: 0, renewed: 0 });
  assert.deepEqual(await s.service.tick(at('2027-05-31')), { notified: 1, renewed: 0 });
  assert.match(s.notes[0]!.title, /株式会社イプシロンの業務委託.*契約の終わりまであと 30 日（6\/30）/);
  assert.deepEqual(await s.service.tick(at('2027-06-15')), { notified: 0, renewed: 0 });

  assert.deepEqual(await s.service.tick(at('2027-07-01')), { notified: 0, renewed: 0 });
  assert.equal((await s.store.get('t1', fixed.contract.id))!.status, 'ended');
  const ended = (await s.store.get('t1', cancel.contract.id))!;
  assert.equal(ended.status, 'ended');
  assert.equal(ended.endOn, '2027-06-30');
});

test('見張り: 担当が知らせを受けられなければ管理者に知らせる。契約の管理を切った会社は見ない', async () => {
  const s = setup();
  const made = await s.service.create(u1, { party: '株式会社エータ', title: '業務委託契約', startOn: '2027-01-01', endOn: '2027-06-30' });
  assert.ok(!('error' in made));
  await s.store.update('t1', made.contract.id, { ownerId: 'gone' }, 'u1');
  assert.deepEqual(await s.service.tick(at('2027-06-10')), { notified: 1, renewed: 0 });
  assert.deepEqual(s.notes.map((n) => n.userId), ['boss']);

  await s.repo.saveTenantSettings('t1', 'contracts', { enabled: false, storage: null }, 'boss');
  await s.store.update('t1', made.contract.id, { notified: [] }, 'u1');
  assert.deepEqual(await s.service.tick(at('2027-06-11')), { notified: 0, renewed: 0 });
});

test('削除できるのは入れた人と管理者だけ。ほかの会社の契約は見えない', async () => {
  const s = setup();
  const made = await s.service.create(u1, { party: '株式会社シータ', title: '秘密保持契約書' });
  assert.ok(!('error' in made));
  assert.match((await s.service.remove({ tenantId: 't1', userId: 'u2' }, made.contract.id)) ?? '', /入れた人と管理者だけ/);
  assert.equal(await s.service.get({ tenantId: 't2', userId: 'u1' }, made.contract.id), null);
  assert.deepEqual(await s.service.list({ tenantId: 't2', userId: 'u1' }), []);
  assert.equal(await s.service.remove(boss, made.contract.id), null);
  assert.equal(await s.service.get(u1, made.contract.id), null);
  assert.ok(s.audits.some((a) => a.action === 'contract.delete'));
});

test('ツール: 使えない人には使えないと答え、台帳を引き・直す（契約書の本文は返さない）', async () => {
  const s = setup();
  await s.service.create(u1, { party: '株式会社ベータ保守', title: 'サーバー保守契約', startOn: '2027-04-01', endOn: '2028-03-31', autoRenew: true, noticeDays: 90, renewMonths: 12 });
  await s.service.create(u1, { party: '株式会社ガンマ', title: '秘密保持契約書' });
  const tool = (name: string) => CONTRACT_TOOLS.find((t) => t.name === name)!;
  const ctx = (on: boolean) => ({
    tenantId: 't1', userId: 'u1', contracts: { service: s.service, access: async () => (on ? s.settings().contracts : null) },
  }) as unknown as ToolContext;

  const off = await tool('contracts.find').invoke({}, ctx(false)) as { available: boolean };
  assert.equal(off.available, false);

  const found = await tool('contracts.find').invoke({ query: '保守' }, ctx(true)) as { count: number; contracts: { party: string; noticeDeadline: string; path: string }[] };
  assert.equal(found.count, 1);
  assert.equal(found.contracts[0]!.party, '株式会社ベータ保守');
  assert.equal(found.contracts[0]!.noticeDeadline, '2028-01-01');
  assert.match(found.contracts[0]!.path, /^\/contracts\/ctr-/);

  const many = await tool('contracts.update').invoke({ query: '株式会社' }, ctx(true)) as { available: boolean; candidates?: unknown[] };
  assert.equal(many.available, false);
  assert.equal(many.candidates?.length, 2);
  const done = await tool('contracts.update').invoke({ query: 'ガンマ', status: 'cancel_requested' }, ctx(true)) as { available: boolean; contract: { status: string } };
  assert.equal(done.available, true);
  assert.equal(done.contract.status, '解約を申し出た');

  const noFile = await tool('contracts.register').invoke({}, ctx(true)) as { available: boolean; reason: string };
  assert.equal(noFile.available, false);
});

test('段 2: 名刺の会社名で、株式会社などを除いて同じ相手の契約を引く', async () => {
  const s = setup();
  await s.service.create(u1, { party: '株式会社ベータ保守', title: 'サーバー保守契約' });
  await s.service.create(u1, { party: 'ガンマ商事株式会社', title: '秘密保持契約書' });
  assert.deepEqual((await s.service.byCompany(u1, 'ベータ保守')).map((c) => c.party), ['株式会社ベータ保守']);
  assert.deepEqual((await s.service.byCompany(u1, '(株)ベータ保守')).map((c) => c.party), ['株式会社ベータ保守']);
  assert.deepEqual((await s.service.byCompany(u1, 'ガンマ商事')).map((c) => c.party), ['ガンマ商事株式会社']);
  assert.deepEqual(await s.service.byCompany(u1, '株式会社'), []);
  assert.deepEqual(await s.service.byCompany({ tenantId: 't2', userId: 'u1' }, 'ベータ保守'), []);
});

test('段 2: 契約書チェックで見直す（ドライブの契約書を本人のファイルに写して起こす）。期限の知らせに見直しを添える', async () => {
  const s = setup();
  await s.service.connectStorage(boss);
  const started: { userId: string; fileId: string }[] = [];
  const service = new ContractService({
    ...s.service.deps,
    reviewStarter: async (_t, userId, fileId) => { started.push({ userId, fileId }); return 'run-review-1'; },
  });
  const nda = SAMPLE.replace('サーバー保守契約書', '秘密保持契約書');
  const r = await service.importFile(u1, await s.upload('u1', nda, 'NDA.csv'));
  assert.ok(!('error' in r));
  // CSV は契約書チェックで読めない形なので断る
  const csv = await service.startReview(u1, r.contract.id);
  assert.ok('error' in csv);
  assert.match(csv.error, /PDF・Word・写真/);
  // PDF の契約書なら写して起こす
  const pdf = await service.importFile(u1, await s.upload('u1', nda.replace('2027年3月15日', '2027年3月16日'), '契約書.pdf'));
  assert.ok(!('error' in pdf));
  const ok = await service.startReview({ tenantId: 't1', userId: 'u2' }, pdf.contract.id);
  assert.deepEqual(ok, { runId: 'run-review-1' });
  assert.equal(started[0]!.userId, 'u2');
  assert.match(started[0]!.fileId, /^f-/);
  assert.ok(s.audits.some((a) => a.action === 'contract.review'));
  // 契約書チェックを使えない人には始めない
  const none = new ContractService({ ...s.service.deps, reviewStarter: async () => null });
  assert.ok('error' in (await none.startReview(u1, pdf.contract.id)));
  // ドライブに契約書の無い契約は見直せない
  const manual = await service.create(u1, { party: '株式会社イプシロン', title: '業務委託契約', startOn: '2027-01-01', endOn: '2027-12-31', autoRenew: true, noticeDays: 30, renewMonths: 12 });
  assert.ok(!('error' in manual));
  assert.ok('error' in (await service.startReview(u1, manual.contract.id)));
  // ドライブに契約書がある契約の申し出の期限の知らせに、見直しを添える
  await service.tick(at('2027-11-03'));
  const notice = s.notes.find((n) => /株式会社ベータ保守の秘密保持/.test(n.title) && /解約の申し出の期限/.test(n.title));
  assert.ok(notice, '申し出の期限の 60 日前の知らせが届く');
  assert.match(notice.body, /契約書チェックで見直す/);
  const plain = s.notes.find((n) => /株式会社イプシロン/.test(n.title));
  assert.ok(plain && !/契約書チェックで見直す/.test(plain.body));
});
