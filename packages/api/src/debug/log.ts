/**
 * @file デバッグモードの記録（仕様書 第20.4.1節「デバッグモード」）。開発のときに、音声・秘書の振り分け・API のエラーを時刻順に残す。
 *
 * `M2O_DEBUG=true` のときだけ作る。記録は API のプロセスのメモリーに、利用者ごとに直近の分だけ持ち、データベースには書かない
 * （音声の中身には人の名前が入りうるため、残す期間の決まりを新しく作らない）。再起動で消える。見られるのは本人の記録だけ。
 */

import { randomUUID } from 'node:crypto';

/** 記録の種類。 */
export type DebugKind = 'voice' | 'secretary' | 'error';

/** 記録の 1 件。 */
export interface DebugEvent {
  id: string;
  at: string;
  kind: DebugKind;
  /** 一覧に出す 1 行。 */
  title: string;
  /** 開いたときに出す中身（JSON にできる値）。 */
  detail?: unknown;
}

/** 利用者 1 人あたりに持つ件数。 */
export const DEBUG_EVENTS_PER_USER = 500;
/** 中身の JSON の上限（字）。長い答えやファイルの中身で、メモリーを使い切らないため。 */
const DETAIL_MAX = 20_000;

/**
 * デバッグモードを使うか。
 *
 * @throws {Error} 本番（`NODE_ENV=production`）で有効にしたとき（開発用の足場。起動を断る）
 */
export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = env['M2O_DEBUG'] === 'true';
  if (on && env['NODE_ENV'] === 'production') {
    throw new Error('本番環境で M2O_DEBUG が有効です。起動を中止します。');
  }
  return on;
}

/** 中身を上限までに切る（切ったことが分かるように印を付ける）。 */
function clip(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(detail);
  } catch {
    return String(detail);
  }
  if (text === undefined) return undefined;
  return text.length > DETAIL_MAX ? { truncated: true, head: text.slice(0, DETAIL_MAX) } : detail;
}

/**
 * デバッグモードの記録。利用者ごとに直近 {@link DEBUG_EVENTS_PER_USER} 件を持つ。
 *
 * @remarks テナント境界: 会社と利用者の組ごとに分けて持ち、本人の分だけを返す（不変則 I-2）
 */
export class DebugLog {
  private readonly byUser = new Map<string, DebugEvent[]>();

  private key(tenantId: string, userId: string): string {
    return `${tenantId}\u0000${userId}`;
  }

  /** 1 件足す。失敗しても本来の処理を止めない。 */
  add(tenantId: string, userId: string, kind: DebugKind, title: string, detail?: unknown): void {
    try {
      const k = this.key(tenantId, userId);
      const list = this.byUser.get(k) ?? [];
      list.push({ id: randomUUID(), at: new Date().toISOString(), kind, title: title.slice(0, 300), detail: clip(detail) });
      if (list.length > DEBUG_EVENTS_PER_USER) list.splice(0, list.length - DEBUG_EVENTS_PER_USER);
      this.byUser.set(k, list);
    } catch {
      // 記録に失敗しても、依頼の処理は続ける
    }
  }

  /**
   * 本人の記録（新しい順）。
   *
   * @param after この ID より後に足したものだけ（画面の読み足し）
   */
  list(tenantId: string, userId: string, after?: string): DebugEvent[] {
    const list = this.byUser.get(this.key(tenantId, userId)) ?? [];
    const from = after ? list.findIndex((e) => e.id === after) + 1 : 0;
    return list.slice(from).reverse();
  }

  /** 本人の記録を消す。 */
  clear(tenantId: string, userId: string): void {
    this.byUser.delete(this.key(tenantId, userId));
  }
}
