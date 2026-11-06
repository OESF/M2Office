/**
 * @file 料金と支払い（仕様書 第23.4.5節、ADR-0123・ADR-0124）の確かめ。料金の計算・招待の確かめ・本番の守り・ダミーの支払いの口・
 * 料金の見回りの知らせを見る。データベースの関数は `npm run smoke` で確かめる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingAmount, inviteEffect, paidSeatCount, remainingMonths, type BillingView, type InvoiceView } from '@m2office/shared';
import { billingRefusal, billingWatchTick, dunningNotice, invoiceNotice, MockPaymentProvider, paymentProviderName, renewalNotice } from '../src/index.js';

test('最初の 1 人はずっと無料で、2 人目から 1 人分ずついただく。消費税は請求書ごとに切り捨てる', () => {
  assert.equal(paidSeatCount(0), 0);
  assert.equal(paidSeatCount(1), 0);
  assert.equal(paidSeatCount(2), 1);
  assert.equal(paidSeatCount(21), 20);
  assert.deepEqual(billingAmount(0, 1800, 10), { subtotalJpy: 0, taxJpy: 0, totalJpy: 0 });
  assert.deepEqual(billingAmount(1, 1800, 10), { subtotalJpy: 1800, taxJpy: 180, totalJpy: 1980 });
  assert.deepEqual(billingAmount(9, 1800, 10), { subtotalJpy: 16200, taxJpy: 1620, totalJpy: 17820 });
  assert.deepEqual(billingAmount(9, 1500, 10, 12), { subtotalJpy: 162000, taxJpy: 16200, totalJpy: 178200 });
  assert.deepEqual(billingAmount(20, 1500, 10, 12), { subtotalJpy: 360000, taxJpy: 36000, totalJpy: 396000 });
  assert.equal(billingAmount(3, 1333, 10).taxJpy, 399);
});

test('契約の終わりまでの月数は、1 か月に満たない分を切り上げる', () => {
  assert.equal(remainingMonths('2026-11-20', '2027-11-19'), 12);
  assert.equal(remainingMonths('2026-11-25', '2027-11-19'), 12);
  assert.equal(remainingMonths('2027-03-10', '2027-11-19'), 9);
  assert.equal(remainingMonths('2027-03-20', '2027-11-19'), 8);
  assert.equal(remainingMonths('2027-11-19', '2027-11-19'), 1);
  assert.equal(remainingMonths('2027-11-20', '2027-11-19'), 0);
  // 月の長さが違うところは、データベースの age() と同じ数え方にする（1 月 31 日の 1 か月後は 2 月 28 日なので、3 月 1 日までは 1 か月と 1 日）
  assert.equal(remainingMonths('2027-01-31', '2027-02-28'), 2);
});

const billingView = (over: Partial<BillingView> = {}): BillingView => ({
  category: 'card', billingClass: 'small_business', seatLimit: 21, invited: 0, contractTerm: 'monthly', termStart: null, termEnd: null, paidSeats: 0,
  annualUnitJpy: null, annualStartOn: null, nextTerm: null, fixedAnnualJpy: null, today: '2027-03-10', contact: '', billingName: '', cancelOn: null, month: '2027-03',
  seats: 3, peak: 3, monthlyPriceJpy: 1800, annualPriceJpy: 1500, taxPercent: 10, transferReady: true, cardReady: true, invoices: [], ...over,
});

test('招待の確かめ（月間）: 今月の人数の最大を超えるときだけ聞く。入れ替えや請求しない会社には聞かない', () => {
  assert.deepEqual(inviteEffect(billingView()), { kind: 'monthly', paidSeats: 3, totalJpy: 5940 });
  assert.deepEqual(inviteEffect(billingView({ seats: 2 })), { kind: 'free' });
  assert.deepEqual(inviteEffect(billingView({ seats: 2, invited: 1 })), { kind: 'monthly', paidSeats: 3, totalJpy: 5940 });
  assert.deepEqual(inviteEffect(billingView({ category: 'none', seatLimit: null })), { kind: 'free' });
});

test('招待の確かめ（年間）: 席を超えるときだけ、残りの月数の金額を示す。1 人の間は期間の始まりを示す', () => {
  const annual = { contractTerm: 'annual', annualUnitJpy: 1500, termStart: '2026-11-20', termEnd: '2027-11-19' } as const;
  assert.deepEqual(inviteEffect(billingView({ ...annual, seats: 2, peak: 2, paidSeats: 1 })), { kind: 'annual_add', months: 9, totalJpy: 14850 });
  assert.deepEqual(inviteEffect(billingView({ ...annual, seats: 2, peak: 3, paidSeats: 2 })), { kind: 'free' });
  assert.deepEqual(inviteEffect(billingView({ contractTerm: 'annual', seats: 1, peak: 1 })), { kind: 'annual_start', totalJpy: 19800 });
});

test('クラスの上限: スターターの 2 人目は支払いの登録へ。スモールビジネスの 22 人目は招けない。定額は上限まで聞かない', () => {
  assert.deepEqual(inviteEffect(billingView({ category: 'starter', billingClass: 'starter', seatLimit: 1, seats: 1, peak: 1, contractTerm: null })), { kind: 'payment_required' });
  assert.deepEqual(inviteEffect(billingView({ seats: 21, peak: 21 })), { kind: 'class_limit', limit: 21 });
  assert.equal(inviteEffect(billingView({ seats: 20, peak: 20 })).kind, 'monthly');
  assert.deepEqual(inviteEffect(billingView({ seats: 20, invited: 1, peak: 20 })), { kind: 'class_limit', limit: 21 });
  assert.deepEqual(inviteEffect(billingView({ billingClass: 'business', seatLimit: 50, seats: 30, peak: 30 })), { kind: 'free' });
  assert.deepEqual(inviteEffect(billingView({ billingClass: 'business', seatLimit: 50, seats: 50, peak: 50 })), { kind: 'class_limit', limit: 50 });
  assert.deepEqual(inviteEffect(billingView({ billingClass: 'enterprise', seatLimit: null, seats: 500, peak: 500 })), { kind: 'free' });
});

test('本番では mock で起動しない。本番の既定は支払いの口なし、開発の既定は mock', () => {
  assert.equal(paymentProviderName({ NODE_ENV: 'production' }), null);
  assert.equal(paymentProviderName({}), 'mock');
  assert.equal(paymentProviderName({ M2O_PAYMENT_PROVIDER: 'stripe', NODE_ENV: 'production' }), 'stripe');
  assert.throws(() => paymentProviderName({ M2O_PAYMENT_PROVIDER: 'mock', NODE_ENV: 'production' }), /mock は使えません/);
  assert.throws(() => paymentProviderName({ M2O_PAYMENT_PROVIDER: 'paypal' }), /値が違います/);
});

test('ダミーの支払いの口: 札を確かめて登録し、失敗するカードの課金は失敗の知らせを返す', async () => {
  const p = new MockPaymentProvider('secret', '/billing/mock-card');
  const { url } = await p.startCardSetup({ tenantId: 't-a', returnUrl: 'https://a.example/admin/billing', customerId: null });
  const session = new URL(url, 'https://signup.example').searchParams.get('session')!;
  assert.equal(p.completeCardSetup('壊れた札', false), null);
  assert.equal(p.completeCardSetup(`${session}x`, false), null);
  // 30 分で切れる
  assert.equal(p.completeCardSetup(session, false, Date.now() + 31 * 60_000), null);

  const ok = p.completeCardSetup(session, false);
  assert.ok(ok && ok.kind === 'card.registered');
  assert.equal(ok.tenantId, 't-a');
  assert.equal((await p.charge({ invoiceId: 'i', number: 'n', totalJpy: 1, customerId: ok.customerId })).kind, 'charge.succeeded');

  const ng = p.completeCardSetup(session, true);
  assert.ok(ng && ng.kind === 'card.registered');
  assert.equal((await p.charge({ invoiceId: 'i', number: 'n', totalJpy: 1, customerId: ng.customerId })).kind, 'charge.failed');
});

test('知らせは署名を確かめて読む', () => {
  const p = new MockPaymentProvider('secret', '/x');
  const body = JSON.stringify({ id: 'e', kind: 'charge.failed', invoiceId: 'i', error: 'x' });
  assert.equal(p.readEvent(body, null), null);
  assert.equal(p.readEvent(body, 'にせの署名'), null);
  assert.equal(p.readEvent(`${body} `, p.signature(body)), null);
  assert.deepEqual(p.readEvent(body, p.signature(body)), JSON.parse(body));
});

test('データベースが断った理由だけを取り出す', () => {
  assert.equal(billingRefusal(new Error('starter_limit')), 'starter_limit');
  assert.equal(billingRefusal(new Error('duplicate key value violates')), null);
  assert.equal(billingRefusal('x'), null);
});

const invoice = (over: Partial<InvoiceView> = {}) => ({ id: 'i', tenantId: 't-a', kind: 'monthly', method: 'transfer', month: '2026-11', totalJpy: 3300, dueDate: '2026-12-31', seats: 2, months: 1, termStart: null, termEnd: null, ...over }) as InvoiceView;

test('知らせの文: 振込は期限を、カードは課金を伝える。督促は段が進むとはっきり伝える', () => {
  assert.match(invoiceNotice(invoice()).body, /2026-12-31 までにお振り込み/);
  assert.match(invoiceNotice(invoice()).title, /2026 年 11 月分のご利用料金 3,300 円/);
  assert.match(invoiceNotice(invoice({ method: 'card' })).body, /登録のカードに課金/);
  const annual = { termStart: '2026-11-20', termEnd: '2027-11-19' };
  assert.match(invoiceNotice(invoice({ kind: 'annual', months: 12, seats: 9, ...annual })).body, /2026-11-20 から 2027-11-19 までの、有料の 9 人分/);
  assert.match(invoiceNotice(invoice({ kind: 'annual_add', months: 9, seats: 1, ...annual })).body, /増えた 1 人の、残り 9 か月分/);
  assert.match(invoiceNotice(invoice({ kind: 'fixed', months: 12, seats: 50, ...annual })).body, /定額/);
  assert.match(renewalNotice({ termEnd: '2027-11-19', nextTerm: null }).body, /2027-11-19 の翌日に自動で更新/);
  assert.match(renewalNotice({ termEnd: '2027-11-19', nextTerm: 'monthly' }).body, /月間契約の請求/);
  assert.doesNotMatch(dunningNotice({ number: 'n', totalJpy: 1, stage: 1 }).body, /止めること/);
  assert.match(dunningNotice({ number: 'n', totalJpy: 1, stage: 3 }).body, /止めることがあります/);
});

test('見回り: 発行者が揃うまで請求を作らず、知らせに失敗しても続ける', async () => {
  const told: string[] = [];
  const warned: string[] = [];
  let closes = 0;
  const base = {
    roll: async () => 0,
    close: async () => { closes++; return [invoice({ tenantId: 't-a' }), invoice({ tenantId: 't-b' })]; },
    renewalNotices: async () => [{ tenantId: 't-f', termEnd: '2027-11-19', nextTerm: null }],
    dunning: async () => [{ invoiceId: 'x', tenantId: 't-c', number: 'n', totalJpy: 1, stage: 1 }],
    applyCancels: async () => 1,
    idleStarters: async () => [{ tenantId: 't-d', action: 'notice' as const }, { tenantId: 't-e', action: 'cancelled' as const }],
  };
  const deps = (ready: boolean) => ({
    store: { ...base, issuerReady: async () => ready },
    notifyAdmins: async (t: string) => { if (t === 't-a') throw new Error('届かない'); told.push(t); },
    log: { warn: (m: string) => { warned.push(m); }, info: () => undefined },
  });

  const none = await billingWatchTick(deps(false));
  assert.equal(closes, 0);
  assert.equal(none.issuerMissing, true);
  assert.equal(none.issued, 0);

  told.length = 0;
  const r = await billingWatchTick(deps(true));
  assert.equal(closes, 1);
  assert.deepEqual(r, { issued: 2, renewals: 1, dunned: 1, cancelled: 1, idle: 2, issuerMissing: false });
  // t-a の知らせが失敗しても、ほかの会社に届く。解約済みにした会社には知らせない
  assert.deepEqual(told, ['t-b', 't-f', 't-c', 't-d']);
  assert.ok(warned.length >= 1);
});
