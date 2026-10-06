/**
 * @file 会員とポイントの段 1 の単体テスト（仕様書 第40.17節）。会員を作る・会員証の鍵・来店は 1 日 1 回・購入は率で換算して金額を残さない・
 * 特典はポイントが足りるときだけ・マイナスにしない・取り消し（その日は店員、前の日は管理者）・調整・まとめる・削除・特典は管理者だけ・
 * 有効期限の失効・LINE の会員証（ID トークンを確かめ、初めてなら呼び名を聞く）・問い合わせの連絡先とのつなぎ・会員証のページ・ツール。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, memberCardKeyOf, type TenantSettings } from '@m2office/shared';
import {
  MEMBER_TOOLS, MemberService, MemoryMemberStore, MockLineVerifier, memberCardUrl, renderCardPage, renderMemberCard,
  type Repository, type ToolContext,
} from '../src/index.js';

/** 2026-10-06（火）9:00（日本時間） */
const NOW = new Date('2026-10-06T00:00:00Z');

function setup(over: Partial<TenantSettings['members']> = {}) {
  let clock = NOW;
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, members: { ...DEFAULT_TENANT_SETTINGS.members, enabled: true, ...over } };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '店長', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '店員', roles: ['member'], status: 'active' },
  ];
  const audits: { action: string }[] = [];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    appendAudit: async (e: { action: string }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryMemberStore();
  store.now = () => new Date(clock.getTime() + store.records.length + store.members.size);
  const service = new MemberService({ store, repo, lineFor: () => new MockLineVerifier(), now: () => clock });
  return { service, store, audits, settings: () => settings, setClock: (d: Date) => { clock = d; } };
}

const boss = { tenantId: 't1', userId: 'boss' };
const u1 = { tenantId: 't1', userId: 'u1' };

async function member(s: ReturnType<typeof setup>, nickname = 'たなか', phone = '') {
  const r = await s.service.create(u1, { nickname, phone });
  assert.ok(!('error' in r));
  return r;
}

test('会員を作る: 呼び名は必須・電話は任意（9 桁以上）・会員番号は連番・会員証の鍵は推測できない長さ', async () => {
  const s = setup();
  assert.ok('error' in (await s.service.create(u1, { nickname: ' ' })));
  assert.ok('error' in (await s.service.create(u1, { nickname: 'すずき', phone: '123' })));
  const a = await member(s, 'たなか', '090-1234-5678');
  const b = await member(s, 'すずき');
  assert.equal(a.member.number, 1);
  assert.equal(b.member.number, 2);
  assert.match(a.cardKey, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a.cardKey, b.cardKey);
  assert.equal(memberCardKeyOf(memberCardUrl('https://a.example.jp', a.cardKey)), a.cardKey);
  assert.equal(memberCardKeyOf(a.cardKey), a.cardKey);
  const card = await s.service.byCard('t1', a.cardKey);
  assert.equal(card?.member.nickname, 'たなか');
  assert.equal(await s.service.byCard('t2', a.cardKey), null);
  assert.equal(await s.service.byCard('t1', 'short'), null);
});

test('来店は 1 日 1 回まで。購入は率で換算し（端数は切り捨て）、金額は残さない', async () => {
  const s = setup();
  const { member: m } = await member(s);
  const v = await s.service.visit(u1, m.id);
  assert.ok(!('error' in v));
  assert.equal(v.points, 1);
  const again = await s.service.visit(u1, m.id);
  assert.ok('error' in again);
  assert.match(again.error, /1 日 1 回/);
  const p = await s.service.purchase(u1, m.id, 1580);
  assert.ok(!('error' in p));
  assert.equal(p.points, 15);
  assert.equal(p.member.balance, 16);
  assert.ok('error' in (await s.service.purchase(u1, m.id, 80)));
  assert.ok('error' in (await s.service.purchase(u1, m.id, -100)));
  assert.ok('error' in (await s.service.purchase(u1, m.id, 12.5)));
  // 記録に金額は無い
  const rec = s.store.records.find((r) => r.kind === 'purchase')!;
  assert.doesNotMatch(JSON.stringify(rec), /1580/);
  // 次の日はまた来店のポイントを付けられる
  s.setClock(new Date('2026-10-07T01:00:00Z'));
  assert.ok(!('error' in (await s.service.visit(u1, m.id))));
});

