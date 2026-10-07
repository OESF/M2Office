/**
 * @file 1 年単位の変形労働時間制・フレックスタイム制・共有の端末の単体テスト（仕様書 第30.6.3節、ADR-0085）。
 *
 * 対象期間の決め方、日・週・対象期間の 3 段（対象期間の分は終わる期間で清算する）、所定の点検（10 時間・52 時間・連続・総枠・280 日・48 時間の週）、
 * フレックスの清算期間の区切り・総枠・月 50 時間・足りない時間の繰り越しと差し引き・コアタイム、
 * 共有の端末の登録・30 秒ごとに変わる QR・番号の間違いで止めることを確かめる。監修の前（第30.27節）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AttDay, HrAnnualSettings, HrEmployee, HrFlexSettings } from '@m2office/shared';
import {
  TerminalService, annualCapMinutes, annualPeriodOf, annualTotals, checkAnnual, coreTimeIssue, flexMonthsOf, flexTotals, pinMatches, hashPin,
  type HrTerminal, type Repository, type TerminalStore,
} from '../src/index.js';

const day = (date: string, sched: number, work: number, type: AttDay['type'] = sched > 0 ? 'workday' : 'dayoff'): AttDay => ({
  date, type, in: work ? '09:00' : null, out: work ? '18:00' : null, breakMinutes: 60, workMinutes: work, nightMinutes: 0,
  overtimeMinutes: 0, extraMinutes: 0, holidayMinutes: 0, lateMinutes: 0, earlyMinutes: 0, leaveDays: 0, issues: [], scheduledMinutes: sched,
});
const dates = (start: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const annual = (over: Partial<HrAnnualSettings> = {}): HrAnnualSettings => ({ enabled: true, start: '2026-04-01', months: 12, busy: [], ...over });

test('対象期間: 起算日から決めた長さで続けて並べる', () => {
  assert.deepEqual(annualPeriodOf('2026-10-07', annual()), { start: '2026-04-01', end: '2027-03-31' });
  assert.deepEqual(annualPeriodOf('2027-04-05', annual()), { start: '2027-04-01', end: '2028-03-31' });
  assert.deepEqual(annualPeriodOf('2026-08-15', annual({ months: 3 })), { start: '2026-07-01', end: '2026-09-30' });
  assert.equal(annualPeriodOf('2026-03-31', annual()), null);
  assert.equal(annualPeriodOf('2026-10-07', annual({ enabled: false })), null);
  assert.equal(annualCapMinutes(365), Math.round(2085.7 * 60));
});

test('1 年単位の 3 段: 日と週は毎月、対象期間の分は対象期間の終わる期間で清算する', () => {
  // 2026-04-05（日）〜 2026-04-18（土）の 2 週を対象期間とみなす。総枠 80 時間 = 4,800 分
  const range = { start: '2026-04-05', end: '2026-04-18' };
  const w1 = dates('2026-04-05', 7).map((d, i) => (i === 0 ? day(d, 0, 0) : day(d, 480, 480)));
  const w2 = dates('2026-04-12', 7).map((d, i) => (i >= 1 && i <= 4 ? day(d, 480, 480) : i === 6 ? day(d, 0, 360) : day(d, 0, 0)));
  const all = [...w1, ...w2];
  // 週 1: 所定 48 時間・実労働 48 時間（所定の週の上限は 48 時間）。週 2: 所定 32 時間・実労働 38 時間（40 時間以内）
  const first = annualTotals(all.map((d) => ({ ...d })), { start: '2026-04-05', end: '2026-04-11' }, range, 0, []);
  assert.equal(first.overtimeMinutes, 0);
  assert.equal(first.annualSettled, undefined);
  // 対象期間の合計 80 時間 + 6 時間 → 総枠を超えた 6 時間を、終わりの期間の所定外から時間外にする
  const last = annualTotals(all.map((d) => ({ ...d })), { start: '2026-04-12', end: '2026-04-18' }, range, 0, [{ days: all.map((d) => ({ ...d })), range }]);
  assert.equal(last.overtimeMinutes, 360);
  assert.equal(last.extraMinutes, 0);
  assert.equal(last.overtimeWithinMinutes, 0);
  assert.equal(last.annualSettled, true);
  // 日の段: 所定 9 時間の日に 10 時間 → 1 時間。所定 7 時間の日に 9 時間 → 8 時間を超えた 1 時間と、所定外 1 時間
  const d1 = annualTotals([day('2026-04-06', 540, 600), day('2026-04-07', 420, 540)], { start: '2026-04-06', end: '2026-04-07' }, range, 0, []);
  assert.equal(d1.overtimeMinutes, 120);
  assert.equal(d1.extraMinutes, 60);
});

test('1 年単位の点検: 10 時間・52 時間・連続 6 日（特定期間 12 日）・総枠・280 日・48 時間の週', () => {
  const range = { start: '2026-04-01', end: '2027-03-31' };
  const sh = (date: string, start = '09:00', end = '18:00') => ({ date, start, end, breakMinutes: 60 });
  const codes = (xs: { code: string }[]) => [...new Set(xs.map((x) => x.code))].sort();
  assert.deepEqual(codes(checkAnnual([sh('2026-04-06', '08:00', '20:00')], range, annual(), 0)), ['day10']);
  // 7 日続けて働く（特定期間でなければ止める。特定期間なら 12 日まで）
  const seven = dates('2026-04-06', 7).map((d) => sh(d, '09:00', '15:00'));
  assert.deepEqual(codes(checkAnnual(seven, range, annual(), 0)), ['streak']);
  assert.deepEqual(codes(checkAnnual(seven, range, annual({ busy: [{ from: '04-01', to: '04-30' }] }), 0)), []);
  // 週 52 時間を超える（6 日 × 9 時間 = 54 時間）
  assert.ok(codes(checkAnnual(dates('2026-04-05', 6).map((d) => sh(d, '08:00', '18:00')), range, annual(), 0)).includes('week52'));
  // 48 時間を超える週が 4 週続く（5 日 × 10 時間 = 50 時間の週を 4 週）
  const heavy = [0, 7, 14, 21].flatMap((w) => dates(new Date(Date.parse('2026-04-06T00:00:00Z') + w * 86_400_000).toISOString().slice(0, 10), 5).map((d) => sh(d, '08:00', '19:00')));
  assert.ok(codes(checkAnnual(heavy, range, annual(), 0)).includes('week48'));
  // 労働日が 280 日を超える
  const many = dates('2026-04-01', 365).filter((_, i) => i % 7 !== 0).map((d) => sh(d, '09:00', '13:00'));
  assert.ok(codes(checkAnnual(many, range, annual(), 0)).includes('days280'));
});

const flex = (over: Partial<HrFlexSettings> = {}): HrFlexSettings => ({ enabled: true, months: 1, startMonth: '', core: null, shortfall: 'carry', ...over });

test('フレックスの清算期間の区切り', () => {
  assert.deepEqual(flexMonthsOf('2026-05', flex({ months: 3, startMonth: '2026-04' })), { first: '2026-04', last: '2026-06', index: 1, months: 3 });
  assert.deepEqual(flexMonthsOf('2026-07', flex({ months: 3, startMonth: '2026-04' })), { first: '2026-07', last: '2026-09', index: 0, months: 3 });
  assert.deepEqual(flexMonthsOf('2026-02', flex({ months: 3, startMonth: '2026-04' })), { first: '2026-01', last: '2026-03', index: 1, months: 3 });
  assert.deepEqual(flexMonthsOf('2026-05', flex()), { first: '2026-05', last: '2026-05', index: 0, months: 1 });
});

test('フレックス 1 か月: 総枠を超えた分が時間外。足りなければ総枠の中で繰り越し、残りは差し引く', () => {
  const period = { start: '2026-10-01', end: '2026-10-31' };
  const cap = Math.round(177.1 * 60);
  const month = (total: number) => [{ period, days: [day('2026-10-01', 0, total)] }];
  const over = flexTotals(month(cap + 174), period, flex(), 22 * 480, 0, true);
  assert.equal(over.totals.overtimeMinutes, 174);
  assert.equal(over.totals.extraMinutes, cap - 22 * 480);
  assert.equal(over.totals.flex!.capMinutes, cap);
  const short = flexTotals(month(22 * 480 - 560), period, flex(), 22 * 480, 0, true);
  assert.equal(short.carryNext, cap - 22 * 480);
  assert.equal(short.totals.flexShortMinutes, 560 - (cap - 22 * 480));
  assert.equal(flexTotals(month(22 * 480 - 560), period, flex({ shortfall: 'deduct' }), 22 * 480, 0, true).totals.flexShortMinutes, 560);
  // 繰り越した分は、次の清算期間の要る時間に足す（総枠の中だけ）
  assert.equal(flexTotals(month(0), period, flex(), 22 * 480, 9999, false).totals.flex!.requiredMinutes, cap);
  // 遅刻・早退は数えない
  const d = day('2026-10-02', 0, 300);
  d.lateMinutes = 30;
  assert.equal(flexTotals([{ period, days: [d] }], period, flex(), 0, 0, false).totals.lateMinutes, 0);
});

test('フレックス 3 か月: 各月で週の平均 50 時間を超えた分はその月に、残りを最後の月に清算する', () => {
  const s = flex({ months: 3, startMonth: '2026-04' });
  const p4 = { start: '2026-04-01', end: '2026-04-30' };
  const p5 = { start: '2026-05-01', end: '2026-05-31' };
  const p6 = { start: '2026-06-01', end: '2026-06-30' };
  const settlement = { start: '2026-04-01', end: '2026-06-30' };
  const m = (period: typeof p4, minutes: number) => ({ period, days: [day(period.start, 0, minutes)] });
  const fifty = (days: number) => Math.floor((50 * days) / 7 * 60);
  // 4 月は 50 時間の平均を 60 分超える
  const april = flexTotals([m(p4, fifty(30) + 60)], settlement, s, 0, 0, false);
  assert.equal(april.totals.overtimeMinutes, 60);
  // 最後の月: 総枠（91 日）を超えた分から、月ごとに払った分を引いて足す
  const cap = annualCapMinutes(91);
  const june = flexTotals([m(p4, fifty(30) + 60), m(p5, 9000), m(p6, cap)], settlement, s, 0, 0, true);
  const worked = fifty(30) + 60 + 9000 + cap;
  assert.equal(june.totals.overtimeMinutes, Math.max(0, cap - fifty(30)) + Math.max(0, worked - cap - 60 - Math.max(0, cap - fifty(30))));
});

test('コアタイムに勤務していない日は指摘する（遅刻としては数えない）', () => {
  const s = flex({ core: { start: '10:00', end: '15:00' } });
  const d = day('2026-10-02', 0, 400, 'workday');
  d.in = '10:30'; d.out = '18:00';
  assert.match(coreTimeIssue(d, s)!, /コアタイム/);
  d.in = '09:30';
  assert.equal(coreTimeIssue(d, s), null);
  assert.equal(coreTimeIssue(day('2026-10-03', 0, 0, 'dayoff'), s), null);
});

/** 端末の置き場（メモリ）。 */
class MemTerminals implements TerminalStore {
  pairings: { id: string; code: string; secretHash: string; expiresAt: string; terminalId: string | null }[] = [];
  terminals: (HrTerminal & { keyHash: string | null; active: boolean })[] = [];
  pins = new Map<string, { pinHash: string; failures: number; lockedUntil: string | null }>();
  async createPairing(_t: string, p: { id: string; code: string; secretHash: string; expiresAt: string }) { this.pairings.push({ ...p, terminalId: null }); }
  async trimPairings() {}
  async findPairingByCode(_t: string, code: string) { return this.pairings.find((p) => p.code === code && !p.terminalId) ?? null; }
  async findPairingBySecret(_t: string, h: string) { return this.pairings.find((p) => p.secretHash === h) ?? null; }
  async setPairingTerminal(_t: string, id: string, terminalId: string) { this.pairings.find((p) => p.id === id)!.terminalId = terminalId; }
  async deletePairing(_t: string, id: string) { this.pairings = this.pairings.filter((p) => p.id !== id); }
  async createTerminal(_t: string, x: { id: string; name: string }) { this.terminals.push({ ...x, lastSeenAt: null, registeredAt: '2026-10-07', keyHash: null, active: true }); }
  async setTerminalKey(_t: string, id: string, keyHash: string) { this.terminals.find((x) => x.id === id)!.keyHash = keyHash; }
  async listTerminals() { return this.terminals.filter((x) => x.active); }
  async terminalByKey(_t: string, h: string) { return this.terminals.find((x) => x.active && x.keyHash === h) ?? null; }
  async getTerminal(_t: string, id: string) { return this.terminals.find((x) => x.active && x.id === id) ?? null; }
  async removeTerminal(_t: string, id: string) { const x = this.terminals.find((y) => y.id === id && y.active); if (x) { x.active = false; x.keyHash = null; } return !!x; }
  async getPin(_t: string, e: string) { return this.pins.get(e) ?? null; }
  async savePin(_t: string, e: string, pinHash: string) { this.pins.set(e, { pinHash, failures: 0, lockedUntil: null }); }
  async setPinFailures(_t: string, e: string, failures: number, lockedUntil: string | null) { Object.assign(this.pins.get(e)!, { failures, lockedUntil }); }
  async listPinEmployees() { return [...this.pins.keys()]; }
}

