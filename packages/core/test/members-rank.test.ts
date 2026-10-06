/**
 * @file 会員のランクと店頭サイネージの特典の単体テスト（仕様書 第40.19節）。境の回数を来店の分布から決める・少ない会員では決めない・
 * 月に 1 回の決め直し・管理者が決めた境と自動に戻す・ランクだけの特典・会員証のランク・ツール・サイネージに特典の 1 枚を流す・作り直す・外す。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  MEMBER_TOOLS, MemberService, MemoryMemberStore, rankCutOf, rankOf, renderCardPage, rewardLines, rewardScreenSvg,
  type Repository, type SignageService, type ToolContext,
} from '../src/index.js';

/** 2026-10-06（火）9:00（日本時間） */
const NOW = new Date('2026-10-06T00:00:00Z');
const DAY = 86_400_000;

function setup() {
  let clock = NOW;
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, members: { ...DEFAULT_TENANT_SETTINGS.members, enabled: true } };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '店長', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '店員', roles: ['member'], status: 'active' },
  ];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    appendAudit: async () => undefined,
  } as unknown as Repository;
  // サイネージの代わり（足した素材・消した素材・流れの先頭に足したもの）
  const signageLog = { added: [] as string[], deleted: [] as string[], prepended: [] as string[], enabled: true };
  let n = 0;
  const signage = {
    settings: async () => ({ enabled: signageLog.enabled, color: null }),
    overview: async () => ({ screens: [{ id: 's1' }, { id: 's2' }] }),
    addAsset: async (_t: string, _u: string, up: { name: string }) => { const id = `a${++n}`; signageLog.added.push(`${id}:${up.name}`); return { asset: { id }, existing: false }; },
    deleteAsset: async (_t: string, _u: string, id: string) => { signageLog.deleted.push(id); return { screens: [] }; },
    prependToFlows: async (_t: string, _u: string, screen: string, head: { assetId: string }[]) => { signageLog.prepended.push(`${screen}:${head[0]!.assetId}`); return true; },
  } as unknown as SignageService;
  const store = new MemoryMemberStore();
  store.now = () => new Date(clock.getTime() + store.records.length);
  const service = new MemberService({ store, repo, signage, now: () => clock });
  return { service, store, signageLog, settings: () => settings, setClock: (d: Date) => { clock = d; } };
}

const boss = { tenantId: 't1', userId: 'boss' };
const u1 = { tenantId: 't1', userId: 'u1' };

/** 会員を作り、決めた回数だけ別の日に来店させる（最後の日の時刻に時計を置く）。 */
async function withVisits(s: ReturnType<typeof setup>, counts: number[]) {
  const ids: string[] = [];
  for (const [i] of counts.entries()) {
    const r = await s.service.create(u1, { nickname: `会員${i + 1}` });
    assert.ok(!('error' in r));
    ids.push(r.member.id);
  }
  const days = Math.max(...counts);
  for (let d = 0; d < days; d++) {
    s.setClock(new Date(NOW.getTime() + d * DAY));
    for (const [i, c] of counts.entries()) if (c > d) assert.ok(!('error' in (await s.service.visit(u1, ids[i]!))));
  }
  return ids;
}

test('境の回数: 来店のある会員の上からおよそ 1 割をゴールド、3 割までをシルバー。少なければ決めない。下限を置く', () => {
  assert.deepEqual(rankCutOf([5, 4, 3]), { silver: null, gold: null });
  assert.deepEqual(rankCutOf([20, 15, 12, 10, 8, 6, 5, 4, 3, 2, 1, 1]), { silver: 10, gold: 15 });
  // 来店の少ない店でも、1 回でシルバーにはしない。ゴールドはシルバーより多い
  assert.deepEqual(rankCutOf(new Array(10).fill(1)), { silver: 2, gold: 3 });
  assert.deepEqual(rankCutOf([4, 4, 4, 4, 4, 4, 4, 4, 4, 4]), { silver: 4, gold: 5 });
  assert.equal(rankOf(15, { silver: 10, gold: 15 }), 'gold');
  assert.equal(rankOf(10, { silver: 10, gold: 15 }), 'silver');
  assert.equal(rankOf(9, { silver: 10, gold: 15 }), 'regular');
  assert.equal(rankOf(99, { silver: null, gold: null }), 'regular');
});