test('特典: 作るのは管理者だけ、ポイントが足りるときだけ使え、期間の外と止めたものは使えない', async () => {
  const s = setup();
  const { member: m, cardKey } = await member(s);
  assert.ok('error' in (await s.service.createReward(u1, { name: 'ドリンク 1 杯', points: 10 })));
  const drink = await s.service.createReward(boss, { name: 'ドリンク 1 杯', points: 10 });
  const future = await s.service.createReward(boss, { name: '秋の特典', points: 1, validFrom: '2026-11-01' });
  assert.ok(!('error' in drink) && !('error' in future));
  await s.service.purchase(u1, m.id, 900);
  const short = await s.service.useReward(u1, m.id, drink.reward.id);
  assert.ok('error' in short);
  assert.match(short.error, /あと 1 ポイント/);
  assert.ok('error' in (await s.service.useReward(u1, m.id, future.reward.id)));
  await s.service.visit(u1, m.id);
  const card = await s.service.byCard('t1', cardKey);
  assert.deepEqual(card?.rewards.map((r) => [r.name, r.enough]), [['ドリンク 1 杯', true]]);
  const used = await s.service.useReward(u1, m.id, drink.reward.id);
  assert.ok(!('error' in used));
  assert.equal(used.member.balance, 0);
  assert.equal(await s.service.updateReward(boss, drink.reward.id, { status: 'stopped' }), null);
  assert.equal((await s.service.byCard('t1', cardKey))?.rewards.length, 0);
});

test('取り消し: その日の記録は店員が、前の日は管理者が取り消す。マイナスになる取り消しと 2 度目は断る', async () => {
  const s = setup();
  const { member: m } = await member(s);
  await s.service.createReward(boss, { name: '割引券', points: 5 });
  const buy = await s.service.purchase(u1, m.id, 500);
  assert.ok(!('error' in buy));
  const buyId = s.store.records.at(-1)!.id;
  const reward = (await s.service.rewards(u1))[0]!;
  await s.service.useReward(u1, m.id, reward.id);
  // 特典を使った後に購入を取り消すとマイナスになるので断る
  assert.match((await s.service.undo(u1, buyId)) ?? '', /足りない/);
  const useId = s.store.records.at(-1)!.id;
  assert.equal(await s.service.undo(u1, useId), null);
  assert.equal(await s.service.undo(u1, useId), 'もう取り消してあります');
  // 次の日になると店員は取り消せず、管理者は取り消せる（監査ログに残す）
  s.setClock(new Date('2026-10-07T01:00:00Z'));
  assert.match((await s.service.undo(u1, buyId)) ?? '', /管理者だけ/);
  assert.equal(await s.service.undo(boss, buyId), null);
  assert.ok(s.audits.some((a) => a.action === 'member.undo'));
  const d = await s.service.get(u1, m.id);
  assert.equal(d!.member.balance, 0);
  assert.equal(d!.points.filter((p) => p.reversed).length, 2);
});

test('調整は理由が要り、マイナスにはしない。来店を取り消すと来店の回数に数えない', async () => {
  const s = setup();
  const { member: m } = await member(s);
  assert.ok('error' in (await s.service.adjust(u1, m.id, 5, '')));
  assert.ok('error' in (await s.service.adjust(u1, m.id, -1, 'まちがい')));
  const r = await s.service.adjust(u1, m.id, 5, 'お詫び');
  assert.ok(!('error' in r));
  assert.equal(r.member.balance, 5);
  await s.service.visit(u1, m.id);
  const visitId = s.store.records.at(-1)!.id;
  assert.equal((await s.service.get(u1, m.id))!.member.visits, 1);
  assert.equal(await s.service.undo(u1, visitId), null);
  const after = (await s.service.get(u1, m.id))!.member;
  assert.equal(after.visits, 0);
  assert.equal(after.lastVisitAt, null);
  // 取り消した日でも、もう一度来店を付けられる
  assert.ok(!('error' in (await s.service.visit(u1, m.id))));
});

