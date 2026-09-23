/**
 * @file ログインの引換券（仕様書 第16.1.2節）。
 *
 * Google は、リダイレクト URI に HTTPS を要求する（例外は `localhost`）。
 * そのためテナントごとのホストを、そのままリダイレクト先にできない。
 * 運営のホストで受け、**そこから会社のホストへ渡す**ための一度きりの札である。
 *
 * ログイン状態の Cookie は `Domain` を付けない（第20.7節）。
 * 受け取ったホストでしか有効にならないため、運営のホストで張っても会社のホストには届かない。
 *
 * @see 仕様書 第16.1.2節 ログインの経路
 */

import { randomBytes } from 'node:crypto';

/**
 * 引換券の有効期間（ミリ秒）。
 *
 * @remarks
 * 使うのはリダイレクトの直後だけである。短くてよい。
 * URL に載って運ばれるため、長く生かす理由がない。
 */
const TTL_MS = 2 * 60 * 1000;

/** 引換券が指す相手。**名前もメールアドレスも入れない**（第16.1.2節）。 */
export interface Handoff {
  tenantId: string;
  userId: string;
  expiresAt: number;
}

/**
 * ログインの引換券の置き場。
 *
 * @remarks
 * 記憶の上に置く。API を複数立てるときは、共有の置き場（データベースなど）へ移すこと。
 * いまは 1 プロセスで足りる。
 */
export class HandoffStore {
  private readonly tickets = new Map<string, Handoff>();

  /**
   * 引換券を発行する。
   *
   * @returns 券。URL に載せて会社のホストへ渡す
   */
  issue(p: { tenantId: string; userId: string }, now = Date.now()): string {
    this.sweep(now);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { ...p, expiresAt: now + TTL_MS });
    return ticket;
  }

  /**
   * 引換券を使う。**1 回しか使えない。**
   *
   * @returns 指していた相手。失効・未知なら `null`
   * @remarks
   * 見つかった時点で消す。同じ券で二度ログインさせない。
   */
  take(ticket: string, now = Date.now()): Handoff | null {
    const hit = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!hit || hit.expiresAt < now) return null;
    return hit;
  }

  /** 期限の切れたものを捨てる。 */
  private sweep(now: number): void {
    for (const [k, v] of this.tickets) if (v.expiresAt < now) this.tickets.delete(k);
  }
}