test('共有の端末: 番号で登録し、鍵を 1 度だけ渡す。QR は 30 秒ごとに変わり、ほかの会社では通らない。外せば鍵は効かない', async () => {
  let now = Date.parse('2026-10-07T00:00:10Z');
  const store = new MemTerminals();
  const alerts: string[] = [];
  const svc = new TerminalService({ store, repo: { appendAudit: async () => {} } as unknown as Repository, secret: 's', alertStaff: async (_t, title) => { alerts.push(title); }, now: () => new Date(now) });
  const secret = 'a'.repeat(40);
  const p = await svc.createPairing('t1', secret);
  assert.ok('code' in p);
  assert.deepEqual(await svc.pollPairing('t1', secret), { status: 'waiting' });
  const claimed = await svc.claim('t1', 'u1', (p as { code: string }).code, '受付');
  assert.ok('terminal' in claimed);
  const got = await svc.pollPairing('t1', secret);
  assert.equal(got.status, 'registered');
  const key = (got as { key: string }).key;
  assert.deepEqual(await svc.pollPairing('t1', secret), { status: 'expired' });
  const terminal = (await svc.byKey('t1', key))!;
  assert.equal(terminal.name, '受付');
  const { token } = svc.qrToken('t1', terminal);
  assert.equal((await svc.verifyToken('t1', token))?.id, terminal.id);
  assert.equal(await svc.verifyToken('t2', token), null);
  now += 30_000;
  assert.equal((await svc.verifyToken('t1', token))?.id, terminal.id);
  now += 30_000;
  assert.equal(await svc.verifyToken('t1', token), null);
  assert.equal(await svc.verifyToken('t1', `${token}x`), null);
  await svc.remove('t1', 'u1', terminal.id);
  assert.equal(await svc.byKey('t1', key), null);
});