test('まとめる（管理者だけ）: ポイントと LINE のつながりを移し、古い会員証はまとめた先を開く。削除は管理者だけ', async () => {
  const s = setup({ liffId: '1234567890-AbCdEfGh', lineLoginChannelId: '1234567890' });
  const a = await member(s, 'たなか', '09012345678');
  const line = await s.service.lineSignIn('t1', 'mock:abc:たなか', 'たなか');
  assert.ok('cardKey' in line);
  const b = (await s.service.byCard('t1', line.cardKey))!.member;
  await s.service.adjust(u1, b.id, 7, '開店の特典');
  const cand = await s.service.get(u1, a.member.id);
  assert.deepEqual(cand!.candidates.map((c) => c.id), [b.id]);
  assert.match((await s.service.merge(u1, b.id, a.member.id)) ?? '', /管理者だけ/);
  assert.equal(await s.service.merge(boss, b.id, a.member.id), null);
  const merged = (await s.service.byCard('t1', line.cardKey))!;
  assert.equal(merged.member.id, a.member.id);
  assert.equal(merged.member.balance, 7);
  assert.equal(merged.member.line, true);
  assert.equal((await s.service.list(u1)).length, 1);
  assert.match((await s.service.remove(u1, a.member.id)) ?? '', /管理者だけ/);
  assert.equal(await s.service.remove(boss, a.member.id), null);
  assert.equal(await s.service.byCard('t1', a.cardKey), null);
  assert.ok(s.audits.some((x) => x.action === 'member.merge') && s.audits.some((x) => x.action === 'member.delete'));
});

test('LINE の会員証: 設定が無ければ使えず、ID トークンを確かめられなければ断り、初めてなら呼び名を聞いて会員にする', async () => {
  const off = setup();
  assert.ok('error' in (await off.service.lineSignIn('t1', 'mock:abc')));
  const s = setup({ liffId: '1234567890-AbCdEfGh', lineLoginChannelId: '1234567890' });
  assert.ok('error' in (await s.service.lineSignIn('t1', 'forged-token')));
  const first = await s.service.lineSignIn('t1', 'mock:u100:さとう');
  assert.deepEqual(first, { needsNickname: true, suggested: 'さとう' });
  const joined = await s.service.lineSignIn('t1', 'mock:u100:さとう', 'さとう');
  assert.ok('cardKey' in joined);
  const again = await s.service.lineSignIn('t1', 'mock:u100:さとう');
  assert.deepEqual(again, { cardKey: joined.cardKey });
  // 問い合わせの LINE のお客様・電話と同じ人の会員
  assert.equal((await s.service.findForContact('t1', { lineUserId: 'Uu100' }))?.nickname, 'さとう');
  await member(s, 'やまだ', '03-1234-5678');
  assert.equal((await s.service.findForContact('t1', { phone: '0312345678' }))?.nickname, 'やまだ');
  assert.equal(await s.service.findForContact('t1', { phone: '1234' }), null);
});

test('設定を直せるのは管理者だけ（値の範囲と LIFF ID の形を確かめる）', async () => {
  const s = setup();
  assert.match((await s.service.saveSettings(u1, { yenPerPoint: 200 })) ?? '', /管理者だけ/);
  assert.match((await s.service.saveSettings(boss, { yenPerPoint: 0 })) ?? '', /1〜/);
  assert.match((await s.service.saveSettings(boss, { liffId: 'bad' })) ?? '', /LIFF ID/);
  assert.equal(await s.service.saveSettings(boss, { yenPerPoint: 200, expiryDays: 180, liffId: '1234567890-AbCdEfGh', lineLoginChannelId: '1234567890' }), null);
  assert.equal(s.settings().members.yenPerPoint, 200);
});

