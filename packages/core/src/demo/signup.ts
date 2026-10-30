/**
 * @file 体験版を自分で申し込む（仕様書 第23.3.2節「自分で申し込む」、Q-289、ADR-0117）の決まり。データベースに触れない純粋な関数だけを置く。
 *
 * 入力の確かめ、同じ人を見分けるためのメールアドレスと送り元のそろえ方、ロボットよけの問題と答えの確かめを持つ。
 * 聞くのはメールアドレスだけで、それも「同じ人は 1 回だけ」の確かめの控えにしか使わない（第 0.491.0 版。情報漏洩を避けるため、
 * 体験版を動かすのに要らない会社名・お名前は聞かず、メールアドレスの文字も残さない）。
 * ロボットよけは ALTCHA と同じ仕組み（画面が `SHA-256(salt + 数)` が問題と一致する数を探す）で、外の部品やサービスを使わない。
 */

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 申し込みの入力（整えたもの）。 */
export interface DemoSignupInput {
  /** 同じ人を見分けるための、そろえた形のメールアドレス（控えを作るためだけに使う）。 */
  emailKey: string;
}

/**
 * 同じ人を見分けるために、メールアドレスをそろえる（大文字と小文字・`+` の後ろ・Gmail の `.`）。
 *
 * @returns そろえた形。メールアドレスの形でなければ `null`
 */
export function demoEmailKey(email: string): string | null {
  const v = email.trim().toLowerCase();
  const m = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(v);
  if (!m) return null;
  let local = m[1]!.split('+')[0]!;
  let domain = m[2]!;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}

/**
 * 申し込みの送り元をそろえる（IPv6 は 1 つの契約で多くのアドレスを持てるため、前の 64 ビットで見る）。
 */
export function demoSignupSource(address: string): string {
  const a = address.trim().toLowerCase();
  if (!a.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) return a.replace(/^::ffff:/, '');
  const [head = '', tail = ''] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * 申し込みの入力を整え、確かめる。
 *
 * @returns 整えた入力か、申し込んだ人に見せる理由
 */
export function checkDemoSignup(raw: Record<string, unknown>): { ok: true; value: DemoSignupInput } | { ok: false; error: string } {
  const email = typeof raw['email'] === 'string' ? raw['email'].trim().toLowerCase() : '';
  const emailKey = email.length <= 200 ? demoEmailKey(email) : null;
  if (!emailKey) return { ok: false, error: 'メールアドレスの形が違います' };
  if (raw['agree'] !== true) return { ok: false, error: '体験版の利用規約に同意してください' };
  return { ok: true, value: { emailKey } };
}

/** データベースが断った理由（`m2o_demo_self_signup`）。 */
export type DemoSignupRefusal = 'signup_closed' | 'signup_invalid' | 'signup_email_used' | 'signup_source_used' | 'signup_daily_limit' | 'signup_budget';

/** 断った理由ごとの、申し込んだ人に見せる文。 */
export const DEMO_SIGNUP_REFUSAL: Record<DemoSignupRefusal, string> = {
  signup_closed: 'いまは体験版の申し込みを受け付けていません',
  signup_invalid: '入力の形が違います',
  signup_email_used: 'このメールアドレスでは、すでに体験版をお使いいただいています',
  signup_source_used: 'この接続からは、すでに体験版をお申し込みいただいています。時間をおいてお試しください',
  signup_daily_limit: '本日の受け付けは終わりました。明日またお試しください',
  signup_budget: '今月の受け付けは終わりました',
};

/**
 * データベースの失敗から、断った理由を読む。
 *
 * @returns 断った理由。ほかの失敗なら `null`
 */
export function demoSignupRefusalOf(err: unknown): DemoSignupRefusal | null {
  const msg = err instanceof Error ? err.message : '';
  const m = /signup_(closed|invalid|email_used|source_used|daily_limit|budget)/.exec(msg);
  return m ? (`signup_${m[1]}` as DemoSignupRefusal) : null;
}

/** ロボットよけの問題（ALTCHA と同じ形）。 */
export interface DemoChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  /** 期限（`?expires=<UNIX 秒>`）を含む。 */
  salt: string;
  maxnumber: number;
  signature: string;
}

/** ロボットよけの答え。 */
export interface DemoChallengeSolution {
  algorithm: string;
  challenge: string;
  salt: string;
  number: number;
  signature: string;
}

/** 探す数の上限（画面がふつうの端末で 1 秒前後で解ける大きさ）。 */
export const DEMO_CHALLENGE_MAX = 100_000;
/** 問題の有効な時間（ミリ秒）。 */
export const DEMO_CHALLENGE_TTL_MS = 10 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');

/**
 * ロボットよけの問題を出す。
 *
 * @param secret 署名の鍵（API の秘密から作る）
 */
export function createDemoChallenge(secret: string, now: number = Date.now(), max: number = DEMO_CHALLENGE_MAX): DemoChallenge {
  const expires = Math.floor((now + DEMO_CHALLENGE_TTL_MS) / 1000);
  const salt = `${randomBytes(12).toString('hex')}?expires=${expires}`;
  const challenge = sha256(salt + randomInt(0, max + 1));
  return { algorithm: 'SHA-256', challenge, salt, maxnumber: max, signature: hmac(secret, challenge) };
}

/**
 * ロボットよけの答えを確かめる（署名・期限・答えの数）。1 度だけ使えることは、呼ぶ側が問題を覚えて守る。
 *
 * @returns 正しければ `true`
 */
export function verifyDemoChallenge(secret: string, s: unknown, now: number = Date.now()): s is DemoChallengeSolution {
  if (!s || typeof s !== 'object') return false;
  const v = s as Record<string, unknown>;
  if (v['algorithm'] !== 'SHA-256' || typeof v['challenge'] !== 'string' || typeof v['salt'] !== 'string'
    || typeof v['signature'] !== 'string' || !Number.isInteger(v['number'])) return false;
  const expires = Number(/[?&]expires=(\d+)/.exec(v['salt'])?.[1] ?? 0);
  if (!expires || expires * 1000 < now) return false;
  const want = Buffer.from(hmac(secret, v['challenge']), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(v['signature']) ? v['signature'] : '', 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  return sha256(v['salt'] + String(v['number'])) === v['challenge'];
}
