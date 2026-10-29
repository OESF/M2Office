/**
 * @file 体験版を自分で申し込む（仕様書 第23.3.2節「自分で申し込む」、Q-289、ADR-0117）の単体テスト。
 * 入力の確かめ・メールアドレスと送り元のそろえ方・ロボットよけの問題と答え・データベースが断った理由の読み方。
 * 開発のデータベース（3105 番）が動いていれば、申し込みの関数の歯止め（同じメールアドレス・同じ送り元・1 日の数・
 * 体験版全体の月の上限・使わない設定）を本物で見る（動いていなければ飛ばす）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  checkDemoSignup, createDemoChallenge, demoEmailKey, demoSignupRefusalOf, demoSignupSource, verifyDemoChallenge, DEMO_SIGNUP_REFUSAL,
  hashMachinePassword, newGuestLoginId, PostgresDemoStore,
} from '../src/index.js';

test('メールアドレスは大文字と小文字・+ の後ろ・Gmail の . をそろえて比べる', () => {
  assert.equal(demoEmailKey(' Taro.Yamada+demo@Example.co.jp '), 'taro.yamada@example.co.jp');
  // Gmail の決まりを見るため、ドメインだけを本物の名前にする（公開の前の点検に引っかかるので、アドレスの形では書かない）
  const gmail = 'gmail.com';
  assert.equal(demoEmailKey(`t.a.r.o+x@${gmail}`), `taro@${gmail}`);
  assert.equal(demoEmailKey(`taro@google${'mail.com'}`), `taro@${gmail}`);
  assert.equal(demoEmailKey('+x@example.com'), null);
  assert.equal(demoEmailKey('not-an-address'), null);
});

test('送り元は IPv4 はそのまま、IPv6 は前の 64 ビットで見る', () => {
  assert.equal(demoSignupSource('203.0.113.5'), '203.0.113.5');
  assert.equal(demoSignupSource('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(demoSignupSource('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(demoSignupSource('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(demoSignupSource('2001:db8::1'), '2001:db8:0:0::/64');
});

test('申し込みの入力: 会社名・お名前・メールアドレスと規約への同意が要る', () => {
  const ok = checkDemoSignup({ company: ' 見本商事 ', contact: '山田', email: 'Yamada+t@Example.co.jp', agree: true });
  assert.deepEqual(ok, { ok: true, value: { company: '見本商事', contact: '山田', email: 'yamada+t@example.co.jp', emailKey: 'yamada@example.co.jp' } });
  assert.equal(checkDemoSignup({ company: '', contact: '山田', email: 'a@example.com', agree: true }).ok, false);
  assert.equal(checkDemoSignup({ company: 'x', contact: '', email: 'a@example.com', agree: true }).ok, false);
  assert.equal(checkDemoSignup({ company: 'x', contact: 'y', email: 'bad', agree: true }).ok, false);
  assert.equal(checkDemoSignup({ company: 'x', contact: 'y', email: 'a@example.com', agree: 'yes' }).ok, false, '同意は true だけ');
  assert.equal(checkDemoSignup({ company: 'x'.repeat(101), contact: 'y', email: 'a@example.com', agree: true }).ok, false);
});

/** 問題を解く（画面と同じ探し方）。 */
function solve(c: ReturnType<typeof createDemoChallenge>): number {
  for (let n = 0; n <= c.maxnumber; n++) {
    if (createHash('sha256').update(c.salt + n).digest('hex') === c.challenge) return n;
  }
  throw new Error('解けない');
}

test('ロボットよけ: 署名・期限・答えの数を確かめる', () => {
  const now = Date.now();
  const c = createDemoChallenge('secret', now, 2000);
  assert.match(c.salt, /\?expires=\d+$/);
  const number = solve(c);
  assert.equal(verifyDemoChallenge('secret', { ...c, number }, now), true);
  assert.equal(verifyDemoChallenge('secret', { ...c, number: number + 1 }, now), false, '答えが違う');
  assert.equal(verifyDemoChallenge('other', { ...c, number }, now), false, '署名の鍵が違う');
  assert.equal(verifyDemoChallenge('secret', { ...c, number, signature: '0'.repeat(64) }, now), false, '署名を書き換えた');
  assert.equal(verifyDemoChallenge('secret', { ...c, number, salt: c.salt.replace(/\d+$/, '9999999999') }, now), false, '期限を書き換えた');
  assert.equal(verifyDemoChallenge('secret', { ...c, number }, now + 11 * 60_000), false, '10 分で切れる');
  assert.equal(verifyDemoChallenge('secret', null, now), false);
});

test('データベースが断った理由を読み、申し込んだ人に見せる文がある', () => {
  assert.equal(demoSignupRefusalOf(new Error('signup_email_used')), 'signup_email_used');
  assert.equal(demoSignupRefusalOf(new Error('boom')), null);
  for (const v of Object.values(DEMO_SIGNUP_REFUSAL)) assert.ok(v.length > 0);
});