test('ランク: 見張りが初めにすぐ境を決め、会員に付く。同じ月は決め直さず、次の月の 8 時から決め直す', async () => {
  const s = setup();
  const ids = await withVisits(s, [12, 9, 7, 5, 4, 3, 2, 2, 1, 1]);
  await s.service.tick(new Date(NOW.getTime() + 12 * DAY));
  const m = s.settings().members;
  assert.deepEqual([m.rankSilver, m.rankGold], [7, 12]);
  const list = await s.service.list(u1);
  const byId = new Map(list.map((x) => [x.id, x]));
  assert.equal(byId.get(ids[0]!)!.rank, 'gold');
  assert.equal(byId.get(ids[1]!)!.rank, 'silver');
  assert.equal(byId.get(ids[2]!)!.rank, 'silver');
  assert.equal(byId.get(ids[3]!)!.rank, 'regular');
  assert.equal(byId.get(ids[0]!)!.yearVisits, 12);
  const at = m.rankAt;
  await s.service.tick(new Date('2026-10-30T00:00:00Z'));
  assert.equal(s.settings().members.rankAt, at);
  // 11/1 の 7 時（日本時間）はまだ、8 時を過ぎたら決め直す
  await s.service.tick(new Date('2026-10-31T22:00:00Z'));
  assert.equal(s.settings().members.rankAt, at);
  await s.service.tick(new Date('2026-10-31T23:30:00Z'));
  assert.notEqual(s.settings().members.rankAt, at);
});

test('ランク: 来店のある会員が 10 人に満たなければ決めない（全員が一般）', async () => {
  const s = setup();
  await withVisits(s, [30, 1]);
  await s.service.tick(new Date(NOW.getTime() + 30 * DAY));
  assert.equal(s.settings().members.rankGold, null);
  assert.ok((await s.service.list(u1)).every((m) => m.rank === 'regular'));
});

test('管理者が境を決めると自動では変わらない。店員は決められない。自動に戻すとすぐ決め直す', async () => {
  const s = setup();
  await withVisits(s, [12, 9, 7, 5, 4, 3, 2, 2, 1, 1]);
  assert.match((await s.service.saveSettings(u1, { rankSilver: 3, rankGold: 6 })) ?? '', /管理者だけ/);
  assert.match((await s.service.saveSettings(boss, { rankSilver: 6, rankGold: 6 })) ?? '', /ゴールドはシルバーより多い/);
  assert.equal(await s.service.saveSettings(boss, { rankSilver: 3, rankGold: 6 }), null);
  assert.equal(s.settings().members.rankAuto, false);
  await s.service.tick(new Date('2026-11-01T00:00:00Z'));
  assert.deepEqual([s.settings().members.rankSilver, s.settings().members.rankGold], [3, 6]);
  assert.equal(await s.service.saveSettings(boss, { rankAuto: true }), null);
  assert.equal(s.settings().members.rankAuto, true);
  assert.deepEqual([s.settings().members.rankSilver, s.settings().members.rankGold], [7, 12]);
});

test('ランクだけの特典: そのランク以上の会員の会員証にだけ出て、その会員だけが使える。会員証にランクが出る', async () => {
  const s = setup();
  const ids = await withVisits(s, [12, 9, 7, 5, 4, 3, 2, 2, 1, 1]);
  await s.service.recomputeRanks('t1');
  const gold = await s.service.createReward(boss, { name: 'ゴールドの特別なケーキ', points: 3, minRank: 'gold' });
  const silver = await s.service.createReward(boss, { name: 'シルバー以上のドリンク', points: 2, minRank: 'silver' });
  assert.ok(!('error' in gold) && !('error' in silver));
  assert.ok('error' in (await s.service.createReward(boss, { name: 'x', points: 1, minRank: 'platinum' })));
  const keyOf = async (id: string) => (await s.service.cardKeyOf(u1, id))!;
  const goldCard = (await s.service.byCard('t1', await keyOf(ids[0]!)))!;
  assert.deepEqual(goldCard.rewards.map((r) => r.name).sort(), ['ゴールドの特別なケーキ', 'シルバー以上のドリンク'].sort());
  const silverCard = (await s.service.byCard('t1', await keyOf(ids[1]!)))!;
  assert.deepEqual(silverCard.rewards.map((r) => r.name), ['シルバー以上のドリンク']);
  const regularCard = (await s.service.byCard('t1', await keyOf(ids[9]!)))!;
  assert.deepEqual(regularCard.rewards, []);
  const used = await s.service.useReward(u1, ids[9]!, gold.reward.id);
  assert.ok('error' in used);
  assert.match(used.error, /ランクだけの特典/);
  assert.ok(!('error' in (await s.service.useReward(u1, ids[0]!, gold.reward.id))));
  const page = renderCardPage('見本の店', goldCard, '<svg/>', 365);
  assert.match(page, /ゴールド会員/);
  assert.doesNotMatch(renderCardPage('見本の店', regularCard, '<svg/>', 365), /一般会員/);
});

