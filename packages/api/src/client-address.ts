/**
 * @file 要求を送ってきた相手のアドレス（回数の制限に使う）。
 *
 * `X-Forwarded-For` の**先頭**は、送る側が自由に書ける（偽った値で回数の制限を外せる。2026-10-12 の点検で見つけた）。
 * 手前の入口（Caddy）は、相手のアドレスを**後ろに付け足す**（信用しない相手の値は捨てる）ため、いちばん後ろを使う。
 * 入口を通らずに届いた要求は、つながってきた相手のアドレスを使う。
 */

import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';

/**
 * 回数の制限に使う、相手のアドレス。
 *
 * @returns 分からなければ `'local'`
 */
export function clientAddress(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  const last = xff ? xff.split(',').map((s) => s.trim()).filter(Boolean).at(-1) : undefined;
  if (last) return last;
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'local';
}
