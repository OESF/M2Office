/**
 * @file Google と会社の接続の認可の要求に付ける、使い捨ての `state` の置き場。戻ってきた要求を照合し、テナントと利用者を引く。
 *
 * `state` は推測できない値にし、10 分で失効させ、1 回使ったら消す。PKCE の検証用の値もここに持つ。
 * いまは API のプロセスの記憶に置く。API を複数台にするときはデータベースに移す（ADR-0007）。
 *
 * @see 仕様書 第14.3.3節「戻り先の検証」
 */

import { randomBytes } from 'node:crypto';

/** 認可の要求を始めたときの記録。 */
export interface OAuthPending {
  tenantId: string;
  userId: string;
  codeVerifier: string;
  /** 終わったあとに戻す画面（テナントのオリジン + パス）。 */
  returnTo: string;
  /** 会社の接続の認可のとき、その接続の ID（仕様書 第12.11.6.3節）。Google のときは無い。 */
  connectionId?: string;
  /**
   * 本人の Google の接続としては保存しない、会社の接続の許可。問い合わせの窓口のアカウント（仕様書 第33.18節）と、
   * Webの分析の担当の許可（第34.18節）。
   */
  purpose?: 'inquiry-mailbox' | 'web-review';
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;

export class OAuthStateStore {
  private readonly pending = new Map<string, OAuthPending>();

  /** 新しい `state` を発行する。 */
  issue(p: Omit<OAuthPending, 'expiresAt'>, now = Date.now()): string {
    this.sweep(now);
    const state = randomBytes(24).toString('base64url');
    this.pending.set(state, { ...p, expiresAt: now + TTL_MS });
    return state;
  }

  /** `state` を照合して取り出す。1 回しか使えない。失効・未知なら `null`。 */
  take(state: string, now = Date.now()): OAuthPending | null {
    const hit = this.pending.get(state);
    this.pending.delete(state);
    if (!hit || hit.expiresAt < now) return null;
    return hit;
  }

  private sweep(now: number) {
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
  }
}
