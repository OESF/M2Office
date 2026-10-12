/**
 * @file 会社の管理者が登録した外の URL（コネクタ（MCP）・その認可の口・WordPress の入れ先）へ、サーバーから送るときの確かめ。
 *
 * 登録した URL に社内のアドレス（クラウドの管理用・基盤の中の宛先・同じ機械）を書くと、M2Office のサーバーから
 * 社内へ要求を送らせ、答えの一部を読めてしまう（SSRF。2026-10-12 の点検で見つけた）。ここでは送る前に宛先を引き、
 * 配備の形に合わせて社内のアドレスを断る。転送（3xx）は自動でたどらず、転送先も同じく確かめる。
 *
 * | 配備の形 | 断る宛先 |
 * |---|---|
 * | クラウド（本番） | 社内・自分自身・リンクローカル（クラウドの管理用）・予約のアドレスすべて（競合の読み取りと同じ） |
 * | ローカルの形（`M2O_DEPLOYMENT=onsite`） | リンクローカル（クラウドの管理用）だけ。社内の LAN と同じ機械の上のサービスは、会社の機械の中なので通す |
 * | 開発 | 断らない |
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress } from '../competitors/fetcher.js';

/** 転送をたどる上限。 */
const MAX_REDIRECTS = 3;

/** 宛先の決まり。 */
export type OutboundPolicy = 'strict' | 'lan' | 'dev';

/** いまの配備の形での宛先の決まり。 */
export function outboundPolicy(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  if (env['NODE_ENV'] !== 'production') return 'dev';
  return env['M2O_DEPLOYMENT'] === 'onsite' ? 'lan' : 'strict';
}

/** リンクローカル（クラウドの管理用の 169.254.169.254 などを含む）か。 */
function isLinkLocal(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return address.startsWith('169.254.');
  if (v === 6) {
    const x = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isLinkLocal(mapped[1]!);
    return /^fe[89ab]/.test(x) || x.startsWith('fd00:ec2:');
  }
  return false;
}

/** その決まりで断るアドレスか。 */
export function isForbiddenAddress(address: string, policy: OutboundPolicy): boolean {
  if (policy === 'dev') return false;
  if (policy === 'lan') return isLinkLocal(address);
  return isBlockedAddress(address);
}

/**
 * 送ってよい宛先か。URL の形（http・https、ID とパスワードを含まない）と、名前を引いたアドレスを確かめる。
 *
 * @returns よければ `null`、だめなら理由
 */
export async function checkOutboundUrl(raw: string, policy: OutboundPolicy = outboundPolicy()): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'URL の形ではありません';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http か https の URL だけに送ります';
  if (u.username || u.password) return 'ID やパスワードを含む URL には送りません';
  if (policy === 'dev') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((l) => l.map((a) => a.address)).catch(() => [] as string[]);
  if (addresses.length === 0) return '宛先の名前を引けませんでした';
  if (addresses.some((a) => isForbiddenAddress(a, policy))) return '社内のアドレスには送りません';
  return null;
}

/** 宛先を確かめてから送れなかったことを表す誤り。 */
export class OutboundBlockedError extends Error {}

/**
 * 宛先を確かめてから送る `fetch`（転送は 3 回まで、そのたびに確かめる）。
 *
 * @remarks 307・308 は同じ方法と本文で、ほかの転送は GET で送り直す（ブラウザと同じ）
 * @throws {OutboundBlockedError} 宛先が決まりに合わないとき
 */
export const outboundFetch: typeof fetch = async (input, init) => {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  let current: RequestInit = { ...(init ?? {}) };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const why = await checkOutboundUrl(url);
    if (why) throw new OutboundBlockedError(why);
    const res = await fetch(url, { ...current, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    url = new URL(location, url).toString();
    if (res.status !== 307 && res.status !== 308) {
      const { body: _body, ...rest } = current;
      current = { ...rest, method: 'GET' };
    }
  }
  throw new OutboundBlockedError('転送が多すぎます');
};
