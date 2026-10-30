/**
 * @file 体験版（仕様書 第23.3.2節、Q-286、ADR-0115）の決まり。データベースに触れない純粋な関数と定数だけを置く。
 *
 * 体験用の会社の ID は `d-` で始まる（顧客の会社は `t-`）。印はデータベースの `tenants.kind = 'demo'` にもあり、両方がそろうことを
 * データベースの検査の決まりで守る。ID の形で見分けられるので、API とワーカーはデータベースを読まずに体験用の会社かを決められる。
 */

import { randomBytes } from 'node:crypto';

/** 体験の日数の既定（出してから 2 週間）。マスター管理画面の「設定」で変えられる。 */
export const DEMO_DEFAULT_DAYS = 14;
/** 体験の期間を通した AI の上限の既定（推定の円）。 */
export const DEMO_DEFAULT_AI_CAP_JPY = 1000;
/** 1 回に延ばせる日数の上限。 */
export const DEMO_EXTEND_MAX_DAYS = 7;
/** 出すときに選べる日数の上限。 */
export const DEMO_MAX_DAYS = 60;
/** ゲストのログイン状態の長さ（時間）。 */
export const DEMO_SESSION_HOURS = 12;
/** ファイルの置き場の上限（バイト。データベースの仕掛けと同じ値）。 */
export const DEMO_STORAGE_BYTES = 500 * 1024 * 1024;

/**
 * 体験用の会社か（ID の形で見分ける）。
 *
 * @remarks データベースの検査の決まりで、`d-` の ID と体験の印は必ずそろう
 */
export function isDemoTenantId(tenantId: string): boolean {
  return tenantId.startsWith('d-');
}

/**
 * 体験版の入口の名前（`DEMO_SUBDOMAIN`。例 `demo` で `demo.m2office.net`）。
 *
 * @returns 入口の名前。決めていなければ `null`（体験版を使わない）
 */
export function demoSubdomain(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env['DEMO_SUBDOMAIN'] ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v) ? v : null;
}

/** 読み違えにくい英小文字と数字（`l`・`o`・`0`・`1` を外す）。 */
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
/** パスワードに使う英数字（読み違えやすい `I`・`l`・`O`・`0`・`1` を外す）。 */
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function pick(chars: string, n: number): string {
  // 偏りを避けるため、文字の数の倍数を超える値は引き直す
  const limit = 256 - (256 % chars.length);
  let out = '';
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < limit && out.length < n) out += chars[b % chars.length];
    }
  }
  return out;
}

/** ゲスト ID（`guest-` と英数字 6 文字）。 */
export function newGuestLoginId(): string {
  return `guest-${pick(ID_CHARS, 6)}`;
}

/** ゲストのパスワード（英数字 16 文字）。出すときに 1 度だけ画面に出す。 */
export function newGuestPassword(): string {
  return pick(PASSWORD_CHARS, 16);
}

/** ゲスト ID の形か。 */
export function isGuestLoginId(v: string): boolean {
  return /^guest-[a-z0-9]{6}$/.test(v);
}

/** 体験版で止めている操作の種類（データベースの仕掛けが `demo_restricted:<種類>` で知らせる）。 */
export type DemoRestriction = 'users' | 'connection' | 'storage' | 'feature';

/** 体験版で止めている操作に当たったときに、利用者に見せる文。 */
export const DEMO_RESTRICTED_MESSAGE: Record<DemoRestriction, string> = {
  users: '体験版では、利用者を招待できません（1 社に 1 人です）',
  connection: '体験版では、接続の設定はできません。見本のデータで動いています',
  storage: '体験版のデータ容量（500 MB）がいっぱいです。要らないファイルを削除してください',
  feature: '体験版では使えません',
};

/**
 * データベースの仕掛けが出した理由（`demo_restricted:<種類>`）を読む。
 *
 * @returns 体験版で止めた理由。ほかの失敗なら `null`
 */
export function demoRestrictionOf(err: unknown): DemoRestriction | null {
  const msg = err instanceof Error ? err.message : '';
  const m = /demo_restricted:(users|connection|storage)/.exec(msg);
  return m ? (m[1] as DemoRestriction) : null;
}