test('有効期限: 最後に貯めた日から日数がたったら残りを失効させる（貯めると延びる）', async () => {
  const s = setup({ expiryDays: 365 });
  const a = (await member(s, 'たなか')).member;
  const b = (await member(s, 'すずき')).member;
  await s.service.purchase(u1, a.id, 1000);
  await s.service.purchase(u1, b.id, 500);
  s.setClock(new Date('2027-06-01T00:00:00Z'));
  await s.service.visit(u1, b.id);
  assert.equal(await s.service.tick(new Date('2027-10-05T00:00:00Z')), 0);
  assert.equal(await s.service.tick(new Date('2027-10-07T00:00:00Z')), 1);
  assert.equal((await s.service.get(u1, a.id))!.member.balance, 0);
  assert.equal((await s.service.get(u1, b.id))!.member.balance, 6);
  assert.equal(await s.service.tick(new Date('2027-10-08T00:00:00Z')), 0);
});

test('会員証のページと紙のカード: 名前は逃がし、ポイントと使える特典と有効期限を出す', async () => {
  const s = setup();
  const { member: m, cardKey } = await member(s, '<b>たなか</b>');
  await s.service.createReward(boss, { name: 'ドリンク', points: 3 });
  await s.service.purchase(u1, m.id, 500);
  const v = (await s.service.byCard('t1', cardKey))!;
  const html = renderCardPage('見本の店', v, '<svg></svg>', 365);
  assert.match(html, /&lt;b&gt;たなか&lt;\/b&gt; さん/);
  assert.doesNotMatch(html, /<b>たなか/);
  assert.match(html, /5 <small>ポイント/);
  assert.match(html, /ドリンク/);
  assert.match(html, /ポイントの有効期限: 2027\/10\/06/);
  const pdf = await renderMemberCard({ number: m.number, nickname: m.nickname, url: memberCardUrl('https://a.example.jp', cardKey) }, '見本の店');
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-');
});

test('ツール: 使えない人には使えないと答え、会員を引き（電話は返さない）、ポイントを足し、特典を作る', async () => {
  const s = setup();
  const { member: m } = await member(s, 'たなか', '09012345678');
  await member(s, 'すずき');
  const tool = (name: string) => MEMBER_TOOLS.find((t) => t.name === name)!;
  const ctx = (userId: string, on = true) => ({ tenantId: 't1', userId, members: { service: s.service, access: async () => (on ? s.settings().members : null) } }) as unknown as ToolContext;
  assert.equal((await tool('members.find').invoke({}, ctx('u1', false)) as { available: boolean }).available, false);
  const all = await tool('members.find').invoke({}, ctx('u1')) as { total: number; members: Record<string, unknown>[] };
  assert.equal(all.total, 2);
  assert.doesNotMatch(JSON.stringify(all), /09012345678/);
  const added = await tool('members.points').invoke({ query: '会員番号 1', points: 5, note: '秘書から' }, ctx('u1')) as { available: boolean; member: { points: number } };
  assert.equal(added.member.points, 5);
  const one = await tool('members.find').invoke({ query: 'たなかさん' }, ctx('u1')) as { members: { number: number; points: number }[] };
  assert.equal(one.members[0]!.number, m.number);
  const denied = await tool('members.rewards').invoke({ action: 'create', name: 'ドリンク', points: 10 }, ctx('u1')) as { available: boolean };
  assert.equal(denied.available, false);
  const made = await tool('members.rewards').invoke({ action: 'create', name: 'ドリンク', points: 10 }, ctx('boss')) as { available: boolean };
  assert.equal(made.available, true);
});
