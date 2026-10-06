/**
 * @file 予約の段 1 の単体テスト（仕様書 第37.17節）。重なりを断る（終わりと始めが同じなら重ならない）・断ったときの空く時間とほかのもの・
 * 空いているものを選ぶ（定員が人数に近いもの）・長さと先の日数・変える・取り消す・終わった・本人と管理者だけ・止めたものと知らせ・
 * カレンダーの予定・種類を名前から決める・1 年で消す・秘書の頼みの読み方と答え。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TENANT_SETTINGS, type TenantSettings } from '@m2office/shared';
import {
  BUILTIN_TOOLS, ConnectorUnavailableError, MemoryReservationStore, MockWorkspaceConnector, ReservationService, answerReservation, eventTitle, itemIn,
  kindOfName, parseReservation, seriesDates, seriesOf, timesOf, type CalendarConnector, type Repository, type ToolContext,
} from '../src/index.js';

/** 2026-10-06（火）9:00（日本時間） */
const NOW = new Date('2026-10-06T00:00:00Z');
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+09:00`;

function setup(calendar?: CalendarConnector) {
  let clock = NOW;
  let settings: TenantSettings = { ...DEFAULT_TENANT_SETTINGS, reservations: { enabled: true } };
  const users = [
    { id: 'boss', email: 'boss@alpha.example.jp', displayName: '責任者', roles: ['admin'], status: 'active' },
    { id: 'u1', email: 'u1@alpha.example.jp', displayName: '総務', roles: ['member'], status: 'active' },
    { id: 'u2', email: 'u2@alpha.example.jp', displayName: '営業', roles: ['member'], status: 'active' },
  ];
  const audits: { action: string; targetId: string }[] = [];
  const notes: { userId: string; kind: string; title: string; body: string }[] = [];
  const repo = {
    listUsers: async () => users,
    findUserById: async (_t: string, id: string) => users.find((u) => u.id === id) ?? null,
    getTenantSettings: async () => settings,
    saveTenantSettings: async (_t: string, section: keyof TenantSettings, value: unknown) => { settings = { ...settings, [section]: value }; },
    listTenantIds: async () => ['t1'],
    listUserGroupIds: async () => [],
    getUserSettings: async () => ({ notifications: { kinds: { reservation: true } } }),
    createNotification: async (n: { userId: string; kind: string; title: string; body: string }) => { notes.push(n); },
    appendAudit: async (e: { action: string; targetId: string }) => { audits.push(e); },
  } as unknown as Repository;
  const store = new MemoryReservationStore();
  const connector = new MockWorkspaceConnector();
  const service = new ReservationService({ store, repo, calendar: calendar ?? connector.calendar, now: () => clock });
  return { service, store, connector, audits, notes, setClock: (d: Date) => { clock = d; } };
}

const boss = { tenantId: 't1', userId: 'boss' };
const u1 = { tenantId: 't1', userId: 'u1' };
const u2 = { tenantId: 't1', userId: 'u2' };

async function withItems(s: ReturnType<typeof setup>) {
  const a = await s.service.addItem(boss, { name: '会議室 A', capacity: 6 });
  const b = await s.service.addItem(boss, { name: '会議室 B', capacity: 12 });
  const car = await s.service.addItem(boss, { name: 'プリウス', location: '第 2 駐車場' });
  assert.ok(!('error' in a) && !('error' in b) && !('error' in car));
  return { a: a.item, b: b.item, car: car.item };
}

test('種類は名前から決め、予定の題は種類と用件を添える', () => {
  assert.equal(kindOfName('会議室 A'), 'room');
  assert.equal(kindOfName('応接室'), 'room');
  assert.equal(kindOfName('プリウス'), 'car');
  assert.equal(kindOfName('社用車 2 号'), 'car');
  assert.equal(kindOfName('プロジェクター'), 'equipment');
  assert.equal(kindOfName('ノート PC 1'), 'equipment');
  assert.equal(kindOfName('脚立'), 'other');
  assert.equal(eventTitle({ name: '会議室 A', kind: 'room' }, '定例'), '会議室 A（定例）');
  assert.equal(eventTitle({ name: 'プリウス', kind: 'car' }, ''), '社用車 プリウス');
  assert.equal(eventTitle({ name: 'プロジェクター', kind: 'equipment' }, ''), 'プロジェクター');
});

test('予約できるもの: 足すのは管理者だけ、名前は重ならず、種類は名前から決める', async () => {
  const s = setup();
  const r = await s.service.addItem(u1, { name: '会議室 A' });
  assert.ok('error' in r);
  const { a, car } = await withItems(s);
  assert.equal(a.kind, 'room');
  assert.equal(car.kind, 'car');
  assert.equal(car.sortOrder, 2);
  const dup = await s.service.addItem(boss, { name: '会議室 A' });
  assert.ok('error' in dup);
  assert.match(dup.error, /もうあります/);
  assert.ok(s.audits.some((x) => x.action === 'reservation.item.create'));
  assert.equal(await s.service.updateItem(u1, a.id, { capacity: 8 }), '予約できるものを直せるのは管理者だけです');
  assert.equal(await s.service.updateItem(boss, a.id, { capacity: 8 }), null);
  assert.equal((await s.store.getItem('t1', a.id))!.capacity, 8);
});

test('重なる予約は断り、次に空く時間と同じ種類で空いているほかのものを示す。終わりと始めが同じなら重ならない', async () => {
  const s = setup();
  const { a, b } = await withItems(s);
  const first = await s.service.book(u1, { itemId: a.id, startAt: at('2026-10-07', '10:00'), endAt: at('2026-10-07', '11:00'), purpose: '定例' });
  assert.ok('reservation' in first);
  assert.equal(first.calendar, 'added');
  assert.ok(first.reservation.calendarEventId === null || typeof first.reservation.calendarEventId === 'string');
  const stored = (await s.store.get('t1', first.reservation.id))!;
  assert.match(stored.calendarEventId ?? '', /^mock-event-/);

  const clash = await s.service.book(u2, { itemId: a.id, startAt: at('2026-10-07', '10:30'), endAt: at('2026-10-07', '11:30') });
  assert.ok('conflict' in clash);
  assert.equal(clash.conflict.taken.userName, '総務');
  assert.equal(clash.conflict.nextFree?.startAt, new Date(at('2026-10-07', '11:00')).toISOString());
  assert.equal(clash.conflict.nextFree?.endAt, new Date(at('2026-10-07', '12:00')).toISOString());
  assert.deepEqual(clash.conflict.others.map((o) => o.id), [b.id]);

  const after = await s.service.book(u2, { itemId: a.id, startAt: at('2026-10-07', '11:00'), endAt: at('2026-10-07', '12:00') });
  assert.ok('reservation' in after);
  // 同時に取っても重ならない（置き場が断る）
  await assert.rejects(s.store.create('t1', { itemId: a.id, startAt: at('2026-10-07', '11:30'), endAt: at('2026-10-07', '11:45'), purpose: '', userId: 'u2', createdBy: 'u2' }), /重なる/);
});

test('長さは 14 日まで・90 日先まで・過ぎた時間は取れない。止めたものは取れない', async () => {
  const s = setup();
  const { a, car } = await withItems(s);
  const long = await s.service.book(u1, { itemId: car.id, startAt: at('2026-10-07', '09:00'), endAt: at('2026-10-22', '09:00') });
  assert.ok('error' in long);
  assert.match(long.error, /14 日まで/);
  const far = await s.service.book(u1, { itemId: car.id, startAt: at('2027-01-10', '09:00'), endAt: at('2027-01-10', '10:00') });
  assert.ok('error' in far);
  assert.match(far.error, /90 日先まで/);
  const past = await s.service.book(u1, { itemId: car.id, startAt: at('2026-10-06', '07:00'), endAt: at('2026-10-06', '08:00') });
  assert.ok('error' in past);
  // いまの枠（9:00 からの予約を 9:00 に取る）は取れる
  const nowSlot = await s.service.book(u1, { itemId: car.id, startAt: at('2026-10-06', '09:00'), endAt: at('2026-10-06', '10:00') });
  assert.ok('reservation' in nowSlot);
  assert.equal(await s.service.updateItem(boss, a.id, { status: 'stopped' }), null);
  const stopped = await s.service.book(u1, { itemId: a.id, startAt: at('2026-10-08', '10:00'), endAt: at('2026-10-08', '11:00') });
  assert.ok('error' in stopped);
  assert.match(stopped.error, /止めています/);
});

test('選んで取る: 定員が人数に近い空いている会議室を選び、空きが無ければいちばん早く空く時間を示す', async () => {
  const s = setup();
  const { a, b } = await withItems(s);
  const ten = { startAt: at('2026-10-07', '10:00'), endAt: at('2026-10-07', '11:00') };
  const big = await s.service.pickAndBook(u1, { kind: 'room', people: 10, ...ten });
  assert.ok('reservation' in big);
  assert.equal(big.item.id, b.id);
  const small = await s.service.pickAndBook(u2, { kind: 'room', people: 4, ...ten });
  assert.ok('reservation' in small);
  assert.equal(small.item.id, a.id);
  const none = await s.service.pickAndBook(u2, { kind: 'room', ...ten });
  assert.ok('noneFree' in none);
  assert.equal(none.nextFree?.startAt, new Date(at('2026-10-07', '11:00')).toISOString());
  const noCar = await s.service.pickAndBook(u1, { kind: 'equipment', ...ten });
  assert.ok('error' in noCar);
});

test('変える・取り消す・終わったは本人と管理者だけ。管理者がほかの人の予約を変えたら知らせて記録する', async () => {
  const s = setup();
  const { a } = await withItems(s);
  const r = await s.service.book(u1, { itemId: a.id, startAt: at('2026-10-07', '10:00'), endAt: at('2026-10-07', '11:00') });
  assert.ok('reservation' in r);
  const id = r.reservation.id;
  const other = await s.service.change(u2, id, { endAt: at('2026-10-07', '11:30') });
  assert.ok('error' in other);
  assert.match(other.error, /総務さんの予約です/);
  assert.match((await s.service.cancel(u2, id)) ?? '', /本人と管理者だけ/);

  const longer = await s.service.change(u1, id, { endAt: at('2026-10-07', '11:30') });
  assert.ok('reservation' in longer);
  assert.equal(longer.reservation.endAt, new Date(at('2026-10-07', '11:30')).toISOString());
  assert.equal(s.notes.length, 0);

  const byAdmin = await s.service.change(boss, id, { startAt: at('2026-10-07', '13:00'), endAt: at('2026-10-07', '14:00') });
  assert.ok('reservation' in byAdmin);
  assert.equal(s.notes[0]!.userId, 'u1');
  assert.equal(s.notes[0]!.kind, 'reservation');
  assert.ok(s.audits.some((x) => x.action === 'reservation.admin_change'));

  assert.equal(await s.service.cancel(boss, id), null);
  assert.equal(s.notes.length, 2);
  assert.equal(await s.service.get(u1, id), null);
  // 取り消した時間は、ほかの人が取れる
  const again = await s.service.book(u2, { itemId: a.id, startAt: at('2026-10-07', '13:00'), endAt: at('2026-10-07', '14:00') });
  assert.ok('reservation' in again);
});

test('終わった: 使っている途中なら終わりをいまにし、まだ始まっていなければ取り消す', async () => {
  const s = setup();
  const { car } = await withItems(s);
  const ongoing = await s.service.book(u1, { itemId: car.id, startAt: at('2026-10-06', '09:00'), endAt: at('2026-10-06', '12:00') });
  assert.ok('reservation' in ongoing);
  // 10:20 に終わった
  s.setClock(new Date('2026-10-06T01:20:00Z'));
  assert.equal(await s.service.finish(u1, ongoing.reservation.id), null);
  assert.equal((await s.store.get('t1', ongoing.reservation.id))!.endAt, '2026-10-06T01:20:00.000Z');
  const later = await s.service.book(u1, { itemId: car.id, startAt: at('2026-10-06', '13:00'), endAt: at('2026-10-06', '14:00') });
  assert.ok('reservation' in later);
  assert.equal(await s.service.finish(u1, later.reservation.id), null);
  assert.equal((await s.store.get('t1', later.reservation.id))!.status, 'cancelled');
});

test('止めたら、これからの予約は残し、予約した人に知らせる', async () => {
  const s = setup();
  const { car } = await withItems(s);
  await s.service.book(u1, { itemId: car.id, startAt: at('2026-10-08', '09:00'), endAt: at('2026-10-08', '10:00') });
  await s.service.book(u2, { itemId: car.id, startAt: at('2026-10-09', '09:00'), endAt: at('2026-10-09', '10:00') });
  assert.equal(await s.service.updateItem(boss, car.id, { status: 'stopped' }), null);
  assert.deepEqual(s.notes.map((n) => n.userId).sort(), ['u1', 'u2']);
  assert.equal((await s.service.list(u1, { from: at('2026-10-08', '00:00'), to: at('2026-10-10', '00:00') })).length, 2);
  assert.ok(s.audits.some((x) => x.action === 'reservation.item.stop'));
});

test('Google につないでいない人の予約は M2Office にだけ持つ。終わって 1 年を過ぎた予約は消す', async () => {
  const off: CalendarConnector = {
    list: async () => [], freeBusy: async () => ({ busy: [], unknown: [] }),
    create: async () => { throw new ConnectorUnavailableError('not-connected', 'Google につないでいません'); },
    update: async () => null, cancel: async () => null,
  };
  const s = setup(off);
  const { a } = await withItems(s);
  const r = await s.service.book(u1, { itemId: a.id, startAt: at('2026-10-07', '10:00'), endAt: at('2026-10-07', '11:00') });
  assert.ok('reservation' in r);
  assert.equal(r.calendar, 'not-connected');
  assert.equal(r.reservation.calendarEventId, null);
  assert.equal(await s.service.tick(new Date('2027-10-06T00:00:00Z')), 0);
  assert.equal(await s.service.tick(new Date('2027-10-08T00:00:00Z')), 1);
});

test('秘書の頼みの読み方: 日時・長さ・人数・種類・名前', () => {
  const today = '2026-10-06';
  assert.deepEqual(timesOf('10時から11時'), { start: '10:00', end: '11:00' });
  assert.deepEqual(timesOf('10時から1時間'), { start: '10:00', end: '11:00' });
  assert.deepEqual(timesOf('14:30〜16:00'), { start: '14:30', end: '16:00' });
  assert.deepEqual(timesOf('午後3時から30分'), { start: '15:00', end: '15:30' });
  assert.deepEqual(timesOf('10時半から1時間半'), { start: '10:30', end: '12:00' });
  assert.deepEqual(timesOf('金曜の午後'), { start: '13:00', end: '17:00' });
  assert.equal(itemIn('会議室a、明日10時から', ['会議室 A', '会議室 B']), '会議室 A');

  const book = parseReservation('明日 10 時から 1 時間、会議室を取って', today, ['会議室 A']);
  assert.deepEqual(book, { kind: 'book', item: null, itemKind: 'room', date: '2026-10-07', start: '10:00', end: '11:00', people: null, purpose: '', series: null });
  const named = parseReservation('会議室 A、明日 10 時から 6 人で予約して', today, ['会議室 A']);
  assert.equal(named?.kind, 'book');
  assert.equal(named?.kind === 'book' && named.item, '会議室 A');
  assert.equal(named?.kind === 'book' && named.people, 6);
  const car = parseReservation('金曜の午後、社用車を使いたい', today, ['プリウス']);
  assert.equal(car?.kind === 'book' && car.date, '2026-10-09');
  assert.equal(car?.kind === 'book' && car.itemKind, 'car');
  assert.equal(parseReservation('明日の会議室は空いてる？', today, [])?.kind, 'status');
  assert.equal(parseReservation('今週の社用車の予約は？', today, [])?.kind, 'status');
  const ext = parseReservation('さっきの予約を 30 分延ばして', today, []);
  assert.equal(ext?.kind === 'change' && ext.extendMinutes, 30);
  assert.equal(parseReservation('明日の会議室の予約を取り消して', today, [])?.kind, 'cancel');
  const add = parseReservation('会議室 A と B、社用車のプリウスとハイエースを予約できるようにして', today, []);
  assert.deepEqual(add, { kind: 'add-item', names: [
    { name: '会議室 A', kind: 'room' }, { name: '会議室 B', kind: 'room' }, { name: 'プリウス', kind: 'car' }, { name: 'ハイエース', kind: 'car' },
  ] });
  // 予約できるものに関わらない頼みは扱わない
  assert.equal(parseReservation('レストランの予約を調べて', today, ['会議室 A']), null);
  assert.equal(parseReservation('明日10時に会議を入れて', today, ['会議室 A']), null);
  assert.equal(parseReservation('明日10時から1時間、会議室で田中さんと打ち合わせを入れて', today, ['会議室 A']), null);
});

test('秘書: 空いているものを選んで取り、重なれば空く時間を示し、空きと自分の予約に答え、延ばして取り消す', async () => {
  const s = setup();
  await withItems(s);
  const deps = { service: s.service, access: async () => true };
  const say = async (who: string, text: string, admin = false) => (await answerReservation(deps, 't1', who, admin, text, NOW))?.text ?? null;

  assert.match((await say('u1', '明日 10 時から 1 時間、5 人で会議室を取って'))!, /会議室 Aを 10\/7 10:00〜11:00 で取りました（定員 6 名）。カレンダーにも入れました/);
  assert.match((await say('u2', '会議室 A、明日 10 時半から 1 時間'))!, /総務さんが 10\/7 10:00〜11:00 に使っています。次に空くのは 10\/7 11:00〜12:00 です。同じ時間に空いている会議室: 会議室 B/);
  assert.match((await say('u2', '明日の会議室は空いてる？'))!, /会議室 A（定員 6 名）: 10:00〜11:00 総務[\s\S]*会議室 B（定員 12 名）: 予約なし/);
  assert.match((await say('u1', '自分の予約を見せて'))!, /10\/7 10:00〜11:00 会議室 A/);
  assert.match((await say('u1', 'さっきの予約を 30 分延ばして'))!, /10\/7 10:00〜11:30 に変えました/);
  assert.match((await say('u1', '明日の会議室の予約を取り消して'))!, /取り消しました/);
  assert.equal(await say('u1', '明日の会議室の予約を取り消して'), '当てはまるあなたの予約はありません。');
  assert.match((await say('u1', '会議室 C を予約できるようにして'))!, /管理者だけ/);
  assert.match((await say('boss', '会議室 C を予約できるようにして', true))!, /会議室 C（会議室）を予約できるようにしました/);
  assert.match((await say('u1', '会議室を取って'))!, /いつ使うか/);
  assert.equal(await say('u1', '明日の天気は？'), null);
});

test('繰り返しの回の日: 毎週・隔週・毎月の第 n 何曜・毎月の最後の何曜（終わりの日まで）', () => {
  const base = { startsOn: '2026-10-06', endsOn: null };
  assert.deepEqual(seriesDates({ ...base, rule: 'weekly', weekday: 1, nth: null }, '2026-10-06', '2026-10-31'), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.deepEqual(seriesDates({ ...base, rule: 'biweekly', weekday: 2, nth: null }, '2026-10-06', '2026-11-10'), ['2026-10-06', '2026-10-20', '2026-11-03']);
  assert.deepEqual(seriesDates({ ...base, rule: 'monthly', weekday: 2, nth: 2 }, '2026-10-06', '2026-12-31'), ['2026-10-13', '2026-11-10', '2026-12-08']);
  assert.deepEqual(seriesDates({ ...base, rule: 'monthly', weekday: 5, nth: 5 }, '2026-10-06', '2026-12-31'), ['2026-10-30', '2026-11-27', '2026-12-25']);
  assert.deepEqual(seriesDates({ ...base, endsOn: '2026-10-20', rule: 'weekly', weekday: 1, nth: null }, '2026-10-06', '2026-12-31'), ['2026-10-12', '2026-10-19']);
  // 隔週は、途中から数えても始めの回からの 2 週ごと
  assert.deepEqual(seriesDates({ ...base, rule: 'biweekly', weekday: 2, nth: null }, '2026-10-14', '2026-11-10'), ['2026-10-20', '2026-11-03']);
});

test('繰り返しの予約: 90 日先までの回を作り、重なった日は飛ばし、見張りで先を足して取れなかった日を知らせる', async () => {
  const s = setup();
  const { a } = await withItems(s);
  // 10/19 だけ先に取られている
  await s.service.book(u2, { itemId: a.id, startAt: at('2026-10-19', '10:30'), endAt: at('2026-10-19', '11:30') });
  const r = await s.service.createSeries(u1, { itemId: a.id, rule: 'weekly', startsOn: '2026-10-06', startTime: '10:00', endTime: '11:00', purpose: '定例' });
  assert.ok(!('error' in r));
  assert.equal(r.series.weekday, 2);
  // 10/6（火）〜 1/3 の火曜は 13 回。そのうち重なりは無い（10/19 は月曜）
  assert.equal(r.booked, 13);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.series.materializedUntil, '2027-01-03');
  const mon = await s.service.createSeries(u1, { itemId: a.id, rule: 'weekly', startsOn: '2026-10-06', startTime: '10:00', endTime: '11:00', purpose: '朝会', weekday: 1 });
  assert.ok(!('error' in mon));
  assert.deepEqual(mon.skipped, ['2026-10-19']);
  // 10/12〜1/3 の月曜は 12 回。10/19 は重なって飛ぶ
  assert.equal(mon.booked, 11);
  const one = (await s.store.list('t1', { from: at('2026-10-12', '00:00'), to: at('2026-10-13', '00:00') }))[0]!;
  assert.equal(one.seriesId, mon.series.id);
  assert.match(one.calendarEventId ?? '', /^mock-event-/);
  // 1 週間後、見張りが先の回を足す。重なる予約を先に入れておく
  s.setClock(new Date('2026-10-13T00:00:00Z'));
  await s.service.book(u2, { itemId: a.id, startAt: at('2027-01-04', '10:00'), endAt: at('2027-01-04', '10:30') });
  await s.service.tick(new Date('2026-10-13T00:00:00Z'));
  assert.equal((await s.store.getSeries('t1', mon.series.id))!.materializedUntil, '2027-01-10');
  assert.ok(s.notes.some((n) => n.userId === 'u1' && /取れなかった日があります/.test(n.title) && /1\/4/.test(n.body)));
  // 終わりの日を過ぎた繰り返しは止まる
  const short = await s.service.createSeries(u1, { itemId: a.id, rule: 'monthly', startsOn: '2026-10-14', startTime: '15:00', endTime: '16:00', endsOn: '2026-11-30', purpose: '' });
  assert.ok(!('error' in short));
  assert.equal(short.series.nth, 2);
  assert.equal(short.booked, 2);
  assert.equal(short.series.status, 'stopped');
  // 決まりの誤りは断る
  assert.ok('error' in (await s.service.createSeries(u1, { itemId: a.id, rule: 'weekly', startsOn: '2026-10-01', startTime: '10:00', endTime: '11:00' })));
  assert.ok('error' in (await s.service.createSeries(u1, { itemId: a.id, rule: 'weekly', startsOn: '2026-10-20', startTime: '11:00', endTime: '10:00' })));
});

test('繰り返しを止める: これからの回を取り消す。本人と管理者だけで、管理者が止めたら 1 回だけ知らせる', async () => {
  const s = setup();
  const { a } = await withItems(s);
  const r = await s.service.createSeries(u1, { itemId: a.id, rule: 'biweekly', startsOn: '2026-10-07', startTime: '09:00', endTime: '10:00', purpose: '' });
  assert.ok(!('error' in r));
  assert.match((await s.service.stopSeries(u2, r.series.id)) ?? '', /本人と管理者だけ/);
  assert.equal(await s.service.stopSeries(boss, r.series.id), null);
  assert.equal((await s.store.listBySeries('t1', r.series.id, NOW.toISOString())).length, 0);
  assert.equal(s.notes.filter((n) => n.userId === 'u1').length, 1);
  assert.equal((await s.service.seriesOf(u1, r.series.id))!.status, 'stopped');
});

test('秘書: 「毎週月曜 10 時から 1 時間、会議室 A を取って」を繰り返しの予約にする', async () => {
  assert.deepEqual(seriesOf('毎週月曜 10 時から'), { rule: 'weekly', weekday: 1, nth: null });
  assert.deepEqual(seriesOf('隔週の水曜に'), { rule: 'biweekly', weekday: 3, nth: null });
  assert.deepEqual(seriesOf('毎月第 2 火曜'), { rule: 'monthly', weekday: 2, nth: 2 });
  assert.deepEqual(seriesOf('毎月最後の金曜'), { rule: 'monthly', weekday: 5, nth: 5 });
  assert.equal(seriesOf('明日 10 時から'), null);
  const s = setup();
  await withItems(s);
  const deps = { service: s.service, access: async () => true };
  const text = (await answerReservation(deps, 't1', 'u1', false, '毎週月曜 10 時から 1 時間、会議室 A を取って', NOW))!.text;
  assert.match(text, /会議室 Aを毎週月曜 10:00〜11:00で取りました（90 日先までの 12 回/);
});

test('日程調整: 予定を作った後で空いている会議室を取り、予定の場所に入れる（予約の側では予定を作らない）', async () => {
  const calendarCreate = BUILTIN_TOOLS.find((t) => t.name === 'calendar.create')!;
  const s = setup();
  const { b } = await withItems(s);
  const ctx = {
    tenantId: 't1', userId: 'u1', connector: s.connector,
    reservations: { service: s.service, access: async () => ({ enabled: true }) },
  } as unknown as ToolContext;
  const out = await calendarCreate.invoke({ title: '企画会議', start: at('2026-10-08', '14:00'), end: at('2026-10-08', '15:00'), attendees: ['a@example.jp', 'b@example.jp', 'c@example.jp', 'd@example.jp', 'e@example.jp', 'f@example.jp', 'g@example.jp'], room: '会議室' }, ctx) as { eventId: string; room: { booked: string } };
  // 8 人なので定員 12 の会議室 B
  assert.equal(out.room.booked, '会議室 B');
  const r = (await s.store.list('t1', { from: at('2026-10-08', '00:00'), to: at('2026-10-09', '00:00'), itemId: b.id }))[0]!;
  assert.equal(r.calendarEventId, null);
  assert.equal(r.purpose, '企画会議');
  const ev = (await s.connector.calendar.list({ tenantId: 't1', userId: 'u1' }, { from: at('2026-10-08', '00:00'), to: at('2026-10-09', '00:00') })).find((e) => e.id === out.eventId);
  assert.equal(ev?.location, '会議室 B');
  // 同じ時間に名前で頼んで重なれば、会議の予定はそのままで理由を返す
  const clash = await calendarCreate.invoke({ title: '別の会議', start: at('2026-10-08', '14:30'), end: at('2026-10-08', '15:30'), attendees: [], room: '会議室 B' }, ctx) as { room: { note: string } };
  assert.match(clash.room.note, /会議室 Bはその時間に予約がある/);
  // 予約を使っていない会社では取らない
  const off = await calendarCreate.invoke({ title: 'x', start: at('2026-10-09', '14:00'), end: at('2026-10-09', '15:00'), room: '会議室' }, { ...ctx, reservations: { service: s.service, access: async () => null } } as unknown as ToolContext) as { room: { note: string } };
  assert.match(off.room.note, /予約を使っていない/);
});