test('名前と番号: 簡単な番号は断り、5 回間違えたら 15 分止めて担当者に知らせる', async () => {
  let now = Date.parse('2026-10-07T00:00:00Z');
  const store = new MemTerminals();
  const alerts: string[] = [];
  const svc = new TerminalService({ store, repo: { appendAudit: async () => {} } as unknown as Repository, secret: 's', alertStaff: async (_t, title) => { alerts.push(title); }, now: () => new Date(now) });
  const emp = { id: 'e1', name: '山田 花子', status: 'active' } as HrEmployee;
  assert.ok('error' in await svc.setPin('t1', 'e1', '1111'));
  assert.ok('error' in await svc.setPin('t1', 'e1', '1234'));
  assert.ok('error' in await svc.setPin('t1', 'e1', '12a4'));
  assert.deepEqual(await svc.setPin('t1', 'e1', '4826'), { ok: true });
  assert.ok(!store.pins.get('e1')!.pinHash.includes('4826'));
  assert.deepEqual(await svc.checkPin('t1', emp, '4826'), { ok: true });
  for (let i = 0; i < 4; i++) assert.equal((await svc.checkPin('t1', emp, '0000') as { status: number }).status, 401);
  assert.equal((await svc.checkPin('t1', emp, '0000') as { status: number }).status, 429);
  assert.equal(alerts.length, 1);
  assert.equal((await svc.checkPin('t1', emp, '4826') as { status: number }).status, 429);
  now += 15 * 60_000 + 1;
  assert.deepEqual(await svc.checkPin('t1', emp, '4826'), { ok: true });
  assert.deepEqual(await svc.pinPeople('t1', [emp, { id: 'e2', name: '佐藤', status: 'active' } as HrEmployee]), [{ employeeId: 'e1', name: '山田 花子' }]);
  assert.ok(pinMatches('4826', hashPin('4826')) && !pinMatches('4827', hashPin('4826')));
});