test('ツール: ランクで会員を絞り、ランクの境を見る・決める（管理者だけ）、ランクだけの特典を作る', async () => {
  const s = setup();
  await withVisits(s, [12, 9, 7, 5, 4, 3, 2, 2, 1, 1]);
  await s.service.recomputeRanks('t1');
  const tool = (name: string) => MEMBER_TOOLS.find((t) => t.name === name)!;
  const ctx = (userId: string) => ({ tenantId: 't1', userId, members: { service: s.service, access: async () => s.settings().members } }) as unknown as ToolContext;
  const golds = await tool('members.find').invoke({ rank: 'gold' }, ctx('u1')) as { count: number; members: { rank: string; yearVisits: number }[] };
  assert.equal(golds.count, 1);
  assert.ok(golds.members.every((m) => m.rank === 'ゴールド'));
  const shown = await tool('members.rank').invoke({ action: 'show' }, ctx('u1')) as { gold: number; silver: number; auto: boolean; counts: Record<string, number> };
  assert.deepEqual([shown.gold, shown.silver, shown.auto], [12, 7, true]);
  assert.deepEqual(shown.counts, { ゴールド: 1, シルバー: 2, 一般: 7 });
  const denied = await tool('members.rank').invoke({ action: 'set', gold: 20 }, ctx('u1')) as { available: boolean; reason: string };
  assert.equal(denied.available, false);
  const set = await tool('members.rank').invoke({ action: 'set', gold: 20 }, ctx('boss')) as { gold: number; silver: number; auto: boolean };
  assert.deepEqual([set.gold, set.silver, set.auto], [20, 7, false]);
  const made = await tool('members.rewards').invoke({ action: 'create', name: 'ゴールドだけのおまけ', points: 1, minRank: 'gold' }, ctx('boss')) as { available: boolean };
  assert.equal(made.available, true);
  const list = await tool('members.rewards').invoke({ action: 'list' }, ctx('u1')) as { rewards: { name: string; who: string }[] };
  assert.equal(list.rewards.find((r) => r.name === 'ゴールドだけのおまけ')!.who, 'ゴールドだけ');
});

test('サイネージ: 流すにすると特典の 1 枚をすべての画面の先頭に足し、中身が同じなら作り直さず、変われば差し替え、切れば外す', async () => {
  const s = setup();
  // 特典が無いうちは何も足さない
  assert.equal(await s.service.saveSettings(boss, { signage: true }), null);
  assert.deepEqual(s.signageLog.added, []);
  await s.service.createReward(boss, { name: 'ドリンク 1 杯', points: 10 });
  await s.service.refreshSignage('t1');
  assert.deepEqual(s.signageLog.added, ['a1:会員の特典']);
  assert.deepEqual(s.signageLog.prepended, ['s1:a1', 's2:a1']);
  assert.equal(await s.service.refreshSignage('t1'), 'same');
  const r = await s.service.createReward(boss, { name: 'ケーキ', points: 30, minRank: 'gold' });
  assert.ok(!('error' in r));
  await s.service.refreshSignage('t1');
  assert.equal(s.settings().members.signageAssetId, 'a2');
  assert.deepEqual(s.signageLog.deleted, ['a1']);
  // 期間の過ぎた特典・止めた特典は流さない
  await s.service.updateReward(boss, r.reward.id, { status: 'stopped' });
  await s.service.refreshSignage('t1');
  assert.equal(s.settings().members.signageAssetId, 'a3');
  // 切れば外す
  assert.equal(await s.service.saveSettings(boss, { signage: false }), null);
  assert.equal(s.settings().members.signageAssetId, null);
  assert.deepEqual(s.signageLog.deleted, ['a1', 'a2', 'a3']);
  // サイネージを使っていない会社では流さない
  s.signageLog.enabled = false;
  await s.service.saveSettings(boss, { signage: true });
  assert.equal(s.settings().members.signageAssetId, null);
});

test('サイネージの 1 枚: ポイントの少ない順に 6 つまで、誕生月とランクの印。字は組んで、名前は逃がす', () => {
  const base = { status: 'active' as const, validFrom: null, validTo: null, createdAt: '', birthdayOnly: false, minRank: 'regular' as const };
  const lines = rewardLines([
    { ...base, id: '1', name: 'ケーキ', points: 30, minRank: 'gold' },
    { ...base, id: '2', name: 'ドリンク', points: 10 },
    { ...base, id: '3', name: '誕生月のデザート', points: 1, birthdayOnly: true },
    ...Array.from({ length: 6 }, (_, i) => ({ ...base, id: `x${i}`, name: `おまけ${i}`, points: 50 + i })),
  ]);
  assert.equal(lines.length, 6);
  assert.deepEqual(lines.slice(0, 3).map((l) => [l.name, l.points, l.who]), [['誕生月のデザート', 1, '誕生月'], ['ドリンク', 10, ''], ['ケーキ', 30, 'ゴールドだけ']]);
  const svg = rewardScreenSvg([{ name: '<b>おまけ</b>', points: 5, who: '' }], '#336699');
  assert.match(svg, /会員の特典/);
  assert.match(svg, /&lt;b&gt;おまけ/);
  assert.match(svg, /fill="#336699"/);
});
