/**
 * @file お知らせの作成の段 1 の単体テスト（仕様書 第35.17節）。期間の読み方・下書き・承認した中身だけを出す・Web（WordPress が無いときは写す）・
 * LINE の一斉配信（無料の範囲を超えたら送らない）・店頭の画面・予約・期間の後。見本の LINE と、記憶だけの店頭の画面で確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  AnnouncementService, MemoryAnnouncementStore, MockLineClient, StubLlmProvider, ANNOUNCEMENT_TOOLS, plainDraft, readPeriod, announcementDigest, endedTitle,
  type AnnouncementSignage, type Repository, type TenantCredential, type ToolContext,
} from '../src/index.js';

function setup(opts: { line?: boolean; signage?: boolean } = {}) {
  MockLineClient.clear();
  let settings: TenantSettings = {
    ...DEFAULT_TENANT_SETTINGS,
    company: { ...DEFAULT_TENANT_SETTINGS.company, legalName: '株式会社アルファ商事', shortName: 'アルファ', phone: '03-0000-0000' },
    announcements: { enabled: true, webPublish: 'publish', webCategory: 'お知らせ', screens: null },
    inquiries: { ...DEFAULT_TENANT_SETTINGS.inquiries, line: opts.line === false ? null : { botName: '見本', basicId: '@mock', connectedBy: 'boss', connectedAt: '2026-10-01T00:00:00Z' } },
  };
  const creds = new Map<string, TenantCredential>();
  if (opts.line !== false) creds.set('line', { tenantId: 't1', kind: 'line', secretEnc: `enc:${JSON.stringify({ secret: 's', token: '' })}`, meta: { mock: true }, updatedBy: 'boss', updatedAt: '' } as TenantCredential);
  const audits: string[] = [];
  const notes: { title: string; body: string }[] = [];
  const repo = {
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    getTenantCredential: async (_t: string, kind: string) => creds.get(kind) ?? null,
    findTenantById: async () => ({ id: 't1', name: '株式会社アルファ商事' }),
    listUsers: async () => [{ id: 'boss', displayName: '責任者', roles: ['admin'], status: 'active' }],
    listUserGroupIds: async () => [],
    listTenantIds: async () => ['t1'],
    getUserSettings: async () => ({ notifications: { kinds: { announcement: true } } }),
    createNotification: async (n: { title: string; body: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string }) => { audits.push(e.action); },
  } as unknown as Repository;
  const screens: Record<string, string[]> = { s1: [], s2: [] };
  const assets = new Map<string, Uint8Array>();
  const signage: AnnouncementSignage = {
    enabled: async () => opts.signage !== false,
    screens: async () => [{ id: 's1', name: '受付' }, { id: 's2', name: '待合' }],
    addImage: async (_t, _u, png) => { const id = `asset-${assets.size + 1}`; assets.set(id, png); return { assetId: id }; },
    addToFlows: async (_t, _u, assetId, ids) => { for (const id of ids) screens[id] = [assetId, ...screens[id]!]; return ids.map((id) => (id === 's1' ? '受付' : '待合')); },
    removeAsset: async (_t, _u, assetId) => { assets.delete(assetId); for (const k of Object.keys(screens)) screens[k] = screens[k]!.filter((x) => x !== assetId); },
  };
  const store = new MemoryAnnouncementStore();
  const service = new AnnouncementService({
    store, repo, box: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.slice(4) } as never, llmFor: async () => new StubLlmProvider(),
    line: { repo, box: { encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.slice(4) } as never, sourceFor: () => 'mock' },
    signage, submitter: async () => 'run-1',
  });
  return { service, store, screens, assets, audits, notes, settings: () => settings };
}

const who = { tenantId: 't1', userId: 'u1' };

test('期間を読む: 「12/28〜1/5」は年をまたぎ、「8月13日から8月16日」も読む', () => {
  assert.deepEqual(readPeriod('年末年始の休業 12/28〜1/5', '2026-12-01'), { start: '2026-12-28', end: '2027-01-05' });
  assert.deepEqual(readPeriod('夏季休業 8月13日から8月16日', '2026-07-20'), { start: '2026-08-13', end: '2026-08-16' });
  assert.deepEqual(readPeriod('臨時休業 10/10', '2026-10-04'), { start: '2026-10-10', end: '2026-10-10' });
  assert.deepEqual(readPeriod('新しいサービスを始めました', '2026-10-04'), { start: null, end: null });
});

test('下書き（推論なし）: 休業の題名と本文、LINE は 200 字まで、「LINE だけで」は LINE だけ、つないでいない出し先は外す', () => {
  const base = { today: '2026-12-01', company: { name: 'アルファ', phone: '03-0000-0000', hours: '' }, selfReference: '当社' };
  const d = plainDraft({ ...base, request: '年末年始の休業のお知らせを出して。12/28〜1/5', available: ['web', 'line', 'signage'] });
  assert.equal(d.title, '年末年始の休業のお知らせ');
  assert.match(d.body, /12 月 28 日（月）〜1 月 5 日（火）は休業/);
  assert.match(d.body, /03-0000-0000/);
  assert.ok(d.texts.line.length <= 200);
  assert.deepEqual(d.channels, ['web', 'line', 'signage']);
  assert.deepEqual(plainDraft({ ...base, request: '夏季休業のお知らせ、LINE だけで。8/13〜8/16', available: ['web', 'line', 'signage'] }).channels, ['line']);
  assert.deepEqual(plainDraft({ ...base, request: '臨時休業 12/10', available: ['web'] }).channels, ['web']);
});

test('出す: 承認した中身だけを出し、Web（WordPress が無ければ写す）・LINE の一斉配信・店頭の画面に出す', async () => {
  const { service, store, screens, audits } = setup();
  const r = await service.draft(who, '年末年始の休業のお知らせを出して。12/28〜1/5');
  assert.ok('announcement' in r);
  if (!('announcement' in r)) return;
  const id = r.announcement.id;
  const p = await service.preview(who, id);
  assert.deepEqual(p!.problems, []);
  assert.deepEqual(p!.line, { followers: 37, limit: 200, used: 0 });
  assert.deepEqual(p!.screens, ['受付', '待合']);
  assert.match(p!.web, /文を写して使う/);
  await service.submit(who, id);
  // 承認の後に直されたら出さない
  const before = p!.digest;
  await store.update('t1', id, { title: '直した題名' });
  const stale = await service.publish(who, id, before);
  assert.ok('error' in stale && /承認した後に/.test(stale.error));
  const a = (await store.get('t1', id))!;
  const ok = await service.publish(who, id, announcementDigest(a));
  assert.ok('status' in ok && ok.status === 'published');
  assert.deepEqual(MockLineClient.pushed('t1').map((x) => [x.to, x.count]), [['*', 37]], '友だち全員に 1 回の一斉配信');
  assert.equal(screens['s1']!.length, 1, '店頭の画面の流れの先頭に足す');
  const outs = await store.outputs('t1', id);
  assert.deepEqual(outs.map((o) => [o.channel, o.status]).sort(), [['line', 'done'], ['signage', 'done'], ['web', 'done']]);
  assert.equal(outs.find((o) => o.channel === 'web')!.result.draft, true, 'WordPress が無ければ写して使う');
  // 休業のお知らせの期間を、会社の休業日として覚える（朝のブリーフなどが休む。第35.7節）
  assert.equal(await store.closedOn('t1', r.announcement.startDate!), true);
  assert.ok(audits.includes('announcement.closure'));
  assert.ok(['announcement.draft', 'announcement.submit', 'announcement.approve', 'announcement.line', 'announcement.signage', 'announcement.publish'].every((x) => audits.includes(x)));
  assert.match((await service.copy(who, id))!.html, /<h2>直した題名|<h2>年末年始/);
});

test('LINE: 今月の無料の範囲を超えるなら承認へ進めず、出すときも送らない（ほかの出し先は止めない）', async () => {
  const { service, store, notes } = setup();
  const r = await service.draft(who, '臨時休業のお知らせ 10/10');
  if (!('announcement' in r)) throw new Error('下書きを作れない');
  const id = r.announcement.id;
  // 今月すでに 180 通使っている（残り 20 通、友だち 37 人）
  const client = new MockLineClient('t1');
  for (let i = 0; i < 180; i += 1) await client.push('U', 'x');
  const p = await service.preview(who, id);
  assert.ok(p!.problems.some((x) => /今月の残りは 20 通で、このお知らせは 37 通/.test(x)));
  assert.ok('error' in await service.submit(who, id), '承認へ進めない');
  // 承認の後に使い切った場合も、出すときにもう一度確かめて送らない
  const a = (await store.get('t1', id))!;
  await service.publish(who, id, announcementDigest(a));
  const outs = await store.outputs('t1', id);
  assert.equal(outs.find((o) => o.channel === 'line')!.status, 'failed');
  assert.equal(outs.find((o) => o.channel === 'signage')!.status, 'done', 'ほかの出し先は止めない');
  assert.ok(notes.some((n) => /出せなかった出し先/.test(n.title)));
});

test('予約と期間の後: 予約の時刻に出し、期間が終わったら店頭の画面から外して終わったにする', async () => {
  const { service, store, screens, assets } = setup();
  const r = await service.draft(who, '臨時休業のお知らせ 10/10');
  if (!('announcement' in r)) throw new Error('下書きを作れない');
  const id = r.announcement.id;
  const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
  assert.equal(await service.update(who, id, { publishAt: at, startDate: '2026-10-10', endDate: '2026-10-10' }), null);
  assert.equal(await service.update(who, id, { endDate: '2026-10-01' }), '期間の終わりが始めより前です');
  const a = (await store.get('t1', id))!;
  const s = await service.publish(who, id, announcementDigest(a));
  assert.ok('status' in s && s.status === 'scheduled');
  assert.equal(MockLineClient.pushed('t1').length, 0, '予約の時刻までは送らない');
  assert.deepEqual(await service.tick(new Date(Date.now() + 3_600_000)), { published: 0, ended: 0 });
  assert.equal((await service.tick(new Date(Date.now() + 3 * 3_600_000))).published, 1);
  assert.equal(MockLineClient.pushed('t1').length, 1);
  assert.equal(screens['s1']!.length, 1);
  // 期間（10/10）の次の日になったら片付ける
  assert.equal((await service.tick(new Date('2026-10-11T00:30:00Z'))).ended, 1);
  assert.equal(screens['s1']!.length, 0, '店頭の画面から外す');
  assert.equal(assets.size, 0);
  assert.equal((await store.get('t1', id))!.status, 'ended');
  assert.equal(endedTitle('臨時休業のお知らせ'), '（終了しました）臨時休業のお知らせ');
});

test('ツール: 承認の前に出し先ごとの見え方と送る数を見せる。出すツールは社外への送信', async () => {
  const { service } = setup();
  const r = await service.draft(who, '年末年始の休業のお知らせ 12/28〜1/5');
  if (!('announcement' in r)) throw new Error('下書きを作れない');
  const ctx = { tenantId: 't1', userId: 'boss', announcements: { service, access: async () => ({ enabled: true }) } } as unknown as ToolContext;
  const publish = ANNOUNCEMENT_TOOLS.find((t) => t.name === 'announcements.publish')!;
  assert.equal(publish.risk, 'external-send');
  const prepared = await publish.prepare!({ announcementId: r.announcement.id }, ctx);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind === 'ready') {
    assert.match(prepared.shown ?? '', /■ LINE（友だち 37 人に一斉配信。今月の残り 200 通/);
    assert.match(prepared.shown ?? '', /■ 店頭の画面（受付・待合）/);
    assert.equal(prepared.audience, 'external');
  }
  const off = { ...ctx, announcements: { service, access: async () => null } } as unknown as ToolContext;
  assert.equal((await ANNOUNCEMENT_TOOLS.find((t) => t.name === 'announcements.list')!.invoke({}, off) as { available: boolean }).available, false);
});