/**
 * 体験版で止める要求か（データベースの仕掛けで止められない操作。第23.3.2節「ゲストのロール」）。
 *
 * @param method HTTP メソッド
 * @param path 要求のパス（`/v1/...`）
 * @returns 止めるなら `true`。閲覧は止めない
 * @remarks 会社の接続（MCP）・本人の Google などの接続・拡張機能のファイルの取り込み・外部のアプリの鍵。
 *   会社の接続の情報（Gemini の自社の鍵・Google・LINE・WordPress・窓口のメールなど）と利用者の招待は、データベースの仕掛けが断る
 */
export function demoBlocked(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return /^\/v1\/admin\/connections(\/|$)/.test(path)
    || /^\/v1\/me\/(google|connections|canva)(\/|$)/.test(path)
    || path === '/v1/admin/extensions/import'
    || /^\/v1\/admin\/apps(\/|$)/.test(path)
    || /^\/v1\/admin\/support(\/|$)/.test(path);
}

/** 体験版の利用規約（最初のログインで同意を求める。第23.3.2節「最初のログイン」）。 */
export const DEMO_TERMS: readonly string[] = [
  '体験版は、M2Office を試していただくためのものです。期限が来たら、入れたデータとファイルはすべて削除し、元に戻せません',
  '会社の機密の情報や、個人の情報は入れないでください。見本のデータでお試しください',
  'AI の利用には上限があります。上限に達すると、AI を使う機能は止まります',
  'メール・チャット・LINE などの社外への送信は行いません（見本の接続で動きます）',
  'Web の調べものなど、外のサイトを読む機能は使えます',
];

/** 体験を出す入力（マスター管理画面。第23.3.2節「マスター管理画面」）。 */
export interface NewDemoInput {
  /** 相手の会社名。 */
  company: string;
  /** 担当者名。 */
  contact: string;
  /** 案内を送るメールアドレス（M2Office からは送らない。運営者が自分のメールで送る）。 */
  email: string;
  days: number;
  aiCapJpy: number;
}

/**
 * 体験を出す入力を整え、確かめる。日数と AI の上限は、省けば既定を使う。
 *
 * @returns 整えた入力か、運営者に見せる理由
 */
export function checkNewDemo(raw: Record<string, unknown>, defaults: { days: number; aiCapJpy: number }): { ok: true; value: NewDemoInput } | { ok: false; error: string } {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const company = str(raw['company'], 100);
  const contact = str(raw['contact'], 100);
  const email = str(raw['email'], 200).toLowerCase();
  const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number(v));
  const days = num(raw['days'], defaults.days);
  const aiCapJpy = num(raw['aiCapJpy'], defaults.aiCapJpy);
  if (!company) return { ok: false, error: '相手の会社名を入れてください' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'メールアドレスの形が違います' };
  if (!Number.isInteger(days) || days < 1 || days > DEMO_MAX_DAYS) return { ok: false, error: `日数は 1〜${DEMO_MAX_DAYS} 日で入れてください` };
  if (!Number.isInteger(aiCapJpy) || aiCapJpy < 1 || aiCapJpy > 100_000) return { ok: false, error: 'AI の上限は 1〜100,000 円で入れてください' };
  return { ok: true, value: { company, contact, email, days, aiCapJpy } };
}

/**
 * 体験の案内の文（運営者が写して、自分のメールで送る。M2Office からは送らない）。
 *
 * @param expiresAt 期限（ISO 形式）
 */
export function demoWelcomeText(p: { company: string; contact: string; url: string; loginId: string; password: string; expiresAt: string }): string {
  const end = new Date(Date.parse(p.expiresAt) + 9 * 3_600_000);
  const day = `${end.getUTCFullYear()} 年 ${end.getUTCMonth() + 1} 月 ${end.getUTCDate()} 日 ${String(end.getUTCHours()).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}`;
  return [
    `${p.company}${p.contact ? ` ${p.contact} 様` : ' ご担当者様'}`,
    '',
    'M2Office の体験版をご用意しました。次の URL を開き、ゲスト ID とパスワードでログインしてください。',
    '',
    p.url,
    `ゲスト ID: ${p.loginId}`,
    `パスワード: ${p.password}`,
    `期限: ${day}（日本時間）まで`,
    '',
    '見本の会社のデータが入っています。期限が来たら、入れたデータはすべて削除します。',
    '会社の機密の情報や個人の情報は入れないでください。メールやチャットなどの社外への送信は行いません。',
  ].join('\n');
}