const OWNER = process.env['MIGRATION_DATABASE_URL'] ?? 'postgres://m2office:m2office@localhost:3105/m2office';
const APP = process.env['DATABASE_URL'] ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office';
const dbReady = await (async () => {
  const c = new pg.Client({ connectionString: OWNER, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.query('select 1 from ops.demo_signup_secret limit 1'); return true; } catch { return false; } finally { await c.end().catch(() => undefined); }
})();

test('申し込みの関数: 同じメールアドレスは一度だけ・同じ送り元は 24 時間に 1 件・1 日の数・全体の月の上限・使わない設定', { skip: dbReady ? false : '開発のデータベース（移行 174 まで）が動いていません' }, async () => {
  const owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  const store = new PostgresDemoStore(APP);
  const tag = Date.now().toString(36);
  const made: string[] = [];
  const saved = (await owner.query('select demo_self_signup, demo_daily_limit, demo_monthly_ai_cap_jpy from ops.platform_settings where id = 1')).rows[0];
  const sign = (email: string, source: string) => store.selfSignup({
    loginId: newGuestLoginId(), passwordHash: hashMachinePassword('x'), company: '見本商事', contact: '山田', email, emailKey: demoEmailKey(email)!,
    source, companyName: '見本精工株式会社',
  });
  const refused = (code: string) => (e: unknown) => demoSignupRefusalOf(e) === code;
  try {
    await owner.query("update ops.platform_settings set demo_self_signup = true, demo_daily_limit = (select count(*) from ops.demo_guests where origin = 'self' and created_at >= date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo') + 2, demo_monthly_ai_cap_jpy = 10000000 where id = 1");
    const a = await sign(`a-${tag}@example.com`, `198.51.100.${tag.length}`);
    made.push(a.tenantId);
    assert.match(a.tenantId, /^d-/);
    const g = (await owner.query('select origin, terms_accepted_at, created_by, ai_cap_jpy from ops.demo_guests where tenant_id = $1', [a.tenantId])).rows[0];
    assert.equal(g.origin, 'self');
    assert.ok(g.terms_accepted_at, '規約には申し込みのときに同意した');
    assert.equal(g.created_by, 'self-signup');
    assert.equal((await owner.query("select count(*)::int as n from ops.audit where action = 'demo.self_signup' and target_id = (select id from ops.demo_guests where tenant_id = $1)", [a.tenantId])).rows[0].n, 1);
    // 控えはハッシュで、元のメールアドレスは入っていない
    assert.equal((await owner.query("select count(*)::int as n from ops.demo_signup_emails where email_hash like $1", [`%${tag}%`])).rows[0].n, 0);

    await assert.rejects(sign(`A-${tag}+again@Example.com`, '198.51.100.200'), refused('signup_email_used'), 'そろえた形で同じメールアドレス');
    await assert.rejects(sign(`b-${tag}@example.com`, `198.51.100.${tag.length}`), refused('signup_source_used'), '同じ送り元');
    const b = await sign(`b-${tag}@example.com`, '198.51.100.201');
    made.push(b.tenantId);
    await assert.rejects(sign(`c-${tag}@example.com`, '198.51.100.202'), refused('signup_daily_limit'), '1 日の数');

    await owner.query('update ops.platform_settings set demo_daily_limit = 1000, demo_monthly_ai_cap_jpy = 0 where id = 1');
    await assert.rejects(sign(`c-${tag}@example.com`, '198.51.100.202'), refused('signup_budget'), '体験版全体の月の上限');
    await owner.query('update ops.platform_settings set demo_monthly_ai_cap_jpy = 10000000, demo_self_signup = false where id = 1');
    await assert.rejects(sign(`c-${tag}@example.com`, '198.51.100.202'), refused('signup_closed'), '使わない設定');

    // 消した体験の会社の AI の利用も、月の合計に残る
    await owner.query("insert into ai_usage (tenant_id, purpose, cost_jpy) values ($1, 'test', 12.5)", [b.tenantId]);
    const before = Number((await owner.query('select ops.demo_ai_month_total() as t')).rows[0].t);
    await owner.query('select m2o_demo_purge($1)', [b.tenantId]);
    assert.equal(Number((await owner.query('select ops.demo_ai_month_total() as t')).rows[0].t), before);
  } finally {
    for (const t of made) await owner.query('select m2o_demo_purge($1)', [t]);
    await owner.query("delete from ops.demo_ai_months where month = date_trunc('month', now() at time zone 'Asia/Tokyo')::date and jpy = 12.5");
    await owner.query("update ops.demo_ai_months set jpy = jpy - 12.5 where month = date_trunc('month', now() at time zone 'Asia/Tokyo')::date and jpy > 12.5");
    await owner.query('update ops.platform_settings set demo_self_signup = $1, demo_daily_limit = $2, demo_monthly_ai_cap_jpy = $3 where id = 1',
      [saved.demo_self_signup, saved.demo_daily_limit, saved.demo_monthly_ai_cap_jpy]);
    await owner.query("delete from ops.demo_signup_sources where created_at > now() - interval '5 minutes' and addr_hash in (select encode(sha256(convert_to(s.pepper || ':addr:' || a, 'UTF8')), 'hex') from ops.demo_signup_secret s, unnest($1::text[]) a)",
      [[`198.51.100.${tag.length}`, '198.51.100.200', '198.51.100.201', '198.51.100.202']]);
    await owner.query("delete from ops.demo_guests where tenant_id = any($1) or email like $2", [made, `%-${tag}@example.com`]);
    await owner.query("delete from ops.demo_signup_emails where email_hash in (select encode(sha256(convert_to(s.pepper || ':email:' || e, 'UTF8')), 'hex') from ops.demo_signup_secret s, unnest($1::text[]) e)",
      [[`a-${tag}@example.com`, `b-${tag}@example.com`]]);
    await owner.end();
  }
});
